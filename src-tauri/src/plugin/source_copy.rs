//! Directory preparation: measure a bounded manifest of opened ordinary
//! objects, query the staging volume, and copy only that measured snapshot.
//! Platform callers supply the same no-follow walk for both passes.

use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

pub(crate) const MAX_LOCAL_ENTRIES: usize = 2_000;
const COPY_WINDOW: usize = 256 * 1024;
pub(crate) const CANCELLED: &str = "plugin_install_cancelled";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SourceStamp {
    pub volume: u64,
    pub identity: u64,
    pub len: u64,
    pub last_write: (i64, i64),
    pub last_change: (i64, i64),
    pub directory: bool,
}

#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(
    tag = "phase",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PluginInstallProgress {
    Waiting,
    Scanning,
    Copying {
        copied_bytes: u64,
        total_bytes: u64,
        available_bytes: u64,
    },
    Validating,
    Committing,
}

#[derive(Clone, Copy)]
pub(crate) struct CopyControl<'a> {
    pub cancelled: &'a dyn Fn() -> bool,
    pub progress: &'a dyn Fn(PluginInstallProgress),
}

impl CopyControl<'_> {
    pub(crate) const SILENT: Self = Self {
        cancelled: &|| false,
        progress: &|_| {},
    };

    pub(crate) fn check(&self) -> io::Result<()> {
        if (self.cancelled)() {
            return Err(io::Error::new(io::ErrorKind::Interrupted, CANCELLED));
        }
        Ok(())
    }
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn changed() -> io::Error {
    invalid("插件源在空间预检或复制时已变化，请重新选择后安装")
}

#[derive(Default)]
struct SourceSnapshot {
    entries: HashMap<PathBuf, SourceStamp>,
    bytes: u64,
}

struct CopyProgress<'a> {
    copied: u64,
    total: u64,
    available: u64,
    last_event: Instant,
    control: CopyControl<'a>,
}

impl CopyProgress<'_> {
    fn emit(&mut self) {
        (self.control.progress)(PluginInstallProgress::Copying {
            copied_bytes: self.copied,
            total_bytes: self.total,
            available_bytes: self.available,
        });
        self.last_event = Instant::now();
    }
}

struct CopyOutput<'a> {
    entries: HashMap<PathBuf, SourceStamp>,
    progress: CopyProgress<'a>,
    window: Vec<u8>,
}

enum Pass<'a> {
    Scan(SourceSnapshot),
    Copy(CopyOutput<'a>),
}

pub(crate) struct DirectoryPass<'a> {
    stage: &'a Path,
    control: CopyControl<'a>,
    pass: Pass<'a>,
}

impl DirectoryPass<'_> {
    pub(crate) fn scanning(&self) -> bool {
        matches!(self.pass, Pass::Scan(_))
    }

    pub(crate) fn check(&self) -> io::Result<()> {
        self.control.check()
    }

    fn visit(&mut self, target: &Path, stamp: SourceStamp) -> io::Result<()> {
        self.check()?;
        let relative = target.strip_prefix(self.stage).map_err(|_| changed())?;
        match &mut self.pass {
            Pass::Scan(snapshot) => {
                if snapshot
                    .entries
                    .insert(relative.to_path_buf(), stamp)
                    .is_some()
                {
                    return Err(changed());
                }
                if !stamp.directory {
                    snapshot.bytes = snapshot
                        .bytes
                        .checked_add(stamp.len)
                        .ok_or_else(|| invalid("插件目录大小溢出"))?;
                }
            }
            Pass::Copy(output) => {
                if output.entries.remove(relative) != Some(stamp) {
                    return Err(changed());
                }
            }
        }
        Ok(())
    }

    pub(crate) fn directory(&mut self, target: &Path, stamp: SourceStamp) -> io::Result<()> {
        self.visit(target, stamp)?;
        if !self.scanning() {
            // Each name, including the stage root, must be newly created.
            fs::create_dir(target)?;
        }
        Ok(())
    }

    pub(crate) fn file(
        &mut self,
        target: &Path,
        mut input: File,
        stamp: SourceStamp,
        restat: impl FnOnce(&File) -> io::Result<SourceStamp>,
    ) -> io::Result<()> {
        self.visit(target, stamp)?;
        let Pass::Copy(output) = &mut self.pass else {
            return Ok(());
        };
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(target)?;
        let mut remaining = stamp.len;
        while remaining != 0 {
            self.control.check()?;
            let limit = remaining.min(output.window.len() as u64) as usize;
            let count = input.read(&mut output.window[..limit])?;
            if count == 0 {
                return Err(changed());
            }
            self.control.check()?;
            file.write_all(&output.window[..count])?;
            remaining -= count as u64;
            output.progress.copied += count as u64;
            if output.progress.copied == count as u64
                || output.progress.last_event.elapsed() >= Duration::from_millis(125)
            {
                output.progress.emit();
            }
        }
        self.control.check()?;
        if input.read(&mut [0])? != 0 || restat(&input)? != stamp {
            return Err(changed());
        }
        Ok(())
    }
}

pub(crate) fn copy_verified(
    stage: &Path,
    limit: Option<u64>,
    control: CopyControl<'_>,
    walk: impl FnMut(&mut DirectoryPass<'_>) -> io::Result<()>,
) -> io::Result<u64> {
    copy_verified_with_space(stage, limit, control, walk, available_space)
}

fn copy_verified_with_space(
    stage: &Path,
    limit: Option<u64>,
    control: CopyControl<'_>,
    mut walk: impl FnMut(&mut DirectoryPass<'_>) -> io::Result<()>,
    space: impl FnOnce(&Path) -> io::Result<u64>,
) -> io::Result<u64> {
    let mut scan = DirectoryPass {
        stage,
        control,
        pass: Pass::Scan(SourceSnapshot::default()),
    };
    walk(&mut scan)?;
    let Pass::Scan(snapshot) = scan.pass else {
        unreachable!()
    };
    if limit.is_some_and(|limit| snapshot.bytes > limit) {
        return Err(invalid("归档暂存内容超过已解压大小上限"));
    }
    control.check()?;
    let volume = stage
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let available = space(volume).map_err(|error| {
        io::Error::new(
            error.kind(),
            format!("无法查询插件暂存磁盘可用空间: {error}"),
        )
    })?;
    ensure_space(snapshot.bytes, available)?;
    let mut progress = CopyProgress {
        copied: 0,
        total: snapshot.bytes,
        available,
        last_event: Instant::now(),
        control,
    };
    progress.emit();
    let mut copy = DirectoryPass {
        stage,
        control,
        pass: Pass::Copy(CopyOutput {
            entries: snapshot.entries,
            progress,
            window: vec![0u8; COPY_WINDOW],
        }),
    };
    walk(&mut copy)?;
    let Pass::Copy(mut output) = copy.pass else {
        unreachable!()
    };
    control.check()?;
    if !output.entries.is_empty() || output.progress.copied != output.progress.total {
        return Err(changed());
    }
    // Guarantee the end value even if the last copy window beat the throttle.
    if output.progress.total != 0 {
        output.progress.emit();
    }
    Ok(output.progress.copied)
}

pub(crate) fn ensure_space(required: u64, available: u64) -> io::Result<()> {
    if required > available {
        return Err(io::Error::new(
            io::ErrorKind::StorageFull,
            format!("插件暂存磁盘空间不足: 需要 {required} 字节，可用 {available} 字节"),
        ));
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn available_space(path: &Path) -> io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| invalid("暂存目录名称包含 NUL"))?;
    let mut info = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // statvfs reports space available to the calling non-privileged user.
    if unsafe { libc::statvfs(path.as_ptr(), info.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let info = unsafe { info.assume_init() };
    Ok(u64::try_from(u128::from(info.f_bavail) * u128::from(info.f_frsize)).unwrap_or(u64::MAX))
}

#[cfg(windows)]
pub(crate) fn available_space(path: &Path) -> io::Result<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let path = path
        .as_os_str()
        .encode_wide()
        .chain([0])
        .collect::<Vec<_>>();
    let mut available = 0u64;
    // The first result is availability for the caller, including disk quotas.
    if unsafe {
        GetDiskFreeSpaceExW(
            path.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(available)
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn available_space(_: &Path) -> io::Result<u64> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "此平台不支持插件磁盘空间预检",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insufficient_staging_space_never_enters_copy_pass() {
        let stage = Path::new("plugins/.staging-test");
        let payload = File::open(std::env::current_exe().unwrap()).unwrap();
        let required = payload.metadata().unwrap().len();
        let mut source = Some(payload);
        let result = copy_verified_with_space(
            stage,
            None,
            CopyControl::SILENT,
            |pass| {
                assert!(pass.scanning(), "preflight failure started writing staging");
                let stamp = SourceStamp {
                    volume: 0,
                    identity: 0,
                    len: required,
                    last_write: (0, 0),
                    last_change: (0, 0),
                    directory: false,
                };
                pass.file(
                    &stage.join("payload"),
                    source.take().unwrap(),
                    stamp,
                    |_| panic!("preflight failed"),
                )
            },
            |volume| {
                assert_eq!(volume, Path::new("plugins"));
                Ok(required - 1)
            },
        );
        assert!(matches!(result, Err(error) if error.kind() == io::ErrorKind::StorageFull));
    }

    #[test]
    fn install_progress_serializes_with_renderer_field_names() {
        let payload = serde_json::to_value(PluginInstallProgress::Copying {
            copied_bytes: 4,
            total_bytes: 8,
            available_bytes: 16,
        })
        .unwrap();
        assert_eq!(
            payload,
            serde_json::json!({ "phase": "copying", "copiedBytes": 4, "totalBytes": 8, "availableBytes": 16 })
        );
    }
}
