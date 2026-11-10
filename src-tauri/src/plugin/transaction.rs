//! Durable plugin transactions. Journal paths are derived, never supplied by packages.
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use crate::config::AppConfig;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Transaction {
    token: String,
    id: String,
    stage_token: Option<String>,
    uninstall: bool,
    commit_revision: u64,
    phase: String,
}

fn journal(root: &Path) -> io::Result<PathBuf> {
    Ok(root.parent().ok_or_else(|| io::Error::other("Missing plugin root parent"))?
        .join("plugin-transaction.json"))
}
fn uuid(value: &str) -> io::Result<()> {
    if uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value) { Ok(()) }
    else { Err(io::Error::other("Invalid transaction identity")) }
}
fn regular_dir(path: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !super::is_link_or_reparse(&meta) => Ok(true),
        Ok(_) => Err(io::Error::other("Transaction path is not an ordinary directory")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Move abandoned transaction trees aside in one rename. Recursive deletion is
/// deliberately not done on the startup or config-lock path: a plugin tree can
/// hold an unbounded number of log segments, and deleting it while the window is
/// still being created made HyperCom look dead (process alive, no window/tray).
fn quarantine(root: &Path, path: &Path) -> io::Result<PathBuf> {
    let target = root.join(format!(".trash-{}", uuid::Uuid::new_v4()));
    rename(root, path, &target)?;
    Ok(target)
}

fn transaction_tree_token(name: &str) -> Option<(&'static str, &str)> {
    [".trash-", ".backup-", ".staging-"]
        .iter()
        .find_map(|prefix| name.strip_prefix(prefix).map(|token| (*prefix, token)))
        .filter(|(_, token)| uuid(token).is_ok())
}

/// Read the plugin id from an abandoned backup tree without trusting its paths.
fn backup_plugin_id(path: &Path) -> Option<String> {
    let manifest = path.join("manifest.json");
    let metadata = fs::symlink_metadata(&manifest).ok()?;
    if !metadata.is_file() || super::is_link_or_reparse(&metadata) || metadata.len() > 1024 * 1024 {
        return None;
    }
    let bytes = fs::read(&manifest).ok()?;
    let manifest: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let id = manifest.get("id")?.as_str()?.to_owned();
    super::validate_plugin_id(&id).ok()?;
    Some(id)
}

/// A staging tree can hold the only copy of a plugin's private `data/` between
/// the `private-data` and `publish` renames. Such a tree must never be swept:
/// the private data would be unrecoverable.
fn staging_holds_private_data(path: &Path) -> bool {
    let data = path.join("data");
    match regular_dir(&data) {
        Ok(true) => match fs::read_dir(&data) {
            Ok(mut entries) => entries.next().is_some(),
            Err(_) => true,
        },
        Ok(false) => false,
        Err(_) => true,
    }
}

/// Select abandoned transaction trees that are safe to delete.
///
/// Callers must hold the plugin IO gate: a present journal means a live
/// transaction, so nothing is touched then. The returned paths are a snapshot;
/// deletion happens outside the gate (`sweep_delete`) because recursive removal
/// is unbounded and must not block install/list/uninstall.
///
/// `.backup-*` is only reclaimed when its code is provably not needed: the
/// backup carries no committed plugin, or the live directory still exists. A
/// backup whose plugin is still configured but whose live tree is missing may be
/// the only surviving copy of the code, so it is preserved.
pub(crate) fn sweep_collect(root: &Path, config: &AppConfig) -> io::Result<Vec<PathBuf>> {
    if fs::symlink_metadata(journal(root)?).is_ok() || !regular_dir(root)? {
        return Ok(Vec::new());
    }
    let mut paths = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => { log::warn!("Skipping unreadable plugin tree during sweep: {error}"); continue; }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some((kind, _)) = transaction_tree_token(name) else { continue };
        let path = entry.path();
        match regular_dir(&path) {
            Ok(true) => {}
            Ok(false) => continue,
            Err(error) => { log::warn!("Refusing to sweep unsafe plugin tree {}: {error}", path.display()); continue; }
        }
        if kind == ".staging-" && staging_holds_private_data(&path) {
            // Crash between `private-data` and `publish`: the only copy of the
            // plugin's private data lives here. Keep it for manual recovery.
            log::warn!(
                "Keeping plugin staging tree {} because it may hold the only copy of private data",
                path.display()
            );
            continue;
        }
        if kind == ".backup-" {
            let Some(id) = backup_plugin_id(&path) else {
                // Unidentifiable tree: keep it rather than delete data we cannot name.
                continue;
            };
            let live = root.join(&id).is_dir();
            let configured = config.entities.plugin_configs.iter().any(|entry| entry.id == id);
            if configured && !live { continue; }
        }
        paths.push(path);
    }
    Ok(paths)
}

/// Delete a snapshot from `sweep_collect` off the plugin IO gate. Individual
/// failures (read-only files, antivirus locks) are logged and skipped so one
/// stuck tree can never abort startup or a later sweep.
pub(crate) fn sweep_delete(root: &Path, paths: &[PathBuf]) -> u64 {
    let mut removed = 0;
    for path in paths {
        // Re-check after leaving the gate: a swapped link must never be followed.
        if !matches!(regular_dir(path), Ok(true)) { continue; }
        match fs::remove_dir_all(path) {
            Ok(()) => removed += 1,
            Err(error) => log::warn!("Failed to sweep plugin tree {}: {error}", path.display()),
        }
    }
    if removed > 0 { let _ = sync_dir(root); }
    removed
}

/// Remove abandoned prepared staging trees when a process crashed before the
/// transaction journal was created. Journal-backed trees are left for `recover`.
/// Trees are moved to `.trash-*` (cheap rename) and reclaimed by `sweep`.
pub(crate) fn cleanup_orphan_staging(root: &Path) -> io::Result<()> {
    if fs::symlink_metadata(journal(root)?).is_ok() || !regular_dir(root)? {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(token) = name.strip_prefix(".staging-") else { continue };
        if uuid(token).is_err() { continue; }
        let path = entry.path();
        if !regular_dir(&path)? {
            return Err(io::Error::other("Orphan staging is not an ordinary directory"));
        }
        // Reclamation is best-effort: a locked orphan must not fail list/install.
        if let Err(error) = quarantine(root, &path) {
            log::warn!("Deferring orphan staging reclamation {}: {error}", path.display());
        }
    }
    Ok(())
}

pub(crate) fn sync_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    fs::File::open(path)?.sync_all()?;
    // Windows rename uses MOVEFILE_WRITE_THROUGH; directories cannot be fsynced
    // through std::fs::File. All files and the journal are explicitly synced.
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Replace in one OS operation: never make the previous data file inaccessible.
pub(crate) fn replace_file(source: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH};
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(not(windows))]
    fs::rename(source, target)?;
    Ok(())
}

pub(crate) fn rename(root: &Path, source: &Path, target: &Path) -> io::Result<()> {
    #[cfg(windows)]
    replace_file(source, target)?;
    #[cfg(not(windows))]
    fs::rename(source, target)?;
    sync_dir(root)?;
    if let Some(parent) = source.parent() { sync_dir(parent)?; }
    if let Some(parent) = target.parent() { sync_dir(parent)?; }
    Ok(())
}

pub(crate) fn sync_tree(path: &Path) -> io::Result<()> {
    if !regular_dir(path)? { return Err(io::Error::other("Missing staged tree")); }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let meta = fs::symlink_metadata(entry.path())?;
        if meta.is_dir() && !meta.file_type().is_symlink() { sync_tree(&entry.path())?; }
        else if meta.is_file() && !meta.file_type().is_symlink() {
            fs::OpenOptions::new().write(true).open(entry.path())?.sync_all()?;
        }
        else { return Err(io::Error::other("Transaction tree contains a link or special file")); }
    }
    sync_dir(path)
}

impl Transaction {
    pub(crate) fn install(root: &Path, id: &str, staging: &Path, revision: u64) -> io::Result<Self> {
        let name = staging.file_name().and_then(|s| s.to_str()).ok_or_else(|| io::Error::other("Invalid staging path"))?;
        let token = name.strip_prefix(".staging-").ok_or_else(|| io::Error::other("Invalid staging name"))?;
        uuid(token)?;
        if staging != root.join(name) { return Err(io::Error::other("Staging is outside plugin root")); }
        sync_tree(staging)?;
        Self::begin(root, id, Some(token.to_owned()), false, revision)
    }
    pub(crate) fn uninstall(root: &Path, id: &str, revision: u64) -> io::Result<Self> {
        Self::begin(root, id, None, true, revision)
    }
    fn begin(root: &Path, id: &str, stage_token: Option<String>, uninstall: bool, revision: u64) -> io::Result<Self> {
        super::validate_plugin_id(id).map_err(io::Error::other)?;
        match fs::symlink_metadata(journal(root)?) {
            Ok(_) => return Err(io::Error::other("Plugin transaction requires recovery")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {},
            Err(e) => return Err(e),
        }
        let transaction = Self { token: uuid::Uuid::new_v4().to_string(), id: id.to_owned(), stage_token,
            uninstall, commit_revision: revision, phase: "prepared".into() };
        transaction.persist(root)?;
        Ok(transaction)
    }
    pub(crate) fn dest(&self, root: &Path) -> PathBuf { root.join(&self.id) }
    pub(crate) fn backup(&self, root: &Path) -> PathBuf { root.join(format!(".backup-{}", self.token)) }
    pub(crate) fn stage(&self, root: &Path) -> Option<PathBuf> { self.stage_token.as_ref().map(|id| root.join(format!(".staging-{id}"))) }
    pub(crate) fn phase(&mut self, root: &Path, phase: &str) -> io::Result<()> {
        self.phase = phase.to_owned();
        self.persist(root)
    }
    fn persist(&self, root: &Path) -> io::Result<()> {
        let path = journal(root)?;
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if !meta.is_file() || meta.file_type().is_symlink() { return Err(io::Error::other("Unsafe plugin journal")); }
        }
        let temporary = path.with_extension(format!("{}.tmp", self.token));
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        let result = (|| {
            serde_json::to_writer(&mut file, self).map_err(io::Error::other)?;
            file.flush()?;
            file.sync_all()?;
            replace_file(&temporary, &path)?;
            sync_dir(path.parent().unwrap())
        })();
        if result.is_err() { let _ = fs::remove_file(temporary); }
        result
    }
    pub(crate) fn finish(&self, root: &Path) -> io::Result<()> {
        let path = journal(root)?;
        let temporary = path.with_extension(format!("{}.tmp", self.token));
        match fs::symlink_metadata(&temporary) {
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => fs::remove_file(&temporary)?,
            Ok(_) => return Err(io::Error::other("Unsafe transaction temporary")),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {},
            Err(e) => return Err(e),
        }
        fs::remove_file(path)?;
        sync_dir(root.parent().unwrap())
    }
}

/// Recover before exposing configuration to workers. Any ambiguous state errors
/// out rather than deleting data or guessing which tree can be trusted.
pub(crate) fn recover(root: &Path, config: &AppConfig) -> io::Result<()> {
    let path = journal(root)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return Err(io::Error::other("Unsafe plugin transaction journal"));
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)?.take(4097).read_to_end(&mut bytes)?;
    if bytes.len() > 4096 { return Err(io::Error::other("Plugin journal too large")); }
    let tx: Transaction = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
    uuid(&tx.token)?;
    if let Some(token) = &tx.stage_token { uuid(token)?; }
    super::validate_plugin_id(&tx.id).map_err(io::Error::other)?;
    if tx.uninstall == tx.stage_token.is_some() { return Err(io::Error::other("Invalid transaction kind")); }
    if !["prepared", "backup", "private-data", "publish", "published", "remove", "config-commit"].contains(&tx.phase.as_str()) {
        return Err(io::Error::other("Invalid transaction phase"));
    }
    if !regular_dir(root)? { return Err(io::Error::other("Missing plugin transaction root")); }
    let dest = tx.dest(root);
    let backup = tx.backup(root);
    let has_dest = regular_dir(&dest)?;
    let has_backup = regular_dir(&backup)?;
    if tx.uninstall {
        let committed = config.revision >= tx.commit_revision
            && !config.entities.plugin_configs.iter().any(|entry| entry.id == tx.id);
        if committed {
            if has_dest { return Err(io::Error::other("Ambiguous committed uninstall")); }
            // The commit is durable: failing to rename the leftover tree only
            // delays reclamation. Never keep the journal alive (and every later
            // start retrying) because of a locked/partially deleted backup.
            if has_backup {
                if let Err(error) = quarantine(root, &backup) {
                    log::warn!("Deferring plugin backup reclamation {}: {error}", backup.display());
                }
            }
        } else if has_backup {
            if has_dest { return Err(io::Error::other("Ambiguous interrupted uninstall")); }
            rename(root, &backup, &dest)?;
        }
    } else {
        let stage = tx.stage(root).unwrap();
        let has_stage = regular_dir(&stage)?;
        if has_dest && has_stage && has_backup { return Err(io::Error::other("Ambiguous interrupted install")); }
        if !has_dest && has_backup {
            if has_stage && regular_dir(&stage.join("data"))? {
                if regular_dir(&backup.join("data"))? { return Err(io::Error::other("Ambiguous private data trees")); }
                rename(root, &stage.join("data"), &backup.join("data"))?;
            }
            rename(root, &backup, &dest)?;
        } else if has_dest && !has_stage && has_backup {
            // The final rename completed. Private data lives in the new tree.
            if regular_dir(&backup.join("data"))? { return Err(io::Error::other("Unmigrated private data")); }
            if let Err(error) = quarantine(root, &backup) {
                log::warn!("Deferring plugin backup reclamation {}: {error}", backup.display());
            }
        }
        if has_stage {
            if let Err(error) = quarantine(root, &stage) {
                log::warn!("Deferring plugin staging reclamation {}: {error}", stage.display());
            }
        }
    }
    tx.finish(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Test helper: the production path splits collection (under the IO gate)
    /// from deletion (off the gate); tests exercise both halves in sequence.
    fn sweep(root: &Path, config: &AppConfig) -> io::Result<u64> {
        let paths = sweep_collect(root, config)?;
        Ok(sweep_delete(root, &paths))
    }

    #[test]
    fn journal_rejects_package_controlled_paths_without_cleaning_siblings() {
        let root = std::env::temp_dir().join(format!("plugin_journal_validation_{}", uuid::Uuid::new_v4()));
        let plugins = root.join("plugins");
        fs::create_dir_all(&plugins).unwrap();
        fs::write(root.join("keep"), "private").unwrap();
        let token = uuid::Uuid::new_v4().to_string();
        for id in ["../keep", ".", "com..bad"] {
            let tx = Transaction { token: token.clone(), id: id.into(), stage_token: Some(token.clone()),
                uninstall: false, commit_revision: 1, phase: "prepared".into() };
            fs::write(journal(&plugins).unwrap(), serde_json::to_vec(&tx).unwrap()).unwrap();
            assert!(recover(&plugins, &AppConfig::default()).is_err());
            assert_eq!(fs::read_to_string(root.join("keep")).unwrap(), "private");
        }
        let tx = Transaction { token: "../keep".into(), id: "com.example.test".into(), stage_token: None,
            uninstall: true, commit_revision: 1, phase: "prepared".into() };
        fs::write(journal(&plugins).unwrap(), serde_json::to_vec(&tx).unwrap()).unwrap();
        assert!(recover(&plugins, &AppConfig::default()).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_removes_journal_less_uuid_staging_but_keeps_unrelated_dirs() {
        let root = std::env::temp_dir().join(format!("plugin_orphan_stage_{}", uuid::Uuid::new_v4()));
        let plugins = root.join("plugins");
        fs::create_dir_all(&plugins).unwrap();
        let orphan = plugins.join(format!(".staging-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&orphan).unwrap();
        fs::write(orphan.join("partial"), "partial").unwrap();
        fs::create_dir(plugins.join(".staging-not-a-uuid")).unwrap();
        cleanup_orphan_staging(&plugins).unwrap();
        assert!(!orphan.exists());
        assert!(plugins.join(".staging-not-a-uuid").exists());
        // Cleanup only renames: the recursive delete is deferred to the sweep.
        let quarantined = fs::read_dir(&plugins).unwrap()
            .filter_map(|entry| entry.ok())
            .any(|entry| entry.file_name().to_string_lossy().starts_with(".trash-"));
        assert!(quarantined);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn committed_uninstall_quarantines_backup_instead_of_deleting_at_startup() {
        let root = std::env::temp_dir().join(format!("plugin_commit_quarantine_{}", uuid::Uuid::new_v4()));
        let plugins = root.join("plugins");
        fs::create_dir_all(&plugins).unwrap();
        let tx = Transaction::uninstall(&plugins, "com.example.test", 1).unwrap();
        // The config commit is durable, then the process dies before cleanup.
        fs::create_dir_all(tx.backup(&plugins).join("data")).unwrap();
        fs::write(tx.backup(&plugins).join("manifest.json"), r#"{"id":"com.example.test"}"#).unwrap();
        fs::write(tx.backup(&plugins).join("data/keep"), "private").unwrap();
        let config = AppConfig { revision: 2, ..Default::default() };
        recover(&plugins, &config).unwrap();
        assert!(!tx.backup(&plugins).exists());
        assert!(!journal(&plugins).unwrap().exists());
        let trash: Vec<_> = fs::read_dir(&plugins).unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(".trash-"))
            .collect();
        assert_eq!(trash.len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sweep_reclaims_quarantine_but_keeps_the_only_surviving_backup() {
        use crate::config::PluginConfigEntry;
        let root = std::env::temp_dir().join(format!("plugin_sweep_{}", uuid::Uuid::new_v4()));
        let plugins = root.join("plugins");
        fs::create_dir_all(&plugins).unwrap();
        let trash = plugins.join(format!(".trash-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(trash.join("nested")).unwrap();
        fs::write(trash.join("nested/segment.bin"), "data").unwrap();
        let recoverable = plugins.join(format!(".backup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&recoverable).unwrap();
        fs::write(recoverable.join("manifest.json"), r#"{"id":"com.example.keep"}"#).unwrap();
        let mut config = AppConfig::default();
        config.entities.plugin_configs.push(PluginConfigEntry {
            id: "com.example.keep".into(),
            install_generation: uuid::Uuid::new_v4().to_string(),
            enabled: false,
            trusted_web_granted: false,
            granted_permissions: Vec::new(),
            installed_at: Some(1),
            source: Some("dir".into()),
        });
        assert_eq!(sweep(&plugins, &config).unwrap(), 1);
        assert!(!trash.exists());
        assert!(recoverable.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sweep_keeps_staging_private_data_and_unidentifiable_backups() {
        let root = std::env::temp_dir().join(format!("plugin_sweep_keep_{}", uuid::Uuid::new_v4()));
        let plugins = root.join("plugins");
        fs::create_dir_all(&plugins).unwrap();
        // The only copy of private data may live in a staging tree after the
        // `private-data` phase and before `publish`.
        let staging = plugins.join(format!(".staging-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(staging.join("data")).unwrap();
        fs::write(staging.join("data/keep"), "private").unwrap();
        // A backup without a readable manifest cannot be attributed safely.
        let unknown = plugins.join(format!(".backup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&unknown).unwrap();
        assert_eq!(sweep(&plugins, &AppConfig::default()).unwrap(), 0);
        assert_eq!(fs::read_to_string(staging.join("data/keep")).unwrap(), "private");
        assert!(unknown.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sweep_reclaims_backup_when_the_live_plugin_still_exists() {
        use crate::config::PluginConfigEntry;
        let root = std::env::temp_dir().join(format!("plugin_sweep_live_{}", uuid::Uuid::new_v4()));
        let plugins = root.join("plugins");
        fs::create_dir_all(plugins.join("com.example.live")).unwrap();
        let backup = plugins.join(format!(".backup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("manifest.json"), r#"{"id":"com.example.live"}"#).unwrap();
        let mut config = AppConfig::default();
        config.entities.plugin_configs.push(PluginConfigEntry {
            id: "com.example.live".into(),
            install_generation: uuid::Uuid::new_v4().to_string(),
            enabled: false,
            trusted_web_granted: false,
            granted_permissions: Vec::new(),
            installed_at: Some(1),
            source: Some("dir".into()),
        });
        assert_eq!(sweep(&plugins, &config).unwrap(), 1);
        assert!(!backup.exists());
        assert!(plugins.join("com.example.live").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sweep_never_touches_trees_while_a_journal_is_present() {
        let root = std::env::temp_dir().join(format!("plugin_sweep_journal_{}", uuid::Uuid::new_v4()));
        let plugins = root.join("plugins");
        fs::create_dir_all(&plugins).unwrap();
        let trash = plugins.join(format!(".trash-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&trash).unwrap();
        let staging = plugins.join(format!(".staging-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(staging.join("data")).unwrap();
        fs::write(staging.join("data/keep"), "private").unwrap();
        let backup = plugins.join(format!(".backup-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("manifest.json"), r#"{"id":"com.example.keep"}"#).unwrap();
        let _tx = Transaction::uninstall(&plugins, "com.example.test", 1).unwrap();
        assert_eq!(sweep(&plugins, &AppConfig::default()).unwrap(), 0);
        assert!(trash.exists());
        assert!(staging.exists());
        assert!(backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn recovery_refuses_linked_transaction_tree() {
        let root = std::env::temp_dir().join(format!("plugin_journal_link_{}", uuid::Uuid::new_v4()));
        let plugins = root.join("plugins");
        fs::create_dir_all(&plugins).unwrap();
        fs::create_dir(root.join("outside")).unwrap();
        fs::write(root.join("outside/keep"), "private").unwrap();
        let tx = Transaction::uninstall(&plugins, "com.example.test", 1).unwrap();
        std::os::unix::fs::symlink(root.join("outside"), tx.backup(&plugins)).unwrap();
        assert!(recover(&plugins, &AppConfig::default()).is_err());
        assert_eq!(fs::read_to_string(root.join("outside/keep")).unwrap(), "private");
        fs::remove_dir_all(root).unwrap();
    }
}
