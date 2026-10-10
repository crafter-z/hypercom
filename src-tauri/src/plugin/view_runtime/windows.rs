//! All native policies are installed on an empty raw Wry control, before Navigate.
//! No Tauri WebView builder, initialization script, host object or invoke transport.
use std::{cell::{Cell, RefCell}, collections::HashMap, num::NonZeroIsize, path::PathBuf, rc::Rc, sync::{Arc, atomic::Ordering}};
use tauri::Manager;
use webview2_com::{
    Microsoft::Web::WebView2::Win32::*,
    AcceleratorKeyPressedEventHandler, CallDevToolsProtocolMethodCompletedHandler,
    FocusChangedEventHandler, LaunchingExternalUriSchemeEventHandler,
    NavigationCompletedEventHandler, NavigationStartingEventHandler,
    PermissionRequestedEventHandler, ProcessFailedEventHandler,
    WebResourceRequestedEventHandler,
};
use windows::{core::{w, HSTRING, Interface, PCWSTR, PWSTR}, Win32::{Foundation::HWND, System::Com::CoTaskMemFree, UI::{Shell::SHCreateMemStream, Input::KeyboardAndMouse::GetKeyState, WindowsAndMessaging::{CreateWindowExW, DestroyWindow, SetWindowPos, ShowWindow, HWND_TOP, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, WINDOW_EX_STYLE, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS}}}};
use wry::{raw_window_handle::{HandleError, HasWindowHandle, Win32WindowHandle, WindowHandle}, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};
use super::{resources::Resource, Rect, Session};

struct EphemeralDirectory(PathBuf);
impl Drop for EphemeralDirectory {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}
// Wry 0.55.1 removes its parent's resize/focus subclass even for child views.
// Never make the Tauri window that parent: retiring a plugin would detach the
// main WebView's subclass. This private HWND owns only this plugin's child.
struct ViewParent(HWND);
impl ViewParent {
    fn new(parent: HWND) -> Result<Self, String> {
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(), w!("STATIC"), PCWSTR::null(),
                WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                0, 0, 0, 0, Some(parent), None, None, None,
            )
        }.map_err(|e| e.to_string())?;
        Ok(Self(hwnd))
    }
    fn set_bounds(&self, x: i32, y: i32, width: i32, height: i32) -> Result<(), String> {
        unsafe { SetWindowPos(self.0, Some(HWND_TOP), x, y, width, height, SWP_NOACTIVATE) }
            .map_err(|e| e.to_string())
    }
    fn set_visible(&self, visible: bool) {
        let _ = unsafe { ShowWindow(self.0, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE }) };
    }
}
impl HasWindowHandle for ViewParent {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let hwnd = NonZeroIsize::new(self.0.0 as isize).ok_or(HandleError::Unavailable)?;
        // Created and used on the UI thread; this borrow cannot outlive its owner.
        Ok(unsafe { WindowHandle::borrow_raw(Win32WindowHandle::new(hwnd).into()) })
    }
}
impl Drop for ViewParent {
    fn drop(&mut self) { let _ = unsafe { DestroyWindow(self.0) }; }
}
struct Control {
    webview: WebView,
    // Field order keeps the private parent alive until Wry has been dropped.
    parent: ViewParent,
    _context: wry::WebContext,
    _directory: EphemeralDirectory,
    session: Arc<Session>,
    revision: Option<u64>,
}
impl Drop for Control {
    fn drop(&mut self) {
        self.session.alive.store(false, Ordering::Release);
        let _ = unsafe { self.webview.controller().Close() };
    }
}
thread_local! { static CONTROLS: RefCell<HashMap<String, Control>> = RefCell::new(HashMap::new()); }

pub fn create(window: &tauri::Window, session: Arc<Session>, declaration: crate::plugin::UiView, mut resources: HashMap<String, Resource>) -> Result<(), String> {
    let directory = std::env::temp_dir().join(format!("hypercom-view-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let directory_guard = EphemeralDirectory(directory.clone());
    let mut context = wry::WebContext::new(Some(directory.clone()));
    let app = window.app_handle().clone();
    let ipc_session = session.clone();
    let ipc_app = app.clone();
    let origin = format!("https://{}.plugin.invalid", uuid::Uuid::new_v4().simple());
    let shell_url = format!("{origin}/__host/index.html");
    let ipc_shell = shell_url.clone();
    let browser_args = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-blink-features=FileSystemAccess,FileSystemAccessLocal,FileSystemAccessOriginPrivate,FileSystem,WebUSB,WebHID,Serial,WebBluetooth,PaymentRequest,SharedWorker --force-webrtc-ip-handling-policy=disable_non_proxied_udp --disable-background-networking --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback> --host-resolver-rules=\"MAP * ~NOTFOUND\"";
    // Wry with no URL/HTML starts with an empty document. Plugin assets are not
    // reachable until every required native policy and CDP operation succeeds.
    let parent = ViewParent::new(HWND(window.hwnd().map_err(|e| e.to_string())?.0))?;
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_visible(false)
        .with_incognito(true)
        .with_devtools(false)
        .with_browser_extensions_enabled(false)
        .with_additional_browser_args(browser_args)
        .with_drag_drop_handler(|_| true)
        .with_download_started_handler(|_, _| false)
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .with_ipc_handler(move |request| {
            if request.uri().to_string() == ipc_shell { super::receive(&ipc_app, &ipc_session, request.body()); }
        })
        .build_as_child(&parent).map_err(|e| e.to_string())?;
    let core = webview.webview();
    let env = webview.environment();
    let styles = declaration.styles.iter().map(|path| format!("<link rel=\"stylesheet\" href=\"/{path}\">" )).collect::<String>();
    let html = format!("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">{styles}<script defer src=\"/__host/sdk.js\"></script><script defer src=\"/{}\"></script></head><body><div id=\"plugin-root\"></div></body></html>", declaration.entry);
    // Host namespace cannot be substituted by a plugin declaration.
    if resources.keys().any(|path| path.starts_with("__host/")) { return Err("插件资源不得覆盖宿主命名空间".into()); }
    resources.insert("__host/index.html".into(), Resource { bytes: html.into_bytes(), mime: "text/html; charset=utf-8" });
    let binding_json = serde_json::to_string(&session.binding).map_err(|e| e.to_string())?;
    let sdk = include_str!("sdk.js").replace("__HOST_VIEW_CONTEXT__", &binding_json);
    resources.insert("__host/sdk.js".into(), Resource { bytes: sdk.into_bytes(), mime: "text/javascript; charset=utf-8" });
    let resources = Rc::new(resources);
    let initial_navigation = Rc::new(Cell::new(true));
    let navigation_flag = initial_navigation.clone();
    let allowed_shell = shell_url.clone();
    let navigation_session = session.clone();
    let resource_session = session.clone();
    let resource_origin = origin.clone();
    let focus_session = session.clone();
    let focus_app = app.clone();
    unsafe {
        let settings = core.Settings().map_err(|e| e.to_string())?;
        settings.SetAreHostObjectsAllowed(false).map_err(|e| e.to_string())?;
        settings.SetAreDevToolsEnabled(false).map_err(|e| e.to_string())?;
        settings.SetAreDefaultContextMenusEnabled(false).map_err(|e| e.to_string())?;
        settings.SetAreDefaultScriptDialogsEnabled(false).map_err(|e| e.to_string())?;
        settings.SetIsStatusBarEnabled(false).map_err(|e| e.to_string())?;
        settings.SetIsZoomControlEnabled(false).map_err(|e| e.to_string())?;
        settings.SetIsBuiltInErrorPageEnabled(false).map_err(|e| e.to_string())?;
        // Clipboard user copy/cut is the explicit user-approved exception. This
        // does not grant async clipboard read/write, which PermissionRequested denies.
        settings.cast::<ICoreWebView2Settings3>().and_then(|s| s.SetAreBrowserAcceleratorKeysEnabled(false)).map_err(|e| e.to_string())?;
        let settings4: ICoreWebView2Settings4 = settings.cast().map_err(|e| e.to_string())?;
        settings4.SetIsPasswordAutosaveEnabled(false).map_err(|e| e.to_string())?;
        settings4.SetIsGeneralAutofillEnabled(false).map_err(|e| e.to_string())?;
        settings.cast::<ICoreWebView2Settings6>().and_then(|s| s.SetIsSwipeNavigationEnabled(false)).map_err(|e| e.to_string())?;
        webview.controller().cast::<ICoreWebView2Controller4>().and_then(|c| c.SetAllowExternalDrop(false)).map_err(|e| e.to_string())?;
        let mut token = 0;
        core.add_NavigationStarting(&NavigationStartingEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut uri = PWSTR::null(); args.Uri(&mut uri)?;
                let uri = take_string(uri);
                let allow = navigation_session.alive.load(Ordering::Acquire) && uri == allowed_shell && navigation_flag.replace(false);
                args.SetCancel(!allow)?;
            }
            Ok(())
        })), &mut token).map_err(|e| e.to_string())?;
        core.add_FrameNavigationStarting(&NavigationStartingEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args { args.SetCancel(true)?; } Ok(())
        })), &mut token).map_err(|e| e.to_string())?;
        core.add_PermissionRequested(&PermissionRequestedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args { args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?; } Ok(())
        })), &mut token).map_err(|e| e.to_string())?;
        core.cast::<ICoreWebView2_18>().and_then(|c| c.add_LaunchingExternalUriScheme(&LaunchingExternalUriSchemeEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args { args.SetCancel(true)?; } Ok(())
        })), &mut token)).map_err(|e| e.to_string())?;
        webview.controller().add_GotFocus(&FocusChangedEventHandler::create(Box::new(move |_, _| {
            super::native_focus(&focus_app, &focus_session); Ok(())
        })), &mut token).map_err(|e| e.to_string())?;
        let failure_app = app.clone();
        let failure_session = session.clone();
        core.add_ProcessFailed(&ProcessFailedEventHandler::create(Box::new(move |_, _| {
            super::native_error(&failure_app, &failure_session, "插件 UI 浏览器进程故障");
            Ok(())
        })), &mut token).map_err(|e| e.to_string())?;
        let loading_app = app.clone();
        let loading_session = session.clone();
        core.add_NavigationCompleted(&NavigationCompletedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut success = windows::core::BOOL(0); args.IsSuccess(&mut success)?;
                if !success.as_bool() { super::native_error(&loading_app, &loading_session, "插件 UI 文档加载失败"); }
            }
            Ok(())
        })), &mut token).map_err(|e| e.to_string())?;
        webview.controller().add_AcceleratorKeyPressed(&AcceleratorKeyPressedEventHandler::create(Box::new(|_, args| {
            if let Some(args) = args {
                let mut key = 0; args.VirtualKey(&mut key)?;
                let control = GetKeyState(0x11) < 0;
                let shift = GetKeyState(0x10) < 0;
                if (control && key == 0x56) || (shift && key == 0x2d) { args.SetHandled(true)?; }
            }
            Ok(())
        })), &mut token).map_err(|e| e.to_string())?;
        // ALL request source kinds includes dedicated/shared/service workers.
        // The resource responder handles every URI itself; there is no network fallthrough.
        core.cast::<ICoreWebView2_22>().and_then(|c| c.AddWebResourceRequestedFilterWithRequestSourceKinds(&HSTRING::from("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL)).map_err(|e| e.to_string())?;
        core.add_WebResourceRequested(&WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()); };
            let denied = env.CreateWebResourceResponse(None, 403, &HSTRING::from("Forbidden"), &HSTRING::from("Content-Type: text/plain\r\nCache-Control: no-store\r\n"))?;
            args.SetResponse(&denied)?;
            let request = args.Request()?;
            let mut uri = PWSTR::null(); request.Uri(&mut uri)?;
            let uri = take_string(uri);
            let mut method = PWSTR::null(); request.Method(&mut method)?;
            let method = take_string(method);
            let mut kind = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
            args.ResourceContext(&mut kind)?;
            let mut source_kind = COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL;
            args.cast::<ICoreWebView2WebResourceRequestedEventArgs2>()?.RequestedSourceKind(&mut source_kind)?;
            let path = uri.strip_prefix(resource_origin.as_str()).and_then(|path| path.strip_prefix('/'))
                .and_then(|path| if path.contains(['?', '#']) { None } else { percent_encoding::percent_decode_str(path).decode_utf8().ok() });
            let resource = if resource_session.alive.load(Ordering::Acquire) && method == "GET"
                && source_kind == COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT
                && kind != COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET
                && path.as_deref().is_some_and(|path| crate::plugin::validate_view_resource_path(path).is_ok()) {
                path.as_deref().and_then(|path| resources.get(path))
            } else { None };
            let (status, mime, bytes) = resource.map(|r| (200, r.mime, r.bytes.as_slice())).unwrap_or((403, "text/plain", b"Forbidden"));
            let stream = SHCreateMemStream(Some(bytes));
            let policy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin";
            let headers = HSTRING::from(format!("Content-Type: {mime}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nContent-Security-Policy: {policy}\r\nPermissions-Policy: camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=(), payment=()\r\n"));
            let response = env.CreateWebResourceResponse(stream.as_ref(), status, &HSTRING::from(if status == 200 { "OK" } else { "Forbidden" }), &headers)?;
            args.SetResponse(&response)?;
            Ok(())
        })), &mut token).map_err(|e| e.to_string())?;
    }
    // Native CDP interception prevents HTML input chooser before it opens; no
    // DOM click handler or patched file API participates in the security boundary.
    cdp(&core, "Page.enable", "{}")?;
    cdp(&core, "Page.setInterceptFileChooserDialog", "{\"enabled\":true}")?;
    cdp(&core, "Network.enable", "{}")?;
    cdp(&core, "Network.emulateNetworkConditions", "{\"offline\":true,\"latency\":0,\"downloadThroughput\":0,\"uploadThroughput\":0}")?;
    cdp(&core, "Network.setBlockedURLs", "{\"urls\":[\"http://*\",\"ws://*\",\"wss://*\",\"file://*\",\"ftp://*\",\"tauri://*\",\"ipc://*\",\"asset://*\"]}")?;
    let control = Control { webview, parent, _context: context, _directory: directory_guard, session: session.clone(), revision: None };
    if !session.alive.load(Ordering::Acquire) { return Err("视图创建期间已退休".into()); }
    unsafe { core.Navigate(&HSTRING::from(shell_url)).map_err(|e| e.to_string())?; }
    CONTROLS.with(|controls| { controls.borrow_mut().insert(session.binding.view_instance_id.clone(), control); });
    Ok(())
}

fn cdp(core: &ICoreWebView2, method: &str, parameters: &str) -> Result<(), String> {
    let core = core.clone();
    let method = HSTRING::from(method);
    let parameters = HSTRING::from(parameters);
    CallDevToolsProtocolMethodCompletedHandler::wait_for_async_operation(Box::new(move |callback| {
        unsafe { core.CallDevToolsProtocolMethod(&method, &parameters, &callback)?; }
        Ok(())
    }), Box::new(|result, response| {
        result?;
        if serde_json::from_str::<serde_json::Value>(&response).map_or(true, |value| value.get("error").is_some()) {
            return Err(windows::core::Error::from_hresult(windows::core::HRESULT(0x80004005u32 as i32)));
        }
        Ok(())
    })).map_err(|e| format!("WebView2 不支持所需原生隔离策略: {e}"))
}
unsafe fn take_string(value: PWSTR) -> String {
    let result = value.to_string().unwrap_or_default();
    CoTaskMemFree(Some(value.0.cast()));
    result
}

pub fn update(window: &tauri::Window, id: &str, rect: Rect, visible: bool, revision: u64) -> Result<(), String> {
    CONTROLS.with(|controls| {
        let mut controls = controls.borrow_mut();
        let control = controls.get_mut(id).ok_or("视图实例不存在")?;
        if !control.session.alive.load(Ordering::Acquire) { return Err("视图已退休".into()); }
        if control.revision.is_some_and(|last| revision <= last) { return Ok(()); }
        control.revision = Some(revision);
        let dpi = window.scale_factor().map_err(|e| e.to_string())?;
        let size = window.inner_size().map_err(|e| e.to_string())?;
        let factor = dpi * rect.zoom_percent / 100.0;
        let left = (rect.x * factor).clamp(0.0, size.width as f64);
        let top = (rect.y * factor).clamp(0.0, size.height as f64);
        let right = ((rect.x + rect.width) * factor).clamp(left, size.width as f64);
        let bottom = ((rect.y + rect.height) * factor).clamp(top, size.height as f64);
        let width = (right - left).round() as i32;
        let height = (bottom - top).round() as i32;
        control.parent.set_bounds(left.round() as i32, top.round() as i32, width, height)?;
        control.webview.set_bounds(wry::Rect {
            position: wry::dpi::PhysicalPosition::new(0, 0).into(),
            size: wry::dpi::PhysicalSize::new(width as u32, height as u32).into(),
        }).map_err(|e| e.to_string())?;
        control.webview.zoom(rect.zoom_percent / 100.0).map_err(|e| e.to_string())?;
        let visible = visible && width > 0 && height > 0 && window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true);
        control.webview.set_visible(visible).map_err(|e| e.to_string())?;
        control.parent.set_visible(visible);
        Ok(())
    })
}
pub fn send(id: &str, source: &str) -> Result<(), String> {
    CONTROLS.with(|controls| {
        let controls = controls.borrow();
        let control = controls.get(id).ok_or("视图实例不存在")?;
        if !control.session.alive.load(Ordering::Acquire) { return Err("视图已退休".into()); }
        control.webview.evaluate_script(source).map_err(|e| e.to_string())
    })
}
pub fn destroy(id: &str) { CONTROLS.with(|controls| { controls.borrow_mut().remove(id); }); }
pub fn clear() { CONTROLS.with(|controls| { controls.borrow_mut().clear(); }); }

#[cfg(test)]
mod tests {
    use super::{EphemeralDirectory, ViewParent};
    use windows::{core::{w, PCWSTR}, Win32::{Foundation::RECT, UI::WindowsAndMessaging::{CreateWindowExW, GetClientRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW}}};
    use wry::{WebContext, WebViewBuilder, WebViewExtWindows};

    #[test]
    #[ignore = "requires the native Windows WebView2 runtime"]
    fn retiring_plugin_children_preserves_host_resize() {
        let directory = EphemeralDirectory(std::env::temp_dir().join(format!("hypercom-resize-test-{}", uuid::Uuid::new_v4())));
        let mut context = WebContext::new(Some(directory.0.clone()));
        let host = ViewParent(unsafe {
            CreateWindowExW(WINDOW_EX_STYLE::default(), w!("STATIC"), PCWSTR::null(), WS_OVERLAPPEDWINDOW, 0, 0, 800, 600, None, None, None, None).unwrap()
        });
        let webview = WebViewBuilder::new_with_web_context(&mut context).with_visible(false).build(&host).unwrap();
        for (width, height) in [(1000, 700), (600, 400), (1100, 800)] {
            // Covers retirement and dropping a child before the host commits
            // it (e.g. when installing a required native policy fails).
            let parent = ViewParent::new(host.0).unwrap();
            let child = WebViewBuilder::new_with_web_context(&mut context).with_visible(false).build_as_child(&parent).unwrap();
            drop(child);
            drop(parent);
            unsafe {
                SetWindowPos(host.0, None, 0, 0, width, height, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE).unwrap();
                let mut client = RECT::default();
                let mut bounds = RECT::default();
                GetClientRect(host.0, &mut client).unwrap();
                webview.controller().Bounds(&mut bounds).unwrap();
                assert_eq!((bounds.left, bounds.top, bounds.right, bounds.bottom), (0, 0, client.right, client.bottom));
            }
        }
    }
}
