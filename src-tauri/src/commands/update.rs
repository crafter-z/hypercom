/**
 * 自动更新命令（issue #12）
 *
 * 架构要点：
 * - JS `check()` 无法在运行时指定 endpoint → 整个更新链路由本模块承载，
 *   经 `app.updater_builder().endpoints(vec![url])` 在运行时选择通道。
 * - stable 通道：`releases/latest/download/latest.json`（GitHub 原生「最新非
 *   prerelease」指针，永不泄漏 preview）。
 * - preview 通道：先经 GitHub API（`/releases?per_page=100`，含 prerelease）
 *   解析出**版本号最大**的 preview tag（issue #12 复审：API 顺序是创建时间序，
 *   补发旧核心 preview 会乱序——取 semver 最大而非第一个命中），再指向
 *   `releases/download/<tag>/latest.json`（唯一 tag 不受影响，preview→preview
 *   自动升级可用）。**preview 语义 = max(preview, stable)**（issue #12 二轮）：
 *   preview 检查同时查 stable，取 semver 大者的通道——preview 收尾发布 stable
 *   后用户自动晋升（含 stable 热修），preview 端点解析失败也降级到 stable。
 * - 双层门控：与 simulation.rs 同款三态——release 构建走真实逻辑；
 *   debug 构建（`cargo check`/`tauri dev`）命令直接返回 Ok(None)/Ok(())；
 *   纯解析函数 `#[cfg(any(test, not(debug_assertions)))]`（测试在 debug
 *   构建下也要能跑）。前端另有 `import.meta.env.DEV` 短路。
 * - 下载进度经 `update:progress` 事件推给前端（Emitter::emit）。
 * - 复审加固：未知 channel 报错（不回退 stable）；GitHub API 请求 15s 超时；
 *   `download_and_install_update` 接受 `expected_version`——安装前重检查（设计
 *   使然，check/install 两次网络往返）若版本已变（弹窗展示后发布了新版）则报错
 *   拒绝安装，防「展示的 X、装的是 Y」TOCTOU。
 */
use serde::Serialize;

use crate::commands::CommandError;

#[cfg(not(debug_assertions))]
use std::time::Duration;

#[cfg(not(debug_assertions))]
use tauri::{AppHandle, Emitter};

#[cfg(not(debug_assertions))]
use tauri_plugin_updater::UpdaterExt;

/// GitHub API 请求超时（issue #12 复审：`reqwest::Client::new()` 无超时，
/// API 挂起会让手动检查按钮永久停在「正在检查...」）。
#[cfg(not(debug_assertions))]
const GITHUB_API_TIMEOUT: Duration = Duration::from_secs(15);

/// GitHub 仓库（owner/repo）
#[cfg(not(debug_assertions))]
const GITHUB_OWNER: &str = "crafter-z";
#[cfg(not(debug_assertions))]
const GITHUB_REPO: &str = "hypercom";

/// stable 通道 endpoint：GitHub「最新非 prerelease」指针
#[cfg(not(debug_assertions))]
fn stable_endpoint() -> Result<url::Url, CommandError> {
    url::Url::parse(&format!(
        "https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}/releases/latest/download/latest.json"
    ))
    .map_err(|e| CommandError::Other(format!("invalid stable endpoint: {e}")))
}

/// preview 通道 endpoint：GitHub API 解析最新 preview tag → 该 tag 的 latest.json
#[cfg(not(debug_assertions))]
async fn preview_endpoint(client: &reqwest::Client) -> Result<url::Url, CommandError> {
    let api_url = format!(
        "https://api.github.com/repos/{GITHUB_OWNER}/{GITHUB_REPO}/releases?per_page=100"
    );
    let resp = client
        .get(&api_url)
        .header(reqwest::header::USER_AGENT, "hypercom-updater")
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| CommandError::Other(format!("GitHub API request failed: {e}")))?;
    if !resp.status().is_success() {
        log::warn!("GitHub API returned status {}", resp.status());
        return Err(CommandError::Other(format!(
            "GitHub API status {}",
            resp.status()
        )));
    }
    let releases: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| CommandError::Other(format!("GitHub API parse failed: {e}")))?;
    let tag = find_latest_preview_tag(&releases).ok_or_else(|| {
        CommandError::Other("no preview release found on GitHub".to_string())
    })?;
    url::Url::parse(&format!(
        "https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}/releases/download/{tag}/latest.json"
    ))
    .map_err(|e| CommandError::Other(format!("invalid preview endpoint: {e}")))
}

/// 从 GitHub API `/releases` 响应中取**版本号最大**的 preview tag：
/// - 非 draft、是 prerelease
/// - tag 匹配 `vX.Y.Z-preview.N`（如 `v0.6.0-preview.2`）
/// 纯函数，便于单测（M1.2b）。
///
/// issue #12 复审：GitHub `/releases` 按创建时间倒序——为旧核心补发的 preview
/// 会排在新核心 preview 之前。取 semver 最大（数值组比较）而非第一个命中。
#[cfg(any(test, not(debug_assertions)))]
pub fn find_latest_preview_tag(releases: &serde_json::Value) -> Option<String> {
    let arr = releases.as_array()?;
    arr.iter()
        .filter(|r| {
            let draft = r.get("draft").and_then(|v| v.as_bool()).unwrap_or(false);
            let pre = r.get("prerelease").and_then(|v| v.as_bool()).unwrap_or(false);
            !draft && pre
        })
        .filter_map(|r| r.get("tag_name").and_then(|v| v.as_str()))
        .filter(|tag| is_preview_tag(tag))
        .max_by_key(|tag| parse_preview_tag(tag))
        .map(|tag| (*tag).to_string())
}

/// tag 是否匹配 `vX.Y.Z-preview.N`（如 `v0.6.0-preview.2`）
#[cfg(any(test, not(debug_assertions)))]
fn is_preview_tag(tag: &str) -> bool {
    let mut parts = tag.splitn(2, '-');
    let core = parts.next().unwrap_or("");
    let suffix = parts.next();
    // 核心段必须 v + 数字.数字.数字
    let core_ok = core.strip_prefix('v').is_some_and(|c| {
        let segs: Vec<&str> = c.split('.').collect();
        segs.len() == 3
            && segs
                .iter()
                .all(|s| !s.is_empty() && s.chars().all(|ch| ch.is_ascii_digit()))
    });
    let suffix_ok = suffix.is_some_and(|s| {
        let p = s.strip_prefix("preview.");
        p.is_some_and(|n| !n.is_empty() && n.chars().all(|ch| ch.is_ascii_digit()))
    });
    core_ok && suffix_ok
}

/// 解析 preview tag 的数值四元组 `(major, minor, patch, preview_n)` 供比较。
/// 调用方必须先经 `is_preview_tag` 校验（此处 parse 失败兜底 0，不会发生）。
#[cfg(any(test, not(debug_assertions)))]
fn parse_preview_tag(tag: &str) -> (u64, u64, u64, u64) {
    let without_v = tag.strip_prefix('v').unwrap_or(tag);
    let (core, suffix) = without_v.split_once('-').unwrap_or((without_v, ""));
    let mut segs = core.split('.').map(|s| s.parse::<u64>().unwrap_or(0));
    let major = segs.next().unwrap_or(0);
    let minor = segs.next().unwrap_or(0);
    let patch = segs.next().unwrap_or(0);
    let n = suffix
        .strip_prefix("preview.")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    (major, minor, patch, n)
}

/// 版本号比较键 `(major, minor, patch, rank)`（issue #12 二轮）。
/// rank 语义与 semver precedence 一致：无后缀（stable）= `u64::MAX`
/// （同核心号下 stable > preview.N），`preview.N` = N；其它后缀防御性取 0
/// （发布纪律下不会出现 alpha/beta）。容忍可选 `v` 前缀。纯函数。
#[cfg(any(test, not(debug_assertions)))]
fn version_key(version: &str) -> (u64, u64, u64, u64) {
    let without_v = version.strip_prefix('v').unwrap_or(version);
    let (core, suffix) = without_v.split_once('-').unwrap_or((without_v, ""));
    let mut segs = core.split('.').map(|s| s.parse::<u64>().unwrap_or(0));
    let major = segs.next().unwrap_or(0);
    let minor = segs.next().unwrap_or(0);
    let patch = segs.next().unwrap_or(0);
    let rank = if suffix.is_empty() {
        u64::MAX
    } else {
        suffix
            .strip_prefix("preview.")
            .and_then(|n| n.parse::<u64>().ok())
            .unwrap_or(0)
    };
    (major, minor, patch, rank)
}

/// 双通道候选版本中取 semver 大者的通道（issue #12 二轮 preview 语义）；
/// 键相等（不应发生，防御）取 stable——正式形态优先。纯函数，便于单测。
#[cfg(any(test, not(debug_assertions)))]
fn newer_channel<'a>(
    preview_version: Option<&'a str>,
    stable_version: Option<&'a str>,
) -> Option<&'static str> {
    match (preview_version, stable_version) {
        (Some(p), Some(s)) => {
            if version_key(p) > version_key(s) {
                Some("preview")
            } else {
                Some("stable")
            }
        }
        (Some(_), None) => Some("preview"),
        (None, Some(_)) => Some("stable"),
        (None, None) => None,
    }
}

/// 检查更新结果（序列化给前端，camelCase）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePayload {
    /// 服务器宣布的版本
    pub version: String,
    /// 当前运行版本
    pub current_version: String,
    /// 发布日期（unix 秒，来自 pub_date）
    pub date: Option<i64>,
    /// 更新日志（latest.json 的 notes 字段）
    pub notes: Option<String>,
    /// 本次检查的通道：stable | preview
    pub channel: String,
}

/// `update:progress` 事件载荷
#[cfg(not(debug_assertions))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressPayload {
    /// 已下载字节数
    pub downloaded: usize,
    /// 总字节数（可能未知）
    pub total: Option<u64>,
    /// 阶段：download | install
    pub phase: String,
}

#[cfg(not(debug_assertions))]
fn build_updater(
    app: &AppHandle,
    endpoint: url::Url,
) -> Result<tauri_plugin_updater::Updater, CommandError> {
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| CommandError::Other(format!("updater builder: {e}")))?
        .build()
        .map_err(|e| CommandError::Other(format!("updater build: {e}")))
}

/// 构造 payload（弹窗数据）
#[cfg(not(debug_assertions))]
fn to_payload(update: &tauri_plugin_updater::Update, channel: &str) -> UpdatePayload {
    UpdatePayload {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        date: update.date.map(|d| d.unix_timestamp()),
        notes: update.body.clone(),
        channel: channel.to_string(),
    }
}

/// 按通道解析 endpoint（issue #12 复审：未知通道报错，不静默回退 stable——
/// 通道名传错时静默查错通道比报错更糟）。
#[cfg(not(debug_assertions))]
async fn endpoint_for_channel(
    client: &reqwest::Client,
    channel: &str,
) -> Result<url::Url, CommandError> {
    match channel {
        "stable" => stable_endpoint(),
        "preview" => preview_endpoint(client).await,
        other => Err(CommandError::Other(format!(
            "unknown update channel: {other}"
        ))),
    }
}

/// 按通道解析 endpoint 并构造 updater
#[cfg(not(debug_assertions))]
async fn updater_for_channel(
    app: &AppHandle,
    channel: &str,
) -> Result<tauri_plugin_updater::Updater, CommandError> {
    let client = reqwest::Client::builder()
        .timeout(GITHUB_API_TIMEOUT)
        .build()
        .map_err(|e| CommandError::Other(format!("http client init failed: {e}")))?;
    let endpoint = endpoint_for_channel(&client, channel).await?;
    build_updater(app, endpoint)
}

/// 单 endpoint 检查（构造 updater + check 一次）
#[cfg(not(debug_assertions))]
async fn check_endpoint(
    app: &AppHandle,
    endpoint: url::Url,
) -> Result<Option<tauri_plugin_updater::Update>, CommandError> {
    let updater = build_updater(app, endpoint)?;
    updater
        .check()
        .await
        .map_err(|e| CommandError::Other(format!("update check failed: {e}")))
}

/// 检查是否有更新（debug 构建直接返回「无更新」）。
///
/// **preview 通道语义 = max(preview, stable)**（issue #12 二轮）：preview 收尾
/// 发布 stable 后，只查 preview 端点的用户永远收不到晋升与 stable 热修——
/// 因此 preview 检查同时查 stable，取 semver 大者的通道返回（payload.channel
/// 反映更新实际来源，安装时按该通道解析 endpoint）。preview 端点解析失败
/// （API 限流/无 preview release）降级为仅 stable。
#[tauri::command]
pub async fn check_for_update(
    app: tauri::AppHandle,
    channel: String,
) -> Result<Option<UpdatePayload>, CommandError> {
    #[cfg(debug_assertions)]
    {
        let _ = (&app, &channel);
        return Ok(None);
    }
    #[cfg(not(debug_assertions))]
    {
        let client = reqwest::Client::builder()
            .timeout(GITHUB_API_TIMEOUT)
            .build()
            .map_err(|e| CommandError::Other(format!("http client init failed: {e}")))?;

        match channel.as_str() {
            "stable" => {
                let update = check_endpoint(&app, stable_endpoint()?).await?;
                Ok(update.map(|u| to_payload(&u, "stable")))
            }
            "preview" => {
                let preview_result = async {
                    let endpoint = preview_endpoint(&client).await?;
                    check_endpoint(&app, endpoint).await
                }
                .await;
                let stable_result = check_endpoint(&app, stable_endpoint()?).await;

                match (preview_result, stable_result) {
                    (Ok(preview), Ok(stable)) => {
                        let chosen = newer_channel(
                            preview.as_ref().map(|u| u.version.as_str()),
                            stable.as_ref().map(|u| u.version.as_str()),
                        );
                        Ok(match chosen {
                            Some("preview") => preview.map(|u| to_payload(&u, "preview")),
                            Some("stable") => stable.map(|u| to_payload(&u, "stable")),
                            None => None,
                        })
                    }
                    // 双通道之一失败：另一通道有更新就用它，否则把失败透出
                    // （自动检查静默、手动检查 toast——不因半边失败丢可用更新）。
                    (Ok(preview), Err(e)) => {
                        if preview.is_some() {
                            log::warn!("stable check failed, using preview result: {e}");
                            Ok(preview.map(|u| to_payload(&u, "preview")))
                        } else {
                            Err(e)
                        }
                    }
                    (Err(e), Ok(stable)) => {
                        if stable.is_some() {
                            log::warn!("preview resolution/check failed, falling back to stable: {e}");
                            Ok(stable.map(|u| to_payload(&u, "stable")))
                        } else {
                            Err(e)
                        }
                    }
                    (Err(e_preview), Err(_e_stable)) => Err(e_preview),
                }
            }
            other => Err(CommandError::Other(format!(
                "unknown update channel: {other}"
            ))),
        }
    }
}

/// 下载并安装更新（debug 构建直接成功返回；错误由调用方按语义处理）。
///
/// `expected_version`：弹窗展示的候选版本。安装前必须重检查（设计上 check/install
/// 是两次独立往返），若服务器侧版本已变（展示后发布了新版）则拒绝安装——
/// 前端重新检查即可，防「弹窗展示 X、实际装 Y」的 TOCTOU（issue #12 复审）。
#[tauri::command]
pub async fn download_and_install_update(
    app: tauri::AppHandle,
    channel: String,
    expected_version: Option<String>,
) -> Result<(), CommandError> {
    #[cfg(debug_assertions)]
    {
        let _ = (&app, &channel, &expected_version);
        return Ok(());
    }
    #[cfg(not(debug_assertions))]
    {
        let updater = updater_for_channel(&app, &channel).await?;
        let update = updater
            .check()
            .await
            .map_err(|e| CommandError::Other(format!("update check failed: {e}")))?
            .ok_or_else(|| CommandError::Other("no update available".to_string()))?;

        if let Some(expected) = &expected_version {
            if update.version != *expected {
                return Err(CommandError::Other(format!(
                    "update changed since check: expected {expected}, found {} — re-check required",
                    update.version
                )));
            }
        }

        let app2 = app.clone();
        update
            .download_and_install(
                |downloaded, total| {
                    let _ = app2.emit(
                        "update:progress",
                        UpdateProgressPayload {
                            downloaded,
                            total,
                            phase: "download".to_string(),
                        },
                    );
                },
                || {
                    let _ = app2.emit(
                        "update:progress",
                        UpdateProgressPayload {
                            downloaded: 0,
                            total: None,
                            phase: "install".to_string(),
                        },
                    );
                },
            )
            .await
            .map_err(|e| CommandError::Other(format!("update install failed: {e}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_preview_tag_from_api_response() {
        let json = serde_json::json!([
            { "tag_name": "v0.6.0", "prerelease": false, "draft": false },
            { "tag_name": "v0.6.0-preview.2", "prerelease": true, "draft": false },
            { "tag_name": "v0.6.0-preview.1", "prerelease": true, "draft": false },
            { "tag_name": "vbeta", "prerelease": true, "draft": false }
        ]);
        assert_eq!(
            find_latest_preview_tag(&json).as_deref(),
            Some("v0.6.0-preview.2")
        );
    }

    #[test]
    fn skips_draft_and_non_preview() {
        let json = serde_json::json!([
            { "tag_name": "v0.6.0-preview.3", "prerelease": true, "draft": true },
            { "tag_name": "v0.6.0", "prerelease": false, "draft": false },
            { "tag_name": "v0.5.9", "prerelease": false, "draft": false }
        ]);
        assert_eq!(find_latest_preview_tag(&json), None);
    }

    #[test]
    fn no_releases_means_none() {
        let json = serde_json::json!([]);
        assert_eq!(find_latest_preview_tag(&json), None);
    }

    #[test]
    fn invalid_json_is_none() {
        let json = serde_json::json!({ "not": "an array" });
        assert_eq!(find_latest_preview_tag(&json), None);
    }

    #[test]
    fn tag_matching_is_strict() {
        assert!(is_preview_tag("v0.6.0-preview.2"));
        assert!(is_preview_tag("v10.20.30-preview.100"));
        assert!(!is_preview_tag("v0.6.0"));
        assert!(!is_preview_tag("v0.6.0-preview"));
        assert!(!is_preview_tag("v0.6.0-alpha.1"));
        assert!(!is_preview_tag("v0.6-preview.1"));
        assert!(!is_preview_tag("preview.1"));
        assert!(!is_preview_tag(""));
    }

    /// issue #12 复审：GitHub `/releases` 按创建时间倒序——为旧核心补发的
    /// preview 排在新核心 preview 前面时，必须取版本号最大而非第一个命中。
    #[test]
    fn picks_highest_version_not_first_in_api_order() {
        let json = serde_json::json!([
            { "tag_name": "v0.5.4-preview.3", "prerelease": true, "draft": false },
            { "tag_name": "v0.6.0-preview.1", "prerelease": true, "draft": false }
        ]);
        assert_eq!(
            find_latest_preview_tag(&json).as_deref(),
            Some("v0.6.0-preview.1")
        );
    }

    #[test]
    fn version_comparison_is_numeric_not_lexical() {
        // 0.10.0 > 0.9.9（ lexical 比较会反）；preview.10 > preview.9 同理
        let json = serde_json::json!([
            { "tag_name": "v0.9.9-preview.9", "prerelease": true, "draft": false },
            { "tag_name": "v0.10.0-preview.2", "prerelease": true, "draft": false },
            { "tag_name": "v0.10.0-preview.10", "prerelease": true, "draft": false }
        ]);
        assert_eq!(
            find_latest_preview_tag(&json).as_deref(),
            Some("v0.10.0-preview.10")
        );
    }

    // ==================== issue #12 二轮：version_key / newer_channel ====================

    #[test]
    fn version_key_respects_semver_precedence() {
        // 同核心号：stable > preview.N（晋升判定基础）
        assert!(version_key("0.6.0") > version_key("0.6.0-preview.9"));
        // preview 序号数值比较
        assert!(version_key("0.6.0-preview.10") > version_key("0.6.0-preview.2"));
        // 核心号数值比较（非词典序）
        assert!(version_key("0.10.0") > version_key("0.9.9"));
        assert!(version_key("0.10.0-preview.1") > version_key("0.9.9"));
        // 容忍 v 前缀
        assert_eq!(version_key("v0.6.0"), version_key("0.6.0"));
        // 相等
        assert_eq!(version_key("0.6.0-preview.2"), version_key("v0.6.0-preview.2"));
    }

    #[test]
    fn newer_channel_picks_semver_max() {
        // preview 核心号更高 → preview
        assert_eq!(
            newer_channel(Some("0.6.0-preview.1"), Some("0.5.3")),
            Some("preview")
        );
        // 同核心 stable 已发布 → stable（晋升）
        assert_eq!(
            newer_channel(Some("0.6.0-preview.3"), Some("0.6.0")),
            Some("stable")
        );
        // stable 热修高于旧核心 preview（防御补发旧核心场景）
        assert_eq!(
            newer_channel(Some("0.5.4-preview.1"), Some("0.6.1")),
            Some("stable")
        );
        // 单边候选 / 无候选
        assert_eq!(newer_channel(Some("0.6.0-preview.1"), None), Some("preview"));
        assert_eq!(newer_channel(None, Some("0.5.3")), Some("stable"));
        assert_eq!(newer_channel(None, None), None);
        // 相等（防御）→ stable 优先
        assert_eq!(newer_channel(Some("0.6.0"), Some("0.6.0")), Some("stable"));
    }
}