/**
 * 插件 HTTP 外联命令（流式、可取消）。
 *
 * 设计要点：
 * - 唯一出站通道，权限仍是 `http:request`；manifest `http.urlWhitelist` 是**可选**
 *   作用域：缺失或空 = 不限制，非空才逐 URL（含每个重定向目标）校验。
 * - 打开/读取/取消三个命令共享一个注册表：requestId 在 open 的同步准入阶段登记，
 *   因此「连接仍在挂起时取消」也能命中条目并打断 send。
 * - 每个请求一把异步 state 锁 + watch 取消通道；全局 map 锁只在插入/查找/删除时持有，
 *   绝不跨网络 await。
 * - 读取是拉取式的：单次最多 64 KiB 传输块，总量无业务上限，剩余字节原样保留。
 * - 显式 timeout 是**整个请求**截止时间（打开 + 所有读取），不是每块重置；
 *   缺省/0 表示无总截止。
 * - 重定向由本模块**手动**跟随（`Policy::none()` + `referer(false)`）：最多 10 跳，
 *   每一跳都重新校验 http.urlWhitelist 与 http/https 协议；跨源跳转剥离凭据头；
 *   301/302 仅 POST 改 GET；303 除 GET/HEAD 外改 GET；仅在改写时丢弃 body
 *   与 body representation headers，PUT/DELETE/GET with body 保持原方法与 body；
 *   307/308 始终保留方法与 body。
 * - `reqwest::Client` 进程级复用（按插件代理配置分桶），每次请求只覆盖 deadline。
 */
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use base64::Engine as _;
use reqwest::header::{HeaderName, HeaderValue, LOCATION};
use reqwest::{Client, Method};
use tauri::State;
use tokio::sync::{watch, Mutex as AsyncMutex};
use url::Url;

use super::CommandError;
use crate::plugin;
use crate::AppState;

/// 单次 read 返回的传输块上限（协议层，不是业务内容上限）。
const TRANSPORT_CHUNK_BYTES: usize = 64 * 1024;
/// 标准重定向跳数上限。
const MAX_REDIRECTS: usize = 10;
/// 仅用于保护运行时的全局（跨插件）并发注册上限，不是内容上限。
const MAX_CONCURRENT_REQUESTS: usize = 64;
/// 取消可能先于 open 到达；只保留一个很小的有界意图窗口。
const MAX_PRE_CANCELLED: usize = 32;
/// requestId 上限（与前端 `REQUEST_ID_PATTERN` 完全一致：1–128 位 `[A-Za-z0-9_-]`）。
const MAX_REQUEST_ID_CHARS: usize = 128;
/// 复用 Client 的缓存上限（按插件代理配置分桶；配置变化不会无界增长）。
const MAX_CACHED_CLIENTS: usize = 8;
/// 禁止插件设置的 HTTP 框架头（hop-by-hop 与消息边界头）：这些头由传输层
/// 掌控，插件覆盖会造成请求走私、连接语义混乱或与本机代理的不一致行为。
/// 命中即**显式报错**，不静默透传也不静默丢弃。
const FORBIDDEN_REQUEST_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
    "accept-encoding",
    "expect",
    "origin",
    "forwarded",
];
/// 由 reqwest/超文本层拥有、整族禁止的前缀头（`proxy-connection`、
/// `proxy-authorization`、`proxy-authenticate` 等）。
const FORBIDDEN_REQUEST_HEADER_PREFIXES: &[&str] = &["proxy-", "sec-", "x-forwarded-"];
/// 重定向处理模式（wire 值 follow/manual/error，缺省 follow）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RedirectMode {
    Follow,
    Manual,
    Error,
}

fn parse_redirect_mode(value: Option<&str>) -> Result<RedirectMode, CommandError> {
    match value.unwrap_or("follow") {
        "follow" => Ok(RedirectMode::Follow),
        "manual" => Ok(RedirectMode::Manual),
        "error" => Ok(RedirectMode::Error),
        other => Err(CommandError::Other(format!(
            "redirect 只支持 follow/manual/error，收到: {other}"
        ))),
    }
}

/// 插件网络/文件流程共用的 requestId 校验（**唯一实现**）：与前端
/// `REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/` 逐字符一致。
fn validate_request_id(request_id: &str) -> Result<(), CommandError> {
    let valid = !request_id.is_empty()
        && request_id.chars().count() <= MAX_REQUEST_ID_CHARS
        && request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if valid {
        Ok(())
    } else {
        Err(CommandError::Other(
            "插件 HTTP requestId 非法（须为 1–128 位字母/数字/_/-）".into(),
        ))
    }
}

/// 错误/日志中使用的脱敏 URL：只保留 origin + path，去掉 userinfo、query 与
/// fragment，避免凭据或查询参数进入错误串与诊断日志。
fn redact_url(url: &Url) -> String {
    let path = if url.path().is_empty() { "/" } else { url.path() };
    format!("{}{}", url.origin().ascii_serialization(), path)
}

/// 未解析成功（或不宜解析）的原始 URL 的脱敏：截掉 `?`/`#` 之后的部分并去掉
/// userinfo，保留 scheme://host/path 供诊断。
fn redact_raw_url(raw: &str) -> String {
    let cut = raw.find(['?', '#']).unwrap_or(raw.len());
    let head = &raw[..cut];
    if let Some(scheme_end) = head.find("://") {
        let rest = &head[scheme_end + 3..];
        let authority_end = rest.find('/').unwrap_or(rest.len());
        if let Some(at) = rest[..authority_end].rfind('@') {
            return format!("{}{}", &head[..scheme_end + 3], &rest[at + 1..]);
        }
    }
    head.to_string()
}

/// reqwest 错误文本：先剥离其自带的完整 URL（可能含 query），再附加脱敏 URL。
fn http_error_text(error: reqwest::Error, url: &Url) -> String {
    let had_url = error.url().is_some();
    let text = error.without_url().to_string();
    if had_url {
        format!("{text}（{}）", redact_url(url))
    } else {
        text
    }
}

fn cancelled_error() -> CommandError {
    CommandError::Other("插件 HTTP 请求已取消".into())
}

fn timeout_error() -> CommandError {
    CommandError::Other("插件 HTTP 请求超时".into())
}

/// 框架头判定：显式名单 + `proxy-*` 整族（名称按小写比较）。
fn is_forbidden_request_header(name: &str) -> bool {
    FORBIDDEN_REQUEST_HEADERS.contains(&name)
        || FORBIDDEN_REQUEST_HEADER_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
}

/// 校验并转换插件提供的请求头；框架头/消息边界头显式报错。
fn validate_request_headers(
    headers: &HashMap<String, String>,
) -> Result<Vec<(HeaderName, HeaderValue)>, CommandError> {
    let mut out = Vec::with_capacity(headers.len());
    for (name, value) in headers {
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|e| CommandError::Other(format!("非法 HTTP header 名 {name}: {e}")))?;
        if is_forbidden_request_header(header_name.as_str()) {
            return Err(CommandError::Other(format!(
                "禁止设置 HTTP 框架头: {}",
                header_name.as_str()
            )));
        }
        let header_value = HeaderValue::from_str(value)
            .map_err(|e| CommandError::Other(format!("非法 HTTP header 值: {e}")))?;
        out.push((header_name, header_value));
    }
    Ok(out)
}

fn redirect_status(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

/// Match reqwest/Fetch redirect semantics: 301/302 rewrite POST only; 303
/// rewrites every method except GET/HEAD. `None` means the original method and
/// body must be preserved.
fn redirect_rewrites_method(status: u16, method: &Method) -> Option<Method> {
    match status {
        301 | 302 if *method == Method::POST => Some(Method::GET),
        303 if *method != Method::GET && *method != Method::HEAD => Some(Method::GET),
        _ => None,
    }
}

/// A method rewrite drops the old request representation. Content-Length is
/// already forbidden at input; these headers describe the body we just removed.
fn strip_body_representation_headers(headers: &mut Vec<(HeaderName, HeaderValue)>) {
    headers.retain(|(name, _)| {
        !matches!(
            name.as_str(),
            "content-type"
                | "content-encoding"
                | "content-language"
                | "content-location"
                | "content-md5"
                | "digest"
        )
    });
}

/// 判断重定向是否跨源：scheme/host/port 任一变化即视为跨源（比只比 host 更严）。
fn redirect_crosses_origin(from: &Url, to: &Url) -> bool {
    from.scheme() != to.scheme()
        || from.host_str() != to.host_str()
        || from.port_or_known_default() != to.port_or_known_default()
}

/// Explicitly safe cross-origin request headers that carry request semantics
/// but not caller credentials. This is a native HTTP channel, not browser CORS:
/// all legal `Content-Type` values (including `application/json`) and
/// `Content-Encoding` are retained so a 307/308 redirect preserves body
/// semantics. Arbitrary custom headers such as `X-Company-Secret` do not follow
/// a redirect. Authentication must be sent directly to the final origin.
fn is_cross_origin_safe_header(name: &HeaderName, _value: &HeaderValue) -> bool {
    matches!(
        name.as_str(),
        "accept"
            | "accept-language"
            | "content-language"
            | "content-type"
            | "content-encoding"
            | "range"
    )
}

fn strip_credential_headers(headers: &mut Vec<(HeaderName, HeaderValue)>, cross_origin: bool) {
    if cross_origin {
        headers.retain(|(name, value)| is_cross_origin_safe_header(name, value));
    }
}

/// 每一跳（初始 URL 与每个重定向目标）都走这里：协议 + 可选白名单。
fn require_allowed_url(
    whitelist: &[String],
    url: &Url,
    label: &str,
) -> Result<(), CommandError> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(CommandError::Other(format!(
            "仅允许 http/https 协议，收到: {}",
            url.scheme()
        )));
    }
    if !whitelist.is_empty()
        && !whitelist
            .iter()
            .any(|pattern| url_glob_match(pattern, url.as_str()))
    {
        return Err(CommandError::Other(format!(
            "{label} 不在插件 http.urlWhitelist 内: {}",
            redact_url(url)
        )));
    }
    Ok(())
}

/// 进程级 Client 缓存（按插件代理配置分桶）。重定向与 Referer 固定为手动语义：
/// `Policy::none()` 保证不会被框架悄悄跟随，`referer(false)` 保证不泄漏来源。
static HTTP_CLIENTS: LazyLock<Mutex<HashMap<Option<String>, Client>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn shared_client(proxy: Option<&str>) -> Result<Client, CommandError> {
    let key = proxy.map(str::to_owned);
    if let Ok(clients) = HTTP_CLIENTS.lock() {
        if let Some(client) = clients.get(&key) {
            return Ok(client.clone());
        }
    }
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .referer(false);
    if let Some(proxy) = proxy {
        builder = builder.proxy(
            reqwest::Proxy::all(proxy)
                .map_err(|e| CommandError::Other(format!("插件代理配置非法: {e}")))?,
        );
    }
    let client = builder
        .build()
        .map_err(|e| CommandError::Other(format!("HTTP client 初始化失败: {e}")))?;
    let mut clients = HTTP_CLIENTS
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    if clients.len() >= MAX_CACHED_CLIENTS {
        clients.clear();
    }
    clients.insert(key, client.clone());
    Ok(client)
}

/// 插件 HTTP 请求（wire 与前端 TS 对齐）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHttpRequest {
    /// 缺省 GET。
    #[serde(default)]
    pub method: Option<String>,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    /// 文本请求体；与 `bodyBase64` 互斥。
    #[serde(default)]
    pub body: Option<String>,
    /// 原始字节请求体（标准 base64）；与 `body` 互斥。
    #[serde(default)]
    pub body_base64: Option<String>,
    /// 总截止秒数：缺省或 0 = 无截止；必须非负有限。
    #[serde(default)]
    pub timeout: Option<f64>,
    /// `follow`（默认）| `manual` | `error`。
    #[serde(default)]
    pub redirect: Option<String>,
}

/// open 返回的响应头信息；响应体由 read 拉取。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHttpHead {
    pub request_id: String,
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub url: String,
}

/// 单次 read 的传输块。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHttpChunk {
    pub base64: String,
    pub done: bool,
}

enum ReadState {
    /// open 已登记但连接尚未完成；此阶段 read 明确报错而不是静默空块。
    Pending,
    Streaming {
        response: reqwest::Response,
        leftover: Vec<u8>,
        leftover_pos: usize,
    },
    Finished,
}

struct RequestEntry {
    plugin_id: String,
    generation: String,
    cancel_tx: watch::Sender<bool>,
    /// 显式 timeout 的绝对截止时间（打开与所有读取共用）。
    deadline: Option<std::time::Instant>,
    state: AsyncMutex<ReadState>,
}

/// 进程级插件 HTTP 请求注册表。
pub struct PluginHttpRegistry {
    entries: Mutex<HashMap<String, Arc<RequestEntry>>>,
    /// cancel 先于 open 到达时的有界意图记录（requestId, plugin, generation）。
    pre_cancelled: Mutex<VecDeque<(String, String, String)>>,
}

impl PluginHttpRegistry {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            pre_cancelled: Mutex::new(VecDeque::new()),
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, Arc<RequestEntry>>>, CommandError> {
        self.entries
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))
    }

    /// 同步准入：在任何 await 之前登记，保证挂起中的 open 也可被取消。
    fn admit(
        &self,
        request_id: &str,
        plugin_id: &str,
        generation: &str,
        deadline: Option<std::time::Instant>,
    ) -> Result<Arc<RequestEntry>, CommandError> {
        let mut entries = self.lock()?;
        if entries.len() >= MAX_CONCURRENT_REQUESTS {
            return Err(CommandError::Other(
                "插件网络请求并发数已达上限，请稍后重试".into(),
            ));
        }
        if entries.contains_key(request_id) {
            return Err(CommandError::Other(format!(
                "插件 HTTP requestId 重复: {request_id}"
            )));
        }
        if let Ok(mut pre) = self.pre_cancelled.lock() {
            if let Some(index) = pre.iter().position(|(id, plugin, gen_val)| {
                id.as_str() == request_id && plugin.as_str() == plugin_id && gen_val.as_str() == generation
            }) {
                pre.remove(index);
                return Err(CommandError::Other("插件 HTTP 请求已取消".into()));
            }
        }
        let (cancel_tx, _) = watch::channel(false);
        let entry = Arc::new(RequestEntry {
            plugin_id: plugin_id.to_string(),
            generation: generation.to_string(),
            cancel_tx,
            deadline,
            state: AsyncMutex::new(ReadState::Pending),
        });
        entries.insert(request_id.to_string(), entry.clone());
        Ok(entry)
    }

    fn get(
        &self,
        request_id: &str,
        plugin_id: &str,
        generation: &str,
    ) -> Result<Arc<RequestEntry>, CommandError> {
        let entries = self.lock()?;
        match entries.get(request_id) {
            Some(entry) if entry.plugin_id == plugin_id && entry.generation == generation => {
                Ok(entry.clone())
            }
            Some(_) => Err(CommandError::Other(
                "该网络请求不属于当前插件安装版本".into(),
            )),
            None => Err(CommandError::Other(format!(
                "插件网络请求不存在或已结束: {request_id}"
            ))),
        }
    }

    /// 删除匹配条目并打断其打开/读取。
    fn retire(&self, request_id: &str, plugin_id: &str, generation: &str) {
        let removed = match self.lock() {
            Ok(mut entries) => {
                let matches = entries.get(request_id).is_some_and(|entry| {
                    entry.plugin_id == plugin_id && entry.generation == generation
                });
                if matches {
                    entries.remove(request_id)
                } else {
                    None
                }
            }
            Err(_) => None,
        };
        if let Some(entry) = removed {
            entry.cancel_tx.send_replace(true);
        }
    }

    fn remove_if_matches(
        &self,
        request_id: &str,
        plugin_id: &str,
        generation: &str,
        entry: &Arc<RequestEntry>,
    ) {
        let removed = match self.lock() {
            Ok(mut entries) => {
                if entries
                    .get(request_id)
                    .is_some_and(|current| Arc::ptr_eq(current, entry))
                    && entry.plugin_id == plugin_id
                    && entry.generation == generation
                {
                    entries.remove(request_id)
                } else {
                    None
                }
            }
            Err(_) => None,
        };
        // Persist cancellation even when the last receiver disappeared between
        // a failed read and cleanup. This also makes cleanup safe for a caller
        // that still holds an Arc to the retired entry.
        if let Some(entry) = removed {
            entry.cancel_tx.send_replace(true);
        }
    }

    fn cancel_where(&self, predicate: impl Fn(&RequestEntry) -> bool) {
        let removed: Vec<Arc<RequestEntry>> = match self.lock() {
            Ok(mut entries) => {
                let ids: Vec<String> = entries
                    .iter()
                    .filter(|(_, entry)| predicate(entry))
                    .map(|(id, _)| id.clone())
                    .collect();
                ids.into_iter()
                    .filter_map(|id| entries.remove(&id))
                    .collect()
            }
            Err(_) => Vec::new(),
        };
        for entry in removed {
            entry.cancel_tx.send_replace(true);
        }
    }

    /// 禁用/撤销/卸载/重载/替换安装后取消该插件的全部请求。
    pub fn cancel_plugin(&self, plugin_id: &str) {
        self.cancel_where(|entry| entry.plugin_id == plugin_id);
        // A pre-open cancel intent belongs to the old request lifecycle too.
        // Retain no stale intent across a plugin lifecycle transition, otherwise
        // a later requestId reuse could be cancelled by an unrelated operation.
        if let Ok(mut pre) = self.pre_cancelled.lock() {
            pre.retain(|(_, plugin, _)| plugin != plugin_id);
        }
    }

    /// 配置恢复/导入可能改变任意插件状态，整体取消最保守。
    pub fn cancel_all(&self) {
        self.cancel_where(|_| true);
        if let Ok(mut pre) = self.pre_cancelled.lock() {
            pre.clear();
        }
    }

    /// cancel 先于 open 到达：记录有界意图，admit 时消费。
    fn remember_pre_cancel(&self, request_id: &str, plugin_id: &str, generation: &str) {
        if let Ok(mut pre) = self.pre_cancelled.lock() {
            if pre.iter().any(|(id, plugin, gen_val)| {
                id.as_str() == request_id && plugin.as_str() == plugin_id && gen_val.as_str() == generation
            }) {
                return;
            }
            if pre.len() >= MAX_PRE_CANCELLED {
                pre.pop_front();
            }
            pre.push_back((
                request_id.to_string(),
                plugin_id.to_string(),
                generation.to_string(),
            ));
        }
    }
}

struct AuthorizedHttp {
    whitelist: Vec<String>,
    proxy: Option<String>,
}

fn validate_generation(expected: &str) -> Result<(), CommandError> {
    if expected.is_empty() {
        return Err(CommandError::Other(
            "插件安装版本已变化，请重新检查插件后操作".into(),
        ));
    }
    Ok(())
}

/// 调用时权限校验（含安装版本），不读取 manifest。
fn require_http_access(
    state: &AppState,
    plugin_id: &str,
    expected_generation: &str,
) -> Result<(), CommandError> {
    validate_generation(expected_generation)?;
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    require_http_access_locked(manager.get_config(), plugin_id, expected_generation)
}

/// 已持有 config 锁时的权限校验（供需要同时读取代理/根目录的调用方复用）。
fn require_http_access_locked(
    cfg: &crate::config::AppConfig,
    plugin_id: &str,
    expected_generation: &str,
) -> Result<(), CommandError> {
    validate_generation(expected_generation)?;
    let entry = cfg
        .entities
        .plugin_configs
        .iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| CommandError::Other(format!("插件未安装: {plugin_id}")))?;
    if entry.install_generation != expected_generation {
        return Err(CommandError::Other(
            "插件安装版本已变化，请重新检查插件后操作".into(),
        ));
    }
    if !entry.enabled {
        return Err(CommandError::Other(format!("插件未启用: {plugin_id}")));
    }
    if !entry
        .granted_permissions
        .iter()
        .any(|p| p == "http:request")
    {
        return Err(CommandError::Other(format!(
            "插件未授予 http:request 权限: {plugin_id}"
        )));
    }
    Ok(())
}

/// open 时的完整校验：权限 + manifest 声明 + 可选白名单 + 插件代理。
/// 锁纪律：`config_manager` 只在内存里读取「已安装/启用/授权/代理」与插件根目录，
/// 释放后再做 manifest 文件 IO。manifest 只需要本体（`load_manifest_lite`），
/// 不在这里读取任何视图资源。
fn authorize_open(
    state: &AppState,
    plugin_id: &str,
    expected_generation: &str,
) -> Result<AuthorizedHttp, CommandError> {
    let (root, proxy) = {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let cfg = manager.get_config();
        require_http_access_locked(cfg, plugin_id, expected_generation)?;
        let proxy = if cfg.plugin_proxy_enabled && !cfg.plugin_proxy.is_empty() {
            Some(cfg.plugin_proxy.clone())
        } else {
            None
        };
        (manager.plugins_dir().to_path_buf(), proxy)
    };
    let manifest = plugin::load_manifest_lite(&super::plugin::plugin_dir(&root, plugin_id)?)
        .map_err(|e| CommandError::Other(format!("插件 manifest 不可读: {e}")))?;
    if manifest.id != plugin_id {
        return Err(CommandError::Other("manifest id 与插件目录不一致".into()));
    }
    if !manifest.permissions.iter().any(|p| p == "http:request") {
        return Err(CommandError::Other(format!(
            "插件未声明 http:request: {plugin_id}"
        )));
    }
    let whitelist = manifest
        .http
        .as_ref()
        .map(|h| h.url_whitelist.clone())
        .unwrap_or_default();
    Ok(AuthorizedHttp { whitelist, proxy })
}

fn total_deadline(timeout: Option<f64>) -> Result<Option<Instant>, CommandError> {
    let Some(seconds) = timeout else { return Ok(None) };
    if !seconds.is_finite() || seconds < 0.0 {
        return Err(CommandError::Other(
            "timeout 必须是非负有限秒数（0 表示无截止）".into(),
        ));
    }
    if seconds == 0.0 {
        return Ok(None);
    }
    let duration = Duration::try_from_secs_f64(seconds)
        .map_err(|_| CommandError::Other("timeout 数值超出范围".into()))?;
    std::time::Instant::now()
        .checked_add(duration)
        .map(Some)
        .ok_or_else(|| CommandError::Other("timeout 数值超出范围".into()))
}

fn request_body(
    body: Option<String>,
    body_base64: Option<String>,
) -> Result<Vec<u8>, CommandError> {
    match (body, body_base64) {
        (Some(_), Some(_)) => Err(CommandError::Other(
            "body 与 bodyBase64 不能同时提供".into(),
        )),
        (Some(body), None) => Ok(body.into_bytes()),
        (None, Some(encoded)) => base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|e| CommandError::Other(format!("bodyBase64 非法: {e}"))),
        (None, None) => Ok(Vec::new()),
    }
}

/// open 的准入守卫：任何提前返回都会移除注册条目并广播取消，
/// 只有成功登记 Streaming 状态后才 disarm。
struct AdmissionGuard<'a> {
    registry: &'a PluginHttpRegistry,
    request_id: String,
    plugin_id: String,
    generation: String,
    entry: Arc<RequestEntry>,
    armed: bool,
}

impl Drop for AdmissionGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            self.registry.remove_if_matches(
                &self.request_id,
                &self.plugin_id,
                &self.generation,
                &self.entry,
            );
            self.entry.cancel_tx.send_replace(true);
        }
    }
}

/// 响应头简化为 `Record<string,string>`：重复头（如 Set-Cookie）按 ", " 合并。
fn response_headers(headers: &reqwest::header::HeaderMap) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for (name, value) in headers {
        let text = value
            .to_str()
            .map(str::to_owned)
            .unwrap_or_else(|_| String::from_utf8_lossy(value.as_bytes()).into_owned());
        out.entry(name.as_str().to_ascii_lowercase())
            .and_modify(|existing: &mut String| {
                existing.push_str(", ");
                existing.push_str(&text);
            })
            .or_insert(text);
    }
    out
}

async fn sleep_until_deadline(deadline: Option<std::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await,
        None => std::future::pending::<()>().await,
    }
}

async fn wait_cancel(rx: &mut watch::Receiver<bool>) {
    if *rx.borrow() {
        return;
    }
    // 发送端在条目存活期间始终存在；变更即取消意图。
    let _ = rx.changed().await;
}

/// Send one request and manually follow redirects. reqwest's built-in redirect
/// policy cannot apply credential stripping to every hop, so this loop owns the
/// redirect semantics and validates each target before any bytes are sent.
struct RedirectRequest<'a> {
    client: &'a Client,
    method: Method,
    url: Url,
    headers: Vec<(HeaderName, HeaderValue)>,
    body: Vec<u8>,
    redirect: RedirectMode,
    whitelist: &'a [String],
    deadline: Option<Instant>,
    cancel_rx: &'a mut watch::Receiver<bool>,
}

async fn send_with_redirects(request: RedirectRequest<'_>) -> Result<reqwest::Response, CommandError> {
    let RedirectRequest {
        client,
        mut method,
        mut url,
        mut headers,
        mut body,
        redirect,
        whitelist,
        deadline,
        cancel_rx,
    } = request;
    let mut redirects = 0usize;
    loop {
        require_allowed_url(whitelist, &url, "重定向 URL")?;
        let mut builder = client.request(method.clone(), url.clone());
        for (name, value) in &headers {
            builder = builder.header(name.clone(), value.clone());
        }
        if !body.is_empty() {
            builder = builder.body(body.clone());
        }
        let send = builder.send();
        tokio::pin!(send);
        let response = tokio::select! {
            biased;
            _ = wait_cancel(cancel_rx) => return Err(cancelled_error()),
            _ = sleep_until_deadline(deadline) => return Err(timeout_error()),
            response = &mut send => response.map_err(|error| {
                CommandError::Other(format!("HTTP 请求失败: {}", http_error_text(error, &url)))
            })?,
        };
        if !redirect_status(response.status().as_u16()) {
            return Ok(response);
        }
        match redirect {
            RedirectMode::Manual => return Ok(response),
            RedirectMode::Error => {
                return Err(CommandError::Other(format!(
                    "HTTP 重定向被拒绝: {}",
                    redact_url(&url)
                )))
            }
            RedirectMode::Follow => {}
        }
        if redirects >= MAX_REDIRECTS {
            return Err(CommandError::Other("HTTP 重定向次数超过上限".into()));
        }
        let Some(location) = response.headers().get(LOCATION) else {
            // A redirect without Location is a valid response, not a transport
            // error; callers can inspect its status and headers in follow mode.
            return Ok(response);
        };
        let location = location.to_str().map_err(|_| {
            CommandError::Other("HTTP 重定向 Location 不是合法文本".into())
        })?;
        let next = response.url().join(location).map_err(|error| {
            CommandError::Other(format!(
                "HTTP 重定向目标非法（{}）: {error}",
                redact_url(response.url())
            ))
        })?;
        require_allowed_url(whitelist, &next, "重定向 URL")?;
        let cross_origin = redirect_crosses_origin(response.url(), &next);
        strip_credential_headers(&mut headers, cross_origin);
        if let Some(rewritten) = redirect_rewrites_method(response.status().as_u16(), &method) {
            method = rewritten;
            body.clear();
            strip_body_representation_headers(&mut headers);
        }
        url = next;
        redirects += 1;
    }
}

#[tauri::command]
pub async fn plugin_http_open(
    plugin_id: String,
    expected_generation: String,
    request_id: String,
    request: PluginHttpRequest,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginHttpHead, CommandError> {
    super::plugin::require_main_window(&window)?;
    plugin::validate_plugin_id(&plugin_id).map_err(CommandError::Other)?;
    validate_request_id(&request_id)?;
    let PluginHttpRequest {
        method,
        url,
        headers,
        body,
        body_base64,
        timeout,
        redirect,
    } = request;
    let scope = authorize_open(&state, &plugin_id, &expected_generation)?;
    let parsed_url = Url::parse(&url).map_err(|e| {
        CommandError::Other(format!("非法 URL {}: {e}", redact_raw_url(&url)))
    })?;
    require_allowed_url(&scope.whitelist, &parsed_url, "URL")?;
    let method = match method.as_deref() {
        None | Some("") => "GET".to_string(),
        Some(method) => method.to_string(),
    };
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| CommandError::Other(format!("非法 HTTP 方法: {e}")))?;
    let body = request_body(body, body_base64)?;
    let deadline = total_deadline(timeout)?;
    let redirect = parse_redirect_mode(redirect.as_deref())?;
    let headers = validate_request_headers(&headers)?;

    // 同步准入先于任何 await：连接挂起期间的 cancel 也能命中条目。
    let entry = state
        .plugin_http
        .admit(&request_id, &plugin_id, &expected_generation, deadline)?;
    let mut admission = AdmissionGuard {
        registry: &state.plugin_http,
        request_id: request_id.clone(),
        plugin_id: plugin_id.clone(),
        generation: expected_generation.clone(),
        entry: entry.clone(),
        armed: true,
    };
    // 准入后再校验一次：若禁用/撤销/重装已在准入前提交，这里必须失败；
    // 若在准入后提交，其 cancel_plugin 会移除本条并广播取消。
    require_http_access(&state, &plugin_id, &expected_generation)?;
    let mut cancel_rx = entry.cancel_tx.subscribe();
    if *cancel_rx.borrow() {
        return Err(CommandError::Other("插件 HTTP 请求已取消".into()));
    }

    let client = shared_client(scope.proxy.as_deref())?;
    let response = send_with_redirects(RedirectRequest {
        client: &client,
        method,
        url: parsed_url,
        headers,
        body,
        redirect,
        whitelist: &scope.whitelist,
        deadline,
        cancel_rx: &mut cancel_rx,
    })
    .await?;

    // A permission change may race the final network response. Never expose the
    // response head unless the current generation is still authorized.
    if let Err(error) = require_http_access(&state, &plugin_id, &expected_generation) {
        state
            .plugin_http
            .remove_if_matches(&request_id, &plugin_id, &expected_generation, &entry);
        return Err(error);
    }
    let status = response.status().as_u16();
    let response_headers = response_headers(response.headers());
    let response_url = response.url().as_str().to_string();

    {
        let mut guard = tokio::select! {
            biased;
            _ = wait_cancel(&mut cancel_rx) => {
                return Err(CommandError::Other("插件 HTTP 请求已取消".into()));
            }
            guard = entry.state.lock() => guard,
        };
        *guard = ReadState::Streaming {
            response,
            leftover: Vec::new(),
            leftover_pos: 0,
        };
    }

    admission.armed = false;
    Ok(PluginHttpHead {
        request_id,
        status,
        headers: response_headers,
        url: response_url,
    })
}

#[tauri::command]
pub async fn plugin_http_read(
    plugin_id: String,
    expected_generation: String,
    request_id: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginHttpChunk, CommandError> {
    super::plugin::require_main_window(&window)?;
    plugin::validate_plugin_id(&plugin_id).map_err(CommandError::Other)?;
    validate_request_id(&request_id)?;
    let entry = state
        .plugin_http
        .get(&request_id, &plugin_id, &expected_generation)?;
    // 读取时重校验：禁用/撤销/重装后旧读取立即失败。
    require_http_access(&state, &plugin_id, &expected_generation)?;
    let mut cancel_rx = entry.cancel_tx.subscribe();
    if *cancel_rx.borrow() {
        state
            .plugin_http
            .remove_if_matches(&request_id, &plugin_id, &expected_generation, &entry);
        return Err(CommandError::Other("插件 HTTP 请求已取消".into()));
    }
    // 截止检查在服务任何残余字节之前：过期请求不得继续产出。
    if entry
        .deadline
        .is_some_and(|deadline| std::time::Instant::now() >= deadline)
    {
        state
            .plugin_http
            .remove_if_matches(&request_id, &plugin_id, &expected_generation, &entry);
        return Err(CommandError::Other("插件 HTTP 请求超时".into()));
    }

    let mut guard = tokio::select! {
        biased;
        _ = wait_cancel(&mut cancel_rx) => {
            state.plugin_http.remove_if_matches(&request_id, &plugin_id, &expected_generation, &entry);
            return Err(CommandError::Other("插件 HTTP 请求已取消".into()));
        }
        guard = entry.state.lock() => guard,
    };
    // Cancellation/deadline may win immediately after the async mutex was
    // acquired. Recheck before consuming leftover bytes or issuing a network
    // pull so a late cancel cannot leak one more chunk.
    if *cancel_rx.borrow() {
        drop(guard);
        state
            .plugin_http
            .remove_if_matches(&request_id, &plugin_id, &expected_generation, &entry);
        return Err(cancelled_error());
    }
    if entry
        .deadline
        .is_some_and(|deadline| std::time::Instant::now() >= deadline)
    {
        drop(guard);
        state
            .plugin_http
            .remove_if_matches(&request_id, &plugin_id, &expected_generation, &entry);
        return Err(timeout_error());
    }

    let done;
    let bytes = match &mut *guard {
        ReadState::Pending => {
            return Err(CommandError::Other("插件 HTTP 请求尚未完成打开".into()));
        }
        ReadState::Finished => {
            done = true;
            Vec::new()
        }
        ReadState::Streaming {
            response,
            leftover,
            leftover_pos,
        } => {
            let mut out = Vec::with_capacity(TRANSPORT_CHUNK_BYTES);
            if *leftover_pos < leftover.len() {
                let take = (leftover.len() - *leftover_pos).min(TRANSPORT_CHUNK_BYTES);
                out.extend_from_slice(&leftover[*leftover_pos..*leftover_pos + take]);
                *leftover_pos += take;
                if *leftover_pos == leftover.len() {
                    leftover.clear();
                    *leftover_pos = 0;
                }
            }
            let mut eof = false;
            // 传输上限不是下限：拿到任意一块就返回，SSE 才能逐事件交付。
            while out.is_empty() && !eof {
                let next = tokio::select! {
                    biased;
                    _ = wait_cancel(&mut cancel_rx) => {
                        state.plugin_http.remove_if_matches(&request_id, &plugin_id, &expected_generation, &entry);
                        return Err(CommandError::Other("插件 HTTP 请求已取消".into()));
                    }
                    _ = sleep_until_deadline(entry.deadline) => {
                        state.plugin_http.remove_if_matches(&request_id, &plugin_id, &expected_generation, &entry);
                        return Err(CommandError::Other("插件 HTTP 请求超时".into()));
                    }
                    chunk = response.chunk() => chunk,
                };
                match next {
                    Ok(Some(bytes)) => out.extend_from_slice(&bytes),
                    Ok(None) => eof = true,
                    Err(error) => {
                        state.plugin_http.remove_if_matches(&request_id, &plugin_id, &expected_generation, &entry);
                        return Err(CommandError::Other(format!("读取响应失败: {error}")));
                    }
                }
            }
            if out.len() > TRANSPORT_CHUNK_BYTES {
                *leftover = out.split_off(TRANSPORT_CHUNK_BYTES);
                *leftover_pos = 0;
            }
            done = eof && leftover.is_empty();
            out
        }
    };
    if done {
        *guard = ReadState::Finished;
    }
    drop(guard);
    // 交付前再校验一次：读取期间被禁用/撤销的请求不得把数据交给旧会话
    // （前端仍是最终权威；通知与这里共同缩小竞态窗口）。
    if let Err(error) = require_http_access(&state, &plugin_id, &expected_generation) {
        state
            .plugin_http
            .remove_if_matches(&request_id, &plugin_id, &expected_generation, &entry);
        return Err(error);
    }
    if done {
        state
            .plugin_http
            .remove_if_matches(&request_id, &plugin_id, &expected_generation, &entry);
    }
    Ok(PluginHttpChunk {
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        done,
    })
}

#[tauri::command]
pub async fn plugin_http_cancel(
    plugin_id: String,
    expected_generation: String,
    request_id: String,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    super::plugin::require_main_window(&window)?;
    plugin::validate_plugin_id(&plugin_id).map_err(CommandError::Other)?;
    validate_request_id(&request_id)?;
    validate_generation(&expected_generation)?;
    let action = {
        let entries = state.plugin_http.lock()?;
        match entries.get(&request_id) {
            None => {
                // Hold the registry lock across intent recording so a concurrent
                // admit either sees this intent or is already visible here.
                state.plugin_http.remember_pre_cancel(
                    &request_id,
                    &plugin_id,
                    &expected_generation,
                );
                0u8
            }
            Some(entry)
                if entry.plugin_id == plugin_id && entry.generation == expected_generation =>
            {
                1
            }
            Some(_) => 2,
        }
    };
    match action {
        0 => Ok(()),
        1 => {
            state
                .plugin_http
                .retire(&request_id, &plugin_id, &expected_generation);
            Ok(())
        }
        _ => Err(CommandError::Other(
            "该网络请求不属于当前插件安装版本".into(),
        )),
    }
}

/// URL glob 匹配（`http.urlWhitelist`）。
/// 规则（纯函数）：
/// - `**` 跨 `/` 段匹配（贪婪）；
/// - `*` 匹配单段内任意字符（不含 `/`）；
/// - 其余字符字面量。
///
/// 空白名单条目 → 恒 false（调用方在空白名单时跳过匹配）。
pub(crate) fn url_glob_match(pattern: &str, url: &str) -> bool {
    if pattern.is_empty() {
        return false;
    }
    let mut regex = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    regex.push_str(".*");
                    i += 2;
                } else {
                    regex.push_str("[^/]*");
                    i += 1;
                }
            }
            '?' | '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\' => {
                regex.push('\\');
                regex.push(chars[i]);
                i += 1;
            }
            c => {
                regex.push(c);
                i += 1;
            }
        }
    }
    regex.push('$');
    match regex::Regex::new(&regex) {
        Ok(re) => re.is_match(url),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    #[derive(Debug)]
    struct TestRequest {
        method: String,
        path: String,
        headers: HashMap<String, String>,
        body: Vec<u8>,
    }

    fn read_test_request(stream: &mut TcpStream) -> TestRequest {
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        let header_end;
        loop {
            let mut chunk = [0u8; 4096];
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0, "test server received an incomplete request");
            bytes.extend_from_slice(&chunk[..read]);
            if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                header_end = index + 4;
                break;
            }
        }
        let header_text = String::from_utf8_lossy(&bytes[..header_end]);
        let mut lines = header_text.split("\r\n");
        let request_line = lines.next().unwrap();
        let mut request_parts = request_line.split_whitespace();
        let method = request_parts.next().unwrap().to_string();
        let path = request_parts.next().unwrap().to_string();
        let mut headers = HashMap::new();
        let mut content_length = 0usize;
        for line in lines.filter(|line| !line.is_empty()) {
            let (name, value) = line.split_once(':').unwrap();
            let value = value.trim().to_string();
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.parse().unwrap();
            }
            headers.insert(name.to_ascii_lowercase(), value);
        }
        while bytes.len() < header_end + content_length {
            let mut chunk = [0u8; 4096];
            let read = stream.read(&mut chunk).unwrap();
            assert!(read > 0, "test server received an incomplete body");
            bytes.extend_from_slice(&chunk[..read]);
        }
        TestRequest {
            method,
            path,
            headers,
            body: bytes[header_end..header_end + content_length].to_vec(),
        }
    }

    fn write_test_response(stream: &mut TcpStream, status: &str, headers: &[(&str, &str)]) {
        let mut response = format!("HTTP/1.1 {status}\r\n");
        for (name, value) in headers {
            response.push_str(name);
            response.push_str(": ");
            response.push_str(value);
            response.push_str("\r\n");
        }
        response.push_str("Connection: close\r\n\r\n");
        stream.write_all(response.as_bytes()).unwrap();
    }

    fn serve_test_requests<F>(listener: TcpListener, count: usize, mut handler: F) -> thread::JoinHandle<Vec<TestRequest>>
    where
        F: FnMut(usize, &TestRequest, &mut TcpStream) + Send + 'static,
    {
        thread::spawn(move || {
            listener.set_nonblocking(true).unwrap();
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut requests = Vec::with_capacity(count);
            while requests.len() < count {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        let request = read_test_request(&mut stream);
                        handler(requests.len(), &request, &mut stream);
                        requests.push(request);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(std::time::Instant::now() < deadline, "test server timed out");
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("test server accept failed: {error}"),
                }
            }
            requests
        })
    }

    fn test_client() -> Client {
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .referer(false)
            .build()
            .unwrap()
    }

    #[test]
    fn timeout_zero_means_no_deadline_and_negative_is_rejected() {
        assert!(total_deadline(None).unwrap().is_none());
        assert!(total_deadline(Some(0.0)).unwrap().is_none());
        assert!(total_deadline(Some(1.5)).unwrap().is_some());
        assert!(total_deadline(Some(-1.0)).is_err());
        assert!(total_deadline(Some(f64::NAN)).is_err());
        assert!(total_deadline(Some(f64::INFINITY)).is_err());
    }

    #[test]
    fn request_body_text_and_base64_are_exclusive_and_uncapped() {
        assert_eq!(request_body(None, None).unwrap(), Vec::<u8>::new());
        assert_eq!(request_body(Some(String::new()), None).unwrap(), Vec::<u8>::new());
        assert_eq!(
            request_body(Some("héllo".into()), None).unwrap(),
            "héllo".as_bytes().to_vec()
        );
        assert_eq!(
            request_body(None, Some("AP+ADQo=".into())).unwrap(),
            vec![0, 255, 128, 13, 10]
        );
        assert!(request_body(Some("x".into()), Some("eA==".into())).is_err());
        assert!(request_body(None, Some("!!!".into())).is_err());
        let large = "x".repeat(2 * 1024 * 1024);
        assert_eq!(request_body(Some(large.clone()), None).unwrap().len(), large.len());
    }

    #[test]
    fn redirect_mode_validation_accepts_contract_values() {
        assert_eq!(parse_redirect_mode(None).unwrap(), RedirectMode::Follow);
        assert_eq!(parse_redirect_mode(Some("follow")).unwrap(), RedirectMode::Follow);
        assert_eq!(parse_redirect_mode(Some("manual")).unwrap(), RedirectMode::Manual);
        assert_eq!(parse_redirect_mode(Some("error")).unwrap(), RedirectMode::Error);
        assert!(parse_redirect_mode(Some("bogus")).is_err());
    }

    #[test]
    fn framework_headers_are_rejected_case_insensitively() {
        for name in ["Host", "content-length", "Connection", "Sec-Fetch-Mode", "X-Forwarded-For"] {
            let mut headers = HashMap::new();
            headers.insert(name.to_string(), "x".to_string());
            assert!(validate_request_headers(&headers).is_err(), "{name}");
        }
        let mut allowed = HashMap::new();
        allowed.insert("X-Plugin-Token".to_string(), "ok".to_string());
        assert!(validate_request_headers(&allowed).is_ok());
    }

    #[test]
    fn cross_origin_redirect_strips_sensitive_headers_but_same_origin_keeps_them() {
        let mut headers = validate_request_headers(&HashMap::from([
            ("Authorization".into(), "Bearer token".into()),
            ("X-API-Key".into(), "secret-key".into()),
            ("Cookie".into(), "a=b".into()),
            ("Referer".into(), "https://a.test/private?q=secret".into()),
            ("Accept".into(), "application/json".into()),
            ("Content-Type".into(), "text/plain; charset=utf-8".into()),
            ("Content-Encoding".into(), "gzip".into()),
            ("X-Company-Secret".into(), "keep-out".into()),
        ]))
        .unwrap();
        strip_credential_headers(
            &mut headers,
            redirect_crosses_origin(
                &Url::parse("https://a.test/private").unwrap(),
                &Url::parse("https://b.test/next").unwrap(),
            ),
        );
        assert_eq!(headers.len(), 3);
        assert!(headers.iter().any(|(name, _)| name.as_str() == "accept"));
        assert!(headers.iter().any(|(name, _)| name.as_str() == "content-type"));
        assert!(headers.iter().any(|(name, _)| name.as_str() == "content-encoding"));
        assert!(!headers.iter().any(|(name, _)| name.as_str() == "x-company-secret"));

        let mut json_type = validate_request_headers(&HashMap::from([(
            "Content-Type".into(),
            "application/json".into(),
        )]))
        .unwrap();
        strip_credential_headers(&mut json_type, true);
        assert_eq!(json_type.len(), 1, "application/json is valid on the native HTTP channel");

        let mut same = validate_request_headers(&HashMap::from([
            ("Authorization".into(), "Bearer token".into()),
            ("X-API-Key".into(), "secret-key".into()),
            ("Referer".into(), "https://a.test/private".into()),
        ]))
        .unwrap();
        strip_credential_headers(
            &mut same,
            redirect_crosses_origin(
                &Url::parse("https://a.test/private").unwrap(),
                &Url::parse("https://a.test/next").unwrap(),
            ),
        );
        assert_eq!(same.len(), 3);
    }

    #[test]
    fn redirect_method_rules_match_http_contract() {
        assert_eq!(redirect_rewrites_method(301, &Method::POST), Some(Method::GET));
        assert_eq!(redirect_rewrites_method(301, &Method::PUT), None);
        assert_eq!(redirect_rewrites_method(302, &Method::DELETE), None);
        assert_eq!(redirect_rewrites_method(302, &Method::GET), None);
        assert_eq!(redirect_rewrites_method(303, &Method::PUT), Some(Method::GET));
        assert_eq!(redirect_rewrites_method(303, &Method::HEAD), None);
        assert_eq!(redirect_rewrites_method(303, &Method::GET), None);
        assert_eq!(redirect_rewrites_method(307, &Method::POST), None);
        assert_eq!(redirect_rewrites_method(308, &Method::POST), None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn local_http_cross_origin_redirect_strips_credentials_and_keeps_safe_headers() {
        let target_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let target_addr = target_listener.local_addr().unwrap();
        let target_thread = serve_test_requests(target_listener, 1, |_index, _request, stream| {
            write_test_response(stream, "200 OK", &[("Content-Length", "0")]);
        });
        let source_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let source_addr = source_listener.local_addr().unwrap();
        let source_thread = serve_test_requests(source_listener, 1, move |_index, _request, stream| {
            let location = format!("http://{target_addr}/final");
            write_test_response(stream, "302 Found", &[("Location", &location), ("Content-Length", "0")]);
        });
        let mut headers = validate_request_headers(&HashMap::from([
            ("Authorization".into(), "Bearer secret".into()),
            ("X-Company-Secret".into(), "must-not-leak".into()),
            ("Referer".into(), "http://127.0.0.1/private?q=secret".into()),
            ("Accept".into(), "application/json".into()),
        ])).unwrap();
        let (_cancel_tx, mut cancel_rx) = watch::channel(false);
        let client = test_client();
        let response = send_with_redirects(RedirectRequest {
            client: &client,
            method: Method::GET,
            url: Url::parse(&format!("http://{source_addr}/start")).unwrap(),
            headers: std::mem::take(&mut headers),
            body: Vec::new(),
            redirect: RedirectMode::Follow,
            whitelist: &[],
            deadline: Some(Instant::now() + Duration::from_secs(2)),
            cancel_rx: &mut cancel_rx,
        }).await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let source_requests = source_thread.join().unwrap();
        let target_requests = target_thread.join().unwrap();
        assert_eq!(source_requests.len(), 1);
        let target = &target_requests[0];
        assert_eq!(target.headers.get("accept").map(String::as_str), Some("application/json"));
        for secret in ["authorization", "x-company-secret", "referer"] {
            assert!(!target.headers.contains_key(secret), "cross-origin header leaked: {secret}");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn local_http_same_origin_redirect_preserves_business_headers() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let thread = serve_test_requests(listener, 2, |_index, _request, stream| {
            if _index == 0 {
                write_test_response(stream, "302 Found", &[("Location", "/final"), ("Content-Length", "0")]);
            } else {
                write_test_response(stream, "200 OK", &[("Content-Length", "0")]);
            }
        });
        let (_cancel_tx, mut cancel_rx) = watch::channel(false);
        let client = test_client();
        let response = send_with_redirects(RedirectRequest {
            client: &client,
            method: Method::GET,
            url: Url::parse(&format!("http://{addr}/start")).unwrap(),
            headers: validate_request_headers(&HashMap::from([
                ("X-Company-Secret".into(), "same-origin-ok".into()),
                ("X-Trace".into(), "trace".into()),
            ])).unwrap(),
            body: Vec::new(),
            redirect: RedirectMode::Follow,
            whitelist: &[],
            deadline: Some(Instant::now() + Duration::from_secs(2)),
            cancel_rx: &mut cancel_rx,
        }).await.unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let requests = thread.join().unwrap();
        assert_eq!(requests[1].headers.get("x-company-secret").map(String::as_str), Some("same-origin-ok"));
        assert_eq!(requests[1].headers.get("x-trace").map(String::as_str), Some("trace"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn local_http_preserves_307_body_and_rewrites_post_301_302() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let thread = serve_test_requests(listener, 6, |_index, request, stream| {
            match request.path.as_str() {
                "/keep" => write_test_response(stream, "307 Temporary Redirect", &[("Location", "/kept"), ("Content-Length", "0")]),
                "/kept" => write_test_response(stream, "200 OK", &[("Content-Length", "0")]),
                "/post301" => write_test_response(stream, "301 Moved Permanently", &[("Location", "/done301"), ("Content-Length", "0")]),
                "/post302" => write_test_response(stream, "302 Found", &[("Location", "/done302"), ("Content-Length", "0")]),
                "/done301" | "/done302" => write_test_response(stream, "200 OK", &[("Content-Length", "0")]),
                path => panic!("unexpected test path {path}"),
            }
        });
        let client = test_client();
        for path in ["keep", "post301", "post302"] {
            let (_cancel_tx, mut cancel_rx) = watch::channel(false);
            let _ = send_with_redirects(RedirectRequest {
                client: &client,
                method: Method::POST,
                url: Url::parse(&format!("http://{addr}/{path}")).unwrap(),
                headers: validate_request_headers(&HashMap::from([
                    ("Content-Type".into(), "application/json".into()),
                ])).unwrap(),
                body: br#"{"value":7}"#.to_vec(),
                redirect: RedirectMode::Follow,
                whitelist: &[],
                deadline: Some(Instant::now() + Duration::from_secs(2)),
                cancel_rx: &mut cancel_rx,
            }).await.unwrap();
        }
        let requests = thread.join().unwrap();
        assert_eq!(requests[1].path, "/kept");
        assert_eq!(requests[1].method, "POST");
        assert_eq!(requests[1].body, br#"{"value":7}"#);
        assert_eq!(requests[1].headers.get("content-type").map(String::as_str), Some("application/json"));
        assert_eq!(requests[3].path, "/done301");
        assert_eq!(requests[3].method, "GET");
        assert!(requests[3].body.is_empty());
        assert!(!requests[3].headers.contains_key("content-type"));
        assert_eq!(requests[5].path, "/done302");
        assert_eq!(requests[5].method, "GET");
        assert!(requests[5].body.is_empty());
    }

    #[test]
    fn representation_headers_are_removed_only_when_body_is_dropped() {
        let mut headers = validate_request_headers(&HashMap::from([
            ("Content-Type".into(), "application/json".into()),
            ("Content-Encoding".into(), "gzip".into()),
            ("Accept".into(), "application/json".into()),
            ("X-Trace".into(), "keep".into()),
        ]))
        .unwrap();
        strip_body_representation_headers(&mut headers);
        assert_eq!(headers.len(), 2);
        assert!(headers.iter().any(|(name, _)| name.as_str() == "accept"));
        assert!(headers.iter().any(|(name, _)| name.as_str() == "x-trace"));
    }

    #[test]
    fn request_id_uses_ascii_char_limit() {
        assert!(validate_request_id("a".repeat(128).as_str()).is_ok());
        assert!(validate_request_id("a".repeat(129).as_str()).is_err());
        assert!(validate_request_id("é").is_err());
        assert!(validate_request_id("bad/id").is_err());
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
        assert!(!url_glob_match("https://a.com/api/**", "https://a.com/other"));
    }

    #[test]
    fn glob_empty_or_bad_never_matches() {
        assert!(!url_glob_match("", "https://a.com/x"));
        assert!(url_glob_match("https://a.com/(x", "https://a.com/(x"));
        assert!(!url_glob_match("https://a.com/(x", "https://a.com/x"));
        assert!(url_glob_match("https://a.com/x", "https://a.com/x"));
    }

    #[test]
    fn glob_regex_metachars_literal() {
        assert!(url_glob_match("https://a.com/v1.2", "https://a.com/v1.2"));
        assert!(!url_glob_match("https://a.com/v1.2", "https://a.com/v1x2"));
    }

    #[test]
    fn glob_matches_normalized_url() {
        let upper = url::Url::parse("https://SYMBOLS.Example.COM/v1/symbol").unwrap();
        assert!(url_glob_match("https://symbols.example.com/**", upper.as_str()));
        let default_port = url::Url::parse("https://symbols.example.com:443/v1").unwrap();
        assert!(url_glob_match("https://symbols.example.com/**", default_port.as_str()));
        let dotdot = url::Url::parse("https://symbols.example.com/a/../v1").unwrap();
        assert_eq!(dotdot.as_str(), "https://symbols.example.com/v1");
        assert!(url_glob_match("https://symbols.example.com/**", dotdot.as_str()));
        let custom_port = url::Url::parse("https://symbols.example.com:8443/v1").unwrap();
        assert!(!url_glob_match(
            "https://symbols.example.com/**",
            custom_port.as_str()
        ));
    }

    #[test]
    fn cancel_before_open_is_remembered_and_generation_bound() {
        let registry = PluginHttpRegistry::new();
        registry.remember_pre_cancel("early", "com.example.test", "gen-a");
        assert!(registry
            .admit("early", "com.example.test", "gen-a", None)
            .is_err());
        // A different generation must not consume the old intent.
        registry.remember_pre_cancel("early2", "com.example.test", "gen-a");
        assert!(registry
            .admit("early2", "com.example.test", "gen-b", None)
            .is_ok());
    }

    #[test]
    fn cancel_between_reads_is_durable_without_receivers() {
        let registry = PluginHttpRegistry::new();
        let entry = registry
            .admit("req", "com.example.test", "gen", None)
            .unwrap();
        // No receiver exists when cancellation happens (between reads).
        drop(entry.cancel_tx.subscribe());
        registry.retire("req", "com.example.test", "gen");
        // The original entry retains the cancel value despite zero receivers.
        assert!(*entry.cancel_tx.subscribe().borrow());
        assert!(registry
            .get("req", "com.example.test", "gen")
            .is_err());
    }

    #[test]
    fn lifecycle_cancellation_clears_pre_open_intents() {
        let registry = PluginHttpRegistry::new();
        registry.remember_pre_cancel("reuse", "com.example.test", "gen");
        registry.cancel_plugin("com.example.test");
        assert!(registry
            .admit("reuse", "com.example.test", "gen", None)
            .is_ok());
        registry.remember_pre_cancel("all", "com.example.test", "gen");
        registry.cancel_all();
        assert!(registry
            .admit("all", "com.example.test", "gen", None)
            .is_ok());
    }
}
