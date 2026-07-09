use crate::acme::LetsEncryptConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRoute {
    pub host: String,
    pub upstream_addr: String,
    pub service: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpProxyConfig {
    pub bind_addr: String,
    pub https_bind_addr: Option<String>,
    pub lets_encrypt: Option<LetsEncryptConfig>,
    pub https_hosts: Vec<String>,
    pub routes: Vec<HttpRoute>,
}

#[cfg(unix)]
mod imp {
    use super::{HttpProxyConfig, HttpRoute};
    use crate::acme::{AcmeIssuer, CertificatePaths, ChallengeStore};
    use anyhow::{bail, Context, Result as AnyResult};
    use async_trait::async_trait;
    use bytes::Bytes;
    use pingora::http::ResponseHeader;
    use pingora::prelude::{
        ConnectError, Error, HttpPeer, ProxyHttp, RequestHeader, Result as PingoraResult, Server,
        Session,
    };
    use pingora::protocols::l4::stream::Stream as PingoraStream;
    use pingora::protocols::l4::virt::{VirtualSockOpt, VirtualSocket, VirtualSocketStream};
    use pingora::protocols::tls::{CustomALPN, ALPN};
    use pingora::protocols::Stream as PingoraIoStream;
    use pingora::proxy::{http_proxy_service_with_name_custom, ProcessCustomSession};
    use pingora::server::{RunArgs, ShutdownSignal, ShutdownSignalWatch};
    use pingora::upstreams::peer::Peer;
    use std::collections::HashMap;
    use std::future::Future;
    use std::net::TcpListener;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::path::PathBuf;
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
    struct RuntimeConfig {
        bind_addr: String,
        https_bind_addr: Option<String>,
        certificate: Option<CertificatePaths>,
    }

    impl RuntimeConfig {
        fn http_only(bind_addr: impl Into<String>) -> Self {
            Self {
                bind_addr: bind_addr.into(),
                https_bind_addr: None,
                certificate: None,
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
            }
        }

        pub async fn apply(&mut self, config: Option<HttpProxyConfig>) -> AnyResult<()> {
            let Some(config) = config.filter(|c| !c.routes.is_empty()) else {
                self.set_routes(&[]);
                self.stop().await?;
                return Ok(());
            };

            self.set_routes(&config.routes);
            let mut runtime = RuntimeConfig::http_only(config.bind_addr.clone());

            if let Some(lets_encrypt) = config.lets_encrypt.as_ref() {
                self.ensure_http_listener(&config.bind_addr).await?;
                let domains = route_domains(&config.https_hosts);
                if domains.is_empty() {
                    self.ensure_running(runtime).await?;
                    return Ok(());
                }
                let issuer = AcmeIssuer::new(self.shared.challenges.clone());
                let certificate = issuer
                    .ensure_certificate(lets_encrypt, &domains)
                    .await
                    .context("ensuring Let's Encrypt certificate")?;
                runtime.https_bind_addr = config.https_bind_addr.clone();
                runtime.certificate = Some(certificate);
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

    fn validate_bind_available(bind_addr: &str, label: &str) -> AnyResult<()> {
        let listener = TcpListener::bind(bind_addr)
            .with_context(|| format!("binding Pingora {label} proxy on {bind_addr}"))?;
        drop(listener);
        Ok(())
    }

    fn stop_running(mut running: Running) -> AnyResult<()> {
        running.shutdown.notify_waiters();
        let result = match running.done_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(result) => result.map_err(anyhow::Error::msg),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                bail!("Pingora HTTP proxy did not stop within 5s")
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Ok(()),
        };
        if let Some(thread) = running.thread.take() {
            let _ = thread.join();
        }
        result
    }

    fn run_pingora(
        config: RuntimeConfig,
        shared: Arc<SharedState>,
        shutdown: Arc<Notify>,
    ) -> std::result::Result<(), String> {
        let mut server = Server::new(None).map_err(|e| format!("{e:#}"))?;
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
        if let (Some(https_bind_addr), Some(certificate)) =
            (config.https_bind_addr.as_ref(), config.certificate.as_ref())
        {
            let cert_path = path_to_str(&certificate.cert_path)?;
            let key_path = path_to_str(&certificate.key_path)?;
            service
                .add_tls(https_bind_addr, cert_path, key_path)
                .map_err(|e| format!("{e:#}"))?;
        }
        server.add_service(service);
        server.run(RunArgs {
            shutdown_signal: Box::new(ManualShutdown { notify: shutdown }),
        });
        tracing::info!("Pingora HTTP proxy stopped");
        Ok(())
    }

    fn path_to_str(path: &PathBuf) -> std::result::Result<&str, String> {
        path.to_str()
            .ok_or_else(|| format!("path is not valid UTF-8: {}", path.display()))
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
    use anyhow::{bail, Result};

    #[derive(Default)]
    pub struct HttpProxyRunner;

    impl HttpProxyRunner {
        pub fn new() -> Self {
            Self
        }

        pub async fn apply(&mut self, config: Option<HttpProxyConfig>) -> Result<()> {
            if config.as_ref().is_some_and(|c| !c.routes.is_empty()) {
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
