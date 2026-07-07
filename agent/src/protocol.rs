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
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RatholeService {
    pub name: String,
    #[serde(rename = "type")]
    pub service_type: ServiceType,
    pub bind_addr: String,
    pub token: Option<String>,
    pub nodelay: Option<bool>,
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
    pub default_token: Option<String>,
    pub transport: TransportType,
    pub tls: Option<TlsConfig>,
    pub noise: Option<NoiseConfig>,
    pub websocket: Option<WebsocketConfig>,
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentCommand {
    Start,
    Stop,
    Restart,
    Reload,
    Status,
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
        metrics: Option<Metrics>,
        #[serde(skip_serializing_if = "Option::is_none")]
        service_status: Option<HashMap<String, bool>>,
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
        config: RatholeConfig,
        config_hash: String,
        #[serde(default)]
        services: Vec<ServiceRef>,
    },
    Command {
        command: AgentCommand,
    },
    Ping,
    Error {
        message: String,
    },
}
