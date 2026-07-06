//! Per-service online state derived from rathole's own `tracing` events — no
//! port probing. rathole instruments its control-channel handling with a span
//! carrying `service = <name>` and logs "Control channel established" when a
//! client connects and "Control channel shutdown" when it disconnects. This
//! layer watches those events and maintains a name -> online map.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use tracing::field::{Field, Visit};
use tracing::span::Attributes;
use tracing::{Event, Id, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

/// Shared name -> online map, read by the status reporter.
pub type ServiceStatus = Arc<Mutex<HashMap<String, bool>>>;

/// The `service` field value captured from a rathole span.
#[derive(Clone)]
struct SpanService(String);

pub struct ServiceStatusLayer {
    status: ServiceStatus,
}

impl ServiceStatusLayer {
    pub fn new(status: ServiceStatus) -> Self {
        Self { status }
    }
}

/// Extracts a single named field's value (Display or str) as a String.
struct FieldGrabber<'a> {
    name: &'a str,
    value: Option<String>,
}

impl Visit for FieldGrabber<'_> {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        if self.value.is_none() && field.name() == self.name {
            self.value = Some(format!("{value:?}"));
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == self.name {
            self.value = Some(value.to_string());
        }
    }
}

impl<S> Layer<S> for ServiceStatusLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let mut grab = FieldGrabber {
            name: "service",
            value: None,
        };
        attrs.record(&mut grab);
        if let (Some(service), Some(span)) = (grab.value, ctx.span(id)) {
            span.extensions_mut().insert(SpanService(service));
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let mut grab = FieldGrabber {
            name: "message",
            value: None,
        };
        event.record(&mut grab);
        let Some(message) = grab.value else {
            return;
        };

        let online = if message.contains("Control channel established") {
            true
        } else if message.contains("Control channel shutdown")
            || message.contains("Dropping previous control channel")
        {
            false
        } else {
            return;
        };

        // Resolve the service name from the enclosing span scope.
        let service = ctx.event_span(event).and_then(|span| {
            span.scope()
                .find_map(|s| s.extensions().get::<SpanService>().map(|svc| svc.0.clone()))
        });
        if let Some(service) = service {
            self.status.lock().unwrap().insert(service, online);
        }
    }
}
