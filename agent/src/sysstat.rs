//! Lightweight, dependency-free process metrics (Linux /proc based).
//! Falls back to `None` on non-Linux or when /proc is unavailable.

use std::time::Instant;

pub struct MetricsCollector {
    started: Instant,
    last_cpu_time: Option<f64>,
    last_sample: Instant,
}

impl MetricsCollector {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            last_cpu_time: None,
            last_sample: Instant::now(),
        }
    }

    pub fn uptime_seconds(&self) -> u64 {
        self.started.elapsed().as_secs()
    }

    /// Resident memory in MB, read from /proc/self/statm.
    pub fn memory_mb(&self) -> Option<f64> {
        let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
        let resident_pages: f64 = statm.split_whitespace().nth(1)?.parse().ok()?;
        let page_size = 4096.0; // getpagesize() is 4K on virtually all Linux hosts.
        Some(resident_pages * page_size / 1024.0 / 1024.0)
    }

    /// Process CPU usage percentage, computed as a delta between samples.
    pub fn cpu_percent(&mut self) -> Option<f64> {
        let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
        // Fields 14 (utime) and 15 (stime) are in clock ticks; skip past the
        // comm field which may contain spaces/parens.
        let after_comm = stat.rsplit_once(')')?.1;
        let fields: Vec<&str> = after_comm.split_whitespace().collect();
        // After ')' the first field is state, so utime is index 11, stime 12.
        let utime: f64 = fields.get(11)?.parse().ok()?;
        let stime: f64 = fields.get(12)?.parse().ok()?;
        let ticks_per_sec = 100.0; // CLOCK_TCK default on Linux.
        let cpu_time = (utime + stime) / ticks_per_sec;

        let now = Instant::now();
        let elapsed = now.duration_since(self.last_sample).as_secs_f64();
        let result = match self.last_cpu_time {
            Some(prev) if elapsed > 0.0 => Some(((cpu_time - prev) / elapsed * 100.0).max(0.0)),
            _ => None,
        };
        self.last_cpu_time = Some(cpu_time);
        self.last_sample = now;
        result
    }
}

pub fn hostname() -> Option<String> {
    std::fs::read_to_string("/proc/sys/kernel/hostname")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
