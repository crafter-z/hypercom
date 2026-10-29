//! Raw Wry controls: isolated assets or explicitly trusted, persistent webpages.
//! Neither mode installs Tauri globals, host objects or an invoke transport.
use std::{cell::{Cell, RefCell}, collections::{HashMap, HashSet}, num::NonZeroIsize, path::{Path, PathBuf}, rc::Rc, sync::{Arc, Weak, atomic::Ordering}};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use webview2_com::{
    Microsoft::Web::WebView2::Win32::*,
    AcceleratorKeyPressedEventHandler, CallDevToolsProtocolMethodCompletedHandler,
    ClearBrowsingDataCompletedHandler, DownloadStartingEventHandler,
    DOMContentLoadedEventHandler, FocusChangedEventHandler, LaunchingExternalUriSchemeEventHandler,
    NavigationCompletedEventHandler, NavigationStartingEventHandler,
    NewWindowRequestedEventHandler, PermissionRequestedEventHandler, ProcessFailedEventHandler,
    StateChangedEventHandler, WebResourceRequestedEventHandler,
};
use tauri_plugin_shell::ShellExt;
use windows::{core::{w, Error, HSTRING, Interface, PCWSTR, PWSTR}, Win32::{Foundation::HWND, Graphics::Gdi::{CombineRgn, CreateRectRgn, DeleteObject, HGDIOBJ, HRGN, RGN_DIFF, RGN_ERROR, SetWindowRgn}, System::Com::CoTaskMemFree, UI::{Shell::SHCreateMemStream, Input::KeyboardAndMouse::GetKeyState, WindowsAndMessaging::{CreateWindowExW, DestroyWindow, SetWindowPos, ShowWindow, HWND_TOP, SW_HIDE, SW_SHOWNOACTIVATE, SWP_NOACTIVATE, WINDOW_EX_STYLE, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS}}}};
use wry::{raw_window_handle::{HandleError, HasWindowHandle, Win32WindowHandle, WindowHandle}, WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};
use super::{resources::Resource, OcclusionRect, Rect, Session};
struct OwnedRegion(Option<HRGN>);
impl OwnedRegion {
    fn rect(left: i32, top: i32, right: i32, bottom: i32) -> Result<Self, String> {
        let region = unsafe { CreateRectRgn(left, top, right, bottom) };
        if region.is_invalid() { return Err(Error::from_win32().to_string()); }
        Ok(Self(Some(region)))
    }
    fn raw(&self) -> HRGN { self.0.expect("owned region missing") }
    fn take(&mut self) -> HRGN { self.0.take().expect("owned region missing") }
}
impl Drop for OwnedRegion {
    fn drop(&mut self) {
        if let Some(region) = self.0.take() { let _ = unsafe { DeleteObject(HGDIOBJ::from(region)) }; }
    }
}

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
    _directory: Option<EphemeralDirectory>,
    profile_directory: Option<PathBuf>,
    downloads: Rc<RefCell<HashMap<String, ICoreWebView2DownloadOperation>>>,
    pending_downloads: Rc<RefCell<HashMap<String, PendingDownload>>>,
    session: Arc<Session>,
    revision: Option<u64>,
}
impl Drop for Control {
    fn drop(&mut self) {
        self.session.alive.store(false, Ordering::Release);
        let pending = std::mem::take(&mut *self.pending_downloads.borrow_mut());
        for download in pending.into_values() { let _ = unsafe { download.args.SetCancel(true) }; }
        // Cancel may synchronously raise StateChanged, so never hold this borrow.
        let downloads = std::mem::take(&mut *self.downloads.borrow_mut());
        for operation in downloads.into_values() { let _ = unsafe { operation.Cancel() }; }
        let _ = unsafe { self.webview.controller().Close() };
    }
}
struct PendingDownload {
    session: Weak<Session>,
    args: ICoreWebView2DownloadStartingEventArgs,
    deferral: ICoreWebView2Deferral,
}
impl Drop for PendingDownload {
    fn drop(&mut self) { let _ = unsafe { self.deferral.Complete() }; }
}
thread_local! {
    static CONTROLS: RefCell<HashMap<String, Control>> = RefCell::new(HashMap::new());
}

// Every control using a plugin profile, including maintenance controls, must
// use identical environment options so WebView2 can share its browser process.
const TRUSTED_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI";

fn trusted_origin(plugin: &str, view: &str) -> String {
    let mut hash = Sha256::new();
    hash.update((plugin.len() as u64).to_le_bytes());
    hash.update(plugin.as_bytes());
    hash.update(view.as_bytes());
    let digest = format!("{:x}", hash.finalize());
    format!("https://{}.{}.plugin.invalid", &digest[..32], &digest[32..])
}

/// Trusted local pages may navigate/reload between HTML files of the plugin's
/// own origin; query/fragment are not part of the validated resource path.
fn local_navigation_path(origin: &str, uri: &str) -> Option<String> {
    let base = url::Url::parse(origin).ok()?;
    let target = url::Url::parse(uri).ok()?;
    if target.scheme() != base.scheme() || target.host_str() != base.host_str()
        || target.port_or_known_default() != base.port_or_known_default()
        || !target.username().is_empty() || target.password().is_some() {
        return None;
    }
    let path = percent_encoding::percent_decode_str(target.path().trim_start_matches('/')).decode_utf8().ok()?.into_owned();
    let lower = path.to_ascii_lowercase();
    if !(lower.ends_with(".html") || lower.ends_with(".htm")) { return None; }
    crate::plugin::validate_view_resource_path(&path).ok()?;
    Some(path)
}

fn external_browser_uri(origin: &str, uri: &str) -> bool {
    let Ok(base) = url::Url::parse(origin) else { return false; };
    url::Url::parse(uri).map(|url| matches!(url.scheme(), "http" | "https") && url.origin() != base.origin()).unwrap_or(false)
}

/// Deliver the native document identity once parsing finished but before slow
/// subresources complete, so an ordinary lazy image cannot hide the page.
fn start_document(core: &ICoreWebView2, session: &Session) {
    let Some(document_id) = session.current_document() else { return; };
    if let Ok(literal) = serde_json::to_string(&document_id) {
        let source = format!("globalThis.__hypercomViewDocumentStart && globalThis.__hypercomViewDocumentStart({literal});");
        let _ = unsafe { core.ExecuteScript(&HSTRING::from(source), None::<&ICoreWebView2ExecuteScriptCompletedHandler>) };
    }
}

#[allow(deprecated)] // Same accepted v1 shell-open pattern as plugin_open_external.
fn open_external_browser(app: &tauri::AppHandle, uri: &str) {
    let Ok(url) = url::Url::parse(uri) else { return; };
    if !matches!(url.scheme(), "http" | "https") { return; }
    if let Err(error) = app.shell().open(url.to_string(), None) {
        log::debug!("unable to open external browser for plugin view: {error}");
    }
}

fn finish_download(owner: &str, id: &str, path: Option<PathBuf>) {
    let pending = CONTROLS.with(|controls| controls.borrow().get(owner)
        .and_then(|control| control.pending_downloads.borrow_mut().remove(id)));
    let Some(pending) = pending else { return; };
    let alive = pending.session.upgrade().is_some_and(|session| session.alive.load(Ordering::Acquire));
    if alive {
        if let Some(path) = path {
            unsafe {
                if pending.args.SetResultFilePath(&HSTRING::from(path.as_path())).is_ok() {
                    let _ = pending.args.SetCancel(false);
                }
            }
        }
    }
    // Cancellation is the default; dropping completes the native deferral.
}

pub fn create(window: &tauri::Window, session: Arc<Session>, declaration: crate::plugin::UiView, mut resources: HashMap<String, Resource>, profile_directory: Option<PathBuf>) -> Result<(), String> {
    let trusted = session.trusted_web;
    if trusted != profile_directory.is_some() { return Err("可信网页配置文件目录不匹配".into()); }
    let directory = profile_directory.clone().unwrap_or_else(|| std::env::temp_dir().join(format!("hypercom-view-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let directory_guard = (!trusted).then(|| EphemeralDirectory(directory.clone()));
    let mut context = wry::WebContext::new(Some(directory));
    let app = window.app_handle().clone();
    let ipc_session = session.clone();
    let ipc_app = app.clone();
    let origin = if trusted { trusted_origin(&session.binding.plugin_id, &session.binding.view_id) }
        else { format!("https://{}.plugin.invalid", uuid::Uuid::new_v4().simple()) };
    let mut entry_url = url::Url::parse(&origin).map_err(|e| e.to_string())?;
    entry_url.set_path(if trusted { &declaration.entry } else { "__host/index.html" });
    let shell_url = entry_url.to_string();
    let ipc_shell = shell_url.clone();
    let browser_args = if trusted { TRUSTED_BROWSER_ARGS } else { "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-blink-features=FileSystemAccess,FileSystemAccessLocal,FileSystemAccessOriginPrivate,FileSystem,WebUSB,WebHID,Serial,WebBluetooth,PaymentRequest,SharedWorker --force-webrtc-ip-handling-policy=disable_non_proxied_udp --disable-background-networking --proxy-server=http://127.0.0.1:9 --proxy-bypass-list=<-loopback> --host-resolver-rules=\"MAP * ~NOTFOUND\"" };
    // Host namespace cannot be substituted by a plugin declaration.
    if resources.keys().any(|path| path.starts_with("__host/")) { return Err("插件资源不得覆盖宿主命名空间".into()); }
    let binding_json = serde_json::to_string(&session.binding).map_err(|e| e.to_string())?;
    let sdk = include_str!("sdk.js")
        .replace("__HOST_TRUSTED_WEB__", if trusted { "true" } else { "false" })
        .replace("__HOST_HAS_WORKER__", if session.binding.worker_epoch > 0 { "true" } else { "false" })
        .replace("__HOST_VIEW_CONTEXT__", &binding_json);
    // The SDK belongs to the top-level page of the local origin, not to one
    // exact URL, so same-origin navigation/reload reinitializes a new document.
    let initialization = if trusted {
        format!("if (window === window.top && location.origin === {}) {{ {sdk} }}", serde_json::to_string(&origin).map_err(|e| e.to_string())?)
    } else { String::new() };
    let ipc_origin = url::Url::parse(&origin).ok().map(|url| url.origin());
    // Wry with no URL/HTML starts with an empty document. Plugin assets are not
    // reachable until every required native policy and CDP operation succeeds.
    let parent = ViewParent::new(HWND(window.hwnd().map_err(|e| e.to_string())?.0))?;
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_visible(false)
        .with_incognito(!trusted)
        .with_devtools(false)
        .with_browser_extensions_enabled(false)
        .with_additional_browser_args(browser_args)
        .with_drag_drop_handler(|_| true)
        .with_initialization_script(&initialization)
        .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
        .with_ipc_handler(move |request| {
            let uri = request.uri().to_string();
            // Trusted local pages navigate between documents on the same origin;
            // isolated mode only ever runs its single host shell document.
            let allowed = if trusted {
                url::Url::parse(&uri).ok().map(|url| Some(url.origin()) == ipc_origin).unwrap_or(false)
            } else { uri == ipc_shell };
            if allowed { super::receive(&ipc_app, &ipc_session, request.body()); }
        })
        .build_as_child(&parent).map_err(|e| e.to_string())?;
    let core = webview.webview();
    let env = webview.environment();
    if !trusted {
        let styles = declaration.styles.iter().map(|path| format!("<link rel=\"stylesheet\" href=\"/{path}\">" )).collect::<String>();
        let html = format!("<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">{styles}<script defer src=\"/__host/sdk.js\"></script><script defer src=\"/{}\"></script></head><body><div id=\"plugin-root\"></div></body></html>", declaration.entry);
        resources.insert("__host/index.html".into(), Resource { bytes: html.into_bytes(), mime: "text/html; charset=utf-8" });
        resources.insert("__host/sdk.js".into(), Resource { bytes: sdk.into_bytes(), mime: "text/javascript; charset=utf-8" });
    }
    let downloads = Rc::new(RefCell::new(HashMap::new()));
    let pending_downloads = Rc::new(RefCell::new(HashMap::new()));
    // Navigation stays inside the declared snapshot: only declared HTML pages
    // can replace the document, and only snapshot resources are served.
    let navigation_html = Rc::new(resources.keys()
        .filter(|path| { let lower = path.to_ascii_lowercase(); lower.ends_with(".html") || lower.ends_with(".htm") })
        .cloned().collect::<HashSet<_>>());
    let resources = Rc::new(resources);
    let navigation_flag = Rc::new(Cell::new(true));
    let navigation_id = Rc::new(Cell::new(None));
    let starting_navigation_id = navigation_id.clone();
    let allowed_shell = shell_url.clone();
    let navigation_origin = origin.clone();
    let navigation_app = app.clone();
    let navigation_session = session.clone();
    let new_window_origin = origin.clone();
    let new_window_session = session.clone();
    let new_window_trusted = trusted;
    let resource_session = session.clone();
    let resource_origin = origin.clone();
    let focus_session = session.clone();
    let focus_app = app.clone();
    let new_window_app = app.clone();
    unsafe {
        let settings = core.Settings().map_err(|e| e.to_string())?;
        settings.SetAreHostObjectsAllowed(false).map_err(|e| e.to_string())?;
        settings.SetAreDevToolsEnabled(false).map_err(|e| e.to_string())?;
        settings.SetAreDefaultContextMenusEnabled(false).map_err(|e| e.to_string())?;
        settings.SetAreDefaultScriptDialogsEnabled(trusted).map_err(|e| e.to_string())?;
        settings.SetIsStatusBarEnabled(false).map_err(|e| e.to_string())?;
        settings.SetIsZoomControlEnabled(false).map_err(|e| e.to_string())?;
        settings.SetIsBuiltInErrorPageEnabled(false).map_err(|e| e.to_string())?;
        // Preserve isolated copy/cut; trusted pages also receive native paste.
        settings.cast::<ICoreWebView2Settings3>().and_then(|s| s.SetAreBrowserAcceleratorKeysEnabled(trusted)).map_err(|e| e.to_string())?;
        let settings4: ICoreWebView2Settings4 = settings.cast().map_err(|e| e.to_string())?;
        settings4.SetIsPasswordAutosaveEnabled(false).map_err(|e| e.to_string())?;
        settings4.SetIsGeneralAutofillEnabled(false).map_err(|e| e.to_string())?;
        settings.cast::<ICoreWebView2Settings6>().and_then(|s| s.SetIsSwipeNavigationEnabled(false)).map_err(|e| e.to_string())?;
        webview.controller().cast::<ICoreWebView2Controller4>().and_then(|c| c.SetAllowExternalDrop(false)).map_err(|e| e.to_string())?;
        let mut token = 0;
        let download_app = app.clone();
        let download_window = window.clone();
        let download_session = Arc::downgrade(&session);
        let active_downloads = Rc::downgrade(&downloads);
        let pending_downloads_weak = Rc::downgrade(&pending_downloads);
        core.cast::<ICoreWebView2_4>().and_then(|core| core.add_DownloadStarting(&DownloadStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()); };
            args.SetCancel(true)?;
            args.SetHandled(true)?; // No default download shelf or automatic opening.
            let Some(session) = download_session.upgrade().filter(|s| trusted && s.alive.load(Ordering::Acquire)) else { return Ok(()); };
            let Some(active) = active_downloads.upgrade() else { return Ok(()); };
            let Some(pending) = pending_downloads_weak.upgrade() else { return Ok(()); };
            let id = uuid::Uuid::new_v4().to_string();
            let operation = args.DownloadOperation()?;
            let completed_id = id.clone();
            let completed_downloads = Rc::downgrade(&active);
            let mut state_token = 0;
            operation.add_StateChanged(&StateChangedEventHandler::create(Box::new(move |operation, _| {
                if let Some(operation) = operation {
                    let mut state = COREWEBVIEW2_DOWNLOAD_STATE::default();
                    operation.State(&mut state)?;
                    if state != COREWEBVIEW2_DOWNLOAD_STATE_IN_PROGRESS {
                        if let Some(active) = completed_downloads.upgrade() { active.borrow_mut().remove(&completed_id); }
                    }
                }
                Ok(())
            })), &mut state_token)?;
            let mut suggested = PWSTR::null(); args.ResultFilePath(&mut suggested)?;
            let suggested = PathBuf::from(take_string(suggested));
            let filename = suggested.file_name().and_then(|name| name.to_str()).unwrap_or("download").to_owned();
            let deferral = args.GetDeferral()?;
            active.borrow_mut().insert(id.clone(), operation);
            pending.borrow_mut().insert(id.clone(), PendingDownload {
                session: Arc::downgrade(&session), args: args.clone(), deferral,
            });
            let owner = session.binding.view_instance_id.clone();
            let app = download_app.clone();
            download_window.dialog().file().set_parent(&download_window).set_file_name(filename).save_file(move |path| {
                let path = path.and_then(|path| path.into_path().ok());
                // Only IDs and paths cross threads; apartment-bound COM objects
                // stay in the UI-thread registry until completed or retired.
                if let Err(error) = app.run_on_main_thread(move || finish_download(&owner, &id, path)) {
                    log::error!("Unable to complete plugin download dialog: {error}");
                }
            });
            Ok(())
        })), &mut token)).map_err(|e| e.to_string())?;
        core.add_NavigationStarting(&NavigationStartingEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut uri = PWSTR::null(); args.Uri(&mut uri)?;
                let uri = take_string(uri);
                let initial = navigation_flag.replace(false);
                let alive = navigation_session.alive.load(Ordering::Acquire);
                let allow = alive && if initial {
                    uri == allowed_shell
                } else if trusted {
                    local_navigation_path(&navigation_origin, &uri).is_some_and(|path| navigation_html.contains(&path))
                } else { false };
                if allow {
                    let mut id = 0; args.NavigationId(&mut id)?;
                    starting_navigation_id.set(Some(id));
                    // Retire the previous document before the new page exists.
                    let document_id = uuid::Uuid::new_v4().to_string();
                    navigation_session.begin_document(&document_id);
                    super::native_document(&navigation_app, &navigation_session, &document_id);
                } else if trusted {
                    let mut user_initiated = windows::core::BOOL(0);
                    args.IsUserInitiated(&mut user_initiated)?;
                    // External HTTP(S) links are delegated to the OS browser only
                    // for a real user action; scripts can never trigger it.
                    if user_initiated.as_bool() && external_browser_uri(&navigation_origin, &uri) {
                        open_external_browser(&navigation_app, &uri);
                    }
                }
                args.SetCancel(!allow)?;
            }
            Ok(())
        })), &mut token).map_err(|e| e.to_string())?;
        core.add_NewWindowRequested(&NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut uri = PWSTR::null(); args.Uri(&mut uri)?;
                let uri = take_string(uri);
                let mut user_initiated = windows::core::BOOL(0);
                args.IsUserInitiated(&mut user_initiated)?;
                if new_window_trusted && new_window_session.alive.load(Ordering::Acquire)
                    && user_initiated.as_bool() && external_browser_uri(&new_window_origin, &uri) {
                    open_external_browser(&new_window_app, &uri);
                }
                // Wry also denies new WebView2 windows; this handler only adds
                // the OS browser action for real user-initiated HTTP(S) links.
                args.SetHandled(true)?;
            }
            Ok(())
        })), &mut token).map_err(|e| e.to_string())?;
        core.add_FrameNavigationStarting(&NavigationStartingEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut uri = PWSTR::null(); args.Uri(&mut uri)?;
                let uri = take_string(uri);
                let allow = trusted && url::Url::parse(&uri).is_ok_and(|url| matches!(url.scheme(), "http" | "https" | "blob" | "about"));
                args.SetCancel(!allow)?;
            }
            Ok(())
        })), &mut token).map_err(|e| e.to_string())?;
        let permission_session = Arc::downgrade(&session);
        let permission_origin = origin.clone();
        core.add_PermissionRequested(&PermissionRequestedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default(); args.PermissionKind(&mut kind)?;
                let mut uri = PWSTR::null(); args.Uri(&mut uri)?;
                let uri = take_string(uri);
                let allow = trusted && kind == COREWEBVIEW2_PERMISSION_KIND_CLIPBOARD_READ
                    && uri.strip_prefix(&permission_origin).is_some_and(|path| path.starts_with('/'))
                    && permission_session.upgrade().is_some_and(|session| session.alive.load(Ordering::Acquire));
                args.SetState(if allow { COREWEBVIEW2_PERMISSION_STATE_ALLOW } else { COREWEBVIEW2_PERMISSION_STATE_DENY })?;
            }
            Ok(())
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
        let dom_core = core.clone();
        let dom_session = session.clone();
        let dom_navigation_id = navigation_id.clone();
        // DOMContentLoaded is exposed by ICoreWebView2_2, not the base interface.
        let dom_interface = core.cast::<ICoreWebView2_2>().map_err(|e| e.to_string())?;
        dom_interface.add_DOMContentLoaded(&DOMContentLoadedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut id = 0; args.NavigationId(&mut id)?;
                // Only the newest allowed top-level navigation owns the document.
                if dom_navigation_id.get() != Some(id) { return Ok(()); }
                start_document(&dom_core, &dom_session);
            }
            Ok(())
        })), &mut token).map_err(|e| e.to_string())?;
        let loading_app = app.clone();
        let loading_session = session.clone();
        core.add_NavigationCompleted(&NavigationCompletedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut id = 0; args.NavigationId(&mut id)?;
                if navigation_id.get() != Some(id) { return Ok(()); }
                let mut success = windows::core::BOOL(0); args.IsSuccess(&mut success)?;
                if !success.as_bool() {
                    let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default(); args.WebErrorStatus(&mut status)?;
                    // A deliberately denied external link is not a failed document.
                    if status != COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED {
                        super::native_error(&loading_app, &loading_session, "插件 UI 文档加载失败");
                    }
                }
            }
            Ok(())
        })), &mut token).map_err(|e| e.to_string())?;
        webview.controller().add_AcceleratorKeyPressed(&AcceleratorKeyPressedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let mut key = 0; args.VirtualKey(&mut key)?;
                let control = GetKeyState(0x11) < 0;
                let shift = GetKeyState(0x10) < 0;
                if !trusted && ((control && key == 0x56) || (shift && key == 0x2d)) { args.SetHandled(true)?; }
            }
            Ok(())
        })), &mut token).map_err(|e| e.to_string())?;
        // Trusted pages intercept only their local origin. Unknown local files
        // always receive a response; remote requests retain browser CORS/TLS.
        let filter = if trusted { format!("{origin}/*") } else { "*".into() };
        core.cast::<ICoreWebView2_22>().and_then(|c| c.AddWebResourceRequestedFilterWithRequestSourceKinds(&HSTRING::from(filter), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL, COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL)).map_err(|e| e.to_string())?;
        core.add_WebResourceRequested(&WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()); };
            // Fail closed for every matched request, including malformed paths.
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
                .and_then(|path| {
                    let path = if trusted { path.split(['?', '#']).next().unwrap_or("") } else if path.contains(['?', '#']) { return None; } else { path };
                    percent_encoding::percent_decode_str(path).decode_utf8().ok()
                });
            let resource = if resource_session.alive.load(Ordering::Acquire) && (method == "GET" || (trusted && method == "HEAD"))
                // Isolated mode may only load its declared snapshot, including
                // the host shell's own script/style subresources.
                && (trusted || source_kind == COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT
                    || path.as_deref().is_some_and(|path| resources.contains_key(path)))
                && kind != COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET
                && path.as_deref().is_some_and(|path| crate::plugin::validate_view_resource_path(path).is_ok()) {
                path.as_deref().and_then(|path| resources.get(path))
            } else { None };
            let (status, mime, bytes): (i32, &'static str, &[u8]) = match resource {
                Some(resource) => (200, resource.mime, resource.bytes.as_slice()),
                None => (403, "text/plain", b"Forbidden".as_slice()),
            };
            let stream = SHCreateMemStream(Some(if method == "HEAD" { b"" } else { bytes }));
            let policy = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin";
            let headers = HSTRING::from(if trusted {
                format!("Content-Type: {mime}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\n")
            } else {
                format!("Content-Type: {mime}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\nContent-Security-Policy: {policy}\r\nPermissions-Policy: camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=(), payment=()\r\n")
            });
            let response = env.CreateWebResourceResponse(stream.as_ref(), status, &HSTRING::from(if status == 200 { "OK" } else { "Forbidden" }), &headers)?;
            args.SetResponse(&response)?;
            Ok(())
        })), &mut token).map_err(|e| e.to_string())?;
    }
    if !trusted {
        // Native policies, not DOM patches, isolate the legacy mode.
        cdp(&core, "Page.enable", "{}")?;
        cdp(&core, "Page.setInterceptFileChooserDialog", "{\"enabled\":true}")?;
        cdp(&core, "Network.enable", "{}")?;
        cdp(&core, "Network.emulateNetworkConditions", "{\"offline\":true,\"latency\":0,\"downloadThroughput\":0,\"uploadThroughput\":0}")?;
        cdp(&core, "Network.setBlockedURLs", "{\"urls\":[\"http://*\",\"ws://*\",\"wss://*\",\"file://*\",\"ftp://*\",\"tauri://*\",\"ipc://*\",\"asset://*\"]}")?;
    }
    let control = Control { webview, parent, _context: context, _directory: directory_guard, profile_directory, downloads, pending_downloads, session: session.clone(), revision: None };
    if !session.alive.load(Ordering::Acquire) { return Err("视图创建期间已退休".into()); }
    unsafe { core.Navigate(&HSTRING::from(shell_url)).map_err(|e| e.to_string())?; }
    CONTROLS.with(|controls| { controls.borrow_mut().insert(session.binding.view_instance_id.clone(), control); });
    Ok(())
}

pub fn clear_web_data(directory: &Path) -> Result<(), String> {
    if !directory.try_exists().map_err(|e| e.to_string())? { return Ok(()); }
    if CONTROLS.with(|controls| controls.borrow().values().any(|control| control.profile_directory.as_deref() == Some(directory))) {
        return Err("清除网页数据前必须关闭插件的所有视图".into());
    }
    // Clear through the profile API instead of racing browser-process file locks
    // with remove_dir_all. No live session or profile is retained after return.
    let parent = ViewParent(unsafe {
        CreateWindowExW(WINDOW_EX_STYLE::default(), w!("STATIC"), PCWSTR::null(),
            windows::Win32::UI::WindowsAndMessaging::WS_OVERLAPPEDWINDOW,
            0, 0, 0, 0, None, None, None, None)
    }.map_err(|e| e.to_string())?);
    let mut context = wry::WebContext::new(Some(directory.to_path_buf()));
    let webview = WebViewBuilder::new_with_web_context(&mut context)
        .with_visible(false).with_incognito(false).with_devtools(false)
        .with_browser_extensions_enabled(false)
        .with_additional_browser_args(TRUSTED_BROWSER_ARGS)
        .build_as_child(&parent).map_err(|e| e.to_string())?;
    let result = (|| {
        let profile = unsafe { webview.webview().cast::<ICoreWebView2_13>()?.Profile()?.cast::<ICoreWebView2Profile2>()? };
        ClearBrowsingDataCompletedHandler::wait_for_async_operation(Box::new(move |callback| {
            unsafe { profile.ClearBrowsingDataAll(&callback)?; }
            Ok(())
        }), Box::new(|result| result))
    })().map_err(|e: webview2_com::Error| format!("清除 WebView2 网页数据失败: {e}"));
    let close = unsafe { webview.controller().Close() }.map_err(|e| e.to_string());
    result.and(close)
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

fn clipped_occlusion(occlusion: &OcclusionRect, factor: f64, origin_x: i32, origin_y: i32, width: i32, height: i32) -> Option<(i32, i32, i32, i32)> {
    let max_x = width as f64;
    let max_y = height as f64;
    let origin_x = origin_x as f64;
    let origin_y = origin_y as f64;
    let left = (occlusion.x * factor - origin_x).clamp(0.0, max_x);
    let top = (occlusion.y * factor - origin_y).clamp(0.0, max_y);
    let right = ((occlusion.x + occlusion.width) * factor - origin_x).clamp(0.0, max_x);
    let bottom = ((occlusion.y + occlusion.height) * factor - origin_y).clamp(0.0, max_y);
    if right <= left || bottom <= top { return None; }
    let left = left.floor() as i32;
    let top = top.floor() as i32;
    let right = right.ceil() as i32;
    let bottom = bottom.ceil() as i32;
    (right > left && bottom > top).then_some((left, top, right, bottom))
}

fn clear_window_region(hwnd: HWND) -> Result<(), String> {
    if unsafe { SetWindowRgn(hwnd, None, true) } == 0 { Err(Error::from_win32().to_string()) } else { Ok(()) }
}

fn apply_occlusions(hwnd: HWND, occlusions: Option<&[OcclusionRect]>, factor: f64, origin_x: i32, origin_y: i32, width: i32, height: i32) -> Result<(), String> {
    if width <= 0 || height <= 0 { return clear_window_region(hwnd); }
    let Some(occlusions) = occlusions else { return clear_window_region(hwnd); };
    if occlusions.is_empty() { return clear_window_region(hwnd); }
    let mut region = None;
    for occlusion in occlusions {
        let Some((left, top, right, bottom)) = clipped_occlusion(occlusion, factor, origin_x, origin_y, width, height) else { continue; };
        if region.is_none() { region = Some(OwnedRegion::rect(0, 0, width, height)?); }
        let base = region.as_ref().expect("region initialized");
        let cut = OwnedRegion::rect(left, top, right, bottom)?;
        let result = unsafe { CombineRgn(Some(base.raw()), Some(base.raw()), Some(cut.raw()), RGN_DIFF) };
        if result == RGN_ERROR { return Err(Error::from_win32().to_string()); }
    }
    let Some(mut region) = region else { return clear_window_region(hwnd); };
    let region = region.take();
    if unsafe { SetWindowRgn(hwnd, Some(region), true) } == 0 {
        let _ = unsafe { DeleteObject(HGDIOBJ::from(region)) };
        return Err(Error::from_win32().to_string());
    }
    Ok(())
}

pub fn update(window: &tauri::Window, id: &str, rect: Rect, occlusions: Option<Vec<OcclusionRect>>, visible: bool, revision: u64) -> Result<(), String> {
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
        let origin_x = left.round() as i32;
        let origin_y = top.round() as i32;
        control.parent.set_bounds(origin_x, origin_y, width, height)?;
        control.webview.set_bounds(wry::Rect {
            position: wry::dpi::PhysicalPosition::new(0, 0).into(),
            size: wry::dpi::PhysicalSize::new(width as u32, height as u32).into(),
        }).map_err(|e| e.to_string())?;
        control.webview.zoom(rect.zoom_percent / 100.0).map_err(|e| e.to_string())?;
        apply_occlusions(control.parent.0, occlusions.as_deref(), factor, origin_x, origin_y, width, height)?;
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
pub fn destroy(id: &str) {
    let control = CONTROLS.with(|controls| controls.borrow_mut().remove(id));
    drop(control);
}
pub fn clear() {
    let controls = CONTROLS.with(|controls| std::mem::take(&mut *controls.borrow_mut()));
    drop(controls);
}

#[cfg(test)]
mod tests {
    use super::{clipped_occlusion, EphemeralDirectory, ViewParent};
    use crate::plugin::view_runtime::OcclusionRect;
    use windows::{core::{w, PCWSTR}, Win32::{Foundation::RECT, UI::WindowsAndMessaging::{CreateWindowExW, GetClientRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOZORDER, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW}}};
    use wry::{WebContext, WebViewBuilder, WebViewExtWindows};

    #[test]
    fn trusted_origins_are_stable_and_view_scoped() {
        let origin = super::trusted_origin("com.example.plugin", "main");
        assert_eq!(origin, super::trusted_origin("com.example.plugin", "main"));
        assert_ne!(origin, super::trusted_origin("com.example.plugin", "other"));
        assert_ne!(origin, super::trusted_origin("com.example.other", "main"));
        assert_ne!(super::trusted_origin("a.b", "cd"), super::trusted_origin("a.bc", "d"));
        let url = url::Url::parse(&origin).unwrap();
        assert_eq!(url.scheme(), "https");
        assert!(url.host_str().unwrap().split('.').all(|label| label.len() <= 63));
    }

    #[test]
    fn navigation_allows_only_same_origin_html_and_remote_external_links() {
        let origin = super::trusted_origin("com.example.plugin", "main");
        assert_eq!(super::local_navigation_path(&origin, &format!("{origin}/ui/page.html?a=1#b")).as_deref(), Some("ui/page.html"));
        assert_eq!(super::local_navigation_path(&origin, &format!("{origin}/ui/page.htm")).as_deref(), Some("ui/page.htm"));
        assert_eq!(super::local_navigation_path(&origin, &format!("{origin}/ui/app.js")), None);
        assert_eq!(super::local_navigation_path(&origin, &format!("{origin}/ui/..%2fsecret.html")), None);
        assert_eq!(super::local_navigation_path(&origin, "https://example.com/ui/page.html"), None);
        assert!(super::external_browser_uri(&origin, "https://example.com/a"));
        assert!(super::external_browser_uri(&origin, "http://example.com/a"));
        assert!(!super::external_browser_uri(&origin, &format!("{origin}/ui/page.html")));
        assert!(!super::external_browser_uri(&origin, "mailto:dev@example.com"));
    }

    #[test]
    fn clearing_absent_profile_does_not_create_it() {
        let directory = std::env::temp_dir().join(format!("hypercom-missing-profile-{}", uuid::Uuid::new_v4()));
        super::clear_web_data(&directory).unwrap();
        assert!(!directory.exists());
    }

    #[test]
    fn clips_occlusions_to_child_and_rounds_edges_outward() {
        let fractional = OcclusionRect { x: 10.9, y: 20.9, width: 1.0, height: 1.0 };
        assert_eq!(clipped_occlusion(&fractional, 1.5, 15, 30, 120, 100), Some((1, 1, 3, 3)));
        let clipped_parent = OcclusionRect { x: 0.9, y: 0.9, width: 1.0, height: 1.0 };
        assert_eq!(clipped_occlusion(&clipped_parent, 1.5, 0, 0, 120, 100), Some((1, 1, 3, 3)));
        let outside = OcclusionRect { x: 500.0, y: 500.0, width: 5.0, height: 5.0 };
        assert_eq!(clipped_occlusion(&outside, 1.5, 15, 30, 120, 100), None);
    }

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
