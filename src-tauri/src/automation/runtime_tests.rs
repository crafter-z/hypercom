use super::*;
use crate::automation::transport::{
    decode_response, encode_request, Control, FrameReader, Precondition, Response, Target,
    DEFAULT_MAX_FRAME_BYTES,
};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio::sync::Notify;
use tokio::time::timeout;

#[derive(Default)]
struct FakeBackend {
    generation: AtomicU64,
    lock_probe: Mutex<Option<std::sync::Weak<RuntimeShared>>>,
    writes: Mutex<Vec<Vec<u8>>>,
    contexts: Mutex<Vec<SerialTxContext>>,
    reports: Mutex<VecDeque<SendReport>>,
    block_before: AtomicBool,
    before: Notify,
    continue_before: Notify,
    block_after: AtomicBool,
    after: Notify,
    continue_after: Notify,
}

impl FakeBackend {
    fn new() -> Self {
        Self {
            generation: AtomicU64::new(7),
            ..Self::default()
        }
    }
}

impl RuntimeBackend for FakeBackend {
    fn list_ports(&self) -> BackendFuture<'_, Result<Vec<Value>, WireError>> {
        Box::pin(async {
            Ok(vec![
                json!({"target":{"hostId":"host-test","nativePortId":"COM3"},"serverEpoch":"epoch-test","connectionGeneration":"7","state":"open"}),
            ])
        })
    }

    fn generation(&self, port_id: &str) -> Result<u64, WireError> {
        if port_id != "COM3" {
            return Err(runtime_error(ErrorCode::PortNotFound, "not connected"));
        }
        if let Some(shared) = self
            .lock_probe
            .lock()
            .unwrap()
            .as_ref()
            .and_then(std::sync::Weak::upgrade)
        {
            assert!(
                shared.state.try_lock().is_ok(),
                "native state must not be acquired under runtime state"
            );
        }
        match self.generation.load(Ordering::SeqCst) {
            0 => Err(runtime_error(ErrorCode::PortNotFound, "port was closed")),
            generation => Ok(generation),
        }
    }

    fn send(
        &self,
        prepared: PreparedSerialSend,
        context: SerialTxContext,
        guard: SerialPreWriteGuard,
    ) -> BackendFuture<'_, SendReport> {
        Box::pin(async move {
            if self.block_before.load(Ordering::SeqCst) {
                self.before.notify_one();
                self.continue_before.notified().await;
            }
            if self.generation.load(Ordering::SeqCst) != 7 {
                return SendReport {
                    native_fact: None,
                    bytes: ByteCount::exact(0),
                    failure: Some(runtime_error(
                        ErrorCode::StaleSession,
                        "native generation check rejected",
                    )),
                };
            }
            if guard().is_err() {
                return SendReport {
                    native_fact: None,
                    bytes: ByteCount::exact(0),
                    failure: Some(runtime_error(
                        ErrorCode::ControlLost,
                        "native guard rejected",
                    )),
                };
            }
            self.writes.lock().unwrap().push(prepared.bytes().to_vec());
            self.contexts.lock().unwrap().push(context);
            if self.block_after.load(Ordering::SeqCst) {
                self.after.notify_one();
                self.continue_after.notified().await;
            }
            self.reports
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or(SendReport {
                    native_fact: None,
                    bytes: ByteCount::exact(prepared.requested_bytes() as u64),
                    failure: None,
                })
        })
    }
}

fn handler(backend: Arc<FakeBackend>, control: bool) -> LocalAutomationHandler {
    LocalAutomationHandler::with_backend(backend, "host-test".into(), "epoch-test".into(), control)
}

fn connection(id: u64) -> ConnectionContext {
    ConnectionContext {
        connection_id: id,
        peer_addr: "127.0.0.1:12345".parse().unwrap(),
    }
}

fn port_request(id: &str, method: &str, params: Value) -> Request {
    let mut request = Request::new(id, method, params);
    request.target = Some(Target {
        host_id: "host-test".into(),
        native_port_id: "COM3".into(),
    });
    request.precondition = Some(Precondition {
        server_epoch: Some("epoch-test".into()),
        connection_generation: Some(7),
    });
    request
}

async fn acquire(handler: &LocalAutomationHandler, id: u64) -> Value {
    handler
        .handle(
            connection(id),
            port_request(
                &format!("acquire-{id}"),
                "control.acquire",
                json!({"ttlMs":60000}),
            ),
        )
        .await
        .unwrap()
}

fn with_lease(mut request: Request, lease: &Value) -> Request {
    request.control = Some(Control {
        lease_id: lease["leaseId"].as_str().unwrap().into(),
        fence: lease["fence"].as_str().unwrap().parse().unwrap(),
    });
    request
}

fn send_request(id: &str, lease: &Value) -> Request {
    with_lease(
        port_request(
            id,
            "serial.send",
            json!({"mode":"text","text":"AT","lineEnding":"crlf"}),
        ),
        lease,
    )
}

async fn get_operation(handler: &LocalAutomationHandler, client: u64, original_id: &str) -> Value {
    handler
        .handle(
            connection(client),
            port_request("query", "operations.get", json!({"requestId":original_id})),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn read_only_default_never_advertises_or_grants_control() {
    let backend = Arc::new(FakeBackend::new());
    let handler = handler(backend.clone(), false);
    assert_eq!(handler.capabilities(), ["host.status", "ports.list"]);
    let status = handler
        .handle(
            connection(1),
            Request::new("status", "host.status", json!({})),
        )
        .await
        .unwrap();
    assert_eq!(status["serialControl"], "not-enabled");
    assert_eq!(status["security"], "unauthenticated-local-test-only");
    assert_eq!(status["nativeGuiArbitration"], false);
    let failure = handler
        .handle(
            connection(1),
            port_request("denied", "control.acquire", json!({"ttlMs":1000})),
        )
        .await
        .unwrap_err();
    assert_eq!(failure.code, ErrorCode::PermissionDenied);
    assert!(backend.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn acquire_and_release_enforce_unique_holder_lease_and_fence() {
    let handler = handler(Arc::new(FakeBackend::new()), true);
    let first = acquire(&handler, 1).await;
    assert_eq!(first["connectionGeneration"], "7");
    assert_eq!(first["state"], "granted");
    let busy = handler
        .handle(
            connection(2),
            port_request("busy", "control.acquire", json!({"ttlMs":1000})),
        )
        .await
        .unwrap_err();
    assert_eq!(busy.code, ErrorCode::PortBusy);
    let release = with_lease(
        port_request("release", "control.release", json!({})),
        &first,
    );
    assert_eq!(
        handler
            .handle(connection(2), release.clone())
            .await
            .unwrap_err()
            .code,
        ErrorCode::ControlLost
    );
    let mut wrong = release.clone();
    wrong.control.as_mut().unwrap().lease_id = "forged".into();
    assert_eq!(
        handler.handle(connection(1), wrong).await.unwrap_err().code,
        ErrorCode::ControlLost
    );
    let mut wrong = release.clone();
    wrong.control.as_mut().unwrap().fence += 1;
    assert_eq!(
        handler.handle(connection(1), wrong).await.unwrap_err().code,
        ErrorCode::ControlLost
    );
    assert_eq!(
        handler.handle(connection(1), release).await.unwrap(),
        Value::Null
    );
    let second = acquire(&handler, 2).await;
    assert!(
        second["fence"].as_str().unwrap().parse::<u64>().unwrap()
            > first["fence"].as_str().unwrap().parse::<u64>().unwrap()
    );
}

#[tokio::test]
async fn runtime_never_holds_its_mutex_while_reading_native_generation() {
    let backend = Arc::new(FakeBackend::new());
    let handler = handler(backend.clone(), true);
    *backend.lock_probe.lock().unwrap() = Some(Arc::downgrade(&handler.shared));
    let lease = acquire(&handler, 1).await;
    handler
        .handle(connection(1), send_request("lock-order", &lease))
        .await
        .unwrap();
    let release = with_lease(
        port_request("release-lock-order", "control.release", json!({})),
        &lease,
    );
    handler.handle(connection(1), release).await.unwrap();
}

#[tokio::test]
async fn stale_host_epoch_generation_and_missing_preconditions_never_write() {
    let backend = Arc::new(FakeBackend::new());
    let handler = handler(backend.clone(), true);
    let lease = acquire(&handler, 1).await;
    let mut cases = Vec::new();
    let mut wrong = send_request("wrong-host", &lease);
    wrong.target.as_mut().unwrap().host_id = "other".into();
    cases.push((wrong, ErrorCode::HostUnavailable));
    let mut wrong = send_request("wrong-epoch", &lease);
    wrong.precondition.as_mut().unwrap().server_epoch = Some("old".into());
    cases.push((wrong, ErrorCode::StaleSession));
    let mut wrong = send_request("wrong-generation", &lease);
    wrong.precondition.as_mut().unwrap().connection_generation = Some(6);
    cases.push((wrong, ErrorCode::StaleSession));
    let mut wrong = send_request("missing-precondition", &lease);
    wrong.precondition = None;
    cases.push((wrong, ErrorCode::InvalidArgument));
    let mut wrong = send_request("missing-control", &lease);
    wrong.control = None;
    cases.push((wrong, ErrorCode::ControlLost));
    for (request, code) in cases {
        assert_eq!(
            handler
                .handle(connection(1), request)
                .await
                .unwrap_err()
                .code,
            code
        );
    }
    assert!(backend.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn send_and_query_preserve_authoritative_bytes_and_operation_identity() {
    let backend = Arc::new(FakeBackend::new());
    let handler = handler(backend.clone(), true);
    let lease = acquire(&handler, 1).await;
    let sent = handler
        .handle(connection(1), send_request("send-1", &lease))
        .await
        .unwrap();
    assert_eq!(sent["state"], "succeeded");
    assert_eq!(
        sent["outcome"],
        json!({"certainty":"known","bytesWritten":"4"})
    );
    assert_eq!(backend.writes.lock().unwrap()[0], b"AT\r\n");
    assert_eq!(get_operation(&handler, 1, "send-1").await, sent);
    let query = port_request(
        "query-id",
        "operations.get",
        json!({"operationId":sent["operationId"]}),
    );
    assert_eq!(handler.handle(connection(1), query).await.unwrap(), sent);
    let context = &backend.contexts.lock().unwrap()[0];
    assert_eq!(
        context.operation_id.as_deref(),
        sent["operationId"].as_str()
    );
    assert_eq!(context.source.as_deref(), Some("unsafe-loopback-test"));
}

#[tokio::test]
async fn raw_bytes_and_hex_use_native_preparation_without_reinterpretation() {
    let backend = Arc::new(FakeBackend::new());
    let handler = handler(backend.clone(), true);
    let lease = acquire(&handler, 1).await;
    for (id, params) in [
        ("raw", json!({"dataBase64":"AAH/"})),
        ("hex", json!({"mode":"hex","hex":"00 01 FF"})),
    ] {
        let request = with_lease(port_request(id, "serial.send", params), &lease);
        let result = handler.handle(connection(1), request).await.unwrap();
        assert_eq!(result["outcome"]["bytesWritten"], "3");
    }
    assert_eq!(
        *backend.writes.lock().unwrap(),
        vec![vec![0, 1, 255], vec![0, 1, 255]]
    );
    for params in [
        json!({"mode":"hex","hex":"A"}),
        json!({"dataBase64":"!bad"}),
        json!({"mode":"hex","hex":"AA","lineEnding":"lf"}),
        json!({"dataBase64":"QQ==","text":"ambiguous"}),
    ] {
        let request = with_lease(port_request("invalid", "serial.send", params), &lease);
        assert_eq!(
            handler
                .handle(connection(1), request)
                .await
                .unwrap_err()
                .code,
            ErrorCode::InvalidArgument
        );
    }
    assert_eq!(backend.writes.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn identical_request_retries_return_original_without_second_write() {
    let backend = Arc::new(FakeBackend::new());
    let handler = handler(backend.clone(), true);
    let lease = acquire(&handler, 1).await;
    let request = send_request("idempotent", &lease);
    let original = handler
        .handle(connection(1), request.clone())
        .await
        .unwrap();
    assert_eq!(
        handler
            .handle(connection(1), request.clone())
            .await
            .unwrap(),
        original
    );
    handler.disconnected(connection(1), None);
    backend.generation.store(0, Ordering::SeqCst); // Physical port is now closed.
                                                   // All local processes share only this explicit test principal; a new session
                                                   // may reconcile the original operation but cannot reuse the old lease to write.
    assert_eq!(
        handler
            .handle(connection(2), request.clone())
            .await
            .unwrap(),
        original
    );
    let mut different = request;
    different.params["text"] = json!("different");
    assert_eq!(
        handler
            .handle(connection(2), different)
            .await
            .unwrap_err()
            .code,
        ErrorCode::RequestIdConflict
    );
    assert_eq!(backend.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn disconnect_releases_only_its_lease_without_closing_port() {
    let backend = Arc::new(FakeBackend::new());
    let handler = handler(backend.clone(), true);
    let old = acquire(&handler, 1).await;
    handler.disconnected(connection(1), None);
    let new = acquire(&handler, 2).await;
    assert_ne!(old["leaseId"], new["leaseId"]);
    assert_eq!(backend.generation("COM3").unwrap(), 7);
    assert_eq!(
        handler
            .handle(connection(2), send_request("stale-lease", &old))
            .await
            .unwrap_err()
            .code,
        ErrorCode::ControlLost
    );
}

#[tokio::test]
async fn disconnect_before_native_guard_prevents_queued_write() {
    let backend = Arc::new(FakeBackend::new());
    backend.block_before.store(true, Ordering::SeqCst);
    let handler = Arc::new(handler(backend.clone(), true));
    let lease = acquire(&handler, 1).await;
    let sending = {
        let handler = handler.clone();
        tokio::spawn(async move {
            handler
                .handle(connection(1), send_request("queued", &lease))
                .await
        })
    };
    timeout(Duration::from_secs(2), backend.before.notified())
        .await
        .unwrap();
    handler.disconnected(connection(1), None);
    acquire(&handler, 2).await;
    backend.continue_before.notify_one();
    let result = sending.await.unwrap().unwrap();
    assert_eq!(result["state"], "failed");
    assert_eq!(result["error"]["code"], "CONTROL_LOST");
    assert_eq!(result["outcome"]["bytesWritten"], "0");
    assert!(backend.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn disconnect_during_physical_write_stays_draining_until_completion() {
    let backend = Arc::new(FakeBackend::new());
    backend.block_after.store(true, Ordering::SeqCst);
    let handler = Arc::new(handler(backend.clone(), true));
    let lease = acquire(&handler, 1).await;
    let sending = {
        let handler = handler.clone();
        tokio::spawn(async move {
            handler
                .handle(connection(1), send_request("in-flight", &lease))
                .await
        })
    };
    timeout(Duration::from_secs(2), backend.after.notified())
        .await
        .unwrap();
    let pending = get_operation(&handler, 1, "in-flight").await;
    assert_eq!(pending["state"], "executing");
    assert_eq!(pending["outcome"]["certainty"], "unknown");
    handler.disconnected(connection(1), None);
    assert_eq!(
        handler
            .handle(
                connection(2),
                port_request("busy", "control.acquire", json!({"ttlMs":1000}))
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::PortBusy
    );
    backend.continue_after.notify_one();
    assert_eq!(sending.await.unwrap().unwrap()["state"], "succeeded");
    acquire(&handler, 2).await;
    assert_eq!(backend.generation("COM3").unwrap(), 7);
}

#[tokio::test]
async fn cancelled_response_future_does_not_abandon_native_completion() {
    let backend = Arc::new(FakeBackend::new());
    backend.block_after.store(true, Ordering::SeqCst);
    let handler = Arc::new(handler(backend.clone(), true));
    let lease = acquire(&handler, 1).await;
    let sending = {
        let handler = handler.clone();
        tokio::spawn(async move {
            handler
                .handle(connection(1), send_request("cancelled-response", &lease))
                .await
        })
    };
    timeout(Duration::from_secs(2), backend.after.notified())
        .await
        .unwrap();
    sending.abort();
    assert!(sending.await.unwrap_err().is_cancelled());
    handler.disconnected(connection(1), None);
    backend.continue_after.notify_one();
    timeout(Duration::from_secs(2), async {
        loop {
            if get_operation(&handler, 2, "cancelled-response").await["state"] == "succeeded" {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    acquire(&handler, 2).await;
    assert_eq!(backend.writes.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn deadline_and_generation_are_rechecked_at_native_execution() {
    let backend = Arc::new(FakeBackend::new());
    let handler = handler(backend.clone(), true);
    let lease = acquire(&handler, 1).await;
    let mut expired = send_request("deadline", &lease);
    expired.timeout_ms = Some(0);
    let result = handler.handle(connection(1), expired).await.unwrap();
    assert_eq!(result["error"]["code"], "DEADLINE_EXCEEDED");
    assert!(backend.writes.lock().unwrap().is_empty());
    backend.block_before.store(true, Ordering::SeqCst);
    let handler = Arc::new(handler);
    let sending = {
        let handler = handler.clone();
        tokio::spawn(async move {
            handler
                .handle(connection(1), send_request("generation-race", &lease))
                .await
        })
    };
    timeout(Duration::from_secs(2), backend.before.notified())
        .await
        .unwrap();
    backend.generation.store(8, Ordering::SeqCst);
    backend.continue_before.notify_one();
    let result = sending.await.unwrap().unwrap();
    assert_eq!(result["error"]["code"], "STALE_SESSION");
    assert!(backend.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn lease_expiry_while_waiting_for_writer_prevents_execution() {
    let backend = Arc::new(FakeBackend::new());
    backend.block_before.store(true, Ordering::SeqCst);
    let handler = Arc::new(handler(backend.clone(), true));
    let lease = handler
        .handle(
            connection(1),
            port_request("short-lease", "control.acquire", json!({"ttlMs":20})),
        )
        .await
        .unwrap();
    let sending = {
        let handler = handler.clone();
        tokio::spawn(async move {
            handler
                .handle(connection(1), send_request("expires", &lease))
                .await
        })
    };
    timeout(Duration::from_secs(2), backend.before.notified())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(30)).await;
    backend.continue_before.notify_one();
    let result = sending.await.unwrap().unwrap();
    assert_eq!(result["error"]["code"], "CONTROL_LOST");
    assert!(backend.writes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn partial_and_unknown_native_outcomes_remain_queryable_without_retry_hint() {
    let backend = Arc::new(FakeBackend::new());
    backend.reports.lock().unwrap().push_back(SendReport {
        native_fact: None,
        bytes: ByteCount::exact(2),
        failure: Some(runtime_error(ErrorCode::IoError, "partial write")),
    });
    backend.reports.lock().unwrap().push_back(SendReport {
        native_fact: None,
        bytes: ByteCount::at_least(0),
        failure: Some(runtime_error(
            ErrorCode::OutcomeUnknown,
            "driver outcome unknown",
        )),
    });
    let handler = handler(backend, true);
    let lease = acquire(&handler, 1).await;
    let partial = handler
        .handle(connection(1), send_request("partial", &lease))
        .await
        .unwrap();
    assert_eq!(
        partial["outcome"],
        json!({"certainty":"partial","bytesWritten":"2"})
    );
    assert_eq!(partial["error"]["retryable"], false);
    assert_eq!(get_operation(&handler, 2, "partial").await, partial);
    let unknown = handler
        .handle(connection(1), send_request("unknown", &lease))
        .await
        .unwrap();
    assert_eq!(
        unknown["outcome"],
        json!({"certainty":"unknown","bytesWritten":"0"})
    );
    assert_eq!(unknown["status"], "unknown");
    assert_eq!(unknown["error"]["code"], "OUTCOME_UNKNOWN");
}

#[tokio::test]
async fn native_completion_facts_are_retained_and_mismatched_generations_are_unknown() {
    let backend = Arc::new(FakeBackend::new());
    backend.reports.lock().unwrap().push_back(SendReport {
        bytes: ByteCount::exact(4),
        failure: None,
        native_fact: Some(NativeFact {
            generation: 7,
            timestamp: Some(1234),
        }),
    });
    backend.reports.lock().unwrap().push_back(SendReport {
        bytes: ByteCount::exact(4),
        failure: None,
        native_fact: Some(NativeFact {
            generation: 8,
            timestamp: Some(1235),
        }),
    });
    let handler = handler(backend, true);
    let lease = acquire(&handler, 1).await;
    let first = handler
        .handle(connection(1), send_request("native-fact", &lease))
        .await
        .unwrap();
    assert_eq!(first["nativeGeneration"], "7");
    assert_eq!(first["completedAtMs"], 1234);
    let mismatch = handler
        .handle(connection(1), send_request("native-mismatch", &lease))
        .await
        .unwrap();
    assert_eq!(mismatch["nativeGeneration"], "8");
    assert_eq!(mismatch["status"], "unknown");
    assert_eq!(mismatch["outcome"]["certainty"], "unknown");
    assert_eq!(mismatch["error"]["code"], "OUTCOME_UNKNOWN");
}

#[tokio::test]
async fn ledger_capacity_rejects_new_work_without_evicting_dedupe_records() {
    let backend = Arc::new(FakeBackend::new());
    let mut handler = handler(backend.clone(), true);
    Arc::get_mut(&mut handler.shared).unwrap().max_operations = 1;
    let lease = acquire(&handler, 1).await;
    let request = send_request("retained", &lease);
    let first = handler
        .handle(connection(1), request.clone())
        .await
        .unwrap();
    assert_eq!(
        handler
            .handle(connection(1), send_request("full", &lease))
            .await
            .unwrap_err()
            .code,
        ErrorCode::PortBusy
    );
    assert_eq!(handler.handle(connection(1), request).await.unwrap(), first);
    assert_eq!(backend.writes.lock().unwrap().len(), 1);
}

async fn tcp_call(
    writer: &mut tokio::net::tcp::OwnedWriteHalf,
    reader: &mut FrameReader<tokio::net::tcp::OwnedReadHalf>,
    request: &Request,
) -> Value {
    writer
        .write_all(&encode_request(request, DEFAULT_MAX_FRAME_BYTES).unwrap())
        .await
        .unwrap();
    let frame = timeout(Duration::from_secs(2), reader.read_frame())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    match decode_response(&frame, DEFAULT_MAX_FRAME_BYTES).unwrap() {
        Response::Ok { result, .. } => result,
        response => panic!("unexpected response: {response:?}"),
    }
}

#[tokio::test]
async fn loopback_handshake_acquire_send_query_release_vertical_slice() {
    let backend = Arc::new(FakeBackend::new());
    let handler = Arc::new(handler(backend.clone(), true));
    let listener = LoopbackListener::bind(
        0,
        ListenerConfig::new("epoch-test", handler.capabilities()),
        handler,
    )
    .await
    .unwrap();
    let (read, mut write) = TcpStream::connect(listener.local_addr())
        .await
        .unwrap()
        .into_split();
    let mut read = FrameReader::new(read, DEFAULT_MAX_FRAME_BYTES).unwrap();
    let handshake = tcp_call(
        &mut write,
        &mut read,
        &Request::new("h", "handshake", json!({})),
    )
    .await;
    assert!(handshake["capabilities"]
        .as_array()
        .unwrap()
        .contains(&json!("serial.send")));
    let lease = tcp_call(
        &mut write,
        &mut read,
        &port_request("acquire", "control.acquire", json!({"ttlMs":5000})),
    )
    .await;
    let sent = tcp_call(&mut write, &mut read, &send_request("tcp-send", &lease)).await;
    assert_eq!(sent["state"], "succeeded");
    let queried = tcp_call(
        &mut write,
        &mut read,
        &port_request(
            "tcp-query",
            "operations.get",
            json!({"requestId":"tcp-send"}),
        ),
    )
    .await;
    assert_eq!(queried, sent);
    let released = tcp_call(
        &mut write,
        &mut read,
        &with_lease(
            port_request("release", "control.release", json!({})),
            &lease,
        ),
    )
    .await;
    assert_eq!(released, Value::Null);
    listener.shutdown().await.unwrap();
    assert_eq!(backend.writes.lock().unwrap()[0], b"AT\r\n");
}
