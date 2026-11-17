//! Handle-based, bounded filesystem primitives for plugin FS operations.
//!
//! Every path is opened one component at a time from a pinned root directory
//! handle. Directory cursors retain the directory handles and enumerate from
//! those handles, so a directory or ancestor replaced between pages cannot
//! redirect a later operation through a pathname.

use std::ffi::OsStr;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

use super::sanitize_plugin_rel_path;

/// Metadata protection is a response/working-set soft budget, not a file-size
/// or total-memory quota. Range batches use their separate scheduler budget.
const MAX_PAGE_METADATA_BYTES: usize = 1024 * 1024;
const MAX_REL_UTF8_BYTES: usize = 4096;
const MAX_CURSOR_DEPTH: usize = 128;
const PAGE_ENTRY_FIXED_BYTES: usize = 160;
const PAGE_UTF8_EXPANSION: usize = 6;

#[derive(Debug)]
pub struct OpenedFile {
    pub file: File,
    pub len: u64,
}

#[derive(Debug)]
struct EntryInfo {
    kind: &'static str,
    size: u64,
    modified_ms: u64,
    handle: Option<File>,
}

/// A resumable handle-based directory walk. The cursor never reopens a
/// directory by path between pages.
pub struct DirectoryCursor {
    stack: Vec<DirectoryFrame>,
    recursive: bool,
    pending: Option<PendingEntry>,
}

struct PendingEntry {
    name: String,
    rel: String,
    info: EntryInfo,
}

struct DirectoryFrame {
    anchor: File,
    stream: DirectoryStream,
    rel: String,
}

#[derive(Debug)]
pub struct DirectoryEntry {
    pub name: String,
    pub rel: String,
    pub kind: &'static str,
    pub size: u64,
    pub modified_ms: u64,
    /// Kept for the existing internal shape. Descents use the pinned handle,
    /// never this path value; it is therefore always `None` for new cursors.
    #[allow(dead_code)]
    pub descend: Option<PathBuf>,
}

fn io_error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}

fn not_found_or(context: &str, error: std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::NotFound {
        "PLUGIN_FILE_NOT_FOUND".to_string()
    } else {
        io_error(context, error)
    }
}

fn require_normal_component(component: Component<'_>) -> Result<&OsStr, String> {
    match component {
        Component::Normal(name) => Ok(name),
        _ => Err("路径含非普通组件".into()),
    }
}

fn modified_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

#[cfg(unix)]
mod platform {
    use super::*;
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::fs::MetadataExt;

    pub struct DirectoryName {
        pub name: std::ffi::OsString,
    }

    pub struct DirectoryStream(*mut libc::DIR);

    // SAFETY: this uniquely owns the DIR stream. next_name requires &mut self,
    // the pointer never escapes, and DirectoryCursor is exclusively borrowed
    // (behind the registry's Mutex) when moved between blocking I/O tasks.
    // POSIX permits sequential access from different threads, but not concurrent
    // readdir/closedir calls on one stream. Deliberately do not implement Sync.
    unsafe impl Send for DirectoryStream {}

    impl Drop for DirectoryStream {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }

    impl DirectoryStream {
        pub fn open(dir: &File) -> Result<Self, String> {
            let duplicate = unsafe { libc::fcntl(dir.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
            if duplicate < 0 {
                return Err(io_error(
                    "打开目录枚举句柄失败",
                    std::io::Error::last_os_error(),
                ));
            }
            let stream = unsafe { libc::fdopendir(duplicate) };
            if stream.is_null() {
                let error = std::io::Error::last_os_error();
                unsafe {
                    libc::close(duplicate);
                }
                return Err(io_error("打开目录枚举句柄失败", error));
            }
            Ok(Self(stream))
        }

        pub fn next_name(&mut self) -> Result<Option<DirectoryName>, String> {
            loop {
                // readdir returns null for both EOF and errors, so clear errno
                // before each call and fail closed when errno is set.
                #[cfg(target_os = "linux")]
                let errno = unsafe { libc::__errno_location() };
                #[cfg(any(target_os = "android", target_os = "netbsd", target_os = "openbsd"))]
                let errno = unsafe { libc::__errno() };
                #[cfg(any(
                    target_vendor = "apple",
                    target_os = "freebsd",
                    target_os = "dragonfly"
                ))]
                let errno = unsafe { libc::__error() };
                #[cfg(not(any(
                    target_os = "linux",
                    target_os = "android",
                    target_os = "netbsd",
                    target_os = "openbsd",
                    target_vendor = "apple",
                    target_os = "freebsd",
                    target_os = "dragonfly"
                )))]
                let errno: *mut libc::c_int = std::ptr::null_mut();
                if errno.is_null() {
                    return Err("当前 Unix 平台不支持安全目录错误检查".into());
                }
                unsafe {
                    *errno = 0;
                }
                let item = unsafe { libc::readdir(self.0) };
                if item.is_null() {
                    let error = unsafe { *errno };
                    return if error == 0 {
                        Ok(None)
                    } else {
                        Err(io_error(
                            "目录条目不可读",
                            std::io::Error::from_raw_os_error(error),
                        ))
                    };
                }
                let bytes = unsafe { std::ffi::CStr::from_ptr((*item).d_name.as_ptr()).to_bytes() };
                if bytes == b"." || bytes == b".." {
                    continue;
                }
                return Ok(Some(DirectoryName {
                    name: std::ffi::OsString::from_vec(bytes.to_vec()),
                }));
            }
        }
    }

    fn open_flags(directory: bool) -> libc::c_int {
        libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if directory { libc::O_DIRECTORY } else { 0 }
    }

    fn open_at(parent: &File, name: &OsStr, directory: bool) -> Result<File, String> {
        let name = CString::new(name.as_bytes()).map_err(|_| "路径段含 NUL".to_string())?;
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), open_flags(directory)) };
        if fd < 0 {
            return Err(not_found_or(
                "打开路径组件失败",
                std::io::Error::last_os_error(),
            ));
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    pub fn open_root(root: &Path) -> Result<File, String> {
        let mut current = if root.is_absolute() {
            let slash = CString::new("/").expect("literal");
            let fd = unsafe { libc::open(slash.as_ptr(), open_flags(true)) };
            if fd < 0 {
                return Err(io_error(
                    "打开插件根目录失败",
                    std::io::Error::last_os_error(),
                ));
            }
            unsafe { File::from_raw_fd(fd) }
        } else {
            let dot = CString::new(".").expect("literal");
            let fd = unsafe { libc::open(dot.as_ptr(), open_flags(true)) };
            if fd < 0 {
                return Err(io_error(
                    "打开当前目录失败",
                    std::io::Error::last_os_error(),
                ));
            }
            unsafe { File::from_raw_fd(fd) }
        };
        for component in root.components() {
            match component {
                Component::RootDir | Component::CurDir => {}
                Component::Normal(name) => current = open_at(&current, name, true)?,
                Component::ParentDir => return Err("插件根目录不得包含 ..".into()),
                Component::Prefix(_) => return Err("不支持的插件根目录前缀".into()),
            }
        }
        let metadata = current
            .metadata()
            .map_err(|error| io_error("插件根目录句柄不可读", error))?;
        if !metadata.is_dir() {
            return Err("插件根目录必须是普通目录".into());
        }
        Ok(current)
    }

    pub fn open_child_dir(parent: &File, name: &OsStr) -> Result<File, String> {
        let file = open_at(parent, name, true)?;
        let metadata = file
            .metadata()
            .map_err(|error| io_error("目录句柄不可读", error))?;
        if !metadata.is_dir() {
            return Err("路径中间组件不是目录".into());
        }
        Ok(file)
    }

    pub fn inspect_child(parent: &File, name: &OsStr) -> Result<EntryInfo, String> {
        let c_name = CString::new(name.as_bytes()).map_err(|_| "路径段含 NUL".to_string())?;
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::fstatat(
                parent.as_raw_fd(),
                c_name.as_ptr(),
                &mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } != 0
        {
            return Err(not_found_or(
                "目录条目不可达",
                std::io::Error::last_os_error(),
            ));
        }
        let mode = stat.st_mode as libc::mode_t;
        let kind = mode & libc::S_IFMT;
        if kind == libc::S_IFLNK {
            return Ok(EntryInfo {
                kind: "other",
                size: 0,
                modified_ms: 0,
                handle: None,
            });
        }
        if kind == libc::S_IFDIR {
            let handle = open_child_dir(parent, name)?;
            let metadata = handle
                .metadata()
                .map_err(|error| io_error("目录句柄不可读", error))?;
            return Ok(EntryInfo {
                kind: "directory",
                size: 0,
                modified_ms: modified_ms(&metadata),
                handle: Some(handle),
            });
        }
        if kind != libc::S_IFREG || stat.st_nlink != 1 {
            return Ok(EntryInfo {
                kind: "other",
                size: 0,
                modified_ms: 0,
                handle: None,
            });
        }
        let handle = open_at(parent, name, false)?;
        let metadata = handle
            .metadata()
            .map_err(|error| io_error("文件句柄不可读", error))?;
        if !metadata.is_file() {
            return Err("目录条目类型在打开期间变化".into());
        }
        if metadata.nlink() != 1 {
            return Ok(EntryInfo {
                kind: "other",
                size: 0,
                modified_ms: 0,
                handle: None,
            });
        }
        Ok(EntryInfo {
            kind: "file",
            size: metadata.len(),
            modified_ms: modified_ms(&metadata),
            handle: Some(handle),
        })
    }

    pub fn open_regular_mode(
        root: &Path,
        rel: &Path,
        reject_hardlink: bool,
    ) -> Result<OpenedFile, String> {
        let mut components = rel.components();
        let last = components
            .next_back()
            .ok_or_else(|| "文件相对路径不能为空".to_string())?;
        let last = require_normal_component(last)?;
        let mut parent = open_root(root)?;
        for component in components {
            let name = require_normal_component(component)?;
            parent = open_child_dir(&parent, name)?;
        }
        let opened = open_at(&parent, last, false)?;
        let metadata = opened
            .metadata()
            .map_err(|error| io_error("文件句柄不可读", error))?;
        if !metadata.is_file() {
            return Err("目标不是普通文件".into());
        }
        if reject_hardlink && metadata.nlink() != 1 {
            return Err("插件文件不得是硬链接".into());
        }
        Ok(OpenedFile {
            len: metadata.len(),
            file: opened,
        })
    }

    pub fn open_directory(root: &Path, rel: &Path) -> Result<File, String> {
        let mut directory = open_root(root)?;
        for component in rel.components() {
            let name = require_normal_component(component)?;
            directory = open_child_dir(&directory, name)?;
        }
        Ok(directory)
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };

    const OBJ_CASE_INSENSITIVE: u32 = 0x40;
    const OBJ_DONT_REPARSE: u32 = 0x1000;
    const FILE_OPEN: u32 = 1;
    const FILE_DIRECTORY_FILE: u32 = 1;
    const FILE_NON_DIRECTORY_FILE: u32 = 0x40;
    const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const SYNCHRONOUS_IO_NONALERT: u32 = 0x20;
    const STATUS_NO_MORE_FILES: i32 = 0x8000_0006u32 as i32;
    const STATUS_BUFFER_OVERFLOW: i32 = 0x8000_0005u32 as i32;
    const FILE_ID_BOTH_DIRECTORY_INFORMATION: u32 = 37;

    #[repr(C)]
    struct UnicodeString {
        length: u16,
        maximum_length: u16,
        buffer: *mut u16,
    }
    #[repr(C)]
    struct ObjectAttributes {
        length: u32,
        root: *mut std::ffi::c_void,
        name: *mut UnicodeString,
        attributes: u32,
        security: *mut std::ffi::c_void,
        quality: *mut std::ffi::c_void,
    }
    #[repr(C)]
    struct IoStatusBlock {
        status: i32,
        information: usize,
    }
    #[allow(clashing_extern_declarations)]
    #[link(name = "ntdll")]
    extern "system" {
        fn NtCreateFile(
            handle: *mut *mut std::ffi::c_void,
            access: u32,
            attributes: *mut ObjectAttributes,
            status: *mut IoStatusBlock,
            size: *mut i64,
            file_attributes: u32,
            share: u32,
            disposition: u32,
            options: u32,
            ea: *mut std::ffi::c_void,
            ea_length: u32,
        ) -> i32;
        fn NtQueryDirectoryFile(
            file_handle: *mut std::ffi::c_void,
            event: *mut std::ffi::c_void,
            apc_routine: *mut std::ffi::c_void,
            apc_context: *mut std::ffi::c_void,
            io_status: *mut IoStatusBlock,
            information: *mut std::ffi::c_void,
            length: u32,
            information_class: u32,
            return_single_entry: u8,
            file_name: *mut std::ffi::c_void,
            restart_scan: u8,
        ) -> i32;
        fn RtlNtStatusToDosError(status: i32) -> u32;
    }

    pub struct DirectoryName {
        pub name: std::ffi::OsString,
        pub reparse: bool,
        pub directory: bool,
    }

    pub struct DirectoryStream {
        handle: File,
        buffer: Vec<u8>,
        offset: usize,
        length: usize,
        done: bool,
        restart: bool,
    }

    impl DirectoryStream {
        pub fn open(dir: &File) -> Result<Self, String> {
            Ok(Self {
                handle: dir
                    .try_clone()
                    .map_err(|error| io_error("复制目录枚举句柄失败", error))?,
                buffer: vec![0; 64 * 1024],
                offset: 0,
                length: 0,
                done: false,
                restart: true,
            })
        }

        fn refill(&mut self) -> Result<(), String> {
            if self.done {
                return Ok(());
            }
            let mut status = IoStatusBlock {
                status: 0,
                information: 0,
            };
            let result = unsafe {
                NtQueryDirectoryFile(
                    self.handle.as_raw_handle(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut status,
                    self.buffer.as_mut_ptr().cast(),
                    self.buffer.len() as u32,
                    FILE_ID_BOTH_DIRECTORY_INFORMATION,
                    0,
                    std::ptr::null_mut(),
                    u8::from(self.restart),
                )
            };
            self.restart = false;
            if result == STATUS_NO_MORE_FILES {
                self.done = true;
                self.offset = 0;
                self.length = 0;
                return Ok(());
            }
            if result < 0 && result != STATUS_BUFFER_OVERFLOW {
                let code = unsafe { RtlNtStatusToDosError(result) } as i32;
                return Err(io_error(
                    "目录枚举失败",
                    std::io::Error::from_raw_os_error(code),
                ));
            }
            if (result != 0 && result != STATUS_BUFFER_OVERFLOW) || status.status != result {
                return Err("目录枚举返回异常完成状态".into());
            }
            if status.information > self.buffer.len() {
                return Err("目录枚举返回超出缓冲区的长度".into());
            }
            self.offset = 0;
            self.length = status.information;
            if self.length == 0 {
                self.done = true;
            }
            Ok(())
        }

        pub fn next_name(&mut self) -> Result<Option<DirectoryName>, String> {
            loop {
                if self.offset >= self.length {
                    self.refill()?;
                    if self.done {
                        return Ok(None);
                    }
                }
                if self.length - self.offset < 104 {
                    return Err("目录枚举记录损坏".into());
                }
                let base = self.offset;
                let next =
                    u32::from_le_bytes(self.buffer[base..base + 4].try_into().unwrap()) as usize;
                let record_end = if next == 0 {
                    self.length
                } else {
                    base.checked_add(next)
                        .ok_or_else(|| "目录枚举记录溢出".to_string())?
                };
                let name_start = base
                    .checked_add(104)
                    .ok_or_else(|| "目录枚举记录溢出".to_string())?;
                if record_end > self.length || record_end < name_start {
                    return Err("目录枚举记录损坏".into());
                }
                let attributes =
                    u32::from_le_bytes(self.buffer[base + 56..base + 60].try_into().unwrap());
                let name_len =
                    u32::from_le_bytes(self.buffer[base + 60..base + 64].try_into().unwrap())
                        as usize;
                let name_end = name_start
                    .checked_add(name_len)
                    .ok_or_else(|| "目录枚举名称长度溢出".to_string())?;
                if !name_len.is_multiple_of(2) || name_end > record_end {
                    return Err("目录枚举名称损坏".into());
                }
                let words = &self.buffer[name_start..name_end];
                let name = std::ffi::OsString::from_wide(
                    &words
                        .as_chunks::<2>()
                        .0
                        .iter()
                        .map(|pair| u16::from_le_bytes(*pair))
                        .collect::<Vec<_>>(),
                );
                self.offset = if next == 0 { self.length } else { record_end };
                if name == "." || name == ".." {
                    continue;
                }
                return Ok(Some(DirectoryName {
                    name,
                    reparse: attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
                    directory: attributes & FILE_ATTRIBUTE_DIRECTORY != 0,
                }));
            }
        }
    }

    fn opened_identity(file: &File, directory: bool) -> Result<std::fs::Metadata, String> {
        let metadata = file
            .metadata()
            .map_err(|error| io_error("文件句柄不可读", error))?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || (directory && !metadata.is_dir())
            || (!directory && !metadata.is_file())
        {
            return Err("插件路径含重解析点或类型变化".into());
        }
        Ok(metadata)
    }

    fn open_anchor_path(path: &Path) -> Result<File, String> {
        let mut options = std::fs::OpenOptions::new();
        options
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
        let file = options
            .open(path)
            .map_err(|error| not_found_or("打开插件根目录失败", error))?;
        opened_identity(&file, true)?;
        Ok(file)
    }

    fn open_relative(parent: &File, name: &OsStr, directory: bool) -> Result<File, String> {
        let mut wide: Vec<u16> = name.encode_wide().collect();
        if wide.is_empty()
            || wide.len() > u16::MAX as usize / 2
            || wide.iter().any(|value| matches!(*value, 0 | 47 | 92 | 58))
        {
            return Err("插件路径段无效".into());
        }
        let mut unicode = UnicodeString {
            length: (wide.len() * 2) as u16,
            maximum_length: (wide.len() * 2) as u16,
            buffer: wide.as_mut_ptr(),
        };
        let mut attributes = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            root: parent.as_raw_handle(),
            name: &mut unicode,
            attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
            security: std::ptr::null_mut(),
            quality: std::ptr::null_mut(),
        };
        let mut status = IoStatusBlock {
            status: 0,
            information: 0,
        };
        let mut handle = std::ptr::null_mut();
        let options = FILE_OPEN_REPARSE_POINT
            | SYNCHRONOUS_IO_NONALERT
            | if directory {
                FILE_DIRECTORY_FILE
            } else {
                FILE_NON_DIRECTORY_FILE
            };
        let result = unsafe {
            NtCreateFile(
                &mut handle,
                0x0012_0089,
                &mut attributes,
                &mut status,
                std::ptr::null_mut(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                FILE_OPEN,
                options,
                std::ptr::null_mut(),
                0,
            )
        };
        if result < 0 {
            let code = unsafe { RtlNtStatusToDosError(result) } as i32;
            return Err(not_found_or(
                "打开路径组件失败",
                std::io::Error::from_raw_os_error(code),
            ));
        }
        Ok(unsafe { File::from_raw_handle(handle) })
    }

    pub fn open_root(root: &Path) -> Result<File, String> {
        let absolute = if root.is_absolute() {
            root.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|error| io_error("当前目录不可达", error))?
                .join(root)
        };
        let mut components = absolute.components();
        let prefix = components
            .next()
            .ok_or_else(|| "插件根目录为空".to_string())?;
        let mut volume = PathBuf::from(prefix.as_os_str());
        volume.push("\\");
        let mut current = open_anchor_path(&volume)?;
        for component in components {
            match component {
                Component::RootDir | Component::CurDir => {}
                Component::Normal(name) => current = open_relative(&current, name, true)?,
                Component::ParentDir => return Err("插件根目录不得包含 ..".into()),
                Component::Prefix(_) => return Err("插件根目录前缀无效".into()),
            }
        }
        opened_identity(&current, true)?;
        Ok(current)
    }

    pub fn open_child_dir(parent: &File, name: &OsStr) -> Result<File, String> {
        let child = open_relative(parent, name, true)?;
        opened_identity(&child, true)?;
        Ok(child)
    }

    pub fn inspect_child(parent: &File, entry: &DirectoryName) -> Result<EntryInfo, String> {
        if entry.reparse {
            return Ok(EntryInfo {
                kind: "other",
                size: 0,
                modified_ms: 0,
                handle: None,
            });
        }
        if entry.directory {
            let child = open_child_dir(parent, &entry.name)?;
            let metadata = opened_identity(&child, true)?;
            return Ok(EntryInfo {
                kind: "directory",
                size: 0,
                modified_ms: modified_ms(&metadata),
                handle: Some(child),
            });
        }
        let child = open_relative(parent, &entry.name, false)?;
        let metadata = opened_identity(&child, false)?;
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(child.as_raw_handle(), &mut information) } == 0 {
            return Err(io_error(
                "读取文件身份失败",
                std::io::Error::last_os_error(),
            ));
        }
        if information.nNumberOfLinks != 1 {
            return Ok(EntryInfo {
                kind: "other",
                size: 0,
                modified_ms: 0,
                handle: None,
            });
        }
        Ok(EntryInfo {
            kind: "file",
            size: metadata.len(),
            modified_ms: modified_ms(&metadata),
            handle: Some(child),
        })
    }

    pub fn open_regular_mode(
        root: &Path,
        rel: &Path,
        reject_hardlink: bool,
    ) -> Result<OpenedFile, String> {
        let mut components = rel.components();
        let last = components
            .next_back()
            .ok_or_else(|| "文件相对路径不能为空".to_string())?;
        let last = require_normal_component(last)?;
        let mut parent = open_root(root)?;
        for component in components {
            let name = require_normal_component(component)?;
            parent = open_child_dir(&parent, name)?;
        }
        let opened = open_relative(&parent, last, false)?;
        let metadata = opened_identity(&opened, false)?;
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(opened.as_raw_handle(), &mut information) } == 0 {
            return Err(io_error(
                "读取文件身份失败",
                std::io::Error::last_os_error(),
            ));
        }
        if reject_hardlink && information.nNumberOfLinks != 1 {
            return Err("插件文件不得是硬链接".into());
        }
        Ok(OpenedFile {
            len: metadata.len(),
            file: opened,
        })
    }

    pub fn open_directory(root: &Path, rel: &Path) -> Result<File, String> {
        let mut directory = open_root(root)?;
        for component in rel.components() {
            let name = require_normal_component(component)?;
            directory = open_child_dir(&directory, name)?;
        }
        Ok(directory)
    }
}

#[cfg(not(any(unix, windows)))]
mod platform {
    use super::*;

    pub struct DirectoryName {
        pub name: std::ffi::OsString,
    }
    pub struct DirectoryStream;
    impl DirectoryStream {
        pub fn open(_: &File) -> Result<Self, String> {
            Err("此平台不支持安全目录枚举".into())
        }
        pub fn next_name(&mut self) -> Result<Option<DirectoryName>, String> {
            Ok(None)
        }
    }
    pub fn open_root(_: &Path) -> Result<File, String> {
        Err("此平台不支持安全文件访问".into())
    }
    pub fn open_regular_mode(_: &Path, _: &Path, _: bool) -> Result<OpenedFile, String> {
        Err("此平台不支持安全文件访问".into())
    }
    pub fn open_directory(_: &Path, _: &Path) -> Result<File, String> {
        Err("此平台不支持安全目录枚举".into())
    }
    pub fn inspect_child(_: &File, _: &DirectoryName) -> Result<EntryInfo, String> {
        Err("此平台不支持安全目录枚举".into())
    }
}

use platform::DirectoryStream;

/// Directory grants preserve native filename semantics. In particular Unix
/// names containing '~', ':' or a trailing dot/space are not package aliases.
/// This is shared with the historical directory commands, not a new policy.
pub fn sanitize_directory_rel(raw: &str) -> Result<(PathBuf, String), String> {
    if raw.len() > MAX_REL_UTF8_BYTES {
        return Err("目录相对路径超过长度上限".into());
    }
    if raw.is_empty() {
        return Ok((PathBuf::new(), String::new()));
    }
    let normalized = raw.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err("目录相对路径不能是绝对路径".into());
    }
    let mut out = PathBuf::new();
    let mut parts = Vec::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("目录相对路径不允许 ..".into());
        }
        if part.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
            return Err("目录相对路径含控制字符".into());
        }
        if parts.is_empty() && part.len() == 2 && part.ends_with(':') {
            return Err("Windows 盘符路径不允许".into());
        }
        #[cfg(windows)]
        if part.ends_with(['.', ' ']) || part.contains(':') || super::is_reserved_windows_name(part)
        {
            return Err(format!("目录相对路径含 Windows 路径别名: {part}"));
        }
        out.push(part);
        parts.push(part.to_string());
    }
    Ok((out, parts.join("/")))
}

/// Open a regular package/private file using pinned component-relative handles.
pub fn open_regular_file(root: &Path, rel: &str) -> Result<OpenedFile, String> {
    let normalized = sanitize_plugin_rel_path(rel)?;
    platform::open_regular_mode(root, &normalized, true)
}

/// Open a legacy directory-grant file using the same safe component handles.
/// Unlike new range reads, the historical directory API allowed a final regular
/// hardlink; links/reparse points and special files remain rejected.
pub fn open_legacy_directory_file(root: &Path, rel: &str) -> Result<OpenedFile, String> {
    let (normalized, _) = sanitize_directory_rel(rel)?;
    platform::open_regular_mode(root, &normalized, false)
}

/// New directory-grant windows retain native filename semantics but reject
/// hardlinks just like new package/private range reads.
pub fn open_directory_range_file(root: &Path, rel: &str) -> Result<OpenedFile, String> {
    let (normalized, _) = sanitize_directory_rel(rel)?;
    platform::open_regular_mode(root, &normalized, true)
}

/// Read one range. EOF and short reads are successful; interrupted syscalls
/// are retried so transient signals cannot produce a truncated result.
pub fn read_open_range(
    mut opened: OpenedFile,
    offset: u64,
    length: usize,
) -> Result<Vec<u8>, String> {
    if length == 0 || offset >= opened.len {
        return Ok(Vec::new());
    }
    let available = opened.len - offset;
    let count = available.min(length as u64) as usize;
    loop {
        match opened.file.seek(SeekFrom::Start(offset)) {
            Ok(_) => break,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(io_error("定位文件失败", error)),
        }
    }
    let mut bytes = vec![0u8; count];
    let mut read = 0usize;
    while read < count {
        match opened.file.read(&mut bytes[read..]) {
            Ok(0) => {
                bytes.truncate(read);
                break;
            }
            Ok(got) => read += got,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(io_error("读取文件失败", error)),
        }
    }
    bytes.truncate(read);
    Ok(bytes)
}

#[cfg(test)]
pub fn read_range(root: &Path, rel: &str, offset: u64, length: usize) -> Result<Vec<u8>, String> {
    read_open_range(open_regular_file(root, rel)?, offset, length)
}

impl DirectoryCursor {
    pub fn open(root: &Path, rel: &str, recursive: bool) -> Result<Self, String> {
        let (normalized, _) = sanitize_directory_rel(rel)?;
        let initial_rel = normalized.to_string_lossy().replace('\\', "/");
        if initial_rel.len() > MAX_REL_UTF8_BYTES {
            return Err("插件目录相对路径超过 4096 UTF-8 字节".into());
        }
        let anchor = platform::open_directory(root, &normalized)?;
        let stream = DirectoryStream::open(&anchor)?;
        Ok(Self {
            stack: vec![DirectoryFrame {
                anchor,
                stream,
                rel: initial_rel,
            }],
            recursive,
            pending: None,
        })
    }

    /// Produce at most `limit` entries without materializing or sorting a tree.
    /// The response metadata estimate is capped independently from file content;
    /// an entry that would cross the cap is retained in `pending` for the next
    /// page together with its already-open child handle.
    pub fn next_page(&mut self, limit: usize) -> Result<(Vec<DirectoryEntry>, bool), String> {
        let mut out = Vec::with_capacity(limit);
        let mut metadata_used = 0usize;
        while out.len() < limit {
            let pending = if let Some(pending) = self.pending.take() {
                pending
            } else {
                let Some(frame) = self.stack.last_mut() else {
                    break;
                };
                let Some(name) = frame.stream.next_name()? else {
                    self.stack.pop();
                    continue;
                };
                let parent_rel = frame.rel.clone();
                let info = match platform::inspect_child(&frame.anchor, &name) {
                    Ok(info) => info,
                    Err(error) if error == "PLUGIN_FILE_NOT_FOUND" => continue,
                    Err(error) => return Err(error),
                };
                let name_text = name
                    .name
                    .to_str()
                    .ok_or_else(|| "目录条目名称不是合法文本".to_string())?
                    .to_string();
                let rel = if parent_rel.is_empty() {
                    name_text.clone()
                } else {
                    format!("{parent_rel}/{name_text}")
                };
                if rel.len() > MAX_REL_UTF8_BYTES {
                    return Err("插件目录相对路径超过 4096 UTF-8 字节".into());
                }
                PendingEntry {
                    name: name_text,
                    rel,
                    info,
                }
            };
            let text_bytes = pending.name.len().saturating_add(pending.rel.len());
            let estimate = text_bytes
                .checked_mul(PAGE_UTF8_EXPANSION)
                .and_then(|value| value.checked_add(PAGE_ENTRY_FIXED_BYTES))
                .ok_or_else(|| "插件目录分页元数据预算溢出".to_string())?;
            if estimate > MAX_PAGE_METADATA_BYTES.saturating_sub(metadata_used) {
                if out.is_empty() {
                    return Err("单条插件目录元数据超过分页预算".into());
                }
                self.pending = Some(pending);
                break;
            }
            metadata_used += estimate;
            let PendingEntry { name, rel, info } = pending;
            let should_descend = self.recursive && info.kind == "directory";
            if should_descend && self.stack.len() >= MAX_CURSOR_DEPTH {
                return Err("插件目录递归深度超过上限".into());
            }
            let EntryInfo {
                kind,
                size,
                modified_ms,
                handle,
            } = info;
            out.push(DirectoryEntry {
                name,
                rel: rel.clone(),
                kind,
                size,
                modified_ms,
                descend: None,
            });
            if should_descend {
                let child = handle.ok_or_else(|| "目录句柄不可用".to_string())?;
                let stream = DirectoryStream::open(&child)?;
                self.stack.push(DirectoryFrame {
                    anchor: child,
                    stream,
                    rel,
                });
            }
        }
        Ok((out, self.pending.is_some() || !self.stack.is_empty()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_root() -> PathBuf {
        std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("hypercom-fs-access-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn cursors_can_move_between_serialized_blocking_workers() {
        fn assert_send<T: Send>() {}
        assert_send::<DirectoryCursor>();
    }

    #[cfg(unix)]
    #[test]
    fn directory_grants_keep_legal_unix_names_and_case() {
        let root = unique_root();
        std::fs::create_dir_all(root.join("DATA")).unwrap();
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::write(root.join("DATA/x"), b"upper").unwrap();
        std::fs::write(root.join("data/x"), b"lower").unwrap();
        assert_eq!(
            read_open_range(open_directory_range_file(&root, "DATA/x").unwrap(), 0, 10).unwrap(),
            b"upper"
        );
        for name in ["a~b", "a:b", "a.", "a "] {
            std::fs::write(root.join(name), b"native").unwrap();
            assert_eq!(
                read_open_range(open_legacy_directory_file(&root, name).unwrap(), 0, 10).unwrap(),
                b"native"
            );
            assert_eq!(
                read_open_range(open_directory_range_file(&root, name).unwrap(), 0, 10).unwrap(),
                b"native"
            );
            assert!(
                open_regular_file(&root, name).is_err(),
                "package policy stays strict"
            );
        }
        std::fs::create_dir_all(root.join("sub~dir")).unwrap();
        std::fs::write(root.join("sub~dir/x"), b"x").unwrap();
        let mut cursor = DirectoryCursor::open(&root, "sub~dir", false).unwrap();
        assert_eq!(cursor.next_page(10).unwrap().0[0].rel, "sub~dir/x");
        drop(cursor);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pagination_respects_metadata_budget_without_losing_entries() {
        let root = unique_root();
        std::fs::create_dir_all(&root).unwrap();
        for index in 0..600 {
            std::fs::write(root.join(format!("{index:04}-{}", "n".repeat(180))), []).unwrap();
        }
        let mut cursor = DirectoryCursor::open(&root, "", false).unwrap();
        let mut seen = std::collections::HashSet::new();
        let mut pages = 0;
        loop {
            let (entries, more) = cursor.next_page(1000).unwrap();
            let estimate: usize = entries
                .iter()
                .map(|entry| {
                    (entry.name.len() + entry.rel.len()) * PAGE_UTF8_EXPANSION
                        + PAGE_ENTRY_FIXED_BYTES
                })
                .sum();
            assert!(estimate <= MAX_PAGE_METADATA_BYTES);
            for entry in entries {
                assert!(seen.insert(entry.rel), "no duplicate page entries");
            }
            pages += 1;
            if !more {
                break;
            }
            assert!(pages < 10, "the cursor must make progress");
        }
        assert_eq!(seen.len(), 600);
        assert!(
            pages > 1,
            "a byte-full page must preserve the pending entry"
        );
        drop(cursor);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn range_reads_seeked_bytes_and_short_eof() {
        let root = unique_root();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("x"), b"abcdef").unwrap();
        assert_eq!(read_range(&root, "x", 2, 3).unwrap(), b"cde");
        assert_eq!(read_range(&root, "x", 99, 3).unwrap(), b"");
        assert_eq!(read_range(&root, "x", 4, 99).unwrap(), b"ef");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn reads_a_tiny_window_above_four_gib_without_loading_the_file() {
        use std::io::{Seek, SeekFrom, Write};
        let root = unique_root();
        std::fs::create_dir_all(&root).unwrap();
        let mut file = File::create(root.join("large.bin")).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            #[link(name = "kernel32")]
            extern "system" {
                fn DeviceIoControl(
                    device: *mut std::ffi::c_void,
                    code: u32,
                    input: *mut std::ffi::c_void,
                    input_size: u32,
                    output: *mut std::ffi::c_void,
                    output_size: u32,
                    returned: *mut u32,
                    overlapped: *mut std::ffi::c_void,
                ) -> i32;
            }
            let mut returned = 0;
            // FSCTL_SET_SPARSE keeps this logical 5 GiB fixture tiny on disk.
            let sparse = unsafe {
                DeviceIoControl(
                    file.as_raw_handle(),
                    0x0009_00c4,
                    std::ptr::null_mut(),
                    0,
                    std::ptr::null_mut(),
                    0,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            };
            assert_ne!(
                sparse,
                0,
                "test filesystem must support sparse files: {}",
                std::io::Error::last_os_error()
            );
        }
        let offset = 5u64 * 1024 * 1024 * 1024 + 7;
        file.set_len(offset + 3).unwrap();
        file.seek(SeekFrom::Start(offset)).unwrap();
        file.write_all(b"end").unwrap();
        file.sync_all().unwrap();
        drop(file);
        assert_eq!(
            read_range(&root, "large.bin", offset - 1, 16).unwrap(),
            b"\0end"
        );
        assert_eq!(read_range(&root, "large.bin", offset + 3, 16).unwrap(), b"");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cursor_is_incremental_and_handle_based() {
        let root = unique_root();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("a"), b"a").unwrap();
        std::fs::write(root.join("sub/b"), b"b").unwrap();
        let mut cursor = DirectoryCursor::open(&root, "", true).unwrap();
        let (first, more) = cursor.next_page(1).unwrap();
        assert_eq!(first.len(), 1);
        assert!(more);
        // Replacing the pathname after open cannot change the pinned cursor.
        let moved = root.with_extension("moved");
        std::fs::rename(&root, &moved).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("evil"), b"evil").unwrap();
        let (second, _) = cursor.next_page(10).unwrap();
        assert!(!second.iter().any(|entry| entry.name == "evil"));
        assert!(second.iter().any(|entry| entry.rel == "sub/b"));
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(moved);
    }

    #[cfg(unix)]
    #[test]
    fn root_and_child_symlinks_are_rejected_or_other() {
        use std::os::unix::fs::symlink;
        let root = unique_root();
        let outside = unique_root();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret"), b"secret").unwrap();
        symlink(&outside, root.join("link-dir")).unwrap();
        assert!(open_regular_file(&root, "link-dir/secret").is_err());
        let mut cursor = DirectoryCursor::open(&root, "", false).unwrap();
        let (entries, _) = cursor.next_page(10).unwrap();
        assert!(entries
            .iter()
            .any(|entry| entry.name == "link-dir" && entry.kind == "other"));
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(outside);
    }

    #[test]
    fn hardlinked_file_is_not_read() {
        use std::fs::hard_link;
        let root = unique_root();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("x"), b"x").unwrap();
        hard_link(root.join("x"), root.join("y")).unwrap();
        assert!(open_regular_file(&root, "x").is_err());
        assert_eq!(
            read_open_range(open_legacy_directory_file(&root, "x").unwrap(), 0, 1).unwrap(),
            b"x"
        );
        let mut cursor = DirectoryCursor::open(&root, "", false).unwrap();
        let (entries, _) = cursor.next_page(10).unwrap();
        assert!(entries
            .iter()
            .filter(|entry| entry.name == "x" || entry.name == "y")
            .all(|entry| entry.kind == "other"));
        let _ = std::fs::remove_dir_all(root);
    }
}
