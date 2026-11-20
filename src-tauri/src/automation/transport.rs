#![allow(dead_code)]

//! Versioned, bounded JSON-lines listener for an explicitly enabled local service.
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
//! Each connection dispatches requests in order but reads concurrently to observe
//! peer EOF during a slow handler. A bounded pipeline queue rejects overflow with
//! `REQUEST_LIMIT` rather than pausing the read side and hiding EOF indefinitely.
//! Input EOF (including TCP half-close) ends the session: pending and unstarted
//! requests are discarded, and only already-queued responses are drained best effort.
//! Framing/transport errors may also queue a terminal response. Write queue overflow
//! reports `SLOW_CLIENT` best effort; a client that never reads may not receive it.
//! The disconnect hook reports the first observed cause before any terminal drain.

use super::wire::{check_limit, invalid_argument, valid_id, valid_method, MAX_ID_BYTES};
// Keep existing host consumers working while also exposing the codec as its own module.
#[allow(unused_imports)]
pub use super::wire::{
    decode_request, decode_response, encode_json_line, encode_request, encode_response,
    write_json_line, Control, ErrorCode, FrameReader, Handshake, Precondition, Request,
    RequestDecodeError, Response, Target, TransportError, WireError, DEFAULT_MAX_FRAME_BYTES,
    HANDSHAKE_METHOD, MAX_FRAME_BYTES, PROTOCOL_VERSION,
};
use serde_json::Value;
use std::collections::HashSet;
use std::future::Future;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::{mpsc, watch};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{timeout, timeout_at, Instant};

pub const DEFAULT_WRITE_QUEUE_CAPACITY: usize = 32;
const REQUEST_QUEUE_CAPACITY: usize = 16;

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
    /// Polls must not block the connection task. Disconnect or shutdown can drop
    /// this future: started physical work must be owned and reconciled by the
    /// domain, not assumed cancelled by dropping the future.
    fn handle(&self, connection: ConnectionContext, request: Request) -> HandlerFuture<'_>;

    /// Called once on termination after dispatch has stopped, before best-effort
    /// output drain. Must be nonblocking; never implicitly close a serial port.
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
                    let (read, write) = stream.into_split();
                    serve_connection(read, write, connection, &config, handler.as_ref(), stopped).await;
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

async fn read_request_frames<R: AsyncRead + Unpin>(
    mut reader: FrameReader<R>,
    frames: mpsc::Sender<Vec<u8>>,
    outbound: &OutboundQueue,
    config: &ListenerConfig,
) -> Result<(), WireError> {
    let error = loop {
        match reader.read_frame().await {
            Ok(Some(frame)) => match frames.try_send(frame) {
                Ok(()) => {
                    // Give dispatch and the writer a turn even if this entire
                    // burst is already buffered. No wait for queue capacity.
                    tokio::task::yield_now().await;
                }
                Err(mpsc::error::TrySendError::Full(_)) => {
                    break WireError::new(
                        ErrorCode::RequestLimit,
                        "connection request queue is full",
                    );
                }
                Err(mpsc::error::TrySendError::Closed(_)) => return Ok(()),
            },
            Ok(None) => return Ok(()),
            Err(TransportError::Protocol(error)) => break error,
            Err(_) => break WireError::new(ErrorCode::IoError, "connection read failed"),
        }
    };
    outbound.try_send(&Response::error(&config.server_epoch, None, error.clone()))?;
    Err(error)
}

async fn dispatch_requests(
    mut frames: mpsc::Receiver<Vec<u8>>,
    outbound: &OutboundQueue,
    config: &ListenerConfig,
    handler: &dyn RequestHandler,
    connection: ConnectionContext,
) -> Result<(), WireError> {
    let mut session = ProtocolSession::new();
    let handshake_deadline = Instant::now() + config.handshake_timeout;
    loop {
        let frame = if session.handshaken {
            frames.recv().await
        } else {
            match timeout_at(handshake_deadline, frames.recv()).await {
                Ok(frame) => frame,
                Err(_) => {
                    let error =
                        WireError::new(ErrorCode::HandshakeTimeout, "handshake deadline exceeded");
                    outbound.try_send(&Response::error(
                        &config.server_epoch,
                        None,
                        error.clone(),
                    ))?;
                    return Err(error);
                }
            }
        };
        let Some(frame) = frame else {
            return Ok(());
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
        drop(frame);
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

async fn serve_connection<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    read: R,
    write: W,
    connection: ConnectionContext,
    config: &ListenerConfig,
    handler: &dyn RequestHandler,
    mut stopped: watch::Receiver<bool>,
) {
    let reader = match FrameReader::new(read, config.max_frame_bytes) {
        Ok(reader) => reader,
        Err(error) => {
            handler.disconnected(connection, Some(error));
            return;
        }
    };
    let (sender, receiver) = mpsc::channel(config.write_queue_capacity);
    let (failure, failure_receiver) = watch::channel(None);
    let outbound = OutboundQueue {
        sender,
        failure,
        limit: config.max_frame_bytes,
    };
    let (frames, pending) = mpsc::channel(REQUEST_QUEUE_CAPACITY);
    let writing = write_responses(write, receiver, failure_receiver, config);
    tokio::pin!(writing);
    let (outcome, drain_output) = {
        let reading = read_request_frames(reader, frames, &outbound, config);
        let dispatching = dispatch_requests(pending, &outbound, config, handler, connection);
        tokio::pin!(reading, dispatching);
        tokio::select! {
            biased;
            _ = stopping(&mut stopped) => (
                Err(WireError::new(ErrorCode::ShuttingDown, "listener is shutting down")),
                false,
            ),
            result = &mut writing => (result, false),
            result = &mut reading => (result, true),
            result = &mut dispatching => (result, true),
        }
    }; // Drop dispatch (including any waiting handler) before releasing the session.
    handler.disconnected(connection, outcome.err());
    drop(outbound);

    if drain_output {
        // Only already-queued frames (or a queued terminal error) may be sent.
        // Bound the entire drain, and close on any partial write or shutdown.
        tokio::select! {
            biased;
            _ = stopping(&mut stopped) => {},
            _ = timeout(config.write_timeout, &mut writing) => {},
        }
    }
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;
