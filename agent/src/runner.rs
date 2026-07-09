//! Supervises the embedded rathole server. rathole runs *in-process* via a
//! small patched API that accepts a typed server config directly; the agent no
//! longer writes Worker-generated TOML or infers state from rathole logs.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, Result};
use rathole::config::{
    MaskedString, NoiseConfig, ServerConfig, ServerServiceConfig, ServiceType, TlsConfig,
    TransportConfig, TransportType, WebsocketConfig,
};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::http_proxy::{
    HttpProxyConfig as AgentHttpProxyConfig, HttpProxyRunner, HttpRoute,
};
use crate::protocol::{
    ProcessState, RatholeConfig, RatholeService, ServiceRef, ServiceType as WireServiceType,
    TrafficStat, TransportType as WireTransportType,
};

struct Running {
    shutdown: broadcast::Sender<bool>,
    handle: JoinHandle<Result<(), String>>,
}

pub struct Runner {
    config: Option<ServerConfig>,
    http_config: Option<AgentHttpProxyConfig>,
    http_proxy: HttpProxyRunner,
    services: Vec<ServiceRef>,
    inner: Option<Running>,
    last_error: Option<String>,
}

impl Runner {
    pub fn new() -> Self {
        Self {
            config: None,
            http_config: None,
            http_proxy: HttpProxyRunner::new(),
            services: Vec::new(),
            inner: None,
            last_error: None,
        }
    }

    pub fn is_running(&self) -> bool {
        self.inner.as_ref().is_some_and(|r| !r.handle.is_finished())
    }

    pub fn state(&self) -> ProcessState {
        if self.is_running() {
            ProcessState::Running
        } else if self.last_error.is_some() {
            ProcessState::Errored
        } else if self.inner.is_some() {
            // Task finished cleanly but we never observed it — treat as stopped.
            ProcessState::Stopped
        } else {
            ProcessState::Stopped
        }
    }

    pub async fn refresh(&mut self) {
        if let Some(msg) = self.http_proxy.refresh() {
            self.last_error = Some(msg);
        }

        if !self.inner.as_ref().is_some_and(|r| r.handle.is_finished()) {
            return;
        }

        let Some(running) = self.inner.take() else {
            return;
        };
        match running.handle.await {
            Ok(Ok(())) => {}
            Ok(Err(msg)) => self.last_error = Some(msg),
            Err(join_err) => self.last_error = Some(join_err.to_string()),
        }
    }

    /// Per-service online state: a service is online only when rathole is
    /// running *and* a client's control channel is currently connected for it.
    pub fn service_status(&self) -> Option<HashMap<String, bool>> {
        if self.services.is_empty() {
            return None;
        }
        let connected = if self.is_running() {
            rathole::connected_services()
        } else {
            Default::default()
        };
        Some(
            self.services
                .iter()
                .map(|svc| (svc.name.clone(), connected.contains(&svc.name)))
                .collect(),
        )
    }

    /// Cumulative traffic per service, sourced from the patched rathole's
    /// counters (keyed by public bind address) and mapped back to service names.
    pub fn traffic(&self) -> Option<HashMap<String, TrafficStat>> {
        if self.services.is_empty() {
            return None;
        }
        let snapshot = rathole::traffic_snapshot();
        Some(
            self.services
                .iter()
                .map(|svc| {
                    // rathole records (to_visitor, from_visitor) = (out, in).
                    let (out, inn) = snapshot.get(&svc.bind_addr).copied().unwrap_or((0, 0));
                    (
                        svc.name.clone(),
                        TrafficStat {
                            bytes_in: inn,
                            bytes_out: out,
                        },
                    )
                })
                .collect(),
        )
    }

    pub async fn apply_config(&mut self, config: RatholeConfig) -> Result<()> {
        let services = config
            .services
            .iter()
            .map(|svc| ServiceRef {
                name: svc.name.clone(),
                bind_addr: svc.bind_addr.clone(),
            })
            .collect::<Vec<_>>();
        let http_config = http_proxy_config(&config).context("building Pingora HTTP proxy config")?;
        let server = to_server_config(config).context("building rathole server config")?;
        self.services = services;
        self.http_config = http_config;
        self.config = Some(server);
        self.last_error = None;

        if self.services.is_empty() {
            self.stop().await;
            return Ok(());
        }

        self.restart().await;
        Ok(())
    }

    /// Start the embedded rathole server if it isn't already running.
    pub async fn start(&mut self) -> Result<()> {
        self.http_proxy.apply(self.http_config.clone()).await?;
        if self.is_running() {
            return Ok(());
        }
        let Some(config) = self.config.clone() else {
            return Ok(());
        };
        if config.services.is_empty() {
            return Ok(());
        }
        let (tx, rx) = broadcast::channel::<bool>(4);
        tracing::info!(
            bind_addr = %config.bind_addr,
            services = config.services.len(),
            "starting embedded rathole server"
        );
        let handle = tokio::spawn(async move {
            match rathole::run_server_direct(config, rx).await {
                Ok(()) => {
                    tracing::info!("rathole server stopped");
                    Ok(())
                }
                Err(e) => {
                    tracing::error!("rathole server exited with error: {:#}", e);
                    Err(format!("{e:#}"))
                }
            }
        });
        self.inner = Some(Running {
            shutdown: tx,
            handle,
        });
        self.last_error = None;
        Ok(())
    }

    /// Ask rathole to shut down, waiting up to a few seconds for a clean stop.
    pub async fn stop(&mut self) {
        if let Some(running) = self.inner.take() {
            let _ = running.shutdown.send(true);
            match tokio::time::timeout(Duration::from_secs(5), running.handle).await {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(msg))) => self.last_error = Some(msg),
                Ok(Err(join_err)) => self.last_error = Some(join_err.to_string()),
                Err(_) => {
                    tracing::warn!("rathole did not stop within 5s");
                    self.last_error = Some("stop timed out".into());
                }
            }
        }
        if let Err(e) = self.http_proxy.stop().await {
            tracing::warn!("Pingora HTTP proxy stop failed: {e:#}");
            self.last_error = Some(format!("{e:#}"));
        }
    }

    pub async fn restart(&mut self) {
        self.stop().await;
        if let Err(e) = self.start().await {
            self.last_error = Some(format!("{e:#}"));
        }
    }
}

fn mask(value: Option<String>) -> Option<MaskedString> {
    value.map(|v| MaskedString::from(v.as_str()))
}

fn service_type(kind: WireServiceType) -> ServiceType {
    match kind {
        WireServiceType::Tcp => ServiceType::Tcp,
        WireServiceType::Udp => ServiceType::Udp,
    }
}

fn service_config(service: RatholeService) -> ServerServiceConfig {
    ServerServiceConfig {
        service_type: service_type(service.service_type),
        name: service.name,
        bind_addr: service.bind_addr,
        token: mask(service.token),
        nodelay: service.nodelay,
    }
}

fn http_proxy_config(config: &RatholeConfig) -> Result<Option<AgentHttpProxyConfig>> {
    let Some(http) = &config.http else {
        return Ok(None);
    };
    if !http.enabled {
        return Ok(None);
    }

    let routes = config
        .services
        .iter()
        .filter_map(|svc| {
            let host = svc.http_host.as_ref()?.trim();
            if host.is_empty() {
                return None;
            }
            Some(HttpRoute {
                host: host.to_ascii_lowercase(),
                upstream_addr: visitor_addr_for_bind(&svc.bind_addr),
                service: svc.name.clone(),
            })
        })
        .collect::<Vec<_>>();

    if routes.is_empty() {
        return Ok(None);
    }

    Ok(Some(AgentHttpProxyConfig {
        bind_addr: http.bind_addr.clone(),
        routes,
    }))
}

fn visitor_addr_for_bind(bind_addr: &str) -> String {
    let trimmed = bind_addr.trim();
    if let Some(rest) = trimmed.strip_prefix('[') {
        if let Some((host, port_part)) = rest.split_once("]:") {
            let port = port_part.trim();
            let host = match host {
                "::" | "0:0:0:0:0:0:0:0" => "::1",
                other => other,
            };
            return format!("[{host}]:{port}");
        }
    }

    let Some((host, port)) = trimmed.rsplit_once(':') else {
        return trimmed.to_string();
    };
    let host = match host {
        "" | "0.0.0.0" => "127.0.0.1",
        "::" => "::1",
        other => other,
    };
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn to_server_config(config: RatholeConfig) -> Result<ServerConfig> {
    let mut transport = TransportConfig::default();
    transport.transport_type = match config.transport {
        WireTransportType::Tcp => TransportType::Tcp,
        WireTransportType::Tls => TransportType::Tls,
        WireTransportType::Noise => TransportType::Noise,
        WireTransportType::Websocket => TransportType::Websocket,
    };
    transport.tls = config.tls.map(|tls| TlsConfig {
        hostname: tls.hostname,
        trusted_root: tls.trusted_root,
        pkcs12: tls.pkcs_path,
        pkcs12_password: mask(tls.keystore_password),
    });
    transport.noise = config.noise.map(|noise| NoiseConfig {
        pattern: noise
            .pattern
            .unwrap_or_else(|| "Noise_NK_25519_ChaChaPoly_BLAKE2s".into()),
        local_private_key: mask(noise.local_private_key),
        remote_public_key: noise.remote_public_key,
    });
    transport.websocket = config.websocket.map(|websocket| WebsocketConfig {
        tls: websocket.tls.unwrap_or(false),
    });

    let services = config
        .services
        .into_iter()
        .map(|svc| (svc.name.clone(), service_config(svc)))
        .collect();

    Ok(ServerConfig {
        bind_addr: config.bind_addr,
        default_token: mask(config.default_token),
        services,
        transport,
        heartbeat_interval: config.heartbeat_interval.unwrap_or(30),
    })
}
