//! Self-enrollment: the agent logs in with the operator's panel account, then
//! registers itself as a new instance and stores the returned credentials.
//!
//! Flow (all over HTTPS):
//!   POST {base}/api/login          -> sets the admin session cookie
//!   POST {base}/api/agent/enroll   -> { instanceId, agentToken, name, created }
//!
//! The cookie store on the ureq Agent carries the session between the two calls.

use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use url::Url;

/// Persisted identity of this node after a successful enrollment.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    /// Panel origin, e.g. `https://panel.example.com` (no path).
    pub hub_url: String,
    /// Stable node id used for idempotent re-enrollment.
    pub node_id: String,
    pub instance_id: String,
    pub agent_token: String,
    pub name: String,
}

impl Identity {
    pub fn load(path: &Path) -> Result<Option<Identity>> {
        match std::fs::read(path) {
            Ok(bytes) => {
                let id = serde_json::from_slice(&bytes)
                    .with_context(|| format!("parsing identity file {}", path.display()))?;
                Ok(Some(id))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        let json = serde_json::to_vec_pretty(self)?;
        std::fs::write(path, json).with_context(|| format!("writing {}", path.display()))?;
        // Credentials — keep them owner-only.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

/// A stable identifier for this machine, used so a re-enrolling agent reclaims
/// its existing instance instead of creating a duplicate.
pub fn node_id() -> String {
    if let Ok(v) = std::env::var("NODE_ID") {
        let v = v.trim();
        if !v.is_empty() {
            return v.to_string();
        }
    }
    for path in ["/etc/machine-id", "/var/lib/dbus/machine-id"] {
        if let Ok(s) = std::fs::read_to_string(path) {
            let s = s.trim();
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    // Fall back to random bytes (persisted inside the identity file after enroll).
    let mut buf = [0u8; 16];
    if let Ok(bytes) = std::fs::read("/dev/urandom") {
        for (i, b) in bytes.iter().take(16).enumerate() {
            buf[i] = *b;
        }
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[derive(Deserialize)]
struct EnrollResult {
    #[serde(rename = "instanceId")]
    instance_id: String,
    #[serde(rename = "agentToken")]
    agent_token: String,
    name: String,
    #[allow(dead_code)]
    created: bool,
}

/// Normalize any hub URL (ws/wss/http/https, with or without a path) to its
/// bare HTTP(S) origin, e.g. `https://panel.example.com:8443`.
pub fn http_origin(hub_url: &str) -> Result<String> {
    let u = Url::parse(hub_url).context("invalid hub URL")?;
    let https = matches!(u.scheme(), "https" | "wss");
    let host = u.host_str().context("hub URL has no host")?;
    let scheme = if https { "https" } else { "http" };
    let mut base = format!("{scheme}://{host}");
    if let Some(port) = u.port() {
        base = format!("{base}:{port}");
    }
    Ok(base)
}

/// Log in with the panel account and enroll this node, returning the identity.
pub fn login_and_enroll(
    hub_url: &str,
    username: &str,
    password: &str,
    node_id: &str,
    name: &str,
) -> Result<Identity> {
    let base = http_origin(hub_url)?;
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(20))
        .build();

    // 1) Login — captures the session cookie in the agent's cookie store.
    let login = agent
        .post(&format!("{base}/api/login"))
        .send_json(ureq::json!({ "username": username, "password": password }));
    match login {
        Ok(_) => {}
        Err(ureq::Error::Status(401, _)) => bail!("invalid username or password"),
        Err(ureq::Error::Status(code, resp)) => {
            let msg = resp.into_string().unwrap_or_default();
            bail!("login failed ({code}): {}", msg.trim());
        }
        Err(e) => return Err(anyhow!(e)).context("could not reach the panel to log in"),
    }

    // 2) Enroll — reuses the session cookie.
    let enroll = agent
        .post(&format!("{base}/api/agent/enroll"))
        .send_json(ureq::json!({ "nodeId": node_id, "name": name }));
    let result: EnrollResult = match enroll {
        Ok(resp) => resp.into_json().context("parsing enroll response")?,
        Err(ureq::Error::Status(code, resp)) => {
            let msg = resp.into_string().unwrap_or_default();
            bail!("enrollment failed ({code}): {}", msg.trim());
        }
        Err(e) => return Err(anyhow!(e)).context("could not reach the panel to enroll"),
    };

    Ok(Identity {
        hub_url: base,
        node_id: node_id.to_string(),
        instance_id: result.instance_id,
        agent_token: result.agent_token,
        name: result.name,
    })
}

/// Default path for the persisted identity file.
pub fn identity_path() -> std::path::PathBuf {
    std::env::var("IDENTITY_PATH")
        .unwrap_or_else(|_| "/var/lib/rathole-manage/identity.json".to_string())
        .into()
}

#[cfg(test)]
mod tests {
    use super::http_origin;

    #[test]
    fn normalizes_schemes_and_strips_path() {
        assert_eq!(
            http_origin("https://panel.example.com/api/agent/ws").unwrap(),
            "https://panel.example.com"
        );
        assert_eq!(
            http_origin("wss://h.example.com:8443/x").unwrap(),
            "https://h.example.com:8443"
        );
        assert_eq!(
            http_origin("ws://h.example.com:2333").unwrap(),
            "http://h.example.com:2333"
        );
        assert_eq!(
            http_origin("http://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
    }

    #[test]
    fn rejects_garbage() {
        assert!(http_origin("not a url").is_err());
        assert!(http_origin("https://").is_err());
    }
}
