//! Prepare durable, non-overwriting log copies before publishing a directory switch.
//! The caller owns LogManager's exclusive operation gate throughout preparation/commit.
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use super::manager::collect_log_paths;

pub(super) struct LogFileMove {
    pub source: PathBuf,
    pub target: PathBuf,
}

pub(super) struct PreparedLogMigration {
    pub files: Vec<LogFileMove>,
    committed: bool,
}

impl PreparedLogMigration {
    /// Existing historical targets are left alone. An active collision must fail
    /// before commit: appending to an unrelated file is not a safe handoff.
    pub fn prepare(
        source: &Path,
        destination: &Path,
        active: &HashSet<PathBuf>,
        mut link: impl FnMut(&Path, &Path) -> io::Result<()>,
    ) -> anyhow::Result<Self> {
        let destination_canonical = destination.canonicalize()?;
        let nested_destination = destination_canonical.starts_with(source);
        let mut paths = collect_log_paths(source)?;
        paths.sort();
        let mut prepared = Self {
            files: Vec::new(),
            committed: false,
        };
        for path in paths {
            if (nested_destination && path.starts_with(&destination_canonical))
                || path.extension().is_none_or(|extension| extension != "log")
            {
                continue;
            }
            let target = destination.join(path.strip_prefix(source)?);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            // hard_link is a zero-copy, no-clobber staging operation on supporting
            // same-volume filesystems. Neither branch removes the source here.
            match link(&path, &target) {
                Ok(()) => prepared.files.push(LogFileMove {
                    source: path,
                    target,
                }),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    if active.contains(&path) {
                        anyhow::bail!(
                            "Active log destination already exists: {}",
                            target.display()
                        );
                    }
                }
                Err(_) => {
                    let mut target_file = match OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&target)
                    {
                        Ok(file) => file,
                        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                            if active.contains(&path) {
                                anyhow::bail!(
                                    "Active log destination already exists: {}",
                                    target.display()
                                );
                            }
                            continue;
                        }
                        Err(error) => return Err(error.into()),
                    };
                    // Record ownership immediately so a failed read/copy/sync
                    // removes this attempt's partial target, never the source.
                    prepared.files.push(LogFileMove {
                        source: path.clone(),
                        target,
                    });
                    io::copy(&mut File::open(&path)?, &mut target_file)?;
                    target_file.sync_all()?;
                }
            }
        }
        Ok(prepared)
    }

    /// Once writers/root are published, cleanup cannot roll the switch back.
    /// Failed deletes retain a durable duplicate and are not counted as moved.
    pub fn commit(mut self) -> u32 {
        self.committed = true;
        let mut migrated = 0;
        for entry in &self.files {
            match fs::remove_file(&entry.source) {
                Ok(()) => migrated += 1,
                Err(error) => log::warn!(
                    "Log migration committed but source cleanup failed for {}: {error}; durable copy remains at {}",
                    entry.source.display(), entry.target.display()
                ),
            }
        }
        migrated
    }
}

impl Drop for PreparedLogMigration {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        for entry in &self.files {
            if let Err(error) = fs::remove_file(&entry.target) {
                log::warn!(
                    "Cannot clean uncommitted log migration target {}: {error}",
                    entry.target.display()
                );
            }
        }
    }
}
