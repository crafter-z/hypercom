pub(crate) mod resources;
#[cfg(windows)]
mod windows;

use std::{collections::HashMap, sync::{Arc, Mutex, LazyLock, atomic::{AtomicBool, Ordering}}, time::Instant};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager};
use crate::{AppState, commands::CommandError, plugin::{self, UiView}};

pub const MAX_MESSAGE_BYTES: usize = 256 * 1024;

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
pub struct Rect { pub x: f64, pub y: f64, pub width: f64, pub height: f64, pub zoom_percent: f64 }

pub struct Session {
    pub binding: Binding, pub alive: AtomicBool, permission: Option<&'static str>,
    rate: Mutex<(Instant, u32)>,
}
#[derive(Default)]
struct Registry { live: HashMap<String, Arc<Session>> }
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
    for identity in [&binding.view_instance_id, &binding.tab_session_id, &binding.tab_id] {
        if uuid::Uuid::parse_str(identity).is_err() { return Err(error("视图会话身份必须为 UUID")); }
    }
    plugin::validate_plugin_id(&binding.plugin_id).map_err(error)?;
    let _io = state.plugin_io.lock().await;
    let (dir, declaration) = {
        let manager = state.config_manager.lock().map_err(|e| error(e.to_string()))?;
        let config = manager.get_config();
        let entry = config.entities.plugin_configs.iter().find(|e| e.id == binding.plugin_id).ok_or_else(|| error("插件未安装"))?;
        if !entry.enabled || binding.install_generation.is_empty() || entry.install_generation != binding.install_generation {
            return Err(error("插件未启用或安装代次失效"));
        }
        let dir = manager.plugins_dir().join(&binding.plugin_id);
        let manifest = plugin::load_manifest_from_dir(&dir).map_err(error)?;
        if manifest.id != binding.plugin_id { return Err(error("插件目录身份不匹配")); }
        let view = manifest.ui.as_ref().and_then(|ui| ui.views.iter().find(|v| v.id == binding.view_id)).ok_or_else(|| error("未声明视图"))?.clone();
        for permission in std::iter::once("ui:view").chain(input_permission(&view)) {
            if !manifest.permissions.iter().any(|p| p == permission) || !entry.granted_permissions.iter().any(|p| p == permission) {
                return Err(error(format!("视图缺少权限 {permission}")));
            }
        }
        validate_binding(&binding, &view)?;
        if binding.bound_port_id.is_some() {
            let mode = binding.port_mode.as_deref().ok_or_else(|| error("视图缺少当前端口工作模式"))?;
            if !["trx", "tty"].contains(&mode) || !view.modes.iter().any(|m| m == mode) { return Err(error("视图不支持端口工作模式")); }
        } else if binding.port_mode.is_some() { return Err(error("无端口视图不得声明端口模式")); }
        (dir, view)
    };
    if let Some(port) = binding.bound_port_id.clone() {
        let manager = state.serial_manager.clone();
        let ports = tokio::task::spawn_blocking(move || crate::serial::list_ports_blocking(&manager))
            .await.map_err(|e| error(e.to_string()))?.map_err(|e| error(e.to_string()))?;
        if !ports.iter().any(|candidate| candidate.id == port) {
            return Err(error("视图绑定端口不存在"));
        }
    }
    let resources = resources::snapshot(&dir, &declaration).map_err(error)?;
    let session = Arc::new(Session { binding, alive: AtomicBool::new(true), permission: input_permission(&declaration), rate: Mutex::new((Instant::now(), 0)) });
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
        { windows::create(&source.window(), session, declaration, resources) }
        #[cfg(not(windows))]
        { let _ = (source, session, declaration, resources); Err("此平台尚未通过原生隔离策略验收，不开放插件视图".into()) }
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

pub async fn update(source: tauri::Webview, id: String, rect: Rect, visible: bool, revision: u64) -> Result<(), CommandError> {
    require_main(&source)?;
    let session = session(&id, source.app_handle())?;
    validate_rect(&rect).map_err(error)?;
    let app = source.app_handle().clone();
    on_ui(&app, move || {
        if !session.alive.load(Ordering::Acquire) { return Err("视图已退休".into()); }
        #[cfg(windows)] { windows::update(&source.window(), &id, rect, visible, revision) }
        #[cfg(not(windows))] { let _ = (source, id, rect, visible, revision); Err("不支持原生隔离视图".into()) }
    }).await
}
pub async fn send(source: tauri::Webview, id: String, mut message: Value) -> Result<(), CommandError> {
    require_main(&source)?;
    let session = session(&id, source.app_handle())?;
    if message["type"] == "init" {
        message["context"] = serde_json::to_value(&session.binding).map_err(|e| error(e.to_string()))?;
    }
    let serialized = serde_json::to_string(&message).map_err(|e| error(e.to_string()))?;
    let max_bytes = if message["type"] == "state" { MAX_MESSAGE_BYTES + 8 * 1024 } else { MAX_MESSAGE_BYTES };
    if serialized.len() > max_bytes || !["init", "state", "environment"].contains(&message.get("type").and_then(Value::as_str).unwrap_or("")) {
        return Err(error("视图消息类型或大小非法"));
    }
    if message["type"] == "state" && serde_json::to_vec(&message["snapshot"]).map_err(|e| error(e.to_string()))?.len() > MAX_MESSAGE_BYTES {
        return Err(error("视图快照超过 256 KiB"));
    }
    // JSON is embedded as a string literal, never as plugin-provided JavaScript source.
    let literal = serde_json::to_string(&serialized).map_err(|e| error(e.to_string()))?;
    let app = source.app_handle().clone();
    on_ui(&app, move || {
        if !session.alive.load(Ordering::Acquire) { return Err("视图已退休".into()); }
        #[cfg(windows)] { windows::send(&id, &format!("globalThis.__hypercomViewDispatch(JSON.parse({literal}));")) }
        #[cfg(not(windows))] { let _ = (id, literal); Err("不支持原生隔离视图".into()) }
    }).await
}
fn retire_registry(id: Option<&str>, plugin: Option<&str>) -> Vec<String> {
    let mut registry = registry().lock().unwrap_or_else(|e| e.into_inner());
    let ids: Vec<_> = registry.live.iter().filter(|(key, session)| id.is_none_or(|id| id == key.as_str()) && plugin.is_none_or(|plugin| plugin == session.binding.plugin_id)).map(|(id, _)| id.clone()).collect();
    for id in &ids { if let Some(session) = registry.live.remove(id) { session.alive.store(false, Ordering::Release); } }
    ids
}
pub async fn retire_plugin(app: &tauri::AppHandle, plugin: &str) -> Result<(), CommandError> {
    let ids = retire_registry(None, Some(plugin));
    on_ui(app, move || { #[cfg(windows)] for id in ids { windows::destroy(&id); } #[cfg(not(windows))] let _ = ids; Ok(()) }).await
}
pub async fn retire_denied(app: &tauri::AppHandle, plugin: &str, grants: &[String]) -> Result<(), CommandError> {
    let ids = {
        let mut registry = registry().lock().map_err(|e| error(e.to_string()))?;
        let ids: Vec<_> = registry.live.iter().filter(|(_, session)| session.binding.plugin_id == plugin
            && (!grants.iter().any(|p| p == "ui:view") || session.permission.is_some_and(|permission| !grants.iter().any(|p| p == permission))))
            .map(|(id, _)| id.clone()).collect();
        for id in &ids { if let Some(session) = registry.live.remove(id) { session.alive.store(false, Ordering::Release); } }
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

pub fn receive(app: &tauri::AppHandle, session: &Session, body: &str) {
    if body.len() > 16 * 1024 || !authorized(app, session) { return; }
    let Ok(mut rate) = session.rate.lock() else { return; };
    if rate.0.elapsed().as_secs_f64() >= 1.0 { *rate = (Instant::now(), 0); }
    rate.1 += 1;
    if rate.1 > 64 { return; }
    drop(rate);
    let Ok(value) = serde_json::from_str::<Value>(body) else { return; };
    let mut event = serde_json::json!({"instanceId": session.binding.view_instance_id});
    match value.get("type").and_then(Value::as_str) {
        Some("ready") => event["type"] = "ready".into(),
        Some("state-ack") if value.get("revision").and_then(Value::as_u64).is_some() => { event["type"] = "ack".into(); event["revision"] = value["revision"].clone(); },
        Some("ui-message") if value.get("messageType").and_then(Value::as_str).is_some_and(|s| !s.is_empty() && s.len() <= 128) => {
            event["type"] = "message".into(); event["messageType"] = value["messageType"].clone(); event["payload"] = value["payload"].clone();
        },
        Some("error") => { event["type"] = "error".into(); event["error"] = value.get("error").and_then(Value::as_str).unwrap_or("插件 UI 错误").chars().take(2048).collect::<String>().into(); },
        // DOM focus-intent is not a trusted native action or focus event.
        _ => return,
    }
    let _ = app.emit_to(tauri::EventTarget::webview("main"), "plugin:view-message", event);
}
pub fn native_focus(app: &tauri::AppHandle, session: &Session) {
    if authorized(app, session) { let _ = app.emit_to(tauri::EventTarget::webview("main"), "plugin:view-message", serde_json::json!({"instanceId": session.binding.view_instance_id, "type":"focus"})); }
}
pub fn native_error(app: &tauri::AppHandle, session: &Session, message: &str) {
    if authorized(app, session) {
        let _ = app.emit_to(tauri::EventTarget::webview("main"), "plugin:view-message", serde_json::json!({"instanceId":session.binding.view_instance_id,"type":"error","error":message}));
    }
}
fn validate_rect(rect: &Rect) -> Result<(), String> {
    if [rect.x, rect.y, rect.width, rect.height, rect.zoom_percent].iter().any(|v| !v.is_finite())
        || rect.width < 0.0 || rect.height < 0.0 || rect.zoom_percent < 25.0 || rect.zoom_percent > 500.0
        || [rect.x.abs(), rect.y.abs(), rect.width, rect.height].iter().any(|v| *v > 100_000.0) {
        return Err("视图矩形非法".into());
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
    fn validates_fixed_port_and_placement_contract() {
        let view = UiView { id: "table".into(), label: "Table".into(), entry: "ui/main.js".into(), styles: vec![], assets: vec![], modes: vec!["trx".into()], input: "bytes".into(), placements: vec!["workspace-tab".into()], port_binding: "required".into(), restore_on_startup: false };
        let mut binding = Binding { plugin_id: "com.example.ui".into(), install_generation: "generation".into(), view_id: "table".into(), tab_id: uuid::Uuid::new_v4().to_string(), placement: "workspace-tab".into(), bound_port_id: Some("COM3".into()), tab_session_id: uuid::Uuid::new_v4().to_string(), view_instance_id: uuid::Uuid::new_v4().to_string(), port_mode: Some("trx".into()), worker_epoch: 1, stream_epoch: 0 };
        assert!(validate_binding(&binding, &view).is_ok());
        binding.bound_port_id = None; assert!(validate_binding(&binding, &view).is_err());
        binding.bound_port_id = Some("COM3".into()); binding.placement = "serial-content".into();
        assert!(validate_binding(&binding, &view).is_err());
    }
}
