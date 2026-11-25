//! Shared production WebResourceRequested admission and COM response adapter.
use std::{
    collections::HashMap,
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use webview2_com::{Microsoft::Web::WebView2::Win32::*, WebResourceRequestedEventHandler};
use windows::{
    core::{Interface, HSTRING, PWSTR},
    Win32::{System::Com::IStream, UI::Shell::SHCreateMemStream},
};

use super::super::resources::{Resource, ResourceContents};

const ISOLATED_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-same-origin";

/// Isolated-view browser features. Clipboard is the only plugin-grantable
/// exception; every other listed feature stays denied for the document.
fn isolated_permissions(clipboard: bool) -> String {
    let clipboard = if clipboard {
        "clipboard-read=(self), clipboard-write=(self)"
    } else {
        "clipboard-read=(), clipboard-write=()"
    };
    format!("camera=(), microphone=(), geolocation=(), {clipboard}, usb=(), serial=(), hid=(), bluetooth=(), display-capture=(), payment=()")
}

pub(super) struct ResourceServer {
    pub origin: String,
    pub trusted: bool,
    /// Effective plugin-level `clipboard` grant frozen for this isolated view at
    /// creation. Ignored for trusted pages, which do not receive this header.
    pub clipboard: bool,
    pub resources: Rc<HashMap<String, Resource>>,
    pub alive: Arc<AtomicBool>,
}

pub(super) struct SelectedResponse {
    pub status: i32,
    pub mime: &'static str,
    pub length: u64,
    pub body: Option<IStream>,
}

impl SelectedResponse {
    fn forbidden() -> Self {
        Self {
            status: 403,
            mime: "text/plain",
            length: 0,
            body: None,
        }
    }
    fn ok(mime: &'static str, length: u64, body: Option<IStream>) -> Self {
        Self {
            status: 200,
            mime,
            length,
            body,
        }
    }
}

impl ResourceServer {
    pub fn select(
        &self,
        uri: &str,
        method: &str,
        kind: COREWEBVIEW2_WEB_RESOURCE_CONTEXT,
        source_kind: COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS,
    ) -> SelectedResponse {
        if !self.alive.load(Ordering::Acquire)
            || !(method == "GET" || (self.trusted && method == "HEAD"))
            || kind == COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET
        {
            return SelectedResponse::forbidden();
        }
        let path = uri
            .strip_prefix(self.origin.as_str())
            .and_then(|path| path.strip_prefix('/'))
            .and_then(|path| {
                let path = if self.trusted {
                    path.split(['?', '#']).next().unwrap_or("")
                } else if path.contains(['?', '#']) {
                    return None;
                } else {
                    path
                };
                percent_encoding::percent_decode_str(path)
                    .decode_utf8()
                    .ok()
            });
        let Some(path) =
            path.filter(|path| crate::plugin::validate_view_resource_path(path).is_ok())
        else {
            return SelectedResponse::forbidden();
        };
        if !self.trusted
            && source_kind != COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT
            && !self.resources.contains_key(path.as_ref())
        {
            return SelectedResponse::forbidden();
        }
        let Some(resource) = self.resources.get(path.as_ref()) else {
            return SelectedResponse::forbidden();
        };
        let response = match &resource.contents {
            ResourceContents::Declared(declared) => {
                // HEAD also verifies the actual file, but does not retain an
                // open handle. A failed open is never a successful empty body.
                let Ok(opened) = declared.open() else {
                    return SelectedResponse::forbidden();
                };
                let length = opened.len;
                let body = (method == "GET").then(|| {
                    hypercom_plugin_resource_stream::from_file(
                        opened.file,
                        length,
                        Arc::clone(&self.alive),
                    )
                });
                SelectedResponse::ok(resource.mime, length, body)
            }
            ResourceContents::Generated(bytes) => {
                let body = if method == "GET" {
                    let Some(stream) = (unsafe { SHCreateMemStream(Some(bytes)) }) else {
                        return SelectedResponse::forbidden();
                    };
                    Some(stream)
                } else {
                    None
                };
                SelectedResponse::ok(resource.mime, bytes.len() as u64, body)
            }
        };
        if self.alive.load(Ordering::Acquire) {
            response
        } else {
            SelectedResponse::forbidden()
        }
    }

    fn response(
        &self,
        env: &ICoreWebView2Environment,
        response: &SelectedResponse,
    ) -> windows::core::Result<ICoreWebView2WebResourceResponse> {
        let mut headers = format!("Content-Type: {}\r\nContent-Length: {}\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-store\r\n", response.mime, response.length);
        if !self.trusted {
            headers.push_str(&format!("Content-Security-Policy: {ISOLATED_CSP}\r\nPermissions-Policy: {}\r\n", isolated_permissions(self.clipboard)));
        }
        unsafe {
            env.CreateWebResourceResponse(
                response.body.as_ref(),
                response.status,
                &HSTRING::from(if response.status == 200 {
                    "OK"
                } else {
                    "Forbidden"
                }),
                &HSTRING::from(headers),
            )
        }
    }

    /// This is the only WebView2 registration for plugin resources. The native
    /// smoke uses the same filter, selector, file stream and response creation.
    pub fn install(
        self,
        core: &ICoreWebView2,
        env: ICoreWebView2Environment,
    ) -> windows::core::Result<()> {
        // Trusted pages only intercept their local origin; isolated pages
        // handle every request so an unknown path never falls back to network.
        let filter = if self.trusted {
            format!("{}/*", self.origin)
        } else {
            "*".into()
        };
        let mut token = 0;
        unsafe {
            core.cast::<ICoreWebView2_22>()?
                .AddWebResourceRequestedFilterWithRequestSourceKinds(
                    &HSTRING::from(filter),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL,
                )?;
            core.add_WebResourceRequested(
                &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                    let Some(args) = args else {
                        return Ok(());
                    };
                    // Fail closed even if extracting method, URI or request source fails.
                    args.SetResponse(&self.response(&env, &SelectedResponse::forbidden())?)?;
                    let request = args.Request()?;
                    let mut uri = PWSTR::null();
                    request.Uri(&mut uri)?;
                    let uri = super::take_string(uri);
                    let mut method = PWSTR::null();
                    request.Method(&mut method)?;
                    let method = super::take_string(method);
                    let mut kind = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
                    args.ResourceContext(&mut kind)?;
                    let mut source_kind = COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL;
                    args.cast::<ICoreWebView2WebResourceRequestedEventArgs2>()?
                        .RequestedSourceKind(&mut source_kind)?;
                    let response = self.select(&uri, &method, kind, source_kind);
                    if response.status == 200 {
                        args.SetResponse(&self.response(&env, &response)?)?;
                    }
                    Ok(())
                })),
                &mut token,
            )?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::isolated_permissions;

    #[test]
    fn clipboard_policy_follows_the_plugin_grant() {
        let denied = isolated_permissions(false);
        assert!(denied.contains("clipboard-read=(), clipboard-write=()"));
        assert!(!denied.contains("clipboard-read=(self)"));
        let granted = isolated_permissions(true);
        assert!(granted.contains("clipboard-read=(self), clipboard-write=(self)"));
        assert!(!granted.contains("clipboard-read=()"));
        // Non-clipboard features stay denied in both modes.
        for policy in [denied, granted] {
            assert!(policy.contains("camera=()"));
            assert!(policy.contains("serial=()"));
            assert!(!policy.contains("clipboard-read=*"));
        }
    }
}
