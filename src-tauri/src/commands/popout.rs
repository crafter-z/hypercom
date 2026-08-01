/**
 * 通用弹出窗命令 (Generic pop-out window commands)
 *
 * Phase 1「柔性工作区」的地基：一个 `open_popout` 同时服务快捷发送（单例）
 * 与终端标签（每端口一个）两类客户。窗口 label 约定：
 *   - 快捷发送 = `"quick-send"`（单例）
 *   - 终端     = `"terminal-{safe_id}"`（safe_id 由 `sanitize` 净化 portId 得到）
 *
 * 前端 `src/components/Popout/popoutLabel.ts` 持有完全一致的 label/sanitize
 * 逻辑——两侧必须同步修改，否则置顶/关闭命令会找不到窗口。
 */
use tauri::{AppHandle, Manager, State};

use super::CommandError;
use crate::AppState;

/// 弹出窗元数据：记录窗口 label 对应的业务语义。
#[derive(Debug, Clone)]
pub struct PopoutMeta {
    /// 弹出类型："quick-send" 或 "terminal"。
    pub kind: String,
    /// 目标端口 id（终端弹出时为 portId；快捷发送为 None）。
    pub target_id: Option<String>,
}

/// 将任意字符串净化为窗口 label 安全的标识符：
/// 非 `[A-Za-z0-9_-]` 字符一律替换为 `_`。
/// 与前端 `popoutLabel.ts` 的 `sanitize` 保持逐字符一致。
fn sanitize(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// 按 kind + target_id 计算窗口 label。未知 kind 返回 Err。
fn compute_label(kind: &str, target_id: Option<&str>) -> Result<String, CommandError> {
    match kind {
        "quick-send" => Ok("quick-send".to_string()),
        "terminal" => Ok(format!("terminal-{}", sanitize(target_id.unwrap_or("")))),
        other => Err(CommandError::Other(format!(
            "Unknown popout kind: {}",
            other
        ))),
    }
}

/// 打开（或聚焦已存在的）弹出窗。
///
/// **async**：Windows/Webview2 下从同步命令创建窗口可能死锁（Tauri 官方建议
/// 用 async 命令建窗）。async 命令运行于异步线程池，建窗经 Tauri 内部调度回
/// 主线程，规避死锁。函数体内无 `.await`，注册表锁在末尾同步获取/释放，
/// 不存在 MutexGuard 跨 await 问题。
/// 已存在同 label 窗口时仅 `show()` + `set_focus()`，不重复创建。
#[tauri::command]
pub async fn open_popout(
    app: AppHandle,
    state: State<'_, AppState>,
    kind: String,
    target_id: Option<String>,
) -> Result<(), CommandError> {
    let label = compute_label(&kind, target_id.as_deref())?;

    // 已存在 → 拉起聚焦，避免重复窗口。
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let id_query = target_id.clone().unwrap_or_default();
    let url = format!("index.html?popout={}&id={}", kind, id_query);

    // 按 kind 取默认标题与尺寸。
    let (title, width, height) = match kind.as_str() {
        "quick-send" => ("HyperCom — Quick Send", 280.0, 640.0),
        "terminal" => ("HyperCom — Terminal", 720.0, 480.0),
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
    popouts.insert(
        label,
        PopoutMeta {
            kind,
            target_id,
        },
    );

    log::info!("Pop-out window opened");
    Ok(())
}

/// 关闭弹出窗并从注册表移除。窗口已不存在时仅清理注册表。
#[tauri::command]
pub fn close_popout(
    app: AppHandle,
    state: State<AppState>,
    label: String,
) -> Result<(), CommandError> {
    if let Some(window) = app.get_webview_window(&label) {
        window
            .destroy()
            .map_err(|e| CommandError::System(e.to_string()))?;
    }
    if let Ok(mut popouts) = state.popouts.lock() {
        popouts.remove(&label);
    }
    log::info!("Pop-out window closed");
    Ok(())
}

/// 切换弹出窗置顶状态。label 不存在时返回 Err。
#[tauri::command]
pub fn set_popout_always_on_top(
    app: AppHandle,
    label: String,
    on: bool,
) -> Result<(), CommandError> {
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
    fn test_sanitize_replaces_unsafe_chars_with_underscore() {
        assert_eq!(sanitize("COM3"), "COM3");
        assert_eq!(sanitize("COM-3_x"), "COM-3_x");
        assert_eq!(sanitize("COM 3"), "COM_3");
        assert_eq!(sanitize("/dev/ttyUSB0"), "_dev_ttyUSB0");
        assert_eq!(sanitize("a.b:c"), "a_b_c");
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
    fn test_compute_label_terminal_uses_sanitized_target_id() {
        assert_eq!(compute_label("terminal", Some("COM3")).unwrap(), "terminal-COM3");
        assert_eq!(
            compute_label("terminal", Some("/dev/ttyUSB0")).unwrap(),
            "terminal-_dev_ttyUSB0"
        );
        assert_eq!(compute_label("terminal", None).unwrap(), "terminal-");
    }

    #[test]
    fn test_compute_label_unknown_kind_errors() {
        assert!(compute_label("control-bar", None).is_err());
    }
}
