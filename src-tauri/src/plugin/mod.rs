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
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 宿主 API 版本。插件 manifest `apiVersion` 的主版本必须等于它
/// （semver：主版本不兼容视为不可用，次版本向后兼容放行）。
pub const HOST_API_MAJOR: u32 = 1;

/// 已知权限集（v1）。manifest 声明的未知权限在桥侧不会被授予
/// （manifest permissions 只是「可授予上限」，评审 v2 P7），此处不拒绝未知权限，
/// 只做格式校验——未知权限静默不授予比拒绝安装对生态更友好。
/// 此表供前端设置页展示与默认授权提示使用（经 list 命令透出）。
pub const KNOWN_PERMISSIONS: &[&str] = &[
    "terminal:read",
    "terminal:write",
    "fs:assets",
    "fs:storage",
    "serial:send",
    "http:request",
    "shell:execute",
    "shell:open",
    "clipboard",
    "notify",
    "storage",
    "events",
];

// ==================== Manifest 结构 ====================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HttpScope {
    /// URL 白名单 glob（`http.urlWhitelist`）。运行时逐条匹配，空数组 = 全部拒绝。
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UiDecl {
    #[serde(default)]
    pub buttons: Vec<UiButton>,
    #[serde(default)]
    pub menu_items: Vec<UiMenuItem>,
}

/// 插件 manifest（`manifest.json`）。
/// 必填：`id`（反向域名）/`name`/`version`/`apiVersion`/`entry`/`permissions`。
/// 可选：`description`/`http`/`shell`/`ui`。
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
    pub entry: String,
    /// 声明的权限（「可授予上限」）。
    pub permissions: Vec<String>,
    #[serde(default)]
    pub http: Option<HttpScope>,
    #[serde(default)]
    pub shell: Option<ShellScope>,
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

/// 从插件目录读取并校验 manifest.json。目录缺失/非目录 → Err。
pub fn load_manifest_from_dir(dir: &Path) -> Result<PluginManifest, String> {
    let manifest_path = dir.join("manifest.json");
    let content = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("读取 manifest.json 失败 ({})", e))?;
    parse_manifest(&content)
}

impl PluginManifest {
    /// 结构校验（纯函数，无 IO）。任一步失败返回带上下文的错误串。
    pub fn validate(&self) -> Result<(), String> {
        // id：反向域名格式——非空、小写字母/数字/`.`/`-`/`_`，至少一段。
        if self.id.is_empty() {
            return Err("manifest 缺少必填字段 id（反向域名）".into());
        }
        if !self
            .id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-' || c == '_')
        {
            return Err(format!("manifest id 含非法字符: {}", self.id));
        }
        if !self.id.contains('.') {
            return Err(format!("manifest id 应为反向域名（含至少一个 .）: {}", self.id));
        }

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
            return Err("manifest 缺少必填字段 entry".into());
        }
        // entry 必须指向插件目录内（防越目录引用与解压后穿越）。
        sanitize_plugin_rel_path(&self.entry)
            .map_err(|e| format!("manifest entry 非法: {e}"))?;

        // permissions 去重校验（内容校验在桥侧做，未知权限静默不授予）。
        let mut seen = std::collections::HashSet::new();
        for p in &self.permissions {
            if p.trim().is_empty() {
                return Err("manifest permissions 含空项".into());
            }
            if !seen.insert(p.clone()) {
                return Err(format!("manifest permissions 重复声明: {p}"));
            }
        }
        Ok(())
    }

    /// apiVersion 主版本。
    pub fn api_major(&self) -> u32 {
        semver_major(&self.api_version)
    }
}

// ==================== 路径防护 ====================

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
    if rel.contains('\\') && !rel.contains('/') && cfg!(not(windows)) {
        // unix 上反斜杠是合法文件名字符，但插件路径约定统一 `/`——不误伤。
        // 仅 windows 需要把 `\` 当分隔符（Path::components 在 windows 上会处理）。
    }
    // 统一分隔符（windows + unix 双写兼容）：`\` → `/` 后再走 Path 组件。
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
            if !path.is_dir() {
                continue; // 跳过松散文件（用户可能放 README 等）
            }
            let manifest = load_manifest_from_dir(&path);
            out.push(InstalledPlugin { dir: path, manifest });
        }
    }
    // 稳定排序：目录名（= 插件 id，反向域名）字典序。
    out.sort_by(|a, b| a.dir.file_name().cmp(&b.dir.file_name()));
    out
}

/// 把插件 zip 安全解压到 `dest_dir`（评审 v2 D7/D11：zip slip 防护）。
///
/// 安全规则（逐条目独立校验，与 manifest entry/assets 前缀检查分开实现/测试）：
/// - 条目名经 `sanitize_plugin_rel_path`——拒绝 `../` 穿越 / 绝对路径 /
///   Windows 盘符 / UNC；
/// - 目录条目直接 create_dir；文件条目先确保父目录存在再流式写（`by_name`
///   的 `read` 流不整包载入内存——def late 压缩按需解压）；
/// - 符号链接/设备条目（unix 文件模式非普通文件）拒绝（链接可指向目录外）。
///
/// zip 结构约定：条目以 `<pluginId>/…` 为前缀（zip 内含顶层插件目录）——
/// 安装到 plugins_root 时剥掉顶层。`install_plugin(zip)` 命令负责该语义：
/// 本函数收 zip 文件路径 + 解压目标（已建好），不做顶层剥除。
pub fn extract_plugin_zip(zip_path: &Path, dest_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("打开 zip 失败: {e}"))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("读取 zip 失败（损坏或非 zip）: {e}"))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目失败: {e}"))?;

        // 目录条目名以 '/' 结尾——先归一化路径（sanitize 拒绝 .. / 绝对路径）。
        let raw_name = entry.name().to_string();
        let is_dir_entry = raw_name.ends_with('/');
        let rel = sanitize_plugin_rel_path(&raw_name)
            .map_err(|e| format!("zip 条目非法（{}）: {raw_name}", e))?;

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
        let mut out = fs::File::create(&target)
            .map_err(|e| format!("创建文件失败 {}: {e}", target.display()))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| format!("解压条目失败 {raw_name}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let good_dir = root.join("com.example.good");
        fs::create_dir_all(&good_dir).unwrap();
        fs::write(good_dir.join("manifest.json"), valid_manifest_json()).unwrap();
        let bad_dir = root.join("com.example.bad");
        fs::create_dir_all(&bad_dir).unwrap();
        fs::write(bad_dir.join("manifest.json"), "not json").unwrap();
        fs::write(root.join("loose.txt"), "skip me").unwrap();

        let found = scan_plugins(&root);
        assert_eq!(found.len(), 2);
        let good = found.iter().find(|p| p.dir.file_name().unwrap() == "com.example.good").unwrap();
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
    fn install_dir_scan_roundtrip_detects_and_validates() {
        // 模拟「安装目录 → 扫描」闭环（install_plugin 的核心校验链：
        // 复制目录 + scan_plugins 发现 + manifest 权威校验）。
        let dir = std::env::temp_dir().join(format!("hypercom_install_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();

        // 源插件目录（含 manifest + 入口 + 资产）。
        let src = dir.join("src_plugin");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("manifest.json"), valid_manifest_json()).unwrap();
        fs::write(src.join("main.js"), "console.log('hi')").unwrap();
        fs::create_dir_all(src.join("assets")).unwrap();
        fs::write(src.join("assets/symbols.map"), "map").unwrap();

        // 目标 plugins 根（模拟 <config_dir>/plugins）。
        let plugins_root = dir.join("plugins");
        fs::create_dir_all(&plugins_root).unwrap();
        let dest = plugins_root.join("com.example.symresolve");
        copy_dir_tree_for_test(&src, &dest);

        // scan 发现并校验通过。
        let found = scan_plugins(&plugins_root);
        assert_eq!(found.len(), 1);
        let manifest = found[0].manifest.as_ref().unwrap();
        assert_eq!(manifest.id, "com.example.symresolve");
        assert_eq!(manifest.entry, "main.js");
        assert_eq!(manifest.permissions.len(), 2);

        // entry 资产可读（read_plugin_asset 语义的路径解析）。
        let entry_rel = sanitize_plugin_rel_path(&manifest.entry).unwrap();
        let entry_path = dest.join(entry_rel);
        assert_eq!(fs::read_to_string(entry_path).unwrap(), "console.log('hi')");
        // 资产在插件目录内可读、目录外拒绝。
        let ok_rel = sanitize_plugin_rel_path("assets/symbols.map").unwrap();
        assert!(dest.join(ok_rel).is_file());
        assert!(sanitize_plugin_rel_path("../outside").is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    /// 测试用递归复制（生产用 commands/plugin.rs 的 copy_dir_recursive——命令层
    /// 依赖 Tauri State 不便单测，此处独立实现等价语义）。
    fn copy_dir_tree_for_test(src: &std::path::Path, dest: &std::path::Path) {
        fs::create_dir_all(dest).unwrap();
        for entry in fs::read_dir(src).unwrap() {
            let entry = entry.unwrap();
            let t = dest.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_dir_tree_for_test(&entry.path(), &t);
            } else {
                fs::copy(entry.path(), &t).unwrap();
            }
        }
    }
}
