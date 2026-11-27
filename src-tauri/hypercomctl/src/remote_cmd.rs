use crate::{
    args::{Format, RemoteAction, Target},
    connect_target, write_json, Failure,
};
use hypercom_protocol::{
    AsyncControlClient, ControlCommand, HostError, ProfileStore, RemoteClientDto, RemoteInvite,
    RemoteProfile, RemoteStatusDto, StoredProfile,
};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, IsTerminal, Read, Write},
    path::PathBuf,
};

const MAX_INVITE_BYTES: usize = 32 * 1024;
const PROFILE_DIR_ENV: &str = "HYPERCOM_PROFILE_DIR";

pub fn open_profile_store() -> Result<ProfileStore, Failure> {
    let dir = match env::var_os(PROFILE_DIR_ENV).filter(|v| !v.is_empty()) {
        Some(custom) => PathBuf::from(custom),
        None => ProfileStore::default_dir()
            .map_err(|e| Failure::new("profile_io", format!("cannot resolve profile directory: {e}")))?,
    };
    Ok(ProfileStore::new(dir))
}

pub fn load_stored_profile(name: &str) -> Result<RemoteProfile, Failure> {
    let store = open_profile_store()?;
    Ok(store.load(name)?)
}

pub async fn execute(
    target: &Target,
    format: Format,
    action: RemoteAction,
    out: &mut impl Write,
) -> Result<(), Failure> {
    match action {
        RemoteAction::Status => {
            let mut client = connect_target(target).await?;
            let status: RemoteStatusDto = client.call_typed(ControlCommand::RemoteStatus).await?;
            if format != Format::Text {
                write_json(out, &serde_json::to_value(&status)?)?;
            } else {
                writeln!(out, "enabled: {}", status.enabled)?;
                writeln!(out, "endpoint: {}", status.endpoint)?;
                writeln!(out, "serverId: {}", status.server_id)?;
                writeln!(out, "certificateSha256: {}", status.certificate_sha256)?;
                out.flush()?;
            }
            Ok(())
        }
        RemoteAction::Start { listen, advertise } => {
            let mut client = connect_target(target).await?;
            let status: RemoteStatusDto = client
                .call_typed(ControlCommand::RemoteStart { listen, advertise })
                .await?;
            if format != Format::Text {
                write_json(out, &serde_json::to_value(&status)?)?;
            } else {
                writeln!(out, "Remote listener started at {}", status.endpoint)?;
                writeln!(out, "serverId: {}", status.server_id)?;
                writeln!(out, "certificateSha256: {}", status.certificate_sha256)?;
                out.flush()?;
            }
            Ok(())
        }
        RemoteAction::Stop => {
            let mut client = connect_target(target).await?;
            let value = client.call(ControlCommand::RemoteStop).await?;
            if format != Format::Text {
                write_json(out, &value)?;
            } else {
                writeln!(out, "Remote listener stopped.")?;
                out.flush()?;
            }
            Ok(())
        }
        RemoteAction::Invite {
            label,
            ports,
            role,
            allow_loan,
            ttl_secs,
        } => {
            let mut client = connect_target(target).await?;
            let invite: RemoteInvite = client
                .call_typed(ControlCommand::RemoteCreateInvite {
                    label,
                    ports,
                    role: role.to_string(),
                    allow_loan,
                    ttl_secs,
                })
                .await?;
            // Invite JSON is designed for direct transfer to `remote pair`, so emit JSON even in text mode.
            write_json(out, &serde_json::to_value(&invite)?)?;
            Ok(())
        }
        RemoteAction::Clients => {
            let mut client = connect_target(target).await?;
            let clients: Vec<RemoteClientDto> =
                client.call_typed(ControlCommand::RemoteListClients).await?;
            if format != Format::Text {
                write_json(out, &serde_json::to_value(&clients)?)?;
            } else if clients.is_empty() {
                writeln!(out, "No paired remote clients.")?;
            } else {
                for c in &clients {
                    writeln!(
                        out,
                        "{}\t{}\trole={}\tports={}\tallowLoan={}\trevoked={}",
                        c.client_id,
                        c.label,
                        c.permissions.role,
                        c.permissions.ports.join(","),
                        c.permissions.allow_loan,
                        c.revoked
                    )?;
                }
            }
            out.flush()?;
            Ok(())
        }
        RemoteAction::Revoke { client_id } => {
            let mut client = connect_target(target).await?;
            let revoked: RemoteClientDto = client
                .call_typed(ControlCommand::RemoteRevokeClient { client_id })
                .await?;
            if format != Format::Text {
                write_json(out, &serde_json::to_value(&revoked)?)?;
            } else {
                writeln!(
                    out,
                    "Revoked client {} ({})",
                    revoked.client_id, revoked.label
                )?;
                out.flush()?;
            }
            Ok(())
        }
        RemoteAction::Pair {
            profile: name,
            invite_file,
        } => {
            let invite = read_invite(invite_file.as_deref())?;
            let store = open_profile_store()?;
            store.preflight(&name)?;
            let reservation = store.reserve(&name)?;
            reservation.prepare_create()?;

            let paired = AsyncControlClient::pair_remote(&invite).await?;
            if let Err(err) = reservation.create(&paired) {
                return Err(Failure::new(
                    "outcome_unknown",
                    format!(
                        "pairing succeeded on server {} (clientId {}), but saving local profile failed ({}): {}",
                        paired.server_id, paired.client_id, err.code, err.message
                    ),
                ));
            }
            let summary = redacted_profile_json(&name, &paired);
            if format != Format::Text {
                write_json(out, &summary)?;
            } else {
                writeln!(
                    out,
                    "Paired profile '{name}' -> {} (serverId={}, clientId={})",
                    paired.endpoint, paired.server_id, paired.client_id
                )?;
                out.flush()?;
            }
            Ok(())
        }
        RemoteAction::Profiles => {
            let store = open_profile_store()?;
            let profiles: Vec<StoredProfile> = store.list()?;
            if format != Format::Text {
                let redacted: Vec<Value> = profiles
                    .iter()
                    .map(|p| redacted_profile_json(&p.id, &p.profile))
                    .collect();
                write_json(out, &Value::Array(redacted))?;
            } else if profiles.is_empty() {
                writeln!(out, "No saved remote profiles.")?;
            } else {
                for p in &profiles {
                    writeln!(
                        out,
                        "{}\t{}\trole={}\tports={}\tallowLoan={}\tclientId={}",
                        p.id,
                        p.profile.endpoint,
                        p.profile.permissions.role,
                        p.profile.permissions.ports.join(","),
                        p.profile.permissions.allow_loan,
                        p.profile.client_id
                    )?;
                }
            }
            out.flush()?;
            Ok(())
        }
        RemoteAction::Check { profile: name } => {
            let store = open_profile_store()?;
            let profile = store.load(&name)?;
            let mut client = AsyncControlClient::connect_remote(&profile).await?;
            let hello = client.call(ControlCommand::Hello).await.unwrap_or_else(|_| {
                client.hello_info().clone()
            });
            let mut summary = redacted_profile_json(&name, &profile);
            if let Some(obj) = summary.as_object_mut() {
                obj.insert("hostId".into(), json!(client.host_id()));
                obj.insert("hello".into(), hello);
            }
            if format != Format::Text {
                write_json(out, &summary)?;
            } else {
                writeln!(
                    out,
                    "Profile '{name}' OK: endpoint={} hostId={} serverId={} clientId={}",
                    profile.endpoint,
                    client.host_id(),
                    profile.server_id,
                    profile.client_id
                )?;
                out.flush()?;
            }
            Ok(())
        }
        RemoteAction::Forget { profile: name } => {
            let store = open_profile_store()?;
            store.remove(&name)?;
            let summary = json!({
                "profile": name,
                "forgotten": true,
            });
            if format != Format::Text {
                write_json(out, &summary)?;
            } else {
                writeln!(
                    out,
                    "Forgot local profile '{name}' (revoke on host to invalidate remote access)."
                )?;
                out.flush()?;
            }
            Ok(())
        }
    }
}

fn read_invite(invite_file: Option<&str>) -> Result<RemoteInvite, Failure> {
    let mut raw = if let Some(path) = invite_file {
        let meta = fs::metadata(path)
            .map_err(|e| Failure::new("invalid_invite", format!("cannot read {path}: {e}")))?;
        if meta.len() > MAX_INVITE_BYTES as u64 {
            return Err(Failure::new(
                "invalid_invite",
                "invite file exceeds maximum size",
            ));
        }
        fs::read(path)
            .map_err(|e| Failure::new("invalid_invite", format!("cannot read {path}: {e}")))?
    } else {
        if io::stdin().is_terminal() {
            return Err(Failure::new(
                "usage",
                "remote pair reads invite JSON from --invite-file <PATH> or piped stdin",
            ));
        }
        let mut buf = Vec::new();
        io::stdin()
            .lock()
            .take((MAX_INVITE_BYTES + 1) as u64)
            .read_to_end(&mut buf)?;
        if buf.len() > MAX_INVITE_BYTES {
            return Err(Failure::new(
                "invalid_invite",
                "invite JSON exceeds maximum size",
            ));
        }
        buf
    };

    let parsed = std::str::from_utf8(&raw)
        .map_err(|_| HostError::new("invalid_invite", "invite JSON must be valid UTF-8"))
        .and_then(RemoteInvite::parse);
    raw.fill(0);
    Ok(parsed?)
}

fn redacted_profile_json(name: &str, profile: &RemoteProfile) -> Value {
    json!({
        "profile": name,
        "endpoint": profile.endpoint,
        "serverId": profile.server_id,
        "certificateSha256": profile.certificate_sha256,
        "clientId": profile.client_id,
        "permissions": profile.permissions,
    })
}
