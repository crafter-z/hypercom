/**
 * 插件命令域（issue #17，第 12 个命令域）
 *
 * 职责：
 * - 插件状态 CRUD（enable/permissions/install/uninstall/list）——锁 config_manager
 *   读写 `AppConfig.entities.plugin_configs` 状态实体 + `crate::plugin` 纯函数层做磁盘
 *   扫描/manifest 校验/路径防护。
 * - 插件资产读写（`read_plugin_asset` / `write_plugin_asset`）——路径规范化 +
 *   前缀校验（评审 v2 D5：canonicalize 后必须落在 `<plugins_dir>/<id>/` 内）。
 *
 * 错误分类：IO 类（文件系统）→ `CommandError::Io`；manifest/校验类 →
 * `CommandError::Other`（带可读串）；config 持久化 → `CommandError::Config`；
 * 锁 → `CommandError::Lock`。前端收到的错误串即用户可读信息（含中文），
 * 与既有命令域一致（toast 直接展示）。
 *
 * zip 与目录安装都在 staging 中限制大小、验证路径；升级备份旧版直到状态保存成功。
 */
use std::path::Path;

use tauri::{Manager, State};

use super::CommandError;
use crate::config;
use crate::plugin::{self, PluginManifest};
use crate::AppState;

/// Private data quotas.  These bound both individual requests and accumulated
/// state so a plugin cannot turn the worker bridge into an unbounded file store.
const PLUGIN_DATA_MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const PLUGIN_DATA_MAX_TOTAL_BYTES: u64 = plugin::MAX_ZIP_UNCOMPRESSED_BYTES;
const PLUGIN_DATA_MAX_FILES: usize = 1024;

/// 单个插件的完整视图（前端设置页/宿主桥消费）。
/// manifest = 磁盘权威（每次 list 现扫）；state = config 实体状态。
/// manifest 损坏时（Err）仍列出该项，前端显示「校验失败」而非整体报错。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginView {
    pub id: String,
    pub dir: String,
    pub install_generation: String,
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
    pub requires: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<plugin::HttpScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<plugin::ShellScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial: Option<plugin::SerialScope>,
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
            requires: m.requires.clone(),
            http: m.http.clone(),
            shell: m.shell.clone(),
            serial: m.serial.clone(),
            ui: m.ui.clone(),
        }
    }
}

/// 从 config 实体取插件状态（不可变借用）。无实体 = 未安装态（默认值）。
fn state_of<'a>(
    cfg: &'a config::AppConfig,
    id: &str,
) -> Option<&'a config::PluginConfigEntry> {
    cfg.entities.plugin_configs.iter().find(|p| p.id == id)
}

/// 合并磁盘扫描结果 + config 状态为完整视图列表。
fn build_views_from_scan(cfg: &config::AppConfig, scanned: Vec<plugin::InstalledPlugin>) -> Vec<PluginView> {
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
                    install_generation: state.map(|s| s.install_generation.clone()).unwrap_or_default(),
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
                    install_generation: String::new(),
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

/// list_plugins 响应：UI 视图（磁盘扫描合并态）+ **权威插件状态数组**。
/// `plugin_configs` 是 config.json 第 9 类实体的原样返回——前端把它写回
/// store.config.pluginConfigs（issue #5-2 快照陷阱修复：以命令返回值为源，
/// 不经 view 再加工，目录缺失/manifest 损坏也不丢状态）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListResponse {
    pub revision: u64,
    pub plugins: Vec<PluginView>,
    pub plugin_configs: Vec<config::PluginConfigEntry>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStateSnapshot {
    pub revision: u64,
    pub plugin_configs: Vec<config::PluginConfigEntry>,
}

fn snapshot(manager: &config::ConfigManager) -> PluginStateSnapshot {
    let cfg = manager.get_config();
    PluginStateSnapshot { revision: cfg.revision, plugin_configs: cfg.entities.plugin_configs.clone() }
}

fn require_generation(cfg: &config::AppConfig, id: &str, expected: &str) -> Result<(), CommandError> {
    let entry = state_of(cfg, id).ok_or_else(|| CommandError::Other(format!("插件未安装: {id}")))?;
    if expected.is_empty() || entry.install_generation != expected {
        return Err(CommandError::Other("插件安装版本已变化，请重新检查插件后操作".into()));
    }
    Ok(())
}

/// 列出已安装插件（磁盘扫描视图 + config 状态数组）。
/// 扫描（read_dir + 逐目录 manifest 解析）在阻塞线程池执行——不占命令线程。
#[tauri::command]
pub async fn list_plugins(window: tauri::WebviewWindow, state: State<'_, AppState>) -> Result<PluginListResponse, CommandError> {
    require_main_window(&window)?;
    let _plugin_io = state.plugin_io.lock().await;
    let root = {
        let manager = state.config_manager.lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager.plugins_dir().to_path_buf()
    };
    let scanned = tokio::task::spawn_blocking(move || {
        plugin::scan_plugins(&root)
    })
        .await
        .map_err(|e| CommandError::Other(format!("插件扫描 join 失败: {e}")))?;
    // Scan may take seconds; never return a permission snapshot captured before it.
    let manager = state.config_manager.lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let cfg = manager.get_config();
    let plugins = build_views_from_scan(cfg, scanned);
    Ok(PluginListResponse { revision: cfg.revision, plugins, plugin_configs: cfg.entities.plugin_configs.clone() })
}

/// 安装插件。`source_path` 可为插件**目录**（复制注册，源保留）或插件 **zip 包**
/// （内含 `<id>/…` 顶层插件目录；安全解压，zip slip 防护见 `extract_plugin_zip`）。
/// 已存在同 id → 版本比较：更高则覆盖（**data/ 私有区保留**，其余旧文件不残留
/// ——staging 目录复制后原子换名，评审复审修复「覆盖安装孤儿文件」），
/// 否则报错（评审 v2 D6）。
/// 返回保存后的 revision + 全量 pluginConfigs 权威快照。
///
/// Preparation runs in spawn_blocking without touching installed files. After
/// preparation, a non-cancellable blocking section persists disabled/no-grants
/// state before the first rename while holding both transaction/config gates.
#[tauri::command]
pub async fn install_plugin(
    source_path: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginStateSnapshot, CommandError> {
    require_main_window(&window)?;
    let _plugin_io = state.plugin_io.lock().await;
    let root = state.config_manager.lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?
        .plugins_dir().to_path_buf();
    let prepared = tokio::task::spawn_blocking(move || prepare_plugin_install(&source_path, &root))
        .await.map_err(|e| CommandError::Other(format!("安装暂存 join 失败: {e}")))??;
    plugin::view_runtime::retire_plugin(window.app_handle(), &prepared.manifest.id).await?;
    // No await after persisting the trust reset: cancellation must not drop the
    // IO gate while a detached blocking task is still replacing executable code.
    tokio::task::block_in_place(|| {
        let mut manager = state.config_manager.lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        install_prepared(&mut manager, prepared)
    })
}

struct PreparedPluginInstall {
    manifest: PluginManifest,
    source_label: &'static str,
    dest: std::path::PathBuf,
    stage_guard: TempDirGuard,
}

fn reset_install_trust(cfg: &mut config::AppConfig, id: &str, source_label: &str) {
    if let Some(existing) = cfg.entities.plugin_configs.iter_mut().find(|p| p.id == id) {
        existing.enabled = false;
        existing.granted_permissions.clear();
        existing.install_generation = uuid::Uuid::new_v4().to_string();
        existing.installed_at = Some(now_unix_secs().max(existing.installed_at.unwrap_or(0).saturating_add(1)));
        existing.source = Some(source_label.into());
    } else {
        cfg.entities.plugin_configs.push(config::PluginConfigEntry {
            id: id.into(), enabled: false, granted_permissions: Vec::new(),
            install_generation: uuid::Uuid::new_v4().to_string(),
            installed_at: Some(now_unix_secs()), source: Some(source_label.into()),
        });
    }
}

fn restore_install_config(manager: &mut config::ConfigManager, old: config::AppConfig) -> Result<(), CommandError> {
    manager.set_config(old)
        .map_err(|e| CommandError::Config(format!("恢复插件状态失败，保持禁用: {e}")))
}

fn persist_install_trust_reset(manager: &mut config::ConfigManager) -> Result<(), CommandError> {
    manager.save().map_err(|e| CommandError::Config(format!("安装前清除插件授权失败: {e}")))?;
    manager.save_safe_backup().map_err(|e| CommandError::Config(format!("安装前更新禁用状态备份失败: {e}")))
}

fn install_prepared(manager: &mut config::ConfigManager, mut prepared: PreparedPluginInstall)
    -> Result<PluginStateSnapshot, CommandError> {
    let old = manager.get_config().clone();
    reset_install_trust(manager.get_config_mut(), &prepared.manifest.id, prepared.source_label);
    // The durable disabled/no-grants state precedes the first rename. Restart
    // after any later interruption therefore cannot trust either code version.
    if let Err(error) = persist_install_trust_reset(manager) {
        // No executable rename has happened yet, so old trust may safely be
        // restored. If restoration cannot persist, remain fail-closed.
        if manager.get_config().revision == old.revision {
            *manager.get_config_mut() = old;
        } else {
            restore_install_config(manager, old)?;
        }
        return Err(error);
    }
    if let Err(error) = commit_plugin_install(&mut prepared, manager.get_config().revision) {
        plugin::transaction::recover(manager.plugins_dir(), manager.get_config())
            .map_err(|e| CommandError::Io(format!("安装恢复失败，保留事务: {e}")))?;
        return Err(error);
    }
    plugin::transaction::recover(manager.plugins_dir(), manager.get_config())
        .map_err(|e| CommandError::Io(format!("安装清理失败，保留事务: {e}")))?;
    log::info!("Plugin installed: {} v{} ({})", prepared.manifest.id, prepared.manifest.version, prepared.source_label);
    Ok(snapshot(manager))
}


/// Fully validate/copy before changing either installed code or its trust state.
fn prepare_plugin_install(source_path: &str, root: &Path) -> Result<PreparedPluginInstall, CommandError> {
    let src = Path::new(source_path);

    // --- 阶段 1：把源归一化为「插件目录」引用 ---
    // zip 源：解到系统临时目录（独立命名防冲突），定位顶层插件目录。
    // **guard 在 create_dir_all 成功后立即绑定**——extract_plugin_zip 及其后
    // 任何 `?` 失败路径（find_single_plugin_dir / manifest 校验）都经 RAII 清理，
    // 不泄漏 uuid 临时目录（advisory B：晚绑定会让解压失败泄漏）。
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
    let source_label: &'static str = if tmp_holder.is_some() { "zip" } else { "dir" };

    std::fs::create_dir_all(root)
        .map_err(|e| CommandError::Io(format!("创建插件目录失败: {e}")))?;
    if tmp_holder.is_none() {
        let canonical_source = src_plugin_dir.canonicalize()
            .map_err(|e| CommandError::Io(format!("源插件目录不可达: {e}")))?;
        let canonical_root = root.canonicalize()
            .map_err(|e| CommandError::Io(format!("插件根目录不可达: {e}")))?;
        if canonical_root.starts_with(&canonical_source) {
            return Err(CommandError::Other("源插件目录不能包含插件安装根目录".into()));
        }
    }

    let dest = plugin_dir(root, &manifest.id)?;

    // 已存在：允许覆盖仅当源版本更高；同版本/更低 → 报错（防意外回滚）。
    if std::fs::symlink_metadata(&dest).is_ok() {
        let existing = plugin::load_manifest_from_dir(&dest);
        if let Ok(existing_m) = existing {
            if !plugin::version_greater(&manifest.version, &existing_m.version) {
                return Err(CommandError::Other(format!(
                    "插件 {} 已安装（版本 {}），覆盖需更高版本（源 {}）",
                    manifest.id, existing_m.version, manifest.version
                )));
            }
        }
        // 已存在但 manifest 损坏：视为可覆盖（修复安装）。
    }

    // Stage before changing the old install. Keep the whole old tree as a backup until
    // the new tree (including the old private data) has been committed.
    let staging = root.join(format!(".staging-{}", uuid::Uuid::new_v4()));
    let stage_guard = TempDirGuard(staging.clone());
    let mut budget = plugin::MAX_ZIP_UNCOMPRESSED_BYTES;
    copy_dir_recursive(&src_plugin_dir, &staging, &mut budget)
        .map_err(|e| CommandError::Io(format!("复制插件目录失败: {e}")))?;
    let staged_manifest = plugin::load_manifest_from_dir(&staging)
        .map_err(|e| CommandError::Other(format!("暂存 manifest 校验失败: {e}")))?;
    if staged_manifest != manifest {
        return Err(CommandError::Other("复制期间插件 manifest 已变化，拒绝安装".into()));
    }
    let entry_rel = sanitize_asset_path(&manifest.entry)?;
    let staged_entry = staging.join(&entry_rel);
    let staged_root = staging.canonicalize()
        .map_err(|e| CommandError::Io(format!("暂存目录不可达: {e}")))?;
    let staged_entry_canon = staged_entry.canonicalize()
        .map_err(|e| CommandError::Other(format!("manifest entry 不存在: {e}")))?;
    if !staged_entry_canon.starts_with(&staged_root)
        || !staged_entry_canon.is_file()
        || std::fs::symlink_metadata(&staged_entry).map(|m| m.file_type().is_symlink()).unwrap_or(true)
    {
        return Err(CommandError::Other("manifest entry 必须是暂存目录内的普通文件".into()));
    }
    if is_data_path(&entry_rel) {
        return Err(CommandError::Other("manifest entry 不得位于 data/ 私有区".into()));
    }
    // Private storage is exclusively owned by the user, even on first install.
    remove_path_if_exists(&staging.join("data"))
        .map_err(|e| CommandError::Io(format!("移除安装包 data/ 失败: {e}")))?;
    Ok(PreparedPluginInstall { manifest, source_label, dest, stage_guard })
}

fn commit_plugin_install(prepared: &mut PreparedPluginInstall, revision: u64)
    -> Result<(Option<std::path::PathBuf>, plugin::transaction::Transaction), CommandError> {
    let dest = prepared.dest.clone();
    let staging = prepared.stage_guard.0.clone();
    let root = dest.parent().unwrap();
    let mut transaction = plugin::transaction::Transaction::install(root, &prepared.manifest.id, &staging, revision)
        .map_err(|e| CommandError::Io(format!("持久化安装事务失败: {e}")))?;
    prepared.stage_guard.0.clear();
    let result = (|| -> std::io::Result<Option<std::path::PathBuf>> {
        let backup = transaction.backup(root);
        let old = dest.exists();
        if old {
            if let Ok(meta) = std::fs::symlink_metadata(dest.join("data")) {
                if !meta.is_dir() || meta.file_type().is_symlink() {
                    return Err(std::io::Error::other("旧版 data/ 不是普通目录"));
                }
            }
            transaction.phase(root, "backup")?;
            plugin::transaction::rename(root, &dest, &backup)?;
            if backup.join("data").exists() {
                transaction.phase(root, "private-data")?;
                plugin::transaction::rename(root, &backup.join("data"), &staging.join("data"))?;
            }
        }
        transaction.phase(root, "publish")?;
        plugin::transaction::rename(root, &staging, &dest)?;
        transaction.phase(root, "published")?;
        Ok(old.then_some(backup))
    })();
    Ok((result.map_err(|e| CommandError::Io(format!("安装事务失败: {e}")))?, transaction))
}

#[cfg(test)]
fn install_plugin_fs_stage(source_path: &str, root: &Path)
    -> Result<(String, String, &'static str, Option<std::path::PathBuf>), CommandError> {
    let mut prepared = prepare_plugin_install(source_path, root)?;
    let (backup, transaction) = commit_plugin_install(&mut prepared, 0)?;
    transaction.finish(root).map_err(|e| CommandError::Io(e.to_string()))?;
    Ok((prepared.manifest.id.clone(), prepared.manifest.version.clone(), prepared.source_label, backup))
}

/// RAII：离开作用域即删除临时目录（zip 解压暂存区）。
struct TempDirGuard(std::path::PathBuf);
impl Drop for TempDirGuard {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = std::fs::remove_dir_all(&self.0);
        }
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
/// 返回保存后的 revision + 全量 pluginConfigs；阻塞事务无取消换名窗口。
#[tauri::command]
pub async fn uninstall_plugin(
    id: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginStateSnapshot, CommandError> {
    require_main_window(&window)?;
    plugin::validate_plugin_id(&id).map_err(CommandError::Other)?;
    let _plugin_io = state.plugin_io.lock().await;
    plugin::view_runtime::retire_plugin(window.app_handle(), &id).await?;
    tokio::task::block_in_place(|| {
        let mut manager = state.config_manager.lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        uninstall_with_manager(&mut manager, &id)
    })
}

fn uninstall_with_manager(manager: &mut config::ConfigManager, id: &str) -> Result<PluginStateSnapshot, CommandError> {
    let root = manager.plugins_dir().to_path_buf();
    std::fs::create_dir_all(&root).map_err(|e| CommandError::Io(e.to_string()))?;
    let dest = plugin_dir(&root, id)?;
    let revision = manager.get_config().revision.checked_add(1)
        .ok_or_else(|| CommandError::Config("Config revision overflow".into()))?;
    let mut transaction = plugin::transaction::Transaction::uninstall(&root, id, revision)
        .map_err(|e| CommandError::Io(e.to_string()))?;
    let old_config = manager.get_config().clone();
    let result = (|| -> Result<(), CommandError> {
        transaction.phase(&root, "remove").map_err(|e| CommandError::Io(e.to_string()))?;
        if dest.exists() {
            plugin::transaction::rename(&root, &dest, &transaction.backup(&root))
                .map_err(|e| CommandError::Io(e.to_string()))?;
        }
        transaction.phase(&root, "config-commit").map_err(|e| CommandError::Io(e.to_string()))?;
        manager.get_config_mut().entities.plugin_configs.retain(|entry| entry.id != id);
        if let Err(error) = manager.save() {
            *manager.get_config_mut() = old_config;
            return Err(CommandError::Config(error.to_string()));
        }
        manager.save_safe_backup().map_err(|e| CommandError::Config(e.to_string()))?;
        Ok(())
    })();
    if result.is_err() && manager.get_config().revision >= revision {
        // Config commit succeeded but the safe fallback did not. Preserve the
        // private backup and journal until startup can sync the fallback.
        return result.map(|_| snapshot(manager));
    }
    plugin::transaction::recover(&root, manager.get_config())
        .map_err(|e| CommandError::Io(format!("卸载恢复失败，保留事务: {e}")))?;
    result?;
    Ok(snapshot(manager))
}

/// 启用/禁用插件。expectedGeneration 必须匹配，返回保存后的权威快照。
#[tauri::command]
pub async fn set_plugin_enabled(
    id: String,
    enabled: bool,
    expected_generation: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginStateSnapshot, CommandError> {
    require_main_window(&window)?;
    plugin::validate_plugin_id(&id).map_err(CommandError::Other)?;
    let _plugin_io = state.plugin_io.lock().await;
    {
        let manager = state.config_manager.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
        require_generation(manager.get_config(), &id, &expected_generation)?;
    }
    if !enabled { plugin::view_runtime::retire_plugin(window.app_handle(), &id).await?; }
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    require_generation(manager.get_config(), &id, &expected_generation)?;
    if enabled {
        let manifest = plugin::load_manifest_from_dir(&plugin_dir(manager.plugins_dir(), &id)?)
            .map_err(|e| CommandError::Other(format!("插件 manifest 不可读: {e}")))?;
        if manifest.id != id {
            return Err(CommandError::Other("manifest id 与插件目录不一致".into()));
        }
    }
    let old_config = manager.get_config().clone();
    let cfg = manager.get_config_mut();
    let entry = cfg.entities.plugin_configs
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| CommandError::Other(format!("插件未安装: {id}")))?;
    entry.enabled = enabled;
    if let Err(e) = manager.save() {
        *manager.get_config_mut() = old_config;
        return Err(CommandError::Config(format!("保存插件状态失败: {e}")));
    }
    log::info!("Plugin {} {}", id, if enabled { "enabled" } else { "disabled" });
    Ok(snapshot(&manager))
}

/// 设置插件授予权限（整体替换 granted_permissions）。
/// 权限是 manifest 声明的子集——超出声明部分拒绝（声明即上限，评审 v2 D3）。
/// 变更立即落盘，宿主桥侧「调用时校验」随 config 生效（撤销即时生效）。
/// expectedGeneration 必须匹配（包括撤销请求），返回保存后的权威快照。
#[tauri::command]
pub async fn set_plugin_permissions(
    id: String,
    permissions: Vec<String>,
    expected_generation: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginStateSnapshot, CommandError> {
    require_main_window(&window)?;
    plugin::validate_plugin_id(&id).map_err(CommandError::Other)?;
    let _plugin_io = state.plugin_io.lock().await;
    {
        let manager = state.config_manager.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
        require_generation(manager.get_config(), &id, &expected_generation)?;
    }
    plugin::view_runtime::retire_denied(window.app_handle(), &id, &permissions).await?;
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    require_generation(manager.get_config(), &id, &expected_generation)?;

    // manifest 权威点：读取声明权限做子集校验。
    let root = manager.plugins_dir().to_path_buf();
    let manifest = plugin::load_manifest_from_dir(&plugin_dir(&root, &id)?)
        .map_err(|e| CommandError::Other(format!("插件 manifest 不可读: {e}")))?;
    if manifest.id != id {
        return Err(CommandError::Other("manifest id 与插件目录不一致".into()));
    }
    let declared: std::collections::HashSet<String> =
        manifest.permissions.into_iter().collect();
    for p in &permissions {
        if !declared.contains(p) {
            return Err(CommandError::Other(format!(
                "权限 {p} 不在插件声明列表内，拒绝授予"
            )));
        }
        if !plugin::KNOWN_PERMISSIONS.contains(&p.as_str()) {
            return Err(CommandError::Other(format!("宿主尚未实现权限 {p}，拒绝授予")));
        }
    }

    let old_config = manager.get_config().clone();
    let cfg = manager.get_config_mut();
    let entry = cfg.entities.plugin_configs
        .iter_mut()
        .find(|p| p.id == id)
        .ok_or_else(|| CommandError::Other(format!("插件未安装: {id}")))?;
    entry.granted_permissions = permissions;
    if let Err(e) = manager.save() {
        *manager.get_config_mut() = old_config;
        return Err(CommandError::Config(format!("保存插件状态失败: {e}")));
    }
    log::info!("Plugin {id} permissions updated");
    Ok(snapshot(&manager))
}

/// 读取插件资产（`main.js` / `assets/` 内文件，供 worker 加载与资源读取）。
/// 路径经 `sanitize_plugin_rel_path` 前缀校验，canonicalize 后必须落在
/// `<plugins_dir>/<id>/` 内（评审 v2 D5 路径穿越防护）。
/// 返回 UTF-8 文本内容（插件代码/文本资产均为文本；二进制资产走后续增量）。
/// FIFO admission avoids failing valid simultaneous startup/KV reads. The wait is
/// bounded; timed-out requests leave the queue and cannot build an infinite backlog.
async fn lock_asset_io(gate: &tokio::sync::Mutex<()>) -> Result<tokio::sync::MutexGuard<'_, ()>, CommandError> {
    tokio::time::timeout(std::time::Duration::from_secs(2), gate.lock()).await
        .map_err(|_| CommandError::Other("插件磁盘操作等待超时，请稍后重试".into()))
}

#[tauri::command]
pub async fn read_plugin_asset(
    id: String,
    rel_path: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    require_main_window(&window)?;
    plugin::validate_plugin_id(&id).map_err(CommandError::Other)?;
    let _plugin_io = lock_asset_io(&state.plugin_io).await?;
    let rel = sanitize_asset_path(&rel_path)?;
    let root = {
        let manager = state.config_manager.lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let root = manager.plugins_dir().to_path_buf();
        let manifest = plugin::load_manifest_from_dir(&plugin_dir(&root, &id)?)
            .map_err(|e| CommandError::Other(format!("插件 manifest 不可读: {e}")))?;
        if manifest.id != id {
            return Err(CommandError::Other("manifest id 与插件目录不一致".into()));
        }
        let entry = manager.get_config().entities.plugin_configs.iter()
            .find(|p| p.id == id)
            .ok_or_else(|| CommandError::Other(format!("插件未安装: {id}")))?;
        if !entry.enabled {
            return Err(CommandError::Other(format!("插件未启用: {id}")));
        }
        let in_data = is_data_path(&rel);
        let boot_file = rel == Path::new("manifest.json")
            || rel == plugin::sanitize_plugin_rel_path(&manifest.entry).map_err(CommandError::Other)?;
        let permission = if in_data { "fs:storage" } else { "fs:assets" };
        let kv_allowed = rel == Path::new("data/state.json")
            && entry.granted_permissions.iter().any(|p| p == "storage")
            && manifest.permissions.iter().any(|p| p == "storage");
        if !(boot_file && !in_data) && !kv_allowed && (!entry.granted_permissions.iter().any(|p| p == permission)
            || !manifest.permissions.iter().any(|p| p == permission)) {
            return Err(CommandError::Other(format!("插件未授予 {permission}: {id}")));
        }
        root
    };
    tokio::task::block_in_place(move || {
        let base = plugin_dir(&root, &id)?;
        read_authorized_asset(&base, &rel)
    })
}

/// 写入插件私有区（`data/` 子目录，storage 权限授予后）。
/// 限制：rel_path 首段必须为 `data`——`fs:storage` 权限只覆盖插件私有 KV 区，
/// 资产区（assets/ 与入口）对插件只读（评审 v2 D5）。
#[tauri::command]
pub async fn write_plugin_asset(
    id: String,
    rel_path: String,
    content: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    plugin::validate_plugin_id(&id).map_err(CommandError::Other)?;
    if content.len() as u64 > PLUGIN_DATA_MAX_FILE_BYTES {
        return Err(CommandError::Other("插件 data 单文件超过 16 MiB 上限".into()));
    }
    let _plugin_io = lock_asset_io(&state.plugin_io).await?;
    let rel = sanitize_asset_path(&rel_path)?;
    let first = rel.components().next().and_then(|c| c.as_os_str().to_str()).unwrap_or("");
    if first != "data" {
        return Err(CommandError::Other("插件写入仅限 data/ 私有区（fs:storage 权限范围）".into()));
    }
    let root = {
        let manager = state.config_manager.lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let root = manager.plugins_dir().to_path_buf();
        let manifest = plugin::load_manifest_from_dir(&plugin_dir(&root, &id)?)
            .map_err(|e| CommandError::Other(format!("插件 manifest 不可读: {e}")))?;
        let entry = manager.get_config().entities.plugin_configs.iter()
            .find(|p| p.id == id)
            .ok_or_else(|| CommandError::Other(format!("插件未安装: {id}")))?;
        let storage_allowed = entry.granted_permissions.iter().any(|p| p == "fs:storage")
            && manifest.permissions.iter().any(|p| p == "fs:storage");
        let kv_allowed = rel == Path::new("data/state.json")
            && entry.granted_permissions.iter().any(|p| p == "storage")
            && manifest.permissions.iter().any(|p| p == "storage");
        if manifest.id != id || !entry.enabled || !(storage_allowed || kv_allowed) {
            return Err(CommandError::Other(format!("插件未启用或未授予存储权限: {id}")));
        }
        root
    };
    tokio::task::block_in_place(move || {
        let base = plugin_dir(&root, &id)?;
        let target = base.join(&rel);
        check_data_write_quota(&base.join("data"), &target, content.len() as u64)?;

        let canon_base = base
            .canonicalize()
            .map_err(|e| CommandError::Io(format!("插件目录不可达: {e}")))?;
        // Check each existing parent before creating the next component.
        let mut parent = base.clone();
        for component in rel.parent().unwrap().components() {
            parent.push(component);
            match std::fs::symlink_metadata(&parent) {
                Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {}
                Ok(_) => return Err(CommandError::Other("写入目录含符号链接或非目录".into())),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    std::fs::create_dir(&parent)
                        .map_err(|e| CommandError::Io(format!("创建目录失败: {e}")))?;
                }
                Err(e) => return Err(CommandError::Io(format!("目录不可达: {e}"))),
            }
        }
        let canon_parent = parent.canonicalize()
            .map_err(|e| CommandError::Io(format!("目录不可达: {e}")))?;
        if !canon_parent.starts_with(&canon_base) {
            return Err(CommandError::Other("写入路径越界，拒绝".into()));
        }
        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {}
            Ok(_) => return Err(CommandError::Other("写入目标不是普通文件".into())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(CommandError::Io(format!("写入目标不可达: {e}"))),
        }
        atomic_write_asset(&canon_parent, &target, content.as_bytes())
            .map_err(|e| CommandError::Io(format!("写入资产失败: {e}")))
    })
}

fn is_data_path(rel: &Path) -> bool {
    rel.components().next().and_then(|c| c.as_os_str().to_str())
        .map(|first| first.eq_ignore_ascii_case("data")).unwrap_or(false)
}

fn sanitize_asset_path(raw: &str) -> Result<std::path::PathBuf, CommandError> {
    let rel = plugin::sanitize_plugin_rel_path(raw).map_err(CommandError::Other)?;
    // Reject Win32 trailing-dot/space and ADS aliases on every platform. Normalize
    // data's case so DATA/state.json cannot be classified as a public asset.
    let mut out = std::path::PathBuf::new();
    for (index, component) in rel.components().enumerate() {
        let name = component.as_os_str().to_str()
            .ok_or_else(|| CommandError::Other("插件路径必须是 UTF-8".into()))?;
        if name.ends_with(['.', ' ']) || name.contains(':') || (index == 0 && name.contains('~')) {
            return Err(CommandError::Other("插件路径含 Windows 路径别名".into()));
        }
        out.push(if index == 0 && name.eq_ignore_ascii_case("data") { "data" } else { name });
    }
    if out.components().count() > plugin::MAX_PLUGIN_SOURCE_DEPTH {
        return Err(CommandError::Other("插件资产路径深度超过上限".into()));
    }
    Ok(out)
}

/// Called only after authorization and the non-queued IO gate have succeeded.
fn read_authorized_asset(base: &Path, rel: &Path) -> Result<Option<String>, CommandError> {
    let canon_base = base.canonicalize().map_err(|e| CommandError::Io(format!("插件目录不可达: {e}")))?;
    if is_data_path(rel) { check_data_write_quota(&base.join("data"), &base.join(rel), 0)?; }
    let mut current = base.to_path_buf();
    let count = rel.components().count();
    for (index, component) in rel.components().enumerate() {
        current.push(component);
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(CommandError::Io(format!("资产不可达: {e}"))),
        };
        if metadata.file_type().is_symlink()
            || (index + 1 < count && !metadata.is_dir())
            || (index + 1 == count && !metadata.is_file()) {
            return Err(CommandError::Other("资产路径含链接或非常规文件".into()));
        }
    }
    let target = current.canonicalize().map_err(|e| CommandError::Io(format!("资产不可达: {e}")))?;
    if !target.starts_with(canon_base) { return Err(CommandError::Other("资产路径越界".into())); }
    let limit = if is_data_path(rel) { PLUGIN_DATA_MAX_FILE_BYTES } else { plugin::MAX_ZIP_UNCOMPRESSED_BYTES };
    read_asset_limited(&target, limit).map(Some)
}

fn read_asset_limited(path: &Path, limit: u64) -> Result<String, CommandError> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| CommandError::Io(format!("读取资产失败: {e}")))?;
    let meta = file.metadata().map_err(|e| CommandError::Io(e.to_string()))?;
    if !meta.is_file() || meta.len() > limit {
        return Err(CommandError::Other("插件资产读取超过大小上限或不是普通文件".into()));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(limit + 1).read_to_end(&mut bytes).map_err(|e| CommandError::Io(e.to_string()))?;
    if bytes.len() as u64 > limit {
        return Err(CommandError::Other("插件资产读取超过大小上限".into()));
    }
    String::from_utf8(bytes).map_err(|e| CommandError::Io(format!("资产不是 UTF-8: {e}")))
}

fn check_data_write_quota(data: &Path, target: &Path, size: u64) -> Result<(), CommandError> {
    fn scan(path: &Path, depth: usize, entries: &mut usize, files: &mut usize, bytes: &mut u64) -> Result<(), CommandError> {
        if depth > plugin::MAX_PLUGIN_SOURCE_DEPTH {
            return Err(CommandError::Other("插件 data 深度超过上限".into()));
        }
        for entry in std::fs::read_dir(path).map_err(|e| CommandError::Io(e.to_string()))? {
            *entries += 1;
            if *entries > plugin::MAX_ZIP_ENTRIES {
                return Err(CommandError::Other("插件 data 条目数超过上限".into()));
            }
            let entry = entry.map_err(|e| CommandError::Io(e.to_string()))?;
            let meta = std::fs::symlink_metadata(entry.path()).map_err(|e| CommandError::Io(e.to_string()))?;
            if meta.file_type().is_symlink() || !(meta.is_file() || meta.is_dir()) {
                return Err(CommandError::Other("插件 data 含链接或非常规文件".into()));
            }
            if meta.is_dir() {
                scan(&entry.path(), depth + 1, entries, files, bytes)?;
            } else {
                if meta.len() > PLUGIN_DATA_MAX_FILE_BYTES {
                    return Err(CommandError::Other("插件 data 单文件超过上限".into()));
                }
                *files += 1;
                *bytes = bytes.saturating_add(meta.len());
                if *files > PLUGIN_DATA_MAX_FILES || *bytes > PLUGIN_DATA_MAX_TOTAL_BYTES {
                    return Err(CommandError::Other("插件 data 文件数或总量超过上限".into()));
                }
            }
        }
        Ok(())
    }
    if size > PLUGIN_DATA_MAX_FILE_BYTES {
        return Err(CommandError::Other("插件 data 单文件超过上限".into()));
    }
    let (mut entries, mut files, mut bytes) = (0, 0, 0u64);
    match std::fs::symlink_metadata(data) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => scan(data, 0, &mut entries, &mut files, &mut bytes)?,
        Ok(_) => return Err(CommandError::Other("插件 data 不是普通目录".into())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
        Err(e) => return Err(CommandError::Io(e.to_string())),
    }
    let relative = target.strip_prefix(data)
        .map_err(|_| CommandError::Other("写入目标不在 data/ 内".into()))?;
    if relative.components().count() > plugin::MAX_PLUGIN_SOURCE_DEPTH {
        return Err(CommandError::Other("插件 data 深度超过上限".into()));
    }
    let mut missing_parents = 0usize;
    let mut parent = data.to_path_buf();
    for component in relative.parent().unwrap_or_else(|| Path::new("")).components() {
        parent.push(component);
        match std::fs::symlink_metadata(&parent) {
            Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {},
            Ok(_) => return Err(CommandError::Other("写入目录含链接或非目录".into())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => missing_parents += 1,
            Err(e) => return Err(CommandError::Io(e.to_string())),
        }
    }
    let old_size = match std::fs::symlink_metadata(target) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => Some(meta.len()),
        Ok(_) => return Err(CommandError::Other("写入目标不是普通文件".into())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(CommandError::Io(e.to_string())),
    };
    if entries + missing_parents + usize::from(old_size.is_none()) > plugin::MAX_ZIP_ENTRIES
        || files + usize::from(old_size.is_none()) > PLUGIN_DATA_MAX_FILES
        || bytes.saturating_sub(old_size.unwrap_or(0)).saturating_add(size) > PLUGIN_DATA_MAX_TOTAL_BYTES {
        return Err(CommandError::Other("插件 data 文件数或总量超过上限".into()));
    }
    Ok(())
}

fn atomic_write_asset(parent: &Path, target: &Path, content: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let temporary = parent.join(format!(".write-{}", uuid::Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
    let result = (|| {
        file.write_all(content)?;
        file.sync_all()?;
        drop(file);
        plugin::transaction::replace_file(&temporary, target)?;
        plugin::transaction::sync_dir(parent)
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result
}

fn require_main_window(window: &tauri::WebviewWindow) -> Result<(), CommandError> {
    if window.label() != "main" {
        return Err(CommandError::Other("插件命令仅允许主窗口调用".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn create_plugin_view(source: tauri::Webview, state: State<'_, AppState>, binding: plugin::view_runtime::Binding) -> Result<(), CommandError> {
    plugin::view_runtime::create(source, &state, binding).await
}

#[tauri::command]
pub async fn update_plugin_view(source: tauri::Webview, instance_id: String, rect: plugin::view_runtime::Rect, visible: bool, layout_revision: u64) -> Result<(), CommandError> {
    plugin::view_runtime::update(source, instance_id, rect, visible, layout_revision).await
}

#[tauri::command]
pub async fn send_plugin_view_message(source: tauri::Webview, instance_id: String, message: serde_json::Value) -> Result<(), CommandError> {
    plugin::view_runtime::send(source, instance_id, message).await
}

#[tauri::command]
pub async fn destroy_plugin_view(source: tauri::Webview, instance_id: String) -> Result<(), CommandError> {
    plugin::view_runtime::destroy(source, instance_id).await
}

// ==================== 辅助 ====================

fn now_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn plugin_dir(root: &Path, id: &str) -> Result<std::path::PathBuf, CommandError> {
    plugin::validate_plugin_id(id).map_err(CommandError::Other)?;
    let dest = root.join(id);
    match std::fs::symlink_metadata(&dest) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() =>
            return Err(CommandError::Other(format!("插件目录不是普通目录: {id}"))),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(CommandError::Io(format!("插件目录不可达: {e}"))),
    }
    Ok(dest)
}

#[cfg(test)]
fn stage_uninstall_fs(root: &Path, id: &str) -> Result<(std::path::PathBuf, Option<std::path::PathBuf>), CommandError> {
    let dest = plugin_dir(root, id)?;
    if !dest.exists() { return Ok((dest, None)); }
    let transaction = plugin::transaction::Transaction::uninstall(root, id, 1)
        .map_err(|e| CommandError::Io(e.to_string()))?;
    let backup = transaction.backup(root);
    plugin::transaction::rename(root, &dest, &backup).map_err(|e| CommandError::Io(e.to_string()))?;
    transaction.finish(root).map_err(|e| CommandError::Io(e.to_string()))?;
    Ok((dest, Some(backup)))
}

fn remove_path_if_exists(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}


/// Directory sources obey the same cumulative uncompressed limit as zip sources.
fn copy_dir_recursive(src: &Path, dest: &Path, budget: &mut u64) -> std::io::Result<()> {
    let mut entries = 0usize;
    copy_dir_recursive_inner(src, dest, budget, 0, &mut entries)
}

fn copy_dir_recursive_inner(src: &Path, dest: &Path, budget: &mut u64, depth: usize, entries: &mut usize) -> std::io::Result<()> {
    if depth > plugin::MAX_PLUGIN_SOURCE_DEPTH {
        return Err(std::io::Error::other("插件目录递归深度超过上限"));
    }
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        *entries = (*entries).saturating_add(1);
        if *entries > plugin::MAX_ZIP_ENTRIES {
            return Err(std::io::Error::other("插件目录条目数超过上限"));
        }
        let entry = entry?;
        let file_type = entry.file_type()?;
        if depth + 1 > plugin::MAX_PLUGIN_SOURCE_DEPTH {
            return Err(std::io::Error::other("插件目录递归深度超过上限"));
        }
        let target = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive_inner(&entry.path(), &target, budget, depth + 1, entries)?;
        } else if file_type.is_file() {
            let mut input = std::fs::File::open(entry.path())?;
            let mut output = std::fs::File::create(target)?;
            let written = std::io::copy(&mut std::io::Read::take(&mut input, *budget + 1), &mut output)?;
            if written > *budget {
                return Err(std::io::Error::other("插件目录超过 64 MiB 大小上限"));
            }
            *budget -= written;
        }
        // Do not follow source symlinks.
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
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginHttpResponse, CommandError> {
    require_main_window(&window)?;
    plugin::validate_plugin_id(&plugin_id).map_err(CommandError::Other)?;
    // --- 权限 + 白名单校验（锁内只读，克隆后释放）---
    let (url_whitelist, plugin_proxy, plugin_proxy_enabled) = {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let cfg = manager.get_config();
        let entry = cfg.entities.plugin_configs
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
        let manifest = crate::plugin::load_manifest_from_dir(&plugin_dir(&root, &plugin_id)?)
            .map_err(|e| CommandError::Other(format!("插件 manifest 不可读: {e}")))?;
        if manifest.id != plugin_id || !manifest.permissions.iter().any(|p| p == "http:request") {
            return Err(CommandError::Other(format!("插件未声明 http:request: {plugin_id}")));
        }
        let whitelist = manifest.http.map(|h| h.url_whitelist).unwrap_or_default();
        (whitelist, cfg.plugin_proxy.clone(), cfg.plugin_proxy_enabled)
    };

    // URL glob 匹配：逐条 glob 匹配（`*` 单段 / `**` 跨段 / 其余字面量）。
    // 匹配对象是 **Url::parse 规范化后的序列化串**（as_str：host 小写、path
    // 归一、默认端口剥离、`..\` 解析消除）而非插件原始串——大小写/尾点/
    // 相对段等畸形写法不再造成误拒，也不给「原始串匹配但实际解析到别处」
    // 留语义缝隙（评审复审：原实现对 request.url 原始串匹配）。
    let parsed_url = url::Url::parse(&request.url)
        .map_err(|e| CommandError::Other(format!("非法 URL: {e}")))?;
    let normalized_url = parsed_url.as_str();
    let matched = url_whitelist
        .iter()
        .any(|pat| url_glob_match(pat, normalized_url));
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
    let mut client_builder = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout))
        // **禁止自动重定向**（评审 v2 D5 安全补强）：urlWhitelist 只校验初始 URL，
        // 白名单主机的开放重定向可把请求转发到任意内网目标——每个跳转都须由
        // 插件经 plugin_http 重新发起，逐跳过白名单闸门。
        .redirect(reqwest::redirect::Policy::none());
    // 代理（issue #17）：`plugin_http` 默认强制直连——不继承宿主代理/系统代理
    // （评审 v2 D5「无凭据注入/干净 client」：`auto_sys_proxy` 默认会把环境变量
    // 与注册表系统代理一并吃进插件 client，骑宿主代理即透传宿主代理凭据）。
    // 宿主可经 config 显式给插件配置出站代理（plugin_proxy_enabled + plugin_proxy），
    // 该代理由宿主声明、仅对插件出站生效，与宿主自身代理互不相干。
    // 此处 `.proxy()`/`.no_proxy()` 二选一——两者互斥（proxy 设 auto_sys_proxy=false）。
    if plugin_proxy_enabled && !plugin_proxy.is_empty() {
        let proxy = reqwest::Proxy::all(&plugin_proxy)
            .map_err(|e| CommandError::Other(format!("invalid plugin proxy: {e}")))?;
        client_builder = client_builder.proxy(proxy);
    } else {
        client_builder = client_builder.no_proxy();
    }
    let client = client_builder
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

    // Keep at most the limit. At exactly the limit continue to EOF or the next
    // non-empty chunk; only observing an extra byte proves truncation.
    let mut body_bytes: Vec<u8> = Vec::new();
    let mut truncated = false;
    {
        use futures_util::StreamExt;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| CommandError::Other(format!("读取响应失败: {e}")))?;
            if append_http_chunk(&mut body_bytes, &chunk, PLUGIN_HTTP_MAX_BODY) {
                truncated = true;
                break;
            }
        }
    }

    let body = String::from_utf8_lossy(&body_bytes).into_owned();
    Ok(PluginHttpResponse {
        status,
        body,
        truncated,
    })
}

/// Return true only when bytes beyond the retained limit were observed.
fn append_http_chunk(body: &mut Vec<u8>, chunk: &[u8], limit: usize) -> bool {
    let remaining = limit.saturating_sub(body.len());
    body.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
    chunk.len() > remaining
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
            // 正则元字符转义。
            '?' | '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\' => {
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

/// 插件打开外部 URL；调用时检查插件启用、shell:open 授权及 manifest 声明。
/// 仅 http/https/mailto 协议（防 file:// 读本地）。
#[tauri::command]
pub async fn plugin_open_external(
    plugin_id: String,
    url: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), CommandError> {
    use tauri_plugin_shell::ShellExt;
    require_main_window(&window)?;
    plugin::validate_plugin_id(&plugin_id).map_err(CommandError::Other)?;
    {
        let manager = state.config_manager.lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let entry = manager.get_config().entities.plugin_configs.iter()
            .find(|p| p.id == plugin_id)
            .ok_or_else(|| CommandError::Other(format!("插件未安装: {plugin_id}")))?;
        if !entry.enabled || !entry.granted_permissions.iter().any(|p| p == "shell:open") {
            return Err(CommandError::Other(format!("插件未启用或未授予 shell:open: {plugin_id}")));
        }
        let manifest = plugin::load_manifest_from_dir(&plugin_dir(manager.plugins_dir(), &plugin_id)?)
            .map_err(|e| CommandError::Other(format!("插件 manifest 不可读: {e}")))?;
        if manifest.id != plugin_id || !manifest.permissions.iter().any(|p| p == "shell:open") {
            return Err(CommandError::Other(format!("插件未声明 shell:open: {plugin_id}")));
        }
    }
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
    use super::*;
    use std::fs;
    use std::future::Future;

    fn manifest(version: &str) -> String {
        format!(r#"{{"id":"com.example.test","name":"Test","version":"{version}","apiVersion":"1.0","entry":"main.js","permissions":[]}}"#)
    }

    fn source(root: &Path, version: &str) -> std::path::PathBuf {
        let src = root.join(format!("source-{version}"));
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("manifest.json"), manifest(version)).unwrap();
        fs::write(src.join("main.js"), version).unwrap();
        src
    }

    fn trusted_manager(root: &Path) -> config::ConfigManager {
        let mut manager = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
        manager.get_config_mut().entities.plugin_configs.push(config::PluginConfigEntry {
            id: "com.example.test".into(), enabled: true,
            install_generation: "old-generation".into(),
            granted_permissions: vec!["fs:storage".into()], installed_at: Some(1), source: Some("dir".into()),
        });
        manager.save().unwrap();
        manager
    }

    #[test]
    fn upgrade_crash_after_code_swap_reloads_without_trust() {
        let root = std::env::temp_dir().join(format!("plugin_crash_{}", uuid::Uuid::new_v4()));
        let old_source = source(&root, "1.0.0");
        let new_source = source(&root, "2.0.0");
        let mut manager = trusted_manager(&root);
        install_plugin_fs_stage(old_source.to_str().unwrap(), manager.plugins_dir()).unwrap();
        let mut prepared = prepare_plugin_install(new_source.to_str().unwrap(), manager.plugins_dir()).unwrap();
        reset_install_trust(manager.get_config_mut(), &prepared.manifest.id, prepared.source_label);
        persist_install_trust_reset(&mut manager).unwrap();
        // During the old-worker/new-code window the live backend is already
        // disabled, not merely the config that will be read on next startup.
        assert!(!manager.get_config().entities.plugin_configs[0].enabled);
        assert!(manager.get_config().entities.plugin_configs[0].granted_permissions.is_empty());
        let before_swap = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
        assert!(!before_swap.get_config().entities.plugin_configs[0].enabled);
        assert_eq!(fs::read_to_string(before_swap.plugins_dir().join("com.example.test/main.js")).unwrap(), "1.0.0");
        drop(before_swap);
        commit_plugin_install(&mut prepared, manager.get_config().revision).unwrap();
        // Model process death before any response/cleanup and fresh startup.
        drop(manager);
        let reloaded = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
        let entry = &reloaded.get_config().entities.plugin_configs[0];
        assert!(!entry.enabled);
        assert!(entry.granted_permissions.is_empty());
        assert!(entry.installed_at.unwrap() > 1);
        assert_eq!(fs::read_to_string(reloaded.plugins_dir().join("com.example.test/main.js")).unwrap(), "2.0.0");
        drop(reloaded);
        fs::write(root.join("config.json"), "corrupt config").unwrap();
        let recovered = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
        assert!(!recovered.get_config().entities.plugin_configs[0].enabled);
        assert!(recovered.get_config().entities.plugin_configs[0].granted_permissions.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_commit_keeps_old_code_but_remains_fail_closed() {
        let root = std::env::temp_dir().join(format!("plugin_state_rollback_{}", uuid::Uuid::new_v4()));
        let old_source = source(&root, "1.0.0");
        let new_source = source(&root, "2.0.0");
        let mut manager = trusted_manager(&root);
        install_plugin_fs_stage(old_source.to_str().unwrap(), manager.plugins_dir()).unwrap();
        let prepared = prepare_plugin_install(new_source.to_str().unwrap(), manager.plugins_dir()).unwrap();
        fs::remove_dir_all(&prepared.stage_guard.0).unwrap();
        assert!(install_prepared(&mut manager, prepared).is_err());
        let reloaded = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
        let entry = &reloaded.get_config().entities.plugin_configs[0];
        assert!(!entry.enabled);
        assert!(entry.granted_permissions.is_empty());
        assert_ne!(entry.install_generation, "old-generation");
        assert_eq!(fs::read_to_string(reloaded.plugins_dir().join("com.example.test/main.js")).unwrap(), "1.0.0");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_precommit_save_never_changes_code_or_memory_trust() {
        let root = std::env::temp_dir().join(format!("plugin_save_fail_{}", uuid::Uuid::new_v4()));
        let old_source = source(&root, "1.0.0");
        let new_source = source(&root, "2.0.0");
        let mut manager = trusted_manager(&root);
        install_plugin_fs_stage(old_source.to_str().unwrap(), manager.plugins_dir()).unwrap();
        let prepared = prepare_plugin_install(new_source.to_str().unwrap(), manager.plugins_dir()).unwrap();
        // ConfigManager's atomic save cannot open a directory as its temp file.
        fs::create_dir(root.join("config.json.tmp")).unwrap();
        assert!(install_prepared(&mut manager, prepared).is_err());
        assert!(manager.get_config().entities.plugin_configs[0].enabled);
        assert_eq!(fs::read_to_string(manager.plugins_dir().join("com.example.test/main.js")).unwrap(), "1.0.0");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_backup_persistence_never_swaps_executable_code() {
        let root = std::env::temp_dir().join(format!("plugin_backup_save_fail_{}", uuid::Uuid::new_v4()));
        let old_source = source(&root, "1.0.0");
        let new_source = source(&root, "2.0.0");
        let mut manager = trusted_manager(&root);
        install_plugin_fs_stage(old_source.to_str().unwrap(), manager.plugins_dir()).unwrap();
        let prepared = prepare_plugin_install(new_source.to_str().unwrap(), manager.plugins_dir()).unwrap();
        let backup = root.join("config.json.bak");
        if backup.exists() { fs::remove_file(&backup).unwrap(); }
        fs::create_dir(&backup).unwrap();
        assert!(install_prepared(&mut manager, prepared).is_err());
        assert_eq!(fs::read_to_string(manager.plugins_dir().join("com.example.test/main.js")).unwrap(), "1.0.0");
        assert!(manager.get_config().entities.plugin_configs[0].enabled);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_copy_rejects_empty_file_count_and_depth() {
        let root = std::env::temp_dir().join(format!("plugin_copy_limits_{}", uuid::Uuid::new_v4()));
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("empty"), "").unwrap();
        let mut count = plugin::MAX_ZIP_ENTRIES;
        let mut budget = plugin::MAX_ZIP_UNCOMPRESSED_BYTES;
        assert!(copy_dir_recursive_inner(&src, &root.join("out"), &mut budget, 0, &mut count).is_err());
        assert_eq!(budget, plugin::MAX_ZIP_UNCOMPRESSED_BYTES);
        fs::create_dir(src.join("nested")).unwrap();
        let mut count = 0;
        assert!(copy_dir_recursive_inner(&src, &root.join("deep"), &mut budget,
            plugin::MAX_PLUGIN_SOURCE_DEPTH, &mut count).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn ordinary_io_waits_for_active_work_without_overtaking_control() {
        let gate = tokio::sync::Mutex::new(());
        let active = gate.lock().await;
        let mut control = std::pin::pin!(gate.lock());
        let mut read = std::pin::pin!(lock_asset_io(&gate));
        let waker = futures_util::task::noop_waker();
        let mut context = std::task::Context::from_waker(&waker);
        assert!(control.as_mut().poll(&mut context).is_pending());
        assert!(read.as_mut().poll(&mut context).is_pending());
        drop(active);
        let control_guard = control.await;
        assert!(read.as_mut().poll(&mut context).is_pending());
        drop(control_guard);
        let read_guard = read.await.unwrap();
        drop(read_guard);
        assert!(gate.try_lock().is_ok());
    }

    #[tokio::test]
    async fn timed_out_asset_waiter_releases_its_queue_position() {
        let gate = tokio::sync::Mutex::new(());
        let active = gate.lock().await;
        assert!(lock_asset_io(&gate).await.is_err());
        drop(active);
        assert!(gate.try_lock().is_ok());
    }

    #[tokio::test]
    async fn queued_old_control_intent_is_rejected_after_install_gate() {
        let gate = tokio::sync::Mutex::new(());
        let installing = gate.lock().await;
        let mut cfg = config::AppConfig::default();
        reset_install_trust(&mut cfg, "com.example.test", "dir");
        let captured = cfg.entities.plugin_configs[0].install_generation.clone();
        let mut queued = std::pin::pin!(gate.lock());
        let waker = futures_util::task::noop_waker();
        let mut context = std::task::Context::from_waker(&waker);
        assert!(queued.as_mut().poll(&mut context).is_pending());
        reset_install_trust(&mut cfg, "com.example.test", "dir");
        drop(installing);
        let _control = queued.await;
        // Both commands check before modifying even a revoke or crash-disable.
        assert!(require_generation(&cfg, "com.example.test", &captured).is_err());
        assert!(!cfg.entities.plugin_configs[0].enabled);
        assert!(cfg.entities.plugin_configs[0].granted_permissions.is_empty());
    }

    #[test]
    fn data_paths_classify_first_component_and_reject_windows_aliases() {
        for raw in ["data/key", "DATA/key", "DaTa\\state.json", "./data/state.json"] {
            let rel = sanitize_asset_path(raw).unwrap();
            assert!(is_data_path(&rel), "{raw}");
            assert!(rel.starts_with("data"));
        }
        for raw in ["database/key", "datafile", "assets/data/key"] {
            assert!(!is_data_path(&sanitize_asset_path(raw).unwrap()), "{raw}");
        }
        for raw in ["data./key", "data /key", "data:key", "data/key:stream", "DATA./state.json", "DATA~1/key"] {
            assert!(sanitize_asset_path(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn data_quota_rejects_single_file_total_and_file_count() {
        let root = std::env::temp_dir().join(format!("plugin_data_limits_{}", uuid::Uuid::new_v4()));
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        let target = data.join("new");
        assert!(check_data_write_quota(&data, &target, PLUGIN_DATA_MAX_FILE_BYTES + 1).is_err());
        for index in 0..4 {
            fs::File::create(data.join(format!("large-{index}"))).unwrap()
                .set_len(PLUGIN_DATA_MAX_FILE_BYTES).unwrap();
        }
        assert!(check_data_write_quota(&data, &target, 1).is_err());
        assert!(check_data_write_quota(&data, &data.join("large-0"), 1).is_ok());
        fs::remove_dir_all(&data).unwrap();
        fs::create_dir(&data).unwrap();
        for index in 0..PLUGIN_DATA_MAX_FILES { fs::write(data.join(index.to_string()), "").unwrap(); }
        assert!(check_data_write_quota(&data, &target, 0).is_err());
        assert!(check_data_write_quota(&data, &data.join("0"), 1).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn asset_reads_enforce_limit_including_exact_boundary() {
        let root = std::env::temp_dir().join(format!("plugin_read_limits_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("text");
        fs::write(&file, "1234").unwrap();
        assert_eq!(read_asset_limited(&file, 4).unwrap(), "1234");
        assert!(read_asset_limited(&file, 3).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn http_truncation_limit_minus_one_exact_and_plus_one() {
        for size in [PLUGIN_HTTP_MAX_BODY - 1, PLUGIN_HTTP_MAX_BODY, PLUGIN_HTTP_MAX_BODY + 1] {
            let mut body = Vec::new();
            let chunk = vec![b'x'; size];
            assert_eq!(append_http_chunk(&mut body, &chunk, PLUGIN_HTTP_MAX_BODY), size > PLUGIN_HTTP_MAX_BODY);
            assert_eq!(body.len(), size.min(PLUGIN_HTTP_MAX_BODY));
        }
        let mut body = Vec::new();
        assert!(!append_http_chunk(&mut body, &vec![b'x'; PLUGIN_HTTP_MAX_BODY - 1], PLUGIN_HTTP_MAX_BODY));
        assert!(!append_http_chunk(&mut body, b"x", PLUGIN_HTTP_MAX_BODY));
        assert!(!append_http_chunk(&mut body, b"", PLUGIN_HTTP_MAX_BODY));
        assert!(append_http_chunk(&mut body, b"x", PLUGIN_HTTP_MAX_BODY));
        assert_eq!(body.len(), PLUGIN_HTTP_MAX_BODY);
    }

    #[test]
    fn invalid_ids_cannot_delete_root_or_siblings() {
        let root = std::env::temp_dir().join(format!("plugin_id_test_{}", uuid::Uuid::new_v4()));
        let sibling = root.join("com.example.keep");
        fs::create_dir_all(&sibling).unwrap();
        fs::write(sibling.join("keep"), "intact").unwrap();
        for id in [".", "..", "", "../com.example.keep", "com..bad", "com.", ".bad"] {
            assert!(stage_uninstall_fs(&root, id).is_err(), "{id}");
        }
        assert_eq!(fs::read_to_string(sibling.join("keep")).unwrap(), "intact");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn uninstall_backup_can_restore_private_data_after_save_failure() {
        let root = std::env::temp_dir().join(format!("plugin_uninstall_{}", uuid::Uuid::new_v4()));
        let plugin_dir = root.join("com.example.keep");
        fs::create_dir_all(plugin_dir.join("data")).unwrap();
        fs::write(plugin_dir.join("data/keep"), "user").unwrap();
        let (dest, backup) = stage_uninstall_fs(&root, "com.example.keep").unwrap();
        let backup = backup.unwrap();
        assert!(!dest.exists());
        assert_eq!(fs::read_to_string(backup.join("data/keep")).unwrap(), "user");
        fs::rename(backup, &dest).unwrap();
        assert_eq!(fs::read_to_string(dest.join("data/keep")).unwrap(), "user");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_write_replaces_existing_content() {
        let root = std::env::temp_dir().join(format!("plugin_write_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("key");
        atomic_write_asset(&root, &target, b"old").unwrap();
        atomic_write_asset(&root, &target, b"new").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_does_not_follow_target_symlink() {
        let root = std::env::temp_dir().join(format!("plugin_write_link_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let outside = root.join("outside");
        fs::write(&outside, "safe").unwrap();
        let target = root.join("key");
        std::os::unix::fs::symlink(&outside, &target).unwrap();
        atomic_write_asset(&root, &target, b"plugin").unwrap();
        assert_eq!(fs::read_to_string(outside).unwrap(), "safe");
        assert_eq!(fs::read_to_string(target).unwrap(), "plugin");
        fs::remove_dir_all(root).unwrap();
    }


    #[test]
    fn upgrade_preserves_old_data_and_removes_old_code() {
        let root = std::env::temp_dir().join(format!("plugin_upgrade_{}", uuid::Uuid::new_v4()));
        let src1 = source(&root, "1.0.0");
        let src2 = source(&root, "2.0.0");
        let plugins = root.join("plugins");
        install_plugin_fs_stage(src1.to_str().unwrap(), &plugins).unwrap();
        let dest = plugins.join("com.example.test");
        fs::create_dir_all(dest.join("data")).unwrap();
        fs::write(dest.join("data/keep"), "user").unwrap();
        fs::write(dest.join("legacy.js"), "old").unwrap();
        fs::create_dir_all(src2.join("data")).unwrap();
        fs::write(src2.join("data/keep"), "package").unwrap();
        let backup = install_plugin_fs_stage(src2.to_str().unwrap(), &plugins).unwrap().3.unwrap();
        assert_eq!(fs::read_to_string(dest.join("data/keep")).unwrap(), "user");
        assert_eq!(fs::read_to_string(dest.join("main.js")).unwrap(), "2.0.0");
        assert!(!dest.join("legacy.js").exists());
        assert_eq!(fs::read_to_string(backup.join("main.js")).unwrap(), "1.0.0");
        fs::remove_dir_all(backup).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_upgrade_entry_preserves_existing_plugin_and_data() {
        let root = std::env::temp_dir().join(format!("plugin_missing_entry_{}", uuid::Uuid::new_v4()));
        let original = source(&root, "1.0.0");
        let upgrade = source(&root, "2.0.0");
        let plugins = root.join("plugins");
        install_plugin_fs_stage(original.to_str().unwrap(), &plugins).unwrap();
        let destination = plugins.join("com.example.test");
        fs::create_dir_all(destination.join("data")).unwrap();
        fs::write(destination.join("data/keep"), "saved").unwrap();
        fs::remove_file(upgrade.join("main.js")).unwrap();

        assert!(install_plugin_fs_stage(upgrade.to_str().unwrap(), &plugins).is_err());
        assert_eq!(fs::read_to_string(destination.join("main.js")).unwrap(), "1.0.0");
        assert_eq!(fs::read_to_string(destination.join("data/keep")).unwrap(), "saved");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_upgrade_keeps_old_code_and_private_data() {
        let root = std::env::temp_dir().join(format!("plugin_failed_upgrade_{}", uuid::Uuid::new_v4()));
        let src1 = source(&root, "1.0.0");
        let src2 = source(&root, "2.0.0");
        let plugins = root.join("plugins");
        install_plugin_fs_stage(src1.to_str().unwrap(), &plugins).unwrap();
        let dest = plugins.join("com.example.test");
        fs::create_dir_all(dest.join("data")).unwrap();
        fs::write(dest.join("data/keep"), "user").unwrap();
        fs::File::create(src2.join("oversized.bin")).unwrap()
            .set_len(plugin::MAX_ZIP_UNCOMPRESSED_BYTES + 1).unwrap();
        assert!(install_plugin_fs_stage(src2.to_str().unwrap(), &plugins).is_err());
        assert_eq!(fs::read_to_string(dest.join("main.js")).unwrap(), "1.0.0");
        assert_eq!(fs::read_to_string(dest.join("data/keep")).unwrap(), "user");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_upgrade_recovers_each_rename_boundary_idempotently() {
        for boundary in 0..=3 {
            let root = std::env::temp_dir().join(format!("plugin_boundary_{}", uuid::Uuid::new_v4()));
            let old_source = source(&root, "1.0.0");
            let new_source = source(&root, "2.0.0");
            let mut manager = trusted_manager(&root);
            install_plugin_fs_stage(old_source.to_str().unwrap(), manager.plugins_dir()).unwrap();
            let plugins = manager.plugins_dir().to_path_buf();
            let dest = plugins.join("com.example.test");
            fs::create_dir(dest.join("data")).unwrap();
            fs::write(dest.join("data/keep"), "private").unwrap();
            let mut prepared = prepare_plugin_install(new_source.to_str().unwrap(), &plugins).unwrap();
            reset_install_trust(manager.get_config_mut(), "com.example.test", "dir");
            persist_install_trust_reset(&mut manager).unwrap();
            let stage = prepared.stage_guard.0.clone();
            let mut tx = plugin::transaction::Transaction::install(&plugins, "com.example.test", &stage,
                manager.get_config().revision).unwrap();
            prepared.stage_guard.0.clear();
            if boundary >= 1 {
                tx.phase(&plugins, "backup").unwrap();
                plugin::transaction::rename(&plugins, &dest, &tx.backup(&plugins)).unwrap();
            }
            if boundary >= 2 {
                tx.phase(&plugins, "private-data").unwrap();
                plugin::transaction::rename(&plugins, &tx.backup(&plugins).join("data"), &stage.join("data")).unwrap();
            }
            if boundary >= 3 {
                tx.phase(&plugins, "publish").unwrap();
                plugin::transaction::rename(&plugins, &stage, &dest).unwrap();
            }
            // No rollback code or guard runs: startup sees exactly the killed-process disk state.
            drop(manager);
            for _ in 0..2 {
                let loaded = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
                assert!(!loaded.get_config().entities.plugin_configs[0].enabled);
                assert!(loaded.get_config().entities.plugin_configs[0].granted_permissions.is_empty());
                assert_eq!(fs::read_to_string(dest.join("data/keep")).unwrap(), "private");
                assert_eq!(fs::read_to_string(dest.join("main.js")).unwrap(),
                    if boundary == 3 { "2.0.0" } else { "1.0.0" });
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn interrupted_uninstall_uses_durable_config_commit() {
        for boundary in 0..=2 {
            let root = std::env::temp_dir().join(format!("plugin_uninstall_boundary_{}", uuid::Uuid::new_v4()));
            let src = source(&root, "1.0.0");
            let mut manager = trusted_manager(&root);
            install_plugin_fs_stage(src.to_str().unwrap(), manager.plugins_dir()).unwrap();
            let plugins = manager.plugins_dir().to_path_buf();
            let dest = plugins.join("com.example.test");
            fs::create_dir(dest.join("data")).unwrap();
            fs::write(dest.join("data/keep"), "private").unwrap();
            let tx = plugin::transaction::Transaction::uninstall(&plugins, "com.example.test", manager.get_config().revision + 1).unwrap();
            if boundary >= 1 { plugin::transaction::rename(&plugins, &dest, &tx.backup(&plugins)).unwrap(); }
            if boundary == 2 {
                manager.get_config_mut().entities.plugin_configs.clear();
                manager.save().unwrap();
                manager.save_safe_backup().unwrap();
            }
            drop(manager);
            for _ in 0..2 {
                let loaded = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
                assert_eq!(loaded.get_config().entities.plugin_configs.is_empty(), boundary == 2);
                if boundary == 2 { assert!(!dest.exists()); }
                else { assert_eq!(fs::read_to_string(dest.join("data/keep")).unwrap(), "private"); }
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn generation_rejects_queued_edits_and_never_repeats_after_reinstall() {
        let mut cfg = config::AppConfig::default();
        reset_install_trust(&mut cfg, "com.example.test", "dir");
        let first = cfg.entities.plugin_configs[0].install_generation.clone();
        assert!(require_generation(&cfg, "com.example.test", &first).is_ok());
        reset_install_trust(&mut cfg, "com.example.test", "dir");
        let second = cfg.entities.plugin_configs[0].install_generation.clone();
        assert!(require_generation(&cfg, "com.example.test", &first).is_err());
        assert!(require_generation(&cfg, "com.example.test", "").is_err());
        cfg.entities.plugin_configs.clear();
        reset_install_trust(&mut cfg, "com.example.test", "dir");
        assert_ne!(cfg.entities.plugin_configs[0].install_generation, first);
        assert_ne!(cfg.entities.plugin_configs[0].install_generation, second);
    }

    #[test]
    fn snapshot_revision_is_captured_after_save() {
        let root = std::env::temp_dir().join(format!("plugin_snapshot_{}", uuid::Uuid::new_v4()));
        let mut manager = trusted_manager(&root);
        let before = snapshot(&manager).revision;
        manager.save().unwrap();
        assert_eq!(snapshot(&manager).revision, before + 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn successful_install_update_uninstall_reinstall_returns_fresh_identity() {
        let root = std::env::temp_dir().join(format!("plugin_identity_cycle_{}", uuid::Uuid::new_v4()));
        let src1 = source(&root, "1.0.0");
        let src2 = source(&root, "2.0.0");
        let mut manager = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
        let prepared = prepare_plugin_install(src1.to_str().unwrap(), manager.plugins_dir()).unwrap();
        let first = install_prepared(&mut manager, prepared).unwrap();
        let prepared = prepare_plugin_install(src2.to_str().unwrap(), manager.plugins_dir()).unwrap();
        let second = install_prepared(&mut manager, prepared).unwrap();
        assert_ne!(first.plugin_configs[0].install_generation, second.plugin_configs[0].install_generation);
        assert!(second.revision > first.revision);
        let removed = uninstall_with_manager(&mut manager, "com.example.test").unwrap();
        assert!(removed.plugin_configs.is_empty());
        assert!(removed.revision > second.revision);
        let prepared = prepare_plugin_install(src1.to_str().unwrap(), manager.plugins_dir()).unwrap();
        let reinstalled = install_prepared(&mut manager, prepared).unwrap();
        assert_ne!(reinstalled.plugin_configs[0].install_generation, first.plugin_configs[0].install_generation);
        assert_ne!(reinstalled.plugin_configs[0].install_generation, second.plugin_configs[0].install_generation);
        assert!(!reinstalled.plugin_configs[0].enabled);
        assert!(reinstalled.plugin_configs[0].granted_permissions.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn missing_asset_does_not_hide_linked_parent_or_data_corruption() {
        let root = std::env::temp_dir().join(format!("plugin_missing_corrupt_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir(root.join("outside")).unwrap();
        std::os::unix::fs::symlink(root.join("outside"), root.join("data/link")).unwrap();
        assert!(read_authorized_asset(&root, Path::new("data/state.json")).is_err());
        std::os::unix::fs::symlink(root.join("outside"), root.join("linked")).unwrap();
        assert!(read_authorized_asset(&root, Path::new("linked/missing")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_first_install_is_disabled_or_absent_without_package_data() {
        for published in [false, true] {
            let root = std::env::temp_dir().join(format!("plugin_first_boundary_{}", uuid::Uuid::new_v4()));
            let src = source(&root, "1.0.0");
            fs::create_dir(src.join("data")).unwrap();
            fs::write(src.join("data/injected"), "package").unwrap();
            let mut manager = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
            let mut prepared = prepare_plugin_install(src.to_str().unwrap(), manager.plugins_dir()).unwrap();
            reset_install_trust(manager.get_config_mut(), "com.example.test", "dir");
            persist_install_trust_reset(&mut manager).unwrap();
            let plugins = manager.plugins_dir().to_path_buf();
            let stage = prepared.stage_guard.0.clone();
            let tx = plugin::transaction::Transaction::install(&plugins, "com.example.test", &stage,
                manager.get_config().revision).unwrap();
            prepared.stage_guard.0.clear();
            if published { plugin::transaction::rename(&plugins, &stage, &tx.dest(&plugins)).unwrap(); }
            drop(manager);
            let loaded = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
            assert!(!loaded.get_config().entities.plugin_configs[0].enabled);
            assert!(loaded.get_config().entities.plugin_configs[0].granted_permissions.is_empty());
            assert_eq!(tx.dest(&plugins).exists(), published);
            assert!(!tx.dest(&plugins).join("data/injected").exists());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn data_quota_budgets_all_new_parent_directories_without_mutation() {
        let root = std::env::temp_dir().join(format!("plugin_parent_budget_{}", uuid::Uuid::new_v4()));
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        let mut accepted = 0;
        for index in 0..65 {
            let mut parent = data.clone();
            for depth in 0..30 { parent.push(format!("p{index}-{depth}")); }
            let target = parent.join("key");
            if check_data_write_quota(&data, &target, 0).is_ok() {
                fs::create_dir_all(&parent).unwrap();
                fs::write(target, "").unwrap();
                accepted += 1;
            } else { assert!(!data.join(format!("p{index}-0")).exists()); }
        }
        assert_eq!(accepted, plugin::MAX_ZIP_ENTRIES / 31);
        assert!(check_data_write_quota(&data, &data.join("p0-0/p0-1/p0-2/p0-3/p0-4/p0-5/p0-6/p0-7/p0-8/p0-9/p0-10/p0-11/p0-12/p0-13/p0-14/p0-15/p0-16/p0-17/p0-18/p0-19/p0-20/p0-21/p0-22/p0-23/p0-24/p0-25/p0-26/p0-27/p0-28/p0-29/key"), 0).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_asset_is_distinct_from_type_encoding_and_limit_errors() {
        let root = std::env::temp_dir().join(format!("plugin_missing_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        assert_eq!(read_authorized_asset(&root, Path::new("data/state.json")).unwrap(), None);
        fs::create_dir(root.join("directory")).unwrap();
        assert!(read_authorized_asset(&root, Path::new("directory")).is_err());
        fs::write(root.join("binary"), [255]).unwrap();
        assert!(read_authorized_asset(&root, Path::new("binary")).is_err());
        fs::write(root.join("file"), "hello").unwrap();
        assert_eq!(read_authorized_asset(&root, Path::new("file")).unwrap(), Some("hello".into()));
        assert!(read_authorized_asset(&root, Path::new("file/child")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn glob_query_separator_is_literal() {
        let pattern = "https://a.com/v1?token=x";
        assert!(url_glob_match(pattern, pattern));
        assert!(!url_glob_match(pattern, "https://a.com/v1Xtoken=x"));
        assert!(!url_glob_match(pattern, "https://a.com/v1token=x"));
    }


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
    #[test]
    fn glob_matches_normalized_url() {
        // 评审复审补强：plugin_http 匹配 Url::parse 规范化串。此处验证
        // 规范化语义与 glob 的组合行为（大小写 host、默认端口、相对段）。
        // 大写 host → Url 小写化 → 与小写白名单匹配。
        let upper = url::Url::parse("https://SYMBOLS.Example.COM/v1/symbol").unwrap();
        assert!(url_glob_match("https://symbols.example.com/**", upper.as_str()));
        // 默认端口剥离：443 在 https 下被 Url 规范化掉 → 前缀仍匹配。
        let default_port = url::Url::parse("https://symbols.example.com:443/v1").unwrap();
        assert!(url_glob_match("https://symbols.example.com/**", default_port.as_str()));
        // 相对段消除：/a/../b → /b（原始串含 ..，归一后与白名单匹配）。
        let dotdot = url::Url::parse("https://symbols.example.com/a/../v1").unwrap();
        assert_eq!(dotdot.as_str(), "https://symbols.example.com/v1");
        assert!(url_glob_match("https://symbols.example.com/**", dotdot.as_str()));
        // 非默认端口保留：8443 不被剥离 → 不等于白名单前缀。
        let custom_port = url::Url::parse("https://symbols.example.com:8443/v1").unwrap();
        assert!(!url_glob_match("https://symbols.example.com/**", custom_port.as_str()));
    }
}
