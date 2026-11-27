use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};
#[cfg(windows)]
use zeroize::Zeroize;
use zeroize::Zeroizing;

const MAX_SECRET_BYTES: usize = 2 * 1024 * 1024;

pub(crate) fn secure_directory(path: &Path, create: bool) -> io::Result<()> {
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "credential directory must be absolute",
        ));
    }
    if path
        .components()
        .any(|piece| matches!(piece, std::path::Component::ParentDir))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "credential directory must not contain parent traversal",
        ));
    }
    #[cfg(windows)]
    if !matches!(path.components().next(), Some(std::path::Component::Prefix(prefix))
        if matches!(prefix.kind(), std::path::Prefix::Disk(_) | std::path::Prefix::VerbatimDisk(_)))
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "protected storage requires a local Windows drive",
        ));
    }
    #[cfg(windows)]
    for ancestor in path.ancestors().skip(1).filter(|part| part.is_absolute()) {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) => validate_metadata(&meta, true)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound && create => {}
            Err(error) => return Err(error),
        }
    }
    #[cfg(unix)]
    verify_unix_ancestors(path, create)?;
    if create {
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(path)?;
        }
        #[cfg(windows)]
        fs::create_dir_all(path)?;
    }
    #[cfg(unix)]
    verify_unix_ancestors(path, false)?;
    let meta = fs::symlink_metadata(path)?;
    validate_metadata(&meta, true)?;
    #[cfg(windows)]
    super::windows_acl::verify_private_owner_directory(path)?;
    Ok(())
}

#[cfg(unix)]
fn verify_unix_ancestors(path: &Path, allow_missing: bool) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let uid = unsafe { libc::geteuid() };
    // Walk from root toward the private leaf so we never follow an existing
    // ancestor symlink. Root-owned sticky directories such as /tmp may host
    // private scratch directories; their users cannot rename our entries.
    let ancestors: Vec<_> = path.ancestors().skip(1).collect();
    for ancestor in ancestors.into_iter().rev() {
        let meta = match fs::symlink_metadata(ancestor) {
            Ok(meta) => meta,
            Err(error) if allow_missing && error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        let sticky = meta.mode() & 0o1000 != 0;
        let other_can_replace = meta.mode() & 0o022 != 0 && !sticky;
        if !meta.is_dir() || ![0, uid].contains(&meta.uid()) || other_can_replace {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "credential ancestor is linked, shared, or owned by another user",
            ));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn verify_private(meta: &fs::Metadata) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "credentials require owner-only directory and file permissions",
        ));
    }
    Ok(())
}

fn validate_metadata(meta: &fs::Metadata, directory: bool) -> io::Result<()> {
    if (directory && !meta.is_dir())
        || (!directory && !meta.is_file())
        || meta.file_type().is_symlink()
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "credential path is not a regular directory/file",
        ));
    }
    #[cfg(unix)]
    verify_private(meta)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "credential paths must not be reparse points",
            ));
        }
    }
    Ok(())
}

fn options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options
}

pub(crate) fn lock_directory(dir: &Path) -> io::Result<File> {
    lock_file(&dir.join("authority.lock"))
}

pub(crate) fn lock_file(path: &Path) -> io::Result<File> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "lock path requires a parent")
    })?;
    secure_directory(parent, true)?;
    let mut options = options();
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    let lock = options
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    let meta = lock.metadata()?;
    validate_metadata(&meta, false)?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(lock)
}

pub(crate) fn read_secret(path: &Path) -> io::Result<Zeroizing<Vec<u8>>> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "credential path needs a parent",
        )
    })?;
    secure_directory(parent, false)?;
    let file = options().read(true).open(path)?;
    let meta = file.metadata()?;
    validate_metadata(&meta, false)?;
    #[cfg(windows)]
    super::windows_acl::verify_private_owner_file(path)?;
    if meta.len() > MAX_SECRET_BYTES as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid credential file",
        ));
    }
    let mut data = Zeroizing::new(Vec::new());
    file.take((MAX_SECRET_BYTES + 1) as u64)
        .read_to_end(&mut data)?;
    if data.len() > MAX_SECRET_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "credential file exceeds size limit",
        ));
    }
    #[cfg(windows)]
    {
        dpapi(&data, false)
    }
    #[cfg(not(windows))]
    Ok(data)
}

pub(crate) fn write_secret(path: &Path, plain: &[u8]) -> io::Result<()> {
    write(path, plain, true)
}

pub(crate) fn create_secret(path: &Path, plain: &[u8]) -> io::Result<()> {
    write(path, plain, false)
}

fn write(path: &Path, plain: &[u8], replace: bool) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "credential path needs a parent",
        )
    })?;
    secure_directory(parent, true)?;
    match fs::symlink_metadata(path) {
        Ok(_) if !replace => {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "protected profile already exists",
            ))
        }
        Ok(meta) => {
            validate_metadata(&meta, false)?;
            #[cfg(windows)]
            super::windows_acl::verify_private_owner_file(path)?;
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    #[cfg(windows)]
    let encrypted = dpapi(plain, true)?;
    #[cfg(windows)]
    let contents = encrypted.as_slice();
    #[cfg(not(windows))]
    let contents = plain;
    if contents.len() > MAX_SECRET_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "credential file exceeds size limit",
        ));
    }
    let mut tmp = PathBuf::from(path);
    let mut tmp_name = tmp.as_os_str().to_os_string();
    tmp_name.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
    tmp = PathBuf::from(tmp_name);
    let mut writer = options().write(true).create_new(true).open(&tmp)?;
    let result = writer.write_all(contents).and_then(|_| writer.sync_all());
    drop(writer);
    let result = result.and_then(|()| {
        if replace {
            fs::rename(&tmp, path)
        }
        // Same-directory link publishes the fully synced encrypted file in
        // one step, and the OS refuses to replace any existing destination.
        else {
            fs::hard_link(&tmp, path)
        }
    });
    if !replace || result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    #[cfg(unix)]
    if result.is_ok() {
        // The rename committed. A metadata fsync problem is not a reason to
        // keep using old permissions in memory after disk contents changed.
        let _ = File::open(parent).and_then(|directory| directory.sync_all());
    }
    result
}

#[cfg(windows)]
fn dpapi(bytes: &[u8], protecting: bool) -> io::Result<Zeroizing<Vec<u8>>> {
    use std::ptr;
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(io::Error::other)?,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let mut result = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    let ok = unsafe {
        if protecting {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut result,
            )
        } else {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut result,
            )
        }
    };
    if ok == 0 || result.pbData.is_null() {
        return Err(io::Error::last_os_error());
    }
    let buffer = unsafe { std::slice::from_raw_parts_mut(result.pbData, result.cbData as usize) };
    let output = (buffer.len() <= MAX_SECRET_BYTES).then(|| Zeroizing::new(buffer.to_vec()));
    buffer.zeroize();
    unsafe { LocalFree(result.pbData.cast()) };
    output.ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid DPAPI credential payload",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{read_secret, write_secret};
    use std::fs;

    #[test]
    fn owner_secret_roundtrips_and_replaces() {
        let dir = std::env::temp_dir().join(format!("hc-secret-{}", uuid::Uuid::new_v4()));
        let path = dir.join("record");
        write_secret(&path, b"original-private-value").unwrap();
        #[cfg(windows)]
        assert!(!fs::read(&path)
            .unwrap()
            .windows(b"original-private-value".len())
            .any(|v| v == b"original-private-value"));
        assert_eq!(
            read_secret(&path).unwrap().as_slice(),
            b"original-private-value"
        );
        write_secret(&path, b"changed").unwrap();
        assert_eq!(read_secret(&path).unwrap().as_slice(), b"changed");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            assert_eq!(
                read_secret(&path).unwrap_err().kind(),
                std::io::ErrorKind::PermissionDenied
            );
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn shared_and_linked_ancestors_are_rejected_even_under_private_leaf() {
        use std::os::unix::fs::{symlink, DirBuilderExt, PermissionsExt};
        let base = fs::canonicalize(std::env::temp_dir()).unwrap();
        let dir = base.join(format!("hc-ancestor-{}", uuid::Uuid::new_v4()));
        fs::DirBuilder::new().mode(0o700).create(&dir).unwrap();
        let writable = dir.join("shared");
        fs::create_dir(&writable).unwrap();
        fs::set_permissions(&writable, fs::Permissions::from_mode(0o777)).unwrap();
        let leaf = writable.join("private");
        fs::DirBuilder::new().mode(0o700).create(&leaf).unwrap();
        assert_eq!(
            super::secure_directory(&leaf, false).unwrap_err().kind(),
            std::io::ErrorKind::PermissionDenied
        );
        let linked = dir.join("link");
        symlink(&leaf, &linked).unwrap();
        assert_eq!(
            super::secure_directory(&linked.join("credentials"), true)
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::PermissionDenied
        );
        assert!(!leaf.join("credentials").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
