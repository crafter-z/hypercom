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
    // TempDirGuard RAII 保证失败路径也清理临时目录。
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
        plugin::extract_plugin_zip(src, &tmp_root)
            .map_err(|e| CommandError::Other(format!("解压插件 zip 失败: {e}")))?;
        Some(tmp_root)
    } else {
        None
    };

    let _cleanup = tmp_holder.as_ref().map(|p| TempDirGuard(p.clone()));

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
