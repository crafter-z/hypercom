/**
 * 自动更新命令（issue #12）
 *
 * 架构要点：
 * - JS `check()` 无法在运行时指定 endpoint → 整个更新链路由本模块承载，
 *   经 `app.updater_builder().endpoints(vec![url])` 在运行时选择通道。
 * - stable 通道：`releases/latest/download/latest.json`（GitHub 原生「最新非
 *   prerelease」指针，永不泄漏 preview）。
 * - preview 通道：先经 GitHub API（`/releases?per_page=100`，含 prerelease）
 *   解析出最新 preview tag，再指向 `releases/download/<tag>/latest.json`
 *   （唯一 tag 不受影响，preview→preview 自动升级可用）。
 * - 双层门控：与 simulation.rs 同款三态——release 构建走真实逻辑；
 *   debug 构建（`cargo check`/`tauri dev`）命令直接返回 Ok(None)/Ok(())；
 *   纯解析函数 `#[cfg(any(test, not(debug_assertions)))]`（测试在 debug
 *   构建下也要能跑）。前端另有 `import.meta.env.DEV` 短路。
 * - 下载进度经 `update:progress` 事件推给前端（Emitter::emit）。
 */
use serde::Serialize;

use crate::commands::CommandError;

#[cfg(not(debug_assertions))]
use tauri::{AppHandle, Emitter};

#[cfg(not(debug_assertions))]
use tauri_plugin_updater::UpdaterExt;

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

/// 从 GitHub API `/releases` 响应中取第一个满足条件的最新 preview tag：
/// - 非 draft、是 prerelease
/// - tag 匹配 `vX.Y.Z-preview.N`（如 `v0.6.0-preview.2`）
/// 纯函数，便于单测（M1.2b）。
#[cfg(any(test, not(debug_assertions)))]
pub fn find_latest_preview_tag(releases: &serde_json::Value) -> Option<String> {
    let arr = releases.as_array()?;
    arr.iter()
        .filter(|r| {
            let draft = r.get("draft").and_then(|v| v.as_bool()).unwrap_or(false);
            let pre = r.get("prerelease").and_then(|v| v.as_bool()).unwrap_or(false);
            !draft && pre
        })
        .map(|r| r.get("tag_name").and_then(|v| v.as_str()).unwrap_or(""))
        .find(|tag| regex_matches_preview_tag(tag))
        .filter(|tag| !tag.is_empty())
        .map(|tag| tag.to_string())
}

/// tag 是否匹配 `vX.Y.Z-preview.N`（如 `v0.6.0-preview.2`）
#[cfg(any(test, not(debug_assertions)))]
fn regex_matches_preview_tag(tag: &str) -> bool {
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

/// 按通道解析 endpoint 并构造 updater
#[cfg(not(debug_assertions))]
async fn updater_for_channel(
    app: &AppHandle,
    channel: &str,
) -> Result<tauri_plugin_updater::Updater, CommandError> {
    let client = reqwest::Client::new();
    let endpoint = match channel {
        "preview" => preview_endpoint(&client).await?,
        _ => stable_endpoint()?,
    };
    build_updater(app, endpoint)
}

/// 检查是否有更新（debug 构建直接返回「无更新」）
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
        let updater = updater_for_channel(&app, &channel).await?;
        match updater.check().await {
            Ok(Some(update)) => Ok(Some(to_payload(&update, &channel))),
            Ok(None) => Ok(None),
            Err(e) => Err(CommandError::Other(format!("update check failed: {e}"))),
        }
    }
}

/// 下载并安装更新（debug 构建直接成功返回；错误由调用方按语义处理）
#[tauri::command]
pub async fn download_and_install_update(
    app: tauri::AppHandle,
    channel: String,
) -> Result<(), CommandError> {
    #[cfg(debug_assertions)]
    {
        let _ = (&app, &channel);
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
        assert!(regex_matches_preview_tag("v0.6.0-preview.2"));
        assert!(regex_matches_preview_tag("v10.20.30-preview.100"));
        assert!(!regex_matches_preview_tag("v0.6.0"));
        assert!(!regex_matches_preview_tag("v0.6.0-preview"));
        assert!(!regex_matches_preview_tag("v0.6.0-alpha.1"));
        assert!(!regex_matches_preview_tag("v0.6-preview.1"));
        assert!(!regex_matches_preview_tag("preview.1"));
        assert!(!regex_matches_preview_tag(""));
    }
}