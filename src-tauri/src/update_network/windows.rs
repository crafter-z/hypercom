use super::{bypasses, manual_proxy, proxy_url};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    ffi::c_void,
    net::{TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, LazyLock,
    },
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{GetLastError, GlobalFree, ERROR_FILE_NOT_FOUND, ERROR_IO_PENDING},
    Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpCreateProxyResolver, WinHttpFreeProxyResult,
        WinHttpGetIEProxyConfigForCurrentUser, WinHttpGetProxyForUrlEx, WinHttpGetProxyResult,
        WinHttpOpen, WinHttpSetOption, WinHttpSetStatusCallback, WINHTTP_ACCESS_TYPE_NO_PROXY,
        WINHTTP_ASYNC_RESULT, WINHTTP_AUTOPROXY_AUTO_DETECT, WINHTTP_AUTOPROXY_CONFIG_URL,
        WINHTTP_AUTOPROXY_OPTIONS, WINHTTP_AUTO_DETECT_TYPE_DHCP, WINHTTP_AUTO_DETECT_TYPE_DNS_A,
        WINHTTP_CALLBACK_FLAG_GETPROXYFORURL_COMPLETE, WINHTTP_CALLBACK_FLAG_REQUEST_ERROR,
        WINHTTP_CALLBACK_STATUS_GETPROXYFORURL_COMPLETE, WINHTTP_CALLBACK_STATUS_REQUEST_ERROR,
        WINHTTP_CURRENT_USER_IE_PROXY_CONFIG, WINHTTP_FLAG_ASYNC, WINHTTP_INTERNET_SCHEME_HTTP,
        WINHTTP_INTERNET_SCHEME_HTTPS, WINHTTP_INTERNET_SCHEME_SOCKS, WINHTTP_OPTION_CONTEXT_VALUE,
        WINHTTP_PROXY_RESULT,
    },
};

const PROXY_TIMEOUT: Duration = Duration::from_secs(10);
type Route = Result<Option<url::Url>, String>;
type RouteList = Result<Vec<Option<url::Url>>, String>;
type Completion = mpsc::SyncSender<RouteList>;
static PENDING: LazyLock<Mutex<HashMap<usize, Completion>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: AtomicUsize = AtomicUsize::new(1);

struct Handle(*mut c_void);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            WinHttpCloseHandle(self.0);
        }
    }
}

struct UserConfig(WINHTTP_CURRENT_USER_IE_PROXY_CONFIG);
impl Drop for UserConfig {
    fn drop(&mut self) {
        unsafe {
            GlobalFree(self.0.lpszAutoConfigUrl.cast());
            GlobalFree(self.0.lpszProxy.cast());
            GlobalFree(self.0.lpszProxyBypass.cast());
        }
    }
}

// These strings are owned by WinHTTP and remain valid until their enclosing
// UserConfig/ProxyResult is freed. No callback stores borrowed pointers.
unsafe fn wide_string(value: *const u16) -> String {
    if value.is_null() {
        return String::new();
    }
    let mut length = 0;
    while *value.add(length) != 0 {
        length += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(value, length))
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[derive(Default)]
struct Settings {
    auto_detect: bool,
    pac: String,
    proxy: String,
    bypass: String,
}
impl Settings {
    fn load() -> Result<Self, String> {
        let mut config = UserConfig(WINHTTP_CURRENT_USER_IE_PROXY_CONFIG::default());
        if unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut config.0) } == 0 {
            let error = unsafe { GetLastError() };
            return if error == ERROR_FILE_NOT_FOUND {
                Ok(Self::default())
            } else {
                Err(format!(
                    "reading Windows proxy configuration failed: {error}"
                ))
            };
        }
        Ok(Self {
            auto_detect: config.0.fAutoDetect != 0,
            pac: unsafe { wide_string(config.0.lpszAutoConfigUrl) },
            proxy: unsafe { wide_string(config.0.lpszProxy) },
            bypass: unsafe { wide_string(config.0.lpszProxyBypass) },
        })
    }
}

fn env_value(names: &[&str]) -> Option<String> {
    names
        .iter()
        .find_map(|name| std::env::var(name).ok())
        .filter(|value| !value.trim().is_empty())
}
struct Environment {
    http: Option<String>,
    https: Option<String>,
    all: Option<String>,
    bypass: String,
}
impl Environment {
    fn load() -> Self {
        Self {
            http: env_value(&["HTTP_PROXY", "http_proxy"]),
            https: env_value(&["HTTPS_PROXY", "https_proxy"]),
            all: env_value(&["ALL_PROXY", "all_proxy"]),
            bypass: env_value(&["NO_PROXY", "no_proxy"]).unwrap_or_default(),
        }
    }
    fn select(&self, url: &url::Url) -> Option<Route> {
        let uri = url.as_str().parse::<http::Uri>().ok()?;
        let bypass = hyper_util::client::proxy::matcher::Matcher::builder()
            .all("http://proxy.invalid")
            .no(&self.bypass)
            .build();
        if bypass.intercept(&uri).is_none() {
            return Some(Ok(None));
        }
        let explicit = match url.scheme() {
            "http" => self.http.as_ref(),
            "https" => self.https.as_ref(),
            _ => None,
        }
        .or(self.all.as_ref());
        explicit.map(|value| proxy_url(value, false).map(Some))
    }
}

pub(super) struct ProxyRouter {
    settings: Settings,
    environment: Environment,
    // Requests are sequential within an updater. Prepare full URL before each
    // initial/redirect request; custom proxy receives only its origin in reqwest.
    routes: Mutex<HashMap<String, Option<url::Url>>>,
}
impl ProxyRouter {
    pub(super) fn new() -> Result<Self, String> {
        Ok(Self {
            settings: Settings::load()?,
            environment: Environment::load(),
            routes: Mutex::new(HashMap::new()),
        })
    }
    pub(super) fn prepare(&self, url: &url::Url) -> Result<(), String> {
        let route = if let Some(route) = self.environment.select(url) {
            route?
        } else if !self.settings.pac.is_empty() || self.settings.auto_detect {
            match resolve_auto(&self.settings, url, PROXY_TIMEOUT) {
                Ok(routes) => select_route(routes, PROXY_TIMEOUT)?,
                Err(error) if !self.settings.proxy.is_empty() => {
                    log::warn!("[update] automatic proxy resolution failed; using configured manual proxy: {error}");
                    self.manual(url)?
                }
                Err(error) if self.settings.pac.is_empty() => {
                    // WPAD detection failing on a network with no PAC is normal;
                    // this follows the Windows no-manual-proxy DIRECT policy.
                    log::debug!("[update] no WPAD proxy found: {error}");
                    None
                }
                Err(error) => return Err(error),
            }
        } else {
            self.manual(url)?
        };
        self.routes
            .lock()
            .insert(url.origin().ascii_serialization(), route);
        Ok(())
    }
    fn manual(&self, url: &url::Url) -> Route {
        if bypasses(&self.settings.bypass, url) {
            return Ok(None);
        }
        manual_proxy(&self.settings.proxy, url.scheme())
    }
    pub(super) fn prepared(&self, url: &url::Url) -> Option<url::Url> {
        self.routes
            .lock()
            .get(&url.origin().ascii_serialization())
            .cloned()
            .flatten()
    }
}

struct ProxyResult(WINHTTP_PROXY_RESULT);
impl Drop for ProxyResult {
    fn drop(&mut self) {
        unsafe {
            WinHttpFreeProxyResult(&mut self.0);
        }
    }
}
unsafe fn resolved_route(handle: *mut c_void) -> RouteList {
    let mut result = ProxyResult(WINHTTP_PROXY_RESULT::default());
    let error = WinHttpGetProxyResult(handle, &mut result.0);
    if error != 0 {
        return Err(format!(
            "reading Windows automatic proxy result failed: {error}"
        ));
    }
    if result.0.cEntries == 0 {
        return Ok(vec![None]);
    }
    if result.0.pEntries.is_null() {
        return Err("Windows proxy result has no entries".into());
    }
    let entries = std::slice::from_raw_parts(result.0.pEntries, result.0.cEntries as usize);
    let mut routes = Vec::with_capacity(entries.len());
    for entry in entries {
        if entry.fProxy == 0 || entry.fBypass != 0 {
            routes.push(None);
            break;
        }
        let scheme = match entry.ProxyScheme {
            WINHTTP_INTERNET_SCHEME_HTTP => "http",
            WINHTTP_INTERNET_SCHEME_HTTPS => "https",
            WINHTTP_INTERNET_SCHEME_SOCKS => "socks4a",
            _ => continue,
        };
        let host = wide_string(entry.pwszProxy);
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host
        };
        if let Ok(proxy) = proxy_url(&format!("{scheme}://{host}:{}", entry.ProxyPort), false) {
            routes.push(Some(proxy));
        }
    }
    if routes.is_empty() {
        Err("Windows automatic proxy returned no supported route".into())
    } else {
        Ok(routes)
    }
}
// PAC order is authoritative. For multi-route lists, test transport availability
// before committing the route; never invent DIRECT or bypass a proxy's HTTP/TLS
// authentication failure. DNS and connection probes share a bounded deadline.
fn select_route(mut routes: Vec<Option<url::Url>>, timeout: Duration) -> Route {
    if routes.len() == 1 {
        return Ok(routes.remove(0));
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let deadline = Instant::now() + timeout;
        let result = (|| {
            for route in routes {
                let Some(proxy) = route else {
                    return Ok(None);
                };
                let Some(host) = proxy.host_str() else {
                    continue;
                };
                let port = proxy.port_or_known_default().unwrap_or(1080);
                let addresses = match (host, port).to_socket_addrs() {
                    Ok(addresses) => addresses,
                    Err(_) => continue,
                };
                for address in addresses {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Err("PAC proxy selection timed out".into());
                    }
                    if TcpStream::connect_timeout(&address, remaining.min(Duration::from_secs(2)))
                        .is_ok()
                    {
                        return Ok(Some(proxy));
                    }
                }
            }
            Err("all PAC proxy routes are unavailable".into())
        })();
        let _ = sender.send(result);
    });
    receiver
        .recv_timeout(timeout)
        .map_err(|_| "PAC proxy selection timed out".to_string())?
}

unsafe extern "system" fn proxy_callback(
    handle: *mut c_void,
    context: usize,
    status: u32,
    information: *mut c_void,
    length: u32,
) {
    if !matches!(
        status,
        WINHTTP_CALLBACK_STATUS_GETPROXYFORURL_COMPLETE | WINHTTP_CALLBACK_STATUS_REQUEST_ERROR
    ) {
        return;
    }
    // Hold the registry lock while reading the resolver result. A timeout must
    // acquire it before closing the handle, so cancellation cannot race this read.
    let mut pending = PENDING.lock();
    let Some(sender) = pending.remove(&context) else {
        return;
    };
    let result = if status == WINHTTP_CALLBACK_STATUS_GETPROXYFORURL_COMPLETE {
        resolved_route(handle)
    } else if !information.is_null()
        && length as usize >= std::mem::size_of::<WINHTTP_ASYNC_RESULT>()
    {
        let error = (*(information.cast::<WINHTTP_ASYNC_RESULT>())).dwError;
        Err(format!(
            "Windows automatic proxy resolution failed: {error}"
        ))
    } else {
        Err("Windows automatic proxy resolution failed without error details".into())
    };
    let _ = sender.send(result);
}

fn resolve_auto(settings: &Settings, url: &url::Url, timeout: Duration) -> RouteList {
    let user_agent = wide("hypercom-updater");
    let session = Handle(unsafe {
        WinHttpOpen(
            user_agent.as_ptr(),
            WINHTTP_ACCESS_TYPE_NO_PROXY,
            std::ptr::null(),
            std::ptr::null(),
            WINHTTP_FLAG_ASYNC,
        )
    });
    if session.0.is_null() {
        return Err(format!(
            "opening Windows proxy session failed: {}",
            unsafe { GetLastError() }
        ));
    }
    let previous = unsafe {
        WinHttpSetStatusCallback(
            session.0,
            Some(proxy_callback),
            WINHTTP_CALLBACK_FLAG_GETPROXYFORURL_COMPLETE | WINHTTP_CALLBACK_FLAG_REQUEST_ERROR,
            0,
        )
    };
    if previous.is_some_and(|callback| callback as usize == usize::MAX) {
        return Err(format!(
            "registering Windows proxy callback failed: {}",
            unsafe { GetLastError() }
        ));
    }
    let mut resolver_raw = std::ptr::null_mut();
    let error = unsafe { WinHttpCreateProxyResolver(session.0, &mut resolver_raw) };
    if error != 0 {
        return Err(format!("creating Windows proxy resolver failed: {error}"));
    }
    let resolver = Handle(resolver_raw);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    if unsafe {
        WinHttpSetOption(
            resolver.0,
            WINHTTP_OPTION_CONTEXT_VALUE,
            (&id as *const usize).cast(),
            std::mem::size_of::<usize>() as u32,
        )
    } == 0
    {
        return Err(format!(
            "setting Windows proxy context failed: {}",
            unsafe { GetLastError() }
        ));
    }
    let (sender, receiver) = mpsc::sync_channel(1);
    PENDING.lock().insert(id, sender);
    let pac = wide(&settings.pac);
    let target = wide(url.as_str());
    let options = WINHTTP_AUTOPROXY_OPTIONS {
        dwFlags: if settings.pac.is_empty() {
            WINHTTP_AUTOPROXY_AUTO_DETECT
        } else {
            WINHTTP_AUTOPROXY_CONFIG_URL
        },
        dwAutoDetectFlags: WINHTTP_AUTO_DETECT_TYPE_DHCP | WINHTTP_AUTO_DETECT_TYPE_DNS_A,
        lpszAutoConfigUrl: if settings.pac.is_empty() {
            std::ptr::null()
        } else {
            pac.as_ptr()
        },
        fAutoLogonIfChallenged: 1,
        ..Default::default()
    };
    let error = unsafe { WinHttpGetProxyForUrlEx(resolver.0, target.as_ptr(), &options, id) };
    if error != ERROR_IO_PENDING {
        PENDING.lock().remove(&id);
        return Err(format!(
            "starting Windows automatic proxy resolution failed: {error}"
        ));
    }
    let result = receiver
        .recv_timeout(timeout)
        .map_err(|_| "Windows automatic proxy resolution timed out".to_string());
    PENDING.lock().remove(&id);
    // Closing the asynchronous resolver cancels outstanding work. Context is an
    // integer registry key, never a pointer, so late callbacks cannot access freed memory.
    result?
}

#[cfg(test)]
mod tests {
    use super::{resolve_auto, select_route, Environment, Settings};
    use std::{
        io::{Read, Write},
        net::TcpListener,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::Duration,
    };

    #[test]
    fn explicit_environment_proxy_and_bypass_take_priority() {
        let env = Environment {
            http: None,
            https: Some("http://environment:9000".into()),
            all: None,
            bypass: "internal.example".into(),
        };
        let url = |raw| url::Url::parse(raw).unwrap();
        assert_eq!(
            env.select(&url("https://github.com/path"))
                .unwrap()
                .unwrap()
                .unwrap()
                .host_str(),
            Some("environment")
        );
        assert_eq!(
            env.select(&url("https://internal.example/path"))
                .unwrap()
                .unwrap(),
            None
        );
        assert!(env.select(&url("http://github.com/path")).is_none());
    }

    #[test]
    fn pac_routes_full_paths_and_cancels_a_stalled_script_download() {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = server.local_addr().unwrap();
        server.set_nonblocking(true).unwrap();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let worker = std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                let (mut stream, _) = match server.accept() {
                    Ok(stream) => stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("PAC server accept failed: {error}"),
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut request = [0; 4096];
                let count = stream.read(&mut request).unwrap();
                if String::from_utf8_lossy(&request[..count]).contains("/stall.pac") {
                    std::thread::sleep(Duration::from_millis(300));
                } else {
                    let script = "function FindProxyForURL(url,host) { if (url.indexOf('/proxied') >= 0) return 'PROXY 127.0.0.1:7890'; return 'DIRECT'; }";
                    let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/x-ns-proxy-autoconfig\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{script}", script.len());
                    let _ = stream.write_all(response.as_bytes());
                }
            }
        });
        let settings = Settings {
            pac: format!("http://{address}/route.pac"),
            ..Default::default()
        };
        assert_eq!(
            select_route(
                resolve_auto(
                    &settings,
                    &url::Url::parse("http://github.com/proxied").unwrap(),
                    Duration::from_secs(5)
                )
                .unwrap(),
                Duration::from_secs(1)
            )
            .unwrap()
            .unwrap()
            .port(),
            Some(7890)
        );
        assert_eq!(
            select_route(
                resolve_auto(
                    &settings,
                    &url::Url::parse("http://github.com/direct").unwrap(),
                    Duration::from_secs(5)
                )
                .unwrap(),
                Duration::from_secs(1)
            )
            .unwrap(),
            None
        );
        let settings = Settings {
            pac: format!("http://{address}/stall.pac"),
            ..Default::default()
        };
        assert!(resolve_auto(
            &settings,
            &url::Url::parse("https://github.com/").unwrap(),
            Duration::from_millis(50)
        )
        .unwrap_err()
        .contains("timed out"));
        stopped.store(true, Ordering::Relaxed);
        worker.join().unwrap();
    }

    #[test]
    fn pac_fails_over_unavailable_primary_without_inventing_direct() {
        let backup = TcpListener::bind("127.0.0.1:0").unwrap();
        let available =
            url::Url::parse(&format!("http://{}", backup.local_addr().unwrap())).unwrap();
        let unused = TcpListener::bind("127.0.0.1:0").unwrap();
        let missing = url::Url::parse(&format!("http://{}", unused.local_addr().unwrap())).unwrap();
        drop(unused);
        assert_eq!(
            select_route(
                vec![Some(missing.clone()), Some(available.clone()), None],
                Duration::from_secs(5)
            )
            .unwrap(),
            Some(available)
        );
        assert_eq!(
            select_route(vec![Some(missing.clone()), None], Duration::from_secs(5)).unwrap(),
            None
        );
        assert!(select_route(
            vec![Some(missing.clone()), Some(missing)],
            Duration::from_secs(5)
        )
        .is_err());
    }
}
