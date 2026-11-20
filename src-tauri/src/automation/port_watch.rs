//! A demand-driven read-only publication of sampled port state. Snapshot and
//! cursor come from one lock; the ring retains changes to that published view,
//! not every physical transition between OS/driver samples.

use super::core::{self, EventCursor, EventRing, HostId, Replay, Sequence, ServerEpoch};
use super::wire::{ErrorCode, WireError};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    future::Future,
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use tokio::{
    sync::watch,
    time::{sleep_until, timeout_at, Instant},
};

pub(super) const MAX_WAIT_MS: u64 = 1_000;
const SAMPLE_INTERVAL: Duration = Duration::from_millis(175);
const DEFAULT_SAMPLE_BUDGET_MS: u64 = 3_000;
const MAX_CURSOR_BYTES: usize = 512;
const MAX_PORTS: usize = 256;
const MAX_PORT_BYTES: usize = 4 * 1024;
const MAX_SNAPSHOT_BYTES: usize = 48 * 1024;
const HISTORY: usize = 128;
const PAGE_SIZE: usize = 8;

type Inventory = BTreeMap<String, Value>;

#[derive(Clone)]
enum Change {
    Upsert(Value),
    Remove(String),
}

struct Publication {
    inventory: Option<Inventory>,
    history: EventRing<Change>,
    sampling: bool,
    next_sample: Instant,
    last_error: Option<WireError>,
}

pub(super) struct PortWatch {
    host: HostId,
    epoch: ServerEpoch,
    published: Mutex<Publication>,
    sampled: watch::Sender<()>,
}

fn watch_error(code: ErrorCode, message: impl Into<String>) -> WireError {
    let mut error = WireError::new(code, message);
    error.stage = Some("ports.watch".into());
    error
}

fn encode_cursor(cursor: &EventCursor) -> String {
    URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&(
            &cursor.host_id.0,
            &cursor.server_epoch.0,
            cursor.sequence.0.to_string(),
        ))
        .expect("cursor scalars serialize"),
    )
}

fn decode_cursor(token: &str) -> Result<EventCursor, WireError> {
    let invalid = || watch_error(ErrorCode::InvalidArgument, "invalid ports.watch cursor");
    if token.is_empty() || token.len() > MAX_CURSOR_BYTES {
        return Err(invalid());
    }
    let bytes = URL_SAFE_NO_PAD.decode(token).map_err(|_| invalid())?;
    let (host, epoch, counter): (String, String, String) =
        serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let sequence = counter.parse::<u64>().map_err(|_| invalid())?;
    let cursor = EventCursor {
        host_id: HostId(host),
        server_epoch: ServerEpoch(epoch),
        sequence: Sequence(sequence),
    };
    if cursor.host_id.0.is_empty()
        || cursor.server_epoch.0.is_empty()
        || encode_cursor(&cursor) != token
    {
        return Err(invalid());
    }
    Ok(cursor)
}

impl PortWatch {
    pub(super) fn new(host: HostId, epoch: ServerEpoch) -> Arc<Self> {
        let (sampled, _) = watch::channel(());
        Arc::new(Self {
            published: Mutex::new(Publication {
                inventory: None,
                history: EventRing::new(host.clone(), epoch.clone(), HISTORY)
                    .expect("positive history capacity"),
                sampling: false,
                next_sample: Instant::now(),
                last_error: None,
            }),
            host,
            epoch,
            sampled,
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Publication>, WireError> {
        self.published
            .lock()
            .map_err(|_| watch_error(ErrorCode::Internal, "port publication unavailable"))
    }

    fn validate_inventory(&self, ports: Vec<Value>) -> Result<Inventory, WireError> {
        if ports.len() > MAX_PORTS {
            return Err(watch_error(
                ErrorCode::FrameTooLarge,
                "port snapshot exceeds the inventory limit",
            ));
        }
        let invalid = || {
            watch_error(
                ErrorCode::Internal,
                "invalid port observation from Host backend",
            )
        };
        let mut inventory = BTreeMap::new();
        let mut snapshot_bytes = 0;
        for port in ports {
            let native_id = port["target"]["nativePortId"]
                .as_str()
                .filter(|id| {
                    !id.is_empty() && id.len() <= 1024 && !id.chars().any(char::is_control)
                })
                .ok_or_else(invalid)?
                .to_owned();
            let generation = port["connectionGeneration"]
                .as_str()
                .and_then(|generation| {
                    let number = generation.parse::<u64>().ok()?;
                    (number.to_string() == generation).then_some(number)
                })
                .ok_or_else(invalid)?;
            if port["target"]["hostId"].as_str() != Some(&self.host.0)
                || port["serverEpoch"].as_str() != Some(&self.epoch.0)
                || !matches!(
                    port["state"].as_str(),
                    Some("open" | "closed" | "opening" | "closing" | "error")
                )
                || (port["state"] == "open" && generation == 0)
            {
                return Err(invalid());
            }
            let bytes = serde_json::to_vec(&port).map_err(|_| invalid())?.len();
            snapshot_bytes += bytes + 1;
            if bytes > MAX_PORT_BYTES || snapshot_bytes > MAX_SNAPSHOT_BYTES {
                return Err(watch_error(
                    ErrorCode::FrameTooLarge,
                    "port snapshot exceeds the byte limit",
                ));
            }
            if inventory.insert(native_id, port).is_some() {
                return Err(invalid());
            }
        }
        Ok(inventory)
    }

    fn publish(state: &mut Publication, inventory: Inventory) -> Result<(), WireError> {
        if let Some(old) = &state.inventory {
            let remove = old
                .keys()
                .filter(|id| !inventory.contains_key(*id))
                .cloned()
                .map(Change::Remove);
            let upsert = inventory
                .iter()
                .filter(|(id, port)| old.get(*id) != Some(*port))
                .map(|(_, port)| Change::Upsert(port.clone()));
            let changes: Vec<_> = remove.chain(upsert).collect();
            // Preflight the sequence so this publication cannot advance the
            // history partway and leave its paired inventory at the old state.
            state
                .history
                .watermark()
                .sequence
                .0
                .checked_add(changes.len() as u64)
                .ok_or_else(|| {
                    watch_error(ErrorCode::Internal, "port stream sequence exhausted")
                })?;
            for change in changes {
                state
                    .history
                    .push(change)
                    .map_err(|error| watch_error(ErrorCode::Internal, error.to_string()))?;
            }
        }
        state.inventory = Some(inventory);
        Ok(())
    }

    async fn refresh<F, Fut>(
        self: &Arc<Self>,
        deadline: Instant,
        sample: &F,
    ) -> Result<Instant, WireError>
    where
        F: Fn() -> Fut + Clone + Send + Sync + 'static,
        Fut: Future<Output = Result<Vec<Value>, WireError>> + Send + 'static,
    {
        let mut sampled = self.sampled.subscribe();
        loop {
            {
                let mut state = self.lock()?;
                if !state.sampling && Instant::now() < state.next_sample {
                    return state.last_error.clone().map_or(Ok(state.next_sample), Err);
                }
                if !state.sampling && Instant::now() < deadline {
                    state.sampling = true;
                    let this = self.clone();
                    let sample = sample.clone();
                    // One owned refresh across all observers, even if the TCP
                    // request that triggered an OS enumeration disconnects.
                    tokio::spawn(async move {
                        let result = tokio::spawn(async move { sample().await })
                            .await
                            .unwrap_or_else(|_| {
                                Err(watch_error(ErrorCode::Internal, "port sampler stopped"))
                            })
                            .and_then(|ports| this.validate_inventory(ports));
                        if let Ok(mut state) = this.lock() {
                            state.last_error = result
                                .and_then(|ports| Self::publish(&mut state, ports))
                                .err();
                            state.sampling = false;
                            state.next_sample = Instant::now() + SAMPLE_INTERVAL;
                        }
                        this.sampled.send_replace(());
                    });
                }
            }
            timeout_at(deadline, sampled.changed())
                .await
                .map_err(|_| {
                    watch_error(
                        ErrorCode::DeadlineExceeded,
                        "timed out observing port state",
                    )
                })?
                .map_err(|_| watch_error(ErrorCode::Internal, "port sampler closed"))?;
        }
    }

    fn page(&self, cursor: Option<&EventCursor>) -> Result<(Value, bool), WireError> {
        let state = self.lock()?;
        if let Some(cursor) = cursor {
            match state.history.read_after(cursor, PAGE_SIZE) {
                Ok(Replay::Events { events, next, .. }) => {
                    let delivered = !events.is_empty();
                    let changes: Vec<_> = events
                        .into_iter()
                        .map(|event| {
                            let cursor = encode_cursor(&event.cursor);
                            match event.payload {
                                Change::Upsert(port) => {
                                    json!({"kind":"upsert", "cursor":cursor, "port":port})
                                }
                                Change::Remove(port) => {
                                    json!({"kind":"remove", "cursor":cursor, "nativePortId":port})
                                }
                            }
                        })
                        .collect();
                    Ok((
                        json!({"kind":"changes", "hostId":self.host.0, "serverEpoch":self.epoch.0,
                        "cursor":encode_cursor(&next), "changes":changes}),
                        delivered,
                    ))
                }
                Ok(Replay::Gap { .. }) => Err(watch_error(
                    ErrorCode::StreamGap,
                    "port history no longer retains this cursor; take a new snapshot",
                )),
                Ok(Replay::Expired { .. })
                | Err(core::AutomationError {
                    code: core::ErrorCode::CursorAhead,
                    ..
                }) => Err(watch_error(
                    ErrorCode::CursorExpired,
                    "port cursor is not valid in this Host epoch; take a new snapshot",
                )),
                Err(error) => Err(watch_error(ErrorCode::Internal, error.to_string())),
            }
        } else {
            let inventory = state.inventory.as_ref().ok_or_else(|| {
                watch_error(ErrorCode::Internal, "no port state has been sampled")
            })?;
            let snapshot = state
                .history
                .snapshot(inventory.values().collect::<Vec<_>>());
            Ok((
                json!({"kind":"snapshot", "hostId":self.host.0, "serverEpoch":self.epoch.0,
                "cursor":encode_cursor(&snapshot.watermark), "ports":snapshot.state}),
                true,
            ))
        }
    }

    pub(super) async fn watch<F, Fut>(
        self: &Arc<Self>,
        token: Option<&str>,
        wait_ms: u64,
        timeout_ms: Option<u64>,
        sample: F,
    ) -> Result<Value, WireError>
    where
        F: Fn() -> Fut + Clone + Send + Sync + 'static,
        Fut: Future<Output = Result<Vec<Value>, WireError>> + Send + 'static,
    {
        if wait_ms > MAX_WAIT_MS {
            return Err(watch_error(
                ErrorCode::InvalidArgument,
                "waitMs must be between 0 and 1000",
            ));
        }
        let cursor = token.map(decode_cursor).transpose()?;
        if let Some(cursor) = &cursor {
            if cursor.host_id != self.host {
                return Err(watch_error(
                    ErrorCode::HostUnavailable,
                    "port cursor belongs to a different Host",
                ));
            }
            if cursor.server_epoch != self.epoch {
                return Err(watch_error(
                    ErrorCode::CursorExpired,
                    "Host restarted; take a new port snapshot",
                ));
            }
            // Retained change pages do not require a new hardware scan.
            let (page, delivered) = self.page(Some(cursor))?;
            if delivered {
                return Ok(page);
            }
        }
        let now = Instant::now();
        let hard_deadline = now
            + Duration::from_millis(
                timeout_ms
                    .unwrap_or(DEFAULT_SAMPLE_BUDGET_MS)
                    .min(DEFAULT_SAMPLE_BUDGET_MS),
            );
        let wait_deadline = (now + Duration::from_millis(wait_ms)).min(hard_deadline);
        let mut first = true;
        loop {
            let next = match self
                .refresh(if first { hard_deadline } else { wait_deadline }, &sample)
                .await
            {
                Ok(next) => next,
                Err(error) if !first && error.code == ErrorCode::DeadlineExceeded => {
                    return self.page(cursor.as_ref()).map(|(page, _)| page);
                }
                Err(error) => return Err(error),
            };
            let (page, delivered) = self.page(cursor.as_ref())?;
            if delivered || Instant::now() >= wait_deadline {
                return Ok(page);
            }
            sleep_until(next.min(wait_deadline)).await;
            if Instant::now() >= wait_deadline {
                return self.page(cursor.as_ref()).map(|(page, _)| page);
            }
            first = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::Notify;

    fn source() -> Arc<PortWatch> {
        PortWatch::new(HostId("host-test".into()), ServerEpoch("epoch-1".into()))
    }

    fn port() -> Value {
        json!({"target":{"hostId":"host-test", "nativePortId":"COM3"}, "serverEpoch":"epoch-1",
            "state":"open", "connectionGeneration":"7"})
    }

    #[tokio::test]
    async fn cancelled_client_does_not_restart_or_release_the_shared_sample() {
        let watch = source();
        let count = Arc::new(AtomicUsize::new(0));
        let began = Arc::new(Notify::new());
        let finish = Arc::new(Notify::new());
        let sample = {
            let (count, began, finish) = (count.clone(), began.clone(), finish.clone());
            move || {
                let (count, began, finish) = (count.clone(), began.clone(), finish.clone());
                async move {
                    count.fetch_add(1, Ordering::SeqCst);
                    began.notify_one();
                    finish.notified().await;
                    Ok(vec![port()])
                }
            }
        };
        let first = {
            let (watch, sample) = (watch.clone(), sample.clone());
            tokio::spawn(async move { watch.watch(None, 0, None, sample).await })
        };
        tokio::time::timeout(Duration::from_secs(2), began.notified())
            .await
            .unwrap();
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        finish.notify_one();
        let snapshot = watch.watch(None, 0, None, sample).await.unwrap();
        assert_eq!(snapshot["ports"], json!([port()]));
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failed_sample_keeps_inventory_and_cursor_without_fabricating_removals() {
        let watch = source();
        let before = watch
            .watch(None, 0, None, || async { Ok(vec![port()]) })
            .await
            .unwrap();
        watch.lock().unwrap().next_sample = Instant::now();
        let error = watch
            .watch(None, 0, None, || async {
                Err(watch_error(ErrorCode::IoError, "enumeration failed"))
            })
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::IoError);
        assert_eq!(watch.page(None).unwrap().0, before);
        watch.lock().unwrap().next_sample = Instant::now();
        let cursor = before["cursor"].as_str().unwrap();
        let after = watch
            .watch(Some(cursor), 0, None, || async { Ok(vec![port()]) })
            .await
            .unwrap();
        assert_eq!(after["cursor"], cursor);
        assert_eq!(after["changes"], json!([]));
    }
}
