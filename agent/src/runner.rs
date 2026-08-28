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

use crate::http_proxy::{
    CustomCertificateConfig as AgentCustomCertificateConfig,
    HttpProxyConfig as AgentHttpProxyConfig, HttpProxyRunner, HttpRoute,
};
use crate::protocol::{
    truncate_cert_error, CertificateStatus, DesiredProcessState, ProcessState, RatholeConfig,
    RatholeService, ServiceRef, ServiceType as WireServiceType, TrafficStat,
    TransportType as WireTransportType,
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
        let proxy_on = proxy_enabled(&config);
        let services = config
            .services
            .iter()
            .map(|svc| ServiceRef {
                name: svc.name.clone(),
                bind_addr: service_bind_addr(svc, proxy_on),
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

        self.restart().await
    }

    /// Start the embedded rathole server if it isn't already running.
    ///
    /// The HTTP proxy is brought up on a best-effort basis: a proxy failure (a
    /// bad DNS record breaking ACME, say) used to abort this whole function, so
    /// rathole never started and *every* TCP/UDP tunnel on the node went down
    /// with HTTPS. Now rathole starts regardless and the proxy error is folded
    /// into the return value at the end, so an explicit Start command still
    /// reports it.
    pub async fn start(&mut self) -> Result<()> {
        let proxy_error = match self.http_proxy.apply(self.http_config.clone()).await {
            Ok(()) => None,
            Err(e) => {
                tracing::error!("HTTP proxy failed to start, continuing without it: {e:#}");
                Some(e)
            }
        };
        let started = self.start_rathole().await;
        match (started, proxy_error) {
            (Err(e), _) => {
                self.last_error = Some(format!("{e:#}"));
                Err(e)
            }
            (Ok(()), Some(e)) => {
                // rathole is up, so `state()` says Running; this is what tells the
                // hub that HTTPS is nevertheless down (see `last_error()`).
                self.last_error = Some(format!("{e:#}"));
                Err(e)
            }
            (Ok(()), None) => {
                // Everything came up: retire any error left over from a previous
                // attempt, including one start_rathole skipped clearing because
                // rathole was already running.
                self.last_error = None;
                Ok(())
            }
        }
    }

    async fn start_rathole(&mut self) -> Result<()> {
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

    pub async fn restart(&mut self) -> Result<()> {
        self.stop().await;
        if let Err(e) = self.start().await {
            // `start` has already recorded it in last_error. Log it so it reaches
            // the panel's live log stream, and return it so config acks and
            // command results stop claiming success.
            tracing::error!("restart failed: {e:#}");
            return Err(e);
        }
        Ok(())
    }

    /// Certificate state to report to the hub, if the proxy has any.
    pub fn certificate_status(&self) -> Option<CertificateStatus> {
        self.http_proxy.certificate_status()
    }

    /// Last error worth showing next to the process state: a failed start or
    /// stop, or an HTTP proxy that failed while rathole itself kept running.
    /// Cleared once everything comes up cleanly.
    pub fn last_error(&self) -> Option<String> {
        self.last_error.as_deref().map(truncate_cert_error)
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

fn service_config(service: RatholeService, proxy_enabled: bool) -> ServerServiceConfig {
    let bind_addr = service_bind_addr(&service, proxy_enabled);
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

/// Whether the node runs the HTTP proxy at all. With it off, no backend is
/// routed no matter what its own switch says, so every service must keep its
/// public bind or it would be reachable from nowhere.
fn proxy_enabled(config: &RatholeConfig) -> bool {
    config.http.as_ref().is_some_and(|http| http.enabled)
}

/// Where rathole binds this service on the server.
///
/// A backend that is routed over HTTP is reachable only through the proxy: it
/// gets an in-memory virtual bind instead of a public port, so the panel's
/// `bindAddr` is kept (routing can be paused again) but never listened on.
fn service_bind_addr(service: &RatholeService, proxy_enabled: bool) -> String {
    match service.service_type {
        WireServiceType::Http | WireServiceType::Https => virtual_bind_addr(&service.name),
        WireServiceType::Tcp if proxy_enabled && !service_http_hosts(service).is_empty() => {
            virtual_bind_addr(&service.name)
        }
        WireServiceType::Tcp | WireServiceType::Udp => service.bind_addr.clone(),
    }
}

/// Hosts the proxy should route for this service: the configured set, or
/// nothing while routing is switched off (the panel keeps the hosts so the
/// backend can be paused without losing them).
fn service_http_hosts(service: &RatholeService) -> Vec<String> {
    if service.http_enabled == Some(false) {
        return Vec::new();
    }
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
            // Only reached with the proxy on (checked above), so routed backends
            // resolve to their virtual bind here.
            let upstream_addr = service_bind_addr(svc, true);
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
    // No routes yet is not a reason to leave the proxy down: with the switch on
    // it listens (answering 404 and ACME challenges) so that adding the first
    // host is a config change, not a cold start.

    let mut custom_certificates = config
        .services
        .iter()
        .filter_map(|service| {
            let certificate = service.custom_certificate.as_ref()?.clone();
            if !certificate.enabled {
                return None;
            }
            Some(AgentCustomCertificateConfig {
                hosts: service_http_hosts(service),
                certificate_pem: certificate.certificate_pem,
                private_key_pem: certificate.private_key_pem,
            })
        })
        .filter(|certificate| !certificate.hosts.is_empty())
        .collect::<Vec<_>>();

    // Accept the previous panel's global certificate and apply it only to
    // backends that do not already have their own certificate.
    let legacy_custom_certificate = http
        .custom_certificate
        .as_ref()
        .filter(|certificate| certificate.enabled);
    if let Some(legacy) = legacy_custom_certificate {
        let hosts = config
            .services
            .iter()
            .filter(|service| {
                !service
                    .custom_certificate
                    .as_ref()
                    .is_some_and(|c| c.enabled)
            })
            .flat_map(service_http_hosts)
            .collect::<Vec<_>>();
        if !hosts.is_empty() {
            custom_certificates.push(AgentCustomCertificateConfig {
                hosts,
                certificate_pem: legacy.certificate_pem.clone(),
                private_key_pem: legacy.private_key_pem.clone(),
            });
        }
    }

    // Let's Encrypt covers only backends without an operator-provided cert.
    let https_hosts = config
        .services
        .iter()
        .filter(|service| {
            legacy_custom_certificate.is_none()
                && !service
                    .custom_certificate
                    .as_ref()
                    .is_some_and(|c| c.enabled)
        })
        .flat_map(service_http_hosts)
        .collect::<Vec<_>>();

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

    let https_enabled = lets_encrypt.is_some() || !custom_certificates.is_empty();

    Ok(Some(AgentHttpProxyConfig {
        bind_addr: HTTP_PROXY_BIND_ADDR.into(),
        https_bind_addr: https_enabled.then(|| HTTPS_PROXY_BIND_ADDR.into()),
        lets_encrypt,
        custom_certificates,
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

    let proxy_on = proxy_enabled(&config);
    let services = config
        .services
        .into_iter()
        .map(|svc| (svc.name.clone(), service_config(svc, proxy_on)))
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
        CustomCertificateConfig as WireCustomCertificateConfig,
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
                custom_certificate: None,
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
            http_enabled: None,
            custom_certificate: None,
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
            http_enabled: None,
            custom_certificate: None,
            token: None,
            nodelay: None,
        }
    }

    #[test]
    fn a_disabled_proxy_puts_routed_backends_back_on_their_public_bind() {
        let mut config = config(
            vec![service("web", WireServiceType::Tcp, "app.example.com")],
            "admin@example.com",
        );
        config.http.as_mut().unwrap().enabled = false;

        assert!(http_proxy_config(&config).unwrap().is_none());
        let server = to_server_config(config).unwrap();
        assert_eq!(
            server.services.get("web").unwrap().bind_addr.as_str(),
            "0.0.0.0:8080"
        );
    }

    #[test]
    fn a_paused_backend_routes_nothing_and_needs_no_certificate() {
        let mut config = config(
            vec![
                service("paused", WireServiceType::Tcp, "paused.example.com"),
                service("live", WireServiceType::Tcp, "live.example.com"),
            ],
            "admin@example.com",
        );
        config.services[0].http_enabled = Some(false);

        let proxy = http_proxy_config(&config).unwrap().unwrap();
        assert_eq!(
            proxy
                .routes
                .iter()
                .map(|r| r.host.as_str())
                .collect::<Vec<_>>(),
            vec!["live.example.com"]
        );
        assert_eq!(proxy.https_hosts, vec!["live.example.com"]);

        // Pausing the only routed backend leaves the proxy up with no routes
        // and nothing to issue a certificate for.
        config.services[1].http_enabled = Some(false);
        let proxy = http_proxy_config(&config).unwrap().unwrap();
        assert!(proxy.routes.is_empty());
        assert!(proxy.lets_encrypt.is_none());
        assert!(proxy.https_bind_addr.is_none());
    }

    #[test]
    fn http_routes_use_a_virtual_bind() {
        let proxy = http_proxy_config(&config(
            vec![service("web", WireServiceType::Tcp, "app.example.com")],
            "admin@example.com",
        ))
        .unwrap()
        .unwrap();

        assert!(proxy.lets_encrypt.is_some());
        assert_eq!(proxy.https_hosts, vec!["app.example.com".to_string()]);
        assert_eq!(proxy.routes.len(), 1);
        assert_eq!(proxy.routes[0].upstream_addr, "memory://web");
    }

    #[test]
    fn custom_certificate_enables_https_for_tcp_routes() {
        let mut config = config(
            vec![service("web", WireServiceType::Tcp, "app.example.com")],
            "admin@example.com",
        );
        config.services[0].custom_certificate = Some(WireCustomCertificateConfig {
            enabled: true,
            certificate_pem: "certificate pem".into(),
            private_key_pem: "private key pem".into(),
        });

        let proxy = http_proxy_config(&config).unwrap().unwrap();
        assert!(proxy.lets_encrypt.is_none());
        assert_eq!(
            proxy.https_bind_addr.as_deref(),
            Some(HTTPS_PROXY_BIND_ADDR)
        );
        let custom = &proxy.custom_certificates[0];
        assert_eq!(custom.hosts, vec!["app.example.com"]);
        assert_eq!(custom.certificate_pem, "certificate pem");
        assert_eq!(custom.private_key_pem, "private key pem");
    }

    #[test]
    fn custom_certificate_only_replaces_acme_for_its_backend() {
        let mut config = config(
            vec![
                service("custom", WireServiceType::Tcp, "custom.example.com"),
                service("acme", WireServiceType::Tcp, "acme.example.com"),
            ],
            "admin@example.com",
        );
        config.services[0].custom_certificate = Some(WireCustomCertificateConfig {
            enabled: true,
            certificate_pem: "certificate pem".into(),
            private_key_pem: "private key pem".into(),
        });

        let proxy = http_proxy_config(&config).unwrap().unwrap();
        assert!(proxy.lets_encrypt.is_some());
        assert_eq!(proxy.https_hosts, vec!["acme.example.com"]);
        assert_eq!(proxy.custom_certificates.len(), 1);
        assert_eq!(
            proxy.custom_certificates[0].hosts,
            vec!["custom.example.com"]
        );
    }

    #[test]
    fn legacy_global_certificate_covers_backends_without_acme() {
        let mut config = config(
            vec![service("web", WireServiceType::Tcp, "app.example.com")],
            "admin@example.com",
        );
        config.http.as_mut().unwrap().custom_certificate = Some(WireCustomCertificateConfig {
            enabled: true,
            certificate_pem: "legacy certificate".into(),
            private_key_pem: "legacy key".into(),
        });

        let proxy = http_proxy_config(&config).unwrap().unwrap();
        assert!(proxy.lets_encrypt.is_none());
        assert!(proxy.https_hosts.is_empty());
        assert_eq!(proxy.custom_certificates[0].hosts, vec!["app.example.com"]);
    }

    #[test]
    fn lets_encrypt_uses_all_tcp_http_route_hosts() {
        let proxy = http_proxy_config(&config(
            vec![
                service("web", WireServiceType::Tcp, "app.example.com"),
                service("secure", WireServiceType::Tcp, "secure.example.com"),
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
        assert_eq!(
            proxy.https_hosts,
            vec![
                "app.example.com".to_string(),
                "secure.example.com".to_string()
            ]
        );
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
                WireServiceType::Tcp,
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
    fn requires_lets_encrypt_email_for_tcp_http_routes() {
        let error = http_proxy_config(&config(
            vec![service(
                "secure",
                WireServiceType::Tcp,
                "secure.example.com",
            )],
            "",
        ))
        .unwrap_err();

        assert!(error.to_string().contains("account email"));
    }

    #[test]
    fn server_config_uses_virtual_binds_for_http_routes() {
        let mut tcp = service("ssh", WireServiceType::Tcp, "");
        tcp.bind_addr = "0.0.0.0:5202".into();
        tcp.http_host = None;
        tcp.http_hosts = None;

        let server = to_server_config(config(
            vec![
                tcp,
                service("web", WireServiceType::Tcp, "app.example.com"),
                service("secure", WireServiceType::Tcp, "secure.example.com"),
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
