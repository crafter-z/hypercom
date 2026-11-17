#![allow(dead_code)]

//! Versioned, bounded JSON-lines transport for an explicitly enabled local service.
//!
//! This module has no Tauri, serial-driver or domain-core dependency. It does not
//! authenticate callers: loopback is a network boundary, NOT an authorization
//! boundary. The embedding host must opt in, establish its own authorization and
//! implement only the advertised domain methods (never a generic invoke bridge).
//!
//! The first request is `handshake`. Every response carries the protocol version,
//! server epoch and request id. A request id may be used only once per connection;
//! the bounded connection ledger is NOT cross-session operation deduplication.
//! Domain handlers still own generation/lease/fence checks, deadlines, persistent
//! operation identity and reconciliation of cancelled/unknown side effects.
//!
//! Frames are compact JSON followed by LF; an optional CR before LF counts toward
//! the byte limit. EOF with a partial frame is an error. No read allocates an
//! unbounded line, and serialization stops at the same limit. Each connection has
//! its own bounded write queue and write deadline. Queue overflow reports
//! `SLOW_CLIENT`, then closes: a terminal wire error is best effort, because a
//! client that never reads cannot be guaranteed to receive one. The disconnect
//! hook always receives the explicit reason. Other connections are unaffected.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::future::Future;
use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{timeout, timeout_at, Instant};

pub const PROTOCOL_VERSION: u32 = 1;
pub const HANDSHAKE_METHOD: &str = "handshake";
pub const DEFAULT_MAX_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const DEFAULT_WRITE_QUEUE_CAPACITY: usize = 32;
const MAX_ID_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub host_id: String,
    pub native_port_id: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Precondition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_epoch: Option<String>,
    /// Canonical decimal string on output; safe JSON integer input is accepted.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "optional_decimal_u64"
    )]
    pub connection_generation: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Control {
    pub lease_id: String,
    /// Canonical decimal string on output; safe JSON integer input is accepted.
    #[serde(with = "decimal_u64")]
    pub fence: u64,
}

// Rust keeps counters as u64, but the wire must not round a fence/generation in
// JavaScript. Inbound numbers are accepted only in the JS safe integer range;
// decimal strings cover the complete u64 range without changing identity.
mod decimal_u64 {
    use serde::{de, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        struct CounterVisitor;
        impl de::Visitor<'_> for CounterVisitor {
            type Value = u64;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a canonical unsigned decimal string or safe JSON integer")
            }

            fn visit_u64<E: de::Error>(self, value: u64) -> Result<u64, E> {
                if value > 9_007_199_254_740_991 {
                    return Err(E::custom(
                        "counter numbers must be JS-safe; use a decimal string",
                    ));
                }
                Ok(value)
            }

            fn visit_str<E: de::Error>(self, value: &str) -> Result<u64, E> {
                if value.is_empty()
                    || value.len() > 20
                    || !value.bytes().all(|byte| byte.is_ascii_digit())
                    || (value.len() > 1 && value.starts_with('0'))
                {
                    return Err(E::custom(
                        "counter must be a canonical unsigned decimal string",
                    ));
                }
                value.parse().map_err(E::custom)
            }
        }
        deserializer.deserialize_any(CounterVisitor)
    }
}

mod optional_decimal_u64 {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer>(value: &Option<u64>, serializer: S) -> Result<S::Ok, S::Error> {
        value.map(|value| value.to_string()).serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<u64>, D::Error> {
        #[derive(Deserialize)]
        struct Counter(#[serde(with = "super::decimal_u64")] u64);
        Ok(Option::<Counter>::deserialize(deserializer)?.map(|counter| counter.0))
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub protocol_version: u32,
    pub request_id: String,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precondition: Option<Precondition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control: Option<Control>,
    /// Passed to the domain handler; the transport never pretends that dropping
    /// a timed-out future proves a physical operation did not happen.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default)]
    pub params: Value,
}

impl Request {
    pub fn new(request_id: impl Into<String>, method: impl Into<String>, params: Value) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id: request_id.into(),
            method: method.into(),
            target: None,
            precondition: None,
            control: None,
            timeout_ms: None,
            params,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    InvalidJson,
    InvalidArgument,
    UnsupportedVersion,
    FrameTooLarge,
    IncompleteFrame,
    HandshakeRequired,
    HandshakeTimeout,
    RequestIdConflict,
    RequestLimit,
    UnsupportedCapability,
    StaleSession,
    Unauthenticated,
    PermissionDenied,
    HostUnavailable,
    PortNotFound,
    PortBusy,
    ControlLost,
    DeadlineExceeded,
    Cancelled,
    IoError,
    OutcomeUnknown,
    CursorExpired,
    StreamGap,
    ConfigConflict,
    SlowClient,
    ConnectionClosed,
    ShuttingDown,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WireError {
    pub code: ErrorCode,
    pub message: String,
    /// Never implies that a physical side effect may safely be replayed.
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl WireError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            stage: Some("transport".into()),
            operation_id: None,
            details: None,
        }
    }
}

impl std::fmt::Display for WireError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for WireError {}

/// The tagged shape makes success/error mutually exclusive, including when
/// decoding untrusted responses. Error responses may have a null request id if
/// framing or envelope decoding failed before a valid id could be established.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Response {
    Ok {
        protocol_version: u32,
        server_epoch: String,
        request_id: String,
        result: Value,
    },
    Error {
        protocol_version: u32,
        server_epoch: String,
        request_id: Option<String>,
        error: WireError,
    },
}

impl Response {
    pub fn ok(server_epoch: &str, request_id: String, result: Value) -> Self {
        Self::Ok {
            protocol_version: PROTOCOL_VERSION,
            server_epoch: server_epoch.into(),
            request_id,
            result,
        }
    }

    pub fn error(server_epoch: &str, request_id: Option<String>, error: WireError) -> Self {
        Self::Error {
            protocol_version: PROTOCOL_VERSION,
            server_epoch: server_epoch.into(),
            request_id,
            error,
        }
    }

    pub fn request_id(&self) -> Option<&str> {
        match self {
            Self::Ok { request_id, .. } => Some(request_id),
            Self::Error { request_id, .. } => request_id.as_deref(),
        }
    }

    pub fn server_epoch(&self) -> &str {
        match self {
            Self::Ok { server_epoch, .. } | Self::Error { server_epoch, .. } => server_epoch,
        }
    }

    pub fn protocol_version(&self) -> u32 {
        match self {
            Self::Ok {
                protocol_version, ..
            }
            | Self::Error {
                protocol_version, ..
            } => *protocol_version,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Handshake {
    pub protocol_version: u32,
    pub server_epoch: String,
    /// Exact domain-method allowlist; `handshake` itself is reserved and implicit.
    pub capabilities: Vec<String>,
    pub max_frame_bytes: usize,
    pub write_queue_capacity: usize,
    /// IDs are retained until disconnect; reconnect before exceeding this bound.
    pub max_requests_per_connection: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RequestDecodeError {
    pub request_id: Option<String>,
    pub error: WireError,
}

impl std::fmt::Display for RequestDecodeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.error.fmt(formatter)
    }
}

impl std::error::Error for RequestDecodeError {}

#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    #[error(transparent)]
    Protocol(#[from] WireError),
    #[error(transparent)]
    Io(#[from] io::Error),
    #[error(transparent)]
    Task(#[from] tokio::task::JoinError),
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && !value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
}

fn valid_method(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || b"._-".contains(&ch))
}

fn invalid_argument(message: &str) -> WireError {
    WireError::new(ErrorCode::InvalidArgument, message)
}

fn check_limit(limit: usize) -> Result<(), WireError> {
    if limit == 0 || limit > MAX_FRAME_BYTES {
        return Err(invalid_argument(
            "frame limit must be between 1 and 1048576 bytes",
        ));
    }
    Ok(())
}

fn check_frame(frame: &[u8], limit: usize) -> Result<(), WireError> {
    check_limit(limit)?;
    if frame.len() > limit {
        return Err(WireError::new(
            ErrorCode::FrameTooLarge,
            "frame exceeds byte limit",
        ));
    }
    if frame.is_empty() || frame.contains(&b'\n') {
        return Err(WireError::new(
            ErrorCode::InvalidJson,
            "expected one nonempty JSON frame without LF",
        ));
    }
    Ok(())
}

fn validate_request(request: &Request) -> Result<(), WireError> {
    if request.protocol_version != PROTOCOL_VERSION {
        return Err(WireError::new(
            ErrorCode::UnsupportedVersion,
            "unsupported protocol version",
        ));
    }
    if !valid_id(&request.request_id) || !valid_method(&request.method) {
        return Err(invalid_argument("invalid requestId or method"));
    }
    if let Some(target) = &request.target {
        if !valid_id(&target.host_id)
            || target.native_port_id.is_empty()
            || target.native_port_id.len() > 1024
            || target.native_port_id.chars().any(char::is_control)
        {
            return Err(invalid_argument("invalid target"));
        }
    }
    if request
        .precondition
        .as_ref()
        .and_then(|value| value.server_epoch.as_deref())
        .is_some_and(|epoch| !valid_id(epoch))
    {
        return Err(invalid_argument("invalid precondition.serverEpoch"));
    }
    if request
        .control
        .as_ref()
        .is_some_and(|value| !valid_id(&value.lease_id))
    {
        return Err(invalid_argument("invalid control.leaseId"));
    }
    Ok(())
}

/// Decode a payload without its LF delimiter. Strict serde envelopes reject
/// unknown and duplicate fields, non-UTF-8 input and excessive JSON nesting.
// The correlated decode error intentionally keeps the full WireError inline so
// callers can return one bounded response without an allocation round-trip.
#[allow(clippy::result_large_err)]
pub fn decode_request(frame: &[u8], limit: usize) -> Result<Request, RequestDecodeError> {
    let uncorrelated = |error| RequestDecodeError {
        request_id: None,
        error,
    };
    check_frame(frame, limit).map_err(uncorrelated)?;
    let request: Request = serde_json::from_slice(frame).map_err(|_| {
        uncorrelated(WireError::new(
            ErrorCode::InvalidJson,
            "invalid request JSON or envelope",
        ))
    })?;
    validate_request(&request).map_err(|error| RequestDecodeError {
        request_id: valid_id(&request.request_id).then(|| request.request_id.clone()),
        error,
    })?;
    Ok(request)
}

pub fn decode_response(frame: &[u8], limit: usize) -> Result<Response, WireError> {
    check_frame(frame, limit)?;
    let response: Response = serde_json::from_slice(frame)
        .map_err(|_| WireError::new(ErrorCode::InvalidJson, "invalid response JSON or envelope"))?;
    validate_response(&response)?;
    Ok(response)
}

fn validate_response(response: &Response) -> Result<(), WireError> {
    if response.protocol_version() != PROTOCOL_VERSION {
        return Err(WireError::new(
            ErrorCode::UnsupportedVersion,
            "unsupported protocol version",
        ));
    }
    if !valid_id(response.server_epoch()) || response.request_id().is_some_and(|id| !valid_id(id)) {
        return Err(invalid_argument("invalid response identity"));
    }
    Ok(())
}

struct LimitedBuffer {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}

impl io::Write for LimitedBuffer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(io::Error::other("frame exceeds byte limit"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Compact serialization plus LF. Allocation is bounded even for an oversized
/// value; checking the size only after `serde_json::to_vec` would not be enough.
pub fn encode_json_line<T: Serialize + ?Sized>(
    value: &T,
    limit: usize,
) -> Result<Vec<u8>, WireError> {
    check_limit(limit)?;
    let mut output = LimitedBuffer {
        bytes: Vec::new(),
        limit,
        exceeded: false,
    };
    if serde_json::to_writer(&mut output, value).is_err() {
        return Err(if output.exceeded {
            WireError::new(ErrorCode::FrameTooLarge, "frame exceeds byte limit")
        } else {
            WireError::new(ErrorCode::InvalidJson, "value could not be serialized")
        });
    }
    output.bytes.push(b'\n');
    Ok(output.bytes)
}

pub fn encode_request(request: &Request, limit: usize) -> Result<Vec<u8>, WireError> {
    validate_request(request)?;
    encode_json_line(request, limit)
}

pub fn encode_response(response: &Response, limit: usize) -> Result<Vec<u8>, WireError> {
    validate_response(response)?;
    encode_json_line(response, limit)
}

/// Reusable buffered framing over any async reader, including TCP and test
/// duplex streams. Cancellation is safe: partial bytes live in `self`, not in
/// the future. After a framing/I/O failure the reader is terminal, not reusable.
pub struct FrameReader<R> {
    reader: BufReader<R>,
    pending: Vec<u8>,
    limit: usize,
    failed: bool,
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    pub fn new(reader: R, limit: usize) -> Result<Self, WireError> {
        check_limit(limit)?;
        Ok(Self {
            reader: BufReader::with_capacity((limit + 1).min(8192), reader),
            pending: Vec::new(),
            limit,
            failed: false,
        })
    }

    pub async fn read_frame(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        if self.failed {
            return Err(
                WireError::new(ErrorCode::ConnectionClosed, "frame reader is terminal").into(),
            );
        }
        loop {
            let bytes = match self.reader.fill_buf().await {
                Ok(bytes) => bytes,
                Err(error) => {
                    self.failed = true;
                    return Err(error.into());
                }
            };
            if bytes.is_empty() {
                if self.pending.is_empty() {
                    return Ok(None);
                }
                self.failed = true;
                return Err(WireError::new(
                    ErrorCode::IncompleteFrame,
                    "EOF before frame delimiter",
                )
                .into());
            }
            let newline = bytes.iter().position(|byte| *byte == b'\n');
            let count = newline.unwrap_or(bytes.len());
            if count > self.limit.saturating_sub(self.pending.len()) {
                self.failed = true;
                return Err(
                    WireError::new(ErrorCode::FrameTooLarge, "frame exceeds byte limit").into(),
                );
            }
            self.pending.extend_from_slice(&bytes[..count]);
            self.reader.consume(count + usize::from(newline.is_some()));
            if newline.is_some() {
                return Ok(Some(std::mem::take(&mut self.pending)));
            }
        }
    }
}

/// Write exactly one bounded JSON line. The caller owns timeout/cancellation
/// policy; cancelling a partial write requires closing that transport, never
/// appending a new frame onto the unfinished one.
pub async fn write_json_line<W: AsyncWrite + Unpin, T: Serialize + ?Sized>(
    writer: &mut W,
    value: &T,
    limit: usize,
) -> Result<(), TransportError> {
    let bytes = encode_json_line(value, limit)?;
    writer.write_all(&bytes).await?;
    Ok(())
}

#[derive(Debug, Clone)]
pub struct ListenerConfig {
    /// Must change on each service start; supplied by the authoritative host.
    pub server_epoch: String,
    /// Exact dispatch allowlist. Empty is safe (handshake only).
    pub capabilities: Vec<String>,
    pub max_frame_bytes: usize,
    pub write_queue_capacity: usize,
    pub max_connections: usize,
    pub max_requests_per_connection: usize,
    pub handshake_timeout: Duration,
    pub write_timeout: Duration,
}

impl ListenerConfig {
    pub fn new(server_epoch: impl Into<String>, capabilities: Vec<String>) -> Self {
        Self {
            server_epoch: server_epoch.into(),
            capabilities,
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            write_queue_capacity: DEFAULT_WRITE_QUEUE_CAPACITY,
            max_connections: 32,
            max_requests_per_connection: 4096,
            handshake_timeout: Duration::from_secs(5),
            write_timeout: Duration::from_secs(5),
        }
    }

    pub fn handshake(&self) -> Handshake {
        Handshake {
            protocol_version: PROTOCOL_VERSION,
            server_epoch: self.server_epoch.clone(),
            capabilities: self.capabilities.clone(),
            max_frame_bytes: self.max_frame_bytes,
            write_queue_capacity: self.write_queue_capacity,
            max_requests_per_connection: self.max_requests_per_connection,
        }
    }

    fn validate(&self) -> Result<(), WireError> {
        check_limit(self.max_frame_bytes)?;
        if !valid_id(&self.server_epoch)
            || self.max_frame_bytes < 512
            || self.write_queue_capacity == 0
            || self.write_queue_capacity > 4096
            || self.max_connections == 0
            || self.max_connections > 1024
            || self.max_requests_per_connection == 0
            || self.max_requests_per_connection > 65536
            || self.handshake_timeout.is_zero()
            || self.write_timeout.is_zero()
            || Instant::now().checked_add(self.handshake_timeout).is_none()
            || Instant::now().checked_add(self.write_timeout).is_none()
        {
            return Err(invalid_argument("invalid listener limits or server epoch"));
        }
        let mut methods = HashSet::new();
        for method in &self.capabilities {
            if !valid_method(method) || method == HANDSHAKE_METHOD || !methods.insert(method) {
                return Err(invalid_argument(
                    "capabilities must be unique, non-reserved method names",
                ));
            }
        }
        // The longest valid request id must still leave room for the handshake.
        let result = serde_json::to_value(self.handshake())
            .map_err(|_| invalid_argument("invalid handshake"))?;
        encode_response(
            &Response::ok(&self.server_epoch, "x".repeat(MAX_ID_BYTES), result),
            self.max_frame_bytes,
        )?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConnectionContext {
    /// Unique within this listener lifetime, not an authenticated principal.
    pub connection_id: u64,
    pub peer_addr: SocketAddr,
}

pub type HandlerFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, WireError>> + Send + 'a>>;

pub trait RequestHandler: Send + Sync + 'static {
    /// Called sequentially per connection, concurrently across connections, only
    /// after handshake/version/allowlist/optional epoch validation. The adapter
    /// MUST validate target, authorization, generation and control at execution.
    /// Shutdown can drop this future: started physical work must be owned and
    /// reconciled by the domain, not assumed cancelled by future cancellation.
    fn handle(&self, connection: ConnectionContext, request: Request) -> HandlerFuture<'_>;

    /// Always called once when an accepted connection ends, including shutdown.
    /// Must be nonblocking; a disconnect must not implicitly close a serial port.
    fn disconnected(&self, _connection: ConnectionContext, _reason: Option<WireError>) {}
}

/// Lifecycle owner. `shutdown().await` stops admission, cancels connection
/// futures, runs disconnect hooks and joins all tasks. Drop requests the same
/// shutdown, but cannot wait; use explicit shutdown for deterministic teardown.
pub struct LoopbackListener {
    local_addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    task: Option<JoinHandle<Result<(), TransportError>>>,
}

impl LoopbackListener {
    /// The API intentionally has no address argument: non-loopback/IPv6/public
    /// binding is impossible. Port zero requests an OS-assigned port.
    pub async fn bind(
        port: u16,
        config: ListenerConfig,
        handler: Arc<dyn RequestHandler>,
    ) -> Result<Self, TransportError> {
        config.validate()?;
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).await?;
        let local_addr = listener.local_addr()?;
        let (shutdown, receiver) = watch::channel(false);
        let task = tokio::spawn(serve(
            listener,
            Arc::new(config),
            handler,
            shutdown.clone(),
            receiver,
        ));
        Ok(Self {
            local_addr,
            shutdown,
            task: Some(task),
        })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn request_shutdown(&self) {
        self.shutdown.send_replace(true);
    }

    pub async fn shutdown(mut self) -> Result<(), TransportError> {
        self.request_shutdown();
        if let Some(task) = self.task.take() {
            task.await??;
        }
        Ok(())
    }
}

impl Drop for LoopbackListener {
    fn drop(&mut self) {
        self.request_shutdown();
    }
}

async fn stopping(receiver: &mut watch::Receiver<bool>) {
    loop {
        if *receiver.borrow_and_update() {
            return;
        }
        if receiver.changed().await.is_err() {
            return;
        }
    }
}

async fn serve(
    listener: TcpListener,
    config: Arc<ListenerConfig>,
    handler: Arc<dyn RequestHandler>,
    shutdown: watch::Sender<bool>,
    mut stopped: watch::Receiver<bool>,
) -> Result<(), TransportError> {
    let mut connections = JoinSet::new();
    let mut next_id = 0_u64;
    let mut outcome = loop {
        tokio::select! {
            biased;
            _ = stopping(&mut stopped) => break Ok(()),
            finished = connections.join_next(), if !connections.is_empty() => {
                if let Some(Err(error)) = finished { break Err(error.into()); }
            }
            // No detached rejection tasks: the OS backlog supplies the bounded
            // admission wait while all configured connection slots are occupied.
            accepted = listener.accept(), if connections.len() < config.max_connections => {
                let (stream, peer_addr) = match accepted {
                    Ok(accepted) => accepted,
                    Err(error) => break Err(error.into()),
                };
                next_id = match next_id.checked_add(1) {
                    Some(id) => id,
                    None => break Err(WireError::new(ErrorCode::Internal, "connection identity exhausted").into()),
                };
                let connection = ConnectionContext { connection_id: next_id, peer_addr };
                let config = Arc::clone(&config);
                let handler = Arc::clone(&handler);
                let stopped = stopped.clone();
                connections.spawn(async move {
                    let reason = serve_connection(stream, connection, &config, handler.as_ref(), stopped).await.err();
                    handler.disconnected(connection, reason);
                });
            }
        }
    };
    drop(listener);
    shutdown.send_replace(true);
    while let Some(finished) = connections.join_next().await {
        if let Err(error) = finished {
            if outcome.is_ok() {
                outcome = Err(error.into());
            }
        }
    }
    outcome
}

struct ProtocolSession {
    handshaken: bool,
    seen: HashSet<String>,
}

impl ProtocolSession {
    fn new() -> Self {
        Self {
            handshaken: false,
            seen: HashSet::new(),
        }
    }

    fn admit(&mut self, request: &Request, config: &ListenerConfig) -> Result<(), WireError> {
        if self.seen.contains(&request.request_id) {
            return Err(WireError::new(
                ErrorCode::RequestIdConflict,
                "requestId already used on this connection",
            ));
        }
        if self.seen.len() >= config.max_requests_per_connection {
            return Err(WireError::new(
                ErrorCode::RequestLimit,
                "connection request limit reached; reconnect with new ids",
            ));
        }
        self.seen.insert(request.request_id.clone());
        if request.method == HANDSHAKE_METHOD {
            if self.handshaken {
                return Err(invalid_argument("handshake already completed"));
            }
            self.handshaken = true;
            return Ok(());
        }
        if !self.handshaken {
            return Err(WireError::new(
                ErrorCode::HandshakeRequired,
                "first request must be handshake",
            ));
        }
        if request
            .precondition
            .as_ref()
            .and_then(|value| value.server_epoch.as_deref())
            .is_some_and(|epoch| epoch != config.server_epoch)
        {
            return Err(WireError::new(
                ErrorCode::StaleSession,
                "server epoch does not match",
            ));
        }
        if !config.capabilities.contains(&request.method) {
            return Err(WireError::new(
                ErrorCode::UnsupportedCapability,
                "method is not advertised by this listener",
            ));
        }
        Ok(())
    }
}

#[derive(Clone)]
struct OutboundQueue {
    sender: mpsc::Sender<Vec<u8>>,
    failure: watch::Sender<Option<WireError>>,
    limit: usize,
}

impl OutboundQueue {
    fn try_send(&self, response: &Response) -> Result<(), WireError> {
        if let Some(error) = self.failure.borrow().clone() {
            return Err(error);
        }
        let frame = encode_response(response, self.limit)?;
        self.sender.try_send(frame).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => {
                let error = WireError::new(ErrorCode::SlowClient, "connection write queue is full");
                self.failure.send_replace(Some(error.clone()));
                error
            }
            mpsc::error::TrySendError::Closed(_) => {
                WireError::new(ErrorCode::ConnectionClosed, "connection writer closed")
            }
        })
    }
}

async fn write_with_deadline<W: AsyncWrite + Unpin>(
    writer: &mut W,
    frame: &[u8],
    deadline: Duration,
) -> Result<(), WireError> {
    match timeout(deadline, writer.write_all(frame)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(WireError::new(
            ErrorCode::IoError,
            "connection write failed",
        )),
        Err(_) => Err(WireError::new(
            ErrorCode::SlowClient,
            "connection write deadline exceeded",
        )),
    }
}

async fn write_responses<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut receiver: mpsc::Receiver<Vec<u8>>,
    failure: watch::Receiver<Option<WireError>>,
    config: &ListenerConfig,
) -> Result<(), WireError> {
    loop {
        let terminal = failure.borrow().clone();
        if let Some(error) = terminal {
            // Never interrupt an in-progress frame to inject an error: doing so
            // could turn a partial success into malformed or misleading JSON.
            let response = Response::error(&config.server_epoch, None, error.clone());
            if let Ok(frame) = encode_response(&response, config.max_frame_bytes) {
                let _ = write_with_deadline(&mut writer, &frame, config.write_timeout).await;
            }
            return Err(error);
        }
        match receiver.recv().await {
            Some(frame) => write_with_deadline(&mut writer, &frame, config.write_timeout).await?,
            None => return Ok(()),
        }
    }
}

async fn read_requests<R: AsyncRead + Unpin>(
    mut reader: FrameReader<R>,
    outbound: OutboundQueue,
    config: &ListenerConfig,
    handler: &dyn RequestHandler,
    connection: ConnectionContext,
) -> Result<(), WireError> {
    let mut session = ProtocolSession::new();
    let handshake_deadline = Instant::now() + config.handshake_timeout;
    loop {
        let frame = if session.handshaken {
            reader.read_frame().await
        } else {
            match timeout_at(handshake_deadline, reader.read_frame()).await {
                Ok(result) => result,
                Err(_) => Err(WireError::new(
                    ErrorCode::HandshakeTimeout,
                    "handshake deadline exceeded",
                )
                .into()),
            }
        };
        let frame = match frame {
            Ok(Some(frame)) => frame,
            Ok(None) => return Ok(()),
            Err(error) => {
                let error = match error {
                    TransportError::Protocol(error) => error,
                    _ => WireError::new(ErrorCode::IoError, "connection read failed"),
                };
                outbound.try_send(&Response::error(&config.server_epoch, None, error.clone()))?;
                return Err(error);
            }
        };
        let request = match decode_request(&frame, config.max_frame_bytes) {
            Ok(request) => request,
            Err(failure) => {
                outbound.try_send(&Response::error(
                    &config.server_epoch,
                    failure.request_id,
                    failure.error.clone(),
                ))?;
                return Err(failure.error);
            }
        };
        let request_id = request.request_id.clone();
        let result = match session.admit(&request, config) {
            Err(error) => {
                let terminal = matches!(
                    error.code,
                    ErrorCode::HandshakeRequired | ErrorCode::RequestLimit
                );
                outbound.try_send(&Response::error(
                    &config.server_epoch,
                    Some(request_id),
                    error.clone(),
                ))?;
                if terminal {
                    return Err(error);
                }
                // Give this connection's writer a chance to run even when a
                // complete request burst is already buffered in memory.
                tokio::task::yield_now().await;
                continue;
            }
            Ok(()) if request.method == HANDSHAKE_METHOD => {
                serde_json::to_value(config.handshake()).map_err(|_| {
                    WireError::new(ErrorCode::Internal, "handshake serialization failed")
                })
            }
            Ok(()) => handler.handle(connection, request).await,
        };
        let response = match result {
            Ok(result) => Response::ok(&config.server_epoch, request_id.clone(), result),
            Err(error) => Response::error(&config.server_epoch, Some(request_id.clone()), error),
        };
        if let Err(error) = outbound.try_send(&response) {
            if error.code != ErrorCode::FrameTooLarge {
                return Err(error);
            }
            // An oversized handler result is an explicit correlated error, not
            // a missing response and not an unbounded queue allocation.
            outbound.try_send(&Response::error(
                &config.server_epoch,
                Some(request_id),
                error,
            ))?;
        }
        tokio::task::yield_now().await;
    }
}

async fn serve_connection(
    stream: TcpStream,
    connection: ConnectionContext,
    config: &ListenerConfig,
    handler: &dyn RequestHandler,
    mut stopped: watch::Receiver<bool>,
) -> Result<(), WireError> {
    let (read, write) = stream.into_split();
    let reader = FrameReader::new(read, config.max_frame_bytes)?;
    let (sender, receiver) = mpsc::channel(config.write_queue_capacity);
    let (failure, failure_receiver) = watch::channel(None);
    let outbound = OutboundQueue {
        sender,
        failure,
        limit: config.max_frame_bytes,
    };
    let writing = write_responses(write, receiver, failure_receiver, config);
    tokio::pin!(writing);
    let read_result = {
        let reading = read_requests(reader, outbound, config, handler, connection);
        tokio::pin!(reading);
        tokio::select! {
            biased;
            _ = stopping(&mut stopped) => return Err(WireError::new(ErrorCode::ShuttingDown, "listener is shutting down")),
            result = &mut writing => return result,
            result = &mut reading => result,
        }
    }; // Drop the only queue sender before draining. No detached writer task.
    tokio::select! {
        biased;
        _ = stopping(&mut stopped) => Err(WireError::new(ErrorCode::ShuttingDown, "listener is shutting down")),
        write_result = &mut writing => write_result.and(read_result),
    }
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;
