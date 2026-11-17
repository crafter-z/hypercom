#![allow(dead_code)]

//! Transport-independent automation domain state. No Tauri, I/O, threads, or clocks.
//!
//! The owner must serialize calls (and snapshot construction) with its serial state.
//! `now_ms` is a server-local monotonic clock, never a client's wall clock. Identity,
//! permissions and port scopes must come from a freshly authenticated server session,
//! not from deserializing client-supplied authority. Epochs must change on restart.
//! A permit is only admission to the existing serial writer: its connection generation
//! must also be checked at that writer's boundary. Draining means *physical work has
//! completed*, not that a future was cancelled or a network response was lost.
//!
//! DTOs support serde in both directions; authoritative containers intentionally only
//! serialize. Restoring counters/leases from arbitrary JSON would defeat fencing.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fmt;

macro_rules! string_id {
    ($name:ident) => {
        #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);
        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }
    };
}
macro_rules! counter_id {
    ($name:ident) => {
        #[derive(
            Clone,
            Copy,
            Debug,
            Default,
            PartialEq,
            Eq,
            PartialOrd,
            Ord,
            Hash,
            Serialize,
            Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(pub u64);
    };
}
string_id!(HostId);
string_id!(ServerEpoch);
string_id!(PrincipalId);
string_id!(ClientSessionId);
string_id!(RequestId);
string_id!(LeaseId);
string_id!(OperationId);
counter_id!(ConnectionGeneration);
counter_id!(FencingToken);
counter_id!(ExecutionId);
counter_id!(Sequence);

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortRef {
    pub host_id: HostId,
    pub native_port_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrincipalKind {
    LocalUi,
    Cli,
    Remote,
    Plugin,
    System,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Principal {
    pub id: PrincipalId,
    pub kind: PrincipalKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    Observe,
    Write,
    Control,
    Takeover,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "ports", rename_all = "snake_case")]
pub enum PortScope {
    All,
    Only(BTreeSet<PortRef>),
}
impl PortScope {
    pub fn allows(&self, port: &PortRef) -> bool {
        match self {
            Self::All => true,
            Self::Only(ports) => ports.contains(port),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientSession {
    pub id: ClientSessionId,
    pub principal: Principal,
    pub server_epoch: ServerEpoch,
    pub permissions: BTreeSet<Permission>,
    pub port_scope: PortScope,
}
impl ClientSession {
    pub fn holder(&self) -> LeaseHolder {
        LeaseHolder {
            principal_id: self.principal.id.clone(),
            session_id: self.id.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseHolder {
    pub principal_id: PrincipalId,
    pub session_id: ClientSessionId,
}

/// Stable wire codes. Display text is diagnostic, never a protocol discriminator.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidArgument,
    WrongHost,
    EpochMismatch,
    GenerationMismatch,
    PermissionDenied,
    PortOutOfScope,
    LeaseBusy,
    LeaseMissing,
    LeaseExpired,
    FenceMismatch,
    HolderMismatch,
    Draining,
    DrainPending,
    TakeoverMissing,
    RequestConflict,
    OperationMissing,
    InvalidTransition,
    CounterExhausted,
    ClockRegression,
    CursorAhead,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorStage {
    Validate,
    Acquire,
    Renew,
    Release,
    Takeover,
    Drain,
    Enqueue,
    Execute,
    Complete,
    Dedupe,
    Replay,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SideEffect {
    None,
    Partial,
    Complete,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationError {
    pub code: ErrorCode,
    pub stage: ErrorStage,
    pub retryable: bool,
    pub side_effect: SideEffect,
    pub message: String,
}
impl AutomationError {
    pub fn new(
        code: ErrorCode,
        stage: ErrorStage,
        retryable: bool,
        side_effect: SideEffect,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            stage,
            retryable,
            side_effect,
            message: message.into(),
        }
    }
}
impl fmt::Display for AutomationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}/{:?}: {}", self.stage, self.code, self.message)
    }
}
impl std::error::Error for AutomationError {}
fn error(code: ErrorCode, stage: ErrorStage) -> AutomationError {
    let retryable = matches!(
        code,
        ErrorCode::LeaseBusy | ErrorCode::Draining | ErrorCode::DrainPending
    );
    AutomationError::new(
        code,
        stage,
        retryable,
        SideEffect::None,
        format!("{code:?}"),
    )
}
fn deadline(now_ms: u64, ttl_ms: u64, stage: ErrorStage) -> Result<u64, AutomationError> {
    if ttl_ms == 0 {
        return Err(error(ErrorCode::InvalidArgument, stage));
    }
    now_ms
        .checked_add(ttl_ms)
        .ok_or_else(|| error(ErrorCode::CounterExhausted, stage))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseOptions {
    pub ttl_ms: u64,
    /// Must include Write or Control and must be a subset of current session grants.
    pub permissions: BTreeSet<Permission>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseFence {
    pub port: PortRef,
    pub server_epoch: ServerEpoch,
    pub connection_generation: ConnectionGeneration,
    pub fencing_token: FencingToken,
    pub holder: LeaseHolder,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlLease {
    pub lease_id: LeaseId,
    pub fence: LeaseFence,
    pub ttl_ms: u64,
    pub granted_at_ms: u64,
    pub expires_at_ms: u64,
    pub permissions: BTreeSet<Permission>,
    /// Each lease is deliberately narrowed to the one arbitrated port.
    pub port_scope: PortScope,
}
impl ControlLease {
    pub fn is_expired(&self, now_ms: u64) -> bool {
        now_ms >= self.expires_at_ms
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingTakeover {
    pub fence: LeaseFence,
    pub options: LeaseOptions,
    /// An abandoned takeover cannot reserve a port forever.
    pub expires_at_ms: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum WriterState {
    Vacant,
    Active {
        lease: ControlLease,
    },
    Draining {
        previous: ControlLease,
        pending: Option<PendingTakeover>,
        drained: bool,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum DrainStatus {
    Pending { request: RequestKey },
    Drained,
}

/// De-duplication scope is principal + server epoch (the registry's epoch), not the
/// transient client connection. Reconnecting the same principal can query a retry.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestKey {
    pub principal_id: PrincipalId,
    pub request_id: RequestId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PayloadHash(pub [u8; 32]);
impl PayloadHash {
    /// Hash canonical *complete request* bytes, including operation, target and args.
    /// A transport must canonicalize once; raw JSON formatting is not canonical.
    pub fn of(canonical_request: &[u8]) -> Self {
        Self(Sha256::digest(canonical_request).into())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedRequest {
    pub key: RequestKey,
    pub payload_hash: PayloadHash,
    pub fence: LeaseFence,
    pub required_permission: Permission,
    pub requested_bytes: u64,
}
/// Opaque-by-convention completion identity. Only the stored matching permit may
/// retire in-flight work; an expired lease does not retire physical work.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionPermit {
    pub execution_id: ExecutionId,
    pub request: QueuedRequest,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortArbiter {
    port: PortRef,
    server_epoch: ServerEpoch,
    connection_generation: ConnectionGeneration,
    next_fence: u64,
    next_execution: u64,
    last_now_ms: u64,
    state: WriterState,
    in_flight: Option<ExecutionPermit>,
}
impl PortArbiter {
    pub fn new(port: PortRef, server_epoch: ServerEpoch, generation: ConnectionGeneration) -> Self {
        Self {
            port,
            server_epoch,
            connection_generation: generation,
            next_fence: 0,
            next_execution: 0,
            last_now_ms: 0,
            state: WriterState::Vacant,
            in_flight: None,
        }
    }
    pub fn state(&self) -> &WriterState {
        &self.state
    }
    pub fn in_flight(&self) -> Option<&ExecutionPermit> {
        self.in_flight.as_ref()
    }
    pub fn port(&self) -> &PortRef {
        &self.port
    }
    pub fn generation(&self) -> ConnectionGeneration {
        self.connection_generation
    }
    /// The sole holder admitted to *new* work; a draining old permit is visible via
    /// in_flight(), and blocks acquisition even when no holder is effective here.
    pub fn effective_writer(&self, now_ms: u64) -> Option<&ControlLease> {
        match &self.state {
            WriterState::Active { lease }
                if !lease.is_expired(now_ms) && now_ms >= self.last_now_ms =>
            {
                Some(lease)
            }
            _ => None,
        }
    }
    fn authorize(
        &self,
        session: &ClientSession,
        permissions: &BTreeSet<Permission>,
        stage: ErrorStage,
    ) -> Result<(), AutomationError> {
        if session.server_epoch != self.server_epoch {
            return Err(error(ErrorCode::EpochMismatch, stage));
        }
        if !session.port_scope.allows(&self.port) {
            return Err(error(ErrorCode::PortOutOfScope, stage));
        }
        if !permissions.is_subset(&session.permissions) {
            return Err(error(ErrorCode::PermissionDenied, stage));
        }
        Ok(())
    }
    fn validate_options(
        &self,
        session: &ClientSession,
        options: &LeaseOptions,
        now_ms: u64,
        stage: ErrorStage,
    ) -> Result<(), AutomationError> {
        deadline(now_ms, options.ttl_ms, stage)?;
        if !options.permissions.contains(&Permission::Write)
            && !options.permissions.contains(&Permission::Control)
        {
            return Err(error(ErrorCode::InvalidArgument, stage));
        }
        self.authorize(session, &options.permissions, stage)
    }
    fn mint_fence(
        &mut self,
        holder: LeaseHolder,
        stage: ErrorStage,
    ) -> Result<LeaseFence, AutomationError> {
        self.next_fence = self
            .next_fence
            .checked_add(1)
            .ok_or_else(|| error(ErrorCode::CounterExhausted, stage))?;
        Ok(LeaseFence {
            port: self.port.clone(),
            server_epoch: self.server_epoch.clone(),
            connection_generation: self.connection_generation,
            fencing_token: FencingToken(self.next_fence),
            holder,
        })
    }
    fn make_lease(&self, fence: LeaseFence, options: LeaseOptions, now_ms: u64) -> ControlLease {
        ControlLease {
            lease_id: LeaseId(format!(
                "{}:{}:{}:{}:{}:{}:{}",
                self.port.host_id.0.len(),
                self.port.host_id.0,
                self.port.native_port_id.len(),
                self.port.native_port_id,
                self.server_epoch.0.len(),
                self.server_epoch.0,
                fence.fencing_token.0
            )),
            fence,
            ttl_ms: options.ttl_ms,
            granted_at_ms: now_ms,
            expires_at_ms: now_ms + options.ttl_ms,
            permissions: options.permissions,
            port_scope: PortScope::Only(BTreeSet::from([self.port.clone()])),
        }
    }
    /// Applies expiration but never pretends that an old physical writer drained.
    /// Returns true if the externally visible arbitration state changed.
    pub fn expire(&mut self, now_ms: u64) -> Result<bool, AutomationError> {
        if now_ms < self.last_now_ms {
            return Err(error(ErrorCode::ClockRegression, ErrorStage::Validate));
        }
        self.last_now_ms = now_ms;
        let next = match &self.state {
            WriterState::Active { lease } if lease.is_expired(now_ms) => {
                Some(if self.in_flight.is_some() {
                    WriterState::Draining {
                        previous: lease.clone(),
                        pending: None,
                        drained: false,
                    }
                } else {
                    WriterState::Vacant
                })
            }
            WriterState::Draining {
                previous,
                pending: Some(pending),
                ..
            } if now_ms >= pending.expires_at_ms => Some(if self.in_flight.is_some() {
                WriterState::Draining {
                    previous: previous.clone(),
                    pending: None,
                    drained: false,
                }
            } else {
                WriterState::Vacant
            }),
            _ => None,
        };
        if let Some(next) = next {
            self.state = next;
            return Ok(true);
        }
        Ok(false)
    }
    pub fn acquire(
        &mut self,
        session: &ClientSession,
        options: LeaseOptions,
        now_ms: u64,
    ) -> Result<ControlLease, AutomationError> {
        self.expire(now_ms)?;
        self.validate_options(session, &options, now_ms, ErrorStage::Acquire)?;
        match self.state {
            WriterState::Vacant => {}
            WriterState::Active { .. } => {
                return Err(error(ErrorCode::LeaseBusy, ErrorStage::Acquire))
            }
            WriterState::Draining { .. } => {
                return Err(error(ErrorCode::Draining, ErrorStage::Acquire))
            }
        }
        let fence = self.mint_fence(session.holder(), ErrorStage::Acquire)?;
        let lease = self.make_lease(fence, options, now_ms);
        self.state = WriterState::Active {
            lease: lease.clone(),
        };
        Ok(lease)
    }
    fn validate_fence(
        &self,
        session: &ClientSession,
        fence: &LeaseFence,
        permission: Option<Permission>,
        now_ms: u64,
        stage: ErrorStage,
    ) -> Result<(), AutomationError> {
        if fence.port.host_id != self.port.host_id {
            return Err(error(ErrorCode::WrongHost, stage));
        }
        if fence.port != self.port {
            return Err(error(ErrorCode::PortOutOfScope, stage));
        }
        if fence.server_epoch != self.server_epoch || session.server_epoch != self.server_epoch {
            return Err(error(ErrorCode::EpochMismatch, stage));
        }
        if fence.connection_generation != self.connection_generation {
            return Err(error(ErrorCode::GenerationMismatch, stage));
        }
        if fence.holder != session.holder() {
            return Err(error(ErrorCode::HolderMismatch, stage));
        }
        let lease = match &self.state {
            WriterState::Active { lease } => lease,
            WriterState::Vacant => return Err(error(ErrorCode::LeaseMissing, stage)),
            WriterState::Draining { .. } => return Err(error(ErrorCode::Draining, stage)),
        };
        if lease.fence != *fence {
            return Err(error(ErrorCode::FenceMismatch, stage));
        }
        if lease.is_expired(now_ms) {
            return Err(error(ErrorCode::LeaseExpired, stage));
        }
        if let Some(permission) = permission {
            self.authorize(session, &BTreeSet::from([permission]), stage)?;
            if !lease.permissions.contains(&permission) || !lease.port_scope.allows(&self.port) {
                return Err(error(ErrorCode::PermissionDenied, stage));
            }
        }
        Ok(())
    }
    pub fn renew(
        &mut self,
        session: &ClientSession,
        fence: &LeaseFence,
        ttl_ms: u64,
        now_ms: u64,
    ) -> Result<ControlLease, AutomationError> {
        // Check expiry before expire() so renewal reports a precise lease_expired.
        if now_ms < self.last_now_ms {
            return Err(error(ErrorCode::ClockRegression, ErrorStage::Renew));
        }
        let validation = self.validate_fence(session, fence, None, now_ms, ErrorStage::Renew);
        self.expire(now_ms)?;
        validation?;
        let expires_at_ms = deadline(now_ms, ttl_ms, ErrorStage::Renew)?;
        let permissions = match &self.state {
            WriterState::Active { lease } => lease.permissions.clone(),
            _ => unreachable!(),
        };
        self.authorize(session, &permissions, ErrorStage::Renew)?;
        if let WriterState::Active { lease } = &mut self.state {
            lease.ttl_ms = ttl_ms;
            lease.expires_at_ms = expires_at_ms;
            return Ok(lease.clone());
        }
        unreachable!()
    }
    pub fn release(
        &mut self,
        session: &ClientSession,
        fence: &LeaseFence,
        now_ms: u64,
    ) -> Result<(), AutomationError> {
        self.expire(now_ms)?;
        // A revoked holder may still release, but may not renew or execute.
        self.validate_fence(session, fence, None, now_ms, ErrorStage::Release)?;
        let WriterState::Active { lease } = &self.state else {
            unreachable!()
        };
        self.state = if self.in_flight.is_some() {
            WriterState::Draining {
                previous: lease.clone(),
                pending: None,
                drained: false,
            }
        } else {
            WriterState::Vacant
        };
        Ok(())
    }
    /// CAS against the observed old fence prevents a stale takeover prompt from
    /// silently evicting an unrelated newer lease. The new holder is NOT active yet.
    pub fn begin_takeover(
        &mut self,
        session: &ClientSession,
        expected: &LeaseFence,
        options: LeaseOptions,
        now_ms: u64,
    ) -> Result<PendingTakeover, AutomationError> {
        self.expire(now_ms)?;
        self.validate_options(session, &options, now_ms, ErrorStage::Takeover)?;
        self.authorize(
            session,
            &BTreeSet::from([Permission::Takeover]),
            ErrorStage::Takeover,
        )?;
        let previous = match &self.state {
            WriterState::Active { lease } if lease.fence == *expected => lease.clone(),
            WriterState::Active { .. } => {
                return Err(error(ErrorCode::FenceMismatch, ErrorStage::Takeover))
            }
            WriterState::Vacant => {
                return Err(error(ErrorCode::LeaseMissing, ErrorStage::Takeover))
            }
            WriterState::Draining { .. } => {
                return Err(error(ErrorCode::Draining, ErrorStage::Takeover))
            }
        };
        let pending = PendingTakeover {
            fence: self.mint_fence(session.holder(), ErrorStage::Takeover)?,
            expires_at_ms: deadline(now_ms, options.ttl_ms, ErrorStage::Takeover)?,
            options,
        };
        self.state = WriterState::Draining {
            previous,
            pending: Some(pending.clone()),
            drained: false,
        };
        Ok(pending)
    }
    /// Observe the drain barrier; only complete_execution can retire a permit.
    pub fn drain(&mut self) -> Result<DrainStatus, AutomationError> {
        if !matches!(self.state, WriterState::Draining { .. }) {
            return Err(error(ErrorCode::InvalidTransition, ErrorStage::Drain));
        }
        if let Some(permit) = &self.in_flight {
            return Ok(DrainStatus::Pending {
                request: permit.request.key.clone(),
            });
        }
        match &mut self.state {
            WriterState::Draining {
                pending: Some(_),
                drained,
                ..
            } => *drained = true,
            _ => self.state = WriterState::Vacant,
        }
        Ok(DrainStatus::Drained)
    }
    pub fn finish_takeover(
        &mut self,
        session: &ClientSession,
        pending_fence: &LeaseFence,
        now_ms: u64,
    ) -> Result<ControlLease, AutomationError> {
        self.expire(now_ms)?;
        let (pending, drained) = match &self.state {
            WriterState::Draining {
                pending: Some(pending),
                drained,
                ..
            } => (pending.clone(), *drained),
            _ => return Err(error(ErrorCode::TakeoverMissing, ErrorStage::Takeover)),
        };
        if pending.fence != *pending_fence {
            return Err(error(ErrorCode::FenceMismatch, ErrorStage::Takeover));
        }
        if pending.fence.holder != session.holder() {
            return Err(error(ErrorCode::HolderMismatch, ErrorStage::Takeover));
        }
        self.validate_options(session, &pending.options, now_ms, ErrorStage::Takeover)?;
        self.authorize(
            session,
            &BTreeSet::from([Permission::Takeover]),
            ErrorStage::Takeover,
        )?;
        if !drained || self.in_flight.is_some() {
            return Err(error(ErrorCode::DrainPending, ErrorStage::Takeover));
        }
        let lease = self.make_lease(pending.fence, pending.options, now_ms);
        self.state = WriterState::Active {
            lease: lease.clone(),
        };
        Ok(lease)
    }
    pub fn queue_request(
        &mut self,
        session: &ClientSession,
        request: QueuedRequest,
        now_ms: u64,
    ) -> Result<QueuedRequest, AutomationError> {
        self.check_request(session, &request, now_ms, ErrorStage::Enqueue)?;
        Ok(request)
    }
    fn check_request(
        &mut self,
        session: &ClientSession,
        request: &QueuedRequest,
        now_ms: u64,
        stage: ErrorStage,
    ) -> Result<(), AutomationError> {
        if now_ms < self.last_now_ms {
            return Err(error(ErrorCode::ClockRegression, stage));
        }
        let validation = self.validate_fence(
            session,
            &request.fence,
            Some(request.required_permission),
            now_ms,
            stage,
        );
        self.expire(now_ms)?;
        validation?;
        if request.key.principal_id != session.principal.id {
            return Err(error(ErrorCode::HolderMismatch, stage));
        }
        if !matches!(
            request.required_permission,
            Permission::Write | Permission::Control
        ) {
            return Err(error(ErrorCode::InvalidArgument, stage));
        }
        Ok(())
    }
    /// Mandatory *execution-time* check: a successful queue check is not authority.
    pub fn begin_execution(
        &mut self,
        session: &ClientSession,
        request: &QueuedRequest,
        now_ms: u64,
    ) -> Result<ExecutionPermit, AutomationError> {
        self.check_request(session, request, now_ms, ErrorStage::Execute)?;
        if self.in_flight.is_some() {
            return Err(error(ErrorCode::LeaseBusy, ErrorStage::Execute));
        }
        self.next_execution = self
            .next_execution
            .checked_add(1)
            .ok_or_else(|| error(ErrorCode::CounterExhausted, ErrorStage::Execute))?;
        let permit = ExecutionPermit {
            execution_id: ExecutionId(self.next_execution),
            request: request.clone(),
        };
        self.in_flight = Some(permit.clone());
        Ok(permit)
    }
    /// Call only after the underlying writer is physically finished, regardless of
    /// cancellation, lease expiry, operation outcome, or disconnected clients.
    pub fn complete_execution(&mut self, permit: &ExecutionPermit) -> Result<(), AutomationError> {
        if self.in_flight.as_ref() != Some(permit) {
            return Err(error(ErrorCode::FenceMismatch, ErrorStage::Complete));
        }
        self.in_flight = None;
        Ok(())
    }
    /// A reconnect invalidates queued requests, but cannot leapfrog an old write or
    /// takeover. The owner must drain first. Generations may not repeat in an epoch.
    pub fn change_generation(
        &mut self,
        generation: ConnectionGeneration,
        now_ms: u64,
    ) -> Result<(), AutomationError> {
        self.expire(now_ms)?;
        if generation <= self.connection_generation {
            return Err(error(ErrorCode::GenerationMismatch, ErrorStage::Validate));
        }
        if self.in_flight.is_some() || matches!(self.state, WriterState::Draining { .. }) {
            return Err(error(ErrorCode::DrainPending, ErrorStage::Validate));
        }
        self.connection_generation = generation;
        self.state = WriterState::Vacant;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationStatus {
    Accepted,
    Queued,
    Executing,
    Succeeded,
    Failed,
    Cancelled,
    Unknown,
}
impl OperationStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Cancelled | Self::Unknown
        )
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ByteCertainty {
    Exact,
    AtLeast,
}
/// `known` counts bytes confirmed handed to the device writer, not ACKed by a
/// remote device. AtLeast explicitly admits additional unknown physical effects.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ByteCount {
    pub known: u64,
    pub certainty: ByteCertainty,
}
impl ByteCount {
    pub fn exact(known: u64) -> Self {
        Self {
            known,
            certainty: ByteCertainty::Exact,
        }
    }
    pub fn at_least(known: u64) -> Self {
        Self {
            known,
            certainty: ByteCertainty::AtLeast,
        }
    }
    pub fn side_effect(self, requested: u64) -> SideEffect {
        if self.certainty == ByteCertainty::AtLeast {
            SideEffect::Unknown
        } else if self.known == 0 {
            SideEffect::None
        } else if self.known < requested {
            SideEffect::Partial
        } else {
            SideEffect::Complete
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRecord {
    pub operation_id: OperationId,
    pub key: RequestKey,
    pub server_epoch: ServerEpoch,
    pub payload_hash: PayloadHash,
    pub requested_bytes: u64,
    pub status: OperationStatus,
    pub bytes: ByteCount,
    pub accepted_at_ms: u64,
    pub updated_at_ms: u64,
    pub error: Option<AutomationError>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "record", rename_all = "snake_case")]
pub enum AcceptOutcome {
    Accepted(OperationRecord),
    Duplicate(OperationRecord),
}
impl AcceptOutcome {
    pub fn record(&self) -> &OperationRecord {
        match self {
            Self::Accepted(record) | Self::Duplicate(record) => record,
        }
    }
}
/// Records are intentionally not auto-evicted: removing a record would let a late
/// retry re-execute a physical side effect. The service must define a durable
/// retention/idempotency contract before adding GC. A new epoch starts a new scope.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationRegistry {
    server_epoch: ServerEpoch,
    next_operation: u64,
    // Serialize as an array: structured map keys are not JSON object keys.
    #[serde(serialize_with = "serialize_records")]
    records: BTreeMap<RequestKey, OperationRecord>,
}
fn serialize_records<S: serde::Serializer>(
    records: &BTreeMap<RequestKey, OperationRecord>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    records.values().collect::<Vec<_>>().serialize(serializer)
}
impl OperationRegistry {
    pub fn new(server_epoch: ServerEpoch) -> Self {
        Self {
            server_epoch,
            next_operation: 0,
            records: BTreeMap::new(),
        }
    }
    pub fn get(&self, key: &RequestKey) -> Option<&OperationRecord> {
        self.records.get(key)
    }
    pub fn accept(
        &mut self,
        session: &ClientSession,
        request_id: RequestId,
        payload_hash: PayloadHash,
        requested_bytes: u64,
        now_ms: u64,
    ) -> Result<AcceptOutcome, AutomationError> {
        if session.server_epoch != self.server_epoch {
            return Err(error(ErrorCode::EpochMismatch, ErrorStage::Dedupe));
        }
        let key = RequestKey {
            principal_id: session.principal.id.clone(),
            request_id,
        };
        if let Some(record) = self.records.get(&key) {
            if record.payload_hash != payload_hash || record.requested_bytes != requested_bytes {
                return Err(error(ErrorCode::RequestConflict, ErrorStage::Dedupe));
            }
            return Ok(AcceptOutcome::Duplicate(record.clone()));
        }
        self.next_operation = self
            .next_operation
            .checked_add(1)
            .ok_or_else(|| error(ErrorCode::CounterExhausted, ErrorStage::Dedupe))?;
        let operation_id = OperationId(format!(
            "{}:{}:{}",
            self.server_epoch.0.len(),
            self.server_epoch.0,
            self.next_operation
        ));
        let record = OperationRecord {
            operation_id,
            key: key.clone(),
            server_epoch: self.server_epoch.clone(),
            payload_hash,
            requested_bytes,
            status: OperationStatus::Accepted,
            bytes: ByteCount::exact(0),
            accepted_at_ms: now_ms,
            updated_at_ms: now_ms,
            error: None,
        };
        self.records.insert(key, record.clone());
        Ok(AcceptOutcome::Accepted(record))
    }
    fn record_mut(
        &mut self,
        key: &RequestKey,
        now_ms: u64,
    ) -> Result<&mut OperationRecord, AutomationError> {
        let record = self
            .records
            .get_mut(key)
            .ok_or_else(|| error(ErrorCode::OperationMissing, ErrorStage::Complete))?;
        if now_ms < record.updated_at_ms {
            return Err(error(ErrorCode::ClockRegression, ErrorStage::Complete));
        }
        Ok(record)
    }
    pub fn mark_queued(&mut self, key: &RequestKey, now_ms: u64) -> Result<(), AutomationError> {
        let record = self.record_mut(key, now_ms)?;
        if record.status != OperationStatus::Accepted {
            return Err(error(ErrorCode::InvalidTransition, ErrorStage::Enqueue));
        }
        record.status = OperationStatus::Queued;
        record.updated_at_ms = now_ms;
        Ok(())
    }
    /// Atomically coordinate ledger de-duplication with execution-time fencing.
    /// Prefer this entry point to separate mark_executing/begin_execution calls.
    /// A rejected fence leaves the record accepted/queued and creates no permit.
    pub fn begin_execution(
        &mut self,
        arbiter: &mut PortArbiter,
        session: &ClientSession,
        request: &QueuedRequest,
        now_ms: u64,
    ) -> Result<ExecutionPermit, AutomationError> {
        if request.fence.server_epoch != self.server_epoch {
            return Err(error(ErrorCode::EpochMismatch, ErrorStage::Execute));
        }
        let record = self.record_mut(&request.key, now_ms)?;
        if record.payload_hash != request.payload_hash
            || record.requested_bytes != request.requested_bytes
        {
            return Err(error(ErrorCode::RequestConflict, ErrorStage::Execute));
        }
        if !matches!(
            record.status,
            OperationStatus::Accepted | OperationStatus::Queued
        ) {
            return Err(error(ErrorCode::InvalidTransition, ErrorStage::Execute));
        }
        let permit = arbiter.begin_execution(session, request, now_ms)?;
        record.status = OperationStatus::Executing;
        record.updated_at_ms = now_ms;
        Ok(permit)
    }
    /// Low-level ledger update for adapters that already atomically hold a permit.
    pub fn mark_executing(
        &mut self,
        request: &QueuedRequest,
        now_ms: u64,
    ) -> Result<(), AutomationError> {
        if request.fence.server_epoch != self.server_epoch {
            return Err(error(ErrorCode::EpochMismatch, ErrorStage::Execute));
        }
        let record = self.record_mut(&request.key, now_ms)?;
        if record.payload_hash != request.payload_hash
            || record.requested_bytes != request.requested_bytes
        {
            return Err(error(ErrorCode::RequestConflict, ErrorStage::Execute));
        }
        if !matches!(
            record.status,
            OperationStatus::Accepted | OperationStatus::Queued
        ) {
            return Err(error(ErrorCode::InvalidTransition, ErrorStage::Execute));
        }
        record.status = OperationStatus::Executing;
        record.updated_at_ms = now_ms;
        Ok(())
    }
    pub fn record_progress(
        &mut self,
        key: &RequestKey,
        known_bytes: u64,
        now_ms: u64,
    ) -> Result<(), AutomationError> {
        let record = self.record_mut(key, now_ms)?;
        if record.status != OperationStatus::Executing
            || known_bytes < record.bytes.known
            || known_bytes > record.requested_bytes
        {
            return Err(error(ErrorCode::InvalidTransition, ErrorStage::Complete));
        }
        // While executing, additional writes may be in flight.
        record.bytes = ByteCount::at_least(known_bytes);
        record.updated_at_ms = now_ms;
        Ok(())
    }
    pub fn finish(
        &mut self,
        key: &RequestKey,
        status: OperationStatus,
        bytes: ByteCount,
        failure: Option<AutomationError>,
        now_ms: u64,
    ) -> Result<(), AutomationError> {
        let record = self.record_mut(key, now_ms)?;
        let executing = record.status == OperationStatus::Executing;
        let invalid = record.status.is_terminal()
            || !status.is_terminal()
            || bytes.known < record.bytes.known
            || bytes.known > record.requested_bytes
            || (!executing && bytes != ByteCount::exact(0))
            || (status == OperationStatus::Succeeded
                && (!executing
                    || bytes != ByteCount::exact(record.requested_bytes)
                    || failure.is_some()))
            || (status == OperationStatus::Unknown
                && (!executing || bytes.certainty != ByteCertainty::AtLeast))
            || (status != OperationStatus::Unknown && bytes.certainty != ByteCertainty::Exact)
            || (status == OperationStatus::Failed && failure.is_none());
        if invalid {
            return Err(error(ErrorCode::InvalidTransition, ErrorStage::Complete));
        }
        let side_effect = bytes.side_effect(record.requested_bytes);
        let failure = failure.map(|mut failure| {
            // Byte counts cannot erase non-byte effects (open/close/signals), nor
            // make an explicitly uncertain driver result look definitely harmless.
            failure.side_effect = match (failure.side_effect, side_effect) {
                (SideEffect::Unknown, _) | (_, SideEffect::Unknown) => SideEffect::Unknown,
                (SideEffect::Complete, _) | (_, SideEffect::Complete) => SideEffect::Complete,
                (SideEffect::Partial, _) | (_, SideEffect::Partial) => SideEffect::Partial,
                _ => SideEffect::None,
            };
            // A partial or uncertain write must never advertise blind retry safety.
            if failure.side_effect != SideEffect::None {
                failure.retryable = false;
            }
            failure
        });
        record.status = status;
        record.bytes = bytes;
        record.error = failure;
        record.updated_at_ms = now_ms;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventCursor {
    pub host_id: HostId,
    pub server_epoch: ServerEpoch,
    /// Last consumed event; zero is the initial, empty-stream watermark.
    pub sequence: Sequence,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventEnvelope<T> {
    pub cursor: EventCursor,
    pub payload: T,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot<T> {
    pub state: T,
    pub watermark: EventCursor,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Replay<T> {
    Events {
        events: Vec<EventEnvelope<T>>,
        next: EventCursor,
        watermark: EventCursor,
    },
    /// Capacity eviction lost events after the requested sequence. Resnapshot;
    /// never silently skip ahead and call the resulting stream contiguous.
    Gap {
        requested: EventCursor,
        oldest_available: EventCursor,
        watermark: EventCursor,
    },
    /// Server restart invalidated the cursor's entire sequence namespace.
    Expired {
        requested: EventCursor,
        watermark: EventCursor,
    },
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventRing<T> {
    host_id: HostId,
    server_epoch: ServerEpoch,
    capacity: usize,
    sequence: Sequence,
    events: VecDeque<EventEnvelope<T>>,
}
impl<T> EventRing<T> {
    pub fn new(
        host_id: HostId,
        server_epoch: ServerEpoch,
        capacity: usize,
    ) -> Result<Self, AutomationError> {
        if capacity == 0 {
            return Err(error(ErrorCode::InvalidArgument, ErrorStage::Validate));
        }
        Ok(Self {
            host_id,
            server_epoch,
            capacity,
            sequence: Sequence(0),
            events: VecDeque::new(),
        })
    }
    pub fn len(&self) -> usize {
        self.events.len()
    }
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }
    pub fn watermark(&self) -> EventCursor {
        EventCursor {
            host_id: self.host_id.clone(),
            server_epoch: self.server_epoch.clone(),
            sequence: self.sequence,
        }
    }
    /// Capture state and this watermark under the same owner lock/serialized turn.
    /// Subscribing after it then includes every event strictly after the snapshot.
    pub fn snapshot<S>(&self, state: S) -> Snapshot<S> {
        Snapshot {
            state,
            watermark: self.watermark(),
        }
    }
    pub fn push(&mut self, payload: T) -> Result<EventCursor, AutomationError> {
        let sequence = self
            .sequence
            .0
            .checked_add(1)
            .ok_or_else(|| error(ErrorCode::CounterExhausted, ErrorStage::Complete))?;
        self.sequence = Sequence(sequence);
        let cursor = self.watermark();
        if self.events.len() == self.capacity {
            self.events.pop_front();
        }
        self.events.push_back(EventEnvelope {
            cursor: cursor.clone(),
            payload,
        });
        Ok(cursor)
    }
}
impl<T: Clone> EventRing<T> {
    pub fn read_after(
        &self,
        cursor: &EventCursor,
        limit: usize,
    ) -> Result<Replay<T>, AutomationError> {
        if limit == 0 {
            return Err(error(ErrorCode::InvalidArgument, ErrorStage::Replay));
        }
        if cursor.host_id != self.host_id {
            return Err(error(ErrorCode::WrongHost, ErrorStage::Replay));
        }
        let watermark = self.watermark();
        if cursor.server_epoch != self.server_epoch {
            return Ok(Replay::Expired {
                requested: cursor.clone(),
                watermark,
            });
        }
        if cursor.sequence > self.sequence {
            return Err(error(ErrorCode::CursorAhead, ErrorStage::Replay));
        }
        if let Some(first) = self.events.front() {
            if cursor.sequence.0 < first.cursor.sequence.0 - 1 {
                return Ok(Replay::Gap {
                    requested: cursor.clone(),
                    oldest_available: first.cursor.clone(),
                    watermark,
                });
            }
        }
        let events: Vec<_> = self
            .events
            .iter()
            .filter(|event| event.cursor.sequence > cursor.sequence)
            .take(limit)
            .cloned()
            .collect();
        let next = events
            .last()
            .map_or_else(|| cursor.clone(), |event| event.cursor.clone());
        Ok(Replay::Events {
            events,
            next,
            watermark,
        })
    }
}
/// A pure snapshot->replay->live cursor. Pagination advances only to the last
/// delivered event, never directly to the head; gaps/expired do not advance it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSubscription {
    cursor: EventCursor,
}
impl LiveSubscription {
    pub fn from_snapshot<T>(snapshot: &Snapshot<T>) -> Self {
        Self {
            cursor: snapshot.watermark.clone(),
        }
    }
    pub fn cursor(&self) -> &EventCursor {
        &self.cursor
    }
    pub fn poll<T: Clone>(
        &mut self,
        ring: &EventRing<T>,
        limit: usize,
    ) -> Result<Replay<T>, AutomationError> {
        let replay = ring.read_after(&self.cursor, limit)?;
        if let Replay::Events { next, .. } = &replay {
            self.cursor = next.clone();
        }
        Ok(replay)
    }
}

#[cfg(test)]
#[path = "core_tests.rs"]
mod tests;
