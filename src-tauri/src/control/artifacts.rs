//! Streaming disk-backed staging store for artifacts uploaded by local CLI/MCP
//! or remote workbench clients before invoking plugin tools.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use sha2::{Digest, Sha256};
use uuid::Uuid;

use hypercom_protocol::{ArtifactInfoDto, HostError, MAX_ARTIFACT_CHUNK_BYTES};

pub const DEFAULT_ARTIFACT_TTL_MS: u64 = 30 * 60 * 1000;
pub const MAX_ARTIFACT_TTL_MS: u64 = 24 * 60 * 60 * 1000;
const MIN_ARTIFACT_TTL_MS: u64 = 1_000;
const STALE_UPLOAD_IDLE_MS: i64 = 30 * 60 * 1000;

struct PendingUpload {
    name: String,
    part_path: PathBuf,
    file: Option<File>,
    written_bytes: u64,
    total_bytes: Option<u64>,
    ttl_ms: u64,
    hasher: Sha256,
    last_activity_ms: i64,
}

struct StoredArtifact {
    info: ArtifactInfoDto,
    path: PathBuf,
}

pub struct ArtifactStore {
    base_dir: PathBuf,
    in_progress: Mutex<HashMap<String, PendingUpload>>,
    committed: Mutex<HashMap<String, StoredArtifact>>,
}

impl ArtifactStore {
    pub fn new(base_dir: PathBuf) -> Self {
        Self {
            base_dir,
            in_progress: Mutex::new(HashMap::new()),
            committed: Mutex::new(HashMap::new()),
        }
    }

    pub fn begin(
        &self,
        name: &str,
        total_bytes: Option<u64>,
        ttl_ms: Option<u64>,
    ) -> Result<String, HostError> {
        fs::create_dir_all(&self.base_dir).map_err(|err| {
            HostError::new(
                "host_unavailable",
                format!("failed to create artifact staging directory: {err}"),
            )
        })?;
        let safe_name = sanitize_artifact_name(name);
        let upload_id = Uuid::new_v4().to_string();
        let part_path = self.base_dir.join(format!("{upload_id}.part"));
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&part_path)
            .map_err(|err| {
                HostError::new(
                    "host_unavailable",
                    format!("failed to open artifact staging file: {err}"),
                )
            })?;
        let effective_ttl = ttl_ms
            .unwrap_or(DEFAULT_ARTIFACT_TTL_MS)
            .clamp(MIN_ARTIFACT_TTL_MS, MAX_ARTIFACT_TTL_MS);

        let pending = PendingUpload {
            name: safe_name,
            part_path,
            file: Some(file),
            written_bytes: 0,
            total_bytes,
            ttl_ms: effective_ttl,
            hasher: Sha256::new(),
            last_activity_ms: now_ms(),
        };

        let mut guard = self.in_progress.lock().map_err(|_| {
            HostError::new("host_unavailable", "artifact upload table poisoned")
        })?;
        guard.insert(upload_id.clone(), pending);
        Ok(upload_id)
    }

    pub fn write_chunk(
        &self,
        upload_id: &str,
        offset: u64,
        bytes: &[u8],
    ) -> Result<u64, HostError> {
        if bytes.len() > MAX_ARTIFACT_CHUNK_BYTES {
            return Err(HostError::new(
                "invalid_request",
                format!(
                    "artifact chunk exceeds max size ({} > {})",
                    bytes.len(),
                    MAX_ARTIFACT_CHUNK_BYTES
                ),
            ));
        }

        let mut guard = self.in_progress.lock().map_err(|_| {
            HostError::new("host_unavailable", "artifact upload table poisoned")
        })?;
        let pending = guard.get_mut(upload_id).ok_or_else(|| {
            HostError::new("not_found", format!("artifact upload '{upload_id}' not found"))
        })?;

        if offset != pending.written_bytes {
            return Err(HostError::new(
                "invalid_request",
                format!(
                    "artifact chunk offset mismatch: expected {}, got {offset}",
                    pending.written_bytes
                ),
            ));
        }

        let next_written = pending
            .written_bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| HostError::new("invalid_request", "artifact size overflow"))?;
        if let Some(total) = pending.total_bytes {
            if next_written > total {
                return Err(HostError::new(
                    "invalid_request",
                    format!("artifact upload exceeds declared totalBytes ({next_written} > {total})"),
                ));
            }
        }

        let file = pending.file.as_mut().ok_or_else(|| {
            HostError::new("host_unavailable", "artifact staging file handle closed")
        })?;
        file.write_all(bytes).map_err(|err| {
            HostError::new(
                "host_unavailable",
                format!("failed to write artifact chunk: {err}"),
            )
        })?;
        pending.hasher.update(bytes);
        pending.written_bytes = next_written;
        pending.last_activity_ms = now_ms();
        Ok(pending.written_bytes)
    }

    pub fn commit(
        &self,
        upload_id: &str,
        expected_sha256: Option<&str>,
    ) -> Result<ArtifactInfoDto, HostError> {
        let mut pending = {
            let mut guard = self.in_progress.lock().map_err(|_| {
                HostError::new("host_unavailable", "artifact upload table poisoned")
            })?;
            guard.remove(upload_id).ok_or_else(|| {
                HostError::new("not_found", format!("artifact upload '{upload_id}' not found"))
            })?
        };

        if let Some(mut file) = pending.file.take() {
            if let Err(err) = file.flush() {
                drop(file);
                let _ = fs::remove_file(&pending.part_path);
                return Err(HostError::new(
                    "host_unavailable",
                    format!("failed to flush artifact staging file: {err}"),
                ));
            }
            drop(file);
        }

        if let Some(total) = pending.total_bytes {
            if pending.written_bytes != total {
                let _ = fs::remove_file(&pending.part_path);
                return Err(HostError::new(
                    "invalid_request",
                    format!(
                        "artifact size mismatch: expected {total} bytes, got {}",
                        pending.written_bytes
                    ),
                ));
            }
        }

        let actual_sha256 = hex_lower(&pending.hasher.finalize());
        if let Some(expected) = expected_sha256 {
            let normalized = expected.trim().to_ascii_lowercase();
            if normalized.len() != 64
                || !normalized.bytes().all(|b| b.is_ascii_hexdigit())
                || normalized != actual_sha256
            {
                let _ = fs::remove_file(&pending.part_path);
                return Err(HostError::new(
                    "invalid_request",
                    "artifact sha256 mismatch",
                ));
            }
        }

        let artifact_id = Uuid::new_v4().to_string();
        let final_path = self
            .base_dir
            .join(format!("{artifact_id}-{}", pending.name));
        fs::rename(&pending.part_path, &final_path).map_err(|err| {
            let _ = fs::remove_file(&pending.part_path);
            HostError::new(
                "host_unavailable",
                format!("failed to finalize artifact file: {err}"),
            )
        })?;

        let expires_at_ms = now_ms().saturating_add(pending.ttl_ms.min(i64::MAX as u64) as i64);
        let info = ArtifactInfoDto {
            artifact_id: artifact_id.clone(),
            name: pending.name,
            size_bytes: pending.written_bytes,
            sha256: actual_sha256,
            expires_at_ms,
        };

        let mut committed = self.committed.lock().map_err(|_| {
            let _ = fs::remove_file(&final_path);
            HostError::new("host_unavailable", "artifact registry poisoned")
        })?;
        committed.insert(
            artifact_id,
            StoredArtifact {
                info: info.clone(),
                path: final_path,
            },
        );
        Ok(info)
    }

    pub fn abort(&self, upload_id: &str) -> bool {
        let pending = self
            .in_progress
            .lock()
            .ok()
            .and_then(|mut guard| guard.remove(upload_id));
        if let Some(mut entry) = pending {
            drop(entry.file.take());
            let _ = fs::remove_file(&entry.part_path);
            true
        } else {
            false
        }
    }

    pub fn resolve(&self, artifact_id: &str) -> Option<(PathBuf, ArtifactInfoDto)> {
        let now = now_ms();
        let mut committed = self.committed.lock().ok()?;
        let expired = committed
            .get(artifact_id)
            .is_some_and(|item| item.info.expires_at_ms <= now);
        if expired {
            if let Some(removed) = committed.remove(artifact_id) {
                let _ = fs::remove_file(&removed.path);
            }
            return None;
        }
        committed
            .get(artifact_id)
            .map(|item| (item.path.clone(), item.info.clone()))
    }

    pub fn reap_expired(&self) -> usize {
        self.reap_expired_at(now_ms())
    }

    pub(crate) fn reap_expired_at(&self, now: i64) -> usize {
        let mut removed_paths = Vec::new();
        if let Ok(mut committed) = self.committed.lock() {
            let expired_ids: Vec<String> = committed
                .iter()
                .filter(|(_, item)| item.info.expires_at_ms <= now)
                .map(|(id, _)| id.clone())
                .collect();
            for id in expired_ids {
                if let Some(item) = committed.remove(&id) {
                    removed_paths.push(item.path);
                }
            }
        }
        if let Ok(mut in_progress) = self.in_progress.lock() {
            let stale_ids: Vec<String> = in_progress
                .iter()
                .filter(|(_, item)| now.saturating_sub(item.last_activity_ms) > STALE_UPLOAD_IDLE_MS)
                .map(|(id, _)| id.clone())
                .collect();
            for id in stale_ids {
                if let Some(mut item) = in_progress.remove(&id) {
                    drop(item.file.take());
                    removed_paths.push(item.part_path);
                }
            }
        }
        let count = removed_paths.len();
        for path in removed_paths {
            let _ = fs::remove_file(path);
        }
        count
    }

    pub fn cleanup_all(&self) {
        if let Ok(mut in_progress) = self.in_progress.lock() {
            for (_, mut item) in in_progress.drain() {
                drop(item.file.take());
                let _ = fs::remove_file(&item.part_path);
            }
        }
        if let Ok(mut committed) = self.committed.lock() {
            for (_, item) in committed.drain() {
                let _ = fs::remove_file(&item.path);
            }
        }
        let _ = fs::remove_dir_all(&self.base_dir);
    }

    #[cfg(test)]
    pub(crate) fn base_dir(&self) -> &std::path::Path {
        &self.base_dir
    }
}

pub fn sanitize_artifact_name(raw: &str) -> String {
    let base = raw
        .replace('\0', "")
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| {
            if matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .take(128)
        .collect();
    let trimmed = cleaned.trim_matches(['.', ' ']);
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        "artifact.bin".to_string()
    } else {
        trimmed.to_string()
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> (PathBuf, ArtifactStore) {
        let dir = std::env::temp_dir().join(format!("hc-art-test-{}", Uuid::new_v4()));
        let store = ArtifactStore::new(dir.clone());
        (dir, store)
    }

    #[test]
    fn sanitize_strips_paths_and_unsafe_characters() {
        assert_eq!(sanitize_artifact_name("../../firmware/app.bin"), "app.bin");
        assert_eq!(sanitize_artifact_name(r"C:\tmp\my:fw?.hex"), "my_fw_.hex");
        assert_eq!(sanitize_artifact_name(".."), "artifact.bin");
        assert_eq!(sanitize_artifact_name("   \0  "), "artifact.bin");
    }

    #[test]
    fn chunked_upload_commit_resolve_and_expiry() {
        let (dir, store) = temp_store();
        let payload = b"hello firmware world";
        let expected_sha = hex_lower(&Sha256::digest(payload));

        let upload_id = store
            .begin("../bins/fw.bin", Some(payload.len() as u64), Some(60_000))
            .unwrap();
        assert_eq!(store.write_chunk(&upload_id, 0, &payload[..6]).unwrap(), 6);
        assert_eq!(store.write_chunk(&upload_id, 6, &payload[6..]).unwrap(), payload.len() as u64);

        let info = store
            .commit(&upload_id, Some(&expected_sha.to_ascii_uppercase()))
            .unwrap();
        assert_eq!(info.name, "fw.bin");
        assert_eq!(info.size_bytes, payload.len() as u64);
        assert_eq!(info.sha256, expected_sha);

        let (path, resolved_info) = store.resolve(&info.artifact_id).unwrap();
        assert_eq!(resolved_info, info);
        assert_eq!(fs::read(&path).unwrap(), payload);

        // Expiry removes both memory entry and file
        assert_eq!(store.reap_expired_at(info.expires_at_ms + 1), 1);
        assert!(store.resolve(&info.artifact_id).is_none());
        assert!(!path.exists());

        store.cleanup_all();
        assert!(!dir.exists());
    }

    #[test]
    fn rejects_bad_offset_bad_sha_and_abort_deletes_part() {
        let (dir, store) = temp_store();

        let u1 = store.begin("a.bin", Some(4), None).unwrap();
        assert_eq!(
            store.write_chunk(&u1, 1, b"ab").unwrap_err().code,
            "invalid_request"
        );
        assert_eq!(store.write_chunk(&u1, 0, b"abcd").unwrap(), 4);
        assert_eq!(
            store.commit(&u1, Some(&"0".repeat(64))).unwrap_err().code,
            "invalid_request"
        );
        assert!(!store.base_dir().join(format!("{u1}.part")).exists());

        let u2 = store.begin("b.bin", None, None).unwrap();
        assert_eq!(store.write_chunk(&u2, 0, b"xyz").unwrap(), 3);
        assert!(store.base_dir().join(format!("{u2}.part")).exists());
        assert!(store.abort(&u2));
        assert!(!store.abort(&u2));
        assert!(!store.base_dir().join(format!("{u2}.part")).exists());

        store.cleanup_all();
        let _ = fs::remove_dir_all(dir);
    }
}
