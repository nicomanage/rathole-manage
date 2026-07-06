//! rathole-agent — runs on a rathole server node.
//!
//! It embeds rathole as a library (see `runner.rs`), dials the rathole-manage
//! hub over WebSocket, applies the config the panel generates, streams logs and
//! metrics back, and executes start/stop/restart commands. The embedded rathole
//! keeps serving tunnels even while the hub is unreachable.

mod logcap;
mod protocol;
mod runner;
mod sysstat;

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

use logcap::ChannelMakeWriter;
use protocol::{AgentCommand, AgentToHub, HubToAgent, Metrics};
use runner::Runner;

const RATHOLE_VERSION: &str = "0.5.0"; // matches the pinned rathole dependency

struct Config {
    hub_url: String,
    instance_id: String,
    agent_token: String,
    config_path: std::path::PathBuf,
}

fn load_config() -> Result<Config> {
    let hub_url = std::env::var("HUB_URL")
        .context("HUB_URL is required, e.g. wss://panel.example.com/api/agent/ws")?;
    let instance_id = std::env::var("INSTANCE_ID").context("INSTANCE_ID is required")?;
    let agent_token = std::env::var("AGENT_TOKEN").context("AGENT_TOKEN is required")?;
    let config_path = std::env::var("CONFIG_PATH")
        .unwrap_or_else(|_| "/etc/rathole-manage/server.toml".to_string())
        .into();
    Ok(Config { hub_url, instance_id, agent_token, config_path })
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn build_ws_url(cfg: &Config) -> Result<String> {
    let mut url = url::Url::parse(&cfg.hub_url).context("HUB_URL is not a valid URL")?;
    url.query_pairs_mut()
        .append_pair("instance", &cfg.instance_id)
        .append_pair("token", &cfg.agent_token);
    Ok(url.to_string())
}

#[tokio::main]
async fn main() -> Result<()> {
    // Route all tracing (agent + embedded rathole) into a channel for streaming.
    let (log_tx, mut log_rx) = mpsc::unbounded_channel::<String>();
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_writer(ChannelMakeWriter::new(log_tx))
        .init();

    let cfg = load_config()?;
    tracing::info!(instance = %cfg.instance_id, "rathole-agent starting");

    let runner = Arc::new(Mutex::new(Runner::new(cfg.config_path.clone())));
    let (to_hub_tx, mut to_hub_rx) = mpsc::unbounded_channel::<String>();

    // Forward captured log lines up to the hub.
    {
        let to_hub_tx = to_hub_tx.clone();
        tokio::spawn(async move {
            while let Some(line) = log_rx.recv().await {
                let msg = AgentToHub::Log { line, stream: Some("stdout".into()), ts: now_ms() };
                if let Ok(text) = serde_json::to_string(&msg) {
                    let _ = to_hub_tx.send(text);
                }
            }
        });
    }

    // Periodic status + metrics.
    {
        let to_hub_tx = to_hub_tx.clone();
        let runner = runner.clone();
        tokio::spawn(async move {
            let mut collector = sysstat::MetricsCollector::new();
            let hostname = sysstat::hostname();
            let mut ticker = tokio::time::interval(Duration::from_secs(8));
            loop {
                ticker.tick().await;
                let state = runner.lock().await.state();
                let metrics = Metrics {
                    cpu_percent: collector.cpu_percent(),
                    memory_mb: collector.memory_mb(),
                    uptime_seconds: Some(collector.uptime_seconds()),
                    rathole_version: Some(RATHOLE_VERSION.into()),
                    agent_version: Some(env!("CARGO_PKG_VERSION").into()),
                    hostname: hostname.clone(),
                    config_in_sync: None,
                };
                let msg = AgentToHub::Status { process_state: state, metrics: Some(metrics) };
                if let Ok(text) = serde_json::to_string(&msg) {
                    let _ = to_hub_tx.send(text);
                }
            }
        });
    }

    // Connection loop with exponential backoff. rathole keeps running across drops.
    let mut backoff = 1u64;
    loop {
        match connect_once(&cfg, &runner, &to_hub_tx, &mut to_hub_rx).await {
            Ok(()) => {
                tracing::warn!("hub connection closed, reconnecting");
                backoff = 1;
            }
            Err(e) => {
                tracing::warn!("hub connection failed: {e:#}");
            }
        }
        tokio::time::sleep(Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(30);
    }
}

async fn connect_once(
    cfg: &Config,
    runner: &Arc<Mutex<Runner>>,
    to_hub_tx: &mpsc::UnboundedSender<String>,
    to_hub_rx: &mut mpsc::UnboundedReceiver<String>,
) -> Result<()> {
    let ws_url = build_ws_url(cfg)?;
    tracing::info!("connecting to hub");
    let (ws, _resp) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .context("websocket connect failed")?;
    let (mut write, mut read) = ws.split();

    // Register immediately.
    let register = AgentToHub::Register {
        instance_id: cfg.instance_id.clone(),
        token: cfg.agent_token.clone(),
        agent_version: Some(env!("CARGO_PKG_VERSION").into()),
        hostname: sysstat::hostname(),
    };
    write.send(Message::Text(serde_json::to_string(&register)?)).await?;
    tracing::info!("registered with hub");

    loop {
        tokio::select! {
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        handle_hub_message(&text, cfg, runner, to_hub_tx).await;
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        write.send(Message::Pong(payload)).await?;
                    }
                    Some(Ok(Message::Close(_))) | None => return Ok(()),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => return Err(e).context("websocket read error"),
                }
            }
            outgoing = to_hub_rx.recv() => {
                match outgoing {
                    Some(text) => write.send(Message::Text(text)).await?,
                    None => return Ok(()),
                }
            }
        }
    }
}

async fn handle_hub_message(
    text: &str,
    _cfg: &Config,
    runner: &Arc<Mutex<Runner>>,
    to_hub_tx: &mpsc::UnboundedSender<String>,
) {
    let msg: HubToAgent = match serde_json::from_str(text) {
        Ok(m) => m,
        Err(e) => {
            tracing::debug!("ignoring unparseable hub message: {e}");
            return;
        }
    };

    let reply = |m: AgentToHub| {
        if let Ok(t) = serde_json::to_string(&m) {
            let _ = to_hub_tx.send(t);
        }
    };

    match msg {
        HubToAgent::Registered { name, .. } => {
            tracing::info!(%name, "hub acknowledged registration");
        }
        HubToAgent::ApplyConfig { toml, config_hash } => {
            tracing::info!(hash = %config_hash, "applying config from hub");
            let mut guard = runner.lock().await;
            match guard.write_config(&toml).await {
                Ok(()) => {
                    // Auto-start on first config; rathole hot-reloads subsequent writes.
                    if !guard.is_running() {
                        guard.start();
                    }
                    reply(AgentToHub::ConfigAck { ok: true, error: None });
                }
                Err(e) => {
                    tracing::error!("failed to apply config: {e:#}");
                    reply(AgentToHub::ConfigAck { ok: false, error: Some(format!("{e:#}")) });
                }
            }
        }
        HubToAgent::Command { command } => {
            tracing::info!(?command, "executing command");
            let mut guard = runner.lock().await;
            match command {
                AgentCommand::Start => guard.start(),
                AgentCommand::Stop => guard.stop().await,
                AgentCommand::Restart | AgentCommand::Reload => guard.restart().await,
                AgentCommand::Status => {}
            }
            let state = guard.state();
            drop(guard);
            reply(AgentToHub::CommandResult { command, ok: true, error: None });
            reply(AgentToHub::Status { process_state: state, metrics: None });
        }
        HubToAgent::Ping => reply(AgentToHub::Pong),
        HubToAgent::Error { message } => {
            tracing::warn!("hub error: {message}");
            if message.contains("token") || message.contains("unauthorized") {
                // Fatal auth problem — surface it clearly.
                tracing::error!("authentication rejected by hub; check AGENT_TOKEN / INSTANCE_ID");
            }
        }
    }
}
