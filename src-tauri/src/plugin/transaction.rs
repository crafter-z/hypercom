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
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => Ok(true),
        Ok(_) => Err(io::Error::other("Transaction path is not an ordinary directory")),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
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
            if has_backup { fs::remove_dir_all(&backup)?; sync_dir(root)?; }
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
            fs::remove_dir_all(&backup)?;
            sync_dir(root)?;
        }
        if has_stage { fs::remove_dir_all(&stage)?; sync_dir(root)?; }
    }
    tx.finish(root)
}

#[cfg(test)]
mod tests {
    use super::*;

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
