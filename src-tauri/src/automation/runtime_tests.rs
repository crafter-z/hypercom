use super::*;
use crate::automation::transport::{
    decode_response, encode_request, Control, FrameReader, Precondition, Response, Target,
    DEFAULT_MAX_FRAME_BYTES,
};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::Notify;
use tokio::time::timeout;

#[derive(Default)]
struct FakeBackend {
    generation: AtomicU64,
    reopen_after_snapshot: AtomicBool,
    shutting_down: AtomicBool,
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
    fn is_shutting_down(&self) -> bool {
        self.shutting_down.load(Ordering::SeqCst)
    }

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
                shared.authority.state.try_lock().is_ok(),
                "native state must not be acquired under runtime authority state"
            );
        }
        let snapshot = if self.reopen_after_snapshot.swap(false, Ordering::SeqCst) {
            self.generation.fetch_add(1, Ordering::SeqCst)
        } else {
            self.generation.load(Ordering::SeqCst)
        };
        match snapshot {
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
async fn native_permit_blocks_cli_on_same_port_but_admits_a_different_port() {
    let handler = handler(Arc::new(FakeBackend::new()), true);
    let status = handler
        .handle(
            connection(1),
            Request::new("native-status", "host.status", json!({})),
        )
        .await
        .unwrap();
    assert_eq!(status["nativeGuiArbitration"], true);
    let native = handler
        .shared
        .authority
        .admit_native_ports(&["COM3"])
        .unwrap();

    let busy = handler
        .handle(
            connection(1),
            port_request("native-busy", "control.acquire", json!({"ttlMs":1000})),
        )
        .await
        .unwrap_err();
    assert_eq!(busy.code, ErrorCode::PortBusy);

    // Native ownership is per local port, not a global desktop mutex.
    let other = handler
        .shared
        .authority
        .admit_native_ports(&["COM4"])
        .unwrap();
    drop(other);
    drop(native);
    assert_eq!(acquire(&handler, 1).await["state"], "granted");
}

#[tokio::test]
async fn native_batch_admission_is_atomic_and_duplicate_names_do_not_underflow() {
    let handler = handler(Arc::new(FakeBackend::new()), true);
    let cli = acquire(&handler, 1).await;

    // COM4 must not be left reserved when the batch fails on COM3.
    assert!(handler
        .shared
        .authority
        .admit_native_ports(&["COM3", "COM4"])
        .is_err());
    let unreserved = handler
        .shared
        .authority
        .admit_native_ports(&["COM4"])
        .unwrap();
    drop(unreserved);
    handler
        .handle(
            connection(1),
            with_lease(
                port_request(
                    "release-before-grouped-native",
                    "control.release",
                    json!({}),
                ),
                &cli,
            ),
        )
        .await
        .unwrap();

    // This is the compatibility shape used by one desktop process which has
    // several writers targeting the same native port.
    let grouped = handler
        .shared
        .authority
        .admit_native_ports(&["COM3", "COM3"])
        .unwrap();
    let second_native = handler
        .shared
        .authority
        .admit_native_ports(&["COM3"])
        .unwrap();
    assert_eq!(
        handler
            .handle(
                connection(2),
                port_request("grouped-busy", "control.acquire", json!({"ttlMs":1000})),
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::PortBusy
    );
    drop(second_native);
    assert_eq!(
        handler
            .handle(
                connection(2),
                port_request(
                    "grouped-still-busy",
                    "control.acquire",
                    json!({"ttlMs":1000})
                ),
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::PortBusy
    );
    drop(grouped);
    assert_eq!(acquire(&handler, 2).await["state"], "granted");
}

#[tokio::test]
async fn cli_lease_blocks_native_until_release_or_disconnect() {
    let handler = handler(Arc::new(FakeBackend::new()), true);
    let lease = acquire(&handler, 1).await;
    assert!(handler
        .shared
        .authority
        .admit_native_ports(&["COM3"])
        .is_err());

    handler
        .handle(
            connection(1),
            with_lease(
                port_request("native-after-release", "control.release", json!({})),
                &lease,
            ),
        )
        .await
        .unwrap();
    let after_release = handler
        .shared
        .authority
        .admit_native_ports(&["COM3"])
        .unwrap();
    drop(after_release);

    let _second = acquire(&handler, 2).await;
    handler.disconnected(connection(2), None);
    let after_disconnect = handler
        .shared
        .authority
        .admit_native_ports(&["COM3"])
        .unwrap();
    drop(after_disconnect);
}

#[tokio::test]
async fn expired_queued_cli_request_is_rejected_while_native_admission_opens() {
    let backend = Arc::new(FakeBackend::new());
    backend.block_before.store(true, Ordering::SeqCst);
    let handler = Arc::new(handler(backend.clone(), true));
    let lease = handler
        .handle(
            connection(1),
            port_request("short-lease-native", "control.acquire", json!({"ttlMs":20})),
        )
        .await
        .unwrap();
    let sending = {
        let handler = handler.clone();
        tokio::spawn(async move {
            handler
                .handle(connection(1), send_request("expired-native", &lease))
                .await
        })
    };
    timeout(TEST_TCP_TIMEOUT, backend.before.notified())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(35)).await;

    let native = handler
        .shared
        .authority
        .admit_native_ports(&["COM3"])
        .unwrap();
    assert_eq!(
        handler
            .handle(
                connection(2),
                port_request(
                    "native-blocks-old-cli",
                    "control.acquire",
                    json!({"ttlMs":1000})
                ),
            )
            .await
            .unwrap_err()
            .code,
        ErrorCode::PortBusy
    );
    backend.continue_before.notify_one();
    let result = sending.await.unwrap().unwrap();
    assert_eq!(result["state"], "failed");
    assert_eq!(result["error"]["code"], "CONTROL_LOST");
    assert!(backend.writes.lock().unwrap().is_empty());
    drop(native);
    assert_eq!(acquire(&handler, 2).await["state"], "granted");
}

#[tokio::test]
async fn expired_in_flight_cli_write_blocks_native_until_physical_completion() {
    let backend = Arc::new(FakeBackend::new());
    backend.block_after.store(true, Ordering::SeqCst);
    let handler = Arc::new(handler(backend.clone(), true));
    let lease = handler
        .handle(
            connection(1),
            port_request("short-in-flight", "control.acquire", json!({"ttlMs":20})),
        )
        .await
        .unwrap();
    let sending = {
        let handler = handler.clone();
        tokio::spawn(async move {
            handler
                .handle(connection(1), send_request("expired-in-flight", &lease))
                .await
        })
    };
    timeout(TEST_TCP_TIMEOUT, backend.after.notified())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(35)).await;
    assert!(handler
        .shared
        .authority
        .admit_native_ports(&["COM3"])
        .is_err());
    backend.continue_after.notify_one();
    assert_eq!(sending.await.unwrap().unwrap()["state"], "succeeded");
    let native = handler
        .shared
        .authority
        .admit_native_ports(&["COM3"])
        .unwrap();
    drop(native);
}

#[tokio::test]
async fn disconnected_in_flight_cli_write_blocks_native_until_physical_completion() {
    let backend = Arc::new(FakeBackend::new());
    backend.block_after.store(true, Ordering::SeqCst);
    let handler = Arc::new(handler(backend.clone(), true));
    let lease = acquire(&handler, 1).await;
    let sending = {
        let handler = handler.clone();
        tokio::spawn(async move {
            handler
                .handle(
                    connection(1),
                    send_request("disconnected-in-flight", &lease),
                )
                .await
        })
    };
    timeout(TEST_TCP_TIMEOUT, backend.after.notified())
        .await
        .unwrap();
    handler.disconnected(connection(1), None);
    assert!(handler
        .shared
        .authority
        .admit_native_ports(&["COM3"])
        .is_err());
    backend.continue_after.notify_one();
    assert_eq!(sending.await.unwrap().unwrap()["state"], "succeeded");
    let native = handler
        .shared
        .authority
        .admit_native_ports(&["COM3"])
        .unwrap();
    drop(native);
}

#[tokio::test]
async fn loopback_listener_native_permit_blocks_cli_and_drop_reopens_port() {
    let backend = Arc::new(FakeBackend::new());
    let handler = Arc::new(handler(backend, true));
    let listener = bind_test_listener(handler.clone()).await;
    let (mut write, mut read) = tcp_client(&listener).await;
    tcp_call(
        &mut write,
        &mut read,
        &Request::new("listener-handshake", "handshake", json!({})),
    )
    .await;

    let native = handler
        .shared
        .authority
        .admit_native_ports(&["COM3"])
        .unwrap();
    match tcp_exchange(
        &mut write,
        &mut read,
        &port_request("listener-busy", "control.acquire", json!({"ttlMs":1000})),
    )
    .await
    {
        Response::Error { error, .. } => assert_eq!(error.code, ErrorCode::PortBusy),
        response => panic!("native permit should block listener CLI acquire: {response:?}"),
    }
    drop(native);
    assert_eq!(
        tcp_call(
            &mut write,
            &mut read,
            &port_request("listener-open", "control.acquire", json!({"ttlMs":1000})),
        )
        .await["state"],
        "granted"
    );
    shutdown_test_listener(listener).await;
}

#[tokio::test]
async fn automation_rejects_unimplemented_virtual_writer_targets() {
    let handler = handler(Arc::new(FakeBackend::new()), true);
    for port in ["GIT:BASH", "GIT:other", "SIM:not-enumerated"] {
        let mut request = port_request("virtual-control", "control.acquire", json!({"ttlMs":1000}));
        request.target.as_mut().unwrap().native_port_id = port.into();
        assert_eq!(
            handler
                .handle(connection(1), request)
                .await
                .unwrap_err()
                .code,
            ErrorCode::UnsupportedCapability,
            "{port} must not hold automation control"
        );
    }
}

#[tokio::test]
async fn acquisition_does_not_publish_a_lease_for_a_reopened_connection() {
    let backend = Arc::new(FakeBackend::new());
    backend.reopen_after_snapshot.store(true, Ordering::SeqCst);
    let handler = handler(backend, true);
    let error = handler
        .handle(
            connection(1),
            port_request(
                "acquire-old-generation",
                "control.acquire",
                json!({"ttlMs":60000}),
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::StaleSession);
    let native = handler
        .shared
        .authority
        .admit_native_ports(&["COM3"])
        .unwrap();
    drop(native);
    let mut current = port_request(
        "acquire-new-generation",
        "control.acquire",
        json!({"ttlMs":60000}),
    );
    current.precondition.as_mut().unwrap().connection_generation = Some(8);
    let lease = handler.handle(connection(2), current).await.unwrap();
    assert_eq!(lease["connectionGeneration"], "8");
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

type TestTcpReader = FrameReader<tokio::net::tcp::OwnedReadHalf>;
type TestTcpWriter = tokio::net::tcp::OwnedWriteHalf;

async fn tcp_client(listener: &LoopbackListener) -> (TestTcpWriter, TestTcpReader) {
    let (read, write) = timeout(TEST_TCP_TIMEOUT, TcpStream::connect(listener.local_addr()))
        .await
        .expect("connect to test listener timed out")
        .expect("connect to test listener")
        .into_split();
    (
        write,
        FrameReader::new(read, DEFAULT_MAX_FRAME_BYTES).unwrap(),
    )
}

async fn tcp_send(writer: &mut TestTcpWriter, request: &Request) {
    let frame = encode_request(request, DEFAULT_MAX_FRAME_BYTES).unwrap();
    timeout(TEST_TCP_TIMEOUT, writer.write_all(&frame))
        .await
        .expect("test TCP write timed out")
        .expect("write request to test TCP connection");
}

async fn tcp_exchange(
    writer: &mut TestTcpWriter,
    reader: &mut TestTcpReader,
    request: &Request,
) -> Response {
    tcp_send(writer, request).await;
    let frame = timeout(TEST_TCP_TIMEOUT, reader.read_frame())
        .await
        .expect("test TCP response timed out")
        .expect("read test TCP response")
        .expect("test TCP connection closed before response");
    decode_response(&frame, DEFAULT_MAX_FRAME_BYTES).unwrap()
}

async fn tcp_call(
    writer: &mut TestTcpWriter,
    reader: &mut TestTcpReader,
    request: &Request,
) -> Value {
    match tcp_exchange(writer, reader, request).await {
        Response::Ok { result, .. } => result,
        response => panic!("unexpected response: {response:?}"),
    }
}

#[tokio::test]
async fn loopback_handshake_acquire_send_query_release_vertical_slice() {
    let backend = Arc::new(FakeBackend::new());
    let listener = bind_test_listener(Arc::new(handler(backend.clone(), true))).await;
    let (mut write, mut read) = tcp_client(&listener).await;
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
    shutdown_test_listener(listener).await;
    assert_eq!(backend.writes.lock().unwrap()[0], b"AT\r\n");
}

#[tokio::test]
async fn loopback_eof_before_native_guard_prevents_old_write() {
    assert_loopback_eof_fencing(false).await;
}

#[tokio::test]
async fn loopback_eof_during_native_write_drains_before_granting_new_control() {
    assert_loopback_eof_fencing(true).await;
}

async fn assert_loopback_eof_fencing(after_guard: bool) {
    let backend = Arc::new(FakeBackend::new());
    backend.block_before.store(!after_guard, Ordering::SeqCst);
    backend.block_after.store(after_guard, Ordering::SeqCst);
    let handler = Arc::new(handler(backend.clone(), true));
    let listener = bind_test_listener(handler.clone()).await;
    let (mut old_write, mut old_read) = tcp_client(&listener).await;
    let (mut new_write, mut new_read) = tcp_client(&listener).await;
    let hello = Request::new("hello", "handshake", json!({}));
    tcp_call(&mut old_write, &mut old_read, &hello).await;
    tcp_call(&mut new_write, &mut new_read, &hello).await;
    let acquire = |id: &str| port_request(id, "control.acquire", json!({"ttlMs":60000}));
    let old_lease = tcp_call(&mut old_write, &mut old_read, &acquire("original-lease")).await;
    let old_session = old_lease["clientSessionId"].as_str().unwrap();
    let blocked = if after_guard {
        &backend.after
    } else {
        &backend.before
    };
    let unblock = if after_guard {
        &backend.continue_after
    } else {
        &backend.continue_before
    };
    tcp_send(&mut old_write, &send_request("eof-send", &old_lease)).await;
    timeout(TEST_TCP_TIMEOUT, blocked.notified())
        .await
        .expect("fake backend did not reach the write barrier");

    let query = |id: &str| port_request(id, "operations.get", json!({"requestId":"eof-send"}));
    let pending = tcp_call(&mut new_write, &mut new_read, &query("while-blocked")).await;
    assert_eq!(
        pending["state"],
        if after_guard { "executing" } else { "queued" }
    );
    // Send a real TCP FIN (not listener shutdown, a direct handler call or a
    // socket reset). Keep the read half open and don't wait for the response.
    timeout(TEST_TCP_TIMEOUT, old_write.shutdown())
        .await
        .expect("test TCP half-close timed out")
        .expect("half-close old TCP connection");
    // Observe the disconnect hook's effect before releasing the fake backend.
    // In the executing case, PORT_BUSY alone would not prove EOF was handled.
    timeout(TEST_TCP_TIMEOUT, async {
        while handler
            .shared
            .authority
            .state
            .lock()
            .unwrap()
            .sessions
            .values()
            .any(|session| session.id.0 == old_session)
        {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("listener did not disconnect the old session while the fake write was blocked");

    let new_lease = if after_guard {
        let busy = tcp_exchange(&mut new_write, &mut new_read, &acquire("must-drain")).await;
        match busy {
            Response::Error { error, .. } => assert_eq!(error.code, ErrorCode::PortBusy),
            response => panic!("in-flight write must block the new lease: {response:?}"),
        }
        None
    } else {
        Some(tcp_call(&mut new_write, &mut new_read, &acquire("new-lease")).await)
    };
    unblock.notify_one();

    let completed = timeout(TEST_TCP_TIMEOUT, async {
        for attempt in 0_u64.. {
            let result = tcp_call(
                &mut new_write,
                &mut new_read,
                &query(&format!("query-after-eof-{attempt}")),
            )
            .await;
            if !matches!(result["state"].as_str(), Some("queued" | "executing")) {
                return result;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        unreachable!()
    })
    .await
    .expect("old operation did not finish after advancing the fake backend");
    assert_eq!(completed["operationId"], pending["operationId"]);
    let new_lease = if after_guard {
        assert_eq!(completed["state"], "succeeded");
        assert_eq!(
            completed["outcome"],
            json!({"certainty":"known","bytesWritten":"4"})
        );
        assert_eq!(*backend.writes.lock().unwrap(), vec![b"AT\r\n".to_vec()]);
        tcp_call(&mut new_write, &mut new_read, &acquire("after-drain")).await
    } else {
        assert_eq!(completed["state"], "failed");
        assert_eq!(completed["error"]["code"], "CONTROL_LOST");
        assert_eq!(
            completed["outcome"],
            json!({"certainty":"known","bytesWritten":"0"})
        );
        assert!(backend.writes.lock().unwrap().is_empty());
        new_lease.unwrap()
    };
    assert_eq!(new_lease["state"], "granted");
    assert_ne!(new_lease["leaseId"], old_lease["leaseId"]);
    assert_eq!(backend.generation("COM3").unwrap(), 7);
    shutdown_test_listener(listener).await;
}

#[tokio::test]
async fn shutdown_rejects_new_requests_and_an_existing_send_that_has_not_started() {
    let backend = Arc::new(FakeBackend::new());
    backend.block_before.store(true, Ordering::SeqCst);
    let handler = Arc::new(handler(backend.clone(), true));
    let lease = acquire(&handler, 1).await;
    let pending = tokio::spawn({
        let handler = handler.clone();
        async move {
            handler
                .handle(connection(1), send_request("queued-at-stop", &lease))
                .await
        }
    });
    timeout(TEST_TCP_TIMEOUT, backend.before.notified())
        .await
        .unwrap();
    backend.shutting_down.store(true, Ordering::SeqCst);
    let error = handler
        .handle(
            connection(2),
            Request::new("read-at-stop", "host.status", json!({})),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::ShuttingDown);
    backend.continue_before.notify_one();
    let finished = timeout(TEST_TCP_TIMEOUT, pending)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(finished["state"], "failed");
    assert_eq!(finished["error"]["code"], "SHUTTING_DOWN");
    assert!(backend.writes.lock().unwrap().is_empty());
}

const TEST_TCP_TIMEOUT: Duration = Duration::from_secs(5);
const TEST_CLI_TIMEOUT: Duration = Duration::from_secs(10);

async fn bind_test_listener(handler: Arc<LocalAutomationHandler>) -> LoopbackListener {
    timeout(
        TEST_TCP_TIMEOUT,
        LoopbackListener::bind(
            0,
            ListenerConfig::new("epoch-test", handler.capabilities()),
            handler,
        ),
    )
    .await
    .expect("test listener bind timed out")
    .expect("bind the runtime to an ephemeral loopback port")
}

async fn shutdown_test_listener(listener: LoopbackListener) {
    timeout(TEST_TCP_TIMEOUT, listener.shutdown())
        .await
        .expect("test listener shutdown timed out")
        .expect("shut down the test listener");
}

fn cli_binary_path() -> PathBuf {
    let bin = std::env::var_os("HYPERCOM_TEST_CLI_BIN")
        .filter(|bin| !bin.is_empty())
        .expect("HYPERCOM_TEST_CLI_BIN must point to the built hypercom-cli; run npm run test:cli");
    // Resolve relative paths as files too, never look up a same-named program on PATH.
    std::path::absolute(bin).expect("resolve HYPERCOM_TEST_CLI_BIN")
}

async fn run_cli(
    bin: &Path,
    listener: &LoopbackListener,
    args: &[&str],
    input: Option<&[u8]>,
) -> Output {
    let mut child = Command::new(bin)
        .arg("--endpoint")
        .arg(listener.local_addr().to_string())
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap_or_else(|error| panic!("spawn {} {args:?}: {error}", bin.display()));
    let stdin = child.stdin.take();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let mut out = Vec::new();
    let mut err = Vec::new();
    let write_input = async move {
        if let Some(input) = input {
            stdin.expect("piped CLI stdin").write_all(input).await?;
            // Dropping the pipe delivers EOF to `--stdin`.
        }
        Ok(())
    };
    let result = timeout(TEST_CLI_TIMEOUT, async {
        tokio::try_join!(
            write_input,
            child.wait(),
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err),
        )
    })
    .await;
    match result {
        Ok(Ok(((), status, _, _))) => Output {
            status,
            stdout: out,
            stderr: err,
        },
        failure => {
            // Tokio's kill also waits for the child; kill_on_drop is the fallback.
            let _ = timeout(TEST_TCP_TIMEOUT, child.kill()).await;
            panic!(
                "hypercom-cli {args:?} did not complete: {failure:?}; stdout: {}; stderr: {}",
                String::from_utf8_lossy(&out),
                String::from_utf8_lossy(&err),
            );
        }
    }
}

fn cli_json(output: &Output, success: bool) -> Value {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output
            .status
            .code()
            .is_some_and(|code| (code == 0) == success),
        "expected CLI success={success}, got {}; stdout: {stdout}; stderr: {stderr}",
        output.status,
    );
    let value: Value = serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!("invalid CLI JSON: {error}; stdout: {stdout}; stderr: {stderr}")
    });
    assert_eq!(value["ok"], success, "unexpected CLI response: {value}");
    value
}

fn cli_success(output: &Output) -> Value {
    cli_json(output, true)
        .get("result")
        .expect("CLI success did not return a result")
        .clone()
}

async fn cli_operation(bin: &Path, listener: &LoopbackListener, request_id: &str) -> Value {
    cli_success(
        &run_cli(
            bin,
            listener,
            &["operation", "get", "--request-id", request_id],
            None,
        )
        .await,
    )
}

#[tokio::test]
#[ignore = "requires HYPERCOM_TEST_CLI_BIN; run npm run test:cli"]
async fn cli_binary_default_local_status_and_ports_list() {
    let bin = cli_binary_path();
    let backend = Arc::new(FakeBackend::new());
    let listener = bind_test_listener(Arc::new(handler(backend, false))).await;

    // Do not supply --target; the CLI must resolve the default local host.
    let status = cli_success(&run_cli(&bin, &listener, &["status"], None).await);
    assert_eq!(status["hostId"], "host-test");
    assert_eq!(status["serverEpoch"], "epoch-test");
    assert_eq!(status["serialControl"], "not-enabled");
    assert_eq!(status["capabilities"], json!(["host.status", "ports.list"]));
    let ports = cli_success(&run_cli(&bin, &listener, &["ports", "list"], None).await);
    assert_eq!(ports["hostId"], status["hostId"]);
    assert_eq!(ports["serverEpoch"], status["serverEpoch"]);
    assert_eq!(ports["readOnly"], true);
    assert_eq!(
        ports["ports"],
        json!([{"target":{"hostId":"host-test","nativePortId":"COM3"},
            "serverEpoch":"epoch-test","connectionGeneration":"7","state":"open"}]),
    );

    shutdown_test_listener(listener).await;
}

#[tokio::test]
#[ignore = "requires HYPERCOM_TEST_CLI_BIN; run npm run test:cli"]
async fn cli_binary_send_discovers_generation_acquires_on_same_connection_and_queries() {
    let bin = cli_binary_path();
    let backend = Arc::new(FakeBackend::new());
    let listener = bind_test_listener(Arc::new(handler(backend.clone(), true))).await;

    // No generation, lease or fence is supplied. The runtime binds the lease
    // holder to the TCP connection, so acquiring on a different one cannot send.
    let expected = b"AT + TEST\r\n";
    let sent = cli_success(
        &run_cli(
            &bin,
            &listener,
            &[
                "send",
                "--port",
                "COM3",
                "--text",
                "AT + TEST",
                "--ending",
                "crlf",
            ],
            None,
        )
        .await,
    );
    assert_eq!(sent["state"], "succeeded");
    assert_eq!(sent["connectionGeneration"], "7");
    assert_eq!(
        sent["target"],
        json!({"hostId":"host-test","nativePortId":"COM3"})
    );
    assert_eq!(
        sent["outcome"],
        json!({"certainty":"known","bytesWritten":expected.len().to_string()}),
    );
    let request_id = sent["requestId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .unwrap();
    let operation_id = sent["operationId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .unwrap();
    assert_eq!(cli_operation(&bin, &listener, request_id).await, sent);
    assert_eq!(*backend.writes.lock().unwrap(), vec![expected.to_vec()]);
    assert_eq!(
        backend.contexts.lock().unwrap()[0].operation_id.as_deref(),
        Some(operation_id),
    );

    shutdown_test_listener(listener).await;
}

#[tokio::test]
#[ignore = "requires HYPERCOM_TEST_CLI_BIN; run npm run test:cli"]
async fn cli_binary_stdin_preserves_exact_binary_bytes() {
    let bin = cli_binary_path();
    let backend = Arc::new(FakeBackend::new());
    let listener = bind_test_listener(Arc::new(handler(backend.clone(), true))).await;

    let input = b"\x00\xff\x80\r\nA\x1a\n\x00";
    let sent = cli_success(
        &run_cli(
            &bin,
            &listener,
            &["send", "--port", "COM3", "--stdin"],
            Some(input),
        )
        .await,
    );
    assert_eq!(sent["state"], "succeeded");
    assert_eq!(
        sent["outcome"],
        json!({"certainty":"known","bytesWritten":input.len().to_string()}),
    );
    assert_eq!(*backend.writes.lock().unwrap(), vec![input.to_vec()]);

    shutdown_test_listener(listener).await;
}

#[tokio::test]
#[ignore = "requires HYPERCOM_TEST_CLI_BIN; run npm run test:cli"]
async fn cli_binary_read_only_denies_send_and_watch_is_unsupported() {
    let bin = cli_binary_path();
    let backend = Arc::new(FakeBackend::new());
    let listener = bind_test_listener(Arc::new(handler(backend.clone(), false))).await;

    let denied = cli_json(
        &run_cli(
            &bin,
            &listener,
            &["send", "--port", "COM3", "--text", "AT"],
            None,
        )
        .await,
        false,
    );
    assert!(
        matches!(
            denied["error"]["code"].as_str(),
            Some("UNSUPPORTED_CAPABILITY" | "PERMISSION_DENIED")
        ),
        "expected read-only control denial, got {denied}",
    );
    assert!(denied["error"]["message"]
        .as_str()
        .is_some_and(|msg| !msg.is_empty()));

    let unsupported = cli_json(
        &run_cli(&bin, &listener, &["watch", "--port", "COM3"], None).await,
        false,
    );
    assert_eq!(unsupported["error"]["code"], "UNSUPPORTED_CAPABILITY");
    assert!(unsupported["error"]["message"]
        .as_str()
        .is_some_and(|msg| !msg.is_empty()));
    assert!(backend.writes.lock().unwrap().is_empty());

    shutdown_test_listener(listener).await;
}

#[tokio::test]
#[ignore = "requires HYPERCOM_TEST_CLI_BIN; run npm run test:cli"]
async fn cli_binary_ack_timeout_keeps_request_id_and_does_not_replay() {
    let bin = cli_binary_path();
    let backend = Arc::new(FakeBackend::new());
    backend.block_after.store(true, Ordering::SeqCst);
    let handler = Arc::new(handler(backend.clone(), true));
    let listener = bind_test_listener(handler.clone()).await;
    let (output, entered_driver) = tokio::join!(
        run_cli(
            &bin,
            &listener,
            &[
                "send",
                "--port",
                "COM3",
                "--text",
                "PING",
                "--timeout-ms",
                "2000"
            ],
            None
        ),
        timeout(TEST_TCP_TIMEOUT, backend.after.notified()),
    );
    entered_driver.expect("CLI send did not reach the fake driver's write barrier");
    assert_eq!(output.status.code(), Some(7));
    let failure = cli_json(&output, false);
    assert_eq!(failure["error"]["code"], "OUTCOME_UNKNOWN");
    let request_id = failure["requestId"].as_str().unwrap();
    assert_eq!(
        backend.contexts.lock().unwrap()[0].request_id.as_deref(),
        Some(request_id)
    );

    backend.continue_after.notify_one();
    let key = RequestKey {
        principal_id: PrincipalId(TEST_PRINCIPAL.into()),
        request_id: RequestId(request_id.into()),
    };
    timeout(TEST_TCP_TIMEOUT, async {
        while !handler
            .shared
            .authority
            .state
            .lock()
            .unwrap()
            .operations
            .get(&key)
            .is_some_and(|record| record.status.is_terminal())
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("host did not record the final operation after disconnect");
    let operation = cli_operation(&bin, &listener, request_id).await;
    assert_eq!(operation["state"], "succeeded");
    assert_eq!(*backend.writes.lock().unwrap(), vec![b"PING".to_vec()]);
    shutdown_test_listener(listener).await;
}

#[tokio::test]
#[ignore = "requires HYPERCOM_TEST_CLI_BIN; run npm run test:cli"]
async fn cli_binary_partial_and_unknown_sends_fail_with_queryable_request_ids() {
    let bin = cli_binary_path();
    for (bytes, code, code_string, message, status, certainty) in [
        (
            ByteCount::exact(2),
            ErrorCode::IoError,
            "IO_ERROR",
            "partial write",
            "failed",
            "partial",
        ),
        (
            ByteCount::at_least(0),
            ErrorCode::OutcomeUnknown,
            "OUTCOME_UNKNOWN",
            "driver outcome unknown",
            "unknown",
            "unknown",
        ),
    ] {
        let backend = Arc::new(FakeBackend::new());
        backend.reports.lock().unwrap().push_back(SendReport {
            native_fact: None,
            bytes,
            failure: Some(runtime_error(code, message)),
        });
        let listener = bind_test_listener(Arc::new(handler(backend.clone(), true))).await;

        let failed = cli_json(
            &run_cli(
                &bin,
                &listener,
                &["send", "--port", "COM3", "--text", "ABCD"],
                None,
            )
            .await,
            false,
        );
        assert_eq!(failed["error"]["code"], code_string);
        assert!(failed["error"]["message"]
            .as_str()
            .is_some_and(|msg| !msg.is_empty()));
        let request_id = failed["requestId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .unwrap();
        // Querying is read-only and succeeds even though the original send failed.
        // Check authoritative details here, without depending on how the CLI
        // chooses to include extra operation fields in the failed send output.
        let operation = cli_operation(&bin, &listener, request_id).await;
        assert_eq!(operation["requestId"], request_id);
        assert_eq!(operation["state"], "failed");
        assert_eq!(operation["status"], status);
        assert_eq!(operation["error"]["code"], code_string);
        assert_eq!(operation["error"]["message"], message);
        assert_eq!(operation["error"]["retryable"], false);
        assert_eq!(
            operation["outcome"],
            json!({"certainty":certainty,"bytesWritten":bytes.known.to_string()}),
        );
        // Each case attempted the write once; neither send nor query replayed it.
        assert_eq!(*backend.writes.lock().unwrap(), vec![b"ABCD".to_vec()]);

        shutdown_test_listener(listener).await;
    }
}
