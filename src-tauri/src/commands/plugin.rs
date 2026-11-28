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
 * ZIP 按归档预算解压，目录按实际暂存空间预检；两者均在 staging 中验证并保留升级恢复语义。
 */
use std::path::Path;
use std::sync::{Arc, Mutex, atomic::{AtomicU8, Ordering}};
use std::time::Duration;
use base64::Engine as _;

use tauri::{Manager, State, ipc::Channel};

use super::CommandError;
use super::file::revoke_plugin_directory_grants;
use super::plugin_serial_tasks::{retire_plugin_serial_file_tasks, retire_plugin_serial_tasks};
use crate::config;
use crate::plugin::{self, PluginManifest};
use crate::plugin::source_copy::{self, CopyControl, DirectoryPass, PluginInstallProgress, SourceStamp};
use crate::AppState;

const PLUGIN_IO_WAIT: Duration = Duration::from_secs(5);

pub(crate) async fn acquire_plugin_gate<'a>(
    gate: &'a tokio::sync::Mutex<()>,
    wait: Duration,
) -> Result<tokio::sync::MutexGuard<'a, ()>, CommandError> {
    tokio::time::timeout(wait, gate.lock())
        .await
        .map_err(|_| CommandError::Other("插件操作忙，请稍后重试".into()))
}

pub(crate) async fn acquire_plugin_io(
    state: &AppState,
) -> Result<tokio::sync::MutexGuard<'_, ()>, CommandError> {
    acquire_plugin_gate(&state.plugin_io, PLUGIN_IO_WAIT).await
}

/// Reclaim quarantined transaction trees off the interactive path.
///
/// Recursive deletion is unbounded in size (a plugin may own millions of log
/// segments), so it must never run while startup, the config mutex or a command
/// is waiting for it. The plugin IO gate serializes the sweep with
/// install/uninstall; callers never await the deletion.
pub(crate) fn schedule_plugin_sweep(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Shutdown may unmanage state while a detached sweep is still queued.
        let Some(state) = app.try_state::<AppState>() else { return; };
        // Only selection is serialized with install/uninstall; recursive deletion
        // runs off the gate so settings stay usable while a large tree is removed.
        let (root, trees) = {
            // A live transaction owns the workspace; wait briefly so a startup
            // race with list_plugins cannot starve reclamation for the session.
            let Ok(_gate) = acquire_plugin_gate(&state.plugin_io, Duration::from_secs(2)).await
            else { return; };
            let (root, config) = match state.config_manager.lock() {
                Ok(manager) => (
                    manager.plugins_dir().to_path_buf(),
                    manager.get_config().clone(),
                ),
                Err(_) => return,
            };
            let trees = match plugin::transaction::sweep_collect(&root, &config) {
                Ok(trees) => trees,
                Err(error) => {
                    log::warn!("Plugin transaction sweep selection failed: {error}");
                    return;
                }
            };
            (root, trees)
        };
        if trees.is_empty() { return; }
        match tokio::task::spawn_blocking(move || {
            plugin::transaction::sweep_delete(&root, &trees)
        }).await {
            Ok(removed) if removed > 0 => {
                log::info!("Reclaimed {removed} abandoned plugin transaction tree(s)")
            }
            Ok(_) => {}
            Err(error) => log::warn!("Plugin transaction sweep join failed: {error}"),
        }
    });
}

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
    pub trusted_web_granted: bool,
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
    /// 安装来源（dir/zip/marketplace）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// 市场安装时关联的归档地址。
    #[serde(rename = "updateUrl", skip_serializing_if = "Option::is_none")]
    pub update_url: Option<String>,
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
    pub host_kind: Option<String>,
    pub tools: Vec<plugin::PluginToolDecl>,
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
            host_kind: m.host_kind.clone(),
            tools: m.tools.clone(),
            http: m.http.clone(),
            shell: m.shell.clone(),
            serial: m.serial.clone(),
            ui: m.ui.clone(),
        }
    }
}

/// 从 config 实体取插件状态（不可变借用）。无实体 = 未安装态（默认值）。
pub(super) fn state_of<'a>(cfg: &'a config::AppConfig, id: &str) -> Option<&'a config::PluginConfigEntry> {
    cfg.entities.plugin_configs.iter().find(|p| p.id == id)
}

/// 合并磁盘扫描结果 + config 状态为完整视图列表。
fn build_views_from_scan(
    cfg: &config::AppConfig,
    scanned: Vec<plugin::InstalledPlugin>,
) -> Vec<PluginView> {
    scanned
        .into_iter()
        .map(|sp| {
            let dir_str = sp.dir.display().to_string();
            let state = sp.manifest.as_ref().ok().and_then(|m| state_of(cfg, &m.id));
            match sp.manifest {
                Ok(manifest) => PluginView {
                    id: manifest.id.clone(),
                    install_generation: state
                        .map(|s| s.install_generation.clone())
                        .unwrap_or_default(),
                    dir: dir_str,
                    enabled: state.map(|s| s.enabled).unwrap_or(false),
                    trusted_web_granted: state.is_some_and(|s| s.trusted_web_granted),
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
                     source: state.and_then(|s| s.source.clone()),
                     update_url: state.and_then(|s| s.update_url.clone()),
                },
                Err(err) => {
                    // The scanner validated the directory ID. Use its config
                    // identity for uninstall confirmation, but expose no runtime
                    // authorization when the package itself is invalid.
                    let dir_id = sp.dir.file_name().and_then(|name| name.to_str());
                    PluginView {
                        id: dir_id.unwrap_or("unknown").into(),
                        dir: dir_str,
                        install_generation: dir_id.and_then(|id| state_of(cfg, id))
                            .map(|entry| entry.install_generation.clone())
                            .unwrap_or_default(),
                        enabled: false,
                        trusted_web_granted: false,
                        granted_permissions: Vec::new(),
                        declared_permissions: Vec::new(),
                        known_permissions: plugin::KNOWN_PERMISSIONS
                            .iter()
                            .map(|s| s.to_string())
                            .collect(),
                        manifest: None,
                        manifest_error: Some(err),
                        installed_at: None,
                        source: None,
                        update_url: None,
                    }
                }
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

pub(crate) fn snapshot(manager: &config::ConfigManager) -> PluginStateSnapshot {
    let cfg = manager.get_config();
    PluginStateSnapshot {
        revision: cfg.revision,
        plugin_configs: cfg.entities.plugin_configs.clone(),
    }
}

fn require_generation(
    cfg: &config::AppConfig,
    id: &str,
    expected: &str,
) -> Result<(), CommandError> {
    let entry =
        state_of(cfg, id).ok_or_else(|| CommandError::Other(format!("插件未安装: {id}")))?;
    if expected.is_empty() || entry.install_generation != expected {
        return Err(CommandError::Other(
            "插件安装版本已变化，请重新检查插件后操作".into(),
        ));
    }
    Ok(())
}

fn require_trusted_web_consent(manifest: &PluginManifest, entry: &config::PluginConfigEntry) -> Result<(), CommandError> {
    if manifest.has_trusted_web_views() && !entry.trusted_web_granted {
        return Err(CommandError::Other("请先单独确认信任此插件的网页能力".into()));
    }
    Ok(())
}

/// 列出已安装插件（磁盘扫描视图 + config 状态数组）。
/// 扫描（read_dir + 逐目录 manifest 解析）在阻塞线程池执行——不占命令线程。
#[tauri::command]
pub async fn list_plugins(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginListResponse, CommandError> {
    require_main_window(&window)?;
    let _plugin_io = acquire_plugin_io(&state).await?;
    let root = {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager.plugins_dir().to_path_buf()
    };
    let scanned = tokio::task::spawn_blocking(move || {
        plugin::transaction::cleanup_orphan_staging(&root)
            .map_err(|e| CommandError::Io(format!("清理插件暂存目录失败: {e}")))?;
        Ok::<_, CommandError>(plugin::scan_plugins(&root))
    })
        .await
        .map_err(|e| CommandError::Other(format!("插件扫描 join 失败: {e}")))??;
    // Scan may take seconds; never return a permission snapshot captured before it.
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let cfg = manager.get_config();
    let plugins = build_views_from_scan(cfg, scanned);
    Ok(PluginListResponse {
        revision: cfg.revision,
        plugins,
        plugin_configs: cfg.entities.plugin_configs.clone(),
    })
}

/// 重载已安装代码（不重新拷贝源、不改变安装身份/授权/私有数据）。
/// 前端会先停掉旧 Worker，再调用本命令；后端在这里取消该插件的全部
/// 流式网络请求并退役本机网页视图，随后由前端以权威快照重建。
#[tauri::command]
pub async fn reload_plugin(
    id: String,
    expected_generation: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginStateSnapshot, CommandError> {
    require_main_window(&window)?;
    plugin::validate_plugin_id(&id).map_err(CommandError::Other)?;
    let _plugin_io = acquire_plugin_io(&state).await?;
    let root = {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        require_generation(manager.get_config(), &id, &expected_generation)?;
        let entry = state_of(manager.get_config(), &id).unwrap();
        if !entry.enabled {
            return Err(CommandError::Other(format!("插件未启用: {id}")));
        }
        manager.plugins_dir().to_path_buf()
    };
    // Full resource validation is required before reload, but never while the
    // config mutex is held. The IO gate keeps code stable during this check.
    plugin::load_manifest_from_dir(&plugin_dir(&root, &id)?)
        .map_err(|e| CommandError::Other(format!("插件 manifest 不可读: {e}")))?;
    let result = {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        require_generation(manager.get_config(), &id, &expected_generation)?;
        if !state_of(manager.get_config(), &id).is_some_and(|entry| entry.enabled) {
            return Err(CommandError::Other(format!("插件未启用: {id}")));
        }
        snapshot(&manager)
    };
    retire_plugin_serial_tasks(&state, Some(&id));
    state.plugin_http.cancel_plugin(&id);
    state.plugin_shell.cancel_plugin(&id);
    state
        .lease_registry
        .release_by_owner_prefix(Some(&state.event_hub), &format!("plugin:{id}:"))
        .await;
    retire_plugin_file_io(&state, &id);
    revoke_plugin_directory_grants(&id);
    state
        .control_hub
        .plugin_bridge()
        .retire_plugin(Some(window.app_handle()), &id);
    plugin::view_runtime::retire_plugin(window.app_handle(), &id).await?;
    log::info!("Plugin reloaded from installed code: {id}");
    Ok(result)
}

/// 安装插件。`source_path` 可为插件**目录**（复制注册，源保留）或插件 **zip 包**
/// （内含 `<id>/…` 顶层插件目录；安全解压，zip slip 防护见 `extract_plugin_zip`）。
/// 已存在同 id → 更高版本正常覆盖；同版本/降级仅在调用方显式
/// `replace_existing=true` 时允许（先经用户确认）。替换保留 data/ 私有区，
/// 但轮换 installGeneration 并重置授权/信任（与普通安装相同）。
/// 返回保存后的 revision + 全量 pluginConfigs 权威快照。
///
/// Preparation runs in spawn_blocking without touching installed files. After
/// preparation, a non-cancellable blocking section persists disabled/no-grants
/// state before the first rename while holding both transaction/config gates.
#[tauri::command]
pub async fn install_plugin(
    source_path: String,
    replace_existing: Option<bool>,
    // Optional identity of the code the user reviewed. A replacement install that
    // races a newer install would otherwise silently overwrite reviewed code.
    expected_generation: Option<String>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginStateSnapshot, CommandError> {
    require_main_window(&window)?;
    let candidate = source_path.clone();
    let is_directory = tokio::task::spawn_blocking(move || {
        std::fs::symlink_metadata(candidate).is_ok_and(|meta| meta.is_dir() && !plugin::is_link_or_reparse(&meta))
    }).await.map_err(|error| CommandError::Other(format!("检查插件来源失败: {error}")))?;
    if is_directory {
        return run_directory_install(window.app_handle().clone(), source_path, replace_existing.unwrap_or(false),
            expected_generation, uuid::Uuid::new_v4(), None).await;
    }
    let plugin_io = acquire_plugin_io(&state).await?;
    let root = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?
        .plugins_dir()
        .to_path_buf();
    let prepared = tokio::task::spawn_blocking(move || {
        plugin::transaction::cleanup_orphan_staging(&root)
            .map_err(|e| CommandError::Io(format!("清理插件暂存目录失败: {e}")))?;
        prepare_plugin_install_controlled(&source_path, &root, replace_existing.unwrap_or(false),
            None, None, CopyControl::SILENT, PrepareFormat::Archive)
    })
    .await
    .map_err(|e| CommandError::Other(format!("安装暂存 join 失败: {e}")))??;
    install_prepared_transaction(
        &state, window.app_handle(), plugin_io, prepared, expected_generation.as_deref(),
    ).await
}

const INSTALL_PREPARING: u8 = 0;
const INSTALL_CANCELLED: u8 = 1;
const INSTALL_COMMITTING: u8 = 2;

struct DirectoryInstallTask {
    id: uuid::Uuid,
    phase: AtomicU8,
    cancelled: tokio::sync::Notify,
}

static DIRECTORY_INSTALL: Mutex<Option<Arc<DirectoryInstallTask>>> = Mutex::new(None);

struct DirectoryInstallLease(Arc<DirectoryInstallTask>);

impl Drop for DirectoryInstallLease {
    fn drop(&mut self) {
        if let Ok(mut active) = DIRECTORY_INSTALL.lock() {
            if active.as_ref().is_some_and(|task| Arc::ptr_eq(task, &self.0)) {
                *active = None;
            }
        }
    }
}

fn install_cancelled() -> CommandError { CommandError::Other(source_copy::CANCELLED.into()) }

impl DirectoryInstallTask {
    fn is_cancelled(&self) -> bool { self.phase.load(Ordering::Acquire) == INSTALL_CANCELLED }

    async fn wait_for_cancel(&self) {
        if !self.is_cancelled() { self.cancelled.notified().await; }
    }

    fn request_cancel(&self) -> CancelPluginInstall {
        match self.phase.compare_exchange(INSTALL_PREPARING, INSTALL_CANCELLED, Ordering::AcqRel, Ordering::Acquire) {
            Ok(_) => {
                self.cancelled.notify_one();
                CancelPluginInstall::Accepted
            }
            Err(INSTALL_CANCELLED) => CancelPluginInstall::Accepted,
            Err(_) => CancelPluginInstall::TooLate,
        }
    }

    fn begin_commit(&self) -> Result<(), CommandError> {
        self.phase.compare_exchange(INSTALL_PREPARING, INSTALL_COMMITTING, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| ()).map_err(|_| install_cancelled())
    }
}

#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CancelPluginInstall {
    Accepted,
    TooLate,
    NotFound,
}

/// Cancellation never waits for the plugin IO gate. Accepted only means that
/// preparation cannot publish; the worker still has to finish its current IO.
#[tauri::command]
pub fn cancel_plugin_install(request_id: String, window: tauri::WebviewWindow) -> Result<CancelPluginInstall, CommandError> {
    require_main_window(&window)?;
    let id = uuid::Uuid::parse_str(&request_id).map_err(|_| CommandError::Other("Invalid directory install request ID".into()))?;
    let active = DIRECTORY_INSTALL.lock().map_err(|error| CommandError::Lock(error.to_string()))?;
    Ok(active.as_ref().filter(|task| task.id == id).map_or(CancelPluginInstall::NotFound, |task| task.request_cancel()))
}

/// Host-only directory install. Older callers and ZIPs may keep using the
/// original install command and identical snapshot result.
#[tauri::command]
pub async fn install_plugin_directory_with_progress(
    source_path: String,
    replace_existing: Option<bool>,
    expected_generation: Option<String>,
    request_id: String,
    progress: Channel<PluginInstallProgress>,
    window: tauri::WebviewWindow,
) -> Result<PluginStateSnapshot, CommandError> {
    require_main_window(&window)?;
    let id = uuid::Uuid::parse_str(&request_id).map_err(|_| CommandError::Other("Invalid directory install request ID".into()))?;
    run_directory_install(window.app_handle().clone(), source_path, replace_existing.unwrap_or(false),
        expected_generation, id, Some(progress)).await
}

type DirectoryProgress = Arc<dyn Fn(PluginInstallProgress) + Send + Sync>;

async fn run_directory_install(
    app: tauri::AppHandle,
    source_path: String,
    replace_existing: bool,
    expected_generation: Option<String>,
    id: uuid::Uuid,
    progress: Option<Channel<PluginInstallProgress>>,
) -> Result<PluginStateSnapshot, CommandError> {
    let task = Arc::new(DirectoryInstallTask { id, phase: AtomicU8::new(INSTALL_PREPARING), cancelled: tokio::sync::Notify::new() });
    {
        let mut active = DIRECTORY_INSTALL.lock().map_err(|error| CommandError::Lock(error.to_string()))?;
        if active.is_some() {
            return Err(CommandError::Other("已有插件目录安装任务，请稍后重试".into()));
        }
        *active = Some(task.clone());
    }
    let lease = DirectoryInstallLease(task);
    // Retain preparation ownership even if the IPC caller disappears.
    tauri::async_runtime::spawn(async move {
        let task = &lease.0;
        let state = app.try_state::<AppState>().ok_or_else(|| CommandError::Other("Application is shutting down".into()))?;
        let progress: DirectoryProgress = Arc::new(move |event| {
            if let Some(channel) = &progress { let _ = channel.send(event); }
        });
        let prepared = prepare_directory_before_commit(&state.config_manager, &state.plugin_io, task,
            source_path, replace_existing, expected_generation.as_deref(), progress.clone()).await?;
        progress(PluginInstallProgress::Waiting);
        let gate = tokio::select! {
            _ = task.wait_for_cancel() => Err(install_cancelled()),
            result = acquire_plugin_io(&state) => result,
        };
        match gate {
            Ok(gate) => install_prepared_transaction_observed(&state, &app, gate, prepared,
                expected_generation.as_deref(), Some((task, &*progress))).await,
            Err(error) => {
                discard_install_stage(prepared).await;
                Err(error)
            }
        }
    }).await.map_err(|error| CommandError::Other(format!("目录安装任务失败: {error}")))?
}

async fn discard_install_stage(prepared: PreparedPluginInstall) {
    if let Err(error) = tokio::task::spawn_blocking(move || drop(prepared)).await {
        log::warn!("Could not finalize cleanup of a plugin preparation: {error}");
    }
}

/// Keep only target admission and publication under the control gate.
pub(crate) async fn install_prepared_transaction(
    state: &AppState,
    app: &tauri::AppHandle,
    plugin_io: tokio::sync::MutexGuard<'_, ()>,
    prepared: PreparedPluginInstall,
    expected_generation: Option<&str>,
) -> Result<PluginStateSnapshot, CommandError> {
    install_prepared_transaction_observed(state, app, plugin_io, prepared, expected_generation, None).await
}

async fn install_prepared_transaction_observed(
    state: &AppState,
    app: &tauri::AppHandle,
    plugin_io: tokio::sync::MutexGuard<'_, ()>,
    mut prepared: PreparedPluginInstall,
    expected_generation: Option<&str>,
    observed: Option<(&DirectoryInstallTask, &(dyn Fn(PluginInstallProgress) + Send + Sync))>,
) -> Result<PluginStateSnapshot, CommandError> {
    let id = prepared.manifest.id.clone();
    let result = install_after_retiring(&state.config_manager, &mut prepared, expected_generation, || {
        if let Some((task, progress)) = observed {
            task.begin_commit()?;
            progress(PluginInstallProgress::Committing);
        }
        Ok(())
    }, || async {
        state.plugin_http.cancel_plugin(&id);
        state.plugin_shell.cancel_plugin(&id);
        state
            .lease_registry
            .release_by_owner_prefix(Some(&state.event_hub), &format!("plugin:{id}:"))
            .await;
        state
            .control_hub
            .plugin_bridge()
            .retire_plugin(Some(app), &id);
        retire_plugin_file_io(state, &id);
        plugin::view_runtime::retire_plugin(app, &id).await
    }, || retire_plugin_serial_tasks(state, Some(&id)))
    .await;
    drop(plugin_io);
    discard_install_stage(prepared).await;
    schedule_plugin_sweep(app.clone());
    result
}

async fn install_after_retiring<F, Fut>(
    config: &std::sync::Mutex<config::ConfigManager>,
    prepared: &mut PreparedPluginInstall,
    expected_generation: Option<&str>,
    begin_commit: impl FnOnce() -> Result<(), CommandError>,
    retire: F,
    after_identity_change: impl FnOnce(),
) -> Result<PluginStateSnapshot, CommandError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<(), CommandError>>,
{
    {
        let manager = config.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
        validate_prepared_install(&manager, prepared, expected_generation)?;
        // Reject stale and cancelled work before touching paths or sessions.
        begin_commit()?;
        if let Some(preparation) = &prepared.preparation {
            prepared.stage_guard.0 = preparation.adopt(manager.plugins_dir())
                .map_err(|e| CommandError::Io(format!("接纳已准备插件目录失败: {e}")))?;
        }
    }
    retire().await?;
    // No await after persisting the trust reset: cancellation must not drop the
    // IO gate while a detached blocking task is still replacing executable code.
    tokio::task::block_in_place(|| {
        let mut manager = config.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
        let id = prepared.manifest.id.clone();
        let previous = state_of(manager.get_config(), &id).map(|entry| entry.install_generation.clone());
        let result = install_prepared_ref(&mut manager, prepared, expected_generation);
        if previous.as_deref().is_some_and(|generation| {
            state_of(manager.get_config(), &id).is_none_or(|entry| entry.install_generation != generation)
        }) {
            // Only a durable generation change (including fail-closed recovery)
            // retires serial work; rejection and safe rollback leave it alone.
            after_identity_change();
        }
        result
    })
}

pub(crate) struct PreparedPluginInstall {
    manifest: PluginManifest,
    source_label: &'static str,
    update_url: Option<String>,
    dest: std::path::PathBuf,
    replace_existing: bool,
    stage_guard: TempDirGuard,
    target: Option<DirectoryTarget>,
    preparation: Option<plugin::transaction::PreparationLease>,
}

#[cfg(test)]
fn reset_install_trust(cfg: &mut config::AppConfig, id: &str, source_label: &str) {
    reset_install_trust_with_url(cfg, id, source_label, None);
}

fn reset_install_trust_with_url(
    cfg: &mut config::AppConfig,
    id: &str,
    source_label: &str,
    update_url: Option<&str>,
) {
    if let Some(existing) = cfg.entities.plugin_configs.iter_mut().find(|p| p.id == id) {
        existing.enabled = false;
        existing.trusted_web_granted = false;
        existing.granted_permissions.clear();
        existing.install_generation = uuid::Uuid::new_v4().to_string();
        existing.installed_at =
            Some(now_unix_secs().max(existing.installed_at.unwrap_or(0).saturating_add(1)));
        existing.source = Some(source_label.into());
        existing.update_url = update_url.map(str::to_owned);
    } else {
        cfg.entities.plugin_configs.push(config::PluginConfigEntry {
            id: id.into(),
            enabled: false,
            trusted_web_granted: false,
            granted_permissions: Vec::new(),
            install_generation: uuid::Uuid::new_v4().to_string(),
            installed_at: Some(now_unix_secs()),
            source: Some(source_label.into()),
            update_url: update_url.map(str::to_owned),
        });
    }
}

fn restore_install_config(
    manager: &mut config::ConfigManager,
    old: config::AppConfig,
) -> Result<(), CommandError> {
    manager
        .set_config(old)
        .map_err(|e| CommandError::Config(format!("恢复插件状态失败，保持禁用: {e}")))
}

fn persist_install_trust_reset(manager: &mut config::ConfigManager) -> Result<(), CommandError> {
    manager
        .save()
        .map_err(|e| CommandError::Config(format!("安装前清除插件授权失败: {e}")))?;
    manager
        .save_safe_backup()
        .map_err(|e| CommandError::Config(format!("安装前更新禁用状态备份失败: {e}")))
}

pub(crate) fn prepared_manifest(prepared: &PreparedPluginInstall) -> &PluginManifest {
    &prepared.manifest
}

fn validate_prepared_install(
    manager: &config::ConfigManager,
    prepared: &PreparedPluginInstall,
    expected_generation: Option<&str>,
) -> Result<(), CommandError> {
    // A replacement install may run after the user reviewed a specific install
    // generation. Marketplace updates always require that identity; a local
    // strictly newer install may omit it for backwards compatibility.
    let existing = state_of(manager.get_config(), &prepared.manifest.id);
    if existing.is_some()
        && prepared.source_label == "marketplace"
        && expected_generation.is_none_or(str::is_empty)
    {
        return Err(CommandError::Other(
            "更新已安装插件必须携带 expectedGeneration".into(),
        ));
    }
    match (existing, expected_generation) {
        (Some(entry), Some(expected)) if !expected.is_empty() && entry.install_generation == expected => {}
        (Some(_), Some(_)) | (None, Some(_)) => {
            return Err(CommandError::Other(
                "插件安装版本已变化，请重新检查插件后操作".into(),
            ));
        }
        (Some(_), None) if prepared.replace_existing => {
            return Err(CommandError::Other(
                "替换安装必须携带已审阅的插件安装代次".into(),
            ));
        }
        (Some(_), None) | (None, None) => {}
    }
    ensure_ordinary_dir_if_present(&prepared.dest)?;
    if let Some(target) = &prepared.target {
        if prepared.dest != manager.plugins_dir().join(&prepared.manifest.id) ||
            &DirectoryTarget::read(&prepared.dest, existing.map(|entry| entry.install_generation.clone()))? != target {
            return Err(directory_target_changed());
        }
        validate_local_version(&prepared.manifest, target.version.as_deref(), prepared.replace_existing)?;
    }
    Ok(())
}

#[cfg(test)]
fn install_prepared(
    manager: &mut config::ConfigManager,
    mut prepared: PreparedPluginInstall,
    expected_generation: Option<&str>,
) -> Result<PluginStateSnapshot, CommandError> {
    install_prepared_ref(manager, &mut prepared, expected_generation)
}

fn install_prepared_ref(
    manager: &mut config::ConfigManager,
    prepared: &mut PreparedPluginInstall,
    expected_generation: Option<&str>,
) -> Result<PluginStateSnapshot, CommandError> {
    validate_prepared_install(manager, prepared, expected_generation)?;
    let old = manager.get_config().clone();
    reset_install_trust_with_url(
        manager.get_config_mut(),
        &prepared.manifest.id,
        prepared.source_label,
        prepared.update_url.as_deref(),
    );
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
    if let Err(error) = commit_plugin_install(prepared, manager.get_config().revision) {
        plugin::transaction::recover(manager.plugins_dir(), manager.get_config())
            .map_err(|e| CommandError::Io(format!("安装恢复失败，保留事务: {e}")))?;
        return Err(error);
    }
    plugin::transaction::recover(manager.plugins_dir(), manager.get_config())
        .map_err(|e| CommandError::Io(format!("安装清理失败，保留事务: {e}")))?;
    revoke_plugin_directory_grants(&prepared.manifest.id);
    log::info!(
        "Plugin installed: {} v{} ({})",
        prepared.manifest.id,
        prepared.manifest.version,
        prepared.source_label
    );
    Ok(snapshot(manager))
}

#[derive(Debug, PartialEq, Eq)]
struct DirectoryTarget {
    generation: Option<String>,
    exists: bool,
    version: Option<String>,
}

impl DirectoryTarget {
    fn read(dest: &Path, generation: Option<String>) -> Result<Self, CommandError> {
        let exists = match std::fs::symlink_metadata(dest) {
            Ok(meta) if meta.is_dir() && !plugin::is_link_or_reparse(&meta) => true,
            Ok(_) => return Err(CommandError::Other("插件安装目标不是普通目录".into())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(CommandError::Io(format!("插件安装目标不可达: {error}"))),
        };
        // Only parse the bounded manifest. Do not load view resources or stage
        // directory contents while the plugin control gate is held.
        let version = if exists { plugin::load_manifest_lite(dest).ok().map(|manifest| manifest.version) } else { None };
        Ok(Self { generation, exists, version })
    }
}

fn directory_target_changed() -> CommandError {
    CommandError::Other("插件安装版本已变化，请重新检查插件后操作".into())
}

fn validate_local_version(manifest: &PluginManifest, version: Option<&str>, replace_existing: bool) -> Result<(), CommandError> {
    if let Some(version) = version.filter(|version| !replace_existing && !plugin::version_greater(&manifest.version, version)) {
        return Err(CommandError::Other(format!(
            "plugin_replace_confirmation_required: 插件 {} 已安装（版本 {}），源版本 {} 不是更高版本；替换安装会保留私有数据但需要重新授权",
            manifest.id, version, manifest.version
        )));
    }
    Ok(())
}

fn validate_directory_source_location(src: &Path, root: &Path) -> Result<(), CommandError> {
    let source = src.canonicalize().map_err(|e| CommandError::Io(format!("源插件目录不可达: {e}")))?;
    let root = root.canonicalize().map_err(|e| CommandError::Io(format!("插件根目录不可达: {e}")))?;
    if root.starts_with(source) {
        return Err(CommandError::Other("源插件目录不能包含插件安装根目录".into()));
    }
    Ok(())
}

async fn prepare_directory_before_commit(
    config: &Mutex<config::ConfigManager>,
    gate: &tokio::sync::Mutex<()>,
    task: &Arc<DirectoryInstallTask>,
    source_path: String,
    replace_existing: bool,
    expected_generation: Option<&str>,
    progress: DirectoryProgress,
) -> Result<PreparedPluginInstall, CommandError> {
    // Snapshot identities at admission, before slow source IO. A first install
    // must not turn into an unattended replacement if an ID appears meanwhile.
    let initial_generations = {
        let manager = config.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
        manager.get_config().entities.plugin_configs.iter().map(|entry| {
            (entry.id.clone(), entry.install_generation.clone())
        }).collect::<std::collections::HashMap<_, _>>()
    };
    progress(PluginInstallProgress::Scanning);
    let source = std::path::PathBuf::from(source_path);
    let probe = source.clone();
    let manifest = tokio::task::spawn_blocking(move || {
        plugin::load_manifest_lite(&probe)
            .map_err(|e| CommandError::Other(format!("插件源必须是包含有效 manifest 的普通目录: {e}")))
    }).await.map_err(|e| CommandError::Other(format!("检查插件目录失败: {e}")))??;

    let (root, dest, target) = {
        let _gate = tokio::select! {
            _ = task.wait_for_cancel() => return Err(install_cancelled()),
            result = acquire_plugin_gate(gate, PLUGIN_IO_WAIT) => result?,
        };
        let (root, generation) = {
            let manager = config.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
            (manager.plugins_dir().to_path_buf(), state_of(manager.get_config(), &manifest.id).map(|entry| entry.install_generation.clone()))
        };
        if generation.as_ref() != initial_generations.get(&manifest.id) ||
            expected_generation.is_some_and(|expected| expected.is_empty() || generation.as_deref() != Some(expected)) {
            return Err(directory_target_changed());
        }
        let dest = plugin_dir(&root, &manifest.id)?;
        let target = DirectoryTarget::read(&dest, generation)?;
        validate_local_version(&manifest, target.version.as_deref(), replace_existing)?;
        (root, dest, target)
    };

    let task = task.clone();
    tokio::task::spawn_blocking(move || {
        let cancelled = || task.is_cancelled();
        let progress = |event| progress(event);
        let control = CopyControl { cancelled: &cancelled, progress: &progress };
        control.check().map_err(map_copy_failure)?;
        std::fs::create_dir_all(&root).map_err(|e| CommandError::Io(format!("创建插件目录失败: {e}")))?;
        validate_directory_source_location(&source, &root)?;
        let preparation = plugin::transaction::PreparationLease::reserve(&root)
            .map_err(|e| CommandError::Io(format!("登记插件准备目录失败: {e}")))?;
        let stage_guard = TempDirGuard(preparation.path().to_path_buf());
        copy_stage_contents(&source, &stage_guard.0, &manifest, None, control)?;
        plugin::transaction::sync_tree(&stage_guard.0, &|| control.check()).map_err(map_copy_failure)?;
        control.check().map_err(map_copy_failure)?;
        Ok(PreparedPluginInstall { manifest, source_label: "dir", update_url: None, dest,
            replace_existing, stage_guard, target: Some(target), preparation: Some(preparation) })
    }).await.map_err(|e| CommandError::Other(format!("安装暂存 join 失败: {e}")))?
}

/// Fixture helper for the synchronous preparation pipeline.
#[cfg(test)]
fn prepare_plugin_install(
    source_path: &str,
    root: &Path,
    replace_existing: bool,
) -> Result<PreparedPluginInstall, CommandError> {
    prepare_plugin_install_with_metadata(source_path, root, replace_existing, None, None)
}

/// Prepare an install while carrying provenance for a marketplace download.
/// The caller must hold the plugin IO gate before invoking this function.
pub(crate) fn prepare_plugin_install_with_metadata(
    source_path: &str,
    root: &Path,
    replace_existing: bool,
    source_label_override: Option<&'static str>,
    update_url: Option<String>,
) -> Result<PreparedPluginInstall, CommandError> {
    prepare_plugin_install_controlled(source_path, root, replace_existing, source_label_override, update_url, CopyControl::SILENT, PrepareFormat::Any)
}

fn map_copy_failure(error: std::io::Error) -> CommandError {
    if error.to_string() == source_copy::CANCELLED { return install_cancelled(); }
    match error.kind() {
        std::io::ErrorKind::InvalidData => CommandError::Other(format!("插件源目录校验失败: {error}")),
        std::io::ErrorKind::StorageFull => CommandError::Io(format!("插件暂存磁盘空间不足: {error}")),
        _ => CommandError::Io(format!("复制插件目录失败: {error}")),
    }
}

#[derive(Clone, Copy)]
enum PrepareFormat { Any, Archive, #[cfg(test)] Directory }

fn prepare_plugin_install_controlled(
    source_path: &str,
    root: &Path,
    replace_existing: bool,
    source_label_override: Option<&'static str>,
    update_url: Option<String>,
    control: CopyControl<'_>,
    format: PrepareFormat,
) -> Result<PreparedPluginInstall, CommandError> {
    control.check().map_err(map_copy_failure)?;
    let src = Path::new(source_path);

    // --- 阶段 1：把源归一化为「插件目录」引用 ---
    // zip 源：解到系统临时目录（独立命名防冲突），定位顶层插件目录。
    // **guard 在 create_dir_all 成功后立即绑定**——extract_plugin_zip 及其后
    // 任何 `?` 失败路径（find_single_plugin_dir / manifest 校验）都经 RAII 清理，
    // 不泄漏 uuid 临时目录（advisory B：晚绑定会让解压失败泄漏）。
    let mut _tmp_guard: Option<TempDirGuard> = None;
    let archive = src.is_file() && src.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("zip"));
    if matches!(format, PrepareFormat::Archive) && !archive {
        return Err(CommandError::Other("请选择普通 ZIP 插件包".into()));
    }
    #[cfg(test)]
    if matches!(format, PrepareFormat::Directory) && !src.is_dir() {
        return Err(CommandError::Other("请选择插件目录，不是 ZIP".into()));
    }
    let tmp_holder: Option<std::path::PathBuf> = if archive {
        // This is our trusted extraction location, not the user's chosen
        // directory source. Resolve OS temp aliases before no-follow traversal.
        let tmp_parent = std::env::temp_dir()
            .canonicalize()
            .map_err(|e| CommandError::Io(format!("系统临时目录不可达: {e}")))?;
        let tmp_root = tmp_parent.join(format!("hypercom_plugin_install_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp_root)
            .map_err(|e| CommandError::Io(format!("创建临时目录失败: {e}")))?;
        // 立即绑定 guard：目录一建好就纳入 RAII 清理范围。
        _tmp_guard = Some(TempDirGuard(tmp_root.clone()));
        plugin::extract_plugin_zip(src, &tmp_root)
            .map_err(|e| CommandError::Other(format!("解压插件 zip 失败: {e}")))?;
        Some(
            tmp_root
                .canonicalize()
                .map_err(|e| CommandError::Io(format!("插件解压目录不可达: {e}")))?,
        )
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
    let source_label: &'static str = source_label_override
        .unwrap_or(if tmp_holder.is_some() { "zip" } else { "dir" });

    std::fs::create_dir_all(root)
        .map_err(|e| CommandError::Io(format!("创建插件目录失败: {e}")))?;
    if tmp_holder.is_none() { validate_directory_source_location(&src_plugin_dir, root)?; }

    let dest = plugin_dir(root, &manifest.id)?;

    let previous = plugin::load_manifest_from_dir(&dest).ok();
    validate_local_version(&manifest, previous.as_ref().map(|item| item.version.as_str()), replace_existing)?;
    let stage_guard = TempDirGuard(root.join(format!(".staging-{}", uuid::Uuid::new_v4())));
    let archive_limit = tmp_holder.as_ref().map(|_| plugin::MAX_ZIP_UNCOMPRESSED_BYTES);
    copy_stage_contents(&src_plugin_dir, &stage_guard.0, &manifest, archive_limit, control)?;
    Ok(PreparedPluginInstall { manifest, source_label, update_url, dest, replace_existing, stage_guard,
        target: None, preparation: None })
}

fn copy_stage_contents(
    src: &Path, staging: &Path, manifest: &PluginManifest, archive_limit: Option<u64>, control: CopyControl<'_>,
) -> Result<(), CommandError> {
    copy_plugin_source(src, staging, archive_limit, control).map_err(map_copy_failure)?;
    (control.progress)(PluginInstallProgress::Validating);
    control.check().map_err(map_copy_failure)?;
    let staged_manifest = plugin::load_manifest_from_dir(staging)
        .map_err(|e| CommandError::Other(format!("暂存 manifest 校验失败: {e}")))?;
    if &staged_manifest != manifest {
        return Err(CommandError::Other(
            "复制期间插件 manifest 已变化，拒绝安装".into(),
        ));
    }
    // 根入口可缺省（纯 HTML 插件）；只有声明了 entry 才要求文件存在。
    if !manifest.entry.trim().is_empty() {
        let entry_rel = sanitize_asset_path(&manifest.entry)?;
        let staged_entry = staging.join(&entry_rel);
        let staged_root = staging
            .canonicalize()
            .map_err(|e| CommandError::Io(format!("暂存目录不可达: {e}")))?;
        let staged_entry_canon = staged_entry
            .canonicalize()
            .map_err(|e| CommandError::Other(format!("manifest entry 不存在: {e}")))?;
        if !staged_entry_canon.starts_with(&staged_root)
            || !staged_entry_canon.is_file()
            || std::fs::symlink_metadata(&staged_entry)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(true)
        {
            return Err(CommandError::Other(
                "manifest entry 必须是暂存目录内的普通文件".into(),
            ));
        }
        if is_data_path(&entry_rel) {
            return Err(CommandError::Other(
                "manifest entry 不得位于 data/ 私有区".into(),
            ));
        }
    }
    // Private storage is exclusively owned by the user, even on first install.
    remove_path_if_exists(&staging.join("data"))
        .map_err(|e| CommandError::Io(format!("移除安装包 data/ 失败: {e}")))?;
    control.check().map_err(map_copy_failure)
}

/// Reject a symlink/junction/other non-directory that replaced the plugin root
/// after `plugin_dir` validated it (same-user swap race before rename).
fn ensure_ordinary_dir_if_present(path: &std::path::Path) -> Result<(), CommandError> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !plugin::is_link_or_reparse(&meta) => Ok(()),
        Ok(_) => Err(CommandError::Other(format!(
            "插件目录不是普通目录: {}",
            path.display()
        ))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(CommandError::Io(format!("插件目录不可达: {e}"))),
    }
}

fn commit_plugin_install(
    prepared: &mut PreparedPluginInstall,
    revision: u64,
) -> Result<(Option<std::path::PathBuf>, plugin::transaction::Transaction), CommandError> {
    let dest = prepared.dest.clone();
    let staging = prepared.stage_guard.0.clone();
    let root = dest.parent().unwrap();
    ensure_ordinary_dir_if_present(&dest)?;
    let mut transaction = if prepared.preparation.is_some() {
        plugin::transaction::Transaction::install_synced(root, &prepared.manifest.id, &staging, revision)
    } else {
        plugin::transaction::Transaction::install(root, &prepared.manifest.id, &staging, revision)
    }.map_err(|e| CommandError::Io(format!("持久化安装事务失败: {e}")))?;
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
    Ok((
        result.map_err(|e| CommandError::Io(format!("安装事务失败: {e}")))?,
        transaction,
    ))
}

#[cfg(test)]
fn install_plugin_fs_stage(
    source_path: &str,
    root: &Path,
) -> Result<(String, String, &'static str, Option<std::path::PathBuf>), CommandError> {
    let mut prepared = prepare_plugin_install(source_path, root, true)?;
    let (backup, transaction) = commit_plugin_install(&mut prepared, 0)?;
    transaction
        .finish(root)
        .map_err(|e| CommandError::Io(e.to_string()))?;
    Ok((
        prepared.manifest.id.clone(),
        prepared.manifest.version.clone(),
        prepared.source_label,
        backup,
    ))
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
    expected_generation: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginStateSnapshot, CommandError> {
    require_main_window(&window)?;
    plugin::validate_plugin_id(&id).map_err(CommandError::Other)?;
    let plugin_io = acquire_plugin_io(&state).await?;
    {
        let manager = state.config_manager.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
        require_generation(manager.get_config(), &id, &expected_generation)?;
    }
    let result = tokio::task::block_in_place(|| {
        let mut manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        uninstall_with_manager(&mut manager, &id, Some(&expected_generation))
    });
    // Even a backup/transaction-cleanup error may follow a durable uninstall.
    // Retire native sessions and remove the browser profile whenever it committed.
    let committed = {
        let manager = state.config_manager.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
        state_of(manager.get_config(), &id).is_none()
    };
    if committed {
        retire_plugin_serial_tasks(&state, Some(&id));
        retire_plugin_file_io(&state, &id);
        state.plugin_http.cancel_plugin(&id);
        state.plugin_shell.cancel_plugin(&id);
        state
            .lease_registry
            .release_by_owner_prefix(Some(&state.event_hub), &format!("plugin:{id}:"))
            .await;
        state
            .control_hub
            .plugin_bridge()
            .retire_plugin(Some(window.app_handle()), &id);
        // The plugin is already gone from config. A stuck native teardown may
        // still freeze the UI thread, so the view runtime bounds it internally:
        // report the failure, keep the command responsive, and retry later.
        if let Err(error) = plugin::view_runtime::retire_plugin(window.app_handle(), &id).await {
            log::warn!("Plugin {id} was uninstalled, but closing its views failed: {error}");
        }
        let directory = {
            let manager = state.config_manager.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
            plugin::web_data_dir(manager.plugins_dir(), &id, &expected_generation)
                .map_err(CommandError::Other)?
        };
        if let Err(error) = plugin::view_runtime::clear_web_data(window.app_handle(), &directory).await {
            log::warn!("Plugin {id} was uninstalled, but clearing its web data failed: {error}");
        }
        log::info!("Plugin uninstalled: {id}");
    }
    // Release the gate before the detached sweep tries to take it.
    drop(plugin_io);
    schedule_plugin_sweep(window.app_handle().clone());
    match result {
        Ok(snapshot) => Ok(snapshot),
        Err(error) if committed => {
            // The config commit already removed the plugin: a post-commit
            // cleanup failure must not be reported as a failed uninstall.
            log::warn!("Plugin {id} was uninstalled with a cleanup error: {error}");
            let manager = state.config_manager.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
            Ok(snapshot(&manager))
        }
        Err(error) => Err(error),
    }
}

fn uninstall_with_manager(
    manager: &mut config::ConfigManager,
    id: &str,
    expected_generation: Option<&str>,
) -> Result<PluginStateSnapshot, CommandError> {
    if let Some(expected) = expected_generation {
        require_generation(manager.get_config(), id, expected)?;
    }
    let root = manager.plugins_dir().to_path_buf();
    std::fs::create_dir_all(&root).map_err(|e| CommandError::Io(e.to_string()))?;
    let dest = plugin_dir(&root, id)?;
    ensure_ordinary_dir_if_present(&dest)?;
    let revision = manager
        .get_config()
        .revision
        .checked_add(1)
        .ok_or_else(|| CommandError::Config("Config revision overflow".into()))?;
    let mut transaction = plugin::transaction::Transaction::uninstall(&root, id, revision)
        .map_err(|e| CommandError::Io(e.to_string()))?;
    let old_config = manager.get_config().clone();
    let result = (|| -> Result<(), CommandError> {
        transaction
            .phase(&root, "remove")
            .map_err(|e| CommandError::Io(e.to_string()))?;
        if dest.exists() {
            plugin::transaction::rename(&root, &dest, &transaction.backup(&root))
                .map_err(|e| CommandError::Io(e.to_string()))?;
        }
        transaction
            .phase(&root, "config-commit")
            .map_err(|e| CommandError::Io(e.to_string()))?;
        manager
            .get_config_mut()
            .entities
            .plugin_configs
            .retain(|entry| entry.id != id);
        if let Err(error) = manager.save() {
            *manager.get_config_mut() = old_config;
            return Err(CommandError::Config(error.to_string()));
        }
        // Once the primary no longer contains this identity, revoke grants
        // exactly once, even if safe backup or transaction recovery now fails.
        revoke_plugin_directory_grants(id);
        manager
            .save_safe_backup()
            .map_err(|e| CommandError::Config(e.to_string()))?;
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

struct CommittedPluginState {
    snapshot: PluginStateSnapshot,
    persistence_tail: Result<(), CommandError>,
}

impl CommittedPluginState {
    fn finish(self, view_result: Result<(), CommandError>) -> Result<PluginStateSnapshot, CommandError> {
        if let Err(error) = self.persistence_tail {
            if let Err(view_error) = view_result {
                log::warn!("Plugin configuration committed, but view cleanup also failed: {view_error}");
            }
            return Err(error);
        }
        view_result?;
        Ok(self.snapshot)
    }
}

/// The outer result means whether the primary state committed. Once it has,
/// revoke the corresponding runtime capabilities while authorization still
/// shares the config lock, even if the recovery barrier cannot be finalized.
fn commit_plugin_trust_change(
    manager: &mut config::ConfigManager,
    id: &str,
    save_error_context: &str,
    change: impl FnOnce(&mut config::PluginConfigEntry),
    after_commit: impl FnOnce(&config::PluginConfigEntry, &config::PluginConfigEntry),
) -> Result<CommittedPluginState, CommandError> {
    let old_config = manager.get_config().clone();
    let previous = state_of(&old_config, id)
        .ok_or_else(|| CommandError::Other(format!("插件未安装: {id}")))?;
    manager
        .begin_plugin_recovery_marker()
        .map_err(|e| CommandError::Config(format!("写入插件信任恢复标记失败: {e}")))?;
    let entry = manager.get_config_mut().entities.plugin_configs.iter_mut()
        .find(|entry| entry.id == id).expect("checked plugin entry");
    change(entry);
    if let Err(error) = manager.save() {
        *manager.get_config_mut() = old_config;
        return Err(CommandError::Config(format!("{save_error_context}: {error}")));
    }
    let committed = state_of(manager.get_config(), id).expect("committed plugin entry");
    after_commit(previous, committed);
    let persistence_tail = manager.save_safe_backup()
        .map_err(|e| CommandError::Config(format!("保存插件安全备份失败，已保留恢复标记: {e}")))
        .and_then(|()| manager.clear_plugin_recovery_marker()
            .map_err(|e| CommandError::Config(format!("清除插件信任恢复标记失败: {e}"))));
    Ok(CommittedPluginState { snapshot: snapshot(manager), persistence_tail })
}

fn retire_disabled_plugin_capabilities(state: &AppState, id: &str) {
    retire_plugin_serial_tasks(state, Some(id));
    retire_plugin_file_io(state, id);
    state.plugin_http.cancel_plugin(id);
    state.plugin_shell.cancel_plugin(id);
    revoke_plugin_directory_grants(id);
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
    let _plugin_io = acquire_plugin_io(&state).await?;
    {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        require_generation(manager.get_config(), &id, &expected_generation)?;
    }
    // Enabling is a package admission boundary, not just a config toggle:
    // validate all declared view resources before committing enabled=true. Keep
    // the potentially expensive resource walk outside config_manager, then
    // recheck the generation under the lock before persisting the state.
    let enable_manifest = if enabled {
        let manifest_dir = {
            let manager = state
                .config_manager
                .lock()
                .map_err(|e| CommandError::Lock(e.to_string()))?;
            require_generation(manager.get_config(), &id, &expected_generation)?;
            plugin_dir(manager.plugins_dir(), &id)?
        };
        let manifest = plugin::load_manifest_from_dir(&manifest_dir)
            .map_err(|e| CommandError::Other(format!("插件 manifest 不可读: {e}")))?;
        if manifest.id != id {
            return Err(CommandError::Other("manifest id 与插件目录不一致".into()));
        }
        Some(manifest)
    } else {
        None
    };
    let result = {
        let mut manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        require_generation(manager.get_config(), &id, &expected_generation)?;
        if enabled {
            let manifest = enable_manifest
                .as_ref()
                .ok_or_else(|| CommandError::Other("插件 manifest 校验状态丢失".into()))?;
            let entry = state_of(manager.get_config(), &id)
                .ok_or_else(|| CommandError::Other(format!("插件未安装: {id}")))?;
            require_trusted_web_consent(manifest, entry)?;
        }
        commit_plugin_trust_change(&mut manager, &id, "保存插件状态失败", |entry| {
            entry.enabled = enabled;
        }, |_, _| {
            if !enabled {
                retire_disabled_plugin_capabilities(&state, &id);
            }
        })?
    };
    // Don’t retire views on primary failure; do retire them even if the backup
    // or recovery marker could not be finalized after the primary committed.
    if !enabled {
        state
            .lease_registry
            .release_by_owner_prefix(Some(&state.event_hub), &format!("plugin:{id}:"))
            .await;
        state
            .control_hub
            .plugin_bridge()
            .retire_plugin(Some(window.app_handle()), &id);
        if let Err(e) = plugin::view_runtime::retire_plugin(window.app_handle(), &id).await {
            log::warn!("Failed to retire disabled plugin views for {id}: {e}");
        }
    }
    log::info!(
        "Plugin {} {}",
        id,
        if enabled { "enabled" } else { "disabled" }
    );
    result.finish(Ok(()))
}

/// Separate consent is never inferred from ordinary permission grants.
#[tauri::command]
pub async fn set_plugin_trusted_web(
    id: String,
    trusted: bool,
    expected_generation: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginStateSnapshot, CommandError> {
    require_main_window(&window)?;
    plugin::validate_plugin_id(&id).map_err(CommandError::Other)?;
    let _plugin_io = acquire_plugin_io(&state).await?;
    let result = {
        let mut manager = state.config_manager.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
        require_generation(manager.get_config(), &id, &expected_generation)?;
        if trusted {
            let manifest = plugin::load_manifest_lite(&plugin_dir(manager.plugins_dir(), &id)?)
                .map_err(CommandError::Other)?;
            if manifest.id != id || !manifest.has_trusted_web_views() {
                return Err(CommandError::Other("插件未声明可信网页视图".into()));
            }
        }
        commit_plugin_trust_change(&mut manager, &id, "保存网页信任状态失败", |entry| {
            entry.trusted_web_granted = trusted;
            if !trusted {
                entry.enabled = false;
            }
        }, |_, _| {
            if !trusted {
                retire_disabled_plugin_capabilities(&state, &id);
            }
        })?
    };
    let view_result = if !trusted {
        state
            .lease_registry
            .release_by_owner_prefix(Some(&state.event_hub), &format!("plugin:{id}:"))
            .await;
        state
            .control_hub
            .plugin_bridge()
            .retire_plugin(Some(window.app_handle()), &id);
        plugin::view_runtime::retire_plugin(window.app_handle(), &id).await
            .map_err(|e| CommandError::Other(format!("网页信任已撤销，但关闭视图失败: {e}")))
    } else {
        Ok(())
    };
    result.finish(view_result)
}

#[tauri::command]
pub async fn clear_plugin_web_data(
    id: String,
    expected_generation: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginStateSnapshot, CommandError> {
    require_main_window(&window)?;
    plugin::validate_plugin_id(&id).map_err(CommandError::Other)?;
    let _plugin_io = acquire_plugin_io(&state).await?;
    let (directory, result) = {
        let manager = state.config_manager.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
        require_generation(manager.get_config(), &id, &expected_generation)?;
        if state_of(manager.get_config(), &id).unwrap().enabled {
            return Err(CommandError::Other("请先禁用插件再清除网页数据".into()));
        }
        (
            plugin::web_data_dir(manager.plugins_dir(), &id, &expected_generation)
                .map_err(CommandError::Other)?,
            snapshot(&manager),
        )
    };
    plugin::view_runtime::retire_plugin(window.app_handle(), &id).await?;
    plugin::view_runtime::clear_web_data(window.app_handle(), &directory).await?;
    Ok(result)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SerialAuthorityLoss { None, Files, All }

fn serial_authority_loss(before: &[String], after: &[String]) -> SerialAuthorityLoss {
    let revoked = |permission: &str| {
        before.iter().any(|item| item == permission) && !after.iter().any(|item| item == permission)
    };
    if revoked("serial:send") { SerialAuthorityLoss::All }
    else if revoked("fs:open") { SerialAuthorityLoss::Files }
    else { SerialAuthorityLoss::None }
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
    let _plugin_io = acquire_plugin_io(&state).await?;
    {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        require_generation(manager.get_config(), &id, &expected_generation)?;
    }
    let result = {
        let mut manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        require_generation(manager.get_config(), &id, &expected_generation)?;

        // manifest 权威点：读取声明权限做子集校验。
        let root = manager.plugins_dir().to_path_buf();
        let manifest = plugin::load_manifest_lite(&plugin_dir(&root, &id)?)
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
                return Err(CommandError::Other(format!(
                    "宿主尚未实现权限 {p}，拒绝授予"
                )));
            }
        }

        commit_plugin_trust_change(&mut manager, &id, "保存插件状态失败", |entry| {
            entry.granted_permissions = permissions.clone();
        }, |previous, committed| {
            let granted = &committed.granted_permissions;
            match serial_authority_loss(&previous.granted_permissions, granted) {
                SerialAuthorityLoss::All => retire_plugin_serial_tasks(&state, Some(&id)),
                SerialAuthorityLoss::Files => retire_plugin_serial_file_tasks(&state, &id),
                SerialAuthorityLoss::None => {}
            }
            retire_revoked_file_io(&state.plugin_fs, &id, &previous.granted_permissions, granted);
            if !granted.iter().any(|p| p == "http:request") {
                state.plugin_http.cancel_plugin(&id);
            }
            if !granted.iter().any(|p| p == "shell:execute") {
                state.plugin_shell.cancel_plugin(&id);
            } else if previous.granted_permissions.iter().any(|p| p == "serial:control") && !granted.iter().any(|p| p == "serial:control") {
                state.plugin_shell.cancel_serial_loans(&id);
            }
            if !granted.iter().any(|p| matches!(p.as_str(), "fs:open-dir" | "fs:write-dir" | "fs:export-dir")) {
                revoke_plugin_directory_grants(&id);
            }
        })?
    };
    if !permissions.iter().any(|p| p == "serial:control") {
        state
            .lease_registry
            .release_by_owner_prefix(Some(&state.event_hub), &format!("plugin:{id}:"))
            .await;
    }
    if !permissions.iter().any(|p| p == "control:expose") {
        state
            .control_hub
            .plugin_bridge()
            .retire_plugin(Some(window.app_handle()), &id);
    }
    let view_result = plugin::view_runtime::retire_denied(window.app_handle(), &id, &permissions).await;
    let snapshot = result.finish(view_result)?;
    log::info!("Plugin {id} permissions updated");
    Ok(snapshot)
}

#[derive(Clone, Copy, Default, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginFileFormat {
    #[default]
    Text,
    Binary,
}

fn encode_asset(bytes: Vec<u8>, format: PluginFileFormat) -> String {
    match format {
        PluginFileFormat::Binary => base64::engine::general_purpose::STANDARD.encode(bytes),
        PluginFileFormat::Text => String::from_utf8(bytes)
            .unwrap_or_else(|error| String::from_utf8_lossy(&error.into_bytes()).into_owned()),
    }
}

pub(crate) struct LegacyFileAuthority(tokio::sync::watch::Sender<bool>);

impl LegacyFileAuthority {
    pub(crate) fn subscribe(&self) -> tokio::sync::watch::Receiver<bool> { self.0.subscribe() }
}
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub(super) enum LegacyFileScope {
    Bootstrap,
    Assets,
    Data,
    Storage,
    EitherStorage,
    DirectoryRead,
    DirectoryWrite,
    DirectoryExport,
}

impl LegacyFileScope {
    fn remains_granted(self, granted: &[String]) -> bool {
        let has = |permission| granted.iter().any(|item| item == permission);
        match self {
            Self::Bootstrap => true,
            Self::Assets => has("fs:assets"),
            Self::Data => has("fs:storage"),
            Self::Storage => has("storage"),
            Self::EitherStorage => has("fs:storage") || has("storage"),
            Self::DirectoryRead => has("fs:open-dir"),
            Self::DirectoryWrite => has("fs:write-dir"),
            Self::DirectoryExport => has("fs:export-dir"),
        }
    }
}

type LegacyPluginAuthorities = std::collections::HashMap<LegacyFileScope, std::sync::Weak<LegacyFileAuthority>>;
type LegacyAuthorityMap = std::collections::HashMap<String, LegacyPluginAuthorities>;
static LEGACY_FILE_AUTHORITIES: std::sync::LazyLock<std::sync::Mutex<LegacyAuthorityMap>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

pub(super) fn legacy_file_authority(
    id: &str, scope: LegacyFileScope,
) -> Result<std::sync::Arc<LegacyFileAuthority>, CommandError> {
    let mut authorities = LEGACY_FILE_AUTHORITIES.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
    authorities.retain(|_, scopes| {
        scopes.retain(|_, authority| authority.strong_count() > 0);
        !scopes.is_empty()
    });
    let scopes = authorities.entry(id.to_string()).or_default();
    if let Some(authority) = scopes.get(&scope).and_then(std::sync::Weak::upgrade) { return Ok(authority); }
    let (cancel, _) = tokio::sync::watch::channel(false);
    let authority = std::sync::Arc::new(LegacyFileAuthority(cancel));
    scopes.insert(scope, std::sync::Arc::downgrade(&authority));
    Ok(authority)
}

pub(crate) fn require_live_file_authority(authority: &LegacyFileAuthority) -> Result<(), CommandError> {
    if *authority.0.borrow() { Err(CommandError::Other("插件文件请求已取消".into())) } else { Ok(()) }
}

fn cancel_legacy_file_authority(id: &str) {
    if let Ok(mut authorities) = LEGACY_FILE_AUTHORITIES.lock() {
        if let Some(scopes) = authorities.remove(id) {
            for authority in scopes.into_values().filter_map(|weak| weak.upgrade()) {
                authority.0.send_replace(true);
            }
        }
    }
}

fn retire_revoked_file_io(registry: &super::plugin_fs::PluginFsRegistry, id: &str, previous: &[String], granted: &[String]) {
    registry.revoke_read_permissions(id, previous, granted);
    if let Ok(mut authorities) = LEGACY_FILE_AUTHORITIES.lock() {
        if let Some(scopes) = authorities.get_mut(id) {
            scopes.retain(|scope, authority| {
                if scope.remains_granted(previous) && !scope.remains_granted(granted) {
                    if let Some(authority) = authority.upgrade() {
                        authority.0.send_replace(true);
                    }
                    false
                } else {
                    true
                }
            });
        }
    }
}

pub(crate) fn retire_plugin_file_io(state: &AppState, id: &str) {
    state.plugin_fs.invalidate_plugin(id);
    cancel_legacy_file_authority(id);
}

pub(crate) fn retire_all_plugin_file_io(state: &AppState) {
    state.plugin_fs.invalidate_all();
    if let Ok(mut authorities) = LEGACY_FILE_AUTHORITIES.lock() {
        for authority in authorities.drain().flat_map(|(_, scopes)| scopes.into_values())
            .filter_map(|weak| weak.upgrade())
        {
            authority.0.send_replace(true);
        }
    }
}

fn data_file_scope(manifest: &PluginManifest, rel: &Path) -> LegacyFileScope {
    if rel == Path::new("data/state.json") && manifest.permissions.iter().any(|p| p == "storage") {
        if manifest.permissions.iter().any(|p| p == "fs:storage") {
            LegacyFileScope::EitherStorage
        } else {
            LegacyFileScope::Storage
        }
    } else {
        LegacyFileScope::Data
    }
}

type AssetAuthority = (std::path::PathBuf, String, std::sync::Arc<LegacyFileAuthority>);

/// An opened file belongs to this installation, never to a later tree at the
/// same pathname. Bootstrap/KV exceptions remain private host capabilities.
fn asset_read_authority(
    state: &AppState,
    id: &str,
    rel: &Path,
    expected_generation: Option<&str>,
) -> Result<AssetAuthority, CommandError> {
    let manager = state.config_manager.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
    let base = plugin_dir(manager.plugins_dir(), id)?;
    let manifest = plugin::load_manifest_lite(&base)
        .map_err(|e| CommandError::Other(format!("插件 manifest 不可读: {e}")))?;
    if manifest.id != id {
        return Err(CommandError::Other("manifest id 与插件目录不一致".into()));
    }
    let entry = state_of(manager.get_config(), id)
        .ok_or_else(|| CommandError::Other(format!("插件未安装: {id}")))?;
    if !entry.enabled || expected_generation.is_some_and(|expected| expected != entry.install_generation) {
        return Err(CommandError::Other(format!("插件已停用或安装身份变化: {id}")));
    }
    let in_data = is_data_path(rel);
    let boot_file = rel == Path::new("manifest.json")
        || (!manifest.entry.trim().is_empty()
            && rel == plugin::sanitize_plugin_rel_path(&manifest.entry).map_err(CommandError::Other)?);
    let permission = if in_data { "fs:storage" } else { "fs:assets" };
    let kv_allowed = rel == Path::new("data/state.json")
        && entry.granted_permissions.iter().any(|p| p == "storage")
        && manifest.permissions.iter().any(|p| p == "storage");
    if !(boot_file && !in_data) && !kv_allowed
        && (!entry.granted_permissions.iter().any(|p| p == permission)
            || !manifest.permissions.iter().any(|p| p == permission))
    {
        return Err(CommandError::Other(format!("插件未授予 {permission}: {id}")));
    }
    let scope = if in_data {
        data_file_scope(&manifest, rel)
    } else if boot_file {
        LegacyFileScope::Bootstrap
    } else {
        LegacyFileScope::Assets
    };
    Ok((base, entry.install_generation.clone(), legacy_file_authority(id, scope)?))
}

async fn read_asset_payload(
    state: &AppState,
    id: &str,
    rel_path: &str,
    expected_generation: Option<&str>,
) -> Result<Option<Vec<u8>>, CommandError> {
    use crate::plugin::io_scheduler::{IoOwner, IoPriority};
    plugin::validate_plugin_id(id).map_err(CommandError::Other)?;
    if rel_path.len() > 4096 {
        return Err(CommandError::Other("插件资产路径超长".into()));
    }
    let rel = sanitize_asset_path(rel_path)?;
    let (_, generation, authority) = asset_read_authority(state, id, &rel, expected_generation)?;
    let cancelled = authority.0.subscribe();
    // Legacy whole-file APIs retain their unbounded result contract. They share
    // IO slots, not the new range transport's bounded byte reservations.
    let permit = state.plugin_fs.scheduler().acquire(
        IoOwner { plugin_id: id.to_string(), session_id: format!("legacy:{generation}") },
        0,
        IoPriority::Interactive,
        cancelled,
    ).await.map_err(CommandError::Other)?;
    let gate = acquire_plugin_io(state).await?;
    require_live_file_authority(&authority)?;
    let (base, _, _) = asset_read_authority(state, id, &rel, Some(&generation))?;
    drop(gate);
    let open_rel = rel.clone();
    let open_authority = authority.clone();
    let (opened, permit) = super::plugin_fs::blocking_open(permit, move || {
        require_live_file_authority(&open_authority)?;
        open_authorized_asset(&base, &open_rel)
    }).await?;
    require_live_file_authority(&authority)?;
    asset_read_authority(state, id, &rel, Some(&generation))?;
    // No global transaction gate spans handle opens, data reads or encoding.
    // The permit stays with each actual blocking task, not its async waiter.
    let task_authority = authority.clone();
    let bytes = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        opened.map(|file| read_open_asset_cancellable(file, Some(&task_authority))).transpose()
    }).await.map_err(|e| CommandError::Other(format!("插件文件读取任务失败: {e}")))??;
    asset_read_authority(state, id, &rel, Some(&generation))?;
    require_live_file_authority(&authority)?;
    Ok(bytes)
}

/// Backwards-compatible whole-file text/base64 endpoint. No business size cap.
#[tauri::command]
pub async fn read_plugin_asset(
    id: String,
    rel_path: String,
    format: Option<PluginFileFormat>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    require_main_window(&window)?;
    let bytes = read_asset_payload(&state, &id, &rel_path, None).await?;
    tokio::task::spawn_blocking(move || bytes.map(|bytes| encode_asset(bytes, format.unwrap_or_default())))
        .await.map_err(|e| CommandError::Other(format!("插件文件编码任务失败: {e}")))
}

/// Raw fast path for existing binary callers. Missing files map to null in the
/// host service, and unsupported IPC may fall back only in that legacy service.
#[tauri::command]
pub async fn read_plugin_asset_raw(
    id: String,
    rel_path: String,
    expected_generation: Option<String>,
    request: tauri::ipc::Request<'_>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, CommandError> {
    require_main_window(&window)?;
    super::plugin_fs::require_raw_transport_for_legacy(&request)?;
    let bytes = read_asset_payload(&state, &id, &rel_path, expected_generation.as_deref()).await?
        .ok_or_else(|| CommandError::Other("PLUGIN_FILE_NOT_FOUND".into()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 写入插件私有区（`data/` 子目录，storage 权限授予后）。
/// 限制：rel_path 首段必须为 `data`——`fs:storage` 权限只覆盖插件私有 KV 区，
/// 资产区（assets/ 与入口）对插件只读（评审 v2 D5）。
/// `content`（含空串）与 `base64`（原始字节）互斥；解码后立即落盘原子替换。
/// 不做任何业务字节上限：大小由用户磁盘与插件自身决定。
#[tauri::command]
pub async fn write_plugin_asset(
    id: String,
    rel_path: String,
    content: Option<String>,
    base64: Option<String>,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    plugin::validate_plugin_id(&id).map_err(CommandError::Other)?;
    if rel_path.len() > 4096 {
        return Err(CommandError::Other("插件资产路径超长".into()));
    }
    let bytes = match (content, base64) {
        (Some(_), Some(_)) => {
            return Err(CommandError::Other(
                "content 与 base64 不能同时提供".into(),
            ));
        }
        (Some(content), None) => content.into_bytes(),
        (None, Some(encoded)) => base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|e| CommandError::Other(format!("base64 非法: {e}")))?,
        (None, None) => {
            return Err(CommandError::Other(
                "写入需要 content 或 base64（空内容也必须显式提供）".into(),
            ));
        }
    };
    use crate::plugin::io_scheduler::{IoOwner, IoPriority};
    let rel = sanitize_asset_path(&rel_path)?;
    if !is_data_path(&rel) {
        return Err(CommandError::Other("插件写入仅限 data/ 私有区（fs:storage 权限范围）".into()));
    }
    let (_, generation, authority) = asset_write_authority(&state, &id, &rel, None)?;
    // Serialise writes to one plugin, not unrelated plugins or lifecycle control.
    let write_guard = asset_write_queue(&id)?.lock_owned().await;
    let cancelled = authority.0.subscribe();
    let permit = state.plugin_fs.scheduler().acquire(
        IoOwner { plugin_id: id.clone(), session_id: format!("legacy:{generation}") },
        0, IoPriority::Interactive, cancelled,
    ).await.map_err(CommandError::Other)?;
    let gate = acquire_plugin_io(&state).await?;
    require_live_file_authority(&authority)?;
    let (base, _, _) = asset_write_authority(&state, &id, &rel, Some(&generation))?;
    let mut prepared = tokio::task::block_in_place(|| {
        let (parent, target) = asset_write_target(&base, &rel, true)?;
        PreparedAssetWrite::new(parent, target).map_err(|e| CommandError::Io(e.to_string()))
    })?;
    drop(gate);
    // The large write and fsync hold neither config_manager nor plugin_io. All
    // owned resources stay with the real task even if its command is abandoned.
    let task_authority = authority.clone();
    let staged = tokio::task::spawn_blocking(move || {
        require_live_file_authority(&task_authority)?;
        prepared.write_cancellable(&bytes, Some(&task_authority))?;
        Ok::<_, CommandError>((prepared, permit, write_guard))
    }).await.map_err(|e| CommandError::Other(format!("插件文件写入任务失败: {e}")))??;
    let (prepared, _permit, _write_guard) = staged;
    let _gate = acquire_plugin_io(&state).await?;
    require_live_file_authority(&authority)?;
    let (base, _, _) = asset_write_authority(&state, &id, &rel, Some(&generation))?;
    tokio::task::block_in_place(|| {
        let (parent, target) = asset_write_target(&base, &rel, false)?;
        if parent != prepared.parent || target != prepared.target {
            return Err(CommandError::Other("插件文件目标在写入期间发生变化".into()));
        }
        prepared.commit().map_err(|e| CommandError::Io(format!("写入资产失败: {e}")))
    })
}

fn asset_write_authority(
    state: &AppState, id: &str, rel: &Path, expected_generation: Option<&str>,
) -> Result<AssetAuthority, CommandError> {
    let manager = state.config_manager.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
    let base = plugin_dir(manager.plugins_dir(), id)?;
    let manifest = plugin::load_manifest_lite(&base)
        .map_err(|e| CommandError::Other(format!("插件 manifest 不可读: {e}")))?;
    let entry = state_of(manager.get_config(), id)
        .ok_or_else(|| CommandError::Other(format!("插件未安装: {id}")))?;
    let storage_allowed = entry.granted_permissions.iter().any(|p| p == "fs:storage")
        && manifest.permissions.iter().any(|p| p == "fs:storage");
    let kv_allowed = rel == Path::new("data/state.json")
        && entry.granted_permissions.iter().any(|p| p == "storage")
        && manifest.permissions.iter().any(|p| p == "storage");
    if manifest.id != id || !entry.enabled || !(storage_allowed || kv_allowed)
        || expected_generation.is_some_and(|expected| expected != entry.install_generation)
    {
        return Err(CommandError::Other(format!("插件未启用、安装身份变化或未授予存储权限: {id}")));
    }
    let scope = data_file_scope(&manifest, rel);
    Ok((base, entry.install_generation.clone(), legacy_file_authority(id, scope)?))
}

fn asset_write_queue(id: &str) -> Result<std::sync::Arc<tokio::sync::Mutex<()>>, CommandError> {
    use std::sync::{Arc, LazyLock, Mutex, Weak};
    static QUEUES: LazyLock<Mutex<std::collections::HashMap<String, Weak<tokio::sync::Mutex<()>>>>> =
        LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));
    let mut queues = QUEUES.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
    queues.retain(|_, queue| queue.strong_count() > 0);
    if let Some(queue) = queues.get(id).and_then(Weak::upgrade) { return Ok(queue); }
    let queue = Arc::new(tokio::sync::Mutex::new(()));
    queues.insert(id.to_string(), Arc::downgrade(&queue));
    Ok(queue)
}

fn asset_write_target(
    base: &Path, rel: &Path, create_parents: bool,
) -> Result<(std::path::PathBuf, std::path::PathBuf), CommandError> {
    let canonical_base = base.canonicalize().map_err(|e| CommandError::Io(e.to_string()))?;
    let mut parent = base.to_path_buf();
    for component in rel.parent().ok_or_else(|| CommandError::Other("文件缺少父目录".into()))?.components() {
        parent.push(component);
        match std::fs::symlink_metadata(&parent) {
            Ok(meta) if meta.is_dir() && !plugin::is_link_or_reparse(&meta) => {}
            Err(e) if create_parents && e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&parent).map_err(|e| CommandError::Io(e.to_string()))?;
            }
            Ok(_) => return Err(CommandError::Other("写入目录含链接、重解析点或非目录".into())),
            Err(e) => return Err(CommandError::Io(e.to_string())),
        }
    }
    let parent = parent.canonicalize().map_err(|e| CommandError::Io(e.to_string()))?;
    if !parent.starts_with(canonical_base) { return Err(CommandError::Other("写入路径越界".into())); }
    let target = parent.join(rel.file_name().ok_or_else(|| CommandError::Other("文件名无效".into()))?);
    match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.is_file() && !plugin::is_link_or_reparse(&meta) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Ok(_) => return Err(CommandError::Other("写入目标不是普通文件".into())),
        Err(e) => return Err(CommandError::Io(e.to_string())),
    }
    Ok((parent, target))
}

fn is_data_path(rel: &Path) -> bool {
    rel.components()
        .next()
        .and_then(|c| c.as_os_str().to_str())
        .map(|first| first.eq_ignore_ascii_case("data"))
        .unwrap_or(false)
}

fn sanitize_asset_path(raw: &str) -> Result<std::path::PathBuf, CommandError> {
    let rel = plugin::sanitize_plugin_rel_path(raw).map_err(CommandError::Other)?;
    // Reject Win32 trailing-dot/space and ADS aliases on every platform. Normalize
    // data's case so DATA/state.json cannot be classified as a public asset.
    let mut out = std::path::PathBuf::new();
    for (index, component) in rel.components().enumerate() {
        let name = component
            .as_os_str()
            .to_str()
            .ok_or_else(|| CommandError::Other("插件路径必须是 UTF-8".into()))?;
        plugin::validate_path_component(name).map_err(CommandError::Other)?;
        out.push(if index == 0 && name.eq_ignore_ascii_case("data") {
            "data"
        } else {
            name
        });
    }
    if out.components().count() > plugin::MAX_PLUGIN_SOURCE_DEPTH {
        return Err(CommandError::Other("插件资产路径深度超过上限".into()));
    }
    Ok(out)
}

/// Open a capability-checked handle outside the transaction gate; the caller
/// revalidates native authority before reading and again before delivery.
fn open_authorized_asset(base: &Path, rel: &Path) -> Result<Option<std::fs::File>, CommandError> {
    let canon_base = base
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("插件目录不可达: {e}")))?;
    let mut current = base.to_path_buf();
    let count = rel.components().count();
    for (index, component) in rel.components().enumerate() {
        current.push(component);
        let metadata = match std::fs::symlink_metadata(&current) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(CommandError::Io(format!("资产不可达: {e}"))),
        };
        if plugin::is_link_or_reparse(&metadata)
            || (index + 1 < count && !metadata.is_dir())
            || (index + 1 == count && !metadata.is_file())
        {
            return Err(CommandError::Other("资产路径含链接或非常规文件".into()));
        }
    }
    let target = current
        .canonicalize()
        .map_err(|e| CommandError::Io(format!("资产不可达: {e}")))?;
    if !target.starts_with(&canon_base) {
        return Err(CommandError::Other("资产路径越界".into()));
    }
    crate::plugin::fs_access::open_regular_file(&canon_base, &rel.to_string_lossy())
        .map(|opened| Some(opened.file))
        .map_err(CommandError::Io)
}

#[cfg(test)]
fn read_authorized_asset(base: &Path, rel: &Path) -> Result<Option<Vec<u8>>, CommandError> {
    open_authorized_asset(base, rel)?.map(read_open_asset).transpose()
}

#[cfg(test)]
fn read_open_asset(file: std::fs::File) -> Result<Vec<u8>, CommandError> {
    read_open_asset_cancellable(file, None)
}

pub(crate) fn read_open_asset_cancellable(
    mut file: std::fs::File, authority: Option<&LegacyFileAuthority>,
) -> Result<Vec<u8>, CommandError> {
    use std::io::Read;
    let mut bytes = Vec::new();
    let mut chunk = [0; 64 * 1024];
    loop {
        if let Some(authority) = authority { require_live_file_authority(authority)?; }
        let count = match file.read(&mut chunk) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            result => result.map_err(|e| CommandError::Io(e.to_string()))?,
        };
        if count == 0 { return Ok(bytes); }
        bytes.extend_from_slice(&chunk[..count]);
    }
}

struct PreparedAssetWrite {
    parent: std::path::PathBuf,
    target: std::path::PathBuf,
    temporary: std::path::PathBuf,
    file: Option<std::fs::File>,
}

impl PreparedAssetWrite {
    fn new(parent: std::path::PathBuf, target: std::path::PathBuf) -> std::io::Result<Self> {
        let temporary = parent.join(format!(".write-{}", uuid::Uuid::new_v4()));
        let file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        Ok(Self { parent, target, temporary, file: Some(file) })
    }

    #[cfg(test)]
    fn write(&mut self, content: &[u8]) -> Result<(), CommandError> {
        self.write_cancellable(content, None)
    }

    fn write_cancellable(&mut self, content: &[u8], authority: Option<&LegacyFileAuthority>) -> Result<(), CommandError> {
        use std::io::Write;
        let mut file = self.file.take().ok_or_else(|| CommandError::Other("文件暂存已经完成".into()))?;
        for chunk in content.chunks(64 * 1024) {
            if let Some(authority) = authority { require_live_file_authority(authority)?; }
            file.write_all(chunk).map_err(|e| CommandError::Io(format!("写入资产暂存失败: {e}")))?;
        }
        if let Some(authority) = authority { require_live_file_authority(authority)?; }
        file.sync_all().map_err(|e| CommandError::Io(format!("同步资产暂存失败: {e}")))
    }

    fn commit(self) -> std::io::Result<()> {
        plugin::transaction::replace_file(&self.temporary, &self.target)?;
        plugin::transaction::sync_dir(&self.parent)
    }
}

impl Drop for PreparedAssetWrite {
    fn drop(&mut self) {
        self.file.take();
        // A UUID temporary file only; never remove the target on failure/cancel.
        let _ = std::fs::remove_file(&self.temporary);
    }
}

#[cfg(test)]
fn atomic_write_asset(parent: &Path, target: &Path, content: &[u8]) -> std::io::Result<()> {
    let mut prepared = PreparedAssetWrite::new(parent.to_path_buf(), target.to_path_buf())?;
    prepared.write(content).map_err(std::io::Error::other)?;
    prepared.commit()
}

pub(crate) fn require_main_window(window: &tauri::WebviewWindow) -> Result<(), CommandError> {
    if window.label() != "main" {
        return Err(CommandError::Other("插件命令仅允许主窗口调用".into()));
    }
    Ok(())
}

#[tauri::command]
pub async fn create_plugin_view(
    source: tauri::Webview,
    state: State<'_, AppState>,
    binding: plugin::view_runtime::Binding,
) -> Result<(), CommandError> {
    plugin::view_runtime::create(source, &state, binding).await
}

#[tauri::command]
pub async fn update_plugin_view(
    source: tauri::Webview,
    instance_id: String,
    rect: plugin::view_runtime::Rect,
    occlusions: Option<Vec<plugin::view_runtime::OcclusionRect>>,
    visible: bool,
    layout_revision: u64,
) -> Result<(), CommandError> {
    plugin::view_runtime::update(
        source,
        instance_id,
        rect,
        occlusions,
        visible,
        layout_revision,
    )
    .await
}

#[tauri::command]
pub async fn send_plugin_view_message(
    source: tauri::Webview,
    instance_id: String,
    message: serde_json::Value,
) -> Result<(), CommandError> {
    plugin::view_runtime::send(source, instance_id, message).await
}

#[tauri::command]
pub async fn destroy_plugin_view(
    source: tauri::Webview,
    instance_id: String,
) -> Result<(), CommandError> {
    plugin::view_runtime::destroy(source, instance_id).await
}

// ==================== 辅助 ====================

fn now_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub(crate) fn plugin_dir(root: &Path, id: &str) -> Result<std::path::PathBuf, CommandError> {
    plugin::validate_plugin_id(id).map_err(CommandError::Other)?;
    let dest = root.join(id);
    match std::fs::symlink_metadata(&dest) {
        Ok(meta) if plugin::is_link_or_reparse(&meta) || !meta.is_dir() => {
            return Err(CommandError::Other(format!("插件目录不是普通目录: {id}")))
        }
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(CommandError::Io(format!("插件目录不可达: {e}"))),
    }
    Ok(dest)
}

#[cfg(test)]
fn stage_uninstall_fs(
    root: &Path,
    id: &str,
) -> Result<(std::path::PathBuf, Option<std::path::PathBuf>), CommandError> {
    let dest = plugin_dir(root, id)?;
    if !dest.exists() {
        return Ok((dest, None));
    }
    let transaction = plugin::transaction::Transaction::uninstall(root, id, 1)
        .map_err(|e| CommandError::Io(e.to_string()))?;
    let backup = transaction.backup(root);
    plugin::transaction::rename(root, &dest, &backup)
        .map_err(|e| CommandError::Io(e.to_string()))?;
    transaction
        .finish(root)
        .map_err(|e| CommandError::Io(e.to_string()))?;
    Ok((dest, Some(backup)))
}

fn remove_path_if_exists(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => {
            std::fs::remove_dir_all(path)
        }
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

fn copy_plugin_source(
    src: &Path, dest: &Path, archive_limit: Option<u64>, control: CopyControl<'_>,
) -> std::io::Result<u64> {
    source_copy::copy_verified(dest, archive_limit, control, |pass| {
        copy_dir_recursive_inner(src, dest, pass, 0, &mut 0)
    })
}

#[cfg(test)]
fn copy_dir_recursive(src: &Path, dest: &Path, budget: &mut u64) -> std::io::Result<()> {
    *budget -= copy_plugin_source(src, dest, Some(*budget), CopyControl::SILENT)?;
    Ok(())
}

// The source side of this copier is deliberately handle-based.  A pathname
// checked with symlink_metadata is not a stable object: an untrusted source
// directory can replace it before File::open follows the path.  Unix walks
// from an O_NOFOLLOW directory handle and Windows verifies every final handle
// against the already-opened source root.  Both paths reject links and all
// non-regular objects before any bytes are read.
#[cfg(any(
    target_os = "linux",
    target_os = "android",
    target_os = "macos",
    target_os = "ios"
))]
fn copy_dir_recursive_inner(
    src: &Path,
    dest: &Path,
    pass: &mut DirectoryPass<'_>,
    depth: usize,
    entries: &mut usize,
) -> std::io::Result<()> {
    use std::ffi::{CStr, CString, OsString};
    use std::os::fd::{AsRawFd, FromRawFd, RawFd};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::fs::MetadataExt;

    fn invalid(message: &str) -> std::io::Error {
        std::io::Error::new(std::io::ErrorKind::InvalidData, message)
    }

    fn open_flags() -> libc::c_int {
        libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK
    }

    fn open_root(path: &Path) -> std::io::Result<std::fs::File> {
        let mut current = if path.is_absolute() {
            let root = CString::new("/").unwrap();
            let fd = unsafe { libc::open(root.as_ptr(), open_flags() | libc::O_DIRECTORY) };
            if fd < 0 {
                return Err(std::io::Error::last_os_error());
            }
            unsafe { std::fs::File::from_raw_fd(fd) }
        } else {
            let dot = CString::new(".").unwrap();
            let fd = unsafe { libc::open(dot.as_ptr(), open_flags() | libc::O_DIRECTORY) };
            if fd < 0 {
                return Err(std::io::Error::last_os_error());
            }
            unsafe { std::fs::File::from_raw_fd(fd) }
        };
        for component in path.components() {
            let name = match component {
                std::path::Component::RootDir | std::path::Component::CurDir => continue,
                std::path::Component::Normal(name) => {
                    CString::new(name.as_bytes()).map_err(|_| invalid("源目录名称包含 NUL"))?
                }
                std::path::Component::ParentDir => return Err(invalid("源目录不得包含 ..")),
                std::path::Component::Prefix(_) => return Err(invalid("不支持的源目录前缀")),
            };
            let fd = unsafe {
                libc::openat(
                    current.as_raw_fd(),
                    name.as_ptr(),
                    open_flags() | libc::O_DIRECTORY,
                )
            };
            if fd < 0 {
                return Err(std::io::Error::last_os_error());
            }
            current = unsafe { std::fs::File::from_raw_fd(fd) };
        }
        let metadata = current.metadata()?;
        if !metadata.is_dir() {
            return Err(invalid("插件源根目录必须是目录"));
        }
        Ok(current)
    }

    struct DirectoryStream(*mut libc::DIR);
    impl Drop for DirectoryStream {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    impl DirectoryStream {
        fn open(dir: RawFd) -> std::io::Result<Self> {
            let duplicate = unsafe { libc::fcntl(dir, libc::F_DUPFD_CLOEXEC, 0) };
            if duplicate < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let stream = unsafe { libc::fdopendir(duplicate) };
            if stream.is_null() {
                let error = std::io::Error::last_os_error();
                unsafe {
                    libc::close(duplicate);
                }
                return Err(error);
            }
            Ok(Self(stream))
        }
        fn next_name(&mut self) -> std::io::Result<Option<OsString>> {
            loop {
                // readdir uses null for both EOF and errors. Clear errno before
                // the call so unreadable/changing directories fail closed.
                #[cfg(target_os = "linux")]
                let errno = unsafe { libc::__errno_location() };
                #[cfg(target_os = "android")]
                let errno = unsafe { libc::__errno() };
                #[cfg(any(target_os = "macos", target_os = "ios"))]
                let errno = unsafe { libc::__error() };
                unsafe {
                    *errno = 0;
                }
                let item = unsafe { libc::readdir(self.0) };
                if item.is_null() {
                    let error = unsafe { *errno };
                    return if error == 0 {
                        Ok(None)
                    } else {
                        Err(std::io::Error::from_raw_os_error(error))
                    };
                }
                let bytes = unsafe { CStr::from_ptr((*item).d_name.as_ptr()) }.to_bytes();
                if bytes == b"." || bytes == b".." {
                    continue;
                }
                return Ok(Some(OsString::from_vec(bytes.to_vec())));
            }
        }
    }

    fn source_stamp(file: &std::fs::File) -> std::io::Result<SourceStamp> {
        let metadata = file.metadata()?;
        if !metadata.is_dir() && (!metadata.is_file() || metadata.nlink() != 1) {
            return Err(invalid("插件源必须是未链接的普通文件"));
        }
        Ok(SourceStamp {
            volume: metadata.dev(), identity: metadata.ino(), len: metadata.len(),
            last_write: (metadata.mtime(), metadata.mtime_nsec()),
            last_change: (metadata.ctime(), metadata.ctime_nsec()), directory: metadata.is_dir(),
        })
    }

    fn copy_dir_fd(
        dir: &std::fs::File,
        dest: &Path,
        pass: &mut DirectoryPass<'_>,
        depth: usize,
        entries: &mut usize,
    ) -> std::io::Result<()> {
        if depth > plugin::MAX_PLUGIN_SOURCE_DEPTH {
            return Err(invalid("插件目录递归深度超过上限"));
        }
        pass.directory(dest, source_stamp(dir)?)?;
        let mut stream = DirectoryStream::open(dir.as_raw_fd())?;
        while let Some(name) = stream.next_name()? {
            pass.check()?;
            *entries = (*entries).saturating_add(1);
            if *entries > source_copy::MAX_LOCAL_ENTRIES {
                return Err(invalid("插件目录条目数超过上限"));
            }
            if depth + 1 > plugin::MAX_PLUGIN_SOURCE_DEPTH {
                return Err(invalid("插件目录递归深度超过上限"));
            }
            let name_bytes = name.as_os_str().as_bytes();
            let c_name = CString::new(name_bytes).map_err(|_| invalid("插件源名称包含 NUL"))?;
            let mut before: libc::stat = unsafe { std::mem::zeroed() };
            if unsafe {
                libc::fstatat(
                    dir.as_raw_fd(),
                    c_name.as_ptr(),
                    &mut before,
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            let target = dest.join(&name);
            let mode = before.st_mode as libc::mode_t;
            let is_dir = (mode & libc::S_IFMT) == libc::S_IFDIR;
            let is_file = (mode & libc::S_IFMT) == libc::S_IFREG;
            if !is_dir && !is_file {
                return Err(invalid("插件源不得包含符号链接或特殊文件"));
            }
            #[cfg(test)]
            if pass.scanning() { directory_copy_test_hook(DirectoryCopyStep::BeforeOpen, &target); }
            let flags = open_flags() | if is_dir { libc::O_DIRECTORY } else { 0 };
            let fd = unsafe { libc::openat(dir.as_raw_fd(), c_name.as_ptr(), flags) };
            if fd < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let opened = unsafe { std::fs::File::from_raw_fd(fd) };
            let metadata = opened.metadata()?;
            if is_dir {
                if !metadata.is_dir() {
                    return Err(invalid("插件源目录类型在打开期间变化"));
                }
                #[cfg(test)]
                if pass.scanning() { directory_copy_test_hook(DirectoryCopyStep::DirectoryOpened, &target); }
                copy_dir_fd(&opened, &target, pass, depth + 1, entries)?;
            } else {
                if !metadata.is_file() {
                    return Err(invalid("插件源文件类型在打开期间变化"));
                }
                let stamp = source_stamp(&opened)?;
                pass.file(&target, opened, stamp, source_stamp)?;
            }
        }
        Ok(())
    }

    let root = open_root(src)?;
    copy_dir_fd(&root, dest, pass, depth, entries)
}

#[cfg(not(any(
    windows,
    target_os = "linux",
    target_os = "android",
    target_os = "macos",
    target_os = "ios"
)))]
fn copy_dir_recursive_inner(
    _: &Path,
    _: &Path,
    _: &mut DirectoryPass<'_>,
    _: usize,
    _: &mut usize,
) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "此平台不支持安全目录插件安装",
    ))
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum DirectoryCopyStep {
    BeforeOpen,
    DirectoryOpened,
}

#[cfg(test)]
type DirectoryCopyHook = Box<dyn FnMut(DirectoryCopyStep, &Path)>;

#[cfg(test)]
thread_local! {
    static DIRECTORY_COPY_HOOK: std::cell::RefCell<Option<DirectoryCopyHook>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn directory_copy_test_hook(step: DirectoryCopyStep, target: &Path) {
    DIRECTORY_COPY_HOOK.with(|hook| {
        if let Some(hook) = hook.borrow_mut().as_mut() {
            hook(step, target);
        }
    });
}

#[cfg(windows)]
fn copy_dir_recursive_inner(
    src: &Path,
    dest: &Path,
    pass: &mut DirectoryPass<'_>,
    depth: usize,
    entries: &mut usize,
) -> std::io::Result<()> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, GetFileType, GetFinalPathNameByHandleW,
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_NORMALIZED, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE, FILE_TYPE_DISK, VOLUME_NAME_DOS,
    };

    fn invalid(message: &str) -> std::io::Error {
        std::io::Error::new(std::io::ErrorKind::InvalidData, message)
    }
    fn final_path(file: &std::fs::File) -> std::io::Result<std::path::PathBuf> {
        use std::os::windows::ffi::OsStringExt;
        let mut buffer = vec![0u16; 32768];
        let length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        };
        if length == 0 || length as usize >= buffer.len() {
            return Err(std::io::Error::last_os_error());
        }
        Ok(std::ffi::OsString::from_wide(&buffer[..length as usize]).into())
    }
    fn validate_opened(file: std::fs::File, directory: bool) -> std::io::Result<std::fs::File> {
        if unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK {
            return Err(invalid("插件源必须是磁盘上的普通文件或目录"));
        }
        let metadata = file.metadata()?;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(invalid("插件源不得包含重解析点"));
        }
        if (directory && !metadata.is_dir()) || (!directory && !metadata.is_file()) {
            return Err(invalid("插件源对象类型在打开期间变化"));
        }
        Ok(file)
    }
    fn open_anchor(path: &Path) -> std::io::Result<std::fs::File> {
        let mut options = std::fs::OpenOptions::new();
        options
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);
        validate_opened(options.open(path)?, true)
    }
    fn open_relative(
        parent: &std::fs::File,
        name: &std::ffi::OsStr,
        directory: bool,
        pinned: bool,
    ) -> std::io::Result<std::fs::File> {
        use std::os::windows::ffi::OsStrExt;
        // NtCreateFile is the Windows openat equivalent. Only a single name is
        // supplied, so intermediate components cannot be re-resolved by Win32.
        #[repr(C)]
        struct UnicodeString {
            length: u16,
            maximum_length: u16,
            buffer: *mut u16,
        }
        #[repr(C)]
        struct ObjectAttributes {
            length: u32,
            root: *mut std::ffi::c_void,
            name: *mut UnicodeString,
            attributes: u32,
            security: *mut std::ffi::c_void,
            quality: *mut std::ffi::c_void,
        }
        #[repr(C)]
        struct IoStatus {
            status: usize,
            information: usize,
        }
        #[link(name = "ntdll")]
        extern "system" {
            fn NtCreateFile(
                handle: *mut *mut std::ffi::c_void,
                access: u32,
                attributes: *mut ObjectAttributes,
                status: *mut IoStatus,
                size: *mut i64,
                file_attributes: u32,
                share: u32,
                disposition: u32,
                options: u32,
                ea: *mut std::ffi::c_void,
                ea_length: u32,
            ) -> i32;
            fn RtlNtStatusToDosError(status: i32) -> u32;
        }
        let mut wide: Vec<u16> = name.encode_wide().collect();
        if wide.is_empty()
            || wide.len() > (u16::MAX as usize / 2)
            || wide.iter().any(|c| matches!(*c, 0 | 47 | 92 | 58))
        {
            return Err(invalid("插件源组件名称无效"));
        }
        let mut unicode = UnicodeString {
            length: (wide.len() * 2) as u16,
            maximum_length: (wide.len() * 2) as u16,
            buffer: wide.as_mut_ptr(),
        };
        let mut attributes = ObjectAttributes {
            length: std::mem::size_of::<ObjectAttributes>() as u32,
            root: parent.as_raw_handle(),
            name: &mut unicode,
            attributes: 0x40 | 0x1000,
            security: std::ptr::null_mut(),
            quality: std::ptr::null_mut(),
        }; // OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE
        let mut status = IoStatus {
            status: 0,
            information: 0,
        };
        let mut handle = std::ptr::null_mut();
        let share = if pinned {
            FILE_SHARE_READ
        } else {
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
        };
        let options = 0x00200000 | 0x20 | if directory { 1 } else { 0x40 }; // OPEN_REPARSE_POINT | SYNCHRONOUS_IO_NONALERT | DIRECTORY/NON_DIRECTORY
        let result = unsafe {
            NtCreateFile(
                &mut handle,
                0x00120089,
                &mut attributes,
                &mut status,
                std::ptr::null_mut(),
                0,
                share,
                1,
                options,
                std::ptr::null_mut(),
                0,
            )
        }; // FILE_GENERIC_READ, FILE_OPEN
        if result < 0 {
            return Err(std::io::Error::from_raw_os_error(
                unsafe { RtlNtStatusToDosError(result) } as i32,
            ));
        }
        validate_opened(unsafe { std::fs::File::from_raw_handle(handle) }, directory)
    }
    fn pin_root(src: &Path) -> std::io::Result<(std::fs::File, std::path::PathBuf)> {
        let absolute = if src.is_absolute() {
            src.to_path_buf()
        } else {
            std::env::current_dir()?.join(src)
        };
        let mut anchor = std::path::PathBuf::new();
        let mut names = Vec::new();
        for component in absolute.components() {
            match component {
                std::path::Component::Prefix(prefix) => {
                    use std::path::Prefix;
                    if !matches!(
                        prefix.kind(),
                        Prefix::Disk(_)
                            | Prefix::VerbatimDisk(_)
                            | Prefix::UNC(_, _)
                            | Prefix::VerbatimUNC(_, _)
                    ) {
                        return Err(invalid("插件源不得使用设备路径"));
                    }
                    anchor.push(prefix.as_os_str());
                }
                std::path::Component::RootDir => anchor.push(component.as_os_str()),
                std::path::Component::CurDir => {}
                std::path::Component::Normal(name) => names.push(name),
                std::path::Component::ParentDir => return Err(invalid("源目录不得包含 ..")),
            }
        }
        if names.is_empty() {
            return Err(invalid("插件源必须是非卷根目录"));
        }
        let mut current = open_anchor(&anchor)?;
        for (index, name) in names.iter().enumerate() {
            current = open_relative(&current, name, true, index + 1 == names.len())?;
        }
        let root = final_path(&current)?;
        Ok((current, root))
    }
    fn source_stamp(file: &std::fs::File) -> std::io::Result<SourceStamp> {
        let metadata = file.metadata()?;
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        if !metadata.is_dir() && (!metadata.is_file() || info.nNumberOfLinks != 1) {
            return Err(invalid("插件源必须是未链接的普通文件"));
        }
        Ok(SourceStamp {
            volume: info.dwVolumeSerialNumber.into(),
            identity: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            len: metadata.len(), last_write: (metadata.last_write_time() as i64, 0),
            last_change: (metadata.creation_time() as i64, 0), directory: metadata.is_dir(),
        })
    }

    fn copy_dir_path(
        dir: &std::fs::File,
        path: &Path,
        root: &Path,
        dest: &Path,
        pass: &mut DirectoryPass<'_>,
        depth: usize,
        entries: &mut usize,
    ) -> std::io::Result<()> {
        if depth > plugin::MAX_PLUGIN_SOURCE_DEPTH {
            return Err(invalid("插件目录递归深度超过上限"));
        }
        pass.directory(dest, source_stamp(dir)?)?;
        for entry in std::fs::read_dir(path)? {
            pass.check()?;
            let entry = entry?;
            *entries = (*entries).saturating_add(1);
            if *entries > source_copy::MAX_LOCAL_ENTRIES {
                return Err(invalid("插件目录条目数超过上限"));
            }
            if depth + 1 > plugin::MAX_PLUGIN_SOURCE_DEPTH {
                return Err(invalid("插件目录递归深度超过上限"));
            }
            let candidate = entry.path();
            let link_meta = std::fs::symlink_metadata(&candidate)?;
            if link_meta.file_type().is_symlink()
                || link_meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
            {
                return Err(invalid("插件源不得包含链接或重解析点"));
            }
            let name = entry.file_name();
            let text = name
                .to_str()
                .ok_or_else(|| invalid("插件源名称必须是 UTF-8"))?;
            let stem = text.split('.').next().unwrap_or("").to_ascii_uppercase();
            if text.ends_with(['.', ' '])
                || text.contains(':')
                || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                    && stem.len() == 4
                    && matches!(stem.as_bytes()[3], b'1'..=b'9'))
            {
                return Err(invalid("插件源名称含 Windows 设备或路径别名"));
            }
            let target = dest.join(&name);
            #[cfg(test)]
            if pass.scanning() { directory_copy_test_hook(DirectoryCopyStep::BeforeOpen, &target); }
            if link_meta.is_dir() {
                let opened = open_relative(dir, &name, true, true)?;
                let child = final_path(&opened)?;
                if child.parent() != Some(path) || !child.starts_with(root) {
                    return Err(invalid("插件源越过选定目录"));
                }
                #[cfg(test)]
                if pass.scanning() { directory_copy_test_hook(DirectoryCopyStep::DirectoryOpened, &target); }
                copy_dir_path(&opened, &child, root, &target, pass, depth + 1, entries)?;
                drop(opened);
            } else if link_meta.is_file() {
                let input = open_relative(dir, &name, false, true)?;
                let opened_path = final_path(&input)?;
                if opened_path.parent() != Some(path) || !opened_path.starts_with(root) {
                    return Err(invalid("插件源越过选定目录"));
                }
                let stamp = source_stamp(&input)?;
                pass.file(&target, input, stamp, source_stamp)?;
            } else {
                return Err(invalid("插件源不得包含特殊文件"));
            }
        }
        Ok(())
    }

    let (opened, root) = pin_root(src)?;
    copy_dir_path(&opened, &root, &root, dest, pass, depth, entries)?;
    drop(opened);
    Ok(())
}

// ==================== 插件 Shell（v1：openExternal + 白名单骨架） ====================

/// Channel-level bound only; this is not a business/content quota.
const MAX_PLUGIN_EXTERNAL_URL_CHARS: usize = 8 * 1024;

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
    if url.chars().count() > MAX_PLUGIN_EXTERNAL_URL_CHARS {
        return Err(CommandError::Other("openExternal URL 超过通道长度上限".into()));
    }
    {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let entry = manager
            .get_config()
            .entities
            .plugin_configs
            .iter()
            .find(|p| p.id == plugin_id)
            .ok_or_else(|| CommandError::Other(format!("插件未安装: {plugin_id}")))?;
        if !entry.enabled || !entry.granted_permissions.iter().any(|p| p == "shell:open") {
            return Err(CommandError::Other(format!(
                "插件未启用或未授予 shell:open: {plugin_id}"
            )));
        }
        let manifest =
            plugin::load_manifest_lite(&plugin_dir(manager.plugins_dir(), &plugin_id)?)
                .map_err(|e| CommandError::Other(format!("插件 manifest 不可读: {e}")))?;
        if manifest.id != plugin_id || !manifest.permissions.iter().any(|p| p == "shell:open") {
            return Err(CommandError::Other(format!(
                "插件未声明 shell:open: {plugin_id}"
            )));
        }
    }
    let parsed =
        url::Url::parse(&url).map_err(|e| CommandError::Other(format!("非法 URL: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(CommandError::Other(format!(
            "openExternal 仅允许 http/https/mailto，收到: {}",
            parsed.scheme()
        )));
    }
    #[allow(deprecated)]
    // tauri-plugin-shell open 已 deprecated（官方建议 tauri-plugin-opener）；v1 沿用 shell 插件（capabilities 已有 shell:allow-open），opener 迁移在评审 §11 开放问题实施时评估
    app.shell()
        .open(url, None)
        .map_err(|e| CommandError::Other(format!("打开 URL 失败: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::commands::plugin_http::url_glob_match;
    use super::*;
    use std::fs;

    #[tokio::test(flavor = "current_thread")]
    async fn plugin_gate_wait_is_bounded_and_recovers_after_release() {
        let gate = tokio::sync::Mutex::new(());
        let held = gate.lock().await;
        let busy = acquire_plugin_gate(&gate, Duration::from_millis(5)).await;
        assert!(matches!(busy, Err(CommandError::Other(message)) if message.contains("忙")));
        drop(held);
        let acquired = acquire_plugin_gate(&gate, Duration::from_millis(50)).await;
        assert!(acquired.is_ok());
    }

    fn canonical_test_temp_dir() -> std::path::PathBuf {
        // macOS /var and /tmp can be aliases; fixtures must exercise copying
        // real directories rather than the intentional ancestor-link rejection.
        std::env::temp_dir().canonicalize().unwrap()
    }

    #[test]
    fn zip_install_uses_canonical_internal_extraction_directory() {
        let root =
            canonical_test_temp_dir().join(format!("plugin_zip_temp_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let archive = root.join("plugin.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        let options = zip::write::SimpleFileOptions::default();
        use std::io::Write;
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest("1.0.0").as_bytes()).unwrap();
        zip.start_file("main.js", options).unwrap();
        zip.write_all(b"ordinary").unwrap();
        zip.finish().unwrap();
        let prepared =
            prepare_plugin_install(archive.to_str().unwrap(), &root.join("plugins"), true).unwrap();
        assert_eq!(
            fs::read_to_string(prepared.stage_guard.0.join("main.js")).unwrap(),
            "ordinary"
        );
        drop(prepared);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn external_archive_retains_the_real_expansion_limit() {
        use std::io::Write;
        let root = canonical_test_temp_dir().join(format!("plugin_large_zip_{}", uuid::Uuid::new_v4()));
        let _cleanup = TempDirGuard(root.clone());
        fs::create_dir_all(&root).unwrap();
        let archive = root.join("large.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest("1.0.0").as_bytes()).unwrap();
        zip.start_file("main.js", options).unwrap();
        zip.write_all(b"ordinary").unwrap();
        zip.start_file("large.bin", options).unwrap();
        let block = vec![0u8; 256 * 1024];
        for _ in 0..=plugin::MAX_ZIP_UNCOMPRESSED_BYTES / block.len() as u64 {
            zip.write_all(&block).unwrap();
        }
        zip.finish().unwrap();
        assert!(fs::metadata(&archive).unwrap().len() < plugin::MAX_ZIP_ARCHIVE_BYTES);
        let plugins = root.join("plugins");
        assert!(prepare_plugin_install_controlled(archive.to_str().unwrap(), &plugins, false, None, None, CopyControl::SILENT, PrepareFormat::Directory).is_err());
        let error = prepare_plugin_install(archive.to_str().unwrap(), &plugins, false).err().unwrap();
        assert!(error.to_string().contains("zip 解压总量超过上限"), "{error}");
        assert!(!plugins.join("com.example.test").exists());
    }

    fn manifest(version: &str) -> String {
        format!(
            r#"{{"id":"com.example.test","name":"Test","version":"{version}","apiVersion":"1.0","entry":"main.js","permissions":[]}}"#
        )
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
        manager
            .get_config_mut()
            .entities
            .plugin_configs
            .push(config::PluginConfigEntry {
                id: "com.example.test".into(),
                enabled: true,
                trusted_web_granted: true,
                install_generation: "old-generation".into(),
                granted_permissions: vec!["fs:storage".into()],
                installed_at: Some(1),
                source: Some("dir".into()),
                update_url: None,
            });
        manager.save().unwrap();
        manager
    }

    fn fixture_install_task() -> DirectoryInstallTask {
        DirectoryInstallTask { id: uuid::Uuid::new_v4(), phase: AtomicU8::new(INSTALL_PREPARING), cancelled: tokio::sync::Notify::new() }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn local_install_publishes_verified_directory_beyond_archive_bound() {
        use std::io::{Read, Write};
        let root = canonical_test_temp_dir().join(format!("plugin_large_dir_{}", uuid::Uuid::new_v4()));
        let _cleanup = TempDirGuard(root.clone());
        let src = source(&root, "1.0.0");
        let manager = Mutex::new(config::ConfigManager::new(Some(root.join("config.json"))).unwrap());
        let gate = tokio::sync::Mutex::new(());
        let task = Arc::new(fixture_install_task());
        let size = plugin::MAX_ZIP_UNCOMPRESSED_BYTES + 1024 * 1024 + 17;
        let payload = |index: usize| (index as u8).wrapping_mul(17).wrapping_add(11);
        let expected: Vec<_> = (0..256 * 1024).map(payload).collect();
        let mut large = fs::File::create(src.join("large.bin")).unwrap();
        for _ in 0..size / expected.len() as u64 { large.write_all(&expected).unwrap(); }
        large.write_all(&expected[..17]).unwrap();
        drop(large);
        let calls = Arc::new(Mutex::new(Vec::new()));
        let events = calls.clone();
        let mut prepared = prepare_directory_before_commit(&manager, &gate, &task, src.to_str().unwrap().into(),
            false, None, Arc::new(move |event| events.lock().unwrap().push(event))).await.unwrap();
        assert!(prepared.stage_guard.0.file_name().unwrap().to_string_lossy().starts_with(".prepare-"));
        let copy_progress = calls.lock().unwrap().iter().filter_map(|event| match *event {
            PluginInstallProgress::Copying { copied_bytes, total_bytes, available_bytes } => Some((copied_bytes, total_bytes, available_bytes)),
            _ => None,
        }).collect::<Vec<_>>();
        let total = copy_progress[0].1;
        assert!(total > size && copy_progress[0].2 >= total);
        assert_eq!(copy_progress[0].0, 0);
        assert_eq!(copy_progress.last().unwrap().0, total);
        assert!(copy_progress.windows(2).all(|pair| pair[0].0 <= pair[1].0 && pair[1].1 == total));
        let held = gate.lock().await;
        let result = install_after_retiring(&manager, &mut prepared, None, || task.begin_commit(), || async { Ok(()) }, || {}).await.unwrap();
        drop(held);
        let installed = manager.lock().unwrap().plugins_dir().join("com.example.test/large.bin");
        assert_eq!(fs::metadata(&installed).unwrap().len(), size);
        let mut input = fs::File::open(installed).unwrap();
        let mut bytes = vec![0u8; expected.len()];
        for _ in 0..size / expected.len() as u64 {
            input.read_exact(&mut bytes).unwrap();
            assert_eq!(bytes, expected);
        }
        input.read_exact(&mut bytes[..17]).unwrap();
        assert_eq!(&bytes[..17], &expected[..17]);
        assert_eq!(input.read(&mut bytes[..1]).unwrap(), 0);
        assert!(!result.plugin_configs[0].enabled);
        assert_eq!(result.plugin_configs[0].source.as_deref(), Some("dir"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn paused_directory_copy_does_not_block_other_controls_or_override_a_racing_first_install() {
        let root = canonical_test_temp_dir().join(format!("plugin_private_prepare_{}", uuid::Uuid::new_v4()));
        let _cleanup = TempDirGuard(root.clone());
        let earlier_source = source(&root, "3.0.0");
        fs::write(earlier_source.join("large.bin"), vec![7u8; 1024 * 1024]).unwrap();
        let competing_source = source(&root, "2.0.0");
        let mut manager = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
        reset_install_trust(manager.get_config_mut(), "com.example.other", "dir");
        manager.get_config_mut().entities.plugin_configs[0].enabled = true;
        manager.save().unwrap();
        let manager = Arc::new(Mutex::new(manager));
        let gate = Arc::new(tokio::sync::Mutex::new(()));
        let task = Arc::new(fixture_install_task());
        let (entered, copying) = tokio::sync::oneshot::channel();
        let entered = Mutex::new(Some(entered));
        let (resume, wait_to_resume) = std::sync::mpsc::channel();
        let wait_to_resume = Mutex::new(wait_to_resume);
        let worker = tokio::spawn({
            let manager = manager.clone();
            let gate = gate.clone();
            let task = task.clone();
            async move {
                prepare_directory_before_commit(&manager, &gate, &task, earlier_source.to_str().unwrap().into(), false, None,
                    Arc::new(move |event| {
                        if matches!(event, PluginInstallProgress::Copying { copied_bytes, total_bytes, .. } if copied_bytes > 0 && copied_bytes < total_bytes) {
                            if let Some(entered) = entered.lock().unwrap().take() {
                                entered.send(()).unwrap();
                                wait_to_resume.lock().unwrap().recv_timeout(Duration::from_secs(10)).unwrap();
                            }
                        }
                    })).await
            }
        });
        tokio::time::timeout(Duration::from_secs(5), copying).await.unwrap().unwrap();
        {
            let _control = acquire_plugin_gate(&gate, Duration::from_secs(1)).await
                .expect("other plugin controls can enter while a real copy is paused");
            let mut manager = manager.lock().unwrap();
            let plugins = manager.plugins_dir().to_path_buf();
            let trigger = plugin::transaction::sweep_collect(&plugins, manager.get_config()).unwrap();
            assert!(trigger.iter().all(|path| !path.file_name().unwrap().to_string_lossy().starts_with(".prepare-")));
            commit_plugin_trust_change(&mut manager, "com.example.other", "test disable", |entry| entry.enabled = false, |_, _| {})
                .unwrap().finish(Ok(())).unwrap();
            let competitor = prepare_plugin_install(competing_source.to_str().unwrap(), &plugins, false).unwrap();
            install_prepared(&mut manager, competitor, None).unwrap();
        }
        resume.send(()).unwrap();
        let mut prepared = worker.await.unwrap().unwrap();
        let _control = gate.lock().await;
        let result = install_after_retiring(&manager, &mut prepared, None,
            || panic!("stale preparation must not cross the commit boundary"),
            || async { panic!("rejection must not retire the new runtime") },
            || panic!("rejection must not retire the new serial tasks")).await;
        assert!(matches!(result, Err(CommandError::Other(message)) if message.contains("安装版本已变化")));
        let plugins = manager.lock().unwrap().plugins_dir().to_path_buf();
        assert_eq!(fs::read_to_string(plugins.join("com.example.test/main.js")).unwrap(), "2.0.0");
        let rejected_stage = prepared.stage_guard.0.clone();
        assert!(rejected_stage.file_name().unwrap().to_string_lossy().starts_with(".prepare-"));
        drop(_control);
        discard_install_stage(prepared).await;
        assert!(!rejected_stage.exists());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn directory_cancellation_after_real_writes_does_not_publish_or_change_old_config() {
        let root = canonical_test_temp_dir().join(format!("plugin_cancel_dir_{}", uuid::Uuid::new_v4()));
        let _cleanup = TempDirGuard(root.clone());
        let old = source(&root, "1.0.0");
        let src = source(&root, "2.0.0");
        let manager = trusted_manager(&root);
        install_plugin_fs_stage(old.to_str().unwrap(), manager.plugins_dir()).unwrap();
        let installed = manager.plugins_dir().join("com.example.test");
        fs::create_dir(installed.join("data")).unwrap();
        fs::write(installed.join("data/user.txt"), "user data").unwrap();
        fs::write(src.join("asset"), vec![7u8; 2 * 1024 * 1024]).unwrap();
        let plugin_root = manager.plugins_dir().to_path_buf();
        let manager = Mutex::new(manager);
        let gate = tokio::sync::Mutex::new(());
        let task = Arc::new(fixture_install_task());
        let cancel = task.clone();
        let result = prepare_directory_before_commit(&manager, &gate, &task, src.to_str().unwrap().into(), false, None,
            Arc::new(move |event| {
                if matches!(event, PluginInstallProgress::Copying { copied_bytes, total_bytes, .. } if copied_bytes > 0 && copied_bytes < total_bytes) {
                    assert_eq!(cancel.request_cancel(), CancelPluginInstall::Accepted);
                }
            })).await;
        assert!(matches!(result, Err(CommandError::Other(ref msg)) if msg == source_copy::CANCELLED));
        assert!(task.is_cancelled());
        assert!(fs::read_dir(&plugin_root).unwrap().flatten().all(|entry| !entry.file_name().to_string_lossy().starts_with(".prepare-")));
        assert_eq!(fs::read_to_string(installed.join("main.js")).unwrap(), "1.0.0");
        assert_eq!(fs::read_to_string(installed.join("data/user.txt")).unwrap(), "user data");
        let manager = manager.lock().unwrap();
        let old = state_of(manager.get_config(), "com.example.test").unwrap();
        assert!(old.enabled && old.trusted_web_granted);
        assert_eq!(old.install_generation, "old-generation");
    }

    #[test]
    fn directory_preflight_rejects_changed_file_snapshot() {
        let root = canonical_test_temp_dir().join(format!("plugin_install_changing_{}", uuid::Uuid::new_v4()));
        let _cleanup = TempDirGuard(root.clone());
        let src = source(&root, "1.0.0");
        let payload = src.join("asset");
        fs::write(&payload, "initial bytes").unwrap();
        let event = |event| {
            if matches!(event, PluginInstallProgress::Copying { copied_bytes: 0, .. }) {
                fs::write(&payload, "source changed after sizing pass").unwrap();
            }
        };
        let control = CopyControl { cancelled: &|| false, progress: &event };
        let plugins = root.join("plugins");
        let result = prepare_plugin_install_controlled(src.to_str().unwrap(), &plugins, false, None, None, control, PrepareFormat::Directory);
        assert!(matches!(result, Err(CommandError::Other(ref msg)) if msg.contains("已变化")));
        assert_eq!(fs::read_dir(&plugins).unwrap().count(), 0);
    }

    #[test]
    fn prepare_cancel_and_commit_have_only_one_winner() {
        let task = || DirectoryInstallTask { id: uuid::Uuid::new_v4(), phase: AtomicU8::new(INSTALL_PREPARING), cancelled: tokio::sync::Notify::new() };
        let preparing = task();
        assert_eq!(preparing.request_cancel(), CancelPluginInstall::Accepted);
        assert_eq!(preparing.request_cancel(), CancelPluginInstall::Accepted);
        assert!(preparing.begin_commit().is_err());
        let committing = task();
        committing.begin_commit().unwrap();
        assert_eq!(committing.request_cancel(), CancelPluginInstall::TooLate);
        assert!(!committing.is_cancelled());
    }

    #[test]
    fn only_relevant_serial_authority_loss_retires_tasks() {
        let permissions = |items: &[&str]| items.iter().map(|item| item.to_string()).collect::<Vec<_>>();
        let before = permissions(&["serial:send", "fs:open", "notify"]);
        assert_eq!(serial_authority_loss(&before, &permissions(&["serial:send", "fs:open"])), SerialAuthorityLoss::None);
        assert_eq!(serial_authority_loss(&before, &permissions(&["serial:send", "notify"])), SerialAuthorityLoss::Files);
        assert_eq!(serial_authority_loss(&before, &permissions(&["fs:open", "notify"])), SerialAuthorityLoss::All);
        assert_eq!(serial_authority_loss(&before, &permissions(&["notify"])), SerialAuthorityLoss::All);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rejected_install_target_never_retires_runtime() {
        let root = canonical_test_temp_dir().join(format!("plugin_retirement_{}", uuid::Uuid::new_v4()));
        let _cleanup = TempDirGuard(root.clone());
        let old_source = source(&root, "1.0.0");
        let new_source = source(&root, "2.0.0");
        let manager = trusted_manager(&root);
        install_plugin_fs_stage(old_source.to_str().unwrap(), manager.plugins_dir()).unwrap();
        let plugins = manager.plugins_dir().to_path_buf();
        let revision = manager.get_config().revision;
        let config = std::sync::Mutex::new(manager);

        // Both real commands call this path before invoking the shared runtime
        // retirement, not just the final commit tested by the older regression.
        for (label, explicit, generation, expected_error) in [
            (None, true, Some("stale"), "安装版本已变化"),
            (Some("marketplace"), false, Some("stale"), "安装版本已变化"),
            (None, true, None, "必须携带"),
            (Some("marketplace"), false, None, "expectedGeneration"),
            (Some("marketplace"), false, Some(""), "expectedGeneration"),
        ] {
            let mut prepared = prepare_plugin_install_with_metadata(
                new_source.to_str().unwrap(), &plugins, explicit, label, None,
            ).unwrap();
            let error = install_after_retiring(&config, &mut prepared, generation, || Ok(()), || async {
                panic!("a rejected install retired the current runtime");
            }, || panic!("a rejected install retired serial tasks")).await.unwrap_err();
            assert!(matches!(error, CommandError::Other(message) if message.contains(expected_error)));
            let manager = config.lock().unwrap();
            let current = state_of(manager.get_config(), "com.example.test").unwrap();
            assert_eq!(manager.get_config().revision, revision);
            assert_eq!(current.install_generation, "old-generation");
            assert!(current.enabled && current.trusted_web_granted);
            assert_eq!(fs::read_to_string(plugins.join("com.example.test/main.js")).unwrap(), "1.0.0");
        }

        // Keep the existing strictly-newer local upgrade without a supplied generation.
        let mut prepared = prepare_plugin_install(new_source.to_str().unwrap(), &plugins, false).unwrap();
        let retired = std::cell::Cell::new(false);
        let serial_retired = std::cell::Cell::new(false);
        let result = install_after_retiring(&config, &mut prepared, None, || Ok(()), || async {
            retired.set(true);
            Ok(())
        }, || serial_retired.set(true)).await.unwrap();
        assert!(retired.get());
        assert!(serial_retired.get());
        assert!(!result.plugin_configs[0].enabled);
        assert!(result.plugin_configs[0].granted_permissions.is_empty());
        assert_eq!(fs::read_to_string(plugins.join("com.example.test/main.js")).unwrap(), "2.0.0");
    }

    #[test]
    fn trust_change_separates_primary_failure_from_committed_followup_errors() {
        let id = "com.example.test";
        for failure in ["primary", "backup", "marker"] {
            let root = canonical_test_temp_dir().join(format!("plugin_trust_commit_{}", uuid::Uuid::new_v4()));
            let _cleanup = TempDirGuard(root.clone());
            let mut manager = trusted_manager(&root);
            let revision = manager.get_config().revision;
            let marker = root.join("plugin-trust-recovery.json");
            let backup = root.join("config.json.bak");
            if failure == "primary" {
                fs::create_dir(root.join("config.json.tmp")).unwrap();
            }
            let mut cleanup_ran = false;
            let result = commit_plugin_trust_change(&mut manager, id, "保存插件状态失败", |entry| {
                entry.enabled = false;
            }, |previous, current| {
                assert!(previous.enabled);
                assert!(!current.enabled);
                cleanup_ran = true;
                // Deterministically fail the requested disk step only after the
                // real primary writer has advanced the authoritative revision.
                if failure == "backup" {
                    fs::remove_file(&backup).unwrap();
                    fs::create_dir(&backup).unwrap();
                } else if failure == "marker" {
                    fs::remove_file(&marker).unwrap();
                    fs::create_dir(&marker).unwrap();
                }
            });
            if failure == "primary" {
                assert!(matches!(result, Err(CommandError::Config(message)) if message.contains("保存插件状态失败")));
                assert!(!cleanup_ran);
                assert_eq!(manager.get_config().revision, revision);
                assert!(state_of(manager.get_config(), id).unwrap().enabled);
                continue;
            }
            assert!(cleanup_ran);
            let committed = result.unwrap();
            assert!(committed.snapshot.revision > revision);
            assert!(!committed.snapshot.plugin_configs[0].enabled);
            let primary: config::AppConfig = serde_json::from_slice(&fs::read(root.join("config.json")).unwrap()).unwrap();
            assert!(!state_of(&primary, id).unwrap().enabled);
            let error = if failure == "backup" { "保存插件安全备份失败" } else { "清除插件信任恢复标记失败" };
            assert!(matches!(committed.finish(Ok(())), Err(CommandError::Config(message)) if message.contains(error)));
            assert!(marker.exists());
            if failure == "backup" {
                // The committed change remains fail-closed on a later startup.
                fs::remove_dir(&backup).unwrap();
                let recovered = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
                let state = state_of(recovered.get_config(), id).unwrap();
                assert!(!state.enabled && !state.trusted_web_granted);
                assert!(state.granted_permissions.is_empty());
            }
        }
    }

    #[test]
    fn committed_unrelated_grants_keep_legacy_file_authority_live() {
        let root = canonical_test_temp_dir().join(format!("plugin_scoped_authority_{}", uuid::Uuid::new_v4()));
        let _cleanup = TempDirGuard(root.clone());
        let id = format!("com.example.p{}", uuid::Uuid::new_v4().simple());
        let mut manager = trusted_manager(&root);
        let entry = &mut manager.get_config_mut().entities.plugin_configs[0];
        entry.id = id.clone();
        entry.granted_permissions = ["fs:assets", "fs:write-dir", "storage", "fs:storage"]
            .into_iter().map(str::to_owned).collect();
        manager.save().unwrap();
        let registry = super::super::plugin_fs::PluginFsRegistry::new();
        let asset = legacy_file_authority(&id, LegacyFileScope::Assets).unwrap();
        let write = legacy_file_authority(&id, LegacyFileScope::DirectoryWrite).unwrap();
        let kv = legacy_file_authority(&id, LegacyFileScope::EitherStorage).unwrap();
        let data = legacy_file_authority(&id, LegacyFileScope::Data).unwrap();
        let mut commit_permissions = |granted: &[&str]| {
            commit_plugin_trust_change(&mut manager, &id, "保存插件状态失败", |entry| {
                entry.granted_permissions = granted.iter().map(|permission| permission.to_string()).collect();
            }, |previous, committed| {
                retire_revoked_file_io(&registry, &id, &previous.granted_permissions, &committed.granted_permissions);
            }).unwrap().finish(Ok(())).unwrap();
        };
        commit_permissions(&["fs:assets", "fs:write-dir", "storage", "fs:storage", "notify"]);
        assert!(require_live_file_authority(&asset).is_ok());
        assert!(require_live_file_authority(&write).is_ok());
        commit_permissions(&["fs:assets", "storage"]);
        assert!(require_live_file_authority(&asset).is_ok());
        assert!(require_live_file_authority(&kv).is_ok());
        assert!(require_live_file_authority(&data).is_err());
        assert!(require_live_file_authority(&write).is_err());
        commit_permissions(&["fs:assets", "fs:write-dir", "storage"]);
        assert!(require_live_file_authority(&write).is_err());
        assert!(require_live_file_authority(&legacy_file_authority(&id, LegacyFileScope::DirectoryWrite).unwrap()).is_ok());
    }

    #[test]
    fn damaged_manifest_listing_uses_only_the_matching_configured_identity() {
        let root = canonical_test_temp_dir().join(format!("plugin_damaged_identity_{}", uuid::Uuid::new_v4()));
        let _cleanup = TempDirGuard(root.clone());
        let manager = trusted_manager(&root);
        let installed = manager.plugins_dir().join("com.example.test");
        let untracked = manager.plugins_dir().join("com.example.untracked");
        fs::create_dir_all(&installed).unwrap();
        fs::create_dir_all(&untracked).unwrap();
        fs::write(installed.join("manifest.json"), "not a manifest").unwrap();
        let scanned = plugin::scan_plugins(manager.plugins_dir());
        let listed = build_views_from_scan(manager.get_config(), scanned);
        assert_eq!(listed.len(), 2);
        let damaged = listed.iter().find(|view| view.id == "com.example.test").unwrap();
        assert_eq!(damaged.install_generation, "old-generation");
        assert!(damaged.manifest_error.is_some() && damaged.manifest.is_none());
        assert!(!damaged.enabled && !damaged.trusted_web_granted && damaged.granted_permissions.is_empty());
        let untracked = listed.iter().find(|view| view.id == "com.example.untracked").unwrap();
        assert!(untracked.install_generation.is_empty());
    }

    #[test]
    fn ordinary_grants_never_replace_web_consent() {
        let manifest = plugin::parse_manifest(r#"{"id":"com.example.test","name":"Test","version":"1.0.0","apiVersion":"1.0","entry":"main.js","permissions":["ui:view"],"requires":["trusted-web-view@1","plugin-workspace-tabs@1"],"ui":{"views":[{"id":"web","label":"Web","mode":"trusted-web","entry":"ui/index.html","modes":["trx"],"input":"none","placements":["workspace-tab"],"portBinding":"none"}]}}"#).unwrap();
        let mut entry: config::PluginConfigEntry = serde_json::from_value(serde_json::json!({"id":"com.example.test","enabled":true,"grantedPermissions":plugin::KNOWN_PERMISSIONS})).unwrap();
        assert!(!entry.trusted_web_granted);
        assert!(require_trusted_web_consent(&manifest, &entry).is_err());
        entry.trusted_web_granted = true;
        assert!(require_trusted_web_consent(&manifest, &entry).is_ok());
        entry.trusted_web_granted = false;
        assert!(require_trusted_web_consent(&manifest, &entry).is_err());
    }

    #[test]
    fn upgrade_crash_after_code_swap_reloads_without_trust() {
        let root = canonical_test_temp_dir().join(format!("plugin_crash_{}", uuid::Uuid::new_v4()));
        let old_source = source(&root, "1.0.0");
        let new_source = source(&root, "2.0.0");
        let mut manager = trusted_manager(&root);
        install_plugin_fs_stage(old_source.to_str().unwrap(), manager.plugins_dir()).unwrap();
        let mut prepared =
            prepare_plugin_install(new_source.to_str().unwrap(), manager.plugins_dir(), true).unwrap();
        reset_install_trust(
            manager.get_config_mut(),
            &prepared.manifest.id,
            prepared.source_label,
        );
        persist_install_trust_reset(&mut manager).unwrap();
        // During the old-worker/new-code window the live backend is already
        // disabled, not merely the config that will be read on next startup.
        assert!(!manager.get_config().entities.plugin_configs[0].enabled);
        assert!(!manager.get_config().entities.plugin_configs[0].trusted_web_granted);
        assert!(manager.get_config().entities.plugin_configs[0]
            .granted_permissions
            .is_empty());
        let before_swap = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
        assert!(!before_swap.get_config().entities.plugin_configs[0].enabled);
        assert_eq!(
            fs::read_to_string(before_swap.plugins_dir().join("com.example.test/main.js")).unwrap(),
            "1.0.0"
        );
        drop(before_swap);
        commit_plugin_install(&mut prepared, manager.get_config().revision).unwrap();
        // Model process death before any response/cleanup and fresh startup.
        drop(manager);
        let reloaded = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
        let entry = &reloaded.get_config().entities.plugin_configs[0];
        assert!(!entry.enabled);
        assert!(!entry.trusted_web_granted);
        assert!(entry.granted_permissions.is_empty());
        assert!(entry.installed_at.unwrap() > 1);
        assert_eq!(
            fs::read_to_string(reloaded.plugins_dir().join("com.example.test/main.js")).unwrap(),
            "2.0.0"
        );
        drop(reloaded);
        fs::write(root.join("config.json"), "corrupt config").unwrap();
        let recovered = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
        assert!(!recovered.get_config().entities.plugin_configs[0].enabled);
        assert!(!recovered.get_config().entities.plugin_configs[0].trusted_web_granted);
        assert!(recovered.get_config().entities.plugin_configs[0]
            .granted_permissions
            .is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_commit_keeps_old_code_but_remains_fail_closed() {
        let root = canonical_test_temp_dir()
            .join(format!("plugin_state_rollback_{}", uuid::Uuid::new_v4()));
        let old_source = source(&root, "1.0.0");
        let new_source = source(&root, "2.0.0");
        let mut manager = trusted_manager(&root);
        install_plugin_fs_stage(old_source.to_str().unwrap(), manager.plugins_dir()).unwrap();
        let prepared =
            prepare_plugin_install(new_source.to_str().unwrap(), manager.plugins_dir(), false).unwrap();
        fs::remove_dir_all(&prepared.stage_guard.0).unwrap();
        assert!(install_prepared(&mut manager, prepared, None).is_err());
        let reloaded = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
        let entry = &reloaded.get_config().entities.plugin_configs[0];
        assert!(!entry.enabled);
        assert!(entry.granted_permissions.is_empty());
        assert_ne!(entry.install_generation, "old-generation");
        assert_eq!(
            fs::read_to_string(reloaded.plugins_dir().join("com.example.test/main.js")).unwrap(),
            "1.0.0"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_precommit_save_never_changes_code_or_memory_trust() {
        let root =
            canonical_test_temp_dir().join(format!("plugin_save_fail_{}", uuid::Uuid::new_v4()));
        let old_source = source(&root, "1.0.0");
        let new_source = source(&root, "2.0.0");
        let mut manager = trusted_manager(&root);
        install_plugin_fs_stage(old_source.to_str().unwrap(), manager.plugins_dir()).unwrap();
        let prepared =
            prepare_plugin_install(new_source.to_str().unwrap(), manager.plugins_dir(), false).unwrap();
        // ConfigManager's atomic save cannot open a directory as its temp file.
        fs::create_dir(root.join("config.json.tmp")).unwrap();
        assert!(install_prepared(&mut manager, prepared, None).is_err());
        assert!(manager.get_config().entities.plugin_configs[0].enabled);
        assert_eq!(
            fs::read_to_string(manager.plugins_dir().join("com.example.test/main.js")).unwrap(),
            "1.0.0"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_backup_persistence_never_swaps_executable_code() {
        let root = canonical_test_temp_dir()
            .join(format!("plugin_backup_save_fail_{}", uuid::Uuid::new_v4()));
        let old_source = source(&root, "1.0.0");
        let new_source = source(&root, "2.0.0");
        let mut manager = trusted_manager(&root);
        install_plugin_fs_stage(old_source.to_str().unwrap(), manager.plugins_dir()).unwrap();
        let prepared =
            prepare_plugin_install(new_source.to_str().unwrap(), manager.plugins_dir(), false).unwrap();
        let backup = root.join("config.json.bak");
        if backup.exists() {
            fs::remove_file(&backup).unwrap();
        }
        fs::create_dir(&backup).unwrap();
        assert!(install_prepared(&mut manager, prepared, None).is_err());
        assert_eq!(
            fs::read_to_string(manager.plugins_dir().join("com.example.test/main.js")).unwrap(),
            "1.0.0"
        );
        assert!(manager.get_config().entities.plugin_configs[0].enabled);
        fs::remove_dir_all(root).unwrap();
    }

    struct DirectoryCopyHookGuard;
    impl Drop for DirectoryCopyHookGuard {
        fn drop(&mut self) {
            DIRECTORY_COPY_HOOK.with(|hook| *hook.borrow_mut() = None);
        }
    }
    fn with_directory_copy_hook(
        hook: impl FnMut(DirectoryCopyStep, &Path) + 'static,
        run: impl FnOnce(),
    ) {
        DIRECTORY_COPY_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
        let _guard = DirectoryCopyHookGuard;
        run();
    }

    #[test]
    fn directory_copy_keeps_regular_tree_and_streaming_budget() {
        let root =
            canonical_test_temp_dir().join(format!("plugin_copy_regular_{}", uuid::Uuid::new_v4()));
        let src = source(&root, "1.0.0");
        fs::create_dir(src.join("nested")).unwrap();
        fs::write(src.join("nested/asset.txt"), "asset").unwrap();
        let mut budget = plugin::MAX_ZIP_UNCOMPRESSED_BYTES;
        copy_dir_recursive(&src, &root.join("out"), &mut budget).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("out/nested/asset.txt")).unwrap(),
            "asset"
        );
        let bytes = manifest("1.0.0").len() as u64 + 5 + 5;
        assert_eq!(budget, plugin::MAX_ZIP_UNCOMPRESSED_BYTES - bytes);
        let mut tiny = 1;
        assert!(copy_dir_recursive(&src, &root.join("too-large"), &mut tiny).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_copy_rejects_hardlinked_source_bytes() {
        let root = canonical_test_temp_dir()
            .join(format!("plugin_copy_hardlink_{}", uuid::Uuid::new_v4()));
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(root.join("private"), "private bytes").unwrap();
        fs::hard_link(root.join("private"), src.join("asset")).unwrap();
        let mut budget = plugin::MAX_ZIP_UNCOMPRESSED_BYTES;
        assert!(copy_dir_recursive(&src, &root.join("out"), &mut budget).is_err());
        assert!(!root.join("out/asset").exists());
        assert_eq!(budget, plugin::MAX_ZIP_UNCOMPRESSED_BYTES);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn directory_copy_rejects_symlink_file_and_source_ancestors() {
        use std::os::unix::fs::symlink;
        let root =
            canonical_test_temp_dir().join(format!("plugin_copy_links_{}", uuid::Uuid::new_v4()));
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(root.join("private"), "private bytes").unwrap();
        symlink(root.join("private"), src.join("asset")).unwrap();
        let mut budget = plugin::MAX_ZIP_UNCOMPRESSED_BYTES;
        assert!(copy_dir_recursive(&src, &root.join("out"), &mut budget).is_err());
        assert!(!root.join("out/asset").exists());
        fs::remove_file(src.join("asset")).unwrap();
        fs::write(src.join("asset"), "ordinary").unwrap();
        symlink(&src, root.join("alias")).unwrap();
        assert!(
            copy_dir_recursive(&root.join("alias"), &root.join("alias-out"), &mut budget).is_err()
        );
        symlink(&root, root.join("ancestor")).unwrap();
        assert!(copy_dir_recursive(
            &root.join("ancestor/src"),
            &root.join("ancestor-out"),
            &mut budget
        )
        .is_err());
        fs::remove_file(root.join("ancestor")).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn directory_copy_rejects_symlink_swapped_after_type_check() {
        use std::os::unix::fs::symlink;
        let root = canonical_test_temp_dir()
            .join(format!("plugin_copy_file_swap_{}", uuid::Uuid::new_v4()));
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("asset"), "ordinary").unwrap();
        fs::write(root.join("private"), "private bytes").unwrap();
        let attack = root.clone();
        with_directory_copy_hook(
            move |step, target| {
                if step == DirectoryCopyStep::BeforeOpen && target.file_name().unwrap() == "asset" {
                    fs::remove_file(attack.join("src/asset")).unwrap();
                    symlink(attack.join("private"), attack.join("src/asset")).unwrap();
                }
            },
            || {
                let mut budget = plugin::MAX_ZIP_UNCOMPRESSED_BYTES;
                assert!(copy_dir_recursive(&src, &root.join("out"), &mut budget).is_err());
                assert!(!root.join("out/asset").exists());
                assert_eq!(budget, plugin::MAX_ZIP_UNCOMPRESSED_BYTES);
            },
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn directory_copy_rejects_changed_ancestor_between_scan_and_copy() {
        use std::os::unix::fs::symlink;
        let root = canonical_test_temp_dir().join(format!(
            "plugin_copy_ancestor_swap_{}",
            uuid::Uuid::new_v4()
        ));
        let src = root.join("src");
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::create_dir(root.join("private")).unwrap();
        fs::write(src.join("nested/asset"), "ordinary").unwrap();
        fs::write(root.join("private/asset"), "private bytes").unwrap();
        let attack = root.clone();
        with_directory_copy_hook(
            move |step, target| {
                if step == DirectoryCopyStep::DirectoryOpened
                    && target.file_name().unwrap() == "nested"
                {
                    fs::rename(attack.join("src/nested"), attack.join("retained")).unwrap();
                    symlink(attack.join("private"), attack.join("src/nested")).unwrap();
                }
            },
            || {
                let mut budget = plugin::MAX_ZIP_UNCOMPRESSED_BYTES;
                assert!(copy_dir_recursive(&src, &root.join("out"), &mut budget).is_err());
                assert!(!root.join("out/nested/asset").exists());
            },
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn directory_copy_rejects_fifo_before_and_after_type_check() {
        use std::os::unix::ffi::OsStrExt;
        fn fifo(path: &Path) {
            let name = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        }
        let root =
            canonical_test_temp_dir().join(format!("plugin_copy_fifo_{}", uuid::Uuid::new_v4()));
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fifo(&src.join("asset"));
        let mut budget = plugin::MAX_ZIP_UNCOMPRESSED_BYTES;
        assert!(copy_dir_recursive(&src, &root.join("out"), &mut budget).is_err());
        fs::remove_file(src.join("asset")).unwrap();
        fs::write(src.join("asset"), "ordinary").unwrap();
        let attack = root.clone();
        with_directory_copy_hook(
            move |step, target| {
                if step == DirectoryCopyStep::BeforeOpen && target.file_name().unwrap() == "asset" {
                    fs::remove_file(attack.join("src/asset")).unwrap();
                    fifo(&attack.join("src/asset"));
                }
            },
            || {
                assert!(copy_dir_recursive(&src, &root.join("swapped-out"), &mut budget).is_err());
                assert!(!root.join("swapped-out/asset").exists());
                assert_eq!(budget, plugin::MAX_ZIP_UNCOMPRESSED_BYTES);
            },
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    fn directory_copy_junction(link: &Path, target: &Path) {
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction fixture: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(windows)]
    #[test]
    fn directory_copy_rejects_junction_source_and_ancestors() {
        let root = canonical_test_temp_dir()
            .join(format!("plugin_copy_junction_{}", uuid::Uuid::new_v4()));
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::create_dir(root.join("private")).unwrap();
        fs::write(root.join("private/asset"), "private bytes").unwrap();
        directory_copy_junction(&src.join("nested"), &root.join("private"));
        let mut budget = plugin::MAX_ZIP_UNCOMPRESSED_BYTES;
        assert!(copy_dir_recursive(&src, &root.join("out"), &mut budget).is_err());
        assert!(!root.join("out/nested/asset").exists());
        directory_copy_junction(&root.join("alias"), &src);
        assert!(
            copy_dir_recursive(&root.join("alias"), &root.join("alias-out"), &mut budget).is_err()
        );
        directory_copy_junction(&root.join("ancestor"), &root);
        assert!(copy_dir_recursive(
            &root.join("ancestor/src"),
            &root.join("ancestor-out"),
            &mut budget
        )
        .is_err());
        fs::remove_dir(src.join("nested")).unwrap();
        fs::remove_dir(root.join("alias")).unwrap();
        fs::remove_dir(root.join("ancestor")).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn directory_copy_rejects_junction_swapped_after_type_check() {
        let root = canonical_test_temp_dir().join(format!(
            "plugin_copy_junction_swap_{}",
            uuid::Uuid::new_v4()
        ));
        let src = root.join("src");
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::create_dir(root.join("private")).unwrap();
        fs::write(root.join("private/asset"), "private bytes").unwrap();
        let attack = root.clone();
        with_directory_copy_hook(
            move |step, target| {
                if step == DirectoryCopyStep::BeforeOpen && target.file_name().unwrap() == "nested"
                {
                    fs::remove_dir(attack.join("src/nested")).unwrap();
                    directory_copy_junction(&attack.join("src/nested"), &attack.join("private"));
                }
            },
            || {
                let mut budget = plugin::MAX_ZIP_UNCOMPRESSED_BYTES;
                assert!(copy_dir_recursive(&src, &root.join("out"), &mut budget).is_err());
                assert!(!root.join("out/nested/asset").exists());
                assert_eq!(budget, plugin::MAX_ZIP_UNCOMPRESSED_BYTES);
            },
        );
        fs::remove_dir(src.join("nested")).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn directory_copy_rejects_hardlink_swapped_after_type_check() {
        let root = canonical_test_temp_dir().join(format!(
            "plugin_copy_hardlink_swap_{}",
            uuid::Uuid::new_v4()
        ));
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("asset"), "ordinary").unwrap();
        fs::write(root.join("private"), "private bytes").unwrap();
        let attack = root.clone();
        let outcome = std::rc::Rc::new(std::cell::Cell::new(None));
        let attack_outcome = outcome.clone();
        with_directory_copy_hook(
            move |step, target| {
                if step == DirectoryCopyStep::BeforeOpen && target.file_name().unwrap() == "asset" {
                    fs::remove_file(attack.join("src/asset")).unwrap();
                    match fs::hard_link(attack.join("private"), attack.join("src/asset")) {
                        Ok(()) => attack_outcome.set(Some(false)),
                        Err(error) => {
                            // Windows may reject the mutation itself because the
                            // selected source directory is pinned without WRITE.
                            assert_eq!(error.raw_os_error(), Some(32));
                            assert!(!attack.join("src/asset").exists());
                            attack_outcome.set(Some(true));
                        }
                    }
                }
            },
            || {
                let mut budget = plugin::MAX_ZIP_UNCOMPRESSED_BYTES;
                assert!(copy_dir_recursive(&src, &root.join("out"), &mut budget).is_err());
                assert!(!root.join("out/asset").exists());
                assert_eq!(budget, plugin::MAX_ZIP_UNCOMPRESSED_BYTES);
                assert!(outcome.get().is_some(), "swap hook must execute");
                assert_eq!(
                    fs::read_to_string(root.join("private")).unwrap(),
                    "private bytes"
                );
            },
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn directory_copy_rejects_device_namespace_before_open() {
        let out =
            canonical_test_temp_dir().join(format!("plugin_copy_device_{}", uuid::Uuid::new_v4()));
        let mut budget = plugin::MAX_ZIP_UNCOMPRESSED_BYTES;
        assert!(copy_dir_recursive(
            Path::new(r"\\.\pipe\hypercom-never-open"),
            &out,
            &mut budget
        )
        .is_err());
        assert!(!out.exists());
    }

    #[cfg(windows)]
    #[test]
    fn directory_copy_does_not_lock_unrelated_ancestor_children() {
        let root =
            canonical_test_temp_dir().join(format!("plugin_copy_sibling_{}", uuid::Uuid::new_v4()));
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("asset"), "ordinary").unwrap();
        fs::write(root.join("outside"), "sibling").unwrap();
        let sibling = root.join("plugins/com.example.keep");
        fs::create_dir_all(sibling.join("data")).unwrap();
        fs::write(sibling.join("data/keep"), "user").unwrap();
        let attack = root.clone();
        with_directory_copy_hook(
            move |step, target| {
                if step == DirectoryCopyStep::BeforeOpen && target.file_name().unwrap() == "asset" {
                    fs::hard_link(attack.join("outside"), attack.join("outside-link")).unwrap();
                    let (dest, backup) =
                        stage_uninstall_fs(&attack.join("plugins"), "com.example.keep").unwrap();
                    fs::rename(backup.unwrap(), dest).unwrap();
                }
            },
            || {
                let mut budget = plugin::MAX_ZIP_UNCOMPRESSED_BYTES;
                copy_dir_recursive(&src, &root.join("out"), &mut budget).unwrap();
                assert_eq!(
                    fs::read_to_string(root.join("out/asset")).unwrap(),
                    "ordinary"
                );
            },
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn directory_copy_pins_opened_ancestor_against_rename() {
        let root =
            canonical_test_temp_dir().join(format!("plugin_copy_pin_{}", uuid::Uuid::new_v4()));
        let src = root.join("src");
        fs::create_dir_all(src.join("nested")).unwrap();
        fs::write(src.join("nested/asset"), "ordinary").unwrap();
        let attack = root.clone();
        with_directory_copy_hook(
            move |step, target| {
                if step == DirectoryCopyStep::DirectoryOpened
                    && target.file_name().unwrap() == "nested"
                {
                    let error =
                        fs::rename(attack.join("src/nested"), attack.join("moved")).unwrap_err();
                    assert_eq!(error.raw_os_error(), Some(32)); // ERROR_SHARING_VIOLATION
                }
            },
            || {
                let mut budget = plugin::MAX_ZIP_UNCOMPRESSED_BYTES;
                copy_dir_recursive(&src, &root.join("out"), &mut budget).unwrap();
                assert_eq!(
                    fs::read_to_string(root.join("out/nested/asset")).unwrap(),
                    "ordinary"
                );
            },
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_copy_rejects_empty_file_count_and_depth() {
        let root =
            canonical_test_temp_dir().join(format!("plugin_copy_limits_{}", uuid::Uuid::new_v4()));
        let src = root.join("src");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("empty"), "").unwrap();
        let out = root.join("out");
        assert!(source_copy::copy_verified(&out, None, CopyControl::SILENT, |pass| {
            let mut count = source_copy::MAX_LOCAL_ENTRIES;
            copy_dir_recursive_inner(&src, &out, pass, 0, &mut count)
        }).is_err());
        fs::create_dir(src.join("nested")).unwrap();
        assert!(source_copy::copy_verified(&out, None, CopyControl::SILENT, |pass| {
            copy_dir_recursive_inner(&src, &out, pass, plugin::MAX_PLUGIN_SOURCE_DEPTH, &mut 0)
        }).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn queued_old_control_intent_is_rejected_after_install_gate() {
        let gate = tokio::sync::Mutex::new(());
        let installing = gate.lock().await;
        let mut cfg = config::AppConfig::default();
        reset_install_trust(&mut cfg, "com.example.test", "dir");
        let captured = cfg.entities.plugin_configs[0].install_generation.clone();
        let mut queued = std::pin::pin!(gate.lock());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut queued)
                .await
                .is_err()
        );
        reset_install_trust(&mut cfg, "com.example.test", "dir");
        drop(installing);
        let _control = queued.await;
        // Both commands check before modifying even a revoke or crash-disable.
        assert!(require_generation(&cfg, "com.example.test", &captured).is_err());
        assert!(!cfg.entities.plugin_configs[0].enabled);
        assert!(cfg.entities.plugin_configs[0]
            .granted_permissions
            .is_empty());
    }

    #[test]
    fn mixed_local_and_marketplace_install_resets_provenance_and_trust() {
        let mut cfg = config::AppConfig::default();
        reset_install_trust(&mut cfg, "com.example.test", "dir");
        let entry = &mut cfg.entities.plugin_configs[0];
        entry.enabled = true;
        entry.trusted_web_granted = true;
        entry.granted_permissions.push("serial:send".into());
        let local_generation = entry.install_generation.clone();

        reset_install_trust_with_url(
            &mut cfg,
            "com.example.test",
            "marketplace",
            Some("https://example.test/releases/demo.zip"),
        );
        let entry = &cfg.entities.plugin_configs[0];
        assert_eq!(entry.source.as_deref(), Some("marketplace"));
        assert_eq!(entry.update_url.as_deref(), Some("https://example.test/releases/demo.zip"));
        assert!(!entry.enabled);
        assert!(!entry.trusted_web_granted);
        assert!(entry.granted_permissions.is_empty());
        assert_ne!(entry.install_generation, local_generation);

        reset_install_trust(&mut cfg, "com.example.test", "zip");
        let entry = &cfg.entities.plugin_configs[0];
        assert_eq!(entry.source.as_deref(), Some("zip"));
        assert!(entry.update_url.is_none());
        assert_ne!(entry.install_generation, local_generation);
    }

    #[test]
    fn data_paths_classify_first_component_and_reject_windows_aliases() {
        for raw in [
            "data/key",
            "DATA/key",
            "DaTa\\state.json",
            "./data/state.json",
        ] {
            let rel = sanitize_asset_path(raw).unwrap();
            assert!(is_data_path(&rel), "{raw}");
            assert!(rel.starts_with("data"));
        }
        for raw in ["database/key", "datafile", "assets/data/key"] {
            assert!(!is_data_path(&sanitize_asset_path(raw).unwrap()), "{raw}");
        }
        for raw in [
            "data./key",
            "data /key",
            "data:key",
            "data/key:stream",
            "DATA./state.json",
            "DATA~1/key",
        ] {
            assert!(sanitize_asset_path(raw).is_err(), "{raw}");
        }
    }

    #[test]
    fn legacy_file_authorities_retire_without_poisoning_a_new_runtime() {
        let id = format!("com.example.{}", uuid::Uuid::new_v4().simple());
        let old = legacy_file_authority(&id, LegacyFileScope::Assets).unwrap();
        let same = legacy_file_authority(&id, LegacyFileScope::Assets).unwrap();
        assert!(std::sync::Arc::ptr_eq(&old, &same));
        cancel_legacy_file_authority(&id);
        assert!(require_live_file_authority(&old).is_err());
        let next = legacy_file_authority(&id, LegacyFileScope::Assets).unwrap();
        assert!(!std::sync::Arc::ptr_eq(&old, &next));
        assert!(require_live_file_authority(&next).is_ok());
    }

    #[test]
    fn opened_asset_reads_the_original_file_after_path_replacement() {
        let root = canonical_test_temp_dir().join(format!("plugin_open_handle_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("data")).unwrap();
        fs::write(root.join("data/file.bin"), b"original").unwrap();
        let opened = open_authorized_asset(&root, Path::new("data/file.bin")).unwrap().unwrap();
        fs::rename(root.join("data/file.bin"), root.join("data/old.bin")).unwrap();
        fs::write(root.join("data/file.bin"), b"replacement").unwrap();
        assert_eq!(read_open_asset(opened).unwrap(), b"original");
        assert_eq!(read_authorized_asset(&root, Path::new("data/file.bin")).unwrap().unwrap(), b"replacement");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn abandoned_staged_asset_write_preserves_the_committed_target() {
        let root = canonical_test_temp_dir().join(format!("plugin_staged_write_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("file.bin");
        fs::write(&target, b"committed").unwrap();
        let mut staged = PreparedAssetWrite::new(root.clone(), target.clone()).unwrap();
        let temporary = staged.temporary.clone();
        staged.write(b"not published").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"committed");
        drop(staged);
        assert!(!temporary.exists());
        assert_eq!(fs::read(&target).unwrap(), b"committed");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancelled_legacy_reads_and_writes_do_not_publish_data() {
        let root = canonical_test_temp_dir().join(format!("plugin_cancelled_io_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("data")).unwrap();
        let target = root.join("data/file.bin");
        fs::write(&target, b"committed").unwrap();
        let opened = open_authorized_asset(&root, Path::new("data/file.bin")).unwrap().unwrap();
        let (cancel, _) = tokio::sync::watch::channel(true);
        let authority = LegacyFileAuthority(cancel);
        assert!(read_open_asset_cancellable(opened, Some(&authority)).is_err());
        let mut staged = PreparedAssetWrite::new(root.join("data"), target.clone()).unwrap();
        assert!(staged.write_cancellable(b"forbidden", Some(&authority)).is_err());
        drop(staged);
        assert_eq!(fs::read(&target).unwrap(), b"committed");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn data_reads_return_large_private_files_exactly() {
        use std::io::{Seek, SeekFrom, Write};
        let root = canonical_test_temp_dir().join(format!("plugin_read_unlimited_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("data")).unwrap();
        let size = 16 * 1024 * 1024 + 1;
        let mut file = fs::File::create(root.join("data/large.bin")).unwrap();
        file.set_len(size).unwrap();
        file.seek(SeekFrom::End(-1)).unwrap();
        file.write_all(&[255]).unwrap();
        drop(file);
        let bytes = read_authorized_asset(&root, Path::new("data/large.bin")).unwrap().unwrap();
        assert_eq!(bytes.len(), size as usize);
        assert_eq!(bytes[0], 0);
        assert_eq!(bytes[bytes.len() - 1], 255);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_ids_cannot_delete_root_or_siblings() {
        let root =
            canonical_test_temp_dir().join(format!("plugin_id_test_{}", uuid::Uuid::new_v4()));
        let sibling = root.join("com.example.keep");
        fs::create_dir_all(&sibling).unwrap();
        fs::write(sibling.join("keep"), "intact").unwrap();
        for id in [
            ".",
            "..",
            "",
            "../com.example.keep",
            "com..bad",
            "com.",
            ".bad",
        ] {
            assert!(stage_uninstall_fs(&root, id).is_err(), "{id}");
        }
        assert_eq!(fs::read_to_string(sibling.join("keep")).unwrap(), "intact");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn uninstall_backup_can_restore_private_data_after_save_failure() {
        let root =
            canonical_test_temp_dir().join(format!("plugin_uninstall_{}", uuid::Uuid::new_v4()));
        let plugin_dir = root.join("com.example.keep");
        fs::create_dir_all(plugin_dir.join("data")).unwrap();
        fs::write(plugin_dir.join("data/keep"), "user").unwrap();
        let (dest, backup) = stage_uninstall_fs(&root, "com.example.keep").unwrap();
        let backup = backup.unwrap();
        assert!(!dest.exists());
        assert_eq!(
            fs::read_to_string(backup.join("data/keep")).unwrap(),
            "user"
        );
        fs::rename(backup, &dest).unwrap();
        assert_eq!(fs::read_to_string(dest.join("data/keep")).unwrap(), "user");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn atomic_write_replaces_existing_content() {
        let root = canonical_test_temp_dir().join(format!("plugin_write_{}", uuid::Uuid::new_v4()));
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
        let root =
            canonical_test_temp_dir().join(format!("plugin_write_link_{}", uuid::Uuid::new_v4()));
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
        let root =
            canonical_test_temp_dir().join(format!("plugin_upgrade_{}", uuid::Uuid::new_v4()));
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
        let backup = install_plugin_fs_stage(src2.to_str().unwrap(), &plugins)
            .unwrap()
            .3
            .unwrap();
        assert_eq!(fs::read_to_string(dest.join("data/keep")).unwrap(), "user");
        assert_eq!(fs::read_to_string(dest.join("main.js")).unwrap(), "2.0.0");
        assert!(!dest.join("legacy.js").exists());
        assert_eq!(fs::read_to_string(backup.join("main.js")).unwrap(), "1.0.0");
        fs::remove_dir_all(backup).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_upgrade_entry_preserves_existing_plugin_and_data() {
        let root = canonical_test_temp_dir()
            .join(format!("plugin_missing_entry_{}", uuid::Uuid::new_v4()));
        let original = source(&root, "1.0.0");
        let upgrade = source(&root, "2.0.0");
        let plugins = root.join("plugins");
        install_plugin_fs_stage(original.to_str().unwrap(), &plugins).unwrap();
        let destination = plugins.join("com.example.test");
        fs::create_dir_all(destination.join("data")).unwrap();
        fs::write(destination.join("data/keep"), "saved").unwrap();
        fs::remove_file(upgrade.join("main.js")).unwrap();

        assert!(install_plugin_fs_stage(upgrade.to_str().unwrap(), &plugins).is_err());
        assert_eq!(
            fs::read_to_string(destination.join("main.js")).unwrap(),
            "1.0.0"
        );
        assert_eq!(
            fs::read_to_string(destination.join("data/keep")).unwrap(),
            "saved"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn same_version_install_requires_explicit_replacement() {
        let root =
            canonical_test_temp_dir().join(format!("plugin_replace_{}", uuid::Uuid::new_v4()));
        let src = source(&root, "1.0.0");
        let plugins = root.join("plugins");
        install_plugin_fs_stage(src.to_str().unwrap(), &plugins).unwrap();
        let dest = plugins.join("com.example.test");
        fs::create_dir_all(dest.join("data")).unwrap();
        fs::write(dest.join("data/keep"), "user").unwrap();

        let err = prepare_plugin_install(src.to_str().unwrap(), &plugins, false)
        .err()
        .unwrap()
        .to_string();
        assert!(
            err.starts_with("plugin_replace_confirmation_required:"),
            "err: {err}"
        );

        let mut prepared = prepare_plugin_install(src.to_str().unwrap(), &plugins, true).unwrap();
        let (backup, transaction) = commit_plugin_install(&mut prepared, 1).unwrap();
        transaction.finish(&plugins).unwrap();
        assert_eq!(fs::read_to_string(dest.join("data/keep")).unwrap(), "user");
        assert_eq!(fs::read_to_string(dest.join("main.js")).unwrap(), "1.0.0");
        if let Some(backup) = backup {
            fs::remove_dir_all(backup).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    fn pure_html_source(root: &Path, entry: &str) -> std::path::PathBuf {
        let src = root.join(format!("html-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(src.join("ui")).unwrap();
        let manifest = serde_json::json!({
            "id": "com.example.html",
            "name": "HTML",
            "version": "1.0.0",
            "apiVersion": "1.0",
            "permissions": ["ui:view"],
            "requires": ["trusted-web-view@1", "plugin-workspace-tabs@1"],
            "ui": {"views": [{
                "id": "web", "label": "Web", "entry": entry, "mode": "trusted-web",
                "modes": ["trx"], "input": "none", "placements": ["workspace-tab"],
                "portBinding": "none", "worker": false
            }]}
        });
        fs::write(src.join("manifest.json"), manifest.to_string()).unwrap();
        let file = src.join(entry);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, "<!doctype html><html></html>").unwrap();
        src
    }

    #[test]
    fn missing_root_entry_allows_pure_trusted_html_plugins() {
        let root =
            canonical_test_temp_dir().join(format!("plugin_html_{}", uuid::Uuid::new_v4()));
        let src = pure_html_source(&root, "ui/index.html");
        let plugins = root.join("plugins");
        let prepared = prepare_plugin_install(src.to_str().unwrap(), &plugins, false).unwrap();
        assert!(prepared.stage_guard.0.join("ui/index.html").is_file());
        assert!(prepared.manifest.entry.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_root_entry_rejects_worker_dependent_views() {
        let root = canonical_test_temp_dir()
            .join(format!("plugin_html_reject_{}", uuid::Uuid::new_v4()));
        let src = pure_html_source(&root, "ui/index.html");
        let mut manifest: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(src.join("manifest.json")).unwrap()).unwrap();
        manifest["ui"]["views"][0]["mode"] = "isolated".into();
        manifest["ui"]["views"][0]["entry"] = "ui/main.js".into();
        manifest["requires"] = serde_json::json!(["isolated-tab-view@1", "plugin-workspace-tabs@1"]);
        fs::write(src.join("manifest.json"), manifest.to_string()).unwrap();
        fs::write(src.join("ui/main.js"), "").unwrap();
        let err = prepare_plugin_install(
            src.to_str().unwrap(),
            &root.join("plugins"),
            false,
        )
        .err()
        .unwrap()
        .to_string();
        assert!(err.contains("缺少 entry"), "err: {err}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_upgrade_keeps_old_code_and_private_data() {
        let root = canonical_test_temp_dir()
            .join(format!("plugin_failed_upgrade_{}", uuid::Uuid::new_v4()));
        let src1 = source(&root, "1.0.0");
        let src2 = source(&root, "2.0.0");
        let plugins = root.join("plugins");
        install_plugin_fs_stage(src1.to_str().unwrap(), &plugins).unwrap();
        let dest = plugins.join("com.example.test");
        fs::create_dir_all(dest.join("data")).unwrap();
        fs::write(dest.join("data/keep"), "user").unwrap();
        // A large directory is valid now; a hardlinked source is still rejected.
        fs::hard_link(src1.join("main.js"), src2.join("linked.bin")).unwrap();
        assert!(install_plugin_fs_stage(src2.to_str().unwrap(), &plugins).is_err());
        assert_eq!(fs::read_to_string(dest.join("main.js")).unwrap(), "1.0.0");
        assert_eq!(fs::read_to_string(dest.join("data/keep")).unwrap(), "user");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_upgrade_recovers_each_rename_boundary_idempotently() {
        for boundary in 0..=3 {
            let root =
                canonical_test_temp_dir().join(format!("plugin_boundary_{}", uuid::Uuid::new_v4()));
            let old_source = source(&root, "1.0.0");
            let new_source = source(&root, "2.0.0");
            let mut manager = trusted_manager(&root);
            install_plugin_fs_stage(old_source.to_str().unwrap(), manager.plugins_dir()).unwrap();
            let plugins = manager.plugins_dir().to_path_buf();
            let dest = plugins.join("com.example.test");
            fs::create_dir(dest.join("data")).unwrap();
            fs::write(dest.join("data/keep"), "private").unwrap();
            let mut prepared =
                prepare_plugin_install(new_source.to_str().unwrap(), &plugins, true).unwrap();
            reset_install_trust(manager.get_config_mut(), "com.example.test", "dir");
            persist_install_trust_reset(&mut manager).unwrap();
            let stage = prepared.stage_guard.0.clone();
            let mut tx = plugin::transaction::Transaction::install(
                &plugins,
                "com.example.test",
                &stage,
                manager.get_config().revision,
            )
            .unwrap();
            prepared.stage_guard.0.clear();
            if boundary >= 1 {
                tx.phase(&plugins, "backup").unwrap();
                plugin::transaction::rename(&plugins, &dest, &tx.backup(&plugins)).unwrap();
            }
            if boundary >= 2 {
                tx.phase(&plugins, "private-data").unwrap();
                plugin::transaction::rename(
                    &plugins,
                    &tx.backup(&plugins).join("data"),
                    &stage.join("data"),
                )
                .unwrap();
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
                assert!(loaded.get_config().entities.plugin_configs[0]
                    .granted_permissions
                    .is_empty());
                assert_eq!(
                    fs::read_to_string(dest.join("data/keep")).unwrap(),
                    "private"
                );
                assert_eq!(
                    fs::read_to_string(dest.join("main.js")).unwrap(),
                    if boundary == 3 { "2.0.0" } else { "1.0.0" }
                );
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn interrupted_uninstall_uses_durable_config_commit() {
        for boundary in 0..=2 {
            let root = canonical_test_temp_dir().join(format!(
                "plugin_uninstall_boundary_{}",
                uuid::Uuid::new_v4()
            ));
            let src = source(&root, "1.0.0");
            let mut manager = trusted_manager(&root);
            install_plugin_fs_stage(src.to_str().unwrap(), manager.plugins_dir()).unwrap();
            let plugins = manager.plugins_dir().to_path_buf();
            let dest = plugins.join("com.example.test");
            fs::create_dir(dest.join("data")).unwrap();
            fs::write(dest.join("data/keep"), "private").unwrap();
            let tx = plugin::transaction::Transaction::uninstall(
                &plugins,
                "com.example.test",
                manager.get_config().revision + 1,
            )
            .unwrap();
            if boundary >= 1 {
                plugin::transaction::rename(&plugins, &dest, &tx.backup(&plugins)).unwrap();
            }
            if boundary == 2 {
                manager.get_config_mut().entities.plugin_configs.clear();
                manager.save().unwrap();
                manager.save_safe_backup().unwrap();
            }
            drop(manager);
            for _ in 0..2 {
                let loaded = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
                assert_eq!(
                    loaded.get_config().entities.plugin_configs.is_empty(),
                    boundary == 2
                );
                if boundary == 2 {
                    assert!(!dest.exists());
                } else {
                    assert_eq!(
                        fs::read_to_string(dest.join("data/keep")).unwrap(),
                        "private"
                    );
                }
            }
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn uninstall_revokes_directory_grants_only_when_primary_commits() {
        use super::super::file::{create_directory_grant, directory_grant_root};

        for outcome in ["primary failure", "backup failure", "success"] {
            let nonce = uuid::Uuid::new_v4().simple().to_string();
            let root = canonical_test_temp_dir().join(format!("plugin_uninstall_grant_{nonce}"));
            let _cleanup = TempDirGuard(root.clone());
            let id = format!("com.example.p{nonce}");
            let mut manager = trusted_manager(&root);
            let entry = &mut manager.get_config_mut().entities.plugin_configs[0];
            entry.id = id.clone();
            entry.granted_permissions = vec!["fs:open-dir".into()];
            let generation = entry.install_generation.clone();
            manager.save().unwrap();
            let revision_before = manager.get_config().revision;
            let installed = manager.plugins_dir().join(&id);
            fs::create_dir_all(installed.join("data")).unwrap();
            fs::write(installed.join("data/keep"), "private data").unwrap();
            let grant = create_directory_grant(&id, &generation, root.clone()).unwrap();
            let primary = root.join("config.json");
            let backup = root.join("config.json.bak");
            match outcome {
                "primary failure" => fs::create_dir(root.join("config.json.tmp")).unwrap(),
                "backup failure" => {
                    // A missing old primary bypasses the ordinary pre-write
                    // backup; only the post-commit safe-backup replacement fails.
                    fs::remove_file(&primary).unwrap();
                    fs::remove_file(&backup).unwrap();
                    fs::create_dir(&backup).unwrap();
                }
                _ => {}
            }
            let result = uninstall_with_manager(&mut manager, &id, Some(&generation));
            match outcome {
                "primary failure" => {
                    assert!(matches!(result, Err(CommandError::Config(_))));
                    assert_eq!(manager.get_config().revision, revision_before);
                    assert!(state_of(manager.get_config(), &id).is_some());
                    assert!(installed.join("data/keep").is_file());
                    assert_eq!(directory_grant_root(&id, &grant, &generation).unwrap(), root);
                    revoke_plugin_directory_grants(&id);
                }
                _ => {
                    assert!(state_of(manager.get_config(), &id).is_none());
                    assert!(manager.get_config().revision > revision_before);
                    assert!(directory_grant_root(&id, &grant, &generation).is_err());
                    assert!(!installed.exists());
                    let persisted: config::AppConfig = serde_json::from_slice(&fs::read(&primary).unwrap()).unwrap();
                    assert!(state_of(&persisted, &id).is_none());
                    if outcome == "backup failure" {
                        assert!(matches!(result, Err(CommandError::Config(_))));
                        assert!(root.join("plugin-transaction.json").is_file());
                    } else {
                        assert!(result.is_ok());
                    }
                }
            }
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
        let root =
            canonical_test_temp_dir().join(format!("plugin_snapshot_{}", uuid::Uuid::new_v4()));
        let mut manager = trusted_manager(&root);
        let before = snapshot(&manager).revision;
        manager.save().unwrap();
        assert_eq!(snapshot(&manager).revision, before + 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn successful_install_update_uninstall_reinstall_returns_fresh_identity() {
        let root = canonical_test_temp_dir()
            .join(format!("plugin_identity_cycle_{}", uuid::Uuid::new_v4()));
        let src1 = source(&root, "1.0.0");
        let src2 = source(&root, "2.0.0");
        let mut manager = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
        let prepared =
            prepare_plugin_install(src1.to_str().unwrap(), manager.plugins_dir(), true).unwrap();
        let first = install_prepared(&mut manager, prepared, None).unwrap();
        let prepared =
            prepare_plugin_install(src2.to_str().unwrap(), manager.plugins_dir(), true).unwrap();
        let second = install_prepared(
            &mut manager,
            prepared,
            Some(&first.plugin_configs[0].install_generation),
        )
        .unwrap();
        assert_ne!(
            first.plugin_configs[0].install_generation,
            second.plugin_configs[0].install_generation
        );
        assert!(second.revision > first.revision);
        let removed = uninstall_with_manager(&mut manager, "com.example.test", None).unwrap();
        assert!(removed.plugin_configs.is_empty());
        assert!(removed.revision > second.revision);
        let prepared =
            prepare_plugin_install(src1.to_str().unwrap(), manager.plugins_dir(), true).unwrap();
        let reinstalled = install_prepared(&mut manager, prepared, None).unwrap();
        assert_ne!(
            reinstalled.plugin_configs[0].install_generation,
            first.plugin_configs[0].install_generation
        );
        assert_ne!(
            reinstalled.plugin_configs[0].install_generation,
            second.plugin_configs[0].install_generation
        );
        assert!(!reinstalled.plugin_configs[0].enabled);
        assert!(reinstalled.plugin_configs[0].granted_permissions.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacement_install_rejects_a_stale_expected_generation() {
        let root = canonical_test_temp_dir()
            .join(format!("plugin_expected_gen_{}", uuid::Uuid::new_v4()));
        let src1 = source(&root, "1.0.0");
        let src2 = source(&root, "2.0.0");
        let mut manager = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();

        // Fresh install has no reviewed prior identity, so it omits expectedGeneration.
        let prepared =
            prepare_plugin_install(src1.to_str().unwrap(), manager.plugins_dir(), true).unwrap();
        let first = install_prepared(&mut manager, prepared, None).unwrap();
        let reviewed = first.plugin_configs[0].install_generation.clone();

        // The reviewed identity still matches, so the replacement is allowed.
        let prepared =
            prepare_plugin_install(src2.to_str().unwrap(), manager.plugins_dir(), true).unwrap();
        let second = install_prepared(&mut manager, prepared, Some(&reviewed)).unwrap();
        let latest = second.plugin_configs[0].install_generation.clone();
        assert_ne!(latest, reviewed);

        // Explicit replacement without a reviewed identity is refused even when
        // the currently installed code still exists.
        let revision = manager.get_config().revision;
        let prepared =
            prepare_plugin_install(src1.to_str().unwrap(), manager.plugins_dir(), true).unwrap();
        let error = install_prepared(&mut manager, prepared, None).unwrap_err();
        assert!(matches!(error, CommandError::Other(ref message) if message.contains("必须携带")));
        assert_eq!(manager.get_config().revision, revision);

        // A replacement queued against the old identity must be refused before any
        // durable state or installed file changes.
        let revision = manager.get_config().revision;
        let prepared =
            prepare_plugin_install(src1.to_str().unwrap(), manager.plugins_dir(), true).unwrap();
        let error = install_prepared(&mut manager, prepared, Some(&reviewed)).unwrap_err();
        assert!(
            matches!(error, CommandError::Other(ref message) if message.contains("安装版本已变化")),
            "unexpected error: {error:?}"
        );
        assert_eq!(
            manager.get_config().revision,
            revision,
            "a refused replacement must not touch durable state"
        );
        assert_eq!(
            manager.get_config().entities.plugin_configs[0].install_generation,
            latest
        );

        // An empty identity can never be reviewed, so it is refused the same way.
        let prepared =
            prepare_plugin_install(src1.to_str().unwrap(), manager.plugins_dir(), true).unwrap();
        assert!(install_prepared(&mut manager, prepared, Some("")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn asset_reads_check_only_the_requested_path_not_unrelated_data_entries() {
        let root = canonical_test_temp_dir()
            .join(format!("plugin_missing_corrupt_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("data")).unwrap();
        fs::create_dir(root.join("outside")).unwrap();
        std::os::unix::fs::symlink(root.join("outside"), root.join("data/link")).unwrap();
        assert_eq!(read_authorized_asset(&root, Path::new("data/state.json")).unwrap(), None);
        std::os::unix::fs::symlink(root.join("outside"), root.join("linked")).unwrap();
        assert!(read_authorized_asset(&root, Path::new("linked/missing")).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_first_install_is_disabled_or_absent_without_package_data() {
        for published in [false, true] {
            let root = canonical_test_temp_dir()
                .join(format!("plugin_first_boundary_{}", uuid::Uuid::new_v4()));
            let src = source(&root, "1.0.0");
            fs::create_dir(src.join("data")).unwrap();
            fs::write(src.join("data/injected"), "package").unwrap();
            let mut manager = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
            let mut prepared =
                prepare_plugin_install(src.to_str().unwrap(), manager.plugins_dir(), true).unwrap();
            reset_install_trust(manager.get_config_mut(), "com.example.test", "dir");
            persist_install_trust_reset(&mut manager).unwrap();
            let plugins = manager.plugins_dir().to_path_buf();
            let stage = prepared.stage_guard.0.clone();
            let tx = plugin::transaction::Transaction::install(
                &plugins,
                "com.example.test",
                &stage,
                manager.get_config().revision,
            )
            .unwrap();
            prepared.stage_guard.0.clear();
            if published {
                plugin::transaction::rename(&plugins, &stage, &tx.dest(&plugins)).unwrap();
            }
            drop(manager);
            let loaded = config::ConfigManager::new(Some(root.join("config.json"))).unwrap();
            assert!(!loaded.get_config().entities.plugin_configs[0].enabled);
            assert!(loaded.get_config().entities.plugin_configs[0]
                .granted_permissions
                .is_empty());
            assert_eq!(tx.dest(&plugins).exists(), published);
            assert!(!tx.dest(&plugins).join("data/injected").exists());
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn missing_asset_is_distinct_from_binary_empty_and_path_errors() {
        let root =
            canonical_test_temp_dir().join(format!("plugin_missing_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        assert_eq!(
            read_authorized_asset(&root, Path::new("data/state.json")).unwrap(),
            None
        );
        fs::create_dir(root.join("directory")).unwrap();
        assert!(read_authorized_asset(&root, Path::new("directory")).is_err());
        fs::write(root.join("binary"), [0, 255, 128, 13, 10]).unwrap();
        let bytes = read_authorized_asset(&root, Path::new("binary")).unwrap().unwrap();
        assert_eq!(bytes, [0, 255, 128, 13, 10]);
        assert_eq!(encode_asset(bytes.clone(), PluginFileFormat::Binary), "AP+ADQo=");
        assert_eq!(encode_asset(bytes, PluginFileFormat::Text), "\0\u{fffd}\u{fffd}\r\n");
        fs::write(root.join("file"), "").unwrap();
        assert_eq!(read_authorized_asset(&root, Path::new("file")).unwrap(), Some(Vec::new()));
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
        assert!(url_glob_match(
            "https://a.com/api/**",
            "https://a.com/api/v1/users"
        ));
        assert!(!url_glob_match(
            "https://a.com/api/**",
            "https://a.com/other"
        ));
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
        assert!(url_glob_match(
            "https://symbols.example.com/**",
            upper.as_str()
        ));
        // 默认端口剥离：443 在 https 下被 Url 规范化掉 → 前缀仍匹配。
        let default_port = url::Url::parse("https://symbols.example.com:443/v1").unwrap();
        assert!(url_glob_match(
            "https://symbols.example.com/**",
            default_port.as_str()
        ));
        // 相对段消除：/a/../b → /b（原始串含 ..，归一后与白名单匹配）。
        let dotdot = url::Url::parse("https://symbols.example.com/a/../v1").unwrap();
        assert_eq!(dotdot.as_str(), "https://symbols.example.com/v1");
        assert!(url_glob_match(
            "https://symbols.example.com/**",
            dotdot.as_str()
        ));
        // 非默认端口保留：8443 不被剥离 → 不等于白名单前缀。
        let custom_port = url::Url::parse("https://symbols.example.com:8443/v1").unwrap();
        assert!(!url_glob_match(
            "https://symbols.example.com/**",
            custom_port.as_str()
        ));
    }
}
