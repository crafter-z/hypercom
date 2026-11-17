use super::{
    AcceptOutcome, AutomationError, ByteCertainty, ByteCount, ClientSession, ClientSessionId,
    ConnectionGeneration, ControlLease, DrainStatus, ErrorCode, ErrorStage, EventCursor, EventRing,
    ExecutionId, FencingToken, HostId, LeaseOptions, LiveSubscription, OperationRegistry,
    OperationStatus, PayloadHash, Permission, PortArbiter, PortRef, PortScope, Principal,
    PrincipalId, PrincipalKind, QueuedRequest, Replay, RequestId, RequestKey, Sequence,
    ServerEpoch, SideEffect, WriterState,
};
use serde::{de::DeserializeOwned, Serialize};
use std::collections::BTreeSet;
use std::fmt::Debug;

fn port() -> PortRef {
    PortRef {
        host_id: HostId::from("host-a"),
        native_port_id: "COM3".into(),
    }
}
fn epoch() -> ServerEpoch {
    ServerEpoch::from("boot-a")
}
fn session(name: &str) -> ClientSession {
    ClientSession {
        id: ClientSessionId::from(name),
        principal: Principal {
            id: PrincipalId::from(name),
            kind: PrincipalKind::Cli,
        },
        server_epoch: epoch(),
        permissions: BTreeSet::from([
            Permission::Observe,
            Permission::Write,
            Permission::Control,
            Permission::Takeover,
        ]),
        port_scope: PortScope::All,
    }
}
fn options(ttl_ms: u64) -> LeaseOptions {
    LeaseOptions {
        ttl_ms,
        permissions: BTreeSet::from([Permission::Write, Permission::Control]),
    }
}
fn arbiter() -> PortArbiter {
    PortArbiter::new(port(), epoch(), ConnectionGeneration(1))
}
fn request(lease: &ControlLease, id: &str) -> QueuedRequest {
    QueuedRequest {
        key: RequestKey {
            principal_id: lease.fence.holder.principal_id.clone(),
            request_id: RequestId::from(id),
        },
        payload_hash: PayloadHash::of(b"send host-a COM3: hello"),
        fence: lease.fence.clone(),
        required_permission: Permission::Write,
        requested_bytes: 5,
    }
}
fn assert_code<T: Debug>(result: Result<T, AutomationError>, code: ErrorCode) {
    let error = result.unwrap_err();
    assert_eq!(error.code, code);
    assert_eq!(error.side_effect, SideEffect::None);
}
fn roundtrip<T: Serialize + DeserializeOwned + PartialEq + Debug>(value: &T) {
    let json = serde_json::to_string(value).unwrap();
    assert_eq!(&serde_json::from_str::<T>(&json).unwrap(), value);
}
fn failure() -> AutomationError {
    AutomationError::new(
        ErrorCode::InvalidArgument,
        ErrorStage::Execute,
        true,
        SideEffect::None,
        "writer failed",
    )
}
#[test]
fn native_error_codes_are_stable_and_retry_hints_are_conservative() {
    for (code, wire) in [
        (ErrorCode::IoError, "io_error"),
        (ErrorCode::OutcomeUnknown, "outcome_unknown"),
        (ErrorCode::DeadlineExceeded, "deadline_exceeded"),
        (ErrorCode::Cancelled, "cancelled"),
    ] {
        assert_eq!(serde_json::to_value(code).unwrap(), wire);
        let error = AutomationError::new(
            code,
            ErrorStage::Execute,
            true,
            SideEffect::None,
            "native result",
        );
        assert_eq!(
            error.retryable,
            matches!(code, ErrorCode::IoError | ErrorCode::DeadlineExceeded)
        );
        roundtrip(&error);
        for side_effect in [
            SideEffect::Partial,
            SideEffect::Complete,
            SideEffect::Unknown,
        ] {
            let error = AutomationError::new(
                code,
                ErrorStage::Execute,
                true,
                side_effect,
                "physical effect",
            );
            assert!(!error.retryable);
        }
    }
}

fn running() -> (OperationRegistry, QueuedRequest) {
    let mut arbiter = arbiter();
    let actor = session("alice");
    let lease = arbiter.acquire(&actor, options(100), 0).unwrap();
    let request = request(&lease, "r1");
    let mut ledger = OperationRegistry::new(epoch());
    ledger
        .accept(
            &actor,
            request.key.request_id.clone(),
            request.payload_hash,
            5,
            0,
        )
        .unwrap();
    ledger.mark_queued(&request.key, 1).unwrap();
    ledger
        .begin_execution(&mut arbiter, &actor, &request, 2)
        .unwrap();
    (ledger, request)
}

#[test]
fn identities_and_wire_fields_are_unambiguous() {
    let value = serde_json::to_value(port()).unwrap();
    assert_eq!(value["hostId"], "host-a");
    assert_eq!(value["nativePortId"], "COM3");
    assert!(value.get("portId").is_none());
    roundtrip(&port());
    roundtrip(&session("alice"));
    roundtrip(&PayloadHash::of(b"payload"));
    assert_ne!(PayloadHash::of(b"payload"), PayloadHash::of(b"payload2"));
    assert_eq!(PayloadHash::of(b"abc").0[..4], [0xba, 0x78, 0x16, 0xbf]);
}

#[test]
fn scope_is_host_qualified_and_empty_scope_denies_all() {
    let mut other = port();
    other.host_id = HostId::from("host-b");
    let scope = PortScope::Only(BTreeSet::from([port()]));
    assert!(scope.allows(&port()));
    assert!(!scope.allows(&other));
    assert!(!PortScope::Only(BTreeSet::new()).allows(&port()));
    let mut actor = session("alice");
    actor.port_scope = PortScope::Only(BTreeSet::from([other]));
    assert_code(
        arbiter().acquire(&actor, options(100), 0),
        ErrorCode::PortOutOfScope,
    );
}

#[test]
fn acquisition_requires_current_epoch_permissions_and_positive_ttl() {
    let mut actor = session("alice");
    actor.server_epoch = ServerEpoch::from("old");
    assert_code(
        arbiter().acquire(&actor, options(100), 0),
        ErrorCode::EpochMismatch,
    );
    actor.server_epoch = epoch();
    actor.permissions.remove(&Permission::Write);
    assert_code(
        arbiter().acquire(&actor, options(100), 0),
        ErrorCode::PermissionDenied,
    );
    actor = session("alice");
    assert_code(
        arbiter().acquire(&actor, options(0), 0),
        ErrorCode::InvalidArgument,
    );
    assert_code(
        arbiter().acquire(&actor, options(2), u64::MAX - 1),
        ErrorCode::CounterExhausted,
    );
    let invalid = LeaseOptions {
        ttl_ms: 1,
        permissions: BTreeSet::from([Permission::Observe]),
    };
    assert_code(
        arbiter().acquire(&actor, invalid, 0),
        ErrorCode::InvalidArgument,
    );
}

#[test]
fn single_writer_and_release_reacquire_monotonic_fence() {
    let mut arbiter = arbiter();
    let alice = session("alice");
    let bob = session("bob");
    let first = arbiter.acquire(&alice, options(100), 0).unwrap();
    assert_eq!(arbiter.effective_writer(0), Some(&first));
    assert_code(
        arbiter.acquire(&alice, options(100), 1),
        ErrorCode::LeaseBusy,
    );
    assert_code(arbiter.acquire(&bob, options(100), 1), ErrorCode::LeaseBusy);
    assert_code(
        arbiter.release(&bob, &first.fence, 2),
        ErrorCode::HolderMismatch,
    );
    arbiter.release(&alice, &first.fence, 2).unwrap();
    assert!(arbiter.effective_writer(2).is_none());
    let second = arbiter.acquire(&bob, options(100), 2).unwrap();
    assert!(second.fence.fencing_token > first.fence.fencing_token);
    assert_ne!(second.lease_id, first.lease_id);
    assert_eq!(second.port_scope, PortScope::Only(BTreeSet::from([port()])));
    roundtrip(&first);
    roundtrip(arbiter.state());
}

#[test]
fn lease_ids_do_not_collide_between_ports() {
    let alice = session("alice");
    let first = arbiter().acquire(&alice, options(100), 0).unwrap();
    let mut other_port = port();
    other_port.native_port_id = "COM4".into();
    let second = PortArbiter::new(other_port, epoch(), ConnectionGeneration(1))
        .acquire(&alice, options(100), 0)
        .unwrap();
    assert_ne!(first.lease_id, second.lease_id);
}

#[test]
fn renewal_keeps_fence_but_respects_exact_expiry_boundary() {
    let mut arbiter = arbiter();
    let alice = session("alice");
    let first = arbiter.acquire(&alice, options(10), 0).unwrap();
    let renewed = arbiter.renew(&alice, &first.fence, 20, 9).unwrap();
    assert_eq!(renewed.fence, first.fence);
    assert_eq!(renewed.lease_id, first.lease_id);
    assert_eq!(renewed.expires_at_ms, 29);
    assert_eq!(renewed.granted_at_ms, 0);
    assert!(arbiter.effective_writer(28).is_some());
    assert!(arbiter.effective_writer(29).is_none());
    assert_code(
        arbiter.renew(&alice, &first.fence, 20, 29),
        ErrorCode::LeaseExpired,
    );
    assert!(matches!(arbiter.state(), WriterState::Vacant));
}

#[test]
fn revoked_holder_cannot_renew_or_execute_but_can_release() {
    let mut arbiter = arbiter();
    let mut alice = session("alice");
    let lease = arbiter.acquire(&alice, options(100), 0).unwrap();
    let queued = arbiter
        .queue_request(&alice, request(&lease, "r"), 1)
        .unwrap();
    alice.permissions.remove(&Permission::Write);
    assert_code(
        arbiter.renew(&alice, &lease.fence, 100, 2),
        ErrorCode::PermissionDenied,
    );
    assert_code(
        arbiter.begin_execution(&alice, &queued, 2),
        ErrorCode::PermissionDenied,
    );
    arbiter.release(&alice, &lease.fence, 3).unwrap();
}

#[test]
fn queue_is_not_authority_after_release_and_reacquire() {
    let mut arbiter = arbiter();
    let alice = session("alice");
    let lease = arbiter.acquire(&alice, options(100), 0).unwrap();
    let queued = arbiter
        .queue_request(&alice, request(&lease, "r"), 1)
        .unwrap();
    arbiter.release(&alice, &lease.fence, 2).unwrap();
    arbiter.acquire(&alice, options(100), 3).unwrap();
    assert_code(
        arbiter.begin_execution(&alice, &queued, 4),
        ErrorCode::FenceMismatch,
    );
    assert!(arbiter.in_flight().is_none());
}

#[test]
fn queued_requests_expire_at_execute_time() {
    let mut arbiter = arbiter();
    let alice = session("alice");
    let lease = arbiter.acquire(&alice, options(10), 0).unwrap();
    let queued = arbiter
        .queue_request(&alice, request(&lease, "r"), 9)
        .unwrap();
    let error = arbiter.begin_execution(&alice, &queued, 10).unwrap_err();
    assert_eq!(error.code, ErrorCode::LeaseExpired);
    assert_eq!(error.stage, ErrorStage::Execute);
    assert_eq!(error.side_effect, SideEffect::None);
    assert!(matches!(arbiter.state(), WriterState::Vacant));
}

#[test]
fn all_fence_dimensions_are_validated_at_execution() {
    let alice = session("alice");
    let mut arbiter = arbiter();
    let lease = arbiter.acquire(&alice, options(100), 0).unwrap();
    let original = request(&lease, "r");
    let mut changed = original.clone();
    changed.fence.port.host_id = HostId::from("other");
    assert_code(
        arbiter.begin_execution(&alice, &changed, 1),
        ErrorCode::WrongHost,
    );
    changed = original.clone();
    changed.fence.port.native_port_id = "COM4".into();
    assert_code(
        arbiter.begin_execution(&alice, &changed, 1),
        ErrorCode::PortOutOfScope,
    );
    changed = original.clone();
    changed.fence.server_epoch = ServerEpoch::from("old");
    assert_code(
        arbiter.begin_execution(&alice, &changed, 1),
        ErrorCode::EpochMismatch,
    );
    changed = original.clone();
    changed.fence.connection_generation = ConnectionGeneration(0);
    assert_code(
        arbiter.begin_execution(&alice, &changed, 1),
        ErrorCode::GenerationMismatch,
    );
    changed = original.clone();
    changed.fence.fencing_token = FencingToken(999);
    assert_code(
        arbiter.begin_execution(&alice, &changed, 1),
        ErrorCode::FenceMismatch,
    );
    changed = original.clone();
    changed.key.principal_id = PrincipalId::from("bob");
    assert_code(
        arbiter.begin_execution(&alice, &changed, 1),
        ErrorCode::HolderMismatch,
    );
    changed = original.clone();
    changed.required_permission = Permission::Observe;
    assert_code(
        arbiter.begin_execution(&alice, &changed, 1),
        ErrorCode::PermissionDenied,
    );
    let mut reconnected = alice.clone();
    reconnected.id = ClientSessionId::from("new-session");
    assert_code(
        arbiter.begin_execution(&reconnected, &original, 1),
        ErrorCode::HolderMismatch,
    );
    let mut scoped = alice.clone();
    scoped.port_scope = PortScope::Only(BTreeSet::new());
    assert_code(
        arbiter.begin_execution(&scoped, &original, 1),
        ErrorCode::PortOutOfScope,
    );
}

#[test]
fn one_physical_execution_and_matching_completion_only() {
    let alice = session("alice");
    let mut arbiter = arbiter();
    let lease = arbiter.acquire(&alice, options(100), 0).unwrap();
    let queued = request(&lease, "r");
    let first = arbiter.begin_execution(&alice, &queued, 1).unwrap();
    assert_code(
        arbiter.begin_execution(&alice, &queued, 2),
        ErrorCode::LeaseBusy,
    );
    let mut fake = first.clone();
    fake.execution_id = ExecutionId(999);
    assert_code(arbiter.complete_execution(&fake), ErrorCode::FenceMismatch);
    assert!(arbiter.in_flight().is_some());
    arbiter.complete_execution(&first).unwrap();
    let second = arbiter.begin_execution(&alice, &queued, 2).unwrap();
    assert!(second.execution_id > first.execution_id);
    assert_code(arbiter.complete_execution(&first), ErrorCode::FenceMismatch);
    arbiter.complete_execution(&second).unwrap();
    assert_code(
        arbiter.complete_execution(&second),
        ErrorCode::FenceMismatch,
    );
    roundtrip(&first);
}

#[test]
fn takeover_freezes_old_writer_waits_for_physical_drain_then_grants_new() {
    let mut arbiter = arbiter();
    let alice = session("alice");
    let bob = session("bob");
    let old = arbiter.acquire(&alice, options(100), 0).unwrap();
    let queued = arbiter
        .queue_request(&alice, request(&old, "r"), 1)
        .unwrap();
    let permit = arbiter.begin_execution(&alice, &queued, 1).unwrap();
    let pending = arbiter
        .begin_takeover(&bob, &old.fence, options(100), 2)
        .unwrap();
    assert!(pending.fence.fencing_token > old.fence.fencing_token);
    assert!(arbiter.effective_writer(2).is_none());
    assert_code(
        arbiter.begin_execution(&alice, &queued, 2),
        ErrorCode::Draining,
    );
    assert_code(arbiter.acquire(&bob, options(100), 2), ErrorCode::Draining);
    assert_eq!(
        arbiter.drain().unwrap(),
        DrainStatus::Pending {
            request: queued.key.clone()
        }
    );
    assert_code(
        arbiter.finish_takeover(&bob, &pending.fence, 3),
        ErrorCode::DrainPending,
    );
    arbiter.complete_execution(&permit).unwrap();
    assert_code(
        arbiter.finish_takeover(&bob, &pending.fence, 4),
        ErrorCode::DrainPending,
    );
    assert_eq!(arbiter.drain().unwrap(), DrainStatus::Drained);
    let new = arbiter.finish_takeover(&bob, &pending.fence, 5).unwrap();
    assert_eq!(new.expires_at_ms, 105);
    assert_eq!(new.fence.holder, bob.holder());
    assert_code(
        arbiter.begin_execution(&alice, &queued, 5),
        ErrorCode::FenceMismatch,
    );
    arbiter
        .begin_execution(&bob, &request(&new, "new"), 6)
        .unwrap();
    roundtrip(&pending);
}

#[test]
fn takeover_requires_permission_cas_and_live_authorization() {
    let mut arbiter = arbiter();
    let alice = session("alice");
    let mut bob = session("bob");
    let old = arbiter.acquire(&alice, options(100), 0).unwrap();
    bob.permissions.remove(&Permission::Takeover);
    assert_code(
        arbiter.begin_takeover(&bob, &old.fence, options(100), 1),
        ErrorCode::PermissionDenied,
    );
    bob.permissions.insert(Permission::Takeover);
    let mut stale = old.fence.clone();
    stale.fencing_token = FencingToken(0);
    assert_code(
        arbiter.begin_takeover(&bob, &stale, options(100), 1),
        ErrorCode::FenceMismatch,
    );
    let pending = arbiter
        .begin_takeover(&bob, &old.fence, options(100), 1)
        .unwrap();
    arbiter.drain().unwrap();
    assert_code(
        arbiter.finish_takeover(&alice, &pending.fence, 2),
        ErrorCode::HolderMismatch,
    );
    bob.permissions.remove(&Permission::Takeover);
    assert_code(
        arbiter.finish_takeover(&bob, &pending.fence, 2),
        ErrorCode::PermissionDenied,
    );
    assert!(arbiter.effective_writer(2).is_none());
}

#[test]
fn expiry_and_release_never_fake_physical_completion() {
    for release in [false, true] {
        let mut arbiter = arbiter();
        let alice = session("alice");
        let lease = arbiter.acquire(&alice, options(10), 0).unwrap();
        let permit = arbiter
            .begin_execution(&alice, &request(&lease, "r"), 1)
            .unwrap();
        if release {
            arbiter.release(&alice, &lease.fence, 2).unwrap();
        } else {
            assert!(arbiter.expire(10).unwrap());
        }
        assert!(arbiter.effective_writer(10).is_none());
        assert_code(
            arbiter.acquire(&session("bob"), options(100), 10),
            ErrorCode::Draining,
        );
        assert!(matches!(
            arbiter.drain().unwrap(),
            DrainStatus::Pending { .. }
        ));
        arbiter.complete_execution(&permit).unwrap();
        arbiter.drain().unwrap();
        arbiter.acquire(&session("bob"), options(100), 11).unwrap();
    }
}

#[test]
fn abandoned_takeover_expires_without_reviving_old_lease() {
    let mut arbiter = arbiter();
    let alice = session("alice");
    let bob = session("bob");
    let old = arbiter.acquire(&alice, options(1000), 0).unwrap();
    let pending = arbiter
        .begin_takeover(&bob, &old.fence, options(10), 1)
        .unwrap();
    arbiter.drain().unwrap();
    assert!(arbiter.expire(11).unwrap());
    assert!(matches!(arbiter.state(), WriterState::Vacant));
    assert_code(
        arbiter.finish_takeover(&bob, &pending.fence, 11),
        ErrorCode::TakeoverMissing,
    );
    let next = arbiter.acquire(&alice, options(10), 11).unwrap();
    assert!(next.fence.fencing_token > pending.fence.fencing_token);
}

#[test]
fn abandoned_takeover_with_inflight_remains_draining() {
    let mut arbiter = arbiter();
    let alice = session("alice");
    let old = arbiter.acquire(&alice, options(1000), 0).unwrap();
    let permit = arbiter
        .begin_execution(&alice, &request(&old, "r"), 0)
        .unwrap();
    arbiter
        .begin_takeover(&session("bob"), &old.fence, options(10), 1)
        .unwrap();
    arbiter.expire(11).unwrap();
    assert!(matches!(
        arbiter.state(),
        WriterState::Draining { pending: None, .. }
    ));
    assert_code(
        arbiter.acquire(&alice, options(10), 11),
        ErrorCode::Draining,
    );
    arbiter.complete_execution(&permit).unwrap();
    arbiter.drain().unwrap();
    assert!(matches!(arbiter.state(), WriterState::Vacant));
}

#[test]
fn reconnect_invalidates_queued_work_and_cannot_skip_drain() {
    let mut arbiter = arbiter();
    let alice = session("alice");
    let old = arbiter.acquire(&alice, options(100), 0).unwrap();
    let queued = request(&old, "r");
    let permit = arbiter.begin_execution(&alice, &queued, 1).unwrap();
    assert_code(
        arbiter.change_generation(ConnectionGeneration(2), 1),
        ErrorCode::DrainPending,
    );
    arbiter.release(&alice, &old.fence, 2).unwrap();
    arbiter.complete_execution(&permit).unwrap();
    assert_code(
        arbiter.change_generation(ConnectionGeneration(2), 2),
        ErrorCode::DrainPending,
    );
    arbiter.drain().unwrap();
    arbiter
        .change_generation(ConnectionGeneration(2), 3)
        .unwrap();
    arbiter.acquire(&alice, options(100), 3).unwrap();
    assert_code(
        arbiter.begin_execution(&alice, &queued, 4),
        ErrorCode::GenerationMismatch,
    );
    assert_code(
        arbiter.change_generation(ConnectionGeneration(2), 4),
        ErrorCode::GenerationMismatch,
    );
    assert_code(
        arbiter.change_generation(ConnectionGeneration(1), 4),
        ErrorCode::GenerationMismatch,
    );
}

#[test]
fn clocks_and_counters_fail_closed() {
    let mut arbiter = arbiter();
    let alice = session("alice");
    arbiter.expire(10).unwrap();
    assert_code(
        arbiter.acquire(&alice, options(10), 9),
        ErrorCode::ClockRegression,
    );
    arbiter.next_fence = u64::MAX;
    assert_code(
        arbiter.acquire(&alice, options(10), 10),
        ErrorCode::CounterExhausted,
    );
    assert!(matches!(arbiter.state(), WriterState::Vacant));
    arbiter.next_fence = 0;
    let lease = arbiter.acquire(&alice, options(10), 10).unwrap();
    arbiter.next_execution = u64::MAX;
    assert_code(
        arbiter.begin_execution(&alice, &request(&lease, "r"), 10),
        ErrorCode::CounterExhausted,
    );
    assert!(arbiter.in_flight().is_none());
    assert!(arbiter.effective_writer(9).is_none());
}

#[test]
fn dedupe_survives_client_reconnect_and_rejects_changed_hash() {
    let mut ledger = OperationRegistry::new(epoch());
    let alice = session("alice");
    let first = ledger
        .accept(&alice, RequestId::from("r"), PayloadHash::of(b"a"), 1, 0)
        .unwrap();
    assert!(matches!(first, AcceptOutcome::Accepted(_)));
    let mut reconnected = alice.clone();
    reconnected.id = ClientSessionId::from("new");
    let duplicate = ledger
        .accept(
            &reconnected,
            RequestId::from("r"),
            PayloadHash::of(b"a"),
            1,
            1,
        )
        .unwrap();
    assert!(matches!(duplicate, AcceptOutcome::Duplicate(_)));
    assert_eq!(first.record(), duplicate.record());
    assert_code(
        ledger.accept(&alice, RequestId::from("r"), PayloadHash::of(b"b"), 1, 2),
        ErrorCode::RequestConflict,
    );
    assert_code(
        ledger.accept(&alice, RequestId::from("r"), PayloadHash::of(b"a"), 2, 2),
        ErrorCode::RequestConflict,
    );
    let other = ledger
        .accept(
            &session("bob"),
            RequestId::from("r"),
            PayloadHash::of(b"a"),
            1,
            2,
        )
        .unwrap();
    assert_ne!(first.record().operation_id, other.record().operation_id);
    roundtrip(&first);
    assert!(serde_json::to_value(&ledger).unwrap()["records"].is_array());
}

#[test]
fn atomic_ledger_execution_rejects_duplicates_and_stale_fences() {
    let mut ledger = OperationRegistry::new(epoch());
    let mut arbiter = arbiter();
    let alice = session("alice");
    let old = arbiter.acquire(&alice, options(10), 0).unwrap();
    let queued = request(&old, "r");
    ledger
        .accept(
            &alice,
            queued.key.request_id.clone(),
            queued.payload_hash,
            5,
            0,
        )
        .unwrap();
    ledger.mark_queued(&queued.key, 1).unwrap();
    assert_code(
        ledger.begin_execution(&mut arbiter, &alice, &queued, 10),
        ErrorCode::LeaseExpired,
    );
    assert_eq!(
        ledger.get(&queued.key).unwrap().status,
        OperationStatus::Queued
    );
    assert!(arbiter.in_flight().is_none());
    let new = arbiter.acquire(&alice, options(100), 10).unwrap();
    let current = request(&new, "new");
    ledger
        .accept(
            &alice,
            current.key.request_id.clone(),
            current.payload_hash,
            5,
            10,
        )
        .unwrap();
    let permit = ledger
        .begin_execution(&mut arbiter, &alice, &current, 11)
        .unwrap();
    arbiter.complete_execution(&permit).unwrap();
    assert_code(
        ledger.begin_execution(&mut arbiter, &alice, &current, 12),
        ErrorCode::InvalidTransition,
    );
    assert!(arbiter.in_flight().is_none());
}

#[test]
fn successful_operation_and_terminal_record_are_immutable() {
    let (mut ledger, queued) = running();
    ledger.record_progress(&queued.key, 3, 3).unwrap();
    ledger
        .finish(
            &queued.key,
            OperationStatus::Succeeded,
            ByteCount::exact(5),
            None,
            4,
        )
        .unwrap();
    let record = ledger.get(&queued.key).unwrap().clone();
    assert_eq!(record.status, OperationStatus::Succeeded);
    assert_eq!(record.bytes, ByteCount::exact(5));
    for terminal in [
        OperationStatus::Succeeded,
        OperationStatus::Failed,
        OperationStatus::Cancelled,
        OperationStatus::Unknown,
    ] {
        assert_code(
            ledger.finish(
                &queued.key,
                terminal,
                ByteCount::exact(5),
                Some(failure()),
                5,
            ),
            ErrorCode::InvalidTransition,
        );
    }
    assert_code(
        ledger.mark_queued(&queued.key, 5),
        ErrorCode::InvalidTransition,
    );
    assert_code(
        ledger.mark_executing(&queued, 5),
        ErrorCode::InvalidTransition,
    );
    assert_eq!(ledger.get(&queued.key), Some(&record));
    roundtrip(&record);
}

#[test]
fn partial_failure_preserves_bytes_and_disables_blind_retry() {
    let (mut ledger, queued) = running();
    ledger.record_progress(&queued.key, 2, 3).unwrap();
    ledger
        .finish(
            &queued.key,
            OperationStatus::Failed,
            ByteCount::exact(2),
            Some(failure()),
            4,
        )
        .unwrap();
    let record = ledger.get(&queued.key).unwrap();
    assert_eq!(record.bytes.known, 2);
    let failure = record.error.as_ref().unwrap();
    assert_eq!(failure.side_effect, SideEffect::Partial);
    assert!(!failure.retryable);
    roundtrip(failure);
    let json = serde_json::to_value(failure).unwrap();
    assert_eq!(json["sideEffect"], "partial");
    assert_eq!(json["code"], "invalid_argument");
    assert_eq!(json["stage"], "execute");
}

#[test]
fn zero_byte_counts_do_not_erase_non_byte_control_side_effects() {
    for side_effect in [
        SideEffect::Partial,
        SideEffect::Complete,
        SideEffect::Unknown,
    ] {
        let (mut ledger, queued) = running();
        let mut failure = failure();
        failure.side_effect = side_effect;
        ledger
            .finish(
                &queued.key,
                OperationStatus::Failed,
                ByteCount::exact(0),
                Some(failure),
                3,
            )
            .unwrap();
        let failure = ledger.get(&queued.key).unwrap().error.as_ref().unwrap();
        assert_eq!(failure.side_effect, side_effect);
        assert!(!failure.retryable);
    }
}

#[test]
fn unknown_outcome_preserves_lower_bound_instead_of_inventing_zero() {
    let (mut ledger, queued) = running();
    ledger.record_progress(&queued.key, 2, 3).unwrap();
    ledger
        .finish(
            &queued.key,
            OperationStatus::Unknown,
            ByteCount::at_least(2),
            Some(failure()),
            4,
        )
        .unwrap();
    let record = ledger.get(&queued.key).unwrap();
    assert_eq!(record.bytes, ByteCount::at_least(2));
    assert_eq!(
        record.error.as_ref().unwrap().side_effect,
        SideEffect::Unknown
    );
    assert!(!record.error.as_ref().unwrap().retryable);
    roundtrip(record);
}

#[test]
fn cancellation_distinguishes_not_started_partial_and_unknown() {
    let mut ledger = OperationRegistry::new(epoch());
    let accepted = ledger
        .accept(
            &session("alice"),
            RequestId::from("r"),
            PayloadHash::of(b"a"),
            5,
            0,
        )
        .unwrap();
    ledger
        .finish(
            &accepted.record().key,
            OperationStatus::Cancelled,
            ByteCount::exact(0),
            None,
            1,
        )
        .unwrap();
    assert_eq!(
        ledger
            .get(&accepted.record().key)
            .unwrap()
            .bytes
            .side_effect(5),
        SideEffect::None
    );
    let (mut ledger, queued) = running();
    assert_code(
        ledger.finish(
            &queued.key,
            OperationStatus::Cancelled,
            ByteCount::at_least(2),
            None,
            3,
        ),
        ErrorCode::InvalidTransition,
    );
    ledger
        .finish(
            &queued.key,
            OperationStatus::Cancelled,
            ByteCount::exact(2),
            None,
            3,
        )
        .unwrap();
    assert_eq!(
        ledger.get(&queued.key).unwrap().bytes.side_effect(5),
        SideEffect::Partial
    );
}

#[test]
fn invalid_operation_transitions_and_byte_counts_do_not_mutate() {
    let (mut ledger, queued) = running();
    ledger.record_progress(&queued.key, 2, 3).unwrap();
    let before = ledger.get(&queued.key).unwrap().clone();
    assert_code(
        ledger.record_progress(&queued.key, 1, 4),
        ErrorCode::InvalidTransition,
    );
    assert_code(
        ledger.record_progress(&queued.key, 6, 4),
        ErrorCode::InvalidTransition,
    );
    assert_code(
        ledger.record_progress(&queued.key, 3, 2),
        ErrorCode::ClockRegression,
    );
    for (status, bytes, failure) in [
        (OperationStatus::Succeeded, ByteCount::exact(4), None),
        (OperationStatus::Succeeded, ByteCount::at_least(5), None),
        (OperationStatus::Failed, ByteCount::exact(2), None),
        (
            OperationStatus::Unknown,
            ByteCount::exact(2),
            Some(failure()),
        ),
        (OperationStatus::Queued, ByteCount::exact(2), None),
        (
            OperationStatus::Failed,
            ByteCount::exact(1),
            Some(failure()),
        ),
    ] {
        assert_code(
            ledger.finish(&queued.key, status, bytes, failure, 4),
            ErrorCode::InvalidTransition,
        );
    }
    assert_eq!(ledger.get(&queued.key), Some(&before));
}

#[test]
fn pre_execution_failures_cannot_claim_physical_bytes() {
    let mut ledger = OperationRegistry::new(epoch());
    let accepted = ledger
        .accept(
            &session("alice"),
            RequestId::from("r"),
            PayloadHash::of(b"a"),
            5,
            0,
        )
        .unwrap();
    let key = &accepted.record().key;
    assert_code(
        ledger.finish(
            key,
            OperationStatus::Failed,
            ByteCount::exact(1),
            Some(failure()),
            1,
        ),
        ErrorCode::InvalidTransition,
    );
    assert_code(
        ledger.finish(
            key,
            OperationStatus::Unknown,
            ByteCount::at_least(0),
            Some(failure()),
            1,
        ),
        ErrorCode::InvalidTransition,
    );
    assert_code(
        ledger.finish(
            key,
            OperationStatus::Succeeded,
            ByteCount::exact(5),
            None,
            1,
        ),
        ErrorCode::InvalidTransition,
    );
    ledger
        .finish(
            key,
            OperationStatus::Failed,
            ByteCount::exact(0),
            Some(failure()),
            1,
        )
        .unwrap();
    assert_eq!(
        ledger.get(key).unwrap().error.as_ref().unwrap().side_effect,
        SideEffect::None
    );
}

#[test]
fn ledger_epoch_hash_and_counter_boundaries_fail_closed() {
    let mut ledger = OperationRegistry::new(epoch());
    let mut alice = session("alice");
    alice.server_epoch = ServerEpoch::from("old");
    assert_code(
        ledger.accept(&alice, RequestId::from("r"), PayloadHash::of(b"a"), 1, 0),
        ErrorCode::EpochMismatch,
    );
    ledger.next_operation = u64::MAX;
    assert_code(
        ledger.accept(
            &session("alice"),
            RequestId::from("r"),
            PayloadHash::of(b"a"),
            1,
            0,
        ),
        ErrorCode::CounterExhausted,
    );
    let (mut ledger, mut queued) = running();
    queued.payload_hash = PayloadHash::of(b"different");
    assert_code(
        ledger.mark_executing(&queued, 3),
        ErrorCode::RequestConflict,
    );
    assert_code(
        ledger.mark_queued(
            &RequestKey {
                principal_id: PrincipalId::from("nobody"),
                request_id: RequestId::from("nope"),
            },
            3,
        ),
        ErrorCode::OperationMissing,
    );
}

fn ring(capacity: usize) -> EventRing<u32> {
    EventRing::new(HostId::from("host-a"), epoch(), capacity).unwrap()
}
fn event_sequences(replay: &Replay<u32>) -> Vec<u64> {
    match replay {
        Replay::Events { events, .. } => {
            events.iter().map(|event| event.cursor.sequence.0).collect()
        }
        other => panic!("expected events, got {other:?}"),
    }
}

#[test]
fn empty_ring_and_capacity_validation() {
    assert_code(
        EventRing::<u32>::new(HostId::from("h"), epoch(), 0),
        ErrorCode::InvalidArgument,
    );
    let ring = ring(2);
    assert!(ring.is_empty());
    assert_eq!(ring.len(), 0);
    assert_eq!(ring.watermark().sequence, Sequence(0));
    assert!(event_sequences(&ring.read_after(&ring.watermark(), 1).unwrap()).is_empty());
    assert_code(
        ring.read_after(&ring.watermark(), 0),
        ErrorCode::InvalidArgument,
    );
}

#[test]
fn bounded_ring_reports_exact_gap_and_retained_boundary() {
    let mut ring = ring(2);
    let zero = ring.watermark();
    let one = ring.push(11).unwrap();
    ring.push(22).unwrap();
    ring.push(33).unwrap();
    assert_eq!(ring.len(), 2);
    let replay = ring.read_after(&zero, 10).unwrap();
    match &replay {
        Replay::Gap {
            requested,
            oldest_available,
            watermark,
        } => {
            assert_eq!(requested.sequence, Sequence(0));
            assert_eq!(oldest_available.sequence, Sequence(2));
            assert_eq!(watermark.sequence, Sequence(3));
        }
        _ => panic!("expected gap"),
    }
    assert_eq!(event_sequences(&ring.read_after(&one, 10).unwrap()), [2, 3]);
    assert!(serde_json::to_value(&replay)
        .unwrap()
        .get("oldestAvailable")
        .is_some());
    roundtrip(&replay);
}

#[test]
fn cursor_expiration_host_mismatch_and_future_are_distinct() {
    let ring = ring(2);
    let mut cursor = ring.watermark();
    cursor.server_epoch = ServerEpoch::from("old");
    let expired = ring.read_after(&cursor, 1).unwrap();
    assert!(matches!(expired, Replay::Expired { .. }));
    roundtrip(&expired);
    cursor.host_id = HostId::from("other-host");
    assert_code(ring.read_after(&cursor, 1), ErrorCode::WrongHost);
    cursor = ring.watermark();
    cursor.sequence = Sequence(1);
    assert_code(ring.read_after(&cursor, 1), ErrorCode::CursorAhead);
}

#[test]
fn snapshot_watermark_handoff_pages_then_goes_live_without_loss_or_duplicates() {
    let mut ring = ring(20);
    ring.push(1).unwrap();
    let snapshot = ring.snapshot(vec!["state at event 1".to_owned()]);
    let mut live = LiveSubscription::from_snapshot(&snapshot);
    ring.push(2).unwrap();
    ring.push(3).unwrap();
    ring.push(4).unwrap();
    let first = live.poll(&ring, 2).unwrap();
    assert_eq!(event_sequences(&first), [2, 3]);
    assert_eq!(live.cursor().sequence, Sequence(3));
    if let Replay::Events { watermark, .. } = first {
        assert_eq!(watermark.sequence, Sequence(4));
    }
    ring.push(5).unwrap();
    assert_eq!(event_sequences(&live.poll(&ring, 2).unwrap()), [4, 5]);
    assert!(event_sequences(&live.poll(&ring, 2).unwrap()).is_empty());
    ring.push(6).unwrap();
    assert_eq!(event_sequences(&live.poll(&ring, 2).unwrap()), [6]);
    roundtrip(&snapshot);
    roundtrip(&live);
}

#[test]
fn slow_snapshot_handoff_does_not_silently_skip_gap_or_epoch() {
    let mut ring = ring(1);
    let snapshot = ring.snapshot(());
    let mut live = LiveSubscription::from_snapshot(&snapshot);
    ring.push(1).unwrap();
    ring.push(2).unwrap();
    assert!(matches!(live.poll(&ring, 10).unwrap(), Replay::Gap { .. }));
    assert_eq!(live.cursor(), &snapshot.watermark);
    let rebooted =
        EventRing::<u32>::new(HostId::from("host-a"), ServerEpoch::from("boot-b"), 1).unwrap();
    assert!(matches!(
        live.poll(&rebooted, 10).unwrap(),
        Replay::Expired { .. }
    ));
    assert_eq!(live.cursor(), &snapshot.watermark);
}

#[test]
fn event_sequence_exhaustion_never_wraps_or_evicts() {
    let mut ring = ring(1);
    ring.push(1).unwrap();
    ring.sequence = Sequence(u64::MAX);
    assert_code(ring.push(2), ErrorCode::CounterExhausted);
    assert_eq!(ring.sequence, Sequence(u64::MAX));
    assert_eq!(ring.events.front().unwrap().payload, 1);
}

#[test]
fn serializable_authoritative_snapshots_use_json_compatible_shapes() {
    let actor = session("alice");
    let mut arbiter = arbiter();
    let lease = arbiter.acquire(&actor, options(100), 0).unwrap();
    arbiter
        .begin_execution(&actor, &request(&lease, "r"), 1)
        .unwrap();
    assert!(serde_json::to_string(&arbiter)
        .unwrap()
        .contains("connectionGeneration"));
    let (ledger, _) = running();
    assert!(serde_json::to_string(&ledger)
        .unwrap()
        .contains("operationId"));
    let mut ring = ring(2);
    ring.push(1).unwrap();
    assert!(serde_json::to_string(&ring)
        .unwrap()
        .contains("serverEpoch"));
    roundtrip(&EventCursor {
        host_id: HostId::from("h"),
        server_epoch: epoch(),
        sequence: Sequence(u64::MAX),
    });
    roundtrip(&ByteCount {
        known: 2,
        certainty: ByteCertainty::AtLeast,
    });
}

#[test]
fn deterministic_action_sequences_preserve_single_effective_writer() {
    let mut arbiter = arbiter();
    let actors = [session("alice"), session("bob")];
    let mut seed = 7_u64;
    for now in 0..1000 {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        let actor = &actors[(seed as usize >> 8) % 2];
        let active = match arbiter.state() {
            WriterState::Active { lease } => Some(lease.clone()),
            _ => None,
        };
        match seed % 9 {
            0 => {
                let _ = arbiter.acquire(actor, options(10), now);
            }
            1 => {
                if let Some(lease) = active {
                    let _ = arbiter.renew(actor, &lease.fence, 10, now);
                }
            }
            2 => {
                if let Some(lease) = active {
                    let _ = arbiter.release(actor, &lease.fence, now);
                }
            }
            3 => {
                if let Some(lease) = active {
                    let _ = arbiter.begin_takeover(actor, &lease.fence, options(10), now);
                }
            }
            4 => {
                let _ = arbiter.drain();
            }
            5 => {
                let pending = match arbiter.state() {
                    WriterState::Draining { pending, .. } => pending.clone(),
                    _ => None,
                };
                if let Some(pending) = pending {
                    let _ = arbiter.finish_takeover(actor, &pending.fence, now);
                }
            }
            6 => {
                if let Some(lease) = active {
                    let _ = arbiter.begin_execution(actor, &request(&lease, "r"), now);
                }
            }
            7 => {
                if let Some(permit) = arbiter.in_flight().cloned() {
                    arbiter.complete_execution(&permit).unwrap();
                }
            }
            _ => {
                arbiter.expire(now).unwrap();
            }
        }
        if let Some(effective) = arbiter.effective_writer(now) {
            if let Some(permit) = arbiter.in_flight() {
                assert_eq!(effective.fence, permit.request.fence);
            }
        }
        if matches!(arbiter.state(), WriterState::Vacant) {
            assert!(arbiter.in_flight().is_none());
        }
        if let WriterState::Draining { drained: true, .. } = arbiter.state() {
            assert!(arbiter.in_flight().is_none());
        }
    }
}
