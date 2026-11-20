use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tokio::io::{duplex, AsyncReadExt};
use tokio::net::TcpStream;
use tokio::sync::Notify;

fn config() -> ListenerConfig {
    ListenerConfig::new("epoch-1", vec!["host.status".into(), "serial.send".into()])
}

fn request(id: &str, method: &str) -> Request {
    Request::new(id, method, Value::Null)
}

fn assert_error(response: &Response, code: ErrorCode, id: Option<&str>) {
    assert_eq!(response.request_id(), id);
    match response {
        Response::Error { error, .. } => assert_eq!(error.code, code),
        response => panic!("expected error, got {response:?}"),
    }
}

#[test]
fn request_round_trip_preserves_guards_and_escaped_newlines() {
    let mut expected = request("request-1", "serial.send");
    expected.target = Some(Target {
        host_id: "host-1".into(),
        native_port_id: "COM3".into(),
    });
    expected.precondition = Some(Precondition {
        server_epoch: Some("epoch-1".into()),
        connection_generation: Some(7),
    });
    expected.control = Some(Control {
        lease_id: "lease-1".into(),
        fence: 12,
    });
    expected.timeout_ms = Some(3000);
    expected.params = json!({"text": "line one\nline two\r\n", "raw": [0, 255]});
    let encoded = encode_request(&expected, 4096).unwrap();
    assert_eq!(encoded.iter().filter(|byte| **byte == b'\n').count(), 1);
    assert_eq!(encoded.last(), Some(&b'\n'));
    assert_eq!(
        decode_request(&encoded[..encoded.len() - 1], 4096).unwrap(),
        expected
    );
    let value: Value = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(value["protocolVersion"], 1);
    assert_eq!(value["target"]["nativePortId"], "COM3");
    assert_eq!(value["precondition"]["serverEpoch"], "epoch-1");
    assert_eq!(value["precondition"]["connectionGeneration"], "7");
    assert_eq!(value["control"]["fence"], "12");
    assert!(value.get("request_id").is_none());
}

#[test]
fn counters_preserve_u64_precision_and_reject_ambiguous_numbers() {
    let frame = br#"{"protocolVersion":1,"requestId":"counter","method":"serial.send","precondition":{"connectionGeneration":"18446744073709551615"},"control":{"leaseId":"lease-1","fence":"18446744073709551615"}}"#;
    let decoded = decode_request(frame, 4096).unwrap();
    assert_eq!(
        decoded.precondition.as_ref().unwrap().connection_generation,
        Some(u64::MAX)
    );
    assert_eq!(decoded.control.as_ref().unwrap().fence, u64::MAX);
    let encoded = encode_request(&decoded, 4096).unwrap();
    let value: Value = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(value["control"]["fence"], u64::MAX.to_string());
    for input in [json!(12), json!("12")] {
        let envelope = json!({"protocolVersion":1,"requestId":"safe","method":"serial.send","precondition":{"connectionGeneration":input.clone()},"control":{"leaseId":"l","fence":input}});
        let decoded = decode_request(&serde_json::to_vec(&envelope).unwrap(), 4096).unwrap();
        assert_eq!(decoded.control.unwrap().fence, 12);
        assert_eq!(
            decoded.precondition.unwrap().connection_generation,
            Some(12)
        );
    }
    for input in [
        json!(9_007_199_254_740_992_u64),
        json!(-1),
        json!(1.5),
        json!("01"),
        json!("+1"),
        json!("18446744073709551616"),
    ] {
        let envelope = json!({"protocolVersion":1,"requestId":"bad","method":"serial.send","control":{"leaseId":"l","fence":input}});
        assert_eq!(
            decode_request(&serde_json::to_vec(&envelope).unwrap(), 4096)
                .unwrap_err()
                .error
                .code,
            ErrorCode::InvalidJson
        );
    }
}

#[test]
fn malicious_json_and_envelopes_are_rejected_without_echoing_input() {
    let malicious: &[&[u8]] = &[
        b"",
        b"null",
        b"[]",
        b"\xff",
        b"{}\n{}",
        b"{broken",
        br#"{"protocolVersion":1,"requestId":"a","requestId":"b","method":"handshake"}"#,
        br#"{"protocolVersion":1,"requestId":"a","method":"handshake","principalId":"admin"}"#,
        br#"{"protocolVersion":1,"requestId":{},"method":"handshake"}"#,
        br#"{"protocolVersion":1,"requestId":"a","method":"handshake","params":NaN}"#,
        br#"{"protocolVersion":1,"requestId":"a","method":"handshake"} trailing"#,
    ];
    for frame in malicious {
        let failure = decode_request(frame, 4096).unwrap_err();
        assert_eq!(failure.error.code, ErrorCode::InvalidJson, "{frame:?}");
        assert_eq!(failure.request_id, None);
        assert!(!failure.error.message.contains("principalId"));
    }
    let deep = format!(
        r#"{{"protocolVersion":1,"requestId":"a","method":"handshake","params":{}{}}}"#,
        "[".repeat(200),
        "]".repeat(200)
    );
    assert_eq!(
        decode_request(deep.as_bytes(), 4096)
            .unwrap_err()
            .error
            .code,
        ErrorCode::InvalidJson
    );
    for id in ["", "new\nline", "space id"] {
        let invalid = request(id, "handshake");
        assert_eq!(
            encode_request(&invalid, 4096).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
    }
}

#[test]
fn unknown_versions_are_explicit_and_correlated() {
    let frame = br#"{"protocolVersion":999,"requestId":"v2","method":"handshake"}"#;
    let failure = decode_request(frame, 4096).unwrap_err();
    assert_eq!(failure.request_id.as_deref(), Some("v2"));
    assert_eq!(failure.error.code, ErrorCode::UnsupportedVersion);
    let frame = br#"{"status":"ok","protocolVersion":999,"serverEpoch":"e","requestId":"v2","result":null}"#;
    assert_eq!(
        decode_response(frame, 4096).unwrap_err().code,
        ErrorCode::UnsupportedVersion
    );
}

#[test]
fn bounded_encode_and_decode_reject_oversized_payloads() {
    assert_eq!(
        decode_request(&[b'x'; 65], 64).unwrap_err().error.code,
        ErrorCode::FrameTooLarge
    );
    assert_eq!(
        encode_json_line(&"x".repeat(4096), 64).unwrap_err().code,
        ErrorCode::FrameTooLarge
    );
    assert_eq!(encode_json_line(&"x".repeat(62), 64).unwrap().len(), 65); // quotes + LF
    assert_eq!(
        encode_json_line(&Value::Null, 0).unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        encode_json_line(&Value::Null, MAX_FRAME_BYTES + 1)
            .unwrap_err()
            .code,
        ErrorCode::InvalidArgument
    );
}

#[test]
fn structured_error_round_trip_and_response_exclusivity() {
    let mut error = WireError::new(
        ErrorCode::OutcomeUnknown,
        "inspect original operation before retry",
    );
    error.stage = Some("driver".into());
    error.operation_id = Some("op-1".into());
    error.details = Some(json!({"knownBytes": 3, "sideEffects": "partial"}));
    let response = Response::error("epoch-1", Some("r1".into()), error);
    let line = encode_response(&response, 4096).unwrap();
    let wire: Value = serde_json::from_slice(&line).unwrap();
    assert_eq!(ErrorCode::OutcomeUnknown.as_str(), "OUTCOME_UNKNOWN");
    assert_eq!(wire["error"]["code"], ErrorCode::OutcomeUnknown.as_str());
    assert_eq!(wire["error"]["operationId"], "op-1");
    assert_eq!(wire["error"]["retryable"], false);
    assert_eq!(
        decode_response(&line[..line.len() - 1], 4096).unwrap(),
        response
    );
    let success = Response::ok("epoch-1", "r2".into(), Value::Null);
    let line = encode_response(&success, 4096).unwrap();
    assert_eq!(
        decode_response(&line[..line.len() - 1], 4096).unwrap(),
        success
    );
    let conflicting = br#"{"status":"ok","protocolVersion":1,"serverEpoch":"e","requestId":"r","result":null,"error":{"code":"INTERNAL","message":"bad","retryable":false}}"#;
    assert_eq!(
        decode_response(conflicting, 4096).unwrap_err().code,
        ErrorCode::InvalidJson
    );
}

#[tokio::test]
async fn partial_frames_survive_cancellation_and_accept_multiple_requests() {
    let (mut producer, consumer) = duplex(256);
    let mut reader = FrameReader::new(consumer, 64).unwrap();
    producer.write_all(b"{\"a\":").await.unwrap();
    assert!(timeout(Duration::from_millis(10), reader.read_frame())
        .await
        .is_err());
    producer.write_all(b"1}\n{\"b\":2}\r\n").await.unwrap();
    assert_eq!(reader.read_frame().await.unwrap().unwrap(), br#"{"a":1}"#);
    assert_eq!(reader.read_frame().await.unwrap().unwrap(), b"{\"b\":2}\r");
    drop(producer);
    assert!(reader.read_frame().await.unwrap().is_none());
}

#[tokio::test]
async fn negotiated_frame_limit_applies_to_prefetched_bytes() {
    let mut reader = FrameReader::new(&b"boot\n1234\n12345\n"[..], MAX_FRAME_BYTES).unwrap();
    assert_eq!(reader.read_frame().await.unwrap().unwrap(), b"boot");
    reader.set_limit(4).unwrap();
    for limit in [0, MAX_FRAME_BYTES + 1] {
        assert_eq!(
            reader.set_limit(limit).unwrap_err().code,
            ErrorCode::InvalidArgument
        );
    }
    assert_eq!(reader.read_frame().await.unwrap().unwrap(), b"1234");
    assert!(matches!(
        reader.read_frame().await.unwrap_err(),
        TransportError::Protocol(WireError {
            code: ErrorCode::FrameTooLarge,
            ..
        })
    ));

    let mut reader = FrameReader::new(&b"hi\n123456789\n"[..], 2).unwrap();
    assert_eq!(reader.read_frame().await.unwrap().unwrap(), b"hi");
    reader.set_limit(9).unwrap();
    assert_eq!(reader.read_frame().await.unwrap().unwrap(), b"123456789");
}

#[tokio::test]
async fn smaller_limit_rejects_an_already_partial_frame_without_waiting_for_more() {
    let (mut producer, consumer) = duplex(64);
    let mut reader = FrameReader::new(consumer, 32).unwrap();
    producer.write_all(b"1234").await.unwrap();
    assert!(timeout(Duration::from_millis(10), reader.read_frame())
        .await
        .is_err());
    reader.set_limit(3).unwrap();
    assert!(matches!(
        timeout(Duration::from_secs(2), reader.read_frame())
            .await
            .unwrap()
            .unwrap_err(),
        TransportError::Protocol(WireError {
            code: ErrorCode::FrameTooLarge,
            ..
        })
    ));
}

#[tokio::test]
async fn overlong_unterminated_frames_are_bounded_and_terminal() {
    let mut reader = FrameReader::new(tokio::io::repeat(b'x'), 64).unwrap();
    let error = reader.read_frame().await.unwrap_err();
    assert!(matches!(
        error,
        TransportError::Protocol(WireError {
            code: ErrorCode::FrameTooLarge,
            ..
        })
    ));
    assert!(matches!(
        reader.read_frame().await.unwrap_err(),
        TransportError::Protocol(WireError {
            code: ErrorCode::ConnectionClosed,
            ..
        })
    ));
    let mut exact = FrameReader::new(&b"1234\n"[..], 4).unwrap();
    assert_eq!(exact.read_frame().await.unwrap().unwrap(), b"1234");
    let mut with_cr = FrameReader::new(&b"1234\r\n"[..], 4).unwrap();
    assert!(matches!(
        with_cr.read_frame().await.unwrap_err(),
        TransportError::Protocol(WireError {
            code: ErrorCode::FrameTooLarge,
            ..
        })
    ));
}

#[tokio::test]
async fn eof_with_partial_frame_is_not_accepted_as_a_request() {
    let mut reader = FrameReader::new(&b"{\"ok\":true}"[..], 64).unwrap();
    assert!(matches!(
        reader.read_frame().await.unwrap_err(),
        TransportError::Protocol(WireError {
            code: ErrorCode::IncompleteFrame,
            ..
        })
    ));
}

#[tokio::test]
async fn generic_write_helper_produces_one_complete_line() {
    let (mut writer, reader) = duplex(256);
    write_json_line(&mut writer, &json!({"a": "escaped\nnewline"}), 64)
        .await
        .unwrap();
    drop(writer);
    let mut reader = FrameReader::new(reader, 64).unwrap();
    let line = reader.read_frame().await.unwrap().unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&line).unwrap(),
        json!({"a": "escaped\nnewline"})
    );
    assert!(reader.read_frame().await.unwrap().is_none());
}

#[test]
fn session_requires_handshake_checks_epoch_and_bounds_request_ids() {
    let mut config = config();
    config.max_requests_per_connection = 3;
    let mut state = ProtocolSession::new();
    assert_eq!(
        state
            .admit(&request("before", "host.status"), &config)
            .unwrap_err()
            .code,
        ErrorCode::HandshakeRequired
    );
    state.admit(&request("h", "handshake"), &config).unwrap();
    assert_eq!(
        state
            .admit(&request("h", "serial.send"), &config)
            .unwrap_err()
            .code,
        ErrorCode::RequestIdConflict
    );
    let mut stale = request("stale", "serial.send");
    stale.precondition = Some(Precondition {
        server_epoch: Some("previous-epoch".into()),
        connection_generation: None,
    });
    assert_eq!(
        state.admit(&stale, &config).unwrap_err().code,
        ErrorCode::StaleSession
    );
    assert_eq!(
        state
            .admit(&request("overflow", "host.status"), &config)
            .unwrap_err()
            .code,
        ErrorCode::RequestLimit
    );
    assert_eq!(state.seen.len(), 3);
}

fn queue(
    capacity: usize,
) -> (
    OutboundQueue,
    mpsc::Receiver<Vec<u8>>,
    watch::Receiver<Option<WireError>>,
) {
    let (sender, receiver) = mpsc::channel(capacity);
    let (failure, failure_receiver) = watch::channel(None);
    (
        OutboundQueue {
            sender,
            failure,
            limit: 4096,
        },
        receiver,
        failure_receiver,
    )
}

#[tokio::test]
async fn independent_bounded_queues_report_slow_clients_explicitly() {
    let (slow, receiver, failure) = queue(1);
    let (healthy, _healthy_receiver, _) = queue(1);
    let response = Response::ok("epoch-1", "r".into(), Value::Null);
    slow.try_send(&response).unwrap();
    assert_eq!(
        slow.try_send(&response).unwrap_err().code,
        ErrorCode::SlowClient
    );
    assert_eq!(
        slow.try_send(&response).unwrap_err().code,
        ErrorCode::SlowClient
    );
    healthy.try_send(&response).unwrap();
    let (writer, reader) = duplex(4096);
    let error = write_responses(writer, receiver, failure, &config())
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::SlowClient);
    let mut reader = FrameReader::new(reader, 4096).unwrap();
    let line = reader.read_frame().await.unwrap().unwrap();
    assert_error(
        &decode_response(&line, 4096).unwrap(),
        ErrorCode::SlowClient,
        None,
    );
    assert!(reader.read_frame().await.unwrap().is_none());
}

#[tokio::test]
async fn blocked_write_has_a_deadline_not_an_unbounded_wait() {
    let (mut writer, mut reader) = duplex(1);
    let error = write_with_deadline(
        &mut writer,
        b"longer than buffer\n",
        Duration::from_millis(10),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::SlowClient);
    drop(writer);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).await.unwrap();
    assert_eq!(bytes, b"l"); // No terminal error was appended to a partial frame.
}

#[derive(Default)]
struct RecordingHandler {
    calls: Mutex<Vec<Request>>,
    disconnects: Mutex<Vec<(ConnectionContext, Option<WireError>)>>,
    changed: Notify,
}

impl RequestHandler for RecordingHandler {
    fn handle(&self, _connection: ConnectionContext, request: Request) -> HandlerFuture<'_> {
        Box::pin(async move {
            self.calls.lock().unwrap().push(request.clone());
            if request.params == json!({"fail": true}) {
                Err(WireError::new(ErrorCode::PortBusy, "port is busy"))
            } else if request.params == json!({"large": true}) {
                Ok(json!("x".repeat(100_000)))
            } else {
                Ok(json!({"method": request.method, "params": request.params}))
            }
        })
    }

    fn disconnected(&self, connection: ConnectionContext, reason: Option<WireError>) {
        self.disconnects.lock().unwrap().push((connection, reason));
        self.changed.notify_one();
    }
}

struct Client {
    write: tokio::net::tcp::OwnedWriteHalf,
    read: FrameReader<tokio::net::tcp::OwnedReadHalf>,
}

impl Client {
    async fn connect(address: SocketAddr) -> Self {
        let (read, write) = TcpStream::connect(address).await.unwrap().into_split();
        Self {
            write,
            read: FrameReader::new(read, DEFAULT_MAX_FRAME_BYTES).unwrap(),
        }
    }

    async fn send(&mut self, request: &Request) {
        self.write
            .write_all(&encode_request(request, DEFAULT_MAX_FRAME_BYTES).unwrap())
            .await
            .unwrap();
    }

    async fn response(&mut self) -> Response {
        let line = timeout(Duration::from_secs(2), self.read.read_frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        decode_response(&line, DEFAULT_MAX_FRAME_BYTES).unwrap()
    }

    async fn handshake(&mut self) {
        self.send(&request("handshake-id", "handshake")).await;
        let response = self.response().await;
        match response {
            Response::Ok { result, .. } => {
                let handshake: Handshake = serde_json::from_value(result).unwrap();
                assert_eq!(handshake.protocol_version, PROTOCOL_VERSION);
                assert_eq!(handshake.server_epoch, "epoch-1");
                assert_eq!(handshake.capabilities, config().capabilities);
            }
            other => panic!("unexpected handshake: {other:?}"),
        }
    }
}

#[tokio::test]
async fn listener_is_loopback_only_and_handles_pipelined_requests_and_errors() {
    let handler = Arc::new(RecordingHandler::default());
    let mut settings = config();
    settings.write_queue_capacity = 1;
    let listener = LoopbackListener::bind(0, settings, handler.clone())
        .await
        .unwrap();
    assert_eq!(listener.local_addr().ip(), Ipv4Addr::LOCALHOST);
    let address = listener.local_addr();
    let mut client = Client::connect(address).await;
    client.handshake().await;
    let mut burst = Vec::new();
    for number in 0..10 {
        burst.extend(encode_request(&request(&format!("r{number}"), "host.status"), 4096).unwrap());
    }
    client.write.write_all(&burst).await.unwrap();
    for number in 0..10 {
        let response = client.response().await;
        assert!(matches!(response, Response::Ok { .. }));
        assert_eq!(response.request_id(), Some(format!("r{number}").as_str()));
    }
    let mut failing = request("failing", "serial.send");
    failing.params = json!({"fail": true});
    client.send(&failing).await;
    assert_error(
        &client.response().await,
        ErrorCode::PortBusy,
        Some("failing"),
    );
    assert_eq!(handler.calls.lock().unwrap().len(), 11);
    listener.shutdown().await.unwrap();
    assert_eq!(handler.disconnects.lock().unwrap().len(), 1);
    assert_eq!(
        handler.disconnects.lock().unwrap()[0]
            .1
            .as_ref()
            .unwrap()
            .code,
        ErrorCode::ShuttingDown
    );
    // Explicit shutdown joins tasks and releases the listening socket.
    let rebound = LoopbackListener::bind(address.port(), config(), handler)
        .await
        .unwrap();
    rebound.shutdown().await.unwrap();
}

#[tokio::test]
async fn listener_rejects_missing_handshake_and_unknown_versions_without_dispatch() {
    let handler = Arc::new(RecordingHandler::default());
    let listener = LoopbackListener::bind(0, config(), handler.clone())
        .await
        .unwrap();
    let mut no_handshake = Client::connect(listener.local_addr()).await;
    no_handshake.send(&request("before", "host.status")).await;
    assert_error(
        &no_handshake.response().await,
        ErrorCode::HandshakeRequired,
        Some("before"),
    );
    assert!(no_handshake.read.read_frame().await.unwrap().is_none());
    let mut wrong_version = Client::connect(listener.local_addr()).await;
    wrong_version
        .write
        .write_all(b"{\"protocolVersion\":2,\"requestId\":\"v2\",\"method\":\"handshake\"}\n")
        .await
        .unwrap();
    assert_error(
        &wrong_version.response().await,
        ErrorCode::UnsupportedVersion,
        Some("v2"),
    );
    assert!(wrong_version.read.read_frame().await.unwrap().is_none());
    assert!(handler.calls.lock().unwrap().is_empty());
    listener.shutdown().await.unwrap();
}

#[tokio::test]
async fn duplicate_request_ids_and_unadvertised_methods_never_dispatch() {
    let handler = Arc::new(RecordingHandler::default());
    let listener = LoopbackListener::bind(0, config(), handler.clone())
        .await
        .unwrap();
    let mut client = Client::connect(listener.local_addr()).await;
    client.handshake().await;
    client.send(&request("once", "host.status")).await;
    assert!(matches!(client.response().await, Response::Ok { .. }));
    client.send(&request("once", "serial.send")).await;
    assert_error(
        &client.response().await,
        ErrorCode::RequestIdConflict,
        Some("once"),
    );
    client.send(&request("invoke", "invoke")).await;
    assert_error(
        &client.response().await,
        ErrorCode::UnsupportedCapability,
        Some("invoke"),
    );
    let mut stale = request("stale", "host.status");
    stale.precondition = Some(Precondition {
        server_epoch: Some("old-epoch".into()),
        connection_generation: None,
    });
    client.send(&stale).await;
    assert_error(
        &client.response().await,
        ErrorCode::StaleSession,
        Some("stale"),
    );
    assert_eq!(handler.calls.lock().unwrap().len(), 1);
    listener.shutdown().await.unwrap();
}

#[tokio::test]
async fn invalid_and_oversized_tcp_frames_return_structured_terminal_errors() {
    let handler = Arc::new(RecordingHandler::default());
    let listener = LoopbackListener::bind(0, config(), handler.clone())
        .await
        .unwrap();
    let mut invalid = Client::connect(listener.local_addr()).await;
    invalid.write.write_all(b"not JSON\n").await.unwrap();
    assert_error(&invalid.response().await, ErrorCode::InvalidJson, None);
    assert!(invalid.read.read_frame().await.unwrap().is_none());
    let mut oversized = Client::connect(listener.local_addr()).await;
    oversized
        .write
        .write_all(&vec![b'x'; DEFAULT_MAX_FRAME_BYTES + 1])
        .await
        .unwrap();
    assert_error(&oversized.response().await, ErrorCode::FrameTooLarge, None);
    assert!(handler.calls.lock().unwrap().is_empty());
    listener.shutdown().await.unwrap();
}

#[tokio::test]
async fn oversized_handler_result_is_a_correlated_error_and_connection_survives() {
    let handler = Arc::new(RecordingHandler::default());
    let listener = LoopbackListener::bind(0, config(), handler).await.unwrap();
    let mut client = Client::connect(listener.local_addr()).await;
    client.handshake().await;
    client
        .send(&Request::new(
            "large",
            "host.status",
            json!({"large": true}),
        ))
        .await;
    assert_error(
        &client.response().await,
        ErrorCode::FrameTooLarge,
        Some("large"),
    );
    client.send(&request("next", "host.status")).await;
    assert!(matches!(client.response().await, Response::Ok { .. }));
    listener.shutdown().await.unwrap();
}

#[tokio::test]
async fn idle_partial_handshake_does_not_block_other_connections() {
    let handler = Arc::new(RecordingHandler::default());
    let mut settings = config();
    settings.handshake_timeout = Duration::from_millis(100);
    let listener = LoopbackListener::bind(0, settings, handler.clone())
        .await
        .unwrap();
    let mut idle = Client::connect(listener.local_addr()).await;
    idle.write.write_all(b"{").await.unwrap();
    let mut healthy = Client::connect(listener.local_addr()).await;
    healthy.handshake().await;
    healthy.send(&request("healthy", "host.status")).await;
    assert!(matches!(healthy.response().await, Response::Ok { .. }));
    assert_error(&idle.response().await, ErrorCode::HandshakeTimeout, None);
    assert_eq!(handler.calls.lock().unwrap().len(), 1);
    listener.shutdown().await.unwrap();
}

#[tokio::test]
async fn dropping_listener_requests_shutdown_and_runs_disconnect_hook() {
    let handler = Arc::new(RecordingHandler::default());
    let listener = LoopbackListener::bind(0, config(), handler.clone())
        .await
        .unwrap();
    let mut client = Client::connect(listener.local_addr()).await;
    client.handshake().await;
    drop(listener);
    timeout(Duration::from_secs(2), handler.changed.notified())
        .await
        .unwrap();
    assert_eq!(handler.disconnects.lock().unwrap().len(), 1);
    assert_eq!(
        handler.disconnects.lock().unwrap()[0]
            .1
            .as_ref()
            .unwrap()
            .code,
        ErrorCode::ShuttingDown
    );
    assert!(client.read.read_frame().await.unwrap().is_none());
}

#[derive(Default)]
struct BlockingHandler {
    started: Notify,
    disconnected: Notify,
    dropped: AtomicBool,
    calls: Mutex<Vec<String>>,
    disconnects: Mutex<Vec<(Option<ErrorCode>, bool)>>,
}

struct MarkDropped<'a>(&'a AtomicBool);

impl Drop for MarkDropped<'_> {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

impl RequestHandler for BlockingHandler {
    fn handle(&self, _connection: ConnectionContext, request: Request) -> HandlerFuture<'_> {
        Box::pin(async move {
            let _mark_dropped = MarkDropped(&self.dropped);
            self.calls.lock().unwrap().push(request.request_id);
            self.started.notify_one();
            std::future::pending().await
        })
    }

    fn disconnected(&self, _connection: ConnectionContext, reason: Option<WireError>) {
        self.disconnects.lock().unwrap().push((
            reason.map(|error| error.code),
            self.dropped.load(Ordering::SeqCst),
        ));
        self.disconnected.notify_one();
    }
}

impl BlockingHandler {
    async fn wait_for_disconnect(&self) {
        timeout(Duration::from_secs(2), self.disconnected.notified())
            .await
            .unwrap();
    }

    fn assert_disconnected_once(&self, reason: Option<ErrorCode>) {
        assert_eq!(&*self.disconnects.lock().unwrap(), &[(reason, true)]);
        assert_eq!(&*self.calls.lock().unwrap(), &["pending".to_owned()]);
    }
}

async fn blocking_connection() -> (Arc<BlockingHandler>, LoopbackListener, Client) {
    let handler = Arc::new(BlockingHandler::default());
    let listener = LoopbackListener::bind(0, config(), handler.clone())
        .await
        .unwrap();
    let mut client = Client::connect(listener.local_addr()).await;
    client.handshake().await;
    client.send(&request("pending", "host.status")).await;
    timeout(Duration::from_secs(2), handler.started.notified())
        .await
        .unwrap();
    (handler, listener, client)
}

#[tokio::test]
async fn shutdown_cancels_pending_handler_futures_and_joins_connections() {
    let (handler, listener, _client) = blocking_connection().await;
    timeout(Duration::from_secs(2), listener.shutdown())
        .await
        .unwrap()
        .unwrap();
    handler.assert_disconnected_once(Some(ErrorCode::ShuttingDown));
}

#[tokio::test]
async fn peer_disconnect_cancels_pending_handler_without_listener_shutdown() {
    let (handler, listener, client) = blocking_connection().await;
    drop(client);
    handler.wait_for_disconnect().await;
    listener.shutdown().await.unwrap();
    handler.assert_disconnected_once(None);
}

#[tokio::test]
async fn tcp_half_close_also_cancels_pending_and_queued_requests() {
    let (handler, listener, mut client) = blocking_connection().await;
    client.send(&request("queued", "host.status")).await;
    client.write.shutdown().await.unwrap();
    handler.wait_for_disconnect().await;
    assert!(timeout(Duration::from_secs(2), client.read.read_frame())
        .await
        .unwrap()
        .unwrap()
        .is_none());
    listener.shutdown().await.unwrap();
    handler.assert_disconnected_once(None);
}

#[tokio::test]
async fn partial_frame_at_eof_cancels_handler_and_returns_structured_error() {
    let (handler, listener, mut client) = blocking_connection().await;
    client.write.write_all(b"{").await.unwrap();
    client.write.shutdown().await.unwrap();
    handler.wait_for_disconnect().await;
    assert_error(&client.response().await, ErrorCode::IncompleteFrame, None);
    listener.shutdown().await.unwrap();
    handler.assert_disconnected_once(Some(ErrorCode::IncompleteFrame));
}

#[tokio::test]
async fn pending_handler_does_not_allow_unbounded_request_intake() {
    let (handler, listener, mut client) = blocking_connection().await;
    let mut burst = Vec::new();
    for number in 0..=REQUEST_QUEUE_CAPACITY {
        burst.extend(encode_request(&request(&format!("q{number}"), "host.status"), 4096).unwrap());
    }
    client.write.write_all(&burst).await.unwrap();
    handler.wait_for_disconnect().await;
    assert_error(&client.response().await, ErrorCode::RequestLimit, None);
    listener.shutdown().await.unwrap();
    handler.assert_disconnected_once(Some(ErrorCode::RequestLimit));
}

#[tokio::test]
async fn eof_releases_handler_before_stalled_output_drain_and_shutdown_interrupts_it() {
    let handler = Arc::new(BlockingHandler::default());
    let (mut client_input, input) = duplex(4096);
    let (output, _unread_output) = duplex(1);
    let (stop, stopped) = watch::channel(false);
    let task = tokio::spawn({
        let handler = handler.clone();
        async move {
            let connection = ConnectionContext {
                connection_id: 1,
                peer_addr: SocketAddrV4::new(Ipv4Addr::LOCALHOST, 1).into(),
            };
            let mut settings = config();
            settings.write_timeout = Duration::from_secs(30);
            serve_connection(
                input,
                output,
                connection,
                &settings,
                handler.as_ref(),
                stopped,
            )
            .await;
        }
    });
    for request in [
        request("h", HANDSHAKE_METHOD),
        request("pending", "host.status"),
    ] {
        client_input
            .write_all(&encode_request(&request, 4096).unwrap())
            .await
            .unwrap();
    }
    timeout(Duration::from_secs(2), handler.started.notified())
        .await
        .unwrap();
    client_input.shutdown().await.unwrap();
    handler.wait_for_disconnect().await;
    handler.assert_disconnected_once(None);
    assert!(!task.is_finished()); // The handshake response cannot fit in the output buffer.
    stop.send_replace(true);
    timeout(Duration::from_secs(2), task)
        .await
        .unwrap()
        .unwrap();
    handler.assert_disconnected_once(None);
}

#[test]
fn invalid_listener_limits_and_capabilities_fail_before_binding() {
    let mut settings = config();
    settings.write_queue_capacity = 0;
    assert_eq!(
        settings.validate().unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    let mut settings = config();
    settings.capabilities.push("handshake".into());
    assert_eq!(
        settings.validate().unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    let mut settings = config();
    settings.capabilities.push("host.status".into());
    assert_eq!(
        settings.validate().unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    let mut settings = config();
    settings.max_frame_bytes = MAX_FRAME_BYTES + 1;
    assert_eq!(
        settings.validate().unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    let mut settings = config();
    settings.handshake_timeout = Duration::MAX;
    assert_eq!(
        settings.validate().unwrap_err().code,
        ErrorCode::InvalidArgument
    );
    let mut settings = config();
    settings.write_timeout = Duration::MAX;
    assert_eq!(
        settings.validate().unwrap_err().code,
        ErrorCode::InvalidArgument
    );
}
