//! Captures `tracing` output (from both the agent and the embedded rathole)
//! and forwards each formatted line into an mpsc channel so it can be streamed
//! to the hub, while still echoing to stderr for local debugging.

use std::io::Write;
use tokio::sync::mpsc::UnboundedSender;
use tracing_subscriber::fmt::MakeWriter;

#[derive(Clone)]
pub struct ChannelWriter {
    tx: UnboundedSender<String>,
}

impl Write for ChannelWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // Echo locally.
        let _ = std::io::stderr().write_all(buf);
        if let Ok(text) = std::str::from_utf8(buf) {
            for line in text.split_inclusive('\n') {
                let trimmed = line.trim_end();
                if !trimmed.is_empty() {
                    let _ = self.tx.send(trimmed.to_string());
                }
            }
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        std::io::stderr().flush()
    }
}

#[derive(Clone)]
pub struct ChannelMakeWriter {
    tx: UnboundedSender<String>,
}

impl ChannelMakeWriter {
    pub fn new(tx: UnboundedSender<String>) -> Self {
        Self { tx }
    }
}

impl<'a> MakeWriter<'a> for ChannelMakeWriter {
    type Writer = ChannelWriter;
    fn make_writer(&'a self) -> Self::Writer {
        ChannelWriter { tx: self.tx.clone() }
    }
}
