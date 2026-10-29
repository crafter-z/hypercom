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
 *   缺省/0 表示无总截止。重定向默认 follow（最多 10 跳），白名单对每跳生效。
 */
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use tauri::State;
use tokio::sync::{watch, Mutex as AsyncMutex};

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
        if let Ok(mut entries) = self.lock() {
            if entries
                .get(request_id)
                .is_some_and(|current| Arc::ptr_eq(current, entry))
                && entry.plugin_id == plugin_id
                && entry.generation == generation
            {
                entries.remove(request_id);
            }
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
    }

    /// 配置恢复/导入可能改变任意插件状态，整体取消最保守。
    pub fn cancel_all(&self) {
        self.cancel_where(|_| true);
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
    let entry = manager
        .get_config()
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
fn authorize_open(
    state: &AppState,
    plugin_id: &str,
    expected_generation: &str,
) -> Result<AuthorizedHttp, CommandError> {
    require_http_access(state, plugin_id, expected_generation)?;
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let cfg = manager.get_config();
    let root = manager.plugins_dir().to_path_buf();
    let manifest = plugin::load_manifest_from_dir(&super::plugin::plugin_dir(&root, plugin_id)?)
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
    let proxy = if cfg.plugin_proxy_enabled && !cfg.plugin_proxy.is_empty() {
        Some(cfg.plugin_proxy.clone())
    } else {
        None
    };
    Ok(AuthorizedHttp { whitelist, proxy })
}

fn redirect_policy(
    mode: &str,
    whitelist: Vec<String>,
) -> Result<reqwest::redirect::Policy, CommandError> {
    match mode {
        "manual" => Ok(reqwest::redirect::Policy::none()),
        "error" => Ok(reqwest::redirect::Policy::custom(|attempt| {
            attempt.error("redirect not allowed")
        })),
        "follow" => Ok(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                return attempt.error("too many redirects");
            }
            if !whitelist.is_empty()
                && !whitelist
                    .iter()
                    .any(|pattern| url_glob_match(pattern, attempt.url().as_str()))
            {
                return attempt.error("redirect URL not in http.urlWhitelist");
            }
            attempt.follow()
        })),
        other => Err(CommandError::Other(format!(
            "redirect 只支持 follow/manual/error，收到: {other}"
        ))),
    }
}

fn total_deadline(timeout: Option<f64>) -> Result<Option<std::time::Instant>, CommandError> {
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
    if request_id.is_empty() || request_id.len() > 256 {
        return Err(CommandError::Other("插件 HTTP requestId 非法".into()));
    }
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
    let parsed_url =
        url::Url::parse(&url).map_err(|e| CommandError::Other(format!("非法 URL: {e}")))?;
    if !matches!(parsed_url.scheme(), "http" | "https") {
        return Err(CommandError::Other(format!(
            "仅允许 http/https 协议，收到: {}",
            parsed_url.scheme()
        )));
    }
    if !scope.whitelist.is_empty()
        && !scope
            .whitelist
            .iter()
            .any(|pattern| url_glob_match(pattern, parsed_url.as_str()))
    {
        return Err(CommandError::Other(format!(
            "URL 不在插件 http.urlWhitelist 内: {url}"
        )));
    }
    let method = match method.as_deref() {
        None | Some("") => "GET".to_string(),
        Some(method) => method.to_string(),
    };
    let method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| CommandError::Other(format!("非法 HTTP 方法: {e}")))?;
    let body = request_body(body, body_base64)?;
    let deadline = total_deadline(timeout)?;
    let redirect = redirect.as_deref().unwrap_or("follow");
    let policy = redirect_policy(redirect, scope.whitelist.clone())?;

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

    let mut client_builder = reqwest::Client::builder().redirect(policy);
    if let Some(deadline) = deadline {
        // reqwest 的总超时与本地读取截止同源，避免两块逻辑分叉。
        client_builder = client_builder.timeout(
            deadline.saturating_duration_since(std::time::Instant::now()),
        );
    }
    if let Some(proxy) = &scope.proxy {
        let proxy = reqwest::Proxy::all(proxy)
            .map_err(|e| CommandError::Other(format!("invalid plugin proxy: {e}")))?;
        client_builder = client_builder.proxy(proxy);
    }
    let client = client_builder
        .build()
        .map_err(|e| CommandError::Other(format!("http client init failed: {e}")))?;

    let mut builder = client.request(method, parsed_url.as_str());
    for (name, value) in &headers {
        let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
            .map_err(|e| CommandError::Other(format!("非法 HTTP header 名: {e}")))?;
        let value = reqwest::header::HeaderValue::from_str(value)
            .map_err(|e| CommandError::Other(format!("非法 HTTP header 值: {e}")))?;
        builder = builder.header(name, value);
    }
    if !body.is_empty() {
        builder = builder.body(body);
    }

    let send = builder.send();
    tokio::pin!(send);
    let response = tokio::select! {
        biased;
        _ = wait_cancel(&mut cancel_rx) => {
            return Err(CommandError::Other("插件 HTTP 请求已取消".into()));
        }
        _ = sleep_until_deadline(deadline) => {
            return Err(CommandError::Other("插件 HTTP 请求超时".into()));
        }
        response = &mut send => response.map_err(|e| CommandError::Other(format!("HTTP 请求失败: {e}")))?,
    };

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
        assert!(redirect_policy("follow", Vec::new()).is_ok());
        assert!(redirect_policy("manual", Vec::new()).is_ok());
        assert!(redirect_policy("error", Vec::new()).is_ok());
        assert!(redirect_policy("bogus", Vec::new()).is_err());
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
}
