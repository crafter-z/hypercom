use std::{collections::HashMap, path::Path};

use crate::plugin::{
    fs_access::{open_regular_file, OpenedFile},
    validate_view_resource_path, PluginManifest, UiView,
};

#[cfg(any(windows, test))]
use std::{path::PathBuf, time::SystemTime};

pub struct Resource {
    #[cfg(any(windows, test))]
    pub mime: &'static str,
    #[cfg(any(windows, test))]
    pub contents: ResourceContents,
}

#[cfg(any(windows, test))]
pub enum ResourceContents {
    #[cfg(windows)]
    Generated(Vec<u8>),
    Declared(DeclaredResource),
}

#[cfg(any(windows, test))]
pub struct DeclaredResource {
    root: PathBuf,
    relative: String,
    identity: ResourceIdentity,
}

#[cfg(any(windows, test))]
#[derive(Debug, PartialEq, Eq)]
struct ResourceIdentity {
    len: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    final_path: PathBuf,
    #[cfg(windows)]
    volume_serial: u32,
    #[cfg(windows)]
    file_index: u64,
}

#[cfg(windows)]
fn windows_identity(root: &Path, file: &std::fs::File) -> Result<(PathBuf, u32, u64), String> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, GetFinalPathNameByHandleW, BY_HANDLE_FILE_INFORMATION,
        FILE_NAME_NORMALIZED, VOLUME_NAME_DOS,
    };
    let handle = file.as_raw_handle();
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0
        || information.nNumberOfLinks != 1
    {
        return Err("无法确认资源是单链接文件".into());
    }
    let mut name = vec![0u16; 512];
    let final_path = loop {
        let len = unsafe {
            GetFinalPathNameByHandleW(
                handle,
                name.as_mut_ptr(),
                name.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        } as usize;
        if len == 0 || len > 32_768 {
            return Err("无法确认已打开资源路径".into());
        }
        if len < name.len() {
            break PathBuf::from(std::ffi::OsString::from_wide(&name[..len]));
        }
        name.resize(len + 1, 0);
    };
    // The shared opener walks the root and every child by handle without
    // following reparses. Keep the additional final-handle fence as well, so
    // a tree moved out of the package during traversal is not served.
    let base = std::fs::canonicalize(root).map_err(|error| error.to_string())?;
    if !final_path.starts_with(&base) || final_path == base {
        return Err("已打开资源越过插件目录".into());
    }
    let index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    Ok((final_path, information.dwVolumeSerialNumber, index))
}

#[cfg(any(windows, test))]
fn file_identity(_root: &Path, opened: &OpenedFile) -> Result<ResourceIdentity, String> {
    // Metadata and identity always describe this exact File, never a second
    // open of a name or metadata obtained before the no-follow open.
    let metadata = opened.file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() != opened.len {
        return Err("视图资源类型或大小已变化".into());
    }
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;
    #[cfg(windows)]
    let (final_path, volume_serial, file_index) = windows_identity(_root, &opened.file)?;
    Ok(ResourceIdentity {
        len: metadata.len(),
        modified: metadata.modified().ok(),
        #[cfg(unix)]
        device: metadata.dev(),
        #[cfg(unix)]
        inode: metadata.ino(),
        #[cfg(windows)]
        final_path,
        #[cfg(windows)]
        volume_serial,
        #[cfg(windows)]
        file_index,
    })
}

fn open_declared(dir: &Path, relative: &str) -> Result<OpenedFile, String> {
    // The view namespace is narrower than the package file API (no private
    // data or URL aliases); traversal and the OS link rules stay in fs_access.
    validate_view_resource_path(relative)?;
    if relative.starts_with("__host/") {
        return Err("视图资源不得覆盖宿主命名空间".into());
    }
    open_regular_file(dir, relative)
}

fn metadata_resource(dir: &Path, relative: &str) -> Result<Resource, String> {
    let opened = open_declared(dir, relative)?;
    #[cfg(not(any(windows, test)))]
    drop(opened);
    Ok(Resource {
        #[cfg(any(windows, test))]
        mime: mime(relative),
        #[cfg(any(windows, test))]
        contents: ResourceContents::Declared(DeclaredResource {
            root: dir.to_path_buf(),
            relative: relative.to_owned(),
            identity: file_identity(dir, &opened)?,
        }),
    })
}

/// Validate the declared paths and snapshot only identity/size, not payloads.
pub fn snapshot_lazy(dir: &Path, view: &UiView) -> Result<HashMap<String, Resource>, String> {
    let mut resources = HashMap::new();
    for path in std::iter::once(&view.entry)
        .chain(&view.styles)
        .chain(&view.assets)
    {
        if !resources.contains_key(path) {
            resources.insert(path.clone(), metadata_resource(dir, path)?);
        }
    }
    Ok(resources)
}

#[cfg(any(windows, test))]
impl DeclaredResource {
    /// Return the same verified open File from which the response identity and
    /// Content-Length were read. An installation replacement must not silently
    /// start serving the new file through an old view.
    pub fn open(&self) -> Result<OpenedFile, String> {
        let opened = open_declared(&self.root, &self.relative)?;
        if file_identity(&self.root, &opened)? != self.identity {
            return Err("资源文件身份已变化".into());
        }
        Ok(opened)
    }
}

pub fn validate_files(dir: &Path, manifest: &PluginManifest) -> Result<(), String> {
    for view in manifest
        .ui
        .as_ref()
        .map(|ui| ui.views.as_slice())
        .unwrap_or_default()
    {
        snapshot_lazy(dir, view)?;
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn mime(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
pub(super) struct TestDirectory(PathBuf);
#[cfg(test)]
impl TestDirectory {
    pub fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("hypercom-resource-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        // The component-walking opener deliberately rejects symlinked ancestors.
        // Canonicalize the Unix fixture root so macOS's /var -> /private/var
        // alias does not make every otherwise-valid resource fail before the
        // test reaches the declared path (and so the symlink test exercises its
        // own alias). Keep the Windows path unchanged: its native final-path
        // fence handles the platform's path aliases separately.
        #[cfg(unix)]
        let path = std::fs::canonicalize(path).unwrap();
        Self(path)
    }
    pub fn path(&self) -> &Path {
        &self.0
    }
}
#[cfg(test)]
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn production_metadata_and_reopen_refuse_outside_or_aliased_paths() {
        let root = TestDirectory::new();
        fs::create_dir(root.path().join("ui")).unwrap();
        let real = root.path().join("ui/data.bin");
        fs::write(&real, b"original").unwrap();
        {
            let resource = metadata_resource(root.path(), "ui/data.bin").unwrap();
            assert_eq!(resource.mime, "application/octet-stream");
            #[cfg(not(windows))]
            let ResourceContents::Declared(declared) = resource.contents;
            #[cfg(windows)]
            let declared = match resource.contents {
                ResourceContents::Declared(declared) => declared,
                ResourceContents::Generated(_) => {
                    panic!("a plugin resource must hold metadata only")
                }
            };
            assert_eq!(declared.open().unwrap().len, 8);
            let alias = root.path().join("ui/alias.bin");
            fs::hard_link(&real, &alias).unwrap();
            assert!(metadata_resource(root.path(), "ui/alias.bin").is_err());
            assert!(
                declared.open().is_err(),
                "adding a link invalidates an already declared file"
            );
            fs::remove_file(&alias).unwrap();
            let older = root.path().join("ui/older.bin");
            fs::rename(&real, &older).unwrap();
            fs::write(&real, b"replaced").unwrap();
            assert!(
                declared.open().is_err(),
                "equal byte count must not conceal a different file handle"
            );
        }
        for path in [
            "data/state.json",
            "DATA/a",
            "../a.js",
            "ui/x%2fy.js",
            "ui/a.js:stream",
            "ui/./x.js",
            "ui\\x.js",
            "/a.js",
            "ui",
            "__host/index.html",
        ] {
            assert!(metadata_resource(root.path(), path).is_err(), "{path}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_native_final_path_fence_uses_the_file_handle() {
        let root = TestDirectory::new();
        let other = TestDirectory::new();
        fs::write(other.path().join("page.html"), b"other package").unwrap();
        let opened = open_regular_file(other.path(), "page.html").unwrap();
        assert!(windows_identity(other.path(), &opened.file).is_ok());
        assert!(
            windows_identity(root.path(), &opened.file).is_err(),
            "current handle final path is outside this package root"
        );
    }

    #[cfg(unix)]
    #[test]
    fn production_metadata_rejects_symlinked_path_components() {
        let root = TestDirectory::new();
        let outside = TestDirectory::new();
        fs::write(outside.path().join("page.html"), b"outside").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("alias")).unwrap();
        assert!(metadata_resource(root.path(), "alias/page.html").is_err());
    }
}
