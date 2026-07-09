//! Supervises the embedded rathole server. rathole runs *in-process* via a
//! small patched API that accepts a typed server config directly; the agent no
//! longer writes Worker-generated TOML or infers state from rathole logs.

use std::collections::HashMap;
use std::time::Duration;

use crate::acme::LetsEncryptConfig as AgentLetsEncryptConfig;
use anyhow::{Context, Result};
use rathole::config::{
    MaskedString, NoiseConfig, ServerConfig, ServerServiceConfig, ServiceType, TlsConfig,
    TransportConfig, TransportType, WebsocketConfig,
};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::http_proxy::{HttpProxyConfig as AgentHttpProxyConfig, HttpProxyRunner, HttpRoute};
use crate::protocol::{
    DesiredProcessState, ProcessState, RatholeConfig, RatholeService, ServiceRef,
    ServiceType as WireServiceType, TrafficStat, TransportType as WireTransportType,
};

const HTTP_PROXY_BIND_ADDR: &str = "[::]:80";
const HTTPS_PROXY_BIND_ADDR: &str = "[::]:443";

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

    pub async fn apply_config(
        &mut self,
        config: RatholeConfig,
        desired_state: Option<DesiredProcessState>,
    ) -> Result<()> {
        let services = config
            .services
            .iter()
            .map(|svc| ServiceRef {
                name: svc.name.clone(),
                bind_addr: service_bind_addr(svc),
            })
            .collect::<Vec<_>>();
        let http_config =
            http_proxy_config(&config).context("building Pingora HTTP proxy config")?;
        let server = to_server_config(config).context("building rathole server config")?;
        self.services = services;
        self.http_config = http_config;
        self.config = Some(server);
        self.last_error = None;

        let should_run = !matches!(desired_state, Some(DesiredProcessState::Stopped));
        if self.services.is_empty() || !should_run {
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
        WireServiceType::Http | WireServiceType::Https => ServiceType::Tcp,
    }
}

fn service_config(service: RatholeService) -> ServerServiceConfig {
    let bind_addr = service_bind_addr(&service);
    ServerServiceConfig {
        service_type: service_type(service.service_type),
        name: service.name,
        bind_addr,
        token: mask(service.token),
        nodelay: service.nodelay,
    }
}

fn virtual_bind_addr(service_name: &str) -> String {
    format!("memory://{service_name}")
}

fn service_bind_addr(service: &RatholeService) -> String {
    match service.service_type {
        WireServiceType::Http | WireServiceType::Https => virtual_bind_addr(&service.name),
        WireServiceType::Tcp | WireServiceType::Udp => service.bind_addr.clone(),
    }
}

fn service_http_hosts(service: &RatholeService) -> Vec<String> {
    let mut hosts = Vec::new();
    if let Some(list) = &service.http_hosts {
        hosts.extend(list.iter().map(String::as_str));
    }
    if let Some(host) = service.http_host.as_deref() {
        hosts.push(host);
    }

    let mut normalized = hosts
        .into_iter()
        .map(|host| host.trim().trim_end_matches('.').to_ascii_lowercase())
        .filter(|host| !host.is_empty())
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    normalized
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
        .flat_map(|svc| {
            let upstream_addr = service_bind_addr(svc);
            let service = svc.name.clone();
            service_http_hosts(svc)
                .into_iter()
                .map(move |host| HttpRoute {
                    host,
                    upstream_addr: upstream_addr.clone(),
                    service: service.clone(),
                })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let https_hosts = config
        .services
        .iter()
        .filter(|svc| matches!(&svc.service_type, WireServiceType::Https))
        .flat_map(service_http_hosts)
        .collect::<Vec<_>>();

    if routes.is_empty() {
        return Ok(None);
    }

    let lets_encrypt = http
        .lets_encrypt
        .as_ref()
        .filter(|config| config.enabled)
        .filter(|_| !https_hosts.is_empty())
        .map(|config| {
            let email = config.email.trim();
            if email.is_empty() {
                anyhow::bail!("Let's Encrypt account email is required");
            }
            Ok(AgentLetsEncryptConfig {
                email: email.to_string(),
                staging: config.staging.unwrap_or(false),
            })
        })
        .transpose()?;

    Ok(Some(AgentHttpProxyConfig {
        bind_addr: HTTP_PROXY_BIND_ADDR.into(),
        https_bind_addr: lets_encrypt.as_ref().map(|_| HTTPS_PROXY_BIND_ADDR.into()),
        lets_encrypt,
        https_hosts,
        routes,
    }))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{
        HttpProxyConfig as WireHttpProxyConfig, LetsEncryptConfig as WireLetsEncryptConfig,
        ServiceType as WireServiceType,
    };

    fn config(services: Vec<RatholeService>, email: &str) -> RatholeConfig {
        RatholeConfig {
            bind_addr: "0.0.0.0:2333".into(),
            domain: None,
            default_token: Some("secret".into()),
            transport: WireTransportType::Tcp,
            tls: None,
            noise: None,
            websocket: None,
            http: Some(WireHttpProxyConfig {
                enabled: true,
                bind_addr: HTTP_PROXY_BIND_ADDR.into(),
                https_bind_addr: Some(HTTPS_PROXY_BIND_ADDR.into()),
                lets_encrypt: Some(WireLetsEncryptConfig {
                    enabled: true,
                    email: email.into(),
                    staging: Some(false),
                }),
            }),
            heartbeat_interval: None,
            services,
        }
    }

    fn service(name: &str, service_type: WireServiceType, host: &str) -> RatholeService {
        RatholeService {
            name: name.into(),
            service_type,
            bind_addr: "0.0.0.0:8080".into(),
            http_host: Some(host.into()),
            http_hosts: None,
            token: None,
            nodelay: None,
        }
    }

    fn service_with_hosts(
        name: &str,
        service_type: WireServiceType,
        hosts: &[&str],
    ) -> RatholeService {
        RatholeService {
            name: name.into(),
            service_type,
            bind_addr: "0.0.0.0:8080".into(),
            http_host: None,
            http_hosts: Some(hosts.iter().map(|host| host.to_string()).collect()),
            token: None,
            nodelay: None,
        }
    }

    #[test]
    fn ignores_lets_encrypt_without_https_routes() {
        let proxy = http_proxy_config(&config(
            vec![service("web", WireServiceType::Http, "app.example.com")],
            "",
        ))
        .unwrap()
        .unwrap();

        assert!(proxy.lets_encrypt.is_none());
        assert!(proxy.https_bind_addr.is_none());
        assert!(proxy.https_hosts.is_empty());
        assert_eq!(proxy.routes.len(), 1);
        assert_eq!(proxy.routes[0].upstream_addr, "memory://web");
    }

    #[test]
    fn lets_encrypt_uses_only_https_route_hosts() {
        let proxy = http_proxy_config(&config(
            vec![
                service("web", WireServiceType::Http, "app.example.com"),
                service("secure", WireServiceType::Https, "secure.example.com"),
            ],
            "admin@example.com",
        ))
        .unwrap()
        .unwrap();

        assert!(proxy.lets_encrypt.is_some());
        assert_eq!(
            proxy.https_bind_addr.as_deref(),
            Some(HTTPS_PROXY_BIND_ADDR)
        );
        assert_eq!(proxy.https_hosts, vec!["secure.example.com".to_string()]);
        assert_eq!(proxy.routes.len(), 2);
        assert_eq!(
            proxy
                .routes
                .iter()
                .map(|route| route.upstream_addr.as_str())
                .collect::<Vec<_>>(),
            vec!["memory://web", "memory://secure"]
        );
    }

    #[test]
    fn expands_multiple_hosts_for_one_service() {
        let proxy = http_proxy_config(&config(
            vec![service_with_hosts(
                "secure",
                WireServiceType::Https,
                &["secure.example.com", "www.example.com"],
            )],
            "admin@example.com",
        ))
        .unwrap()
        .unwrap();

        assert_eq!(
            proxy
                .routes
                .iter()
                .map(|route| (route.host.as_str(), route.upstream_addr.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("secure.example.com", "memory://secure"),
                ("www.example.com", "memory://secure"),
            ]
        );
        assert_eq!(
            proxy.https_hosts,
            vec![
                "secure.example.com".to_string(),
                "www.example.com".to_string()
            ]
        );
    }

    #[test]
    fn requires_lets_encrypt_email_only_for_https_routes() {
        let error = http_proxy_config(&config(
            vec![service(
                "secure",
                WireServiceType::Https,
                "secure.example.com",
            )],
            "",
        ))
        .unwrap_err();

        assert!(error.to_string().contains("account email"));
    }

    #[test]
    fn server_config_uses_virtual_binds_for_http_services() {
        let mut tcp = service("ssh", WireServiceType::Tcp, "");
        tcp.bind_addr = "0.0.0.0:5202".into();
        tcp.http_host = None;
        tcp.http_hosts = None;

        let server = to_server_config(config(
            vec![
                tcp,
                service("web", WireServiceType::Http, "app.example.com"),
                service("secure", WireServiceType::Https, "secure.example.com"),
            ],
            "admin@example.com",
        ))
        .unwrap();

        assert_eq!(
            server.services.get("ssh").unwrap().bind_addr.as_str(),
            "0.0.0.0:5202"
        );
        assert_eq!(
            server.services.get("web").unwrap().bind_addr.as_str(),
            "memory://web"
        );
        assert_eq!(
            server.services.get("secure").unwrap().bind_addr.as_str(),
            "memory://secure"
        );
    }
}
