use crate::acme::LetsEncryptConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRoute {
    pub host: String,
    pub upstream_addr: String,
    pub service: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomCertificateConfig {
    pub hosts: Vec<String>,
    pub certificate_pem: String,
    pub private_key_pem: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpProxyConfig {
    pub bind_addr: String,
    pub https_bind_addr: Option<String>,
    pub lets_encrypt: Option<LetsEncryptConfig>,
    pub custom_certificates: Vec<CustomCertificateConfig>,
    pub https_hosts: Vec<String>,
    pub routes: Vec<HttpRoute>,
}

#[cfg(unix)]
mod imp {
    use super::{HttpProxyConfig, HttpRoute};
    use crate::acme::{
        store_custom_certificate, AcmeIssuer, CertificateOutcome, CertificatePaths, ChallengeStore,
        LetsEncryptConfig,
    };
    use crate::protocol::{truncate_cert_error, CertificateState, CertificateStatus};
    use anyhow::{bail, Context, Result as AnyResult};
    use async_trait::async_trait;
    use bytes::Bytes;
    use pingora::http::ResponseHeader;
    use pingora::listeners::tls::TlsSettings;
    use pingora::listeners::TlsAccept;
    use pingora::prelude::{
        ConnectError, Error, HttpPeer, ProxyHttp, RequestHeader, Result as PingoraResult, Server,
        Session,
    };
    use pingora::protocols::l4::stream::Stream as PingoraStream;
    use pingora::protocols::l4::virt::{VirtualSockOpt, VirtualSocket, VirtualSocketStream};
    use pingora::protocols::tls::{CustomALPN, ALPN};
    use pingora::protocols::Stream as PingoraIoStream;
    use pingora::proxy::{http_proxy_service_with_name_custom, ProcessCustomSession};
    use pingora::server::configuration::ServerConf;
    use pingora::server::{RunArgs, ShutdownSignal, ShutdownSignalWatch};
    use pingora::tls::ext;
    use pingora::tls::pkey::{PKey, Private};
    use pingora::tls::ssl::{NameType, SslRef};
    use pingora::tls::x509::X509;
    use pingora::upstreams::peer::Peer;
    use std::collections::HashMap;
    use std::fs;
    use std::future::Future;
    use std::net::TcpListener;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::pin::Pin;
    use std::sync::mpsc::{self, Receiver, TryRecvError};
    use std::sync::{Arc, RwLock};
    use std::task::{Context as TaskContext, Poll};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;
    use tokio::io::{AsyncRead, AsyncWrite, DuplexStream, ReadBuf};
    use tokio::sync::Notify;

    #[derive(Clone)]
    struct RouteState {
        upstream_addr: String,
        service: String,
    }

    struct SharedState {
        routes: RwLock<HashMap<String, RouteState>>,
        challenges: Arc<ChallengeStore>,
    }

    impl Default for SharedState {
        fn default() -> Self {
            Self {
                routes: RwLock::new(HashMap::new()),
                challenges: Arc::new(ChallengeStore::default()),
            }
        }
    }

    struct RequestCtx {
        host: Option<String>,
        route: Option<RouteState>,
    }

    struct HostRouter {
        shared: Arc<SharedState>,
    }

    #[derive(Debug)]
    struct RatholeVirtualSocket(DuplexStream);

    impl AsyncRead for RatholeVirtualSocket {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.0).poll_read(cx, buf)
        }
    }

    impl AsyncWrite for RatholeVirtualSocket {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            Pin::new(&mut self.0).poll_write(cx, buf)
        }

        fn poll_flush(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.0).poll_flush(cx)
        }

        fn poll_shutdown(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.0).poll_shutdown(cx)
        }
    }

    impl VirtualSocket for RatholeVirtualSocket {
        fn set_socket_option(&self, _opt: VirtualSockOpt) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[derive(Clone, Copy)]
    struct RatholeConnector;

    #[async_trait]
    impl pingora::connectors::http::custom::Connector for RatholeConnector {
        type Session = ();

        async fn get_http_session<P: Peer + Send + Sync + 'static>(
            &self,
            peer: &P,
        ) -> PingoraResult<(
            pingora::connectors::http::custom::Connection<Self::Session>,
            bool,
        )> {
            let key = peer.sni();
            let duplex = rathole::open_virtual_tcp(key).await.map_err(|error| {
                Error::because(ConnectError, "opening rathole virtual upstream", error)
            })?;
            let stream = PingoraStream::from(VirtualSocketStream::new(Box::new(
                RatholeVirtualSocket(duplex),
            )));
            Ok((
                pingora::connectors::http::custom::Connection::Stream(
                    Box::new(stream) as PingoraIoStream
                ),
                false,
            ))
        }

        async fn reused_http_session<P: Peer + Send + Sync + 'static>(
            &self,
            _peer: &P,
        ) -> Option<Self::Session> {
            None
        }

        async fn release_http_session<P: Peer + Send + Sync + 'static>(
            &self,
            _session: Self::Session,
            _peer: &P,
            _idle_timeout: Option<Duration>,
        ) {
        }
    }

    #[async_trait]
    impl ProxyHttp for HostRouter {
        type CTX = RequestCtx;

        fn new_ctx(&self) -> Self::CTX {
            RequestCtx {
                host: None,
                route: None,
            }
        }

        async fn request_filter(
            &self,
            session: &mut Session,
            ctx: &mut Self::CTX,
        ) -> PingoraResult<bool> {
            if let Some(token) = acme_challenge_token(session) {
                if let Some(value) = self.shared.challenges.get(token) {
                    respond_text(session, 200, value).await?;
                    return Ok(true);
                }
                session.respond_error(404).await?;
                return Ok(true);
            }

            let Some(host) = request_host(session) else {
                session.respond_error(400).await?;
                return Ok(true);
            };
            let route = {
                let routes = self
                    .shared
                    .routes
                    .read()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                routes.get(&host).cloned()
            };
            let Some(route) = route else {
                session.respond_error(404).await?;
                return Ok(true);
            };
            ctx.host = Some(host);
            ctx.route = Some(route);
            Ok(false)
        }

        async fn upstream_peer(
            &self,
            _session: &mut Session,
            ctx: &mut Self::CTX,
        ) -> PingoraResult<Box<HttpPeer>> {
            let route = ctx
                .route
                .as_ref()
                .expect("Pingora HTTP route should be set by request_filter");
            let mut peer = HttpPeer::new(("127.0.0.1", 0), false, route.upstream_addr.clone());
            peer.options.alpn = ALPN::Custom(CustomALPN::new(b"rathole-memory".to_vec()));
            Ok(Box::new(peer))
        }

        async fn upstream_request_filter(
            &self,
            _session: &mut Session,
            upstream_request: &mut RequestHeader,
            ctx: &mut Self::CTX,
        ) -> PingoraResult<()> {
            if let Some(host) = &ctx.host {
                if let Err(error) = upstream_request.insert_header("Host", host.as_str()) {
                    tracing::warn!(%host, ?error, "failed to set upstream Host header");
                }
            }
            Ok(())
        }

        async fn logging(
            &self,
            _session: &mut Session,
            error: Option<&Error>,
            ctx: &mut Self::CTX,
        ) {
            if let Some(route) = &ctx.route {
                tracing::debug!(
                    service = %route.service,
                    upstream = %route.upstream_addr,
                    host = ?ctx.host,
                    error = ?error.map(|e| e.to_string()),
                    "Pingora proxied HTTP request"
                );
            }
        }
    }

    struct ManualShutdown {
        notify: Arc<Notify>,
    }

    impl ShutdownSignalWatch for ManualShutdown {
        fn recv<'life0, 'async_trait>(
            &'life0 self,
        ) -> Pin<Box<dyn Future<Output = ShutdownSignal> + Send + 'async_trait>>
        where
            'life0: 'async_trait,
            Self: 'async_trait,
        {
            let notify = self.notify.clone();
            Box::pin(async move {
                notify.notified().await;
                ShutdownSignal::GracefulTerminate
            })
        }
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct CertificateBinding {
        hosts: Vec<String>,
        certificate: CertificatePaths,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct RuntimeConfig {
        bind_addr: String,
        https_bind_addr: Option<String>,
        certificates: Vec<CertificateBinding>,
    }

    impl RuntimeConfig {
        fn http_only(bind_addr: impl Into<String>) -> Self {
            Self {
                bind_addr: bind_addr.into(),
                https_bind_addr: None,
                certificates: Vec::new(),
            }
        }
    }

    struct Running {
        config: RuntimeConfig,
        shutdown: Arc<Notify>,
        done_rx: Receiver<std::result::Result<(), String>>,
        thread: Option<JoinHandle<()>>,
    }

    pub struct HttpProxyRunner {
        shared: Arc<SharedState>,
        running: Option<Running>,
        cert_status: Option<CertificateStatus>,
    }

    impl Default for HttpProxyRunner {
        fn default() -> Self {
            Self::new()
        }
    }

    impl HttpProxyRunner {
        pub fn new() -> Self {
            Self {
                shared: Arc::new(SharedState::default()),
                running: None,
                cert_status: None,
            }
        }

        /// Last known Let's Encrypt certificate state, for the status report to
        /// the hub. Operator-provided certificates are not tracked here: the
        /// panel already holds their PEM and can inspect them itself.
        pub fn certificate_status(&self) -> Option<CertificateStatus> {
            self.cert_status.clone()
        }

        pub async fn apply(&mut self, config: Option<HttpProxyConfig>) -> AnyResult<()> {
            // `None` means the proxy is switched off. An enabled proxy with no
            // routes still runs, so the operator's switch is observable and the
            // first host can be added without a cold start.
            let Some(config) = config else {
                self.set_routes(&[]);
                self.cert_status = None;
                self.stop().await?;
                return Ok(());
            };

            self.set_routes(&config.routes);
            let mut runtime = RuntimeConfig::http_only(config.bind_addr.clone());
            let mut renewed = false;
            // No Let's Encrypt this time round: drop any state from a previous config.
            if config.lets_encrypt.is_none() {
                self.cert_status = None;
            }

            if let Some(lets_encrypt) = config.lets_encrypt.as_ref() {
                // Cleared up front so an early error below cannot leave a report
                // describing the previous config's domains or staging flag.
                self.cert_status = None;
                self.ensure_http_listener(&config.bind_addr).await?;
                let domains = route_domains(&config.https_hosts);
                if domains.is_empty() {
                    self.cert_status = None;
                } else {
                    // Scoped so the immutable borrow of `self` ends before the
                    // `&mut self` write below.
                    let outcome = {
                        let issuer = AcmeIssuer::new(self.shared.challenges.clone());
                        issuer.ensure_certificate(lets_encrypt, &domains).await
                    };
                    let outcome = outcome.context("ensuring Let's Encrypt certificate")?;
                    self.cert_status = Some(certificate_status(&outcome, lets_encrypt, &domains));
                    renewed = outcome.renewed;

                    if let Some(error) = outcome.error.as_deref() {
                        tracing::error!(domains = ?domains, "Let's Encrypt issuance failed: {error}");
                    }
                    match outcome.paths {
                        Some(certificate) => runtime.certificates.push(CertificateBinding {
                            hosts: domains,
                            certificate,
                        }),
                        // Nothing servable: those hosts stay on plain HTTP so the
                        // challenge endpoint keeps working for the next attempt.
                        None => tracing::warn!(
                            "serving HTTP only for the Let's Encrypt hosts until a certificate is available"
                        ),
                    }
                }
            }
            for custom in &config.custom_certificates {
                let certificate =
                    store_custom_certificate(&custom.certificate_pem, &custom.private_key_pem)
                        .context("storing custom HTTPS certificate")?;
                runtime.certificates.push(CertificateBinding {
                    hosts: route_domains(&custom.hosts),
                    certificate,
                });
            }
            if !runtime.certificates.is_empty() {
                runtime.https_bind_addr = config.https_bind_addr.clone();
            }

            if renewed && self.running.is_some() {
                // RuntimeConfig compares certificate *paths*, and a renewal rewrites
                // the same files, so ensure_running would see no change and leave
                // Pingora holding the old certificate it read at startup.
                tracing::info!("restarting the HTTP proxy to load the renewed certificate");
                self.stop().await?;
            }
            self.ensure_running(runtime).await?;
            Ok(())
        }

        pub async fn stop(&mut self) -> AnyResult<()> {
            let Some(running) = self.running.take() else {
                return Ok(());
            };
            tokio::task::spawn_blocking(move || stop_running(running))
                .await
                .context("joining Pingora stop task")?
        }

        pub fn refresh(&mut self) -> Option<String> {
            let status = match self.running.as_ref() {
                Some(running) => match running.done_rx.try_recv() {
                    Ok(result) => Some(result),
                    Err(TryRecvError::Disconnected) => {
                        Some(Err("Pingora HTTP proxy exited without status".into()))
                    }
                    Err(TryRecvError::Empty) => None,
                },
                None => None,
            };
            status.and_then(|result| {
                if let Some(mut running) = self.running.take() {
                    if let Some(thread) = running.thread.take() {
                        let _ = thread.join();
                    }
                }
                result.err()
            })
        }

        fn set_routes(&self, routes: &[HttpRoute]) {
            let mut map = self
                .shared
                .routes
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            map.clear();
            for route in routes {
                map.insert(
                    normalize_route_host(&route.host),
                    RouteState {
                        upstream_addr: route.upstream_addr.clone(),
                        service: route.service.clone(),
                    },
                );
            }
        }

        async fn ensure_http_listener(&mut self, bind_addr: &str) -> AnyResult<()> {
            if self
                .running
                .as_ref()
                .is_some_and(|running| running.config.bind_addr == bind_addr)
            {
                return Ok(());
            }
            self.ensure_running(RuntimeConfig::http_only(bind_addr))
                .await
        }

        async fn ensure_running(&mut self, config: RuntimeConfig) -> AnyResult<()> {
            if self
                .running
                .as_ref()
                .is_some_and(|running| running.config == config)
            {
                return Ok(());
            }

            self.stop().await?;
            self.start(config)?;
            Ok(())
        }

        fn start(&mut self, config: RuntimeConfig) -> AnyResult<()> {
            validate_runtime_bind_available(&config)?;

            let shutdown = Arc::new(Notify::new());
            let thread_shutdown = shutdown.clone();
            let thread_shared = self.shared.clone();
            let thread_config = config.clone();
            let (done_tx, done_rx) = mpsc::channel();
            let thread = thread::Builder::new()
                .name("rathole-agent-pingora".into())
                .spawn(move || {
                    let result = catch_unwind(AssertUnwindSafe(|| {
                        run_pingora(thread_config, thread_shared, thread_shutdown)
                    }))
                    .unwrap_or_else(|_| Err("Pingora HTTP proxy panicked".into()));
                    let _ = done_tx.send(result);
                })
                .context("spawning Pingora HTTP proxy thread")?;

            tracing::info!(
                bind_addr = %config.bind_addr,
                https_bind_addr = ?config.https_bind_addr,
                "started Pingora HTTP proxy"
            );
            self.running = Some(Running {
                config,
                shutdown,
                done_rx,
                thread: Some(thread),
            });
            Ok(())
        }
    }

    fn validate_runtime_bind_available(config: &RuntimeConfig) -> AnyResult<()> {
        validate_bind_available(&config.bind_addr, "HTTP")?;
        if let Some(https_bind_addr) = &config.https_bind_addr {
            if https_bind_addr == &config.bind_addr {
                bail!("Pingora HTTPS bind address must be different from HTTP bind address");
            }
            validate_bind_available(https_bind_addr, "HTTPS")?;
        }
        Ok(())
    }

    /// How long to keep retrying a bind that fails with "address in use".
    ///
    /// A proxy that was just stopped releases its listeners a moment after its
    /// server loop returns, so the very next bind can race it; anything much
    /// longer than this means somebody else owns the port.
    const BIND_RETRY_WINDOW: Duration = Duration::from_secs(5);
    const BIND_RETRY_STEP: Duration = Duration::from_millis(200);

    /// Probe that `bind_addr` can be listened on, retrying briefly while the
    /// previous listener lets go of it.
    fn validate_bind_available(bind_addr: &str, label: &str) -> AnyResult<()> {
        let deadline = std::time::Instant::now() + BIND_RETRY_WINDOW;
        loop {
            match TcpListener::bind(bind_addr) {
                Ok(listener) => {
                    drop(listener);
                    return Ok(());
                }
                Err(error)
                    if error.kind() == std::io::ErrorKind::AddrInUse
                        && std::time::Instant::now() < deadline =>
                {
                    thread::sleep(BIND_RETRY_STEP);
                }
                Err(error) => {
                    let hint = if error.kind() == std::io::ErrorKind::AddrInUse {
                        " (another program is listening there, or the previous proxy has not released it)"
                    } else {
                        ""
                    };
                    return Err(anyhow::Error::new(error).context(format!(
                        "binding Pingora {label} proxy on {bind_addr}{hint}"
                    )));
                }
            }
        }
    }

    /// Block until `bind_addr` can be bound again, or the retry window passes.
    /// Used after a stop so the caller can start a replacement immediately.
    fn wait_until_bindable(bind_addr: &str) {
        let deadline = std::time::Instant::now() + BIND_RETRY_WINDOW;
        while std::time::Instant::now() < deadline {
            match TcpListener::bind(bind_addr) {
                Ok(listener) => {
                    drop(listener);
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                    thread::sleep(BIND_RETRY_STEP);
                }
                // Anything else (permissions, bad address) is for the next
                // start to report properly.
                Err(_) => return,
            }
        }
        tracing::warn!(%bind_addr, "stopped proxy has not released its port yet");
    }

    /// Upper bound on a stop: the 1s grace period plus the 2s runtime shutdown
    /// configured in `run_pingora`, with room for the thread to unwind.
    const STOP_TIMEOUT: Duration = Duration::from_secs(10);

    fn stop_running(mut running: Running) -> AnyResult<()> {
        running.shutdown.notify_waiters();
        let result = match running.done_rx.recv_timeout(STOP_TIMEOUT) {
            Ok(result) => result.map_err(anyhow::Error::msg),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                bail!(
                    "Pingora HTTP proxy did not stop within {}s",
                    STOP_TIMEOUT.as_secs()
                )
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Ok(()),
        };
        if let Some(thread) = running.thread.take() {
            let _ = thread.join();
        }
        // The server loop returning does not mean the kernel has closed the
        // listeners yet; make sure a replacement can bind before we hand back.
        wait_until_bindable(&running.config.bind_addr);
        if let Some(https_bind_addr) = &running.config.https_bind_addr {
            wait_until_bindable(https_bind_addr);
        }
        result
    }

    fn run_pingora(
        config: RuntimeConfig,
        shared: Arc<SharedState>,
        shutdown: Arc<Notify>,
    ) -> std::result::Result<(), String> {
        // Pingora's graceful stop otherwise sleeps its built-in 300s grace
        // period before letting go of the ports, which is longer than any
        // caller can wait: a certificate renewal restarts this proxy and the
        // new instance cannot bind :80/:443 until the old one is gone. One
        // second lets in-flight requests finish; the runtimes get two more.
        let conf = ServerConf {
            grace_period_seconds: Some(1),
            graceful_shutdown_timeout_seconds: Some(2),
            ..ServerConf::default()
        };
        let mut server = Server::new_with_opt_and_conf(None, conf);
        server.bootstrap();
        let router = HostRouter { shared };
        let on_custom: ProcessCustomSession<HostRouter, RatholeConnector> =
            Arc::new(|_, stream, _| Box::pin(async move { Some(stream) }));
        let mut service = http_proxy_service_with_name_custom(
            &server.configuration,
            router,
            "rathole-agent-pingora",
            RatholeConnector,
            on_custom,
        );
        service.add_tcp(&config.bind_addr);
        if let Some(https_bind_addr) = config.https_bind_addr.as_ref() {
            let dynamic_certificates = DynamicCertificates::load(&config.certificates)?;
            let mut tls_settings = TlsSettings::with_callbacks(Box::new(dynamic_certificates))
                .map_err(|e| format!("creating TLS settings: {e:#}"))?;
            tls_settings.enable_h2();
            service.add_tls_with_settings(https_bind_addr, None, tls_settings);
        }
        server.add_service(service);
        server.run(RunArgs {
            shutdown_signal: Box::new(ManualShutdown { notify: shutdown }),
        });
        tracing::info!("Pingora HTTP proxy stopped");
        Ok(())
    }

    struct LoadedCertificate {
        hosts: Vec<String>,
        chain: Vec<X509>,
        private_key: PKey<Private>,
    }

    struct DynamicCertificates {
        certificates: Vec<LoadedCertificate>,
    }

    impl DynamicCertificates {
        fn load(bindings: &[CertificateBinding]) -> std::result::Result<Self, String> {
            let certificates = bindings
                .iter()
                .map(|binding| {
                    let certificate_pem =
                        fs::read(&binding.certificate.cert_path).map_err(|e| {
                            format!(
                                "reading certificate {}: {e}",
                                binding.certificate.cert_path.display()
                            )
                        })?;
                    let chain = X509::stack_from_pem(&certificate_pem)
                        .map_err(|e| format!("parsing certificate chain: {e:#}"))?;
                    if chain.is_empty() {
                        return Err("certificate chain contains no certificates".into());
                    }
                    let private_key_pem = fs::read(&binding.certificate.key_path).map_err(|e| {
                        format!(
                            "reading private key {}: {e}",
                            binding.certificate.key_path.display()
                        )
                    })?;
                    let private_key = PKey::private_key_from_pem(&private_key_pem)
                        .map_err(|e| format!("parsing certificate private key: {e:#}"))?;
                    Ok(LoadedCertificate {
                        hosts: route_domains(&binding.hosts),
                        chain,
                        private_key,
                    })
                })
                .collect::<std::result::Result<Vec<_>, String>>()?;
            if certificates.is_empty() {
                return Err("HTTPS listener requires at least one certificate".into());
            }
            Ok(Self { certificates })
        }
    }

    #[async_trait]
    impl TlsAccept for DynamicCertificates {
        async fn certificate_callback(&self, ssl: &mut SslRef) {
            let sni = ssl
                .servername(NameType::HOST_NAME)
                .map(normalize_route_host);
            let certificate = sni
                .as_ref()
                .and_then(|host| {
                    self.certificates
                        .iter()
                        .find(|certificate| certificate.hosts.contains(host))
                })
                .or_else(|| self.certificates.first());
            let Some(certificate) = certificate else {
                return;
            };
            let result = (|| {
                ext::ssl_use_certificate(ssl, &certificate.chain[0])?;
                ext::ssl_use_private_key(ssl, &certificate.private_key)?;
                for intermediate in certificate.chain.iter().skip(1) {
                    ext::ssl_add_chain_cert(ssl, intermediate)?;
                }
                Ok::<_, pingora::tls::error::ErrorStack>(())
            })();
            if let Err(error) = result {
                tracing::error!(sni = ?sni, ?error, "failed to select HTTPS certificate");
            }
        }
    }

    async fn respond_text(session: &mut Session, status: u16, value: String) -> PingoraResult<()> {
        let body = Bytes::from(value);
        let mut response = ResponseHeader::build(status, Some(3))?;
        response.insert_header("content-type", "text/plain")?;
        response.set_content_length(body.len())?;
        session
            .write_response_header(Box::new(response), false)
            .await?;
        session.write_response_body(Some(body), true).await
    }

    fn acme_challenge_token(session: &Session) -> Option<&str> {
        let path = session.req_header().uri.path();
        let token = path.strip_prefix("/.well-known/acme-challenge/")?;
        (!token.is_empty() && !token.contains('/')).then_some(token)
    }

    fn request_host(session: &Session) -> Option<String> {
        let raw = session.get_header("host")?.to_str().ok()?;
        let normalized = normalize_request_host(raw);
        (!normalized.is_empty()).then_some(normalized)
    }

    /// Fold an issuance result into the shape the hub and panel consume.
    fn certificate_status(
        outcome: &CertificateOutcome,
        lets_encrypt: &LetsEncryptConfig,
        domains: &[String],
    ) -> CertificateStatus {
        // A certificate inside its renewal window is renewed on the spot, so a
        // successful outcome is always fresh: there is no "expiring" state to
        // report, only "renewal failed" (which keeps serving the old one).
        let state = if outcome.error.is_some() {
            CertificateState::Failed
        } else if outcome.facts.not_after_ms.is_none() {
            CertificateState::Pending
        } else {
            CertificateState::Valid
        };
        // Describe the certificate we are actually serving, not the set that was
        // requested: a failed re-issue falls back to the previous certificate,
        // whose SAN set may not include a newly added host.
        let domains = match outcome.paths {
            Some(_) => outcome
                .facts
                .covered_domains
                .clone()
                .unwrap_or_else(|| domains.to_vec()),
            // Nothing servable, so nothing is covered.
            None => Vec::new(),
        };
        CertificateStatus {
            domains,
            staging: lets_encrypt.staging,
            state,
            not_after: outcome.facts.not_after_ms,
            error: outcome.error.as_deref().map(truncate_cert_error),
            checked_at: crate::now_ms(),
        }
    }

    fn route_domains(hosts: &[String]) -> Vec<String> {
        let mut domains = hosts
            .iter()
            .map(|host| normalize_route_host(host))
            .filter(|host| !host.is_empty())
            .collect::<Vec<_>>();
        domains.sort();
        domains.dedup();
        domains
    }

    fn normalize_route_host(host: &str) -> String {
        host.trim().trim_end_matches('.').to_ascii_lowercase()
    }

    fn normalize_request_host(host: &str) -> String {
        let trimmed = host.trim();
        let host_without_port = if trimmed.starts_with('[') {
            trimmed
        } else {
            trimmed.split_once(':').map(|(h, _)| h).unwrap_or(trimmed)
        };
        normalize_route_host(host_without_port)
    }
}

#[cfg(not(unix))]
mod imp {
    use super::HttpProxyConfig;
    use crate::protocol::CertificateStatus;
    use anyhow::{bail, Result};

    #[derive(Default)]
    pub struct HttpProxyRunner;

    impl HttpProxyRunner {
        pub fn new() -> Self {
            Self
        }

        /// No proxy on this platform, so never a certificate.
        pub fn certificate_status(&self) -> Option<CertificateStatus> {
            None
        }

        pub async fn apply(&mut self, config: Option<HttpProxyConfig>) -> Result<()> {
            if config.is_some() {
                bail!("Pingora HTTP proxy is only available on Unix agent targets");
            }
            Ok(())
        }

        pub async fn stop(&mut self) -> Result<()> {
            Ok(())
        }

        pub fn refresh(&mut self) -> Option<String> {
            None
        }
    }
}

pub use imp::HttpProxyRunner;
