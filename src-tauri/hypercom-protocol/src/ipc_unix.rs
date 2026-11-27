use super::BoxedStream;
use std::{
    fs::{self, File, OpenOptions},
    io,
    os::{
        fd::AsRawFd,
        unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
};
use tokio::net::{UnixListener, UnixStream};

fn uid() -> u32 {
    unsafe { libc::geteuid() }
}

fn directory() -> io::Result<PathBuf> {
    if let Some(root) = std::env::var_os("XDG_RUNTIME_DIR").filter(|value| !value.is_empty()) {
        let root = PathBuf::from(root);
        check_directory(&root)?;
        return Ok(root.join("hypercom-control-v1"));
    }
    // In environments without XDG_RUNTIME_DIR, preserve the existing private
    // endpoint. Never chmod or reuse somebody else's directory.
    Ok(PathBuf::from(format!("/tmp/hypercom-control-v1-{}", uid())))
}

fn verify_private(metadata: &fs::Metadata) -> io::Result<()> {
    if metadata.uid() != uid() || metadata.mode() & 0o077 != 0 {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Host endpoint is not private to this user",
        ))
    } else {
        Ok(())
    }
}

fn check_directory(dir: &Path) -> io::Result<()> {
    if !dir.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Host runtime directory must be absolute",
        ));
    }
    let metadata = fs::symlink_metadata(dir)?;
    verify_private(&metadata)?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Host endpoint parent is not a private directory",
        ));
    }
    Ok(())
}

fn verify_dir() -> io::Result<PathBuf> {
    let dir = directory()?;
    check_directory(&dir)?;
    Ok(dir)
}

fn socket_path(dir: &Path, name: &str) -> PathBuf {
    dir.join(format!("{name}.sock"))
}

pub(super) struct Listener {
    socket: UnixListener,
    path: PathBuf,
    _owner: File,
}

impl Listener {
    pub(super) fn bind(name: &str) -> io::Result<Self> {
        match fs::DirBuilder::new().mode(0o700).create(directory()?) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        let dir = verify_dir()?;
        let owner = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(dir.join(format!("{name}.lock")))?;
        let metadata = owner.metadata()?;
        verify_private(&metadata)?;
        if !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "Host lock is not a regular file",
            ));
        }
        if unsafe { libc::flock(owner.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(io::Error::last_os_error());
        }
        let path = socket_path(&dir, name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_socket() && metadata.uid() == uid() => {
                fs::remove_file(&path)?
            }
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "existing Host endpoint is not a same-user socket",
                ))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        let socket = UnixListener::bind(&path)?;
        if let Err(error) = fs::set_permissions(&path, fs::Permissions::from_mode(0o600)) {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        Ok(Self {
            socket,
            path,
            _owner: owner,
        })
    }

    pub(super) async fn accept(&mut self) -> io::Result<Option<BoxedStream>> {
        let (stream, _) = self.socket.accept().await?;
        if stream
            .peer_cred()
            .ok()
            .is_some_and(|peer| peer.uid() == uid())
        {
            Ok(Some(Box::new(stream)))
        } else {
            Ok(None)
        }
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub(super) async fn connect(name: &str) -> io::Result<BoxedStream> {
    let dir = verify_dir()?;
    let path = socket_path(&dir, name);
    let metadata = fs::symlink_metadata(&path)?;
    verify_private(&metadata)?;
    if !metadata.file_type().is_socket() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Host endpoint is not a socket",
        ));
    }
    let stream = UnixStream::connect(path).await?;
    if stream.peer_cred()?.uid() != uid() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Host peer does not run as this user",
        ));
    }
    Ok(Box::new(stream))
}
