/**
 * 插件命令域（issue #17，第 12 个命令域）
 *
 * 职责：
 * - 插件状态 CRUD（enable/permissions/install/uninstall/list）——锁 config_manager
 *   读写 `AppConfig.plugin_configs` 状态实体 + `crate::plugin` 纯函数层做磁盘
 *   扫描/manifest 校验/路径防护。
 * - 插件资产读写（`read_plugin_asset` / `write_plugin_asset`）——路径规范化 +
 *   前缀校验（评审 v2 D5：canonicalize 后必须落在 `<plugins_dir>/<id>/` 内）。
 *
 * 错误分类：IO 类（文件系统）→ `CommandError::Io`；manifest/校验类 →
 * `CommandError::Other`（带可读串）；config 持久化 → `CommandError::Config`；
 * 锁 → `CommandError::Lock`。前端收到的错误串即用户可读信息（含中文），
 * 与既有命令域一致（toast 直接展示）。
 *
 * zip 安装（评审 v2 D7：zip slip 单列防护 + 独立测试）在后续增量实现——
 * v1 先落地「目录安装」闭环（install_plugin(dirPath)），zip 分支补齐后同命令
 * 扩展。状态实体/资产读写/扫描骨架先行，保证设置页/宿主桥可并行开发。
 */
use std::path::Path;

use tauri::State;

use super::CommandError;
use crate::config;
use crate::plugin::{self, PluginManifest};
use crate::AppState;

/// 单个插件的完整视图（前端设置页/宿主桥消费）。
/// manifest = 磁盘权威（每次 list 现扫）；state = config 实体状态。
/// manifest 损坏时（Err）仍列出该项，前端显示「校验失败」而非整体报错。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginView {
    pub id: String,
    pub dir: String,
    pub enabled: bool,
    /// 用户已授予权限（config 实体）。manifest 声明是上限，此处是实际授予。
    pub granted_permissions: Vec<String>,
    /// manifest 声明权限（未授予前不生效）——供前端授权对话框展示。
    pub declared_permissions: Vec<String>,
    /// 宿主已知权限全集——供前端设置页展示「可授予权限」清单。
    pub known_permissions: Vec<String>,
    pub manifest: Option<PluginManifestView>,
    /// manifest 读取/校验错误串（None = 正常）。
    pub manifest_error: Option<String>,
    /// 已安装时间（unix 秒）。
    pub installed_at: Option<i64>,
}

/// manifest 的 wire 视图（camelCase 与前端 TS 类型对齐）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifestView {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub api_version: String,
    pub entry: String,
    pub permissions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<plugin::HttpScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<plugin::ShellScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui: Option<plugin::UiDecl>,
}

impl From<&PluginManifest> for PluginManifestView {
    fn from(m: &PluginManifest) -> Self {
        Self {
            id: m.id.clone(),
            name: m.name.clone(),
            version: m.version.clone(),
            description: m.description.clone(),
            api_version: m.api_version.clone(),
            entry: m.entry.clone(),
            permissions: m.permissions.clone(),
            http: m.http.clone(),
            shell: m.shell.clone(),
            ui: m.ui.clone(),
        }
    }
}

/// 从 config 实体取插件状态（不可变借用）。无实体 = 未安装态（默认值）。
fn state_of<'a>(
    cfg: &'a config::AppConfig,
    id: &str,
) -> Option<&'a config::PluginConfigEntry> {
    cfg.plugin_configs.iter().find(|p| p.id == id)
}

/// 合并磁盘扫描结果 + config 状态为完整视图列表。
fn build_views(cfg: &config::AppConfig, root: &Path) -> Vec<PluginView> {
    let scanned = plugin::scan_plugins(root);
    scanned
        .into_iter()
        .map(|sp| {
            let dir_str = sp.dir.display().to_string();
            let state = sp
                .manifest
                .as_ref()
                .ok()
                .and_then(|m| state_of(cfg, &m.id));
            match sp.manifest {
                Ok(manifest) => PluginView {
                    id: manifest.id.clone(),
                    dir: dir_str,
                    enabled: state.map(|s| s.enabled).unwrap_or(false),
                    granted_permissions: state
                        .map(|s| s.granted_permissions.clone())
                        .unwrap_or_default(),
                    declared_permissions: manifest.permissions.clone(),
                    known_permissions: plugin::KNOWN_PERMISSIONS
                        .iter()
                        .map(|s| s.to_string())
                        .collect(),
                    manifest: Some(PluginManifestView::from(&manifest)),
                    manifest_error: None,
                    installed_at: state.and_then(|s| s.installed_at),
                },
                Err(err) => PluginView {
                    // 损坏目录：id 无法从 manifest 得知——用目录名占位，前端显示校验失败。
                    id: sp
                        .dir
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_else(|| "unknown".into()),
                    dir: dir_str,
                    enabled: false,
                    granted_permissions: Vec::new(),
                    declared_permissions: Vec::new(),
                    known_permissions: plugin::KNOWN_PERMISSIONS
                        .iter()
                        .map(|s| s.to_string())
                        .collect(),
                    manifest: None,
                    manifest_error: Some(err),
                    installed_at: None,
                },
            }
        })
        .collect()
}

/// 列出已安装插件（磁盘扫描 + config 状态合并）。
#[tauri::command]
pub fn list_plugins(state: State<AppState>) -> Result<Vec<PluginView>, CommandError> {
    let (views, _) = {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let root = manager.plugins_dir().to_path_buf();
        let cfg = manager.get_config().clone();
        (build_views(&cfg, &root), root)
    };
    Ok(views)
}

/// 安装插件。`source_path` 可为插件**目录**（复制注册，源保留）或插件 **zip 包**
/// （内含 `<id>/…` 顶层插件目录；安全解压，zip slip 防护见 `extract_plugin_zip`）。
/// 已存在同 id → 版本比较：更高则覆盖（保留 data/），否则报错（评审 v2 D6）。
#[tauri::command]
pub fn install_plugin(source_path: String, state: State<AppState>) -> Result<String, CommandError> {
    let src = Path::new(&source_path);

    // --- 阶段 1：把源归一化为「插件目录」引用 ---
    // zip 源：解到系统临时目录（独立命名防冲突），定位顶层插件目录。
    // **guard 在 create_dir_all 成功后立即绑定**——extract_plugin_zip 及其后
    // 任何 `?` 失败路径（find_single_plugin_dir / manifest 校验）都经 RAII 清理，
    // 不泄漏 uuid 临时目录（advisory B：晚绑定会让解压失败泄漏）。
    // `_tmp_guard` 下划线前缀：赋值后不读（RAII drop 即清理），豁免 unused 告警。
    let mut _tmp_guard: Option<TempDirGuard> = None;
    let tmp_holder: Option<std::path::PathBuf> = if src.is_file()
        && src
            .extension()
            .map(|e| e.eq_ignore_ascii_case("zip"))
            .unwrap_or(false)
    {
        let tmp_root = std::env::temp_dir().join(format!(
            "hypercom_plugin_install_{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&tmp_root)
            .map_err(|e| CommandError::Io(format!("创建临时目录失败: {e}")))?;
        // 立即绑定 guard：目录一建好就纳入 RAII 清理范围。
        _tmp_guard = Some(TempDirGuard(tmp_root.clone()));
        plugin::extract_plugin_zip(src, &tmp_root)
            .map_err(|e| CommandError::Other(format!("解压插件 zip 失败: {e}")))?;
        Some(tmp_root)
    } else {
        None
    };

    // 源插件目录：zip 源 = 临时目录下唯一顶层插件目录；目录源 = 用户路径本身。
    let src_plugin_dir: std::path::PathBuf = if let Some(tmp) = &tmp_holder {
        find_single_plugin_dir(tmp)?
    } else {
        src.to_path_buf()
    };

    let manifest = plugin::load_manifest_from_dir(&src_plugin_dir)
        .map_err(|e| CommandError::Other(format!("插件目录校验失败: {e}")))?;

    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let root = manager.plugins_dir().to_path_buf();
    std::fs::create_dir_all(&root)
        .map_err(|e| CommandError::Io(format!("创建插件目录失败: {e}")))?;

    let dest = root.join(&manifest.id);

    // 已存在：允许覆盖仅当源版本更高；同版本/更低 → 报错（防意外回滚）。
    if dest.exists() {
        let existing = plugin::load_manifest_from_dir(&dest);
        match existing {
            Ok(existing_m) => {
                if !plugin::version_greater(&manifest.version, &existing_m.version) {
                    return Err(CommandError::Other(format!(
                        "插件 {} 已安装（版本 {}），覆盖需更高版本（源 {}）",
                        manifest.id, existing_m.version, manifest.version
                    )));
                }
            }
            Err(_) => {
                // 已存在但 manifest 损坏：视为可覆盖（修复安装）。
            }
        }
    }

    copy_dir_recursive(&src_plugin_dir, &dest)
        .map_err(|e| CommandError::Io(format!("复制插件目录失败: {e}")))?;

    // 记录/更新状态实体（保留既有 enabled/grantedPermissions——覆盖安装不清授权）。
    let cfg = manager.get_config_mut();
    let source_label = if tmp_holder.is_some() { "zip" } else { "dir" };
    if let Some(existing) = cfg.plugin_configs.iter_mut().find(|p| p.id == manifest.id) {
        existing.source = Some(source_label.into());
    } else {
        cfg.plugin_configs.push(config::PluginConfigEntry {
            id: manifest.id.clone(),
            enabled: false,
            granted_permissions: Vec::new(),
            installed_at: Some(now_unix_secs()),
            source: Some(source_label.into()),
        });
    }
    manager
        .save()
        .map_err(|e| CommandError::Config(format!("保存插件状态失败: {e}")))?;

    log::info!("Plugin installed: {} v{} -> {:?}", manifest.id, manifest.version, dest);
    Ok(manifest.id)
}

/// RAII：离开作用域即删除临时目录（zip 解压暂存区）。
struct TempDirGuard(std::path::PathBuf);
impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 在解压后的临时根里定位唯一插件目录（zip 含 `<id>/…` 顶层）。
/// 容错：允许根下直接是 manifest（无顶层包裹）或恰好一个子目录。
fn find_single_plugin_dir(root: &Path) -> Result<std::path::PathBuf, CommandError> {
    // 直接是插件目录？
    if root.join("manifest.json").is_file() {
        return Ok(root.to_path_buf());
    }
    // 恰好一个子目录（顶层包裹 `<id>/`）？
    let mut dirs = Vec::new();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                dirs.push(entry.path());
            }
        }
    }
    match dirs.len() {
        1 => Ok(dirs.remove(0)),
        0 => Err(CommandError::Other(
            "zip 内未找到插件目录（缺 manifest.json 顶层或子目录）".into(),
        )),
        _ => Err(CommandError::Other(
            "zip 内含多个顶层目录，无法确定插件根（应打包为单个 <id>/ 目录）".into(),
        )),
    }
}

/// 卸载插件：删除目录 + 移除 config 状态实体。
/// **仅限 `<plugins_dir>/<id>` 子树**——目录名即插件 id（反向域名），
/// 路径由 id 派生（不经用户任意路径），天然无穿越面。目录不存在视为已卸载（幂等）。
#[tauri::command]
pub fn uninstall_plugin(id: String, state: State<AppState>) -> Result<(), CommandError> {
    // id 格式白名单（与 manifest 校验一致：反向域名字符集）——防把任意串拼进路径。
    if !id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-' || c == '_')
    {
        return Err(CommandError::Other(format!("非法插件 id: {id}")));
    }

    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let root = manager.plugins_dir().to_path_buf();
    let dest = root.join(&id);

    // canonicalize 双保险：确认 dest 真实存在于 plugins 根内（防符号链接逃逸）。
    if dest.exists() {
        let canon_root = root
            .canonicalize()
            .map_err(|e| CommandError::Io(format!("插件根目录不可达: {e}")))?;
        let canon_dest = dest
            .canonicalize()
            .map_err(|e| CommandError::Io(format!("插件目录不可达: {e}")))?;
        if !canon_dest.starts_with(&canon_root) {
            return Err(CommandError::Other("插件目录越界，拒绝卸载".into()));
        }
        std::fs::remove_dir_all(&canon_dest)
            .map_err(|e| CommandError::Io(format!("删除插件目录失败: {e}")))?;
    }

    let cfg = manager.get_config_mut();
    cfg.plugin_configs.retain(|p| p.id != id);
    manager
        .save()
        .map_err(|e| CommandError::Config(format!("保存插件状态失败: {e}")))?;

    log::info!("Plugin uninstalled: {id}");
    Ok(())
}

/// 启用/禁用插件。
#[tauri::command]
pub fn set_plugin_enabled(id: String, enabled: bool, state: State<AppState>) -> Result<(), CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let cfg = manager.get_config_mut();
    let entry = cfg
        .plugin_configs
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| CommandError::Other(format!("插件未安装: {id}")))?;
    entry.enabled = enabled;
    manager
        .save()
        .map_err(|e| CommandError::Config(format!("保存插件状态失败: {e}")))?;
    log::info!("Plugin {} {}", id, if enabled { "enabled" } else { "disabled" });
    Ok(())
}

/// 设置插件授予权限（整体替换 granted_permissions）。
/// 权限是 manifest 声明的子集——超出声明部分拒绝（声明即上限，评审 v2 D3）。
/// 变更立即落盘，宿主桥侧「调用时校验」随 config 生效（撤销即时生效）。
#[tauri::command]
pub fn set_plugin_permissions(
    id: String,
    permissions: Vec<String>,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;

    // manifest 权威点：读取声明权限做子集校验。
    let root = manager.plugins_dir().to_path_buf();
    let manifest = plugin::load_manifest_from_dir(&root.join(&id))
        .map_err(|e| CommandError::Other(format!("插件 manifest 不可读: {e}")))?;
    let declared: std::collections::HashSet<String> =
        manifest.permissions.into_iter().collect();
    for p in &permissions {
        if !declared.contains(p) {
            return Err(CommandError::Other(format!(
                "权限 {p} 不在插件声明列表内，拒绝授予"
            )));
        }
    }

    let cfg = manager.get_config_mut();
    let entry = cfg
        .plugin_configs
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| CommandError::Other(format!("插件未安装: {id}")))?;
    entry.granted_permissions = permissions;
    manager
        .save()
        .map_err(|e| CommandError::Config(format!("保存插件状态失败: {e}")))?;
    log::info!("Plugin {id} permissions updated");
    Ok(())
}

/// 读取插件资产（`main.js` / `assets/` 内文件，供 worker 加载与资源读取）。
/// 路径经 `sanitize_plugin_rel_path` 前缀校验，canonicalize 后必须落在
/// `<plugins_dir>/<id>/` 内（评审 v2 D5 路径穿越防护）。
/// 返回 UTF-8 文本内容（插件代码/文本资产均为文本；二进制资产走后续增量）。
#[tauri::command]
pub fn read_plugin_asset(
    id: String,
    rel_path: String,
    state: State<AppState>,
) -> Result<String, CommandError> {
    let rel = plugin::sanitize_plugin_rel_path(&rel_path)
        .map_err(|e| CommandError::Other(format!("非法插件路径: {e}")))?;

    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let root = manager.plugins_dir().to_path_buf();
    let base = root.join(&id);
    let target = base.join(&rel);

    let canon_base = base
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("插件目录不可达: {e}")))?;
    let canon_target = target
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("资产文件不可读: {e}")))?;
    if !canon_target.starts_with(&canon_base) {
        return Err(CommandError::Other("资产路径越界，拒绝读取".into()));
    }
    if !canon_target.is_file() {
        return Err(CommandError::Io("资产不是文件".into()));
    }

    std::fs::read_to_string(&canon_target)
        .map_err(|e| CommandError::Io(format!("读取资产失败: {e}")))
}

/// 写入插件私有区（`data/` 子目录，storage 权限授予后）。
/// 限制：rel_path 首段必须为 `data`——`fs:storage` 权限只覆盖插件私有 KV 区，
/// 资产区（assets/ 与入口）对插件只读（评审 v2 D5）。
#[tauri::command]
pub fn write_plugin_asset(
    id: String,
    rel_path: String,
    content: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let rel = plugin::sanitize_plugin_rel_path(&rel_path)
        .map_err(|e| CommandError::Other(format!("非法插件路径: {e}")))?;
    let first = rel
        .components()
        .next()
        .and_then(|c| c.as_os_str().to_str())
        .unwrap_or("");
    if first != "data" {
        return Err(CommandError::Other(
            "插件写入仅限 data/ 私有区（fs:storage 权限范围）".into(),
        ));
    }

    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let root = manager.plugins_dir().to_path_buf();
    let base = root.join(&id);
    let target = base.join(&rel);

    let canon_base = base
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("插件目录不可达: {e}")))?;
    // target 可能尚不存在（首次写）——canonicalize 父链后逐级落，再校验前缀。
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| CommandError::Io(format!("创建目录失败: {e}")))?;
    }
    let canon_parent = target
        .parent()
        .ok_or_else(|| CommandError::Other("路径无父目录".into()))?
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("目录不可达: {e}")))?;
    if !canon_parent.starts_with(&canon_base) {
        return Err(CommandError::Other("写入路径越界，拒绝".into()));
    }

    std::fs::write(&target, content.as_bytes())
        .map_err(|e| CommandError::Io(format!("写入资产失败: {e}")))
}

// ==================== 辅助 ====================

fn now_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 递归复制目录（install_plugin 用）。复制而非移动：源目录保留，安装 = 注册副本。
fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &target)?;
        }
        // 符号链接不复制（防链接逃逸——插件目录内不允许链接资产）。
    }
    Ok(())
}

// ==================== 插件 HTTP 外联（评审 v2 D5/D8） ====================

/// 插件 HTTP 请求参数（wire 与前端 TS 对齐）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    /// 超时秒数（≤15，服务端钳制）。
    #[serde(default)]
    pub timeout: Option<u64>,
}

/// 插件 HTTP 响应。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHttpResponse {
    pub status: u16,
    /// 响应体 UTF-8 文本（截断到上限，防恶意大响应打爆内存）。
    pub body: String,
    /// 是否因超限截断。
    pub truncated: bool,
}

/// HTTP 响应体截断上限（1MB——插件外联是轻量 API 调用，非文件下载）。
const PLUGIN_HTTP_MAX_BODY: usize = 1024 * 1024;
/// 插件外联超时上限（对齐 update.rs 惯例）。
const PLUGIN_HTTP_MAX_TIMEOUT_SECS: u64 = 15;

/// 插件 HTTP 转发（唯一合法出站通道——生产 CSP `connect-src 'self'` 关死
/// worker 直连 fetch，评审 v2 D8）。
///
/// 安全（评审 v2 D5「无凭据注入」+ D3「权限调用时校验」）：
/// 1. 插件必须已授予 `http:request`（config 实体，调用时校验——撤销即时生效）；
/// 2. manifest `http.urlWhitelist` glob 必须匹配请求 URL（声明即白名单）；
/// 3. 不注入任何宿主凭据/Cookie（干净 reqwest client）；
/// 4. 超时钳制 ≤15s；响应体截断 1MB。
#[tauri::command]
pub async fn plugin_http(
    plugin_id: String,
    request: PluginHttpRequest,
    state: State<'_, AppState>,
) -> Result<PluginHttpResponse, CommandError> {
    // --- 权限 + 白名单校验（锁内只读，克隆后释放）---
    let (url_whitelist,) = {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let cfg = manager.get_config();
        let entry = cfg
            .plugin_configs
            .iter()
            .find(|p| p.id == plugin_id)
            .ok_or_else(|| CommandError::Other(format!("插件未安装: {plugin_id}")))?;
        if !entry.enabled {
            return Err(CommandError::Other(format!("插件未启用: {plugin_id}")));
        }
        if !entry
            .granted_permissions
            .iter()
            .any(|p| p == "http:request")
        {
            return Err(CommandError::Other(format!(
                "插件未授予 http:request 权限: {plugin_id}"
            )));
        }
        // manifest 白名单（声明即上限）。
        let root = manager.plugins_dir().to_path_buf();
        let manifest = crate::plugin::load_manifest_from_dir(&root.join(&plugin_id))
            .map_err(|e| CommandError::Other(format!("插件 manifest 不可读: {e}")))?;
        let whitelist = manifest
            .http
            .map(|h| h.url_whitelist)
            .unwrap_or_default();
        (whitelist,)
    };

    // URL glob 匹配：逐条 glob 匹配（`*` 单段 / `**` 跨段 / 其余字面量）。
    let parsed_url = url::Url::parse(&request.url)
        .map_err(|e| CommandError::Other(format!("非法 URL: {e}")))?;
    let matched = url_whitelist
        .iter()
        .any(|pat| url_glob_match(pat, &request.url));
    if !matched {
        return Err(CommandError::Other(format!(
            "URL 不在插件 http.urlWhitelist 内: {}",
            request.url
        )));
    }
    // 仅允许 http/https。
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err(CommandError::Other(format!(
            "仅允许 http/https 协议，收到: {}",
            parsed_url.scheme()
        )));
    }

    // --- 转发 ---
    let timeout = request.timeout.unwrap_or(10).min(PLUGIN_HTTP_MAX_TIMEOUT_SECS);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout))
        // 无凭据注入：不设 cookie store / **不继承任何代理**（`auto_sys_proxy`
        // 默认会连环境变量与注册表系统代理都吃进来——插件流量不得骑宿主代理，
        // 程序化强制隔离：环境变量 + 系统代理（Windows 注册表/macOS dynamic store）
        // 两路一并关死。插件无法访问宿主网络，需代理时由插件自行配置其代理）。
        // **禁止自动重定向**（评审 v2 D5 安全补强）：urlWhitelist 只校验初始 URL，
        // 白名单主机的开放重定向可把请求转发到任意内网目标——每个跳转都须由
        // 插件经 plugin_http 重新发起，逐跳过白名单闸门。
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| CommandError::Other(format!("http client init failed: {e}")))?;

    let method = reqwest::Method::from_bytes(request.method.as_bytes())
        .map_err(|e| CommandError::Other(format!("非法 HTTP 方法: {e}")))?;

    let mut builder = client.request(method, &request.url);
    for (k, v) in &request.headers {
        // 防 header 注入：拒绝换行字符（reqwest 会拒绝，这里前置报错更友好）。
        if k.contains(['\r', '\n']) || v.contains(['\r', '\n']) {
            return Err(CommandError::Other("HTTP header 含非法换行".into()));
        }
        builder = builder.header(k, v);
    }
    if let Some(body) = &request.body {
        builder = builder.body(body.clone());
    }

    let resp = builder
        .send()
        .await
        .map_err(|e| CommandError::Other(format!("HTTP 请求失败: {e}")))?;
    let status = resp.status().as_u16();

    // 响应体**流式**读 + 截断：chunk 逐段累积到上限即停——峰值内存 ≤ 上限 + 单
    // chunk（不整包载入，防恶意超大响应打爆内存；1MB 上限同时约束下载量与保留量）。
    let mut body_bytes: Vec<u8> = Vec::new();
    let mut truncated = false;
    {
        use futures_util::StreamExt;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| CommandError::Other(format!("读取响应失败: {e}")))?;
            let remaining = PLUGIN_HTTP_MAX_BODY.saturating_sub(body_bytes.len());
            if chunk.len() >= remaining {
                body_bytes.extend_from_slice(&chunk[..remaining]);
                truncated = true;
                break;
            }
            body_bytes.extend_from_slice(&chunk);
        }
    }

    let body = String::from_utf8_lossy(&body_bytes).into_owned();
    Ok(PluginHttpResponse {
        status,
        body,
        truncated,
    })
}

/// URL glob 匹配（评审 v2 D3 `http.urlWhitelist`）。
/// 规则（纯函数，独立测试）：
/// - `**` 跨 `/` 段匹配（贪婪）；
/// - `*` 匹配单段内任意字符（不含 `/`）；
/// - 其余字符字面量（大小写敏感——URL 的 scheme/host 惯例小写，保持字面比较）。
/// 实现：把 glob 转成正则。空白名单 → 恒 false（无匹配即拒绝）。
fn url_glob_match(pattern: &str, url: &str) -> bool {
    if pattern.is_empty() {
        return false;
    }
    let mut regex = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' => {
                // `**` → 跨段；`*` → 单段内。
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    regex.push_str(".*");
                    i += 2;
                } else {
                    regex.push_str("[^/]*");
                    i += 1;
                }
            }
            '?' => {
                regex.push_str("[^/]");
                i += 1;
            }
            // 正则元字符转义。
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\' => {
                regex.push('\\');
                regex.push(chars[i]);
                i += 1;
            }
            c => {
                regex.push(c);
                i += 1;
            }
        }
    }
    regex.push('$');
    // glob 转正则后匹配。预编译不划算（白名单短、低频），直接每次编译。
    match regex::Regex::new(&regex) {
        Ok(re) => re.is_match(url),
        Err(_) => false,
    }
}

// ==================== 插件 Shell（v1：openExternal + 白名单骨架） ====================

/// 插件打开外部 URL（经宿主 `shell:allow-open` 权限——capabilities 已有）。
/// 安全：仅 http/https/mailto 协议；不做任意协议跳转（防 file:// 读本地）。
/// openExternal 的 per-plugin URL 限制在实施时评估（评审 v2 §8）——v1 先做
/// 协议白名单（宿主既有 shell:allow-open 全局授权，协议限制是底线）。
#[tauri::command]
pub async fn plugin_open_external(
    url: String,
    app: tauri::AppHandle,
) -> Result<(), CommandError> {
    use tauri_plugin_shell::ShellExt;
    let parsed = url::Url::parse(&url)
        .map_err(|e| CommandError::Other(format!("非法 URL: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(CommandError::Other(format!(
            "openExternal 仅允许 http/https/mailto，收到: {}",
            parsed.scheme()
        )));
    }
    #[allow(deprecated)] // tauri-plugin-shell open 已 deprecated（官方建议 tauri-plugin-opener）；v1 沿用 shell 插件（capabilities 已有 shell:allow-open），opener 迁移在评审 §11 开放问题实施时评估
    app.shell()
        .open(url, None)
        .map_err(|e| CommandError::Other(format!("打开 URL 失败: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::url_glob_match;

    #[test]
    fn glob_matches_literal_prefix() {
        assert!(url_glob_match(
            "https://symbols.example.com/**",
            "https://symbols.example.com/v1/symbol"
        ));
        assert!(!url_glob_match(
            "https://symbols.example.com/**",
            "https://evil.example.com/v1/symbol"
        ));
    }

    #[test]
    fn glob_star_single_segment() {
        // `*` 不跨 `/`
        assert!(url_glob_match("https://a.com/*", "https://a.com/x"));
        assert!(!url_glob_match("https://a.com/*", "https://a.com/x/y"));
    }

    #[test]
    fn glob_double_star_crosses_segments() {
        assert!(url_glob_match("https://a.com/**", "https://a.com/x/y/z"));
        assert!(url_glob_match("https://a.com/api/**", "https://a.com/api/v1/users"));
        assert!(!url_glob_match("https://a.com/api/**", "https://a.com/other"));
    }

    #[test]
    fn glob_empty_or_bad_never_matches() {
        assert!(!url_glob_match("", "https://a.com/x"));
        // 正则元字符字面量：`(` 转义后字面匹配 `(x`
        assert!(url_glob_match("https://a.com/(x", "https://a.com/(x"));
        assert!(!url_glob_match("https://a.com/(x", "https://a.com/x"));
        assert!(url_glob_match("https://a.com/x", "https://a.com/x"));
    }

    #[test]
    fn glob_regex_metachars_literal() {
        // `+`、`.` 等应字面匹配
        assert!(url_glob_match("https://a.com/v1.2", "https://a.com/v1.2"));
        assert!(!url_glob_match("https://a.com/v1.2", "https://a.com/v1x2"));
    }
}
