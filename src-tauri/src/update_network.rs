//! Update-only HTTP policy. Windows resolves the active user's proxy per URL,
//! including redirects; other platforms keep reqwest's native/environment policy.
use std::time::Duration;

pub(crate) const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[cfg(windows)]
mod windows;

#[derive(Clone)]
pub(crate) struct UpdateNetwork {
    #[cfg(windows)]
    router: std::sync::Arc<windows::ProxyRouter>,
}

impl UpdateNetwork {
    pub(crate) async fn new() -> Result<Self, String> {
        #[cfg(windows)]
        {
            let router = tokio::task::spawn_blocking(windows::ProxyRouter::new)
                .await
                .map_err(|e| format!("proxy configuration task failed: {e}"))??;
            Ok(Self {
                router: std::sync::Arc::new(router),
            })
        }
        #[cfg(not(windows))]
        {
            Ok(Self {})
        }
    }

    // Resolve the full initial URL before reqwest reduces it to an origin in
    // Proxy::custom. Redirects prepare the next full URL before it is requested.
    pub(crate) async fn prepare(&self, url: &url::Url) -> Result<(), String> {
        #[cfg(windows)]
        {
            let router = self.router.clone();
            let url = url.clone();
            tokio::task::spawn_blocking(move || router.prepare(&url))
                .await
                .map_err(|e| format!("proxy resolution task failed: {e}"))?
        }
        #[cfg(not(windows))]
        {
            let _ = url;
            Ok(())
        }
    }

    pub(crate) fn configure(&self, builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
        let builder = builder
            .connect_timeout(CONNECT_TIMEOUT)
            .read_timeout(READ_TIMEOUT);
        #[cfg(windows)]
        {
            let proxy_router = self.router.clone();
            let redirect_router = self.router.clone();
            builder
                .no_proxy()
                .pool_max_idle_per_host(0)
                .proxy(reqwest::Proxy::custom(move |url| {
                    proxy_router.prepared(url)
                }))
                .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                    if attempt.previous().len() >= 10 {
                        return attempt.error("too many update redirects");
                    }
                    if attempt.url().scheme() != "https"
                        && attempt.previous().iter().any(|url| url.scheme() == "https")
                    {
                        return attempt.error("update redirect would downgrade HTTPS");
                    }
                    match redirect_router.prepare(attempt.url()) {
                        Ok(()) => attempt.follow(),
                        Err(error) => attempt.error(error),
                    }
                }))
        }
        #[cfg(not(windows))]
        {
            builder.redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 {
                    attempt.error("too many update redirects")
                } else if attempt.url().scheme() != "https"
                    && attempt.previous().iter().any(|url| url.scheme() == "https")
                {
                    attempt.error("update redirect would downgrade HTTPS")
                } else {
                    attempt.follow()
                }
            }))
        }
    }

    pub(crate) fn check_client(&self) -> Result<reqwest::Client, String> {
        self.configure(reqwest::Client::builder())
            .timeout(CHECK_TIMEOUT)
            .build()
            .map_err(|e| format!("update HTTP client init failed: {e}"))
    }
}

#[cfg(any(windows, test))]
fn proxy_url(raw: &str, socks: bool) -> Result<url::Url, String> {
    let raw = raw.trim();
    let url = if raw.contains("://") {
        url::Url::parse(raw)
    } else {
        url::Url::parse(&format!(
            "{}://{raw}",
            if socks { "socks5h" } else { "http" }
        ))
    }
    .map_err(|e| format!("invalid update proxy: {e}"))?;
    if url.host_str().is_none()
        || !matches!(
            url.scheme(),
            "http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h"
        )
    {
        return Err("unsupported update proxy address or protocol".into());
    }
    Ok(url)
}

#[cfg(any(windows, test))]
fn manual_proxy(raw: &str, scheme: &str) -> Result<Option<url::Url>, String> {
    let mut generic = None;
    let mut socks = None;
    for entry in raw
        .split(';')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        if let Some((protocol, address)) = entry.split_once('=') {
            if protocol.eq_ignore_ascii_case(scheme) {
                return proxy_url(address, false).map(Some);
            }
            if protocol.eq_ignore_ascii_case("socks") {
                socks = Some(address);
            }
        } else {
            generic = Some(entry);
        }
    }
    match generic {
        Some(address) => proxy_url(address, false).map(Some),
        None => socks.map(|address| proxy_url(address, true)).transpose(),
    }
}

#[cfg(any(windows, test))]
fn wildcard_match(pattern: &str, value: &str) -> bool {
    let (mut p, mut v, mut star, mut retry) = (0, 0, None, 0);
    let (pattern, value) = (pattern.as_bytes(), value.as_bytes());
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p].eq_ignore_ascii_case(&value[v])) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            retry = v;
        } else if let Some(pos) = star {
            retry += 1;
            v = retry;
            p = pos + 1;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

#[cfg(any(windows, test))]
fn bypasses(raw: &str, url: &url::Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    raw.split(';').map(str::trim).any(|rule| {
        if rule.eq_ignore_ascii_case("<local>") {
            !host.contains('.') && !host.contains(':') && host.parse::<std::net::IpAddr>().is_err()
        } else {
            wildcard_match(rule, host)
                || wildcard_match(
                    rule,
                    &format!("{host}:{}", url.port_or_known_default().unwrap_or(0)),
                )
        }
    })
}

#[cfg(test)]
mod tests {
    use super::{bypasses, manual_proxy};

    #[test]
    fn protocol_specific_proxies_do_not_silently_become_direct() {
        let raw = "http=127.0.0.1:7890;https=127.0.0.1:7891";
        assert_eq!(
            manual_proxy(raw, "http").unwrap().unwrap().port(),
            Some(7890)
        );
        assert_eq!(
            manual_proxy(raw, "https").unwrap().unwrap().port(),
            Some(7891)
        );
        assert_eq!(manual_proxy("http=proxy:80", "https").unwrap(), None);
        assert_eq!(
            manual_proxy("socks=proxy:1080", "https")
                .unwrap()
                .unwrap()
                .scheme(),
            "socks5h"
        );
        assert!(manual_proxy("https=", "https").is_err());
    }

    #[test]
    fn windows_bypass_respects_wildcards_local_hosts_and_ports() {
        let url = |value| url::Url::parse(value).unwrap();
        assert!(bypasses("<local>;*.example.com", &url("https://printer/")));
        assert!(bypasses(
            "<local>;*.example.com",
            &url("https://sub.example.com/")
        ));
        assert!(!bypasses(
            "<local>;*.example.com",
            &url("https://notexample.com/")
        ));
        assert!(!bypasses("<local>", &url("https://127.0.0.1/")));
        assert!(bypasses("github.com:443", &url("https://github.com/")));
        assert!(!bypasses("github.com:443", &url("http://github.com/")));
    }
}
