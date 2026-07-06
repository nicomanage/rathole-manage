//! Supervises the embedded rathole server. rathole runs *in-process* via
//! `rathole::run()`; there is no child process. Config hot-reload is handled by
//! rathole itself (it watches the config file), so applying a new config is just
//! a file write. A full restart is available for changes rathole can't hot-swap.

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

use crate::protocol::ProcessState;

struct Running {
    shutdown: broadcast::Sender<bool>,
    handle: JoinHandle<Result<(), String>>,
}

pub struct Runner {
    config_path: PathBuf,
    inner: Option<Running>,
    last_error: Option<String>,
}

impl Runner {
    pub fn new(config_path: PathBuf) -> Self {
        Self {
            config_path,
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

    /// Overwrite the config file on disk (rathole hot-reloads it while running).
    pub async fn write_config(&self, toml: &str) -> Result<()> {
        if let Some(dir) = self.config_path.parent() {
            tokio::fs::create_dir_all(dir)
                .await
                .with_context(|| format!("creating config dir {}", dir.display()))?;
        }
        tokio::fs::write(&self.config_path, toml)
            .await
            .with_context(|| format!("writing config {}", self.config_path.display()))?;
        Ok(())
    }

    /// Start the embedded rathole server if it isn't already running.
    pub fn start(&mut self) {
        if self.is_running() {
            return;
        }
        let (tx, rx) = broadcast::channel::<bool>(4);
        let cli = rathole::Cli {
            config_path: Some(self.config_path.clone()),
            server: true,
            client: false,
            genkey: None,
        };
        tracing::info!(config = %self.config_path.display(), "starting embedded rathole server");
        let handle = tokio::spawn(async move {
            match rathole::run(cli, rx).await {
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
    }

    pub async fn restart(&mut self) {
        self.stop().await;
        self.start();
    }
}
