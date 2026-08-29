//! Wire protocol shared with the Cloudflare Worker hub.
//! Mirrors `src/shared/types.ts` (`AgentToHub` / `HubToAgent`).
//!
//! Some variants/fields exist for protocol completeness and aren't all
//! constructed on the agent side, so dead-code analysis is relaxed here.
#![allow(dead_code)]

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransportType {
    Tcp,
    Tls,
    Noise,
    Websocket,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceType {
    Tcp,
    Udp,
    Http,
    Https,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RatholeService {
    pub name: String,
    #[serde(rename = "type")]
    pub service_type: ServiceType,
    pub bind_addr: String,
    pub http_host: Option<String>,
    pub http_hosts: Option<Vec<String>>,
    /// `Some(false)` keeps the hosts configured but routes nothing for them.
    pub http_enabled: Option<bool>,
    pub custom_certificate: Option<CustomCertificateConfig>,
    pub token: Option<String>,
    pub nodelay: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LetsEncryptConfig {
    pub enabled: bool,
    pub email: String,
    pub staging: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomCertificateConfig {
    pub enabled: bool,
    pub certificate_pem: String,
    pub private_key_pem: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpProxyConfig {
    pub enabled: bool,
    pub bind_addr: String,
    pub https_bind_addr: Option<String>,
    pub lets_encrypt: Option<LetsEncryptConfig>,
    pub custom_certificate: Option<CustomCertificateConfig>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TlsConfig {
    pub pkcs_path: Option<String>,
    pub keystore_password: Option<String>,
    pub trusted_root: Option<String>,
    pub hostname: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoiseConfig {
    pub pattern: Option<String>,
    pub local_private_key: Option<String>,
    pub remote_public_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebsocketConfig {
    pub tls: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RatholeConfig {
    pub bind_addr: String,
    pub domain: Option<String>,
    pub default_token: Option<String>,
    pub transport: TransportType,
    pub tls: Option<TlsConfig>,
    pub noise: Option<NoiseConfig>,
    pub websocket: Option<WebsocketConfig>,
    pub http: Option<HttpProxyConfig>,
    pub heartbeat_interval: Option<u64>,
    pub services: Vec<RatholeService>,
}

/// A service the agent reports status for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRef {
    pub name: String,
    pub bind_addr: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcessState {
    Running,
    Stopped,
    Errored,
    Unknown,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesiredProcessState {
    Running,
    Stopped,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentCommand {
    Start,
    Stop,
    Restart,
    Reload,
    Status,
    /// Re-issue the Let's Encrypt certificate now, even if the current one is
    /// still fresh (operator switched staging off, or wants a clean start).
    #[serde(rename = "renew_certificate")]
    RenewCertificate,
}

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_mb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rathole_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_in_sync: Option<bool>,
}

/// Cumulative bytes for one service.
#[derive(Debug, Default, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficStat {
    pub bytes_in: u64,
    pub bytes_out: u64,
}

/// State of the node's Let's Encrypt certificate. Mirrors `CertificateState` in
/// `src/shared/types.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CertificateState {
    /// Issued and outside the renewal window. There is no "expiring" state: a
    /// certificate inside the window is renewed on the spot, and a renewal that
    /// fails is reported as `Failed` while the old certificate keeps serving.
    Valid,
    /// The last issuance attempt errored.
    Failed,
    /// Configured, but nothing issued yet.
    Pending,
}

/// Live state of the single multi-SAN certificate this agent provisions.
///
/// `rename_all_fields` on `AgentToHub` only reaches that enum's own variant
/// fields, so this struct needs its own `rename_all` — like [`Metrics`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateStatus {
    /// SAN set the certificate covers, normalized and sorted.
    pub domains: Vec<String>,
    /// Whether it came from the Let's Encrypt staging directory.
    pub staging: bool,
    pub state: CertificateState,
    /// Expiry, epoch ms. None when nothing has been issued yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub not_after: Option<u64>,
    /// Error from the last failed issuance, truncated to [`MAX_CERT_ERROR_LEN`].
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Epoch ms of the last issuance attempt or freshness check.
    pub checked_at: u64,
}

/// ACME errors embed the account email and full order URLs, and the hub both
/// persists and renders whatever arrives, so cap what goes on the wire.
pub const MAX_CERT_ERROR_LEN: usize = 512;

/// Truncate on a char boundary so the result stays valid UTF-8.
pub fn truncate_cert_error(error: &str) -> String {
    if error.len() <= MAX_CERT_ERROR_LEN {
        return error.to_string();
    }
    let mut end = MAX_CERT_ERROR_LEN;
    while end > 0 && !error.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &error[..end])
}

/// Messages this agent sends up to the hub.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AgentToHub {
    Register {
        instance_id: String,
        token: String,
        agent_version: Option<String>,
        hostname: Option<String>,
    },
    Status {
        process_state: ProcessState,
        /// Omitted (not `null`) when absent: the hub's report validator only
        /// accepts a missing key or an object here.
        #[serde(skip_serializing_if = "Option::is_none")]
        metrics: Option<Metrics>,
        #[serde(skip_serializing_if = "Option::is_none")]
        service_status: Option<HashMap<String, bool>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        traffic: Option<HashMap<String, TrafficStat>>,
        /// Omitted when Let's Encrypt is off; the hub reads that as "clear it".
        ///
        /// Boxed to keep this variant from dwarfing the rest of the enum, the
        /// same reason `HubToAgent::ApplyConfig` boxes its config.
        #[serde(skip_serializing_if = "Option::is_none")]
        certificate: Option<Box<CertificateStatus>>,
        /// Last start/stop/proxy error, if any (see `Runner::last_error`).
        /// Omitted after a clean start; the hub reads that as "clear it".
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Log {
        line: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        stream: Option<String>,
        ts: u64,
    },
    ConfigAck {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    CommandResult {
        command: AgentCommand,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Pong,
}

/// Messages the hub sends down to this agent.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum HubToAgent {
    Registered {
        instance_id: String,
        name: String,
    },
    ApplyConfig {
        config: Box<RatholeConfig>,
        config_hash: String,
        #[serde(default)]
        services: Vec<ServiceRef>,
        #[serde(default)]
        desired_process_state: Option<DesiredProcessState>,
    },
    Command {
        command: AgentCommand,
    },
    Ping,
    Error {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status_json(certificate: Option<CertificateStatus>) -> serde_json::Value {
        let msg = AgentToHub::Status {
            process_state: ProcessState::Running,
            metrics: None,
            service_status: None,
            traffic: None,
            certificate: certificate.map(Box::new),
            error: None,
        };
        serde_json::from_str(&serde_json::to_string(&msg).expect("serialize")).expect("valid JSON")
    }

    /// `rename_all_fields` on the enum does not reach nested structs, so this
    /// pins the wire keys the hub reads (src/shared/types.ts).
    #[test]
    fn certificate_serializes_with_camel_case_keys() {
        let json = status_json(Some(CertificateStatus {
            domains: vec!["app.example.com".into()],
            staging: true,
            state: CertificateState::Valid,
            not_after: Some(1_700_000_000_000),
            error: None,
            checked_at: 1_699_000_000_000,
        }));

        assert_eq!(json["type"], "status");
        assert_eq!(json["processState"], "running");
        let cert = &json["certificate"];
        assert_eq!(cert["domains"][0], "app.example.com");
        assert_eq!(cert["staging"], true);
        assert_eq!(cert["state"], "valid");
        assert_eq!(cert["notAfter"], 1_700_000_000_000u64);
        assert_eq!(cert["checkedAt"], 1_699_000_000_000u64);
        assert!(cert.get("error").is_none(), "empty error must be omitted");
    }

    #[test]
    fn certificate_is_omitted_when_absent() {
        let json = status_json(None);
        assert!(json.get("certificate").is_none());
    }

    #[test]
    fn short_errors_pass_through_untouched() {
        assert_eq!(truncate_cert_error("boom"), "boom");
    }

    #[test]
    fn long_errors_truncate_on_a_char_boundary() {
        // Two bytes per char, so the cut lands mid-character without the guard.
        let long = "é".repeat(MAX_CERT_ERROR_LEN);
        let truncated = truncate_cert_error(&long);
        assert!(truncated.ends_with('…'));
        assert!(truncated.len() <= MAX_CERT_ERROR_LEN + '…'.len_utf8());
    }
}
