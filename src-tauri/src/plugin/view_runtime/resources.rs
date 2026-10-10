use std::{collections::HashMap, fs, io::Read, path::Path};

use crate::plugin::{validate_view_resource_path, PluginManifest, UiView};

pub const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone)]
pub struct Resource {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
}

pub fn snapshot(dir: &Path, view: &UiView) -> Result<HashMap<String, Resource>, String> {
    let mut resources = HashMap::new();
    let mut total = 0usize;
    for path in std::iter::once(&view.entry).chain(&view.styles).chain(&view.assets) {
        if resources.contains_key(path) { continue; }
        let bytes = read_regular_resource(dir, path)?;
        total = total.checked_add(bytes.len()).ok_or("视图资源总量溢出")?;
        if total > MAX_TOTAL_BYTES { return Err("视图资源总量超过 32 MiB".into()); }
        resources.insert(path.clone(), Resource { bytes, mime: mime(path) });
    }
    Ok(resources)
}

pub fn validate_files(dir: &Path, manifest: &PluginManifest) -> Result<(), String> {
    for view in manifest.ui.as_ref().map(|ui| ui.views.as_slice()).unwrap_or_default() {
        snapshot(dir, view)?;
    }
    Ok(())
}

fn linked(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() { return true; }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT != 0 { return true; }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.is_file() && metadata.nlink() != 1 { return true; }
    }
    false
}

pub fn read_regular_resource(dir: &Path, relative: &str) -> Result<Vec<u8>, String> {
    validate_view_resource_path(relative)?;
    let base = fs::canonicalize(dir).map_err(|e| e.to_string())?;
    let mut path = dir.to_path_buf();
    let root = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !root.is_dir() || linked(&root) { return Err("资源目录包含链接".into()); }
    for segment in relative.split('/') {
        path.push(segment);
        let metadata = fs::symlink_metadata(&path).map_err(|e| format!("资源不可读 {relative}: {e}"))?;
        if linked(&metadata) { return Err("资源路径包含链接或重解析点".into()); }
    }
    let canonical = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    if !canonical.starts_with(&base) { return Err("资源越过插件目录".into()); }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(&path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || linked(&metadata) || metadata.len() > MAX_FILE_BYTES {
        return Err("视图资源必须为普通非链接文件且不超过 8 MiB".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 || information.nNumberOfLinks != 1 {
            return Err("视图资源不得包含硬链接".into());
        }
        use windows_sys::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED, VOLUME_NAME_DOS};
        let mut name = vec![0u16; 32768];
        let length = unsafe { GetFinalPathNameByHandleW(file.as_raw_handle(), name.as_mut_ptr(), name.len() as u32, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS) };
        if length == 0 || length as usize >= name.len() { return Err("无法确认已打开资源路径".into()); }
        use std::os::windows::ffi::OsStringExt;
        let opened_path = std::path::PathBuf::from(std::ffi::OsString::from_wide(&name[..length as usize]));
        if !opened_path.starts_with(&base) { return Err("已打开资源越过插件目录".into()); }
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES { return Err("视图资源超过上限".into()); }
    Ok(bytes)
}

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "js" => "text/javascript; charset=utf-8", "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml", "png" => "image/png", "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif", "webp" => "image/webp", "ico" => "image/x-icon",
        "woff" => "font/woff", "woff2" => "font/woff2", "ttf" => "font/ttf",
        "json" => "application/json", _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_private_paths_and_undeclared_aliases() {
        for path in ["data/state.json", "DATA/a", "../a.js", "a%2fb.js", "a.js:stream", "a/./b.js", "a\\b.js", "/a.js"] {
            assert!(validate_view_resource_path(path).is_err(), "{path}");
        }
        assert!(validate_view_resource_path("ui/assets/a.woff2").is_ok());
    }
    #[test]
    fn accepts_binary_but_rejects_directories_and_large_resources() {
        let root = std::env::temp_dir().join(format!("hypercom-view-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("ui")).unwrap();
        fs::write(root.join("ui/a.png"), [0, 255, 1]).unwrap();
        assert_eq!(read_regular_resource(&root, "ui/a.png").unwrap(), [0, 255, 1]);
        assert!(read_regular_resource(&root, "ui").is_err());
        let file = fs::File::create(root.join("ui/large.js")).unwrap();
        file.set_len(MAX_FILE_BYTES + 1).unwrap();
        assert!(read_regular_resource(&root, "ui/large.js").is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symbolic_and_hard_links() {
        let root = std::env::temp_dir().join(format!("hypercom-view-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("real.js"), "test").unwrap();
        std::os::unix::fs::symlink(root.join("real.js"), root.join("link.js")).unwrap();
        assert!(read_regular_resource(&root, "link.js").is_err());
        fs::hard_link(root.join("real.js"), root.join("hard.js")).unwrap();
        assert!(read_regular_resource(&root, "hard.js").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
