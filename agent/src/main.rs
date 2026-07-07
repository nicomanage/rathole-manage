//! rathole-agent — runs on a rathole server node.
//!
//! It embeds rathole as a library (see `runner.rs`), dials the rathole-manage
//! hub over WebSocket, applies the config the panel generates, streams logs and
//! metrics back, and executes start/stop/restart commands. The embedded rathole
//! keeps serving tunnels even while the hub is unreachable.
//!
//! Commands:
//!   rathole-agent login   interactive TUI: sign in with your panel account and
//!                         enroll this node (saves an identity file)
//!   rathole-agent run     (default) run the daemon using the saved identity

mod enroll;
mod logcap;
mod protocol;
mod runner;
mod sysstat;
mod tui;

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;
use tracing_subscriber::prelude::*;
use url::Url;

use logcap::ChannelMakeWriter;
use protocol::{AgentCommand, AgentToHub, HubToAgent, Metrics};
use runner::Runner;

const RATHOLE_VERSION: &str = "0.5.0"; // matches the pinned rathole dependency

/// Everything the daemon needs to connect and manage its instance.
struct RunConfig {
    /// Panel origin (http/https), e.g. `https://panel.example.com`.
    hub_base: String,
    instance_id: String,
    agent_token: String,
}

fn main() -> Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("login") | Some("enroll") => cmd_login(),
        None | Some("run") => cmd_run(),
        Some("--version") | Some("-V") => {
            println!("rathole-agent {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("--help") | Some("-h") | Some("help") => {
            print_usage();
            Ok(())
        }
        Some(other) => {
            eprintln!("unknown command: {other}\n");
            print_usage();
            std::process::exit(2);
        }
    }
}

fn print_usage() {
    eprintln!(
        "rathole-agent {v}

USAGE:
    rathole-agent [COMMAND]

COMMANDS:
    run      Run the agent daemon (default). Requires an enrolled identity.
    login    Sign in with your panel account (TUI) and enroll this node.

The daemon reads its identity from {path} (created by `login`), or from the
INSTANCE_ID / AGENT_TOKEN / HUB_URL environment variables.",
        v = env!("CARGO_PKG_VERSION"),
        path = enroll::identity_path().display(),
    );
}

// ---- login command ---------------------------------------------------------

fn cmd_login() -> Result<()> {
    match tui::run_login()? {
        Some(identity) => {
            let path = enroll::identity_path();
            identity.save(&path)?;
            println!(
                "\n✓ Enrolled \"{}\" (instance {}).",
                identity.name, identity.instance_id
            );
            println!("  Identity saved to {}.", path.display());
            println!("  Start the node:  sudo systemctl enable --now rathole-agent");
            Ok(())
        }
        None => {
            println!("Enrollment cancelled.");
            Ok(())
        }
    }
}

// ---- run command -----------------------------------------------------------

fn cmd_run() -> Result<()> {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("building tokio runtime")?;
    rt.block_on(run_daemon())
}

fn resolve_run_config() -> Result<RunConfig> {
    // 1) Explicit env credentials win (non-interactive / static provisioning).
    if let (Ok(instance_id), Ok(agent_token), Ok(hub_url)) = (
        std::env::var("INSTANCE_ID"),
        std::env::var("AGENT_TOKEN"),
        std::env::var("HUB_URL"),
    ) {
        if !instance_id.is_empty() && !agent_token.is_empty() {
            return Ok(RunConfig {
                hub_base: enroll::http_origin(&hub_url)?,
                instance_id,
                agent_token,
            });
        }
    }

    // 2) Persisted identity from `rathole-agent login`.
    let path = enroll::identity_path();
    if let Some(id) = enroll::Identity::load(&path)? {
        return Ok(RunConfig {
            hub_base: id.hub_url,
            instance_id: id.instance_id,
            agent_token: id.agent_token,
        });
    }

    bail!(
        "no identity found at {}.\nRun `rathole-agent login` to enroll this node, \
         or set INSTANCE_ID / AGENT_TOKEN / HUB_URL.",
        path.display()
    )
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn send_log(to_hub_tx: &mpsc::UnboundedSender<String>, line: impl Into<String>) {
    let msg = AgentToHub::Log {
        line: line.into(),
        stream: Some("stdout".into()),
        ts: now_ms(),
    };
    if let Ok(text) = serde_json::to_string(&msg) {
        let _ = to_hub_tx.send(text);
    }
}

fn build_ws_url(cfg: &RunConfig) -> Result<String> {
    let u = Url::parse(&cfg.hub_base).context("invalid hub URL")?;
    let scheme = if u.scheme() == "https" { "wss" } else { "ws" };
    let host = u.host_str().context("hub URL has no host")?;
    let authority = match u.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    };
    let mut ws = Url::parse(&format!("{scheme}://{authority}/api/agent/ws"))?;
    ws.query_pairs_mut()
        .append_pair("instance", &cfg.instance_id)
        .append_pair("token", &cfg.agent_token);
    Ok(ws.to_string())
}

async fn run_daemon() -> Result<()> {
    // Route all tracing (agent + embedded rathole) into a channel for streaming.
    // Service status is reported directly from the runner's typed config/state.
    let (log_tx, mut log_rx) = mpsc::unbounded_channel::<String>();
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::registry()
        .with(filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_writer(ChannelMakeWriter::new(log_tx)),
        )
        .init();

    let cfg = resolve_run_config()?;
    tracing::info!(instance = %cfg.instance_id, hub = %cfg.hub_base, "rathole-agent starting");

    let runner = Arc::new(Mutex::new(Runner::new()));
    let (to_hub_tx, mut to_hub_rx) = mpsc::unbounded_channel::<String>();

    // Forward captured log lines up to the hub.
    {
        let to_hub_tx = to_hub_tx.clone();
        tokio::spawn(async move {
            while let Some(line) = log_rx.recv().await {
                let msg = AgentToHub::Log {
                    line,
                    stream: Some("stdout".into()),
                    ts: now_ms(),
                };
                if let Ok(text) = serde_json::to_string(&msg) {
                    let _ = to_hub_tx.send(text);
                }
            }
        });
    }

    // Periodic status + metrics + per-service online state.
    {
        let to_hub_tx = to_hub_tx.clone();
        let runner = runner.clone();
        tokio::spawn(async move {
            let mut collector = sysstat::MetricsCollector::new();
            let hostname = sysstat::hostname();
            let mut ticker = tokio::time::interval(Duration::from_secs(8));
            loop {
                ticker.tick().await;
                let mut guard = runner.lock().await;
                guard.refresh().await;
                let state = guard.state();
                let statuses = guard.service_status();
                let traffic = guard.traffic();
                drop(guard);
                let metrics = Metrics {
                    cpu_percent: collector.cpu_percent(),
                    memory_mb: collector.memory_mb(),
                    uptime_seconds: Some(collector.uptime_seconds()),
                    rathole_version: Some(RATHOLE_VERSION.into()),
                    agent_version: Some(env!("CARGO_PKG_VERSION").into()),
                    hostname: hostname.clone(),
                    config_in_sync: None,
                };
                let msg = AgentToHub::Status {
                    process_state: state,
                    metrics: Some(metrics),
                    service_status: statuses,
                    traffic,
                };
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
    cfg: &RunConfig,
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
    write
        .send(Message::Text(serde_json::to_string(&register)?))
        .await?;
    tracing::info!("registered with hub");
    send_log(to_hub_tx, "[agent] registered with hub");

    loop {
        tokio::select! {
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        handle_hub_message(&text, runner, to_hub_tx).await;
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
        HubToAgent::ApplyConfig {
            config,
            config_hash,
            services: _,
        } => {
            tracing::info!(hash = %config_hash, "applying config from hub");
            send_log(
                to_hub_tx,
                format!(
                    "[agent] applying config {config_hash} ({} services)",
                    config.services.len()
                ),
            );
            let mut guard = runner.lock().await;
            match guard.apply_config(*config).await {
                Ok(()) => {
                    send_log(to_hub_tx, "[agent] config applied");
                    reply(AgentToHub::ConfigAck {
                        ok: true,
                        error: None,
                    });
                }
                Err(e) => {
                    tracing::error!("failed to apply config: {e:#}");
                    send_log(to_hub_tx, format!("[agent] config failed: {e:#}"));
                    reply(AgentToHub::ConfigAck {
                        ok: false,
                        error: Some(format!("{e:#}")),
                    });
                }
            }
        }
        HubToAgent::Command { command } => {
            tracing::info!(?command, "executing command");
            let mut guard = runner.lock().await;
            let result = match command {
                AgentCommand::Start => guard.start(),
                AgentCommand::Stop => {
                    guard.stop().await;
                    Ok(())
                }
                AgentCommand::Restart | AgentCommand::Reload => {
                    guard.restart().await;
                    Ok(())
                }
                AgentCommand::Status => Ok(()),
            };
            let state = guard.state();
            let statuses = guard.service_status();
            let traffic = guard.traffic();
            drop(guard);
            reply(AgentToHub::CommandResult {
                command,
                ok: result.is_ok(),
                error: result.err().map(|e| format!("{e:#}")),
            });
            reply(AgentToHub::Status {
                process_state: state,
                metrics: None,
                service_status: statuses,
                traffic,
            });
        }
        HubToAgent::Ping => reply(AgentToHub::Pong),
        HubToAgent::Error { message } => {
            tracing::warn!("hub error: {message}");
            if message.contains("token") || message.contains("unauthorized") {
                tracing::error!("authentication rejected by hub; re-run `rathole-agent login`");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(hub_base: &str) -> RunConfig {
        RunConfig {
            hub_base: hub_base.to_string(),
            instance_id: "abc".to_string(),
            agent_token: "tok".to_string(),
        }
    }

    #[test]
    fn ws_url_uses_wss_for_https_and_carries_credentials() {
        let url = build_ws_url(&cfg("https://panel.example.com:8443")).unwrap();
        assert!(url.starts_with("wss://panel.example.com:8443/api/agent/ws?"));
        assert!(url.contains("instance=abc"));
        assert!(url.contains("token=tok"));
    }

    #[test]
    fn ws_url_uses_ws_for_http() {
        let url = build_ws_url(&cfg("http://127.0.0.1:8787")).unwrap();
        assert!(url.starts_with("ws://127.0.0.1:8787/api/agent/ws?"));
    }
}
