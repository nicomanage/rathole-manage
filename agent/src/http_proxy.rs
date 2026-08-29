use crate::acme::LetsEncryptConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRoute {
    pub host: String,
    pub upstream_addr: String,
    pub upstream_tls: bool,
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
    use pingora::connectors::L4Connect;
    use pingora::http::ResponseHeader;
    use pingora::listeners::tls::TlsSettings;
    use pingora::listeners::{TcpSocketOptions, TlsAccept};
    use pingora::prelude::{
        ConnectError, Error, HttpPeer, ProxyHttp, RequestHeader, Result as PingoraResult, Server,
        Session,
    };
    use pingora::protocols::l4::socket::SocketAddr as PingoraSocketAddr;
    use pingora::protocols::l4::stream::Stream as PingoraStream;
    use pingora::protocols::l4::virt::{VirtualSockOpt, VirtualSocket, VirtualSocketStream};
    use pingora::proxy::http_proxy_service_with_name;
    use pingora::server::configuration::ServerConf;
    use pingora::server::{RunArgs, ShutdownSignal, ShutdownSignalWatch};
    use pingora::tls::ext;
    use pingora::tls::pkey::{PKey, Private};
    use pingora::tls::ssl::{NameType, SslRef};
    use pingora::tls::x509::X509;
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
        upstream_tls: bool,
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

    #[derive(Debug)]
    struct RatholeConnector {
        upstream_addr: String,
    }

    fn upstream_peer_for_route(route: &RouteState, host: Option<&str>) -> HttpPeer {
        let port = if route.upstream_tls { 443 } else { 80 };
        let mut peer = HttpPeer::new(
            ("127.0.0.1", port),
            route.upstream_tls,
            host.unwrap_or_default().to_string(),
        );
        peer.options.custom_l4 = Some(Arc::new(RatholeConnector {
            upstream_addr: route.upstream_addr.clone(),
        }));
        if route.upstream_tls {
            // These backends live behind the authenticated rathole tunnel and
            // commonly use self-signed, expired, or hostname-mismatched
            // certificates. Encrypt the hop but deliberately do not use the
            // certificate as an identity check.
            peer.options.verify_cert = false;
            peer.options.verify_hostname = false;
        }
        peer
    }

    #[async_trait]
    impl L4Connect for RatholeConnector {
        async fn connect(&self, _addr: &PingoraSocketAddr) -> PingoraResult<PingoraStream> {
            let duplex = rathole::open_virtual_tcp(&self.upstream_addr)
                .await
                .map_err(|error| {
                    Error::because(ConnectError, "opening rathole virtual upstream", error)
                })?;
            Ok(PingoraStream::from(VirtualSocketStream::new(Box::new(
                RatholeVirtualSocket(duplex),
            ))))
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
            // The socket itself comes from rathole, while Pingora's normal
            // transport connector still owns the optional TLS handshake. This
            // is important for HTTPS backends: returning a raw stream from a
            // custom HTTP connector would make Pingora speak plaintext to the
            // backend and never reach certificate verification at all.
            Ok(Box::new(upstream_peer_for_route(
                route,
                ctx.host.as_deref(),
            )))
        }

        async fn upstream_request_filter(
            &self,
            session: &mut Session,
            upstream_request: &mut RequestHeader,
            ctx: &mut Self::CTX,
        ) -> PingoraResult<()> {
            if let Some(host) = &ctx.host {
                if let Err(error) = upstream_request.insert_header("Host", host.as_str()) {
                    tracing::warn!(%host, ?error, "failed to set upstream Host header");
                }
                let _ = upstream_request.insert_header("X-Forwarded-Host", host.as_str());
            }
            // Tell the backend what the visitor used, independently of whether
            // the backend hop itself is HTTP or HTTPS. Without this a backend that
            // redirects http→https (nginx `return 301 https://…`) loops forever.
            let downstream = session.as_downstream();
            let proto = if downstream.digest().is_some_and(|d| d.ssl_digest.is_some()) {
                "https"
            } else {
                "http"
            };
            let _ = upstream_request.insert_header("X-Forwarded-Proto", proto);
            if let Some(ip) = downstream
                .client_addr()
                .and_then(|addr| addr.as_inet())
                .map(|addr| addr.ip().to_string())
            {
                let _ = upstream_request.insert_header("X-Forwarded-For", ip.as_str());
                let _ = upstream_request.insert_header("X-Real-IP", ip.as_str());
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
                    upstream_tls = route.upstream_tls,
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
        /// Set by `renew_certificate`; consumed by the next `apply`, which then
        /// re-issues even when the certificate on disk is still fresh.
        force_renew: bool,
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
                force_renew: false,
            }
        }

        /// Operator-triggered "renew now": re-run `apply` with the freshness
        /// short-circuit disabled, so the certificate is re-issued from the
        /// currently configured directory (production or staging).
        pub async fn renew_certificate(
            &mut self,
            config: Option<HttpProxyConfig>,
        ) -> AnyResult<()> {
            let Some(config) = config.filter(|c| c.lets_encrypt.is_some()) else {
                bail!("Let's Encrypt is not enabled on this node");
            };
            if route_domains(&config.https_hosts).is_empty() {
                bail!("no backend is routed with Let's Encrypt, nothing to renew");
            }
            self.force_renew = true;
            let result = self.apply(Some(config)).await;
            // `apply` consumes the flag; clear it here too in case it bailed early.
            self.force_renew = false;
            result
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
                let configured = route_domains(&config.https_hosts);
                // A name that does not resolve cannot pass HTTP-01: Let's Encrypt
                // would fail the whole order, and repeated attempts count against
                // the failed-validation rate limit. Drop those names here and
                // order for the rest, so one typo does not cost every host its
                // certificate.
                let (domains, unresolved) = split_resolvable(&configured).await;
                if !unresolved.is_empty() {
                    tracing::warn!(
                        hosts = ?unresolved,
                        "skipping Let's Encrypt for hosts that do not resolve"
                    );
                }
                if domains.is_empty() {
                    self.cert_status = (!configured.is_empty())
                        .then(|| unresolved_status(lets_encrypt, &unresolved));
                } else {
                    // Scoped so the immutable borrow of `self` ends before the
                    // `&mut self` write below.
                    let force = std::mem::take(&mut self.force_renew);
                    let outcome = {
                        let issuer = AcmeIssuer::new(self.shared.challenges.clone());
                        issuer
                            .ensure_certificate(lets_encrypt, &domains, force)
                            .await
                    };
                    let outcome = outcome.context("ensuring Let's Encrypt certificate")?;
                    let mut status = certificate_status(&outcome, lets_encrypt, &domains);
                    if !unresolved.is_empty() {
                        // Surfaced next to whatever the issuance itself said: the
                        // certificate can be perfectly valid and still not cover
                        // the host the operator is actually testing.
                        status.error = Some(truncate_cert_error(&join_errors(
                            status.error.as_deref(),
                            &unresolved_message(&unresolved),
                        )));
                    }
                    self.cert_status = Some(status);
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

        /// Reap the proxy thread if it has exited on its own, returning its
        /// error (if any). Leaves `running` alone while the thread is alive.
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
                        upstream_tls: route.upstream_tls,
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
            // A proxy that died since the last apply must not pass as "already
            // running with this config": reap it first so an identical config
            // still brings it back.
            if let Some(error) = self.refresh() {
                tracing::warn!("HTTP proxy had exited ({error}); starting it again");
            }
            if self
                .running
                .as_ref()
                .is_some_and(|running| running.config == config)
            {
                return Ok(());
            }

            self.stop().await?;
            self.start(config).await?;
            Ok(())
        }

        async fn start(&mut self, config: RuntimeConfig) -> AnyResult<()> {
            validate_runtime_bind_available(&config).await?;

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

            // Failures that happen before the server loop settles — a
            // certificate that does not load, a listener Pingora cannot bind —
            // surface on `done_rx` within a few hundred milliseconds. Wait that
            // long so they fail this call instead of being reported as a
            // success and only noticed by the next status tick.
            let started_at = std::time::Instant::now();
            let mut thread = Some(thread);
            while started_at.elapsed() < START_GRACE {
                let early_exit = match done_rx.try_recv() {
                    Err(TryRecvError::Empty) => {
                        tokio::time::sleep(START_POLL).await;
                        continue;
                    }
                    Ok(Err(message)) => message,
                    Ok(Ok(())) => "Pingora HTTP proxy exited immediately".to_string(),
                    Err(TryRecvError::Disconnected) => {
                        "Pingora HTTP proxy exited without status".to_string()
                    }
                };
                if let Some(thread) = thread.take() {
                    let _ = thread.join();
                }
                bail!("starting Pingora HTTP proxy: {early_exit}");
            }

            tracing::info!(
                bind_addr = %config.bind_addr,
                https_bind_addr = ?config.https_bind_addr,
                "started Pingora HTTP proxy"
            );
            self.running = Some(Running {
                config,
                shutdown,
                done_rx,
                thread,
            });
            Ok(())
        }
    }

    async fn validate_runtime_bind_available(config: &RuntimeConfig) -> AnyResult<()> {
        for (addr, _) in listen_addrs(&config.bind_addr) {
            validate_bind_available(&addr, "HTTP").await?;
        }
        if let Some(https_bind_addr) = &config.https_bind_addr {
            if https_bind_addr == &config.bind_addr {
                bail!("Pingora HTTPS bind address must be different from HTTP bind address");
            }
            for (addr, _) in listen_addrs(https_bind_addr) {
                validate_bind_available(&addr, "HTTPS").await?;
            }
        }
        Ok(())
    }

    /// The concrete sockets to open for a configured wildcard address.
    ///
    /// `[::]:port` is bound as two explicit listeners — `0.0.0.0:port` and an
    /// IPv6-only `[::]:port` — instead of relying on the kernel's dual-stack
    /// default: with `net.ipv6.bindv6only=1` a lone `[::]` would never see
    /// IPv4 clients, and with IPv6 disabled it would not bind at all. When the
    /// host has no IPv6 the v6 listener is simply skipped. Non-wildcard
    /// addresses are used as given.
    fn listen_addrs(bind_addr: &str) -> Vec<(String, Option<TcpSocketOptions>)> {
        let Some(port) = bind_addr.strip_prefix("[::]:") else {
            return vec![(bind_addr.to_string(), None)];
        };
        let mut addrs = vec![(format!("0.0.0.0:{port}"), None)];
        if ipv6_available() {
            let mut options = TcpSocketOptions::default();
            options.ipv6_only = Some(true);
            addrs.push((bind_addr.to_string(), Some(options)));
        } else {
            tracing::warn!(
                "IPv6 is not available on this host; the HTTP proxy listens on IPv4 only"
            );
        }
        addrs
    }

    /// Whether an IPv6 wildcard socket can be created and bound at all.
    fn ipv6_available() -> bool {
        TcpListener::bind("[::]:0").is_ok()
    }

    /// How long to keep retrying a bind that fails with "address in use".
    ///
    /// A proxy that was just stopped releases its listeners a moment after its
    /// server loop returns, so the very next bind can race it; anything much
    /// longer than this means somebody else owns the port.
    const BIND_RETRY_WINDOW: Duration = Duration::from_secs(5);
    const BIND_RETRY_STEP: Duration = Duration::from_millis(200);

    /// Probe that `bind_addr` can be listened on, retrying briefly while the
    /// previous listener lets go of it. Async so the wait yields the tokio
    /// worker instead of stalling status reports and the hub socket.
    async fn validate_bind_available(bind_addr: &str, label: &str) -> AnyResult<()> {
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
                    tokio::time::sleep(BIND_RETRY_STEP).await;
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

    /// How long `start` watches a freshly spawned proxy for an early exit
    /// (certificate load or listener bind failures) before calling it started.
    const START_GRACE: Duration = Duration::from_millis(750);
    const START_POLL: Duration = Duration::from_millis(50);

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
        for (addr, _) in listen_addrs(&running.config.bind_addr) {
            wait_until_bindable(&addr);
        }
        if let Some(https_bind_addr) = &running.config.https_bind_addr {
            for (addr, _) in listen_addrs(https_bind_addr) {
                wait_until_bindable(&addr);
            }
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
        let mut service =
            http_proxy_service_with_name(&server.configuration, router, "rathole-agent-pingora");
        for (addr, options) in listen_addrs(&config.bind_addr) {
            match options {
                Some(options) => service.add_tcp_with_settings(&addr, options),
                None => service.add_tcp(&addr),
            }
        }
        if let Some(https_bind_addr) = config.https_bind_addr.as_ref() {
            // One certificate store shared by every HTTPS listener (v4 and v6).
            let certificates = Arc::new(DynamicCertificates::load(&config.certificates)?);
            for (addr, options) in listen_addrs(https_bind_addr) {
                let mut tls_settings =
                    TlsSettings::with_callbacks(Box::new(SharedCertificates(certificates.clone())))
                        .map_err(|e| format!("creating TLS settings: {e:#}"))?;
                tls_settings.enable_h2();
                service.add_tls_with_settings(&addr, options, tls_settings);
            }
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

    /// `TlsSettings` takes ownership of its callback, and the proxy has one
    /// HTTPS listener per address family, so hand each one a handle to the
    /// same loaded store instead of parsing the certificates twice.
    struct SharedCertificates(Arc<DynamicCertificates>);

    #[async_trait]
    impl TlsAccept for SharedCertificates {
        async fn certificate_callback(&self, ssl: &mut SslRef) {
            self.0.certificate_callback(ssl).await
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
        let header = session.req_header();
        pick_request_host(
            header.headers.get("host").and_then(|v| v.to_str().ok()),
            header.uri.host(),
        )
    }

    /// Split hosts into those that resolve and those that do not.
    ///
    /// Resolution only — deliberately not "does it resolve to *this* node".
    /// A host fronted by a CDN resolves to the CDN's addresses and still passes
    /// HTTP-01 (the CDN forwards port 80), so comparing against our own
    /// addresses would reject working setups. A name that resolves nowhere,
    /// though, can never pass.
    async fn split_resolvable(domains: &[String]) -> (Vec<String>, Vec<String>) {
        let mut resolvable = Vec::new();
        let mut unresolved = Vec::new();
        for domain in domains {
            // Port 80 because that is where HTTP-01 will be answered; the port
            // itself plays no part in resolution.
            match tokio::net::lookup_host((domain.as_str(), 80)).await {
                // Mutating in a match guard is not allowed, so step the iterator
                // in the arm body instead.
                Ok(mut addrs) => {
                    if addrs.next().is_some() {
                        resolvable.push(domain.clone());
                    } else {
                        unresolved.push(domain.clone());
                    }
                }
                Err(error) => {
                    tracing::debug!(%domain, ?error, "DNS lookup failed before HTTP-01");
                    unresolved.push(domain.clone());
                }
            }
        }
        (resolvable, unresolved)
    }

    fn unresolved_message(unresolved: &[String]) -> String {
        format!(
            "{} do{} not resolve, so HTTP-01 cannot succeed for {}; point {} at this node in DNS",
            unresolved.join(", "),
            if unresolved.len() == 1 { "es" } else { "" },
            if unresolved.len() == 1 { "it" } else { "them" },
            if unresolved.len() == 1 { "it" } else { "them" },
        )
    }

    /// Status for "every configured host is unresolvable": nothing was ordered,
    /// so there is no certificate to describe, only the reason.
    fn unresolved_status(
        lets_encrypt: &LetsEncryptConfig,
        unresolved: &[String],
    ) -> CertificateStatus {
        CertificateStatus {
            domains: Vec::new(),
            staging: lets_encrypt.staging,
            state: CertificateState::Failed,
            not_after: None,
            error: Some(truncate_cert_error(&unresolved_message(unresolved))),
            checked_at: crate::now_ms(),
        }
    }

    fn join_errors(existing: Option<&str>, extra: &str) -> String {
        match existing {
            Some(existing) if !existing.is_empty() => format!("{existing}; {extra}"),
            _ => extra.to_string(),
        }
    }

    /// Which name the request is for, from the two places it can live.
    ///
    /// HTTP/1.1 sends a `Host` header; **HTTP/2 does not** — the name arrives as
    /// the `:authority` pseudo-header, which Pingora exposes as the request
    /// URI's authority. Reading only the header made every h2 request (i.e.
    /// every browser over HTTPS, since the listener advertises h2 via ALPN) fail
    /// to route and get a 400, while HTTP/1.1 clients were served normally.
    fn pick_request_host(header_host: Option<&str>, uri_host: Option<&str>) -> Option<String> {
        [header_host, uri_host]
            .into_iter()
            .flatten()
            .map(normalize_request_host)
            .find(|host| !host.is_empty())
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

    #[cfg(test)]
    mod tests {
        use super::*;
        use pingora::upstreams::peer::Peer;

        #[test]
        fn https_backend_uses_tls_and_accepts_an_invalid_certificate() {
            let route = RouteState {
                upstream_addr: "memory://web".into(),
                upstream_tls: true,
                service: "web".into(),
            };
            let peer = upstream_peer_for_route(&route, Some("app.example.com"));

            assert!(peer.tls());
            assert_eq!(peer.sni(), "app.example.com");
            assert!(!peer.verify_cert());
            assert!(!peer.verify_hostname());
            assert!(peer.options.custom_l4.is_some());
        }

        #[test]
        fn http_backend_stays_plaintext() {
            let route = RouteState {
                upstream_addr: "memory://web".into(),
                upstream_tls: false,
                service: "web".into(),
            };
            let peer = upstream_peer_for_route(&route, Some("app.example.com"));

            assert!(!peer.tls());
        }
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

        pub async fn renew_certificate(&mut self, _config: Option<HttpProxyConfig>) -> Result<()> {
            bail!("Pingora HTTP proxy is only available on Unix agent targets");
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
