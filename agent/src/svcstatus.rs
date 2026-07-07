//! Per-service online state derived from rathole's own instrumentation — no
//! port probing and no log-text matching.
//!
//! rathole wraps each control channel in a span `handle` carrying
//! `service = <name>` (`ControlChannelHandle::new`), and that span is propagated
//! into the long-lived `run` task via `.instrument(Span::current())`. So the
//! span's lifetime == the control channel's lifetime. We simply count live
//! `handle` spans per service: a service is online while at least one is open.
//! Counting (rather than a bool) keeps it correct when a client reconnects and
//! briefly overlaps the previous channel.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tracing::span::{Attributes, Id};
use tracing::Subscriber;
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

/// The rathole span whose lifetime tracks a control channel.
const HANDLE_SPAN: &str = "handle";

/// Shared name -> online map, read by the status reporter.
pub type ServiceStatus = Arc<Mutex<HashMap<String, bool>>>;

/// Service name recorded on a `handle` span, so we can find it again on close.
#[derive(Clone)]
struct SpanService(String);

pub struct ServiceStatusLayer {
    online: ServiceStatus,
    /// Live `handle` span count per service (internal).
    counts: Mutex<HashMap<String, u32>>,
}

impl ServiceStatusLayer {
    pub fn new(online: ServiceStatus) -> Self {
        Self {
            online,
            counts: Mutex::new(HashMap::new()),
        }
    }

    fn set_online(&self, service: &str, up: bool) {
        self.online.lock().unwrap().insert(service.to_string(), up);
    }

    fn opened(&self, service: String) {
        let up = {
            let mut counts = self.counts.lock().unwrap();
            let n = counts.entry(service.clone()).or_insert(0);
            *n += 1;
            *n > 0
        };
        self.set_online(&service, up);
    }

    fn closed(&self, service: String) {
        let up = {
            let mut counts = self.counts.lock().unwrap();
            let n = counts.entry(service.clone()).or_insert(0);
            *n = n.saturating_sub(1);
            *n > 0
        };
        self.set_online(&service, up);
    }
}

/// Pull the `service` field off a span's attributes.
fn service_of(attrs: &Attributes<'_>) -> Option<String> {
    use std::fmt;
    use tracing::field::{Field, Visit};

    struct Grab(Option<String>);
    impl Visit for Grab {
        fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
            if self.0.is_none() && field.name() == "service" {
                self.0 = Some(format!("{value:?}"));
            }
        }
        fn record_str(&mut self, field: &Field, value: &str) {
            if field.name() == "service" {
                self.0 = Some(value.to_string());
            }
        }
    }

    let mut grab = Grab(None);
    attrs.record(&mut grab);
    grab.0
}

impl<S> Layer<S> for ServiceStatusLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        if attrs.metadata().name() != HANDLE_SPAN {
            return;
        }
        let Some(service) = service_of(attrs) else {
            return;
        };
        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(SpanService(service.clone()));
        }
        self.opened(service);
    }

    fn on_close(&self, id: Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(&id) else {
            return;
        };
        let service = span.extensions().get::<SpanService>().map(|s| s.0.clone());
        if let Some(service) = service {
            self.closed(service);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::prelude::*;

    fn with_layer(body: impl FnOnce(&ServiceStatus)) {
        let status: ServiceStatus = Arc::new(Mutex::new(HashMap::new()));
        let subscriber =
            tracing_subscriber::registry().with(ServiceStatusLayer::new(status.clone()));
        tracing::subscriber::with_default(subscriber, || body(&status));
    }

    fn online(status: &ServiceStatus, name: &str) -> Option<bool> {
        status.lock().unwrap().get(name).copied()
    }

    #[test]
    fn handle_span_lifetime_drives_online_state() {
        with_layer(|status| {
            {
                let span = tracing::info_span!("handle", service = %"ssh");
                let _enter = span.enter();
                assert_eq!(online(status, "ssh"), Some(true));
            }
            // Span dropped → control channel closed.
            assert_eq!(online(status, "ssh"), Some(false));
        });
    }

    #[test]
    fn overlapping_reconnect_stays_online() {
        with_layer(|status| {
            let first = tracing::info_span!("handle", service = %"web");
            assert_eq!(online(status, "web"), Some(true));
            // Client reconnects: a new channel opens before the old one closes.
            let second = tracing::info_span!("handle", service = %"web");
            drop(first);
            assert_eq!(online(status, "web"), Some(true));
            drop(second);
            assert_eq!(online(status, "web"), Some(false));
        });
    }

    #[test]
    fn non_handle_spans_are_ignored() {
        with_layer(|status| {
            let _span = tracing::info_span!("run", service = %"db").entered();
            assert_eq!(online(status, "db"), None);
        });
    }

    #[test]
    fn handle_span_without_service_is_ignored() {
        with_layer(|status| {
            let _span = tracing::info_span!("handle").entered();
            assert!(status.lock().unwrap().is_empty());
        });
    }
}
