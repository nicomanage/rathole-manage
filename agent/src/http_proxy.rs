#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRoute {
    pub host: String,
    pub upstream_addr: String,
    pub service: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpProxyConfig {
    pub bind_addr: String,
    pub routes: Vec<HttpRoute>,
}

#[cfg(unix)]
mod imp {
    use super::{HttpProxyConfig, HttpRoute};
    use anyhow::{bail, Context, Result as AnyResult};
    use async_trait::async_trait;
    use pingora::prelude::{
        http_proxy_service, Error, HttpPeer, ProxyHttp, RequestHeader, Result as PingoraResult,
        Server, Session,
    };
    use pingora::server::{RunArgs, ShutdownSignal, ShutdownSignalWatch};
    use std::collections::HashMap;
    use std::future::Future;
    use std::net::TcpListener;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::pin::Pin;
    use std::sync::mpsc::{self, Receiver, TryRecvError};
    use std::sync::{Arc, RwLock};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;
    use tokio::sync::Notify;

    #[derive(Clone)]
    struct RouteState {
        upstream_addr: String,
        service: String,
    }

    #[derive(Default)]
    struct SharedRoutes {
        routes: RwLock<HashMap<String, RouteState>>,
    }

    struct RequestCtx {
        host: Option<String>,
        route: Option<RouteState>,
    }

    struct HostRouter {
        shared: Arc<SharedRoutes>,
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
            Ok(Box::new(HttpPeer::new(
                route.upstream_addr.as_str(),
                false,
                String::new(),
            )))
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

    struct Running {
        bind_addr: String,
        shutdown: Arc<Notify>,
        done_rx: Receiver<std::result::Result<(), String>>,
        thread: Option<JoinHandle<()>>,
    }

    pub struct HttpProxyRunner {
        shared: Arc<SharedRoutes>,
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
                shared: Arc::new(SharedRoutes::default()),
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
            if self
                .running
                .as_ref()
                .is_some_and(|running| running.bind_addr == config.bind_addr)
            {
                return Ok(());
            }

            self.stop().await?;
            self.start(&config.bind_addr)?;
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

        fn start(&mut self, bind_addr: &str) -> AnyResult<()> {
            validate_bind_available(bind_addr)?;

            let shutdown = Arc::new(Notify::new());
            let thread_shutdown = shutdown.clone();
            let thread_shared = self.shared.clone();
            let thread_bind = bind_addr.to_string();
            let (done_tx, done_rx) = mpsc::channel();
            let thread = thread::Builder::new()
                .name("rathole-agent-pingora".into())
                .spawn(move || {
                    let result = catch_unwind(AssertUnwindSafe(|| {
                        run_pingora(thread_bind, thread_shared, thread_shutdown)
                    }))
                    .unwrap_or_else(|_| Err("Pingora HTTP proxy panicked".into()));
                    let _ = done_tx.send(result);
                })
                .context("spawning Pingora HTTP proxy thread")?;

            tracing::info!(bind_addr = %bind_addr, "started Pingora HTTP proxy");
            self.running = Some(Running {
                bind_addr: bind_addr.to_string(),
                shutdown,
                done_rx,
                thread: Some(thread),
            });
            Ok(())
        }
    }

    fn validate_bind_available(bind_addr: &str) -> AnyResult<()> {
        let listener = TcpListener::bind(bind_addr)
            .with_context(|| format!("binding Pingora HTTP proxy on {bind_addr}"))?;
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
        bind_addr: String,
        shared: Arc<SharedRoutes>,
        shutdown: Arc<Notify>,
    ) -> std::result::Result<(), String> {
        let mut server = Server::new(None).map_err(|e| format!("{e:#}"))?;
        server.bootstrap();
        let router = HostRouter { shared };
        let mut service = http_proxy_service(&server.configuration, router);
        service.add_tcp(&bind_addr);
        server.add_service(service);
        server.run(RunArgs {
            shutdown_signal: Box::new(ManualShutdown { notify: shutdown }),
        });
        tracing::info!("Pingora HTTP proxy stopped");
        Ok(())
    }

    fn request_host(session: &Session) -> Option<String> {
        let raw = session.get_header("host")?.to_str().ok()?;
        let normalized = normalize_request_host(raw);
        (!normalized.is_empty()).then_some(normalized)
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
