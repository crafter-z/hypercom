/**
 * 通用弹出窗命令 (Generic pop-out window commands)
 *
 * Phase 1「柔性工作区」的地基：一个 `open_popout` 同时服务快捷发送（单例）
 * 与终端标签（每端口一个）两类客户。窗口 label 约定：
 *   - 快捷发送 = `"quick-send"`（单例）
 *   - 终端     = `"terminal-{safe_id}"`（safe_id 由 `sanitize` 净化 portId 得到）
 *
 * **label 规则的权威实现是本文件的 `sanitize` / `compute_label`**：命令只接受
 * 业务语义参数（kind + target_id），label 一律由 Rust 计算，前端不再复制这套
 * 映射——两侧各写一份必然漂移，而漂移的症状是置顶/关闭命令找不到窗口（静默
 * 失效，没有报错）。src 侧只传 kind 与 targetId。
 */
use tauri::{AppHandle, Emitter, EventTarget, Manager, State};

use super::CommandError;
use crate::AppState;

const HELP_MAX_COMPONENT_BYTES: usize = 512;

/// 弹出窗元数据：记录窗口 label 对应的业务语义。
#[derive(Debug, Clone)]
pub struct PopoutMeta {
    /// 弹出类型："quick-send"、"terminal" 或 "help"。
    pub kind: String,
    /// 目标端口 id（终端弹出时为 portId；快捷发送为 None）。
    pub target_id: Option<String>,
}

/// help 窗口收到已有窗口复用请求时的目标载荷。
///
/// `article_id` 的 wire 名称显式固定为 `articleId`，避免事件载荷跟 Rust
/// 字段命名约定漂移。首次打开时同样的值通过 URL query 传递。
#[derive(Debug, Clone, serde::Serialize)]
struct HelpOpenPayload {
    #[serde(rename = "articleId")]
    article_id: Option<String>,
    anchor: Option<String>,
}

fn validate_help_component(value: &str, name: &str) -> Result<(), CommandError> {
    if value.is_empty() {
        return Err(CommandError::Other(format!(
            "Help {name} must not be empty"
        )));
    }
    if value.len() > HELP_MAX_COMPONENT_BYTES {
        return Err(CommandError::Other(format!("Help {name} is too long")));
    }
    if value
        .chars()
        .any(|ch| ch.is_control() || ch == '#' || ch == '\\')
    {
        return Err(CommandError::Other(format!(
            "Help {name} contains invalid characters"
        )));
    }
    if value.split('/').any(|segment| segment == "..") {
        return Err(CommandError::Other(format!(
            "Help {name} contains a path traversal"
        )));
    }
    Ok(())
}

/// Decode the service token `articleId#anchor` without allowing path/query
/// delimiters to escape the app-owned help route. Article ids may contain `/`
/// because the content pipeline can use a relative source path as a stable id.
fn parse_help_target(target_id: Option<&str>) -> Result<HelpOpenPayload, CommandError> {
    let Some(token) = target_id else {
        return Ok(HelpOpenPayload {
            article_id: None,
            anchor: None,
        });
    };
    if token.len() > HELP_MAX_COMPONENT_BYTES * 2 + 1 {
        return Err(CommandError::Other("Help target is too long".into()));
    }
    let (article, anchor) = token
        .split_once('#')
        .map_or((token, None), |(article, anchor)| (article, Some(anchor)));
    validate_help_component(article, "article id")?;
    if let Some(anchor) = anchor {
        if anchor.is_empty() {
            return Err(CommandError::Other("Help anchor must not be empty".into()));
        }
        validate_help_component(anchor, "anchor")?;
    }
    Ok(HelpOpenPayload {
        article_id: Some(article.to_string()),
        anchor: anchor.map(str::to_string),
    })
}

/// Encode UTF-8 bytes injectively into the window label's safe alphabet.
/// Escape '_' too so a literal escape-like id cannot collide with another port.
fn sanitize(id: &str) -> String {
    use std::fmt::Write;
    let mut safe = String::with_capacity(id.len());
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() || byte == b'-' {
            safe.push(char::from(byte));
        } else {
            let _ = write!(&mut safe, "_{byte:02X}");
        }
    }
    safe
}

fn popout_url(kind: &str, target_id: Option<&str>) -> Result<String, CommandError> {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    serializer.append_pair("popout", kind);
    match kind {
        "help" => {
            let target = parse_help_target(target_id)?;
            if let Some(article_id) = target.article_id.as_deref() {
                serializer.append_pair("article", article_id);
            }
            if let Some(anchor) = target.anchor.as_deref() {
                serializer.append_pair("anchor", anchor);
            }
        }
        _ => {
            serializer.append_pair("id", target_id.unwrap_or_default());
        }
    }
    Ok(format!("index.html?{}", serializer.finish()))
}

/// 按 kind + target_id 计算窗口 label。未知 kind 返回 Err。
fn compute_label(kind: &str, target_id: Option<&str>) -> Result<String, CommandError> {
    match kind {
        "quick-send" => Ok("quick-send".to_string()),
        "terminal" => Ok(format!("terminal-{}", sanitize(target_id.unwrap_or("")))),
        // Help is a singleton. Its article/anchor target must never affect the
        // native label, otherwise each link opens another native window.
        "help" => Ok("help".to_string()),
        other => Err(CommandError::Other(format!(
            "Unknown popout kind: {}",
            other
        ))),
    }
}

/// Pop-out window management is a main-window concern only. `set_popout_always_on_top`
/// is intentionally exempt: a pop-out toggles its own pin from its title bar.
fn require_main_window(window: &tauri::WebviewWindow) -> Result<(), CommandError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(CommandError::System(
            "Only the main window may manage pop-out windows".into(),
        ))
    }
}

/// 打开（或聚焦已存在的）弹出窗。
///
/// **async**：Windows/Webview2 下从同步命令创建窗口可能死锁（Tauri 官方建议
/// 用 async 命令建窗）。async 命令运行于异步线程池，建窗经 Tauri 内部调度回
/// 主线程，规避死锁。函数体内无 `.await`，注册表锁在末尾同步获取/释放，
/// 不存在 MutexGuard 跨 await 问题。
/// 已存在同 label 窗口时仅 `show()` + `set_focus()`，不重复创建。
/// 只接受主窗调用（webview label 由 Tauri 注入，JS 不能伪造）。
#[tauri::command]
pub async fn open_popout(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    kind: String,
    target_id: Option<String>,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    let help_target = if kind == "help" {
        Some(parse_help_target(target_id.as_deref())?)
    } else {
        None
    };
    let label = compute_label(&kind, target_id.as_deref())?;

    // 已存在 → 拉起聚焦，避免重复窗口。Help 还把新目标通知给现有页面，
    // 因为 singleton 不能通过重新建窗 URL 更新当前文章。
    if let Some(window) = app.get_webview_window(&label) {
        if let Some(target) = help_target {
            app.emit_to(EventTarget::webview_window(&label), "help:open", target)
                .map_err(|e| CommandError::System(e.to_string()))?;
        }
        window
            .show()
            .map_err(|e| CommandError::System(e.to_string()))?;
        window
            .set_focus()
            .map_err(|e| CommandError::System(e.to_string()))?;
        return Ok(());
    }

    let url = popout_url(&kind, target_id.as_deref())?;

    // 按 kind 取默认标题与尺寸。
    let (title, width, height) = match kind.as_str() {
        "quick-send" => ("HyperCom — Quick Send", 280.0, 640.0),
        "terminal" => ("HyperCom — Terminal", 720.0, 480.0),
        "help" => ("HyperCom — Help", 1080.0, 760.0),
        // compute_label 已拦截未知 kind，此处不可达。
        _ => unreachable!("compute_label already rejected unknown kind"),
    };

    let mut builder =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
            .title(title)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .inner_size(width, height)
            .resizable(true);

    // owner 语义：恒在主窗之上、随主窗最小化/销毁。主窗缺失时跳过 parent 仍建窗。
    if let Some(main_window) = app.get_webview_window("main") {
        builder = builder
            .parent(&main_window)
            .map_err(|e| CommandError::System(e.to_string()))?;
    }

    builder
        .build()
        .map_err(|e| CommandError::System(e.to_string()))?;

    // 建窗成功后登记注册表。
    let mut popouts = state
        .popouts
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    popouts.insert(label, PopoutMeta { kind, target_id });

    log::info!("Pop-out window opened");
    Ok(())
}

/// 关闭弹出窗并从注册表移除。窗口已不存在时仅清理注册表。
/// label 由 `compute_label` 从 kind + target_id 计算（前端不持有 label 规则）。
///
/// 返回值语义是“关闭请求已被接受”：quick-send 走 `CloseRequested`，编辑器守卫
/// 可能取消这次关闭；终端的 `destroy()` 会异步生效。调用方不应把 `Ok(())`
/// 当作“窗口此刻已消失”。
/// 只接受主窗调用（webview label 由 Tauri 注入，JS 不能伪造）。
#[tauri::command]
pub fn close_popout(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<AppState>,
    kind: String,
    target_id: Option<String>,
) -> Result<(), CommandError> {
    require_main_window(&window)?;
    let label = compute_label(&kind, target_id.as_deref())?;
    // Quick-send contains session drafts: request its guarded close rather than
    // destroying the WebView and bypassing save/discard confirmation.
    if kind == "quick-send" {
        if let Some(window) = app.get_webview_window(&label) {
            return window
                .close()
                .map_err(|error| CommandError::System(error.to_string()));
        }
    }
    let removed = state
        .popouts
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?
        .remove(&label);
    let destroy_result = if let Some(window) = app.get_webview_window(&label) {
        window
            .destroy()
            .map_err(|e| CommandError::System(e.to_string()))
    } else {
        Ok(())
    };
    if let Err(error) = destroy_result {
        if let Some(meta) = removed {
            if let Ok(mut popouts) = state.popouts.lock() {
                popouts.insert(label, meta);
            }
        }
        return Err(error);
    }
    // Remove metadata before destroy: Destroyed only reports user-closed windows.
    log::info!("Pop-out window closed");
    Ok(())
}

/// 切换弹出窗置顶状态。窗口（由 kind + target_id 算出 label）不存在时返回 Err。
#[tauri::command]
pub fn set_popout_always_on_top(
    app: AppHandle,
    kind: String,
    target_id: Option<String>,
    on: bool,
) -> Result<(), CommandError> {
    let label = compute_label(&kind, target_id.as_deref())?;
    let window = app
        .get_webview_window(&label)
        .ok_or_else(|| CommandError::Other(format!("Pop-out window not found: {}", label)))?;
    window
        .set_always_on_top(on)
        .map_err(|e| CommandError::System(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_labels_keep_distinct_port_ids_distinct() {
        let ids = [
            "COM3",
            "COM-3_x",
            "COM 3",
            "/dev/ttyUSB0",
            "a.b:c",
            "a_b_c",
            "a_2Eb_3Ac",
            "端口",
        ];
        let labels: std::collections::HashSet<_> = ids
            .iter()
            .map(|id| compute_label("terminal", Some(id)).unwrap())
            .collect();
        assert_eq!(labels.len(), ids.len());
        assert!(labels.iter().all(|label| label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')));
    }

    #[test]
    fn popout_query_roundtrips_special_port_id() {
        let id = "/dev/tty+usb&name=#端口";
        let route = popout_url("terminal", Some(id)).unwrap();
        let parsed = url::Url::parse(&format!("https://localhost/{route}")).unwrap();
        let query: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(query.get("id").unwrap(), id);
        assert_eq!(query.get("popout").unwrap(), "terminal");
    }

    #[test]
    fn test_compute_label_quick_send_is_singleton() {
        assert_eq!(compute_label("quick-send", None).unwrap(), "quick-send");
        // target_id 对快捷发送无影响。
        assert_eq!(
            compute_label("quick-send", Some("COM3")).unwrap(),
            "quick-send"
        );
    }

    #[test]
    fn test_compute_label_terminal_uses_encoded_target_id() {
        assert_eq!(
            compute_label("terminal", Some("COM3")).unwrap(),
            "terminal-COM3"
        );
        assert_eq!(
            compute_label("terminal", Some("/dev/ttyUSB0")).unwrap(),
            "terminal-_2Fdev_2FttyUSB0"
        );
        assert_eq!(compute_label("terminal", None).unwrap(), "terminal-");
    }

    #[test]
    fn test_compute_label_unknown_kind_errors() {
        assert!(compute_label("control-bar", None).is_err());
    }

    #[test]
    fn help_is_singleton_and_encodes_article_and_anchor_as_query() {
        assert_eq!(
            compute_label("help", Some("quick-start#connect")).unwrap(),
            "help"
        );
        let route = popout_url("help", Some("快速入门#连接设备")).unwrap();
        let parsed = url::Url::parse(&format!("https://localhost/{route}")).unwrap();
        let query: std::collections::HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        assert_eq!(query.get("popout").unwrap(), "help");
        assert_eq!(query.get("article").unwrap(), "快速入门");
        assert_eq!(query.get("anchor").unwrap(), "连接设备");
        assert!(!query.contains_key("id"));
    }

    #[test]
    fn help_target_validation_rejects_unsafe_or_incomplete_tokens() {
        for target in [
            "#anchor",
            "article#",
            "article#one#two",
            "../secret",
            "article/../secret",
            "article\\\\secret",
        ] {
            assert!(
                parse_help_target(Some(target)).is_err(),
                "accepted unsafe help target {target:?}"
            );
        }
        assert!(parse_help_target(None).unwrap().article_id.is_none());
    }

    #[test]
    fn help_open_payload_uses_stable_article_id_wire_name() {
        let payload = serde_json::to_value(HelpOpenPayload {
            article_id: Some("quick-start".into()),
            anchor: Some("connect".into()),
        })
        .unwrap();
        assert_eq!(payload["articleId"], "quick-start");
        assert_eq!(payload["anchor"], "connect");
        assert!(payload.get("article_id").is_none());
    }

    fn read_json(relative: &str) -> serde_json::Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
        let content =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        serde_json::from_str(&content)
            .unwrap_or_else(|e| panic!("{} must be valid JSON: {e}", path.display()))
    }

    fn capability(name: &str) -> serde_json::Value {
        read_json(&format!("capabilities/{name}"))
    }

    fn string_list<'a>(value: &'a serde_json::Value, field: &str) -> Vec<&'a str> {
        value[field]
            .as_array()
            .unwrap_or_else(|| panic!("{field} must be an array"))
            .iter()
            .map(|item| {
                item.as_str()
                    .unwrap_or_else(|| panic!("{field} entries must be strings"))
            })
            .collect()
    }

    fn permissions(value: &serde_json::Value) -> Vec<&str> {
        string_list(value, "permissions")
    }

    fn assert_has_permissions(value: &serde_json::Value, required: &[&str]) {
        let permissions = permissions(value);
        for permission in required {
            assert!(
                permissions.iter().any(|candidate| candidate == permission),
                "missing {permission}"
            );
        }
    }

    fn assert_lacks_permissions(value: &serde_json::Value, forbidden: &[&str]) {
        let permissions = permissions(value);
        for permission in forbidden {
            assert!(
                permissions.iter().all(|candidate| candidate != permission),
                "permission {permission} must not be granted here"
            );
        }
    }

    #[test]
    fn popout_title_text_remains_a_native_drag_and_double_click_region() {
        let source = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../src/components/Popout/PopoutShell.tsx"),
        )
        .unwrap();
        assert!(source.contains("<span className=\"popout-title\" data-tauri-drag-region>"));
        assert!(source.contains("className=\"popout-titlebar-drag\" data-tauri-drag-region"));
        // Tauri's injected drag.js selects start_dragging for detail=1 and its
        // default internal_toggle_maximize command for detail=2 on this region.
        assert_has_permissions(
            &capability("popout.json"),
            &["core:default", "core:window:allow-start-dragging"],
        );
    }

    #[test]
    fn capability_split_scopes_window_management_to_popouts() {
        let main = capability("main.json");
        let popout = capability("popout.json");

        assert_eq!(string_list(&main, "windows"), ["main"]);
        assert_eq!(
            string_list(&popout, "windows"),
            ["quick-send", "terminal-*"]
        );

        // Dragging is installed from the shared title-bar markup in both windows.
        assert_has_permissions(&main, &["core:window:allow-start-dragging"]);
        assert_has_permissions(&popout, &["core:window:allow-start-dragging"]);

        // Pop-out teardown needs close/destroy; the main window must never be able
        // to destroy itself (that used to leave a windowless, unquittable process).
        assert_has_permissions(
            &popout,
            &[
                "core:window:allow-close",
                "core:window:allow-destroy",
                "core:window:allow-set-title",
                "core:webview:allow-set-webview-zoom",
                "core:event:allow-listen",
                "core:event:allow-emit",
                "clipboard-manager:allow-write-text",
            ],
        );
        assert_lacks_permissions(&main, &["core:window:allow-destroy"]);
    }

    #[test]
    fn help_capability_is_singleton_and_minimally_scoped() {
        let help = capability("help.json");
        assert_eq!(string_list(&help, "windows"), ["help"]);
        assert_has_permissions(
            &help,
            &[
                "core:default",
                "core:event:allow-listen",
                "core:event:allow-emit",
                "core:webview:allow-set-webview-zoom",
                "core:window:allow-close",
                "core:window:allow-start-dragging",
                "core:window:allow-set-always-on-top",
                "core:window:allow-set-title",
            ],
        );
        assert_lacks_permissions(
            &help,
            &[
                "core:window:allow-destroy",
                "shell:allow-open",
                "dialog:allow-open",
                "process:default",
                "core:app:allow-version",
                "clipboard-manager:allow-write-text",
                "clipboard-manager:allow-read-text",
            ],
        );
    }

    #[test]
    fn capability_split_keeps_desktop_plugins_on_the_main_window() {
        let main = capability("main.json");
        let popout = capability("popout.json");

        assert_has_permissions(
            &main,
            &[
                "dialog:allow-open",
                "dialog:allow-save",
                "dialog:allow-message",
                "shell:allow-open",
                "core:app:allow-version",
                "process:default",
            ],
        );
        // `process:default` includes restart, which bypasses the close approval;
        // dialogs/shell/app-version are main-window features only.
        for forbidden in [
            "process:default",
            "dialog:allow-open",
            "dialog:allow-save",
            "shell:allow-open",
            "core:app:allow-version",
        ] {
            assert_lacks_permissions(&popout, &[forbidden]);
        }
        let popout_permissions = permissions(&popout);
        for prefix in ["process:", "dialog:", "shell:", "core:app:"] {
            assert!(
                popout_permissions
                    .iter()
                    .all(|permission| !permission.starts_with(prefix)),
                "pop-out permissions must not include the {prefix} domain"
            );
        }
    }

    #[test]
    fn generated_capability_schema_matches_the_split_sources() {
        let schema = read_json("gen/schemas/capabilities.json");
        assert!(
            schema.get("default").is_none(),
            "the legacy shared capability must be gone"
        );
        for name in ["main", "popout"] {
            let source = capability(&format!("{name}.json"));
            let generated = schema
                .get(name)
                .unwrap_or_else(|| panic!("gen/schemas/capabilities.json is missing {name}"));
            assert_eq!(
                string_list(generated, "windows"),
                string_list(&source, "windows"),
                "generated windows drifted for {name}"
            );
            let mut source_permissions = permissions(&source);
            let mut generated_permissions = permissions(generated);
            source_permissions.sort_unstable();
            generated_permissions.sort_unstable();
            assert_eq!(
                generated_permissions, source_permissions,
                "generated permissions drifted for {name}"
            );
        }
    }
}
