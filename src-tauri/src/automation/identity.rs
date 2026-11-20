//! Local Host identity lives beside the exact config filename, not in settings.
//! The caller must hold the existing configuration instance lock.

use crate::plugin::transaction::{replace_file, sync_dir};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use uuid::Uuid;

const SCHEMA_VERSION: u8 = 1;
const MAX_IDENTITY_BYTES: u64 = 512;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Identity {
    schema_version: u8,
    host_id: String,
}

pub(crate) fn fresh_id() -> String {
    format!("host-{}", Uuid::new_v4())
}

fn identity_path(config: &Path) -> io::Result<PathBuf> {
    let mut name = config
        .file_name()
        .ok_or_else(|| io::Error::other("configuration path has no filename"))?
        .to_os_string();
    name.push(".host-identity.json");
    Ok(config.with_file_name(name))
}

fn check_regular(metadata: &Metadata) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err(io::Error::other(
                "Host identity must not be a reparse point",
            ));
        }
    }
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(io::Error::other("Host identity must be a regular file"));
    }
    Ok(())
}

fn read_identity(path: &Path) -> io::Result<String> {
    check_regular(&fs::symlink_metadata(path)?)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    check_regular(&file.metadata()?)?;
    let mut bytes = Vec::new();
    file.take(MAX_IDENTITY_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_IDENTITY_BYTES {
        return Err(io::Error::other(
            "Host identity file exceeds the byte limit",
        ));
    }
    let identity: Identity = serde_json::from_slice(&bytes)?;
    let valid_id = identity
        .host_id
        .strip_prefix("host-")
        .and_then(|value| {
            Uuid::parse_str(value).ok().filter(|uuid| {
                uuid.get_version() == Some(uuid::Version::Random)
                    && uuid.get_variant() == uuid::Variant::RFC4122
                    && uuid.to_string() == value
            })
        })
        .is_some();
    if identity.schema_version != SCHEMA_VERSION || !valid_id {
        return Err(io::Error::other("Unsupported or malformed Host identity"));
    }
    Ok(identity.host_id)
}

struct OwnedTemp(PathBuf);
impl Drop for OwnedTemp {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

pub(crate) fn load_or_create(config: &Path) -> io::Result<String> {
    let path = identity_path(config)?;
    // Only an absent entry permits creation. Existing malformed data is never replaced.
    match fs::symlink_metadata(&path) {
        Ok(_) => return read_identity(&path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    let identity = Identity {
        schema_version: SCHEMA_VERSION,
        host_id: fresh_id(),
    };
    let temp = path.with_file_name(format!(".host-identity-{}.tmp", Uuid::new_v4()));
    let mut file = File::create_new(&temp)?;
    let temp = OwnedTemp(temp);
    serde_json::to_writer(&mut file, &identity)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    drop(file);
    // Cooperating Host instances serialize creation via the instance lock. If
    // an entry appeared while staging, do not deliberately replace it either.
    match fs::symlink_metadata(&path) {
        Ok(_) => return read_identity(&path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    replace_file(&temp.0, &path)?;
    let parent = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    sync_dir(parent)?;
    Ok(identity.host_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> OwnedFixture {
        let path = std::env::temp_dir().join(format!("hypercom-identity-test-{}", Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        OwnedFixture(path)
    }

    struct OwnedFixture(PathBuf);
    impl Drop for OwnedFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn stable_per_exact_config_and_not_embedded_in_settings() {
        let directory = fixture();
        let config = directory.0.join("custom.json");
        let other = directory.0.join("custom.config");
        fs::write(&config, b"{}").unwrap();
        let first = load_or_create(&config).unwrap();
        assert_eq!(load_or_create(&config).unwrap(), first);
        assert_ne!(load_or_create(&other).unwrap(), first);
        assert_eq!(fs::read(config).unwrap(), b"{}");
        assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 3);
    }

    #[test]
    fn refuses_corrupt_oversized_or_unversioned_data_without_replacing_it() {
        let directory = fixture();
        let config = directory.0.join("config.json");
        let identity = identity_path(&config).unwrap();
        for garbage in [b"{bad".to_vec(), b"{}".to_vec(), vec![b' '; 513]] {
            fs::write(&identity, &garbage).unwrap();
            assert!(load_or_create(&config).is_err());
            assert_eq!(fs::read(&identity).unwrap(), garbage);
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_links_even_if_their_target_is_valid() {
        let directory = fixture();
        let original = directory.0.join("original.json");
        load_or_create(&original).unwrap();
        let other = directory.0.join("alias.json");
        std::os::unix::fs::symlink(
            identity_path(&original).unwrap(),
            identity_path(&other).unwrap(),
        )
        .unwrap();
        assert!(load_or_create(&other).is_err());
        assert!(fs::symlink_metadata(identity_path(&other).unwrap())
            .unwrap()
            .is_symlink());
    }
}
