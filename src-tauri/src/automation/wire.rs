#![allow(dead_code)] // The listener and CLI each use a subset of this shared module.

//! Versioned JSON-lines DTOs and bounded framing shared by the host and CLI.
//! No listener, Tauri, serial-driver or domain-core dependency.
//! Frames are compact JSON followed by LF; an optional CR before LF counts toward
//! the payload byte limit. EOF with a partial frame is an error.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

pub const PROTOCOL_VERSION: u32 = 1;
pub const HANDSHAKE_METHOD: &str = "handshake";
pub const DEFAULT_MAX_FRAME_BYTES: usize = 64 * 1024;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub(super) const MAX_ID_BYTES: usize = 128;

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

// Keep serde's spelling and the allocation-free string accessor in one place.
macro_rules! error_codes {
    ($($variant:ident => $name:literal),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
        pub enum ErrorCode {
            $(#[serde(rename = $name)] $variant),+
        }

        impl ErrorCode {
            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $name),+
                }
            }
        }
    };
}

error_codes! {
    InvalidJson => "INVALID_JSON",
    InvalidArgument => "INVALID_ARGUMENT",
    UnsupportedVersion => "UNSUPPORTED_VERSION",
    FrameTooLarge => "FRAME_TOO_LARGE",
    IncompleteFrame => "INCOMPLETE_FRAME",
    HandshakeRequired => "HANDSHAKE_REQUIRED",
    HandshakeTimeout => "HANDSHAKE_TIMEOUT",
    RequestIdConflict => "REQUEST_ID_CONFLICT",
    RequestLimit => "REQUEST_LIMIT",
    UnsupportedCapability => "UNSUPPORTED_CAPABILITY",
    StaleSession => "STALE_SESSION",
    Unauthenticated => "UNAUTHENTICATED",
    PermissionDenied => "PERMISSION_DENIED",
    HostUnavailable => "HOST_UNAVAILABLE",
    PortNotFound => "PORT_NOT_FOUND",
    PortBusy => "PORT_BUSY",
    ControlLost => "CONTROL_LOST",
    DeadlineExceeded => "DEADLINE_EXCEEDED",
    Cancelled => "CANCELLED",
    IoError => "IO_ERROR",
    OutcomeUnknown => "OUTCOME_UNKNOWN",
    CursorExpired => "CURSOR_EXPIRED",
    StreamGap => "STREAM_GAP",
    ConfigConflict => "CONFIG_CONFLICT",
    SlowClient => "SLOW_CLIENT",
    ConnectionClosed => "CONNECTION_CLOSED",
    ShuttingDown => "SHUTTING_DOWN",
    Internal => "INTERNAL",
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

pub(super) fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && !value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
}

pub(super) fn valid_method(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || b"._-".contains(&ch))
}

pub(super) fn invalid_argument(message: &str) -> WireError {
    WireError::new(ErrorCode::InvalidArgument, message)
}

pub(super) fn check_limit(limit: usize) -> Result<(), WireError> {
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

    /// Change the payload limit in place without discarding buffered bytes.
    /// The next read applies it to the entire frame, including any partial data
    /// held after a cancelled read. An out-of-range limit leaves it unchanged.
    pub fn set_limit(&mut self, limit: usize) -> Result<(), WireError> {
        check_limit(limit)?;
        self.limit = limit;
        Ok(())
    }

    pub async fn read_frame(&mut self) -> Result<Option<Vec<u8>>, TransportError> {
        if self.failed {
            return Err(
                WireError::new(ErrorCode::ConnectionClosed, "frame reader is terminal").into(),
            );
        }
        if self.pending.len() > self.limit {
            return Err(self.frame_too_large());
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
            if count > self.limit - self.pending.len() {
                return Err(self.frame_too_large());
            }
            self.pending.extend_from_slice(&bytes[..count]);
            self.reader.consume(count + usize::from(newline.is_some()));
            if newline.is_some() {
                return Ok(Some(std::mem::take(&mut self.pending)));
            }
        }
    }

    fn frame_too_large(&mut self) -> TransportError {
        self.failed = true;
        WireError::new(ErrorCode::FrameTooLarge, "frame exceeds byte limit").into()
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
