use super::{
    digest, load_profile, save_profile, Access, Authority, ProfileStore, RemoteInvite,
    RemotePermissions, RemoteRole,
};
use crate::protocol::HostError;
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("hc-auth-{}", uuid::Uuid::new_v4()));
        Self(path)
    }

    fn authority(&self) -> Authority {
        Authority::open(&self.0.join("authority"), "127.0.0.1:24680".into()).unwrap()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn permission(role: RemoteRole, allow_loan: bool) -> RemotePermissions {
    RemotePermissions {
        role,
        ports: vec!["COM7".into()],
        allow_loan,
        automation: false,
        device_plugins: false,
        device_tools: false,
    }
}

fn err_code<T>(result: Result<T, HostError>) -> String {
    result.err().expect("expected failure").code
}

#[test]
fn expired_guessed_and_reused_invites_are_indistinguishable_and_not_disclosed_in_debug() {
    let scratch = Scratch::new();
    let auth = scratch.authority();
    let expired = auth
        .invite(
            "expired".into(),
            permission(RemoteRole::Observe, false),
            Some(1000),
        )
        .unwrap();
    auth.registry
        .lock()
        .unwrap()
        .invitations
        .get_mut(&digest(expired.code.as_bytes()))
        .unwrap()
        .expires = Instant::now() - Duration::from_millis(1);
    assert_eq!(err_code(auth.pair(&expired.code)), "invalid_invite");
    assert_eq!(err_code(auth.pair(&"x".repeat(43))), "invalid_invite");

    let active = auth
        .invite("fixture".into(), permission(RemoteRole::Write, false), None)
        .unwrap();
    assert!(!format!("{active:?}").contains(&active.code));
    assert_eq!(active.label.as_deref(), Some("fixture"));
    assert_eq!(active.ports, vec!["COM7"]);
    assert_eq!(active.role, Some(RemoteRole::Write));
    assert!(!active.allow_loan);

    // Inspecting invite JSON does not consume it.
    let invite_json = serde_json::to_string(&active).unwrap();
    let inspected = RemoteInvite::parse(&invite_json).unwrap();
    assert_eq!(inspected.server_id, active.server_id);
    assert_eq!(inspected.ports, vec!["COM7"]);

    let pair = auth.pair(&active.code).unwrap();
    assert!(!format!("{pair:?}").contains(&pair.token));
    assert_eq!(err_code(auth.pair(&active.code)), "invalid_invite");
    assert_eq!(
        err_code(auth.authenticate(&pair.client_id, &"x".repeat(43))),
        "unauthorized"
    );
}

#[test]
fn durable_profile_uses_same_stable_pin_after_restart_and_revocation_persists() {
    let scratch = Scratch::new();
    let auth = scratch.authority();
    assert!(Authority::open(&scratch.0.join("authority"), "127.0.0.1:24681".into()).is_err());

    let profile = auth
        .pair(
            &auth
                .invite(
                    "workstation".into(),
                    permission(RemoteRole::Control, true),
                    None,
                )
                .unwrap()
                .code,
        )
        .unwrap();
    assert_ne!(profile.token.len(), 0);
    assert!(profile.permissions.allow_loan);

    let path = scratch.0.join("profiles").join("workstation");
    save_profile(&path, &profile).unwrap();
    let restored = load_profile(&path).unwrap();
    assert_eq!(restored.token, profile.token);
    assert!(restored.permissions.allow_loan);
    drop(auth);

    let auth = scratch.authority();
    assert_eq!(auth.server_id(), restored.server_id);
    assert_eq!(
        auth.status().certificate_sha256,
        restored.certificate_sha256
    );
    let peer = auth
        .authenticate(&restored.client_id, &restored.token)
        .unwrap();
    let signal = peer.revoked();
    let revoked_dto = auth.revoke(&restored.client_id).unwrap();
    assert!(revoked_dto.revoked);
    assert!(*signal.borrow());
    assert_eq!(err_code(peer.require_active()), "revoked");
    drop(auth);

    let auth = scratch.authority();
    assert_eq!(
        err_code(auth.authenticate(&restored.client_id, &restored.token)),
        "revoked"
    );
    assert_eq!(auth.list().len(), 1);
    drop(auth);

    fs::write(
        scratch.0.join("authority/grants.protected"),
        b"not a trust roster",
    )
    .unwrap();
    assert!(Authority::open(&scratch.0.join("authority"), "127.0.0.1:24680".into()).is_err());
}

#[test]
fn acl_and_allow_loan_enforced_per_port_and_role() {
    let scratch = Scratch::new();
    let auth = scratch.authority();
    let write = auth
        .pair(
            &auth
                .invite("writer".into(), permission(RemoteRole::Write, false), None)
                .unwrap()
                .code,
        )
        .unwrap();
    let control_no_loan = auth
        .pair(
            &auth
                .invite(
                    "ctrl-noloan".into(),
                    permission(RemoteRole::Control, false),
                    None,
                )
                .unwrap()
                .code,
        )
        .unwrap();
    let control_with_loan = auth
        .pair(
            &auth
                .invite(
                    "ctrl-loan".into(),
                    permission(RemoteRole::Control, true),
                    None,
                )
                .unwrap()
                .code,
        )
        .unwrap();

    let writer_peer = auth.authenticate(&write.client_id, &write.token).unwrap();
    let no_loan_peer = auth
        .authenticate(&control_no_loan.client_id, &control_no_loan.token)
        .unwrap();
    let loan_peer = auth
        .authenticate(&control_with_loan.client_id, &control_with_loan.token)
        .unwrap();

    assert!(writer_peer.check(Access::Observe, Some("COM7")).is_ok());
    assert!(writer_peer.check(Access::Write, Some("COM7")).is_ok());
    for scope in [
        Access::Control,
        Access::Loan,
        Access::Automation,
        Access::DevicePlugins,
        Access::DeviceTools,
    ] {
        assert_eq!(err_code(writer_peer.check(scope, Some("COM7"))), "forbidden");
    }
    for denied in ["COM8", "dut", r"\\.\COM7"] {
        assert_eq!(
            err_code(writer_peer.check(Access::Observe, Some(denied))),
            "forbidden"
        );
    }

    assert!(no_loan_peer.check(Access::Control, Some("COM7")).is_ok());
    assert_eq!(
        err_code(no_loan_peer.check(Access::Loan, Some("COM7"))),
        "forbidden"
    );

    assert!(loan_peer.check(Access::Control, Some("COM7")).is_ok());
    assert!(loan_peer.check(Access::Loan, Some("COM7")).is_ok());
    assert_eq!(
        err_code(loan_peer.check(Access::Loan, Some("COM8"))),
        "forbidden"
    );

    // allow_loan requires Control role at invite creation time.
    for role in [RemoteRole::Observe, RemoteRole::Write] {
        assert_eq!(
            err_code(auth.invite("bad-loan".into(), permission(role, true), None)),
            "invalid_request"
        );
    }

    // Invalid port lists rejected.
    for forbidden in [
        vec![],
        vec!["*".to_string()],
        vec!["COM7".into(), "com07".into()],
        vec!["remote::p::COM7".into()],
    ] {
        assert_eq!(
            err_code(auth.invite(
                "bad".into(),
                RemotePermissions {
                    ports: forbidden,
                    ..permission(RemoteRole::Control, false)
                },
                None
            )),
            "invalid_request"
        );
    }

    auth.revoke(&write.client_id).unwrap();
    assert_eq!(
        err_code(writer_peer.check(Access::Write, Some("COM7"))),
        "revoked"
    );
    assert!(no_loan_peer.check(Access::Control, Some("COM7")).is_ok());
}

#[test]
fn profile_store_saves_lists_loads_and_removes_profiles() {
    let scratch = Scratch::new();
    let auth = scratch.authority();
    let store = ProfileStore::new(scratch.0.join("store"));
    assert!(store.list().unwrap().is_empty());

    let p1 = auth
        .pair(
            &auth
                .invite("bench-a".into(), permission(RemoteRole::Observe, false), None)
                .unwrap()
                .code,
        )
        .unwrap();
    let p2 = auth
        .pair(
            &auth
                .invite("bench-b".into(), permission(RemoteRole::Control, true), None)
                .unwrap()
                .code,
        )
        .unwrap();

    store.preflight("bench-a").unwrap();
    store.save("bench-a", &p1).unwrap();
    store.save("bench-b", &p2).unwrap();

    // Duplicate save refuses to overwrite pin silently.
    assert_eq!(err_code(store.save("bench-a", &p2)), "profile_exists");

    // Invalid profile IDs rejected.
    for bad in ["", ".hidden", "a..b", "a::b", "a/b", "a b"] {
        assert_eq!(err_code(store.path_for(bad)), "invalid_request");
    }

    let list = store.list().unwrap();
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].id, "bench-a");
    assert_eq!(list[1].id, "bench-b");
    assert!(!list[0].profile.permissions.allow_loan);
    assert!(list[1].profile.permissions.allow_loan);

    let loaded = store.load("bench-a").unwrap();
    assert_eq!(loaded.client_id, p1.client_id);

    store.remove("bench-a").unwrap();
    assert_eq!(err_code(store.load("bench-a")), "profile_not_found");
    assert_eq!(err_code(store.remove("bench-a")), "profile_not_found");
    assert_eq!(store.list().unwrap().len(), 1);
}

#[test]
fn remote_permissions_defaults_allow_loan_when_omitted() {
    let raw = r#"{"role":"control","ports":["COM7"]}"#;
    let parsed: RemotePermissions = serde_json::from_str(raw).unwrap();
    assert!(!parsed.allow_loan);
    assert!(!parsed.automation);
}
