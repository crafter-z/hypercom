/**
 * 插件模块（issue #17）
 *
 * 职责分层（评审 v2 D5/D8 落地）：
 * - 本文件：**纯函数层** —— manifest 解析/校验（Rust 权威点）、插件内相对路径
 *   规范化与穿越防护（`sanitize_plugin_rel_path`）、插件目录扫描。
 *   不触 serialport FFI，Windows 全平台可跑 cargo test。
 * - `commands/plugin.rs`：命令层 —— 锁 config_manager 读/写 `plugin_configs`
 *   状态实体 + 调用本层磁盘函数。管理逻辑无需独立缓存状态（manifest.json
 *   是小文件，list 时现扫即可），故不新增 AppState 字段，镜像 storage.rs
 *   「锁 config_manager → mutate → save」模式。
 *
 * manifest 校验权威点在 Rust：TS 侧校验只是 UX 预检；`install_plugin` 必须经
 * 本层后端独立校验（serde 反序列化 + 必填字段 + apiVersion 兼容 + entry/assets
 * 路径前缀检查）。前端结果不可信，前端校验失败 ≠ 后端拒绝。
 */
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

pub(crate) mod transaction;
pub(crate) mod view_runtime;

/// Manifests are UTF-8 regular files, bounded to 1 MiB before parsing.
pub const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// 宿主 API 版本。插件 manifest `apiVersion` 的主版本必须等于它
/// （semver：主版本不兼容视为不可用，次版本向后兼容放行）。
pub const HOST_API_MAJOR: u32 = 1;

/// 已交付的可授予权限。manifest 可以声明未来权限，但当前不得授予或显示成可用能力。
/// 此集合在 `set_plugin_permissions` 后端命令中校验，并通过列表返回设置页。
pub const KNOWN_PERMISSIONS: &[&str] = &[
    "terminal:read",
    "terminal:write",
    "rx:bytes",
    "fs:assets",
    "fs:storage",
    "fs:open",
    "serial:send",
    "http:request",
    "shell:open",
    "clipboard",
    "notify",
    "storage",
    "ui:view",
    "ui:tabs",
];

// ==================== Manifest 结构 ====================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HttpScope {
    /// URL 白名单 glob（`http.urlWhitelist`）。可选作用域：
    /// 缺失或空数组 = 不限制；非空时初始 URL 与每个重定向目标都必须匹配。
    #[serde(default)]
    pub url_whitelist: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ShellScope {
    /// 可执行文件白名单（`shell.executableWhitelist`）。运行时逐条匹配。
    #[serde(default)]
    pub executable_whitelist: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SerialScope {
    /// 发送目标端口白名单（`serial.portWhitelist`，评审 v2 P10）。
    /// 声明且非空 → 仅白名单端口可发；声明为空数组 → 全部拒绝；
    /// 未声明 → 不做端口作用域（仍需 `serial:send` 授权）。
    #[serde(default)]
    pub port_whitelist: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiButton {
    pub id: String,
    pub label: String,
    /// lucide-react 图标名（宿主已有该依赖）。可选。
    #[serde(default)]
    pub icon: Option<String>,
    /// 扩展点：`"sidebar"`（Sidebar 工具栏）。可选，默认 sidebar。
    #[serde(default)]
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiMenuItem {
    pub id: String,
    pub label: String,
    /// 扩展点：`"port-context"`（端口右键菜单）。
    #[serde(default)]
    pub target: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ViewMode {
    #[default]
    Isolated,
    TrustedWeb,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UiView {
    pub id: String,
    pub label: String,
    pub entry: String,
    #[serde(default)]
    pub mode: ViewMode,
    #[serde(default)]
    pub styles: Vec<String>,
    #[serde(default)]
    pub assets: Vec<String>,
    pub modes: Vec<String>,
    pub input: String,
    pub placements: Vec<String>,
    pub port_binding: String,
    #[serde(default)]
    pub restore_on_startup: bool,
    /// 是否依附插件的根 Worker。缺省 true；false 仅允许纯本地可信网页。
    #[serde(default = "default_worker")]
    pub worker: bool,
}

fn default_worker() -> bool {
    true
}

impl UiView {
    pub fn is_trusted_web(&self) -> bool { self.mode == ViewMode::TrustedWeb }
}

/// Browser profiles are outside plugin packages and plugin-writable private data.
/// The install generation is part of the profile identity: reinstalling the same
/// plugin id must never inherit the old trusted-web profile. Validate and
/// canonicalize the UUID at this single path derivation boundary.
pub fn web_data_dir(
    plugins_dir: &Path,
    id: &str,
    install_generation: &str,
) -> Result<std::path::PathBuf, String> {
    let generation = uuid::Uuid::parse_str(install_generation)
        .map_err(|_| "插件安装代次不是合法 UUID".to_string())?
        .to_string();
    Ok(plugins_dir
        .parent()
        .expect("plugins directory has a parent")
        .join("plugin-web-data")
        .join(id)
        .join(generation))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiDecl {
    #[serde(default)]
    pub buttons: Vec<UiButton>,
    #[serde(default)]
    pub menu_items: Vec<UiMenuItem>,
    #[serde(default)]
    pub views: Vec<UiView>,
}

/// 插件 manifest（`manifest.json`）。
/// 必填：`id`（反向域名）/`name`/`version`/`apiVersion`/`permissions`。
/// 可选：`description`/`entry`/`http`/`shell`/`serial`/`ui`。
/// `entry` 缺省为空仅用于「纯本地可信网页」插件（无根 Worker）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    /// 插件要求的最低宿主 API 版本（semver，如 "1.0"）。
    pub api_version: String,
    /// 入口文件（插件目录内相对路径，如 "main.js"）。
    /// 缺省/空串表示没有根 Worker（仅当 ui.views 全为 trusted-web + input:none 时允许）。
    #[serde(default)]
    pub entry: String,
    /// 声明的权限（「可授予上限」）。
    pub permissions: Vec<String>,
    #[serde(default)]
    pub requires: Vec<String>,
    #[serde(default)]
    pub http: Option<HttpScope>,
    #[serde(default)]
    pub shell: Option<ShellScope>,
    /// 发送端口作用域（评审 v2 P10）。可选——桥侧 `serial.send` 调用时校验。
    #[serde(default)]
    pub serial: Option<SerialScope>,
    #[serde(default)]
    pub ui: Option<UiDecl>,
}

// ==================== 校验（Rust 权威点） ====================

/// 解析 + 校验 manifest JSON。返回结构化错误（进入 CommandError / diaglog）。
pub fn parse_manifest(json: &str) -> Result<PluginManifest, String> {
    let manifest: PluginManifest =
        serde_json::from_str(json).map_err(|e| format!("manifest 不是合法 JSON: {e}"))?;
    manifest.validate()?;
    Ok(manifest)
}

/// Read a regular, unlinked manifest with both metadata and streaming bounds.
///
/// This is the **cheap** variant: it parses and validates the manifest itself
/// but does not stat/read the declared view resources. Use it on hot paths
/// (per-request capability checks, asset reads, enable/permission changes)
/// where only the manifest's declarations matter. Install, enable, reload and
/// plugin listing use [`load_manifest_from_dir`] for full package validation;
/// native view creation validates the manifest here and snapshots only the
/// selected view resources outside the config lock.
pub fn load_manifest_lite(dir: &Path) -> Result<PluginManifest, String> {
    let directory = fs::symlink_metadata(dir).map_err(|e| format!("插件目录不可读: {e}"))?;
    if !directory.is_dir() || is_link_or_reparse(&directory) {
        return Err("插件目录必须是普通目录".into());
    }
    let manifest_path = dir.join("manifest.json");
    let metadata = fs::symlink_metadata(&manifest_path).map_err(|e| format!("manifest 不可读: {e}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_MANIFEST_BYTES {
        return Err("manifest 必须是普通文件且不超过 1 MiB".into());
    }
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
    let file = options.open(&manifest_path).map_err(|e| format!("manifest 不可读: {e}"))?;
    let opened = file.metadata().map_err(|e| format!("manifest 不可读: {e}"))?;
    if !opened.is_file() || opened.file_type().is_symlink() || opened.len() > MAX_MANIFEST_BYTES {
        return Err("manifest 必须是普通文件且不超过 1 MiB".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if opened.nlink() != 1 {
            return Err("manifest 不得是硬链接".into());
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.file_attributes() & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("manifest 不得是链接或重解析点".into());
        }
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
        let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0
            || information.nNumberOfLinks != 1
        {
            return Err("manifest 不得是硬链接".into());
        }
    }
    let bytes = read_manifest_bytes(file, opened.len())?;
    let content = String::from_utf8(bytes).map_err(|e| format!("manifest 不是 UTF-8: {e}"))?;
    parse_manifest(&content)
}

/// Read a manifest **and** validate every declared view resource.
///
/// Keep the resource walk on install/list/enable/reload paths: it stats and
/// reads `ui.views[].entry/styles/assets` (up to 32 MiB per view) and must not
/// run on per-request capability checks or native view creation's config lock.
pub fn load_manifest_from_dir(dir: &Path) -> Result<PluginManifest, String> {
    let manifest = load_manifest_lite(dir)?;
    view_runtime::resources::validate_files(dir, &manifest)?;
    Ok(manifest)
}

fn read_manifest_bytes(reader: impl Read, reported_size: u64) -> Result<Vec<u8>, String> {
    if reported_size > MAX_MANIFEST_BYTES { return Err("manifest 超过 1 MiB".into()); }
    let mut bytes = Vec::with_capacity(reported_size as usize);
    reader.take(MAX_MANIFEST_BYTES + 1).read_to_end(&mut bytes)
        .map_err(|e| format!("manifest 读取失败: {e}"))?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES { return Err("manifest 超过 1 MiB".into()); }
    Ok(bytes)
}

impl PluginManifest {
    pub fn has_trusted_web_views(&self) -> bool {
        self.ui.as_ref().is_some_and(|ui| ui.views.iter().any(UiView::is_trusted_web))
    }

    /// 结构校验（纯函数，无 IO）。任一步失败返回带上下文的错误串。
    pub fn validate(&self) -> Result<(), String> {
        validate_plugin_id(&self.id)?;

        if self.name.trim().is_empty() {
            return Err("manifest 缺少必填字段 name".into());
        }
        if parse_semver(&self.version).is_none() {
            return Err(format!("manifest version 不是合法 semver: {}", self.version));
        }
        if parse_semver(&self.api_version).is_none() {
            return Err(format!(
                "manifest apiVersion 不是合法 semver: {}",
                self.api_version
            ));
        }
        let api_major = self.api_major();
        if api_major != HOST_API_MAJOR {
            return Err(format!(
                "manifest apiVersion 主版本 {} 与宿主 {} 不兼容",
                api_major, HOST_API_MAJOR
            ));
        }

        if self.entry.trim().is_empty() {
            // 纯 HTML 插件：没有根 Worker，但必须有独立的本地可信网页。
            let ui = self
                .ui
                .as_ref()
                .ok_or_else(|| "manifest 缺少 entry，且未声明纯网页 ui.views".to_string())?;
            if !ui.buttons.is_empty() || !ui.menu_items.is_empty() {
                return Err("manifest 缺少 entry 时不得声明 Worker 按钮/菜单".into());
            }
            if ui.views.is_empty()
                || ui.views.iter().any(|view| {
                    !view.is_trusted_web() || view.input != "none"
                })
            {
                return Err(
                    "manifest 缺少 entry 时 ui.views 必须非空且全部为 trusted-web、input:none".into(),
                );
            }
        } else {
            // entry 必须指向插件目录内（防越目录引用与解压后穿越）。
            sanitize_plugin_rel_path(&self.entry)
                .map_err(|e| format!("manifest entry 非法: {e}"))?;
        }

        // 声明未知权限可兼容未来版本，但授予命令仅允许当前 KNOWN_PERMISSIONS。
        let mut seen = std::collections::HashSet::new();
        for p in &self.permissions {
            if p.trim().is_empty() {
                return Err("manifest permissions 含空项".into());
            }
            if !seen.insert(p.clone()) {
                return Err(format!("manifest permissions 重复声明: {p}"));
            }
        }
        // scope 白名单条目非空（http/shell/serial 同规——空串条目无意义且易误配）。
        for scope_items in [
            self.http.as_ref().map(|h| &h.url_whitelist),
            self.shell.as_ref().map(|s| &s.executable_whitelist),
            self.serial.as_ref().map(|s| &s.port_whitelist),
        ]
        .into_iter()
        .flatten()
        {
            if scope_items.iter().any(|item| item.trim().is_empty()) {
                return Err("manifest scope 白名单含空项".into());
            }
        }
        let mut capabilities = std::collections::HashSet::new();
        for required in &self.requires {
            if !["isolated-tab-view@1", "trusted-web-view@1", "plugin-workspace-tabs@1"].contains(&required.as_str())
                || !capabilities.insert(required) {
                return Err(format!("未知或重复的必需能力: {required}"));
            }
        }
        let mut ids = std::collections::HashSet::new();
        let views = self.ui.as_ref().map(|ui| ui.views.as_slice()).unwrap_or_default();
        if views.len() > 32 { return Err("每插件最多声明 32 个视图".into()); }
        if !views.is_empty() && !self.permissions.iter().any(|p| p == "ui:view") {
            return Err("视图须声明 ui:view".into());
        }
        for view in views {
            let capability = if view.is_trusted_web() { "trusted-web-view@1" } else { "isolated-tab-view@1" };
            if !self.requires.iter().any(|r| r == capability) {
                return Err(format!("视图须声明 {capability}"));
            }
            if view.id.is_empty() || view.id.len() > 128
                || !view.id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                || !ids.insert(&view.id) || view.label.trim().is_empty() || view.label.chars().count() > 128 {
                return Err("视图 id/label 非法或重复".into());
            }
            if view.styles.len() + view.assets.len() > 256 { return Err("视图资源数超过上限".into()); }
            for path in std::iter::once(&view.entry).chain(&view.styles).chain(&view.assets) {
                validate_view_resource_path(path)?;
                if path.starts_with("__host/") { return Err("视图资源不得覆盖宿主命名空间".into()); }
            }
            if view.is_trusted_web() {
                if !(view.entry.ends_with(".html") || view.entry.ends_with(".htm")) || !view.styles.is_empty() {
                    return Err("可信网页 entry 必须为 HTML，styles 必须为空".into());
                }
            } else if !view.entry.ends_with(".js") || view.styles.iter().any(|p| !p.ends_with(".css")) {
                return Err("视图 entry/styles 必须为 JS/CSS".into());
            }
            if !view.worker && !(view.is_trusted_web() && view.input == "none") {
                return Err("worker:false 仅允许 trusted-web 且 input:none 的视图".into());
            }
            if view.modes.is_empty() || view.modes.len() > 2
                || view.modes.iter().any(|m| !["trx", "tty"].contains(&m.as_str()))
                || (view.modes.len() == 2 && view.modes[0] == view.modes[1]) {
                return Err("视图 modes 非法".into());
            }
            let input_permission = match view.input.as_str() {
                "bytes" => Some("rx:bytes"),
                "lines" if view.modes.iter().all(|m| m == "trx") => Some("terminal:read"),
                "none" => None,
                _ => return Err("视图 input 非法，lines 仅支持 TRX".into()),
            };
            if input_permission.is_some_and(|permission| !self.permissions.iter().any(|p| p == permission)) {
                return Err("视图未声明输入权限".into());
            }
            if !["required", "optional", "none"].contains(&view.port_binding.as_str())
                || (view.input != "none" && view.port_binding == "none") {
                return Err("视图 portBinding 与 input 不兼容".into());
            }
            if view.placements.is_empty() || view.placements.len() > 2
                || view.placements.iter().any(|p| !["serial-content", "workspace-tab"].contains(&p.as_str()))
                || (view.placements.len() == 2 && view.placements[0] == view.placements[1])
                || (view.placements.iter().any(|p| p == "serial-content") && view.port_binding == "none") {
                return Err("视图 placements 非法".into());
            }
            if view.placements.iter().any(|p| p == "workspace-tab")
                && !self.requires.iter().any(|r| r == "plugin-workspace-tabs@1") {
                return Err("独立标签须声明 plugin-workspace-tabs@1".into());
            }
        }
        Ok(())
    }

    /// apiVersion 主版本。
    pub fn api_major(&self) -> u32 {
        semver_major(&self.api_version)
    }
}

pub fn validate_view_resource_path(path: &str) -> Result<(), String> {
    if path.len() > 512 || path.contains(['\\', ':', '%', '?', '#', '\0', '"', '\'', '<', '>', '&']) || path.chars().any(|c| c.is_control())
        || path.split('/').any(|s| s.is_empty() || s == "." || s == ".." || s.ends_with(['.', ' ']))
        || path.split('/').next().is_some_and(|s| s.eq_ignore_ascii_case("data")) {
        return Err(format!("视图资源路径非法: {path}"));
    }
    sanitize_plugin_rel_path(path).map(|_| ())
}

// ==================== 路径防护 ====================

/// Link or Windows reparse point (junction/symlink). `file_type().is_symlink()`
/// alone does not report junctions, which are creatable without privileges.
pub(crate) fn is_link_or_reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return true;
        }
    }
    false
}

/// Windows device names / path aliases. Win32 strips trailing dots/spaces,
/// resolves `:` as an ADS and treats CON/COM1… as devices, so a ZIP entry that
/// only checks `..` can still escape or alias another path.
pub(crate) fn is_reserved_windows_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

/// One shared component check for ZIP extraction, assets and data writes.
pub(crate) fn validate_path_component(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("路径段为空".into());
    }
    if name.ends_with(['.', ' ']) || name.contains(':') || name.contains('~') {
        return Err(format!("路径段含 Windows 路径别名: {name}"));
    }
    if name.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return Err(format!("路径段含控制字符: {name}"));
    }
    if is_reserved_windows_name(name) {
        return Err(format!("路径段是 Windows 设备名: {name}"));
    }
    Ok(())
}

/// A plugin id is exactly one safe directory name, with nonempty reverse-domain labels.
pub fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.split('.').count() < 2
        || id.split('.').any(|label| {
            label.is_empty()
                || is_reserved_windows_name(label)
                || !label.chars().all(|c| {
                    c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'
                })
        })
    {
        return Err(format!("非法插件 id（须为反向域名且每段非空）: {id}"));
    }
    Ok(())
}

/// 规范化插件内相对路径并校验其停留在插件目录内（防 `../` 穿越 / 绝对路径 /
/// Windows 盘符 / 空路径）。返回规范化后的相对 PathBuf。
///
/// 规则：
/// - 空串、绝对路径（含 Windows 盘符 `C:`、UNC `\\`、unix `/`）→ Err；
/// - 任一段为 `..`（ParentDir）或 `.` 之外的非普通段（RootDir/Prefix/CurDir）→ Err；
/// - 允许 `.` 段与重复分隔符（归一化忽略）。
pub fn sanitize_plugin_rel_path(rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() {
        return Err("路径为空".into());
    }
    // 统一分隔符（windows + unix 双写兼容）：`\` → `/` 后再走 Path 组件。
    // 已知副作用（接受）：unix 上文件名中的字面 `\` 会被归一化为分隔符——
    // 插件内路径约定统一 `/`，字面反斜杠文件名不支持（评审复审：删除原空 if
    // 死代码，注释与行为对齐）。
    let normalized = rel.replace('\\', "/");
    let path = Path::new(&normalized);

    // 绝对路径检测（含盘符前缀）：Path::is_absolute 在 windows 上认 `C:\`，
    // unix 上认 `/`。再做一次前缀字符防御（`C:foo` 是 windows 相对但带盘符）。
    if path.is_absolute() || normalized.starts_with('/') {
        return Err(format!("绝对路径不允许: {rel}"));
    }
    let first = normalized.split('/').next().unwrap_or("");
    if first.len() == 2 && first.ends_with(':') {
        return Err(format!("Windows 盘符路径不允许: {rel}"));
    }

    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::Normal(seg) => {
                let seg_str = seg.to_string_lossy();
                if seg_str.is_empty() {
                    continue;
                }
                validate_path_component(&seg_str)?;
                out.push(seg);
            }
            Component::CurDir => {}
            Component::ParentDir => return Err(format!("路径穿越（..）不允许: {rel}")),
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("绝对路径不允许: {rel}"))
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err("路径为空".into());
    }
    Ok(out)
}

// ==================== semver 辅助（纯函数） ====================

/// 解析 `x.y[.z]` 版本号。返回 (major, minor, patch)。patch 缺省 0。
pub fn parse_semver(v: &str) -> Option<(u32, u32, u32)> {
    let v = v.trim();
    let mut parts = v.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next().unwrap_or("0").parse::<u32>().ok()?;
    let patch = parts.next().unwrap_or("0").parse::<u32>().ok()?;
    // 不允许多余段（`1.2.3.4` 非法）。
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn semver_major(v: &str) -> u32 {
    parse_semver(v).map(|(m, _, _)| m).unwrap_or(0)
}

/// 版本比较：a > b。用于「重装覆盖的版本判断」与 preview/stable 同类语义。
pub fn version_greater(a: &str, b: &str) -> bool {
    match (parse_semver(a), parse_semver(b)) {
        (Some(x), Some(y)) => x > y,
        _ => false,
    }
}

// ==================== 目录扫描 ====================

/// 单个已安装插件的磁盘事实 + 结构校验结果。
#[derive(Debug, Clone)]
pub struct InstalledPlugin {
    pub dir: PathBuf,
    /// 解析成功的 manifest；Err = 目录存在但 manifest 损坏/缺失。
    pub manifest: Result<PluginManifest, String>,
}

/// 扫描插件根目录下全部子目录（每个子目录视为一个插件目录）。
/// 返回项带独立 manifest 结果——损坏的插件不阻断其余插件列出
/// （前端设置页可对损坏项显示「校验失败」而非整体报错）。
/// 根目录不存在时返回空 Vec（首次安装前无插件，正常态）。
pub fn scan_plugins(plugins_root: &Path) -> Vec<InstalledPlugin> {
    if !plugins_root.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    // read_dir 失败（权限等）静默降级——扫描是尽力而为，不因单目录异常炸列表。
    if let Ok(entries) = fs::read_dir(plugins_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let Some(id) = name.to_str() else { continue };
            if validate_plugin_id(id).is_err() || !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue; // staging/backup directories and symlinks are not installed plugins
            }
            let manifest = load_manifest_from_dir(&path).and_then(|manifest| {
                if manifest.id == id {
                    Ok(manifest)
                } else {
                    Err(format!("manifest id 与目录名不一致: {} != {id}", manifest.id))
                }
            });
            out.push(InstalledPlugin { dir: path, manifest });
        }
    }
    // 稳定排序：目录名（= 插件 id，反向域名）字典序。
    out.sort_by(|a, b| a.dir.file_name().cmp(&b.dir.file_name()));
    out
}

/// zip 解压条目数上限（评审复审 zip bomb 加固：正常插件远小于此）。
pub const MAX_ZIP_ENTRIES: usize = 2000;
/// 目录/zip 源的递归深度上限，避免深目录耗尽栈与路径处理资源。
pub const MAX_PLUGIN_SOURCE_DEPTH: usize = 32;
/// zip 解压总量（字节）上限。
pub const MAX_ZIP_UNCOMPRESSED_BYTES: u64 = 64 * 1024 * 1024;
/// Central-directory limits are checked before `zip::ZipArchive::new`: zip 2.x
/// materializes its index eagerly, so trusting its deduplicated `len()` is too late.
const MAX_ZIP_CENTRAL_DIRECTORY_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ZIP_ENTRY_METADATA_BYTES: u64 = 64 * 1024;
/// Immutable input budget, checked before central-directory parsing.
pub const MAX_ZIP_ARCHIVE_BYTES: u64 = 96 * 1024 * 1024;

// zip 2.x retries earlier footer signatures after malformed metadata. Its
// indexing pass sees only our verified canonical footer; extraction then reads
// the unchanged compressed snapshot. Masking is allocation-free per read.
struct ValidatedZipReader {
    bytes: Vec<u8>,
    position: u64,
    footer_start: usize,
    indexing: std::rc::Rc<std::cell::Cell<bool>>,
}

impl Read for ValidatedZipReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        let start = usize::try_from(self.position).unwrap_or(usize::MAX);
        if start >= self.bytes.len() { return Ok(0); }
        let count = out.len().min(self.bytes.len() - start);
        out[..count].copy_from_slice(&self.bytes[start..start + count]);
        if self.indexing.get() {
            for offset in start.saturating_sub(3)..(start + count).min(self.footer_start) {
                if offset + 4 <= self.footer_start && matches!(&self.bytes[offset..offset + 4], [0x50, 0x4b, 0x05, 0x06] | [0x50, 0x4b, 0x06, 0x06] | [0x50, 0x4b, 0x06, 0x07]) {
                    for absolute in offset.max(start)..(offset + 4).min(start + count) { out[absolute - start] = 0; }
                }
            }
        }
        self.position += count as u64;
        Ok(count)
    }
}

impl Seek for ValidatedZipReader {
    fn seek(&mut self, from: SeekFrom) -> std::io::Result<u64> {
        let next = match from {
            SeekFrom::Start(value) => value as i128,
            SeekFrom::End(delta) => self.bytes.len() as i128 + delta as i128,
            SeekFrom::Current(delta) => self.position as i128 + delta as i128,
        };
        self.position = u64::try_from(next).map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "ZIP seek overflow"))?;
        Ok(self.position)
    }
}

fn read_le_u16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn read_le_u32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}

fn read_le_u64(bytes: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}

/// Validate the bounded, physical central-directory representation without
/// allocating anything according to attacker-controlled entry counts.  In
/// particular, count every record and reject duplicate raw names before the
/// zip crate gets a chance to build its eager index.
fn validate_zip_metadata(file: &mut std::io::Cursor<Vec<u8>>, max_entries: usize) -> Result<(usize, usize, u16), String> {
    const EOCD_SIGNATURE: u32 = 0x0605_4b50;
    const ZIP64_EOCD_SIGNATURE: u32 = 0x0606_4b50;
    const ZIP64_LOCATOR_SIGNATURE: u32 = 0x0706_4b50;
    const CENTRAL_SIGNATURE: u32 = 0x0201_4b50;
    const EOCD_LEN: u64 = 22;
    const MAX_COMMENT: u64 =  u16::MAX as u64;

    let file_len = file.get_ref().len() as u64;
    if file_len < EOCD_LEN {
        return Err("zip 结构无效：缺少 EOCD".to_string());
    }
    let tail_len = file_len.min(EOCD_LEN + MAX_COMMENT);
    file.seek(SeekFrom::Start(file_len - tail_len))
        .map_err(|e| format!("定位 zip EOCD 失败: {e}"))?;
    let mut tail = vec![0u8; tail_len as usize];
    file.read_exact(&mut tail)
        .map_err(|e| format!("读取 zip EOCD 失败: {e}"))?;
    let eocd_rel = tail
        .windows(4)
        .enumerate()
        .rev()
        .filter(|(_, sig)| u32::from_le_bytes((*sig).try_into().unwrap()) == EOCD_SIGNATURE)
        .find_map(|(at, _)| {
            (tail.len() - at >= EOCD_LEN as usize)
                .then(|| read_le_u16(&tail, at + 20) as u64)
                .filter(|&comment_len| at as u64 + EOCD_LEN + comment_len == tail_len)
                .map(|_| at)
        })
        .ok_or_else(|| "zip 结构无效：找不到有效 EOCD".to_string())?;
    let eocd_offset = file_len - tail_len + eocd_rel as u64;
    let eocd = &tail[eocd_rel..eocd_rel + EOCD_LEN as usize];
    let disk = read_le_u16(eocd, 4);
    let cd_disk = read_le_u16(eocd, 6);
    let disk_count = read_le_u16(eocd, 8);
    let total_count = read_le_u16(eocd, 10);
    if disk != 0 || cd_disk != 0 || disk_count != total_count {
        return Err("zip 结构无效：不支持多磁盘归档".to_string());
    }

    let (entry_count, cd_size, cd_offset, cd_end_limit) =
        if total_count == u16::MAX || read_le_u32(eocd, 12) == u32::MAX || read_le_u32(eocd, 16) == u32::MAX {
            if eocd_offset < 20 {
                return Err("zip 结构无效：缺少 ZIP64 locator".to_string());
            }
            file.seek(SeekFrom::Start(eocd_offset - 20))
                .map_err(|e| format!("定位 ZIP64 locator 失败: {e}"))?;
            let mut locator = [0u8; 20];
            file.read_exact(&mut locator)
                .map_err(|e| format!("读取 ZIP64 locator 失败: {e}"))?;
            if read_le_u32(&locator, 0) != ZIP64_LOCATOR_SIGNATURE
                || read_le_u32(&locator, 4) != 0
                || read_le_u32(&locator, 16) != 1
            {
                return Err("zip 结构无效：ZIP64 locator 不受支持".to_string());
            }
            let zip64_offset = read_le_u64(&locator, 8);
            if zip64_offset.checked_add(56).is_none() || zip64_offset + 56 > file_len {
                return Err("zip 结构无效：ZIP64 EOCD 越界".to_string());
            }
            file.seek(SeekFrom::Start(zip64_offset))
                .map_err(|e| format!("定位 ZIP64 EOCD 失败: {e}"))?;
            let mut zip64_fixed = [0u8; 56];
            file.read_exact(&mut zip64_fixed)
                .map_err(|e| format!("读取 ZIP64 EOCD 失败: {e}"))?;
            if read_le_u32(&zip64_fixed, 0) != ZIP64_EOCD_SIGNATURE
                || read_le_u64(&zip64_fixed, 4) < 44
                || read_le_u32(&zip64_fixed, 16) != 0
                || read_le_u32(&zip64_fixed, 20) != 0
                || read_le_u64(&zip64_fixed, 24) != read_le_u64(&zip64_fixed, 32)
            {
                return Err("zip 结构无效：ZIP64 EOCD 字段错误".to_string());
            }
            (
                read_le_u64(&zip64_fixed, 32),
                read_le_u64(&zip64_fixed, 40),
                read_le_u64(&zip64_fixed, 48),
                zip64_offset,
            )
        } else {
            (
                total_count as u64,
                read_le_u32(eocd, 12) as u64,
                read_le_u32(eocd, 16) as u64,
                eocd_offset,
            )
        };
    if entry_count > max_entries as u64 {
        return Err(format!(
            "zip 条目数 {entry_count} 超过上限 {max_entries}，疑似 zip bomb，拒绝"
        ));
    }
    if cd_size > MAX_ZIP_CENTRAL_DIRECTORY_BYTES {
        return Err(format!(
            "zip 中央目录 {} 字节超过上限 {}，拒绝",
            cd_size, MAX_ZIP_CENTRAL_DIRECTORY_BYTES
        ));
    }
    let cd_end = cd_offset
        .checked_add(cd_size)
        .ok_or_else(|| "zip 结构无效：中央目录溢出".to_string())?;
    if cd_offset > cd_end_limit || cd_end > cd_end_limit || cd_end > file_len {
        return Err("zip 结构无效：中央目录越界".to_string());
    }
    file.seek(SeekFrom::Start(cd_offset))
        .map_err(|e| format!("定位 zip 中央目录失败: {e}"))?;
    let mut central = vec![0u8; cd_size as usize];
    file.read_exact(&mut central)
        .map_err(|e| format!("读取 zip 中央目录失败: {e}"))?;
    let mut names = HashSet::<Vec<u8>>::with_capacity(entry_count as usize);
    let mut cursor = 0usize;
    let mut physical_count = 0u64;
    while cursor < central.len() {
        if central.len() - cursor < 46 || read_le_u32(&central, cursor) != CENTRAL_SIGNATURE {
            return Err("zip 结构无效：中央目录记录损坏".to_string());
        }
        let name_len = read_le_u16(&central, cursor + 28) as usize;
        let extra_len = read_le_u16(&central, cursor + 30) as usize;
        let comment_len = read_le_u16(&central, cursor + 32) as usize;
        let metadata_len = name_len as u64 + extra_len as u64 + comment_len as u64;
        if metadata_len > MAX_ZIP_ENTRY_METADATA_BYTES {
            return Err("zip 条目元数据过大，拒绝".to_string());
        }
        let record_len = 46usize
            .checked_add(name_len)
            .and_then(|n| n.checked_add(extra_len))
            .and_then(|n| n.checked_add(comment_len))
            .ok_or_else(|| "zip 结构无效：中央目录记录溢出".to_string())?;
        if record_len > central.len() - cursor {
            return Err("zip 结构无效：中央目录记录截断".to_string());
        }
        let name_start = cursor + 46;
        if !names.insert(central[name_start..name_start + name_len].to_vec()) {
            return Err("zip 结构无效：重复条目名，拒绝".to_string());
        }
        physical_count += 1;
        if physical_count > entry_count {
            return Err("zip 结构无效：中央目录条目数与 EOCD 不一致".to_string());
        }
        cursor += record_len;
    }
    if physical_count != entry_count {
        return Err("zip 结构无效：中央目录条目数与 EOCD 不一致".to_string());
    }
    Ok((cd_offset as usize, cd_end as usize, entry_count as u16))
}


/// 把插件 zip 安全解压到 `dest_dir`（评审 v2 D7/D11：zip slip 防护）。
///
/// 安全规则（逐条目独立校验，与 manifest entry/assets 前缀检查分开实现/测试）：
/// - 条目名经 `sanitize_plugin_rel_path`——拒绝 `../` 穿越 / 绝对路径 /
///   Windows 盘符 / UNC；
/// - 目录条目直接 create_dir；文件条目先确保父目录存在再流式写（`by_name`
///   的 `read` 流不整包载入内存——def late 压缩按需解压）；
/// - 符号链接/设备条目（unix 文件模式非普通文件）拒绝（链接可指向目录外）；
/// - **zip bomb 上限**（评审复审补强）：条目数 ≤ [`MAX_ZIP_ENTRIES`]、
///   解压总量 ≤ [`MAX_ZIP_UNCOMPRESSED_BYTES`]（超限即拒绝，防恶意压缩包
///   把磁盘/内存打爆——用户主动安装，但值得设防）。
///
/// zip 结构约定：条目以 `<pluginId>/…` 为前缀（zip 内含顶层插件目录）——
/// 安装到 plugins_root 时剥掉顶层。`install_plugin(zip)` 命令负责该语义：
/// 本函数收 zip 文件路径 + 解压目标（已建好），不做顶层剥除。
pub fn extract_plugin_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    extract_plugin_zip_limited(zip_path, dest_dir, MAX_ZIP_ENTRIES, MAX_ZIP_UNCOMPRESSED_BYTES)
}

/// 内部实现：上限可注入（测试用小上限覆盖 zip bomb 分支）。
fn extract_plugin_zip_limited(
    zip_path: &Path,
    dest_dir: &Path,
    max_entries: usize,
    max_total_bytes: u64,
) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("打开 zip 失败: {e}"))?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() { return Err("ZIP 源必须是普通文件".into()); }
    if metadata.len() > MAX_ZIP_ARCHIVE_BYTES { return Err("ZIP 压缩包超过 96 MiB 上限".into()); }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_ZIP_ARCHIVE_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_ZIP_ARCHIVE_BYTES { return Err("ZIP 压缩包超过 96 MiB 上限".into()); }
    let mut snapshot = std::io::Cursor::new(bytes);
    let (central_start, central_end, entries) = validate_zip_metadata(&mut snapshot, max_entries)?;
    let mut bytes = snapshot.into_inner();
    bytes.truncate(central_end);
    if bytes[central_start..].windows(4).any(|marker| matches!(marker, [0x50, 0x4b, 0x05, 0x06] | [0x50, 0x4b, 0x06, 0x06] | [0x50, 0x4b, 0x06, 0x07])) {
        return Err("ZIP 中央目录包含歧义结束标记".into());
    }
    // Even ZIP64 packages fit classic footer fields within our input/count
    // budgets. Per-entry ZIP64 extra fields are retained without conversion.
    let mut footer = [0u8; 22];
    footer[..4].copy_from_slice(&[0x50, 0x4b, 0x05, 0x06]);
    footer[8..10].copy_from_slice(&entries.to_le_bytes());
    footer[10..12].copy_from_slice(&entries.to_le_bytes());
    footer[12..16].copy_from_slice(&((central_end - central_start) as u32).to_le_bytes());
    footer[16..20].copy_from_slice(&(central_start as u32).to_le_bytes());
    bytes.extend_from_slice(&footer);
    let indexing = std::rc::Rc::new(std::cell::Cell::new(true));
    let reader = ValidatedZipReader { bytes, position: 0, footer_start: central_end, indexing: indexing.clone() };
    let mut archive = zip::ZipArchive::with_config(zip::read::Config { archive_offset: zip::read::ArchiveOffset::Known(0) }, reader)
        .map_err(|e| format!("读取 zip 失败（损坏或非 zip）: {e}"))?;
    indexing.set(false);

    let mut total_written: u64 = 0;
    for i in 0..archive.len() {
        let entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目失败: {e}"))?;

        // 目录条目名以 '/' 结尾——先归一化路径（sanitize 拒绝 .. / 绝对路径）。
        let raw_name = entry.name().to_string();
        let is_dir_entry = raw_name.ends_with('/');
        let rel = sanitize_plugin_rel_path(&raw_name)
            .map_err(|e| format!("zip 条目非法（{}）: {raw_name}", e))?;
        if rel.components().count() > MAX_PLUGIN_SOURCE_DEPTH {
            return Err(format!("zip 条目递归深度超过上限 {MAX_PLUGIN_SOURCE_DEPTH}: {raw_name}"));
        }

        // 符号链接/非普通文件拒绝：unix_mode 0 = 无模式信息（Windows zip 常见），
        // 放行；有模式信息且非普通文件/目录 → 拒绝。
        if let Some(mode) = entry.unix_mode() {
            let is_file = mode & 0o170000 == 0o100000;
            let is_dir_mode = mode & 0o170000 == 0o040000;
            if !is_file && !is_dir_mode {
                return Err(format!("zip 条目含非常规文件（链接/设备），拒绝: {raw_name}"));
            }
        }

        let target = dest_dir.join(&rel);
        if is_dir_entry {
            fs::create_dir_all(&target)
                .map_err(|e| format!("创建目录失败 {}: {e}", target.display()))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建父目录失败 {}: {e}", parent.display()))?;
        }
        let mut out = fs::OpenOptions::new().write(true).create_new(true).open(&target)
            .map_err(|e| format!("创建文件失败 {}: {e}", target.display()))?;
        // Do not rely on ZIP metadata: a forged size must not allow an oversized write.
        let remaining = max_total_bytes.saturating_sub(total_written);
        let written = std::io::copy(&mut entry.take(remaining + 1), &mut out)
            .map_err(|e| format!("解压条目失败 {raw_name}: {e}"))?;
        if written > remaining {
            return Err(format!(
                "zip 解压总量超过上限 {max_total_bytes} 字节，疑似 zip bomb，拒绝"
            ));
        }
        total_written += written;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_data_dir_isolated_by_install_generation() {
        let root = Path::new("/config/plugins");
        let first_generation = uuid::Uuid::new_v4().to_string();
        let second_generation = uuid::Uuid::new_v4().to_string();
        let first = web_data_dir(root, "com.example.test", &first_generation).unwrap();
        let second = web_data_dir(root, "com.example.test", &second_generation).unwrap();
        assert_ne!(first, second);
        assert_eq!(first.file_name().and_then(|name| name.to_str()), Some(first_generation.as_str()));
        assert_eq!(second.file_name().and_then(|name| name.to_str()), Some(second_generation.as_str()));
        assert_eq!(first.parent().and_then(Path::file_name).and_then(|name| name.to_str()), Some("com.example.test"));
        assert!(web_data_dir(root, "com.example.test", "../../outside").is_err());
        assert!(web_data_dir(root, "com.example.test", "not-a-generation").is_err());
    }

    fn valid_manifest_json() -> String {
        r#"{
            "id": "com.example.symresolve",
            "name": "Symbol Resolver",
            "version": "1.2.0",
            "description": "resolve crash traces",
            "apiVersion": "1.0",
            "entry": "main.js",
            "permissions": ["terminal:read", "terminal:write"],
            "http": { "urlWhitelist": ["https://symbols.example.com/**"] },
            "ui": {
                "buttons": [{ "id": "resolve", "label": "Resolve", "target": "sidebar" }],
                "menuItems": [{ "id": "resolve-line", "label": "Resolve line", "target": "port-context" }]
            }
        }"#
        .to_string()
    }

    #[test]
    fn parses_valid_manifest() {
        let m = parse_manifest(&valid_manifest_json()).unwrap();
        assert_eq!(m.id, "com.example.symresolve");
        assert_eq!(m.version, "1.2.0");
        assert_eq!(m.api_major(), 1);
        assert_eq!(m.permissions, vec!["terminal:read", "terminal:write"]);
        let http = m.http.unwrap();
        assert_eq!(http.url_whitelist, vec!["https://symbols.example.com/**"]);
        let ui = m.ui.unwrap();
        assert_eq!(ui.buttons.len(), 1);
        assert_eq!(ui.menu_items[0].target.as_deref(), Some("port-context"));
    }

    #[test]
    fn trusted_web_requires_explicit_mode_html_and_capability() {
        let mut value: serde_json::Value = serde_json::from_str(&valid_manifest_json()).unwrap();
        value["permissions"] = serde_json::json!(["ui:view"]);
        value["requires"] = serde_json::json!(["trusted-web-view@1", "plugin-workspace-tabs@1"]);
        value["ui"]["views"] = serde_json::json!([{"id":"web","label":"Web","entry":"ui/index.html","mode":"trusted-web","modes":["trx"],"input":"none","placements":["workspace-tab"],"portBinding":"none"}]);
        assert!(parse_manifest(&value.to_string()).unwrap().has_trusted_web_views());
        value["ui"]["views"][0]["entry"] = "ui/index.htm".into();
        assert!(parse_manifest(&value.to_string()).is_ok());
        value["ui"]["views"][0]["styles"] = serde_json::json!(["ui/main.css"]);
        assert!(parse_manifest(&value.to_string()).is_err());
        value["ui"]["views"][0]["styles"] = serde_json::json!([]);
        value["ui"]["views"][0].as_object_mut().unwrap().remove("mode");
        assert!(parse_manifest(&value.to_string()).is_err());
        value["requires"] = serde_json::json!(["isolated-tab-view@1", "plugin-workspace-tabs@1"]);
        value["ui"]["views"][0]["entry"] = "ui/main.js".into();
        let parsed = parse_manifest(&value.to_string()).unwrap();
        assert_eq!(parsed.ui.unwrap().views[0].mode, ViewMode::Isolated);
    }

    #[test]
    fn view_contract_validates_capabilities_permissions_and_bindings() {
        let mut value: serde_json::Value = serde_json::from_str(&valid_manifest_json()).unwrap();
        value["permissions"] = serde_json::json!(["ui:view", "rx:bytes"]);
        value["requires"] = serde_json::json!(["isolated-tab-view@1", "plugin-workspace-tabs@1"]);
        value["ui"]["views"] = serde_json::json!([{"id":"table","label":"Table","entry":"ui/main.js","styles":["ui/main.css"],"assets":["ui/a.png"],"modes":["trx","tty"],"input":"bytes","placements":["workspace-tab"],"portBinding":"required"}]);
        let valid = serde_json::to_string(&value).unwrap();
        let parsed = parse_manifest(&valid).unwrap();
        assert!(!parsed.ui.unwrap().views[0].restore_on_startup);
        value["requires"] = serde_json::json!(["unknown@1"]);
        assert!(parse_manifest(&value.to_string()).is_err());
        value = serde_json::from_str(&valid).unwrap();
        value["ui"]["views"][0]["entry"] = "data/private.js".into();
        assert!(parse_manifest(&value.to_string()).is_err());
        value = serde_json::from_str(&valid).unwrap();
        value["ui"]["views"][0]["input"] = "lines".into();
        assert!(parse_manifest(&value.to_string()).is_err());
        value = serde_json::from_str(&valid).unwrap();
        value["ui"]["views"][0]["portBinding"] = "none".into();
        assert!(parse_manifest(&value.to_string()).is_err());
        value = serde_json::from_str(&valid).unwrap();
        let duplicate = value["ui"]["views"][0].clone();
        value["ui"]["views"].as_array_mut().unwrap().push(duplicate);
        assert!(parse_manifest(&value.to_string()).is_err());
    }

    #[test]
    fn manifest_read_bounds_metadata_stream_and_exact_boundary() {
        let root = std::env::temp_dir().join(format!("manifest_bounds_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let mut json = valid_manifest_json();
        json.push_str(&" ".repeat(MAX_MANIFEST_BYTES as usize - json.len()));
        fs::write(root.join("manifest.json"), &json).unwrap();
        assert!(load_manifest_from_dir(&root).is_ok());
        json.push(' ');
        fs::write(root.join("manifest.json"), &json).unwrap();
        assert!(load_manifest_from_dir(&root).is_err());
        // A growing source must still be bounded even when metadata was smaller.
        assert!(read_manifest_bytes(json.as_bytes(), 0).is_err());
        fs::write(root.join("manifest.json"), [255]).unwrap();
        assert!(load_manifest_from_dir(&root).is_err());
        fs::remove_file(root.join("manifest.json")).unwrap();
        fs::create_dir(root.join("manifest.json")).unwrap();
        assert!(load_manifest_from_dir(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn manifest_rejects_linked_file_and_directory() {
        let root = std::env::temp_dir().join(format!("manifest_links_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("source")).unwrap();
        fs::write(root.join("real.json"), valid_manifest_json()).unwrap();
        std::os::unix::fs::symlink(root.join("real.json"), root.join("source/manifest.json")).unwrap();
        assert!(load_manifest_from_dir(&root.join("source")).is_err());
        fs::remove_file(root.join("source/manifest.json")).unwrap();
        fs::write(root.join("source/manifest.json"), valid_manifest_json()).unwrap();
        std::os::unix::fs::symlink(root.join("source"), root.join("linked")).unwrap();
        assert!(load_manifest_from_dir(&root.join("linked")).is_err());
        fs::remove_file(root.join("linked")).unwrap();
        fs::remove_file(root.join("source/manifest.json")).unwrap();
        fs::write(root.join("real.json"), valid_manifest_json()).unwrap();
        fs::hard_link(root.join("real.json"), root.join("source/manifest.json")).unwrap();
        assert!(load_manifest_lite(&root.join("source")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_missing_required_fields() {
        // 缺 id
        let json = r#"{"name":"X","version":"1.0.0","apiVersion":"1.0","entry":"main.js","permissions":[]}"#;
        assert!(parse_manifest(json).is_err());

        // 缺 apiVersion
        let json = r#"{"id":"com.x.y","name":"X","version":"1.0.0","entry":"main.js","permissions":[]}"#;
        let err = parse_manifest(json).unwrap_err();
        assert!(err.contains("apiVersion"), "err: {err}");

        // 缺 permissions（serde：非 Option 字段缺失 → JSON 层报错）
        let json = r#"{"id":"com.x.y","name":"X","version":"1.0.0","apiVersion":"1.0","entry":"main.js"}"#;
        assert!(parse_manifest(json).is_err());
    }

    #[test]
    fn pure_html_manifest_requires_independent_readonly_trusted_views() {
        let base = r#"{"id":"com.x.y","name":"X","version":"1.0.0","apiVersion":"1.0","permissions":["ui:view"],"requires":["trusted-web-view@1","plugin-workspace-tabs@1"],"ui":{"views":[{"id":"web","label":"Web","entry":"ui/index.html","mode":"trusted-web","modes":["trx"],"input":"none","placements":["workspace-tab"],"portBinding":"none"}]}}"#;
        let parsed = parse_manifest(base).unwrap();
        assert!(parsed.entry.is_empty());
        assert!(parsed.ui.as_ref().unwrap().views[0].worker);

        let worker_false = base.replace(
            "\"portBinding\":\"none\"",
            "\"portBinding\":\"none\",\"worker\":false",
        );
        assert!(!parse_manifest(&worker_false).unwrap().ui.unwrap().views[0].worker);

        // Worker-only buttons/menu are forbidden when the root entry is absent.
        let mut value: serde_json::Value = serde_json::from_str(base).unwrap();
        value["ui"]["buttons"] = serde_json::json!([{"id":"b","label":"B"}]);
        assert!(parse_manifest(&value.to_string()).is_err());

        // input:bytes view depends on a Worker.
        let mut value: serde_json::Value = serde_json::from_str(base).unwrap();
        value["ui"]["views"][0]["input"] = "bytes".into();
        assert!(parse_manifest(&value.to_string()).is_err());

        // Isolated view depends on a Worker.
        let mut value: serde_json::Value = serde_json::from_str(base).unwrap();
        value["ui"]["views"][0]["mode"] = "isolated".into();
        value["ui"]["views"][0]["entry"] = "ui/main.js".into();
        value["requires"] =
            serde_json::json!(["isolated-tab-view@1", "plugin-workspace-tabs@1"]);
        assert!(parse_manifest(&value.to_string()).is_err());

        // worker:false is only valid for trusted-web + input:none.
        // (Root entry present so the empty-entry rule does not fire first.)
        let mut value: serde_json::Value = serde_json::from_str(base).unwrap();
        value["entry"] = "main.js".into();
        value["ui"]["views"][0]["input"] = "bytes".into();
        value["ui"]["views"][0]["worker"] = false.into();
        let err = parse_manifest(&value.to_string()).unwrap_err();
        assert!(err.contains("worker:false"), "err: {err}");
    }

    #[test]
    fn rejects_non_reverse_domain_id() {
        let mut json = valid_manifest_json();
        json = json.replacen("com.example.symresolve", "no-dots", 1);
        let err = parse_manifest(&json).unwrap_err();
        assert!(err.contains("反向域名"), "err: {err}");
    }

    #[test]
    fn rejects_bad_semver() {
        let mut json = valid_manifest_json();
        json = json.replacen("\"1.2.0\"", "\"abc\"", 1);
        assert!(parse_manifest(&json).is_err());

        let mut json2 = valid_manifest_json();
        json2 = json2.replacen("\"1.0\"", "\"2.0\"", 1); // apiVersion 2.0 ≠ 宿主 1
        let err = parse_manifest(&json2).unwrap_err();
        assert!(err.contains("不兼容"), "err: {err}");
    }

    #[test]
    fn rejects_entry_outside_plugin_dir() {
        // 绝对路径 entry
        let mut json = valid_manifest_json();
        json = json.replacen("\"main.js\"", "\"/etc/passwd\"", 1);
        let err = parse_manifest(&json).unwrap_err();
        assert!(err.contains("绝对路径"), "err: {err}");

        // 穿越 entry
        let mut json = valid_manifest_json();
        json = json.replacen("\"main.js\"", "\"../evil.js\"", 1);
        let err = parse_manifest(&json).unwrap_err();
        assert!(err.contains("穿越"), "err: {err}");
    }

    #[test]
    fn rejects_duplicate_permissions() {
        let mut json = valid_manifest_json();
        json = json.replacen(
            "\"terminal:write\"",
            "\"terminal:read\", \"terminal:read\"",
            1,
        );
        let err = parse_manifest(&json).unwrap_err();
        assert!(err.contains("重复"), "err: {err}");
    }

    #[test]
    fn sanitize_path_allows_nested_relative() {
        let p = sanitize_plugin_rel_path("assets/maps/./sym.map").unwrap();
        assert_eq!(p, PathBuf::from("assets/maps/sym.map"));
    }

    #[test]
    fn sanitize_path_rejects_traversal_and_absolute() {
        assert!(sanitize_plugin_rel_path("../x").is_err());
        assert!(sanitize_plugin_rel_path("a/../../b").is_err());
        assert!(sanitize_plugin_rel_path("/etc/passwd").is_err());
        assert!(sanitize_plugin_rel_path("C:/windows").is_err());
        assert!(sanitize_plugin_rel_path("C:\\windows").is_err());
        assert!(sanitize_plugin_rel_path("").is_err());
        assert!(sanitize_plugin_rel_path(".").is_err()); // 归一后为空
    }

    #[test]
    fn sanitize_path_rejects_win32_aliases_and_device_names() {
        // Win32 strips trailing dots/spaces and resolves colon as ADS.
        assert!(sanitize_plugin_rel_path(".. /.. /evil.js").is_err());
        assert!(sanitize_plugin_rel_path("assets/evil.js ").is_err());
        assert!(sanitize_plugin_rel_path("assets/evil.js.").is_err());
        assert!(sanitize_plugin_rel_path("assets/foo:bar").is_err());
        assert!(sanitize_plugin_rel_path("assets/CON").is_err());
        assert!(sanitize_plugin_rel_path("assets/com1.txt").is_err());
        assert!(sanitize_plugin_rel_path("assets/state.json\0junk").is_err());
        assert!(sanitize_plugin_rel_path("assets/PROGRA~1").is_err());
        // Legitimate names still pass.
        assert!(sanitize_plugin_rel_path("assets/console.js").is_ok());
        assert!(sanitize_plugin_rel_path("assets/com10.txt").is_ok());
    }

    #[test]
    fn plugin_id_rejects_windows_device_labels() {
        assert!(validate_plugin_id("con.example").is_err());
        assert!(validate_plugin_id("com1.example").is_err());
        assert!(validate_plugin_id("com.example").is_ok());
    }

    #[test]
    fn windows_style_separators_normalize() {
        let p = sanitize_plugin_rel_path("assets\\maps\\sym.map").unwrap();
        assert_eq!(p, PathBuf::from("assets/maps/sym.map"));
    }

    #[test]
    fn semver_helpers() {
        assert_eq!(parse_semver("1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_semver("1.2"), Some((1, 2, 0)));
        assert_eq!(parse_semver("1"), Some((1, 0, 0)));
        assert!(parse_semver("1.2.3.4").is_none());
        assert!(parse_semver("v1.2").is_none());
        assert!(version_greater("1.3.0", "1.2.9"));
        assert!(!version_greater("1.2.0", "1.2.0"));
    }

    #[test]
    fn scan_empty_or_missing_root() {
        let root = std::env::temp_dir().join(format!("hypercom_scan_missing_{}", uuid::Uuid::new_v4()));
        assert!(scan_plugins(&root).is_empty());
    }

    #[test]
    fn scan_skips_non_dirs_and_reports_bad_manifest() {
        let root = std::env::temp_dir().join(format!("hypercom_scan_{}", uuid::Uuid::new_v4()));
        let _ = fs::create_dir_all(&root);
        let good_dir = root.join("com.example.symresolve");
        fs::create_dir_all(&good_dir).unwrap();
        fs::write(good_dir.join("manifest.json"), valid_manifest_json()).unwrap();
        let bad_dir = root.join("com.example.bad");
        fs::create_dir_all(&bad_dir).unwrap();
        fs::write(bad_dir.join("manifest.json"), "not json").unwrap();
        fs::write(root.join("loose.txt"), "skip me").unwrap();

        let found = scan_plugins(&root);
        assert_eq!(found.len(), 2);
        let good = found.iter().find(|p| p.dir.file_name().unwrap() == "com.example.symresolve").unwrap();
        assert!(good.manifest.is_ok());
        let bad = found.iter().find(|p| p.dir.file_name().unwrap() == "com.example.bad").unwrap();
        assert!(bad.manifest.is_err());

        let _ = fs::remove_dir_all(&root);
    }

    /// 构造一个内存 zip 写入临时文件。entries: (name, content)。
    fn write_test_zip(path: &Path, entries: &[(&str, &str)]) {
        let file = fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default();
        for (name, content) in entries {
            if *name == "__DIR__" {
                // 目录占位：真实 zip 用带尾斜杠条目
                continue;
            }
            w.start_file(*name, opts).unwrap();
            use std::io::Write;
            w.write_all(content.as_bytes()).unwrap();
        }
        w.finish().unwrap();
    }

    #[test]
    fn extract_zip_ok_regular_layout() {
        let dir = std::env::temp_dir().join(format!("hypercom_zip_ok_{}", uuid::Uuid::new_v4()));
        let zip_path = dir.join("pkg.zip");
        fs::create_dir_all(&dir).unwrap();
        write_test_zip(
            &zip_path,
            &[
                ("com.example.demo/manifest.json", valid_manifest_json().as_str()),
                ("com.example.demo/main.js", "console.log('hi')"),
            ],
        );
        let dest = dir.join("out");
        extract_plugin_zip(&zip_path, &dest).unwrap();
        assert!(dest.join("com.example.demo/manifest.json").exists());
        assert_eq!(
            fs::read_to_string(dest.join("com.example.demo/main.js")).unwrap(),
            "console.log('hi')"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn zip64_footer_and_embedded_comment_signature_extract_normally() {
        let dir = std::env::temp_dir().join(format!("hypercom_zip64_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("package.zip");
        write_test_zip(&path, &[("com.example.demo/main.js", "payload")]);
        let mut bytes = fs::read(&path).unwrap();
        let footer_at = bytes.len() - 22;
        let mut footer = bytes.split_off(footer_at);
        let count = read_le_u16(&footer, 10) as u64;
        let size = read_le_u32(&footer, 12) as u64;
        let offset = read_le_u32(&footer, 16) as u64;
        let mut zip64 = [0u8; 56];
        zip64[..4].copy_from_slice(&[0x50, 0x4b, 0x06, 0x06]);
        zip64[4..12].copy_from_slice(&44u64.to_le_bytes());
        zip64[12..14].copy_from_slice(&45u16.to_le_bytes());
        zip64[14..16].copy_from_slice(&45u16.to_le_bytes());
        zip64[24..32].copy_from_slice(&count.to_le_bytes());
        zip64[32..40].copy_from_slice(&count.to_le_bytes());
        zip64[40..48].copy_from_slice(&size.to_le_bytes());
        zip64[48..56].copy_from_slice(&offset.to_le_bytes());
        bytes.extend_from_slice(&zip64);
        bytes.extend_from_slice(&[0x50, 0x4b, 0x06, 0x07]);
        bytes.extend_from_slice(&0u32.to_le_bytes());
        bytes.extend_from_slice(&(footer_at as u64).to_le_bytes());
        bytes.extend_from_slice(&1u32.to_le_bytes());
        footer[8..12].fill(0xff); footer[12..20].fill(0xff);
        let comment = b"normal comment PK\x05\x06 tail";
        footer[20..22].copy_from_slice(&(comment.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&footer); bytes.extend_from_slice(comment);
        fs::write(&path, bytes).unwrap();
        extract_plugin_zip(&path, &dir.join("out")).unwrap();
        assert_eq!(fs::read_to_string(dir.join("out/com.example.demo/main.js")).unwrap(), "payload");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn genuine_zip64_entry_extra_fields_are_supported() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("hypercom_zip64_entry_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("package.zip");
        let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        writer.set_zip64_comment(Some("bounded"));
        writer.start_file("com.example.demo/main.js", zip::write::SimpleFileOptions::default().large_file(true)).unwrap();
        writer.write_all(b"real ZIP64 payload").unwrap(); writer.finish().unwrap();
        extract_plugin_zip(&path, &dir.join("out")).unwrap();
        assert_eq!(fs::read(dir.join("out/com.example.demo/main.js")).unwrap(), b"real ZIP64 payload");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn forged_count_and_duplicate_physical_records_are_rejected_before_extracting() {
        let dir = std::env::temp_dir().join(format!("hypercom_zip_metadata_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("package.zip");
        write_test_zip(&path, &[("com.example.demo/aa.js", "first"), ("com.example.demo/bb.js", "second")]);
        let original = fs::read(&path).unwrap();
        let footer = original.len() - 22;
        let mut forged = original.clone();
        forged[footer + 8..footer + 12].fill(0);
        fs::write(&path, &forged).unwrap();
        assert!(extract_plugin_zip(&path, &dir.join("bad-count")).unwrap_err().contains("条目数"));
        let mut duplicate = original.clone();
        let central = read_le_u32(&duplicate, footer + 16) as usize;
        let first_len = 46 + read_le_u16(&duplicate, central + 28) as usize + read_le_u16(&duplicate, central + 30) as usize + read_le_u16(&duplicate, central + 32) as usize;
        let second_name = central + first_len + 46;
        duplicate[second_name..second_name + "com.example.demo/aa.js".len()].copy_from_slice(b"com.example.demo/aa.js");
        fs::write(&path, duplicate).unwrap();
        assert!(extract_plugin_zip(&path, &dir.join("duplicates")).unwrap_err().contains("重复"));
        assert!(!dir.join("bad-count").exists());
        assert!(!dir.join("duplicates").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn archive_input_and_central_metadata_have_preparse_budgets() {
        let dir = std::env::temp_dir().join(format!("hypercom_zip_budget_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("package.zip");
        fs::File::create(&path).unwrap().set_len(MAX_ZIP_ARCHIVE_BYTES + 1).unwrap();
        assert!(extract_plugin_zip(&path, &dir.join("oversize")).unwrap_err().contains("96 MiB"));
        write_test_zip(&path, &[("com.example.demo/main.js", "payload")]);
        let mut bytes = fs::read(&path).unwrap();
        let footer = bytes.len() - 22;
        bytes[footer + 12..footer + 16].copy_from_slice(&((MAX_ZIP_CENTRAL_DIRECTORY_BYTES + 1) as u32).to_le_bytes());
        fs::write(&path, bytes).unwrap();
        assert!(extract_plugin_zip(&path, &dir.join("metadata")).unwrap_err().contains("中央目录"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn parser_cannot_fall_back_to_an_unvalidated_earlier_footer() {
        let dir = std::env::temp_dir().join(format!("hypercom_zip_footer_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("package.zip");
        use std::io::Write;
        let mut fake = [0u8; 22]; fake[..4].copy_from_slice(&[0x50, 0x4b, 0x05, 0x06]);
        fake[8..10].copy_from_slice(&60000u16.to_le_bytes());
        fake[10..12].copy_from_slice(&60000u16.to_le_bytes());
        let mut writer = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        writer.start_file("com.example.demo/main.js", zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)).unwrap();
        writer.write_all(&fake).unwrap(); writer.finish().unwrap();
        let mut bytes = fs::read(&path).unwrap();
        let footer = bytes.len() - 22;
        let central = read_le_u32(&bytes, footer + 16) as usize;
        // Fail after indexing starts, which normally makes zip 2.x retry the
        // attacker footer embedded in stored payload and allocate its count.
        bytes[central + 42..central + 46].copy_from_slice(&(central as u32).to_le_bytes());
        fs::write(&path, bytes).unwrap();
        assert!(extract_plugin_zip(&path, &dir.join("out")).is_err());
        assert!(!dir.join("out").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn extract_zip_rejects_traversal_entry() {
        let dir = std::env::temp_dir().join(format!("hypercom_zip_slip_{}", uuid::Uuid::new_v4()));
        let zip_path = dir.join("pkg.zip");
        fs::create_dir_all(&dir).unwrap();
        write_test_zip(
            &zip_path,
            &[
                ("com.example.demo/manifest.json", valid_manifest_json().as_str()),
                ("../evil.txt", "pwned"),
            ],
        );
        let dest = dir.join("out");
        let err = extract_plugin_zip(&zip_path, &dest).unwrap_err();
        assert!(err.contains("非法") || err.contains("穿越"), "err: {err}");
        // 无害条目可能已写入，但越界条目必须失败——断言没有文件逃逸出 dest。
        assert!(!dir.join("evil.txt").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_zip_rejects_absolute_entry() {
        let dir = std::env::temp_dir().join(format!("hypercom_zip_abs_{}", uuid::Uuid::new_v4()));
        let zip_path = dir.join("pkg.zip");
        fs::create_dir_all(&dir).unwrap();
        write_test_zip(
            &zip_path,
            &[
                ("/etc/passwd", "root:x"),
            ],
        );
        let dest = dir.join("out");
        let err = extract_plugin_zip(&zip_path, &dest).unwrap_err();
        assert!(err.contains("绝对路径"), "err: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_zip_non_utf8_or_duplicate_names_handled() {
        // zip 条目名非 UTF-8 时 zip crate 的 name() 会怎样——确保不 panic。
        // 用 Windows 反斜杠分隔（winzip 常见）也应归一化成功。
        let dir = std::env::temp_dir().join(format!("hypercom_zip_bs_{}", uuid::Uuid::new_v4()));
        let zip_path = dir.join("pkg.zip");
        fs::create_dir_all(&dir).unwrap();
        write_test_zip(
            &zip_path,
            &[
                ("com.example.demo\\manifest.json", valid_manifest_json().as_str()),
            ],
        );
        let dest = dir.join("out");
        extract_plugin_zip(&zip_path, &dest).unwrap();
        assert!(dest.join("com.example.demo/manifest.json").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_zip_rejects_entry_count_over_limit() {
        // 条目数上限注入小值（2）——3 个文件即拒绝（真实上限 2000 太大不便于测）。
        let dir = std::env::temp_dir().join(format!("hypercom_zip_cnt_{}", uuid::Uuid::new_v4()));
        let zip_path = dir.join("pkg.zip");
        fs::create_dir_all(&dir).unwrap();
        write_test_zip(
            &zip_path,
            &[
                ("com.example.demo/manifest.json", valid_manifest_json().as_str()),
                ("com.example.demo/a.js", "a"),
                ("com.example.demo/b.js", "b"),
            ],
        );
        let dest = dir.join("out");
        let err = extract_plugin_zip_limited(&zip_path, &dest, 2, MAX_ZIP_UNCOMPRESSED_BYTES)
            .unwrap_err();
        assert!(err.contains("条目数"), "err: {err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_zip_rejects_total_uncompressed_over_limit() {
        // 解压总量上限注入小值（10 字节）——20 字节条目拒绝（zip bomb 分支）。
        let dir = std::env::temp_dir().join(format!("hypercom_zip_bomb_{}", uuid::Uuid::new_v4()));
        let zip_path = dir.join("pkg.zip");
        fs::create_dir_all(&dir).unwrap();
        write_test_zip(
            &zip_path,
            &[
                ("com.example.demo/big.js", "0123456789ABCDEFGHIJKLMNOPQRSTUV"),
            ],
        );
        let dest = dir.join("out");
        let err = extract_plugin_zip_limited(&zip_path, &dest, MAX_ZIP_ENTRIES, 10).unwrap_err();
        assert!(err.contains("总量"), "err: {err}");
        let _ = fs::remove_dir_all(&dir);
    }
    #[test]
    fn zip_limit_applies_during_each_copy() {
        let dir = std::env::temp_dir().join(format!("hypercom_zip_bound_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("pkg.zip");
        write_test_zip(&zip_path, &[("com.example.demo/first", "12345678"),
            ("com.example.demo/second", "abcdefghijk")]);
        let out = dir.join("out");
        assert!(extract_plugin_zip_limited(&zip_path, &out, MAX_ZIP_ENTRIES, 10).is_err());
        assert_eq!(fs::metadata(out.join("com.example.demo/first")).unwrap().len(), 8);
        assert!(fs::metadata(out.join("com.example.demo/second")).unwrap().len() <= 3);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn extract_zip_rejects_excessive_path_depth() {
        let dir = std::env::temp_dir().join(format!("hypercom_zip_depth_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("pkg.zip");
        let name = std::iter::repeat_n("x", MAX_PLUGIN_SOURCE_DEPTH + 1)
            .collect::<Vec<_>>()
            .join("/");
        write_test_zip(&zip_path, &[(name.as_str(), "")]);
        let error = extract_plugin_zip(&zip_path, &dir.join("out")).unwrap_err();
        assert!(error.contains("深度"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn manifest_rejects_dangerous_id_segments() {
        for id in [".", "..", "com..example", ".com", "com.", "com/example", "COM.example"] {
            assert!(validate_plugin_id(id).is_err(), "{id}");
            assert!(parse_manifest(&valid_manifest_json().replace("com.example.symresolve", id)).is_err(), "{id}");
        }
    }


    #[test]
    fn manifest_serial_scope_validation() {
        // serial.portWhitelist 正常声明 → 解析成功；空串条目 → 拒绝（scope 同规）。
        let mut json = valid_manifest_json();
        json = json.replacen(
            r#""http": { "urlWhitelist": ["https://symbols.example.com/**"] },"#,
            r#""http": { "urlWhitelist": ["https://symbols.example.com/**"] },
            "serial": { "portWhitelist": ["COM3", "COM7"] },"#,
            1,
        );
        let m = parse_manifest(&json).unwrap();
        assert_eq!(
            m.serial.unwrap().port_whitelist,
            vec!["COM3", "COM7"]
        );

        let mut bad = valid_manifest_json();
        bad = bad.replacen(
            r#""http": { "urlWhitelist": ["https://symbols.example.com/**"] },"#,
            r#""serial": { "portWhitelist": ["COM3", ""] },"#,
            1,
        );
        let err = parse_manifest(&bad).unwrap_err();
        assert!(err.contains("空项"), "err: {err}");
    }

    #[test]
    fn manifest_scope_optional_absent_ok() {
        // 不声明 serial/http/shell → 全部 None（向后兼容旧 manifest）。
        let json = r#"{"id":"com.x.y","name":"X","version":"1.0.0","apiVersion":"1.0","entry":"main.js","permissions":["terminal:read"]}"#;
        let m = parse_manifest(json).unwrap();
        assert!(m.serial.is_none());
        assert!(m.http.is_none());
        assert!(m.shell.is_none());
    }

}
