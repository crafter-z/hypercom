pub(crate) mod resources;
mod timeline;
#[cfg(windows)]
mod windows;

use std::{collections::HashMap, sync::{Arc, Mutex, LazyLock, atomic::{AtomicBool, Ordering}}, time::Instant};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};
use crate::{AppState, commands::CommandError, plugin::{self, UiView}};

pub const MAX_MESSAGE_BYTES: usize = 256 * 1024;
/// Page -> native binary frames get their own token bucket instead of the
/// ordinary interaction bucket (ACK pacing must not be starved by page
/// interactions), but they must not be completely unthrottled either: every
/// frame is parsed/emitted on the native UI thread.
pub const BINARY_MESSAGE_RATE_PER_SECOND: f64 = 512.0;
pub const BINARY_MESSAGE_BURST: f64 = 1024.0;
/// Cheap pre-parse bounds: both of our senders use UUIDs (36 chars), a bounded
/// upper seq keeps malformed page values from being forwarded to the frontend.
pub const MAX_BINARY_TRANSFER_ID_LEN: usize = 128;
pub const MAX_BINARY_SEQ: u64 = 16_777_216;
const TIMELINE_PREVIEW_RATE: f64 = 20.0;
const TIMELINE_CONTROL_RATE: f64 = 64.0;

/// Simple monotonic token bucket (fractional refill, capped burst).
struct TokenBucket { tokens: f64, updated: Instant }
impl TokenBucket {
    fn new(burst: f64) -> Self { Self { tokens: burst, updated: Instant::now() } }
    fn try_take(&mut self, rate: f64, burst: f64) -> bool {
        self.try_take_at(rate, burst, Instant::now())
    }
    fn try_take_at(&mut self, rate: f64, burst: f64, now: Instant) -> bool {
        let elapsed = now.saturating_duration_since(self.updated).as_secs_f64();
        self.tokens = (self.tokens + elapsed * rate).min(burst);
        self.updated = now;
        if self.tokens < 1.0 { return false; }
        self.tokens -= 1.0;
        true
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub plugin_id: String, pub install_generation: String, pub view_id: String,
    pub tab_id: String, pub placement: String, pub bound_port_id: Option<String>,
    pub tab_session_id: String, pub view_instance_id: String,
    #[serde(default)]
    pub port_mode: Option<String>,
    pub worker_epoch: u64, pub stream_epoch: u64,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OcclusionRect { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rect { pub x: f64, pub y: f64, pub width: f64, pub height: f64, pub zoom_percent: f64 }

#[derive(Default)]
struct DocumentState { current: Option<String> }
pub struct Session {
    pub binding: Binding, pub alive: AtomicBool, permission: Option<&'static str>,
    pub trusted_web: bool,
    rate: Mutex<(Instant, u32)>,
    control_rate: Mutex<TokenBucket>,
    timeline_preview_rate: Mutex<TokenBucket>,
    timeline_control_rate: Mutex<TokenBucket>,
    /// Once set, the first binary rate-limit violation has already retired the
    /// view via `native_error`; later hostile frames must stay silent.
    binary_rate_reported: AtomicBool,
    document: Mutex<DocumentState>,
}
impl Session {
    /// Each top-level navigation retires the previous document identity before
    /// any new page can report ready, so old ACKs/data can never initialize it.
    pub fn begin_document(&self, id: &str) {
        if let Ok(mut document) = self.document.lock() { document.current = Some(id.to_string()); }
    }
    pub fn current_document(&self) -> Option<String> {
        self.document.lock().ok().and_then(|document| document.current.clone())
    }
    fn accepts_document(&self, id: &str) -> bool {
        self.document.lock().map(|document| document.current.as_deref() == Some(id)).unwrap_or(false)
    }
}
#[derive(Default)]
struct Registry { live: HashMap<String, Arc<Session>>, binary_rates: HashMap<String, TokenBucket> }
fn registry() -> &'static Mutex<Registry> { static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(Mutex::default); &REGISTRY }

pub fn require_main(source: &tauri::Webview) -> Result<(), CommandError> {
    if source.label() != "main" || source.window().label() != "main" {
        return Err(CommandError::Other("插件视图命令仅允许主 WebView 调用".into()));
    }
    Ok(())
}
fn error(message: impl Into<String>) -> CommandError { CommandError::Other(message.into()) }

fn authorized(app: &tauri::AppHandle, session: &Session) -> bool {
    if !session.alive.load(Ordering::Acquire) { return false; }
    let state = app.state::<AppState>();
    let Ok(manager) = state.config_manager.lock() else { return false; };
    manager.get_config().entities.plugin_configs.iter().any(|entry| {
        entry.id == session.binding.plugin_id && entry.enabled
            && entry.install_generation == session.binding.install_generation
            && (!session.trusted_web || entry.trusted_web_granted)
            && entry.granted_permissions.iter().any(|p| p == "ui:view")
            && session.permission.is_none_or(|permission| entry.granted_permissions.iter().any(|p| p == permission))
    })
}
fn session(id: &str, app: &tauri::AppHandle) -> Result<Arc<Session>, CommandError> {
    let session = registry().lock().map_err(|e| error(e.to_string()))?.live.get(id).cloned().ok_or_else(|| error("视图实例已失效"))?;
    if !authorized(app, &session) { return Err(error("视图授权或安装代次已失效")); }
    Ok(session)
}

pub async fn create(source: tauri::Webview, state: &AppState, binding: Binding) -> Result<(), CommandError> {
    require_main(&source)?;
    for identity in [&binding.view_instance_id, &binding.tab_session_id, &binding.tab_id, &binding.install_generation] {
        if uuid::Uuid::parse_str(identity).is_err() { return Err(error("视图会话身份必须为 UUID")); }
    }
    plugin::validate_plugin_id(&binding.plugin_id).map_err(error)?;
    let _io = crate::commands::acquire_plugin_io(state).await?;
    // Snapshot memory-only authority under config lock. Full resource reads must
    // never block unrelated configuration saves while holding that lock.
    let (plugins_dir, entry) = {
        let manager = state.config_manager.lock().map_err(|e| error(e.to_string()))?;
        let entry = manager.get_config().entities.plugin_configs.iter().find(|e| e.id == binding.plugin_id).cloned().ok_or_else(|| error("插件未安装"))?;
        if !entry.enabled || entry.install_generation != binding.install_generation {
            return Err(error("插件未启用或安装代次失效"));
        }
        (manager.plugins_dir().to_path_buf(), entry)
    };
    let dir = plugins_dir.join(&binding.plugin_id);
    let manifest_dir = dir.clone();
    let manifest = tokio::task::spawn_blocking(move || plugin::load_manifest_lite(&manifest_dir))
        .await.map_err(|e| error(e.to_string()))?.map_err(error)?;
    if manifest.id != binding.plugin_id { return Err(error("插件目录身份不匹配")); }
    let declaration = manifest.ui.as_ref().and_then(|ui| ui.views.iter().find(|v| v.id == binding.view_id)).ok_or_else(|| error("未声明视图"))?.clone();
    if declaration.is_trusted_web() && !entry.trusted_web_granted {
        return Err(error("可信网页尚未获得独立授权"));
    }
    for permission in std::iter::once("ui:view").chain(input_permission(&declaration)) {
        if !manifest.permissions.iter().any(|p| p == permission) || !entry.granted_permissions.iter().any(|p| p == permission) {
            return Err(error(format!("视图缺少权限 {permission}")));
        }
    }
    validate_binding(&binding, &declaration)?;
    if binding.bound_port_id.is_some() {
        let mode = binding.port_mode.as_deref().ok_or_else(|| error("视图缺少当前端口工作模式"))?;
        if !["trx", "tty"].contains(&mode) || !declaration.modes.iter().any(|m| m == mode) { return Err(error("视图不支持端口工作模式")); }
    } else if binding.port_mode.is_some() { return Err(error("无端口视图不得声明端口模式")); }
    let web_data_dir = if declaration.is_trusted_web() {
        Some(plugin::web_data_dir(&plugins_dir, &binding.plugin_id, &binding.install_generation).map_err(error)?)
    } else { None };
    if let Some(port) = binding.bound_port_id.clone() {
        let manager = state.serial_manager.clone();
        let ports = tokio::task::spawn_blocking(move || crate::serial::list_ports_blocking(&manager))
            .await.map_err(|e| error(e.to_string()))?.map_err(|e| error(e.to_string()))?;
        if !ports.iter().any(|candidate| candidate.id == port) {
            return Err(error("视图绑定端口不存在"));
        }
    }
    // Validate and snapshot only the selected view, once, off the async worker.
    // Install/enable/reload retain their complete package validation boundary.
    let resource_view = declaration.clone();
    let resources = tokio::task::spawn_blocking(move || resources::snapshot(&dir, &resource_view))
        .await.map_err(|e| error(e.to_string()))?.map_err(error)?;
    let session = Arc::new(Session { binding, alive: AtomicBool::new(true), trusted_web: declaration.is_trusted_web(), permission: input_permission(&declaration), rate: Mutex::new((Instant::now(), 0)), control_rate: Mutex::new(TokenBucket::new(128.0)), timeline_preview_rate: Mutex::new(TokenBucket::new(TIMELINE_PREVIEW_RATE)), timeline_control_rate: Mutex::new(TokenBucket::new(TIMELINE_CONTROL_RATE)), binary_rate_reported: AtomicBool::new(false), document: Mutex::new(DocumentState::default()) });
    if !authorized(source.app_handle(), &session) { return Err(error("视图创建期间授权或安装代次已失效")); }
    {
        let mut registry = registry().lock().map_err(|e| error(e.to_string()))?;
        if registry.live.len() >= 16
            || registry.live.values().filter(|s| s.binding.plugin_id == session.binding.plugin_id).count() >= 8 {
            return Err(error("原生视图实例额度已满"));
        }
        if registry.live.contains_key(&session.binding.view_instance_id) { return Err(error("原生视图身份已存在")); }
        registry.live.insert(session.binding.view_instance_id.clone(), session.clone());
    }
    let id = session.binding.view_instance_id.clone();
    let app = source.app_handle().clone();
    let result = on_ui(&app, move || {
        #[cfg(windows)]
        { windows::create(&source.window(), session, declaration, resources, web_data_dir) }
        #[cfg(not(windows))]
        { let _ = (source, session, declaration, resources, web_data_dir); Err("此平台尚未通过原生隔离策略验收，不开放插件视图".into()) }
    }).await;
    if result.is_err() { retire_registry(Some(&id), None); }
    result
}
fn input_permission(view: &UiView) -> Option<&'static str> { match view.input.as_str() { "bytes" => Some("rx:bytes"), "lines" => Some("terminal:read"), _ => None } }
fn validate_binding(binding: &Binding, view: &UiView) -> Result<(), CommandError> {
    if !view.placements.contains(&binding.placement)
        || binding.bound_port_id.as_ref().is_some_and(|id| id.is_empty() || id.len() > 512)
        || ((view.input != "none" || view.port_binding == "required" || binding.placement == "serial-content") && binding.bound_port_id.is_none())
        || (view.port_binding == "none" && binding.bound_port_id.is_some()) { return Err(error("视图端口绑定或放置方式非法")); }
    Ok(())
}

async fn on_ui<T: Send + 'static>(app: &tauri::AppHandle, operation: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, CommandError> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || { let _ = tx.send(operation()); }).map_err(|e| error(e.to_string()))?;
    rx.await.map_err(|_| error("原生 UI 线程已退出"))?.map_err(error)
}

pub async fn update(source: tauri::Webview, id: String, rect: Rect, occlusions: Option<Vec<OcclusionRect>>, visible: bool, revision: u64) -> Result<(), CommandError> {
    require_main(&source)?;
    let session = session(&id, source.app_handle())?;
    validate_rect(&rect).map_err(error)?;
    validate_occlusions(occlusions.as_deref()).map_err(error)?;
    let app = source.app_handle().clone();
    on_ui(&app, move || {
        if !session.alive.load(Ordering::Acquire) { return Err("视图已退休".into()); }
        #[cfg(windows)] { windows::update(&source.window(), &id, rect, occlusions, visible, revision) }
        #[cfg(not(windows))] { let _ = (source, id, rect, occlusions, visible, revision); Err("不支持原生隔离视图".into()) }
    }).await
}
fn document_identity(message: &Value) -> Result<String, CommandError> {
    message.get("documentId").and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 64)
        .map(str::to_string)
        .ok_or_else(|| error("视图消息缺少文档身份"))
}
fn bounded_text<'a>(message: &'a Value, key: &str, maximum: usize) -> Result<&'a str, String> {
    message.get(key).and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= maximum)
        .ok_or_else(|| format!("视图消息 {key} 非法"))
}
/// Cheap transfer-id gate applied to both directions before emitting/parsing
/// further: our senders only produce UUIDs, so a strict charset keeps malformed
/// or hostile frames from reaching the browser process at all.
fn valid_binary_transfer_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_BINARY_TRANSFER_ID_LEN
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}
fn binary_transfer_id(message: &Value) -> Result<&str, String> {
    let transfer_id = bounded_text(message, "transferId", MAX_BINARY_TRANSFER_ID_LEN)?;
    if !valid_binary_transfer_id(transfer_id) { return Err("视图二进制传输标识非法".into()); }
    Ok(transfer_id)
}
fn bounded_binary_seq(message: &Value) -> Option<u64> {
    message.get("seq").and_then(Value::as_u64).filter(|seq| *seq < MAX_BINARY_SEQ)
}
fn validate_binary_chunk(message: &Value) -> Result<(), String> {
    binary_transfer_id(message)?;
    bounded_text(message, "transferType", 128)?;
    bounded_binary_seq(message).ok_or("视图二进制序号非法")?;
    message.get("done").and_then(Value::as_bool).ok_or("视图二进制完成标记非法")?;
    let data = message.get("data").and_then(Value::as_str).ok_or("视图二进制分片非法")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| "视图二进制分片编码非法")?;
    if bytes.len() > 8 * 1024 { return Err("视图二进制分片超过 8 KiB".into()); }
    Ok(())
}
fn validate_binary_ack(message: &Value) -> Result<(), String> {
    binary_transfer_id(message)?;
    bounded_binary_seq(message).ok_or("视图二进制确认序号非法")?;
    message.get("done").and_then(Value::as_bool).ok_or("视图二进制确认完成标记非法")?;
    message.get("ok").and_then(Value::as_bool).ok_or("视图二进制确认状态非法")?;
    if message.get("error").is_some_and(|value| !value.is_string() || value.as_str().is_some_and(|text| text.len() > 2048)) {
        return Err("视图二进制确认错误文本非法".into());
    }
    Ok(())
}
pub async fn send(source: tauri::Webview, id: String, mut message: Value) -> Result<(), CommandError> {
    require_main(&source)?;
    let session = session(&id, source.app_handle())?;
    let document_id = document_identity(&message)?;
    if !session.accepts_document(&document_id) { return Err(error("视图文档身份已失效")); }
    let message_type = message.get("type").and_then(Value::as_str).unwrap_or("").to_string();
    match message_type.as_str() {
        "init" => { message["context"] = serde_json::to_value(&session.binding).map_err(|e| error(e.to_string()))?; }
        "state" | "environment" => {}
        "binary-chunk" => validate_binary_chunk(&message).map_err(error)?,
        "binary-ack" => validate_binary_ack(&message).map_err(error)?,
        "timeline-seek" | "timeline-cancel" => if !timeline::validate_host(&message) { return Err(error("视图时间控制消息非法")); },
        _ => return Err(error("视图消息类型或大小非法")),
    }
    let serialized = serde_json::to_string(&message).map_err(|e| error(e.to_string()))?;
    let max_bytes = match message_type.as_str() {
        "state" => MAX_MESSAGE_BYTES + 8 * 1024,
        "binary-chunk" | "binary-ack" => 16 * 1024,
        "timeline-seek" | "timeline-cancel" => 8 * 1024,
        _ => MAX_MESSAGE_BYTES,
    };
    if serialized.len() > max_bytes { return Err(error("视图消息类型或大小非法")); }
    if message_type == "state" && serde_json::to_vec(&message["snapshot"]).map_err(|e| error(e.to_string()))?.len() > MAX_MESSAGE_BYTES {
        return Err(error("视图快照超过 256 KiB"));
    }
    // JSON is embedded as a string literal, never as plugin-provided JavaScript source.
    let literal = serde_json::to_string(&serialized).map_err(|e| error(e.to_string()))?;
    let app = source.app_handle().clone();
    let sent_document = document_id.clone();
    on_ui(&app, move || {
        // Navigation may have started between validation and this dispatch;
        // never execute a stale document's message in its replacement.
        if !session.alive.load(Ordering::Acquire) { return Err("视图已退休".into()); }
        if !session.accepts_document(&sent_document) { return Err("视图文档身份已失效".into()); }
        #[cfg(windows)] { windows::send(&id, &format!("globalThis.__hypercomViewDispatch(JSON.parse({literal}));")) }
        #[cfg(not(windows))] { let _ = (id, literal); Err("不支持原生隔离视图".into()) }
    }).await
}
fn retire_registry(id: Option<&str>, plugin: Option<&str>) -> Vec<String> {
    let mut registry = registry().lock().unwrap_or_else(|e| e.into_inner());
    let ids: Vec<_> = registry.live.iter().filter(|(key, session)| id.is_none_or(|id| id == key.as_str()) && plugin.is_none_or(|plugin| plugin == session.binding.plugin_id)).map(|(id, _)| id.clone()).collect();
    for id in &ids { if let Some(session) = registry.live.remove(id) { session.alive.store(false, Ordering::Release); } }
    prune_binary_rates(&mut registry);
    ids
}
fn prune_binary_rates(registry: &mut Registry) {
    let live = &registry.live;
    registry.binary_rates.retain(|plugin, _| live.values().any(|session| session.binding.plugin_id == *plugin));
}
pub async fn retire_plugin(app: &tauri::AppHandle, plugin: &str) -> Result<(), CommandError> {
    let ids = retire_registry(None, Some(plugin));
    on_ui(app, move || { #[cfg(windows)] for id in ids { windows::destroy(&id); } #[cfg(not(windows))] let _ = ids; Ok(()) }).await
}
pub async fn clear_web_data(app: &tauri::AppHandle, directory: &std::path::Path) -> Result<(), CommandError> {
    match std::fs::symlink_metadata(directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(cause) => return Err(error(format!("无法读取网页数据目录: {cause}"))),
        Ok(metadata) if !metadata.is_dir() || plugin::is_link_or_reparse(&metadata) => return Err(error("网页数据目录不是普通目录")),
        Ok(_) => {}
    }
    let directory = directory.to_path_buf();
    on_ui(app, move || {
        #[cfg(windows)] { windows::clear_web_data(&directory) }
        #[cfg(not(windows))] {
            let _ = directory;
            Err("此平台不支持可信网页数据管理".into())
        }
    }).await
}
pub async fn retire_denied(app: &tauri::AppHandle, plugin: &str, grants: &[String]) -> Result<(), CommandError> {
    let ids = {
        let mut registry = registry().lock().map_err(|e| error(e.to_string()))?;
        let ids: Vec<_> = registry.live.iter().filter(|(_, session)| session.binding.plugin_id == plugin
            && (!grants.iter().any(|p| p == "ui:view") || session.permission.is_some_and(|permission| !grants.iter().any(|p| p == permission))))
            .map(|(id, _)| id.clone()).collect();
        for id in &ids { if let Some(session) = registry.live.remove(id) { session.alive.store(false, Ordering::Release); } }
        prune_binary_rates(&mut registry);
        ids
    };
    on_ui(app, move || { #[cfg(windows)] for id in ids { windows::destroy(&id); } #[cfg(not(windows))] let _ = ids; Ok(()) }).await
}
pub async fn destroy(source: tauri::Webview, id: String) -> Result<(), CommandError> {
    require_main(&source)?;
    retire_registry(Some(&id), None);
    on_ui(source.app_handle(), move || { #[cfg(windows)] windows::destroy(&id); #[cfg(not(windows))] let _ = id; Ok(()) }).await
}
pub fn clear_all() {
    retire_registry(None, None);
    #[cfg(windows)] windows::clear();
}

fn inbound_binary_chunk(value: &Value, mut event: Value) -> Option<Value> {
    let transfer_id = binary_transfer_id(value).ok()?;
    let transfer_type = bounded_text(value, "transferType", 128).ok()?;
    let seq = bounded_binary_seq(value)?;
    let done = value.get("done").and_then(Value::as_bool)?;
    let data = value.get("data").and_then(Value::as_str)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
    if bytes.len() > 8 * 1024 { return None; }
    event["type"] = "binary".into();
    event["transferId"] = transfer_id.into();
    event["transferType"] = transfer_type.into();
    event["seq"] = seq.into();
    event["done"] = done.into();
    event["data"] = data.into();
    Some(event)
}
fn inbound_binary_ack(value: &Value, mut event: Value) -> Option<Value> {
    let transfer_id = binary_transfer_id(value).ok()?;
    let seq = bounded_binary_seq(value)?;
    let done = value.get("done").and_then(Value::as_bool)?;
    let ok = value.get("ok").and_then(Value::as_bool)?;
    event["type"] = "binary-ack".into();
    event["transferId"] = transfer_id.into();
    event["seq"] = seq.into();
    event["done"] = done.into();
    event["ok"] = ok.into();
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        event["error"] = error.chars().take(2048).collect::<String>().into();
    }
    Some(event)
}

/// Binary traffic has a separate budget from ordinary UI messages. The native
/// receive callback is synchronous, so an over-budget frame is dropped before
/// base64 decoding or event construction; this bounds native UI-thread work even
/// when a page sends malformed or excessive frames.
fn take_plugin_binary_token(registry: &mut Registry, plugin_id: &str, now: Instant) -> bool {
    registry.binary_rates.entry(plugin_id.to_string())
        .or_insert_with(|| TokenBucket::new(BINARY_MESSAGE_BURST))
        .try_take_at(BINARY_MESSAGE_RATE_PER_SECOND, BINARY_MESSAGE_BURST, now)
}
fn take_binary_token(session: &Session) -> bool {
    registry().lock().map(|mut registry| take_plugin_binary_token(&mut registry, &session.binding.plugin_id, Instant::now())).unwrap_or(false)
}
/// State ACK/ready/error must not compete with the 64/s interaction bucket.
/// These small controls remain bounded independently, including hostile errors.
fn take_control_token(session: &Session) -> bool {
    session.control_rate.lock().map(|mut bucket| bucket.try_take(128.0, 128.0)).unwrap_or(false)
}
fn take_timeline_token(session: &Session, preview: bool, now: Instant) -> bool {
    let (bucket, limit) = if preview { (&session.timeline_preview_rate, TIMELINE_PREVIEW_RATE) } else { (&session.timeline_control_rate, TIMELINE_CONTROL_RATE) };
    bucket.lock().map(|mut bucket| bucket.try_take_at(limit, limit, now)).unwrap_or(false)
}
fn is_control_message(event_type: &str) -> bool {
    matches!(event_type, "state-ack" | "ready" | "error")
}
fn claim_binary_rate_report(reported: &AtomicBool) -> bool {
    reported
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}
pub fn receive(app: &tauri::AppHandle, session: &Session, body: &str) {
    if body.len() > 16 * 1024 || !authorized(app, session) { return; }
    let Ok(value) = serde_json::from_str::<Value>(body) else { return; };
    let Some(document_id) = value.get("documentId").and_then(Value::as_str) else { return; };
    if uuid::Uuid::parse_str(document_id).is_err() || !session.accepts_document(document_id) { return; }
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    if event_type == "binary-chunk" || event_type == "binary-ack" {
        // Binary traffic has its own budget so a burst of frames cannot starve
        // ordinary interaction messages (or spend their bucket). This check is
        // deliberately before base64 decoding and event construction. Retire
        // once on the first violation so legitimate senders settle their pending
        // ACKs, then stay silent for any hostile follow-up burst.
        if !take_binary_token(session) {
            if claim_binary_rate_report(&session.binary_rate_reported) {
                native_error(app, session, "插件视图二进制帧速率超限");
            }
            return;
        }
    } else if event_type == "timeline" {
        // End/ACK/registration never spend preview tokens. An ordinary time-lane
        // timeout or dropped preview does not retire the business page.
        let preview = timeline::preview(&value["payload"]);
        if !take_timeline_token(session, preview, Instant::now()) { return; }
    } else if is_control_message(event_type) {
        if !take_control_token(session) { return; }
    } else {
        let Ok(mut rate) = session.rate.lock() else { return; };
        if rate.0.elapsed().as_secs_f64() >= 1.0 { *rate = (Instant::now(), 0); }
        rate.1 += 1;
        if rate.1 > 64 { return; }
        drop(rate);
    }
    let base = serde_json::json!({"instanceId": session.binding.view_instance_id, "documentId": document_id});
    let event = match event_type {
        "ready" => { let mut event = base; event["type"] = "ready".into(); event },
        "state-ack" if value.get("revision").and_then(Value::as_u64).is_some() => {
            let mut event = base; event["type"] = "ack".into(); event["revision"] = value["revision"].clone(); event
        },
        "ui-message" if value.get("messageType").and_then(Value::as_str).is_some_and(|s| !s.is_empty() && s.len() <= 128) => {
            let mut event = base; event["type"] = "message".into(); event["messageType"] = value["messageType"].clone(); event["payload"] = value["payload"].clone(); event
        },
        "error" => {
            let mut event = base; event["type"] = "error".into();
            event["error"] = value.get("error").and_then(Value::as_str).unwrap_or("插件 UI 错误").chars().take(2048).collect::<String>().into();
            event
        },
        "timeline" if timeline::validate_page(&value["payload"])
            && (value["payload"]["registration"]["clock"]["kind"] != "bound-input"
                || (session.binding.worker_epoch > 0 && session.binding.bound_port_id.is_some() && session.permission.is_some())) => {
            let mut event = base; event["type"] = "timeline".into(); event["payload"] = value["payload"].clone(); event
        },
        "binary-chunk" => match inbound_binary_chunk(&value, base) { Some(event) => event, None => return },
        "binary-ack" => match inbound_binary_ack(&value, base) { Some(event) => event, None => return },
        // DOM focus-intent is not a trusted native action or focus event.
        _ => return,
    };
    let _ = app.emit_to(tauri::EventTarget::webview("main"), "plugin:view-message", event);
}
pub fn native_document(app: &tauri::AppHandle, session: &Session, document_id: &str) {
    if authorized(app, session) {
        let _ = app.emit_to(tauri::EventTarget::webview("main"), "plugin:view-message", serde_json::json!({
            "instanceId": session.binding.view_instance_id, "documentId": document_id, "type": "document",
        }));
    }
}
fn event_document(session: &Session) -> Value {
    session.current_document().map(Value::String).unwrap_or(Value::Null)
}
/// Report that the current document finished navigating successfully.
///
/// The frontend only arms the (generous) trusted-web ready watchdog after this
/// signal, so a slow page load is never mistaken for a hung document while a page
/// that loads but never calls `ready` still fails closed.
pub fn native_navigation_complete(app: &tauri::AppHandle, session: &Session) {
    if authorized(app, session) {
        let _ = app.emit_to(tauri::EventTarget::webview("main"), "plugin:view-message", serde_json::json!({
            "instanceId": session.binding.view_instance_id, "documentId": event_document(session), "type": "navigation-complete",
        }));
    }
}
pub fn native_focus(app: &tauri::AppHandle, session: &Session) {
    if authorized(app, session) {
        let _ = app.emit_to(tauri::EventTarget::webview("main"), "plugin:view-message", serde_json::json!({
            "instanceId": session.binding.view_instance_id, "documentId": event_document(session), "type": "focus",
        }));
    }
}
pub fn native_error(app: &tauri::AppHandle, session: &Session, message: &str) {
    if authorized(app, session) {
        let _ = app.emit_to(tauri::EventTarget::webview("main"), "plugin:view-message", serde_json::json!({
            "instanceId": session.binding.view_instance_id, "documentId": event_document(session), "type": "error", "error": message,
        }));
    }
}
const MAX_OCCLUSIONS: usize = 64;
const MAX_GEOMETRY_COORD: f64 = 100_000.0;
const MAX_OCCLUSION_SIZE: f64 = 1_000_000.0;

fn validate_rect(rect: &Rect) -> Result<(), String> {
    if [rect.x, rect.y, rect.width, rect.height, rect.zoom_percent].iter().any(|v| !v.is_finite())
        || rect.width < 0.0 || rect.height < 0.0 || rect.zoom_percent < 25.0 || rect.zoom_percent > 500.0
        || [rect.x.abs(), rect.y.abs(), rect.width, rect.height].iter().any(|v| *v > MAX_GEOMETRY_COORD) {
        return Err("视图矩形非法".into());
    }
    Ok(())
}

fn validate_occlusions(occlusions: Option<&[OcclusionRect]>) -> Result<(), String> {
    let Some(occlusions) = occlusions else { return Ok(()); };
    if occlusions.len() > MAX_OCCLUSIONS { return Err("视图遮挡矩形数量非法".into()); }
    if occlusions.iter().any(|rect| {
        [rect.x, rect.y, rect.width, rect.height].iter().any(|value| !value.is_finite())
            || rect.width < 0.0 || rect.height < 0.0
            || [rect.x.abs(), rect.y.abs(), rect.width, rect.height].iter().any(|value| *value > MAX_OCCLUSION_SIZE)
    }) {
        return Err("视图遮挡矩形非法".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_nonfinite_and_unbounded_geometry() {
        let mut rect = Rect { x: 0.0, y: 0.0, width: 200.0, height: 100.0, zoom_percent: 125.0 };
        assert!(validate_rect(&rect).is_ok());
        rect.x = f64::NAN; assert!(validate_rect(&rect).is_err());
        rect.x = 0.0; rect.width = -1.0; assert!(validate_rect(&rect).is_err());
        rect.width = 200.0; rect.zoom_percent = 0.0; assert!(validate_rect(&rect).is_err());
    }
    #[test]
    fn validates_occlusion_contract() {
        let rect = OcclusionRect { x: -10.0, y: 20.0, width: 30.0, height: 40.0 };
        assert!(validate_occlusions(Some(std::slice::from_ref(&rect))).is_ok());
        assert!(validate_occlusions(Some(&[OcclusionRect { width: -1.0, ..rect }])).is_err());
        let rect = OcclusionRect { x: -10.0, y: 20.0, width: 30.0, height: 40.0 };
        assert!(validate_occlusions(Some(&[OcclusionRect { x: f64::NAN, ..rect }])).is_err());
        let rect = OcclusionRect { x: 0.0, y: 0.0, width: MAX_OCCLUSION_SIZE + 1.0, height: 1.0 };
        assert!(validate_occlusions(Some(&[rect])).is_err());
        let rect = OcclusionRect { x: -10.0, y: 20.0, width: 30.0, height: 40.0 };
        assert!(validate_occlusions(Some(&(0..=MAX_OCCLUSIONS).map(|_| rect.clone()).collect::<Vec<_>>())).is_err());
    }
    #[test]
    fn validates_binary_chunk_envelopes_and_roundtrips_exact_payloads() {
        let payload = vec![0x5au8; 8 * 1024];
        let encoded = base64::engine::general_purpose::STANDARD.encode(&payload);
        let chunk = serde_json::json!({
            "type": "binary-chunk", "documentId": uuid::Uuid::new_v4().to_string(),
            "transferId": "transfer", "transferType": "data", "seq": 0u64, "done": true, "data": encoded,
        });
        assert!(validate_binary_chunk(&chunk).is_ok());
        let decoded = base64::engine::general_purpose::STANDARD.decode(chunk["data"].as_str().unwrap()).unwrap();
        assert_eq!(decoded, payload);
        let oversized = serde_json::json!({
            "transferId": "transfer", "transferType": "data", "seq": 0u64, "done": true,
            "data": base64::engine::general_purpose::STANDARD.encode(vec![0u8; 8 * 1024 + 1]),
        });
        assert!(validate_binary_chunk(&oversized).is_err());
        assert!(validate_binary_chunk(&serde_json::json!({"transferId": "", "transferType": "data", "seq": 0u64, "done": true, "data": ""})).is_err());
    }
    #[test]
    fn binary_token_bucket_enforces_burst_and_refills_deterministically() {
        let start = Instant::now();
        let mut bucket = TokenBucket { tokens: BINARY_MESSAGE_BURST, updated: start };
        for _ in 0..BINARY_MESSAGE_BURST as usize {
            assert!(bucket.try_take_at(BINARY_MESSAGE_RATE_PER_SECOND, BINARY_MESSAGE_BURST, start));
        }
        assert!(!bucket.try_take_at(BINARY_MESSAGE_RATE_PER_SECOND, BINARY_MESSAGE_BURST, start));
        let refilled = start + std::time::Duration::from_millis(2);
        assert!(bucket.try_take_at(BINARY_MESSAGE_RATE_PER_SECOND, BINARY_MESSAGE_BURST, refilled));
    }

    #[test]
    fn binary_rate_is_shared_across_views_of_a_plugin_but_not_other_plugins() {
        let mut registry = Registry::default();
        // A nearly empty shared bucket models two views spending the same owner.
        let now = Instant::now();
        registry.binary_rates.insert("a".into(), TokenBucket { tokens: 1.0, updated: now });
        assert!(take_plugin_binary_token(&mut registry, "a", now));
        assert!(!take_plugin_binary_token(&mut registry, "a", now));
        assert!(take_plugin_binary_token(&mut registry, "b", now));
        prune_binary_rates(&mut registry);
        assert!(registry.binary_rates.is_empty());
    }

    #[test]
    fn state_and_ready_controls_have_an_independent_bounded_bucket() {
        assert!(is_control_message("state-ack"));
        assert!(is_control_message("ready"));
        assert!(is_control_message("error"));
        assert!(!is_control_message("ui-message"));
        assert!(!is_control_message("binary-ack"));
        let now = Instant::now();
        let mut interactions = TokenBucket { tokens: 64.0, updated: now };
        let mut controls = TokenBucket { tokens: 128.0, updated: now };
        for _ in 0..64 { assert!(interactions.try_take_at(64.0, 64.0, now)); }
        assert!(!interactions.try_take_at(64.0, 64.0, now));
        // A full interaction burst cannot spend any of the state ACK allowance.
        for _ in 0..128 { assert!(controls.try_take_at(128.0, 128.0, now)); }
        assert!(!controls.try_take_at(128.0, 128.0, now));
    }

    #[test]
    fn documents_reject_replaced_and_unknown_identities() {
        let session = Session {
            binding: Binding { plugin_id: "com.example.view".into(), install_generation: "generation".into(), view_id: "view".into(), tab_id: String::new(), placement: "workspace-tab".into(), bound_port_id: None, tab_session_id: String::new(), view_instance_id: String::new(), port_mode: None, worker_epoch: 1, stream_epoch: 0 },
            alive: AtomicBool::new(true), trusted_web: false, permission: None,
            rate: Mutex::new((Instant::now(), 0)), control_rate: Mutex::new(TokenBucket::new(128.0)), timeline_preview_rate: Mutex::new(TokenBucket::new(TIMELINE_PREVIEW_RATE)), timeline_control_rate: Mutex::new(TokenBucket::new(TIMELINE_CONTROL_RATE)),
            binary_rate_reported: AtomicBool::new(false), document: Mutex::new(DocumentState::default()),
        };
        // An exhausted preview bucket cannot consume the reserved final/ACK
        // controls, nor the unrelated state ACK bucket.
        let now = Instant::now();
        for _ in 0..TIMELINE_PREVIEW_RATE as usize { assert!(take_timeline_token(&session, true, now)); }
        assert!(!take_timeline_token(&session, true, now));
        for _ in 0..TIMELINE_CONTROL_RATE as usize { assert!(take_timeline_token(&session, false, now)); }
        assert!(!take_timeline_token(&session, false, now));
        assert!(take_control_token(&session));
        assert!(!session.accepts_document("unknown"));
        session.begin_document("old-document"); assert!(session.accepts_document("old-document"));
        session.begin_document("new-document");
        assert!(!session.accepts_document("old-document")); assert!(session.accepts_document("new-document"));
        assert!(document_identity(&serde_json::json!({})).is_err());
        assert!(document_identity(&serde_json::json!({ "documentId": "" })).is_err());
        assert!(document_identity(&serde_json::json!({ "documentId": "a".repeat(65) })).is_err());
        assert_eq!(document_identity(&serde_json::json!({ "documentId": "new-document" })).unwrap(), "new-document");
    }

    #[test]
    fn binary_rate_limit_error_is_claimed_once() {
        let reported = AtomicBool::new(false);
        assert!(claim_binary_rate_report(&reported));
        assert!(reported.load(Ordering::Acquire));
        assert!(!claim_binary_rate_report(&reported));
    }

    #[test]
    fn inbound_binary_envelope_reuses_strict_id_and_sequence_bounds() {
        assert!(inbound_binary_chunk(&serde_json::json!({
            "transferId": "transfer-1", "transferType": "data", "seq": 0u64,
            "done": true, "data": ""
        }), serde_json::json!({})).is_some());
        for transfer_id in ["", "../escape", "含有中文"] {
            assert!(inbound_binary_chunk(&serde_json::json!({
                "transferId": transfer_id, "transferType": "data", "seq": 0u64,
                "done": true, "data": ""
            }), serde_json::json!({})).is_none());
        }
        assert!(inbound_binary_chunk(&serde_json::json!({
            "transferId": "transfer-1", "transferType": "data", "seq": MAX_BINARY_SEQ,
            "done": true, "data": ""
        }), serde_json::json!({})).is_none());
        assert!(inbound_binary_ack(&serde_json::json!({
            "transferId": "transfer-1", "seq": MAX_BINARY_SEQ, "done": true, "ok": true
        }), serde_json::json!({})).is_none());
    }

    #[test]
    fn binary_transfer_validation_rejects_unsafe_identifiers() {
        assert!(!valid_binary_transfer_id("../transfer"));
        assert!(!valid_binary_transfer_id("传输"));
        assert!(valid_binary_transfer_id("transfer_1.v2-3"));
    }

    #[test]
    fn validates_fixed_port_and_placement_contract() {
        let view = UiView { id: "table".into(), label: "Table".into(), mode: plugin::ViewMode::Isolated, worker: true, entry: "ui/main.js".into(), styles: vec![], assets: vec![], modes: vec!["trx".into()], input: "bytes".into(), placements: vec!["workspace-tab".into()], port_binding: "required".into(), restore_on_startup: false };
        let mut binding = Binding { plugin_id: "com.example.ui".into(), install_generation: "generation".into(), view_id: "table".into(), tab_id: uuid::Uuid::new_v4().to_string(), placement: "workspace-tab".into(), bound_port_id: Some("COM3".into()), tab_session_id: uuid::Uuid::new_v4().to_string(), view_instance_id: uuid::Uuid::new_v4().to_string(), port_mode: Some("trx".into()), worker_epoch: 1, stream_epoch: 0 };
        assert!(validate_binding(&binding, &view).is_ok());
        binding.bound_port_id = None; assert!(validate_binding(&binding, &view).is_err());
        binding.bound_port_id = Some("COM3".into()); binding.placement = "serial-content".into();
        assert!(validate_binding(&binding, &view).is_err());
    }
}
