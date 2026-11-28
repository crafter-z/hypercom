//! Local authority for invitations and remote principal credentials, plus
//! DPAPI/0600-protected client profile storage.

pub(crate) mod store;
#[cfg(windows)]
mod windows_acl;

use crate::protocol::HostError;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fmt,
    fs::{self, File},
    io,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::watch;
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

const STATE_VERSION: u8 = 1;
const MAX_INVITES: usize = 128;
const MAX_PEERS: usize = 256;
const MAX_PORTS_PER_GRANT: usize = 64;
const DEFAULT_TTL_MS: u64 = 5 * 60 * 1000;
const PROFILE_EXT: &str = "profile";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteRole {
    Observe,
    Write,
    Control,
}

impl RemoteRole {
    pub fn allows_tool_access(&self, access: &str) -> bool {
        match access {
            "observe" => true,
            "write" => *self >= Self::Write,
            "control" => *self >= Self::Control,
            _ => false,
        }
    }
}

impl fmt::Display for RemoteRole {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Observe => f.write_str("observe"),
            Self::Write => f.write_str("write"),
            Self::Control => f.write_str("control"),
        }
    }
}

impl FromStr for RemoteRole {
    type Err = HostError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "observe" => Ok(Self::Observe),
            "write" => Ok(Self::Write),
            "control" => Ok(Self::Control),
            _ => Err(HostError::new(
                "invalid_request",
                "role must be one of: observe, write, control",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    Observe,
    Write,
    Control,
    Loan,
    Automation,
    DevicePlugins,
    DeviceTools,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemotePermissions {
    pub role: RemoteRole,
    pub ports: Vec<String>,
    #[serde(default)]
    pub allow_loan: bool,
    #[serde(default)]
    pub automation: bool,
    #[serde(default)]
    pub device_plugins: bool,
    #[serde(default)]
    pub device_tools: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteInvite {
    pub endpoint: String,
    pub server_id: String,
    pub certificate_sha256: String,
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ports: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<RemoteRole>,
    #[serde(default)]
    pub allow_loan: bool,
    #[serde(default)]
    pub device_plugins: bool,
}

impl RemoteInvite {
    /// Parse an invite JSON payload for inspection/preview without consuming it.
    pub fn parse(raw: &str) -> Result<Self, HostError> {
        serde_json::from_str(raw)
            .map_err(|err| HostError::new("invalid_invite", format!("invalid invite JSON: {err}")))
    }

    pub fn is_expired_at(&self, now_ms: u64) -> bool {
        self.expires_at.is_some_and(|exp| now_ms >= exp)
    }
}

impl fmt::Debug for RemoteInvite {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RemoteInvite")
            .field("endpoint", &self.endpoint)
            .field("server_id", &self.server_id)
            .field("expires_at", &self.expires_at)
            .field("label", &self.label)
            .field("ports", &self.ports)
            .field("role", &self.role)
            .field("allow_loan", &self.allow_loan)
            .field("device_plugins", &self.device_plugins)
            .field("code", &"[redacted]")
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteProfile {
    pub endpoint: String,
    pub server_id: String,
    pub certificate_sha256: String,
    pub client_id: String,
    pub token: String,
    pub permissions: RemotePermissions,
}

impl fmt::Debug for RemoteProfile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RemoteProfile")
            .field("endpoint", &self.endpoint)
            .field("server_id", &self.server_id)
            .field("client_id", &self.client_id)
            .field("permissions", &self.permissions)
            .field("token", &"[redacted]")
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProfile {
    pub id: String,
    pub profile: RemoteProfile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteClientDto {
    pub client_id: String,
    pub label: String,
    pub permissions: RemotePermissions,
    pub revoked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatusDto {
    pub enabled: bool,
    pub endpoint: String,
    pub server_id: String,
    pub certificate_sha256: String,
}

/// Check the selected protected store before spending a single-use invitation.
pub fn preflight_profile(path: &Path) -> Result<(), HostError> {
    let directory = path
        .parent()
        .ok_or_else(|| profile_error("profile path needs a directory"))?;
    let probe = directory.join(format!(".probe-{}.protected", Uuid::new_v4()));
    store::write_secret(&probe, b"HyperCom protected profile readiness check")
        .map_err(profile_error)?;
    fs::remove_file(probe).map_err(profile_error)
}

/// A locally reserved profile path. Pairing and forgetting the same name must
/// hold this cross-process lock; keep it across redemption and publication.
pub struct ProfileReservation {
    path: PathBuf,
    _lock: File,
}

pub fn reserve_profile_name(path: &Path) -> Result<ProfileReservation, HostError> {
    if path.file_name().is_none() {
        return Err(profile_error("profile path needs a regular file name"));
    }
    let mut lock = path.as_os_str().to_os_string();
    lock.push(".lock");
    let lock = store::lock_file(Path::new(&lock)).map_err(|error| {
        #[cfg(windows)]
        let busy = matches!(error.raw_os_error(), Some(32 | 33));
        #[cfg(unix)]
        let busy = error.kind() == io::ErrorKind::WouldBlock;
        if busy {
            HostError::new(
                "profile_busy",
                "another process is pairing or forgetting this profile name",
            )
        } else {
            profile_error(error)
        }
    })?;
    Ok(ProfileReservation {
        path: path.to_path_buf(),
        _lock: lock,
    })
}

impl ProfileReservation {
    pub fn prepare_create(&self) -> Result<(), HostError> {
        match fs::symlink_metadata(&self.path) {
            Ok(_) => return Err(profile_exists()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(profile_error(error)),
        }
        preflight_profile(&self.path)
    }

    pub fn create(&self, profile: &RemoteProfile) -> Result<(), HostError> {
        let data = Zeroizing::new(
            serde_json::to_vec(profile).map_err(|_| profile_error("invalid profile"))?,
        );
        store::create_secret(&self.path, &data).map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                profile_exists()
            } else {
                profile_error(error)
            }
        })
    }

    pub fn forget(&self) -> Result<(), HostError> {
        load_profile(&self.path)?;
        fs::remove_file(&self.path).map_err(profile_error)
    }
}

fn profile_exists() -> HostError {
    HostError::new(
        "profile_exists",
        "profile is already saved; use a new name or explicitly forget the old profile",
    )
}

/// Save a new opaque client identity. Existing profiles require an explicit
/// forget before creation; even local callers cannot silently replace a pin.
pub fn save_profile(path: &Path, profile: &RemoteProfile) -> Result<(), HostError> {
    reserve_profile_name(path)?.create(profile)
}

pub fn load_profile(path: &Path) -> Result<RemoteProfile, HostError> {
    let plain = store::read_secret(path).map_err(profile_error)?;
    serde_json::from_slice(&plain).map_err(|_| profile_error("invalid protected profile"))
}

fn profile_error(message: impl fmt::Display) -> HostError {
    HostError::new("profile_io", message)
}

/// Directory-backed store for paired remote client profiles.
/// Secured via DPAPI + owner ACL verification on Windows and `0700`/`0600` on Unix.
#[derive(Debug, Clone)]
pub struct ProfileStore {
    dir: PathBuf,
}

impl ProfileStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn default_dir() -> io::Result<PathBuf> {
        #[cfg(windows)]
        let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        #[cfg(not(windows))]
        let base = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state"))
            });
        base.map(|dir| dir.join("HyperCom").join("profiles"))
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "no user state directory available for profiles",
                )
            })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn validate_profile_id(profile_id: &str) -> Result<(), HostError> {
        if profile_id.is_empty()
            || profile_id.len() > 64
            || profile_id.starts_with('.')
            || profile_id.contains("..")
            || profile_id.contains("::")
            || !profile_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
        {
            return Err(HostError::new(
                "invalid_request",
                "profile ID must be 1–64 ASCII letters/digits/_/-/. without '..' or '::'",
            ));
        }
        Ok(())
    }

    pub fn path_for(&self, profile_id: &str) -> Result<PathBuf, HostError> {
        Self::validate_profile_id(profile_id)?;
        Ok(self.dir.join(format!("{profile_id}.{PROFILE_EXT}")))
    }

    pub fn reserve(&self, profile_id: &str) -> Result<ProfileReservation, HostError> {
        let path = self.path_for(profile_id)?;
        reserve_profile_name(&path)
    }

    pub fn preflight(&self, profile_id: &str) -> Result<(), HostError> {
        let path = self.path_for(profile_id)?;
        store::secure_directory(&self.dir, true).map_err(profile_error)?;
        preflight_profile(&path)
    }

    pub fn save(&self, profile_id: &str, profile: &RemoteProfile) -> Result<(), HostError> {
        let path = self.path_for(profile_id)?;
        save_profile(&path, profile)
    }

    pub fn load(&self, profile_id: &str) -> Result<RemoteProfile, HostError> {
        let path = self.path_for(profile_id)?;
        load_profile(&path).map_err(|err| {
            if !path.exists() {
                HostError::new(
                    "profile_not_found",
                    format!("remote profile '{profile_id}' does not exist"),
                )
            } else {
                err
            }
        })
    }

    pub fn remove(&self, profile_id: &str) -> Result<(), HostError> {
        let reservation = self.reserve(profile_id)?;
        if !reservation.path.exists() {
            return Err(HostError::new(
                "profile_not_found",
                format!("remote profile '{profile_id}' does not exist"),
            ));
        }
        reservation.forget()
    }

    pub fn list(&self) -> Result<Vec<StoredProfile>, HostError> {
        match fs::symlink_metadata(&self.dir) {
            Ok(_) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(err) => return Err(profile_error(err)),
        }
        store::secure_directory(&self.dir, false).map_err(profile_error)?;
        let entries = fs::read_dir(&self.dir).map_err(profile_error)?;
        let mut profiles = Vec::new();
        for entry in entries {
            let entry = entry.map_err(profile_error)?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some(PROFILE_EXT) {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if Self::validate_profile_id(stem).is_err() {
                continue;
            }
            let profile = load_profile(&path)?;
            profiles.push(StoredProfile {
                id: stem.to_owned(),
                profile,
            });
        }
        profiles.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(profiles)
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct StoredIdentity {
    version: u8,
    server_id: String,
    certificate: Vec<u8>,
    private_key: Vec<u8>,
}

impl Drop for StoredIdentity {
    fn drop(&mut self) {
        self.private_key.zeroize();
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credential {
    client_id: String,
    label: String,
    token_hash: [u8; 32],
    permissions: RemotePermissions,
    revoked: bool,
}

#[derive(Serialize, Deserialize)]
struct PersistedGrants {
    version: u8,
    server_id: String,
    peers: Vec<Credential>,
}

struct Invitation {
    label: String,
    permissions: RemotePermissions,
    expires: Instant,
}

#[derive(Default)]
struct Registry {
    invitations: HashMap<[u8; 32], Invitation>,
    peers: Vec<Arc<Peer>>,
}

pub struct Peer {
    credential: Credential,
    active: AtomicBool,
    revoked: watch::Sender<bool>,
}

impl Peer {
    fn new(credential: Credential) -> Self {
        let revoked = credential.revoked;
        Self {
            credential,
            active: AtomicBool::new(!revoked),
            revoked: watch::channel(revoked).0,
        }
    }

    pub fn require_active(&self) -> Result<(), HostError> {
        if self.active.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(HostError::new("revoked", "this paired client is revoked"))
        }
    }

    fn revoke(&self) {
        self.active.store(false, Ordering::Release);
        self.revoked.send_replace(true);
    }

    pub fn revoked(&self) -> watch::Receiver<bool> {
        self.revoked.subscribe()
    }

    pub fn is_revoked(&self) -> bool {
        !self.active.load(Ordering::Acquire)
    }

    pub fn id(&self) -> &str {
        &self.credential.client_id
    }

    pub fn label(&self) -> &str {
        &self.credential.label
    }

    pub fn permissions(&self) -> &RemotePermissions {
        &self.credential.permissions
    }

    pub fn check(&self, access: Access, port: Option<&str>) -> Result<(), HostError> {
        self.require_active()?;
        let grant = &self.credential.permissions;
        let allowed = match access {
            Access::Observe => true,
            Access::Write => grant.role >= RemoteRole::Write,
            Access::Control => grant.role >= RemoteRole::Control,
            Access::Loan => grant.role >= RemoteRole::Control && grant.allow_loan,
            Access::Automation => grant.role >= RemoteRole::Write && grant.automation,
            Access::DevicePlugins => grant.device_plugins,
            Access::DeviceTools => grant.role >= RemoteRole::Control && grant.device_tools,
        };
        if !allowed || port.is_some_and(|id| !grant.ports.iter().any(|permitted| permitted == id)) {
            return Err(HostError::new(
                "forbidden",
                "this paired client is not allowed to perform that operation",
            ));
        }
        Ok(())
    }

    pub fn to_dto(&self) -> RemoteClientDto {
        RemoteClientDto {
            client_id: self.credential.client_id.clone(),
            label: self.credential.label.clone(),
            permissions: self.credential.permissions.clone(),
            revoked: !self.active.load(Ordering::Acquire),
        }
    }
}

pub struct Authority {
    _lock: File,
    registry: Mutex<Registry>,
    endpoint: String,
    identity: StoredIdentity,
    pin: String,
    grants_path: PathBuf,
}

impl Authority {
    pub fn open(dir: &Path, endpoint: String) -> anyhow::Result<Self> {
        let lock = store::lock_directory(dir)?;
        let identity_path = dir.join("identity.protected");
        let grants_path = dir.join("grants.protected");
        let identity = match store::read_secret(&identity_path) {
            Ok(data) => serde_json::from_slice::<StoredIdentity>(&data).map_err(|_| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    "invalid protected Host identity",
                )
            })?,
            Err(error) if error.kind() == io::ErrorKind::NotFound && !grants_path.exists() => {
                let rcgen::CertifiedKey { cert, signing_key } =
                    rcgen::generate_simple_self_signed(vec!["hypercom-host.local".to_string()])?;
                let identity = StoredIdentity {
                    version: STATE_VERSION,
                    server_id: Uuid::new_v4().to_string(),
                    certificate: cert.der().as_ref().to_vec(),
                    private_key: signing_key.serialize_der(),
                };
                let data = Zeroizing::new(serde_json::to_vec(&identity)?);
                store::write_secret(&identity_path, &data)?;
                identity
            }
            Err(error) => return Err(error.into()),
        };
        anyhow::ensure!(
            identity.version == STATE_VERSION && Uuid::parse_str(&identity.server_id).is_ok(),
            "incompatible protected Host identity"
        );
        let peers = match store::read_secret(&grants_path) {
            Ok(data) => {
                let value: PersistedGrants = serde_json::from_slice(&data).map_err(|_| {
                    io::Error::new(io::ErrorKind::InvalidData, "invalid protected Host roster")
                })?;
                anyhow::ensure!(
                    value.version == STATE_VERSION
                        && value.server_id == identity.server_id
                        && value.peers.len() <= MAX_PEERS,
                    "incompatible protected Host roster"
                );
                value
                    .peers
                    .into_iter()
                    .map(|credential| Arc::new(Peer::new(credential)))
                    .collect()
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        let pin = encode_digest(&digest(&identity.certificate));
        Ok(Self {
            _lock: lock,
            registry: Mutex::new(Registry {
                peers,
                ..Registry::default()
            }),
            endpoint,
            identity,
            pin,
            grants_path,
        })
    }

    pub fn material(&self) -> (&[u8], &[u8]) {
        (&self.identity.certificate, &self.identity.private_key)
    }

    pub fn server_id(&self) -> &str {
        &self.identity.server_id
    }

    pub fn certificate_sha256(&self) -> &str {
        &self.pin
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub fn status(&self) -> RemoteStatusDto {
        RemoteStatusDto {
            enabled: true,
            endpoint: self.endpoint.clone(),
            server_id: self.identity.server_id.clone(),
            certificate_sha256: self.pin.clone(),
        }
    }

    pub fn invite(
        &self,
        label: String,
        mut permissions: RemotePermissions,
        ttl_ms: Option<u64>,
    ) -> Result<RemoteInvite, HostError> {
        let time_to_live = ttl_ms.unwrap_or(DEFAULT_TTL_MS);
        if !(1_000..=3_600_000).contains(&time_to_live) {
            return Err(invalid("ttlMs must be 1000–3600000"));
        }
        let label = label.trim().to_owned();
        if label.is_empty() || label.len() > 80 || label.chars().any(char::is_control) {
            return Err(invalid(
                "label must be 1–80 UTF-8 bytes without control characters",
            ));
        }
        let mut distinct = HashSet::new();
        if permissions.ports.is_empty() || permissions.ports.len() > MAX_PORTS_PER_GRANT {
            return Err(invalid("grant requires 1–64 explicit port IDs"));
        }
        if permissions.role < RemoteRole::Write && permissions.automation {
            return Err(invalid("automation requires at least the write role"));
        }
        if (permissions.device_tools || permissions.allow_loan)
            && permissions.role < RemoteRole::Control
        {
            return Err(invalid(
                "allowLoan and deviceTools require the control role",
            ));
        }
        for port in &mut permissions.ports {
            let normalized = normalize_grant_port_id(port)?;
            if !distinct.insert(normalized.clone()) {
                return Err(invalid("grant ports must be unique"));
            }
            *port = normalized;
        }
        let code = secret_token()?;
        let mut registry = self.registry.lock().expect("authority registry poisoned");
        let now = Instant::now();
        registry.invitations.retain(|_, value| value.expires > now);
        if registry.invitations.len() >= MAX_INVITES {
            return Err(HostError::new(
                "host_busy",
                "too many outstanding invitations",
            ));
        }
        let preview_ports = permissions.ports.clone();
        let preview_role = permissions.role;
        let preview_allow_loan = permissions.allow_loan;
        let preview_device_plugins = permissions.device_plugins;
        registry.invitations.insert(
            digest(code.as_bytes()),
            Invitation {
                label: label.clone(),
                permissions,
                expires: now + Duration::from_millis(time_to_live),
            },
        );
        let expires = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
            + time_to_live;
        Ok(RemoteInvite {
            endpoint: self.endpoint.clone(),
            server_id: self.server_id().to_owned(),
            certificate_sha256: self.pin.clone(),
            code,
            expires_at: Some(expires),
            label: Some(label),
            ports: preview_ports,
            role: Some(preview_role),
            allow_loan: preview_allow_loan,
            device_plugins: preview_device_plugins,
        })
    }

    pub fn pair(&self, code: &str) -> Result<RemoteProfile, HostError> {
        let ended = || {
            HostError::new(
                "invalid_invite",
                "invitation is invalid, expired or already used",
            )
        };
        if !valid_token(code) {
            return Err(ended());
        }
        let hash = digest(code.as_bytes());
        let mut registry = self.registry.lock().expect("authority registry poisoned");
        let invitation = registry
            .invitations
            .get(&hash)
            .filter(|v| v.expires > Instant::now())
            .ok_or_else(ended)?;
        // Keep a bounded revocation history without permanently exhausting
        // pair slots. Forgetting a revoked ID still rejects its old token.
        let evict = if registry.peers.len() >= MAX_PEERS {
            Some(
                registry
                    .peers
                    .iter()
                    .position(|peer| !peer.active.load(Ordering::Acquire))
                    .ok_or_else(|| HostError::new("host_busy", "paired client roster is full"))?,
            )
        } else {
            None
        };
        let token = secret_token()?;
        let credential = Credential {
            client_id: Uuid::new_v4().to_string(),
            label: invitation.label.clone(),
            token_hash: digest(token.as_bytes()),
            permissions: invitation.permissions.clone(),
            revoked: false,
        };
        let mut replacement = Self::saved_peers(&registry);
        if let Some(index) = evict {
            replacement.remove(index);
        }
        replacement.push(credential.clone());
        self.persist(replacement)?;
        if let Some(index) = evict {
            registry.peers.remove(index);
        }
        // A failed durable write leaves the invitation usable; a successful
        // commit consumes it before responding, even if the reply is lost.
        registry.invitations.remove(&hash);
        registry.peers.push(Arc::new(Peer::new(credential.clone())));
        Ok(RemoteProfile {
            endpoint: self.endpoint.clone(),
            server_id: self.server_id().to_owned(),
            certificate_sha256: self.pin.clone(),
            client_id: credential.client_id,
            token,
            permissions: credential.permissions,
        })
    }

    pub fn authenticate(&self, id: &str, token: &str) -> Result<Arc<Peer>, HostError> {
        let rejected = || HostError::new("unauthorized", "invalid paired client credential");
        if Uuid::parse_str(id).is_err() || !valid_token(token) {
            return Err(rejected());
        }
        let hash = digest(token.as_bytes());
        let registry = self.registry.lock().expect("authority registry poisoned");
        let peer = registry
            .peers
            .iter()
            .find(|peer| peer.id() == id && bool::from(peer.credential.token_hash.ct_eq(&hash)))
            .cloned()
            .ok_or_else(rejected)?;
        peer.require_active()?;
        Ok(peer)
    }

    fn saved_peers(registry: &Registry) -> Vec<Credential> {
        registry
            .peers
            .iter()
            .map(|peer| {
                let mut saved = peer.credential.clone();
                saved.revoked = !peer.active.load(Ordering::Acquire);
                saved
            })
            .collect()
    }

    fn persist(&self, peers: Vec<Credential>) -> Result<(), HostError> {
        let prepared = PersistedGrants {
            version: STATE_VERSION,
            server_id: self.server_id().to_string(),
            peers,
        };
        let plain = Zeroizing::new(
            serde_json::to_vec(&prepared)
                .map_err(|_| profile_error("could not serialize authority roster"))?,
        );
        store::write_secret(&self.grants_path, &plain).map_err(profile_error)
    }

    pub fn list(&self) -> Vec<RemoteClientDto> {
        let registry = self.registry.lock().expect("authority registry poisoned");
        registry.peers.iter().map(|peer| peer.to_dto()).collect()
    }

    pub fn revoke(&self, id: &str) -> Result<RemoteClientDto, HostError> {
        let registry = self.registry.lock().expect("authority registry poisoned");
        let Some(index) = registry.peers.iter().position(|peer| peer.id() == id) else {
            return Err(HostError::new("unknown_client", "no such paired client"));
        };
        let peer = &registry.peers[index];
        if peer.active.load(Ordering::Acquire) {
            let mut replacement = Self::saved_peers(&registry);
            replacement[index].revoked = true;
            self.persist(replacement)?;
            peer.revoke();
        }
        Ok(peer.to_dto())
    }

    pub fn default_state_root() -> io::Result<PathBuf> {
        #[cfg(windows)]
        let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
        #[cfg(not(windows))]
        let base = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state"))
            });
        base.map(|dir| dir.join("HyperCom").join("control-authority"))
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::NotFound,
                    "no user state directory available for authority",
                )
            })
    }
}

fn normalize_grant_port_id(raw: &str) -> Result<String, HostError> {
    let port = raw.trim();
    if port.is_empty()
        || port.len() > 256
        || port == "*"
        || port.starts_with("remote::")
        || port.starts_with(r"\\.\")
        || port.contains("..")
        || port.chars().any(char::is_control)
    {
        return Err(invalid(
            "grant ports must be explicit local port IDs, not wildcards, remote refs, or device paths",
        ));
    }
    if let Some(digits) = port.strip_prefix("COM").or_else(|| port.strip_prefix("com")) {
        if !digits.is_empty()
            && digits.len() <= 5
            && digits.bytes().all(|b| b.is_ascii_digit())
        {
            let number = digits.parse::<u16>().map_err(|_| invalid("invalid COM port ID"))?;
            if number == 0 {
                return Err(invalid("invalid COM port ID"));
            }
            return Ok(format!("COM{number}"));
        }
    }
    Ok(port.to_owned())
}

fn invalid(message: &str) -> HostError {
    HostError::new("invalid_request", message)
}

fn valid_token(token: &str) -> bool {
    token.len() == 43
        && token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn secret_token() -> Result<String, HostError> {
    let mut bytes = Zeroizing::new([0u8; 32]);
    getrandom::fill(bytes.as_mut())
        .map_err(|_| HostError::new("host_unavailable", "secure random source unavailable"))?;
    Ok(URL_SAFE_NO_PAD.encode(bytes.as_ref()))
}

pub(crate) fn digest(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn encode_digest(bytes: &[u8; 32]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests;
