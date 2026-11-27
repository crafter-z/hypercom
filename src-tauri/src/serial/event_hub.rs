//! Per-port bounded ring buffer and live broadcast hub for serial events.
//! Pure Rust (no Tauri dependency) so CLI, MCP, plugins, and tests can share it.

#![allow(dead_code)] // Prepared for Step 2 wiring into AppState / commands.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, Notify};

use super::managed_loan::LoanMetadata;

/// Maximum retained events per port in the ring buffer.
pub const MAX_HISTORY_EVENTS: usize = 4096;
/// Maximum retained payload/metadata bytes per port in the ring buffer (2 MiB).
pub const MAX_HISTORY_BYTES: usize = 2 * 1024 * 1024;
/// Live broadcast channel capacity across all ports.
const BROADCAST_CAPACITY: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HubEventKind {
    Rx,
    Tx,
    Status,
    Loan,
    Note,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubEvent {
    pub seq: u64,
    pub port_id: String,
    pub generation: u64,
    pub timestamp_ms: i64,
    pub kind: HubEventKind,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub data: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loan: Option<LoanMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubEventPage {
    pub port_id: String,
    pub latest_seq: u64,
    pub next_seq: u64,
    pub gap: bool,
    pub events: Vec<HubEvent>,
}

struct StoredEvent {
    event: Arc<HubEvent>,
    bytes: usize,
}

struct PortEventBuffer {
    next_seq: u64,
    total_bytes: usize,
    events: VecDeque<StoredEvent>,
    notify: Arc<Notify>,
}

impl Default for PortEventBuffer {
    fn default() -> Self {
        Self {
            next_seq: 1,
            total_bytes: 0,
            events: VecDeque::new(),
            notify: Arc::new(Notify::new()),
        }
    }
}

impl PortEventBuffer {
    fn latest_seq(&self) -> u64 {
        self.next_seq.saturating_sub(1)
    }

    fn push(&mut self, mut event: HubEvent) -> (Arc<HubEvent>, Arc<Notify>) {
        let seq = self.next_seq;
        self.next_seq = self.next_seq.saturating_add(1);
        event.seq = seq;

        let bytes = estimate_event_bytes(&event);
        while self.events.len() >= MAX_HISTORY_EVENTS
            || (!self.events.is_empty() && self.total_bytes.saturating_add(bytes) > MAX_HISTORY_BYTES)
        {
            if let Some(evicted) = self.events.pop_front() {
                self.total_bytes = self.total_bytes.saturating_sub(evicted.bytes);
            } else {
                break;
            }
        }

        let arc_event = Arc::new(event);
        self.total_bytes = self.total_bytes.saturating_add(bytes);
        self.events.push_back(StoredEvent {
            event: Arc::clone(&arc_event),
            bytes,
        });
        (arc_event, Arc::clone(&self.notify))
    }

    fn poll(
        &self,
        port_id: &str,
        after_seq: Option<u64>,
        recent: Option<usize>,
        limit: usize,
    ) -> HubEventPage {
        let latest_seq = self.latest_seq();
        if self.events.is_empty() {
            let gap = after_seq.is_some_and(|after| after < latest_seq);
            return HubEventPage {
                port_id: port_id.to_string(),
                latest_seq,
                next_seq: latest_seq,
                gap,
                events: Vec::new(),
            };
        }

        let first_seq = self
            .events
            .front()
            .map(|entry| entry.event.seq)
            .unwrap_or(latest_seq);

        if let Some(after) = after_seq {
            if after >= latest_seq {
                return HubEventPage {
                    port_id: port_id.to_string(),
                    latest_seq,
                    next_seq: latest_seq,
                    gap: false,
                    events: Vec::new(),
                };
            }
            let gap = after.saturating_add(1) < first_seq;
            let events: Vec<HubEvent> = self
                .events
                .iter()
                .filter(|entry| entry.event.seq > after)
                .take(limit)
                .map(|entry| (*entry.event).clone())
                .collect();
            let next_seq = events
                .last()
                .map(|ev| ev.seq)
                .unwrap_or_else(|| after.min(latest_seq));
            return HubEventPage {
                port_id: port_id.to_string(),
                latest_seq,
                next_seq,
                gap,
                events,
            };
        }

        if let Some(recent_count) = recent {
            let take_count = recent_count.min(limit).min(self.events.len());
            let skip = self.events.len().saturating_sub(take_count);
            let events: Vec<HubEvent> = self
                .events
                .iter()
                .skip(skip)
                .map(|entry| (*entry.event).clone())
                .collect();
            let next_seq = events.last().map(|ev| ev.seq).unwrap_or(latest_seq);
            return HubEventPage {
                port_id: port_id.to_string(),
                latest_seq,
                next_seq,
                gap: false,
                events,
            };
        }

        let gap = first_seq > 1;
        let events: Vec<HubEvent> = self
            .events
            .iter()
            .take(limit)
            .map(|entry| (*entry.event).clone())
            .collect();
        let next_seq = events.last().map(|ev| ev.seq).unwrap_or(0);
        HubEventPage {
            port_id: port_id.to_string(),
            latest_seq,
            next_seq,
            gap,
            events,
        }
    }
}

fn estimate_event_bytes(event: &HubEvent) -> usize {
    const FIXED_OVERHEAD: usize = 64;
    FIXED_OVERHEAD
        .saturating_add(event.port_id.len())
        .saturating_add(event.data.len())
        .saturating_add(event.text.as_ref().map_or(0, String::len))
        .saturating_add(event.status.as_ref().map_or(0, String::len))
        .saturating_add(event.source.as_ref().map_or(0, String::len))
}

pub struct SerialEventHub {
    ports: Mutex<HashMap<String, PortEventBuffer>>,
    tx: broadcast::Sender<Arc<HubEvent>>,
}

impl Default for SerialEventHub {
    fn default() -> Self {
        Self::new()
    }
}

impl SerialEventHub {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(BROADCAST_CAPACITY);
        Self {
            ports: Mutex::new(HashMap::new()),
            tx,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<HubEvent>> {
        self.tx.subscribe()
    }

    fn publish(&self, event: HubEvent) -> Arc<HubEvent> {
        let (arc_event, notify) = {
            let mut guard = self.ports.lock().unwrap_or_else(|e| e.into_inner());
            let buffer = guard.entry(event.port_id.clone()).or_default();
            buffer.push(event)
        };
        notify.notify_waiters();
        let _ = self.tx.send(Arc::clone(&arc_event));
        arc_event
    }

    pub fn publish_rx(
        &self,
        port_id: &str,
        generation: u64,
        timestamp_ms: i64,
        data: &[u8],
    ) -> Arc<HubEvent> {
        self.publish(HubEvent {
            seq: 0,
            port_id: port_id.to_string(),
            generation,
            timestamp_ms,
            kind: HubEventKind::Rx,
            data: data.to_vec(),
            text: None,
            status: None,
            source: None,
            loan: None,
        })
    }

    pub fn publish_tx(
        &self,
        port_id: &str,
        generation: u64,
        timestamp_ms: i64,
        data: &[u8],
        source: Option<String>,
    ) -> Arc<HubEvent> {
        self.publish(HubEvent {
            seq: 0,
            port_id: port_id.to_string(),
            generation,
            timestamp_ms,
            kind: HubEventKind::Tx,
            data: data.to_vec(),
            text: None,
            status: None,
            source,
            loan: None,
        })
    }

    pub fn publish_status(
        &self,
        port_id: &str,
        generation: u64,
        timestamp_ms: i64,
        status: &str,
    ) -> Arc<HubEvent> {
        self.publish(HubEvent {
            seq: 0,
            port_id: port_id.to_string(),
            generation,
            timestamp_ms,
            kind: HubEventKind::Status,
            data: Vec::new(),
            text: None,
            status: Some(status.to_string()),
            source: None,
            loan: None,
        })
    }

    pub fn publish_loan(
        &self,
        port_id: &str,
        generation: u64,
        timestamp_ms: i64,
        active: bool,
        loan: Option<LoanMetadata>,
        note: Option<String>,
    ) -> Arc<HubEvent> {
        self.publish(HubEvent {
            seq: 0,
            port_id: port_id.to_string(),
            generation,
            timestamp_ms,
            kind: HubEventKind::Loan,
            data: Vec::new(),
            text: note,
            status: Some(if active { "active" } else { "released" }.to_string()),
            source: None,
            loan,
        })
    }

    pub fn publish_note(
        &self,
        port_id: &str,
        generation: u64,
        timestamp_ms: i64,
        text: impl Into<String>,
        source: Option<String>,
    ) -> Arc<HubEvent> {
        self.publish(HubEvent {
            seq: 0,
            port_id: port_id.to_string(),
            generation,
            timestamp_ms,
            kind: HubEventKind::Note,
            data: Vec::new(),
            text: Some(text.into()),
            status: None,
            source,
            loan: None,
        })
    }

    pub fn poll(
        &self,
        port_id: &str,
        after_seq: Option<u64>,
        recent: Option<usize>,
        limit: usize,
    ) -> HubEventPage {
        let guard = self.ports.lock().unwrap_or_else(|e| e.into_inner());
        match guard.get(port_id) {
            Some(buffer) => buffer.poll(port_id, after_seq, recent, limit),
            None => HubEventPage {
                port_id: port_id.to_string(),
                latest_seq: 0,
                next_seq: 0,
                gap: false,
                events: Vec::new(),
            },
        }
    }

    fn port_notify(&self, port_id: &str) -> Arc<Notify> {
        let mut guard = self.ports.lock().unwrap_or_else(|e| e.into_inner());
        let buffer = guard.entry(port_id.to_string()).or_default();
        Arc::clone(&buffer.notify)
    }

    pub async fn wait_for_events(
        &self,
        port_id: &str,
        after_seq: Option<u64>,
        wait_ms: u64,
        limit: usize,
    ) -> HubEventPage {
        let notify = self.port_notify(port_id);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(wait_ms);
        loop {
            let notified = notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            let page = self.poll(port_id, after_seq, None, limit);
            if !page.events.is_empty() || wait_ms == 0 {
                return page;
            }
            let now = tokio::time::Instant::now();
            if now >= deadline {
                return page;
            }
            let remaining = deadline - now;
            if tokio::time::timeout(remaining, notified).await.is_err() {
                return self.poll(port_id, after_seq, None, limit);
            }
        }
    }

    pub fn latest_seq(&self, port_id: &str) -> u64 {
        let guard = self.ports.lock().unwrap_or_else(|e| e.into_inner());
        guard.get(port_id).map_or(0, PortEventBuffer::latest_seq)
    }

    pub fn clear_port(&self, port_id: &str) {
        let mut guard = self.ports.lock().unwrap_or_else(|e| e.into_inner());
        guard.remove(port_id);
    }
}

#[cfg(test)]
mod tests {
    use super::{HubEventKind, SerialEventHub, MAX_HISTORY_BYTES, MAX_HISTORY_EVENTS};
    use crate::serial::managed_loan::LoanMetadata;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn publishes_all_event_kinds_with_independent_monotonic_sequences() {
        let hub = SerialEventHub::new();
        let mut rx_sub = hub.subscribe();

        let e1 = hub.publish_rx("COM1", 1, 100, b"hello");
        let e2 = hub.publish_tx("COM1", 1, 101, b"AT\r\n", Some("cli".into()));
        let e3 = hub.publish_status("COM1", 2, 102, "connected");
        let meta = LoanMetadata {
            lease_id: "lease-1".into(),
            holder: "cli".into(),
            reason: Some("flash".into()),
            acquired_at_ms: 103,
            expires_at_ms: Some(200),
            auto_reopen: true,
            connection_bound: false,
        };
        let e4 = hub.publish_loan("COM1", 2, 103, true, Some(meta.clone()), None);
        let e5 = hub.publish_note("COM1", 2, 104, "flashing done", Some("cli".into()));
        let other = hub.publish_rx("COM2", 1, 105, b"ok");

        assert_eq!(e1.seq, 1);
        assert_eq!(e2.seq, 2);
        assert_eq!(e3.seq, 3);
        assert_eq!(e4.seq, 4);
        assert_eq!(e5.seq, 5);
        assert_eq!(other.seq, 1);
        assert_eq!(hub.latest_seq("COM1"), 5);
        assert_eq!(hub.latest_seq("COM2"), 1);
        assert_eq!(hub.latest_seq("COM9"), 0);

        let page1 = hub.poll("COM1", Some(0), None, 2);
        assert!(!page1.gap);
        assert_eq!(page1.latest_seq, 5);
        assert_eq!(page1.next_seq, 2);
        assert_eq!(page1.events.len(), 2);
        assert_eq!(page1.events[0].kind, HubEventKind::Rx);
        assert_eq!(page1.events[0].data, b"hello");
        assert_eq!(page1.events[1].kind, HubEventKind::Tx);
        assert_eq!(page1.events[1].source.as_deref(), Some("cli"));

        let page2 = hub.poll("COM1", Some(page1.next_seq), None, 10);
        assert!(!page2.gap);
        assert_eq!(page2.next_seq, 5);
        assert_eq!(page2.events.len(), 3);
        assert_eq!(page2.events[0].kind, HubEventKind::Status);
        assert_eq!(page2.events[0].status.as_deref(), Some("connected"));
        assert_eq!(page2.events[1].kind, HubEventKind::Loan);
        assert_eq!(page2.events[1].loan.as_ref(), Some(&meta));
        assert_eq!(page2.events[2].kind, HubEventKind::Note);
        assert_eq!(page2.events[2].text.as_deref(), Some("flashing done"));

        let recent = hub.poll("COM1", None, Some(2), 10);
        assert!(!recent.gap);
        assert_eq!(recent.events.len(), 2);
        assert_eq!(recent.events[0].seq, 4);
        assert_eq!(recent.events[1].seq, 5);
        assert_eq!(recent.next_seq, 5);

        let mut received = Vec::new();
        while let Ok(ev) = rx_sub.try_recv() {
            received.push((ev.port_id.clone(), ev.seq, ev.kind));
        }
        assert_eq!(received.len(), 6);
        assert_eq!(received[5], ("COM2".to_string(), 1, HubEventKind::Rx));
    }

    #[test]
    fn ring_buffer_bounds_count_and_reports_gap() {
        let hub = SerialEventHub::new();
        let total = MAX_HISTORY_EVENTS + 15;
        for i in 0..total {
            hub.publish_rx("COM3", 1, i as i64, b"x");
        }

        let page = hub.poll("COM3", Some(0), None, 10);
        assert!(page.gap);
        assert_eq!(page.latest_seq, total as u64);
        assert_eq!(page.events.len(), 10);
        assert_eq!(page.events[0].seq, 16);

        let no_gap = hub.poll("COM3", Some(15), None, 5);
        assert!(!no_gap.gap);
        assert_eq!(no_gap.events[0].seq, 16);
    }

    #[test]
    fn ring_buffer_bounds_bytes_and_survives_oversized_single_event() {
        let hub = SerialEventHub::new();
        let chunk = vec![0xAA; 512 * 1024];
        for i in 0..6 {
            hub.publish_rx("COM4", 1, i, &chunk);
        }
        let page = hub.poll("COM4", Some(0), None, 100);
        assert!(page.gap);
        assert!(page.events.len() < 4);
        let retained_bytes: usize = page.events.iter().map(|e| e.data.len()).sum();
        assert!(retained_bytes <= MAX_HISTORY_BYTES);

        let huge = vec![0x55; MAX_HISTORY_BYTES + 1024];
        hub.publish_rx("COM4", 1, 99, &huge);
        let after_huge = hub.poll("COM4", None, Some(10), 10);
        assert_eq!(after_huge.events.len(), 1);
        assert_eq!(after_huge.events[0].data.len(), huge.len());
    }

    #[tokio::test]
    async fn wait_for_events_wakes_on_publish_and_respects_timeout() {
        let hub = Arc::new(SerialEventHub::new());
        let empty = hub.wait_for_events("COM5", Some(0), 20, 10).await;
        assert!(empty.events.is_empty());
        assert_eq!(empty.latest_seq, 0);

        let hub_clone = Arc::clone(&hub);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            hub_clone.publish_rx("COM5", 1, 500, b"pong");
        });

        let page = hub.wait_for_events("COM5", Some(0), 1000, 10).await;
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].data, b"pong");
        assert_eq!(page.next_seq, 1);
    }
}
