//! Per-service reachability check. rathole only listens on a service's public
//! port while a client is connected for it, so a successful local TCP connect to
//! that port means the service is online (has a live client).

use std::time::Duration;

use tokio::net::TcpStream;

const PROBE_TIMEOUT: Duration = Duration::from_millis(800);

/// True if something is accepting connections on the service's bind address.
pub async fn service_online(bind_addr: &str) -> bool {
    let Some(target) = local_target(bind_addr) else {
        return false;
    };
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, TcpStream::connect(&target)).await,
        Ok(Ok(_))
    )
}

/// Map a rathole bind address to a locally-connectable one. A wildcard host
/// (0.0.0.0 / ::) is probed via loopback.
fn local_target(bind_addr: &str) -> Option<String> {
    let (host, port) = bind_addr.rsplit_once(':')?;
    if port.is_empty() || port.parse::<u16>().is_err() {
        return None;
    }
    let host = host.trim_matches(|c| c == '[' || c == ']');
    let host = match host {
        "0.0.0.0" | "::" | "" | "*" => "127.0.0.1",
        h => h,
    };
    Some(format!("{host}:{port}"))
}
