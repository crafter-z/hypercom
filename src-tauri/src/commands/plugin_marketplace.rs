//! Marketplace commands.
//!
//! Metadata and archives are fetched before acquiring `AppState::plugin_io`.
//! Only package preparation and the durable install transaction use that gate;
//! a slow marketplace mirror therefore cannot block local plugin operations.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{Manager, State, WebviewWindow};

use super::{
    acquire_plugin_io, install_prepared, require_main_window, schedule_plugin_sweep, CommandError,
    PluginStateSnapshot,
};
use crate::plugin::{
    self,
    marketplace::{self, MarketplaceIndex, PluginDescription},
};
use crate::update_network::{UpdateNetwork, DOWNLOAD_TIMEOUT};
use crate::AppState;

const MARKETPLACE_USER_AGENT: &str = "hypercom-plugin-marketplace";

/// Marketplace update data returned to the frontend.  The full manifest is
/// included so the confirmation view can display exactly what was reviewed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceUpdate {
    pub id: String,
    pub latest_version: String,
    pub description_url: String,
    pub manifest: plugin::PluginManifest,
    pub download_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version: Option<String>,
    pub update_available: bool,
}

struct RemoteArchive {
    directory: PathBuf,
    path: PathBuf,
}

impl Drop for RemoteArchive {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn marketplace_error(message: impl Into<String>) -> CommandError {
    CommandError::Other(message.into())
}

fn configured_marketplace_url(state: &AppState) -> Result<String, CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let value = manager
        .get_config()
        .plugin_marketplace_url
        .trim()
        .to_string();
    if value.is_empty() {
        return Err(marketplace_error("插件市场尚未配置 URL"));
    }
    Ok(value)
}

async fn fetch_remote_bytes(
    network: &UpdateNetwork,
    url: &url::Url,
    label: &str,
    max_bytes: u64,
) -> Result<Vec<u8>, CommandError> {
    network.prepare(url).await.map_err(marketplace_error)?;
    let client = network
        .configure(reqwest::Client::builder())
        .timeout(DOWNLOAD_TIMEOUT)
        .user_agent(MARKETPLACE_USER_AGENT)
        .build()
        .map_err(|e| marketplace_error(format!("{label} HTTP 客户端初始化失败: {e}")))?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|e| marketplace_error(format!("{label} 下载失败: {e}")))?;
    if !response.status().is_success() {
        return Err(marketplace_error(format!(
            "{label} 返回 HTTP 状态 {}",
            response.status()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
    {
        return Err(marketplace_error(format!(
            "{label} 超过 {} MiB 大小限制",
            max_bytes / (1024 * 1024)
        )));
    }
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| marketplace_error(format!("{label} 读取失败: {e}")))?
    {
        if bytes.len().saturating_add(chunk.len()) as u64 > max_bytes {
            return Err(marketplace_error(format!(
                "{label} 超过 {} MiB 大小限制",
                max_bytes / (1024 * 1024)
            )));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn fetch_index(
    network: &UpdateNetwork,
    source_url: &str,
) -> Result<MarketplaceIndex, CommandError> {
    let url =
        marketplace::validate_url(source_url, "插件市场 sourceUrl").map_err(marketplace_error)?;
    let bytes = fetch_remote_bytes(
        network,
        &url,
        "插件市场索引",
        marketplace::MAX_METADATA_BYTES as u64,
    )
    .await?;
    marketplace::parse_index(&bytes).map_err(marketplace_error)
}

async fn fetch_description(
    network: &UpdateNetwork,
    metadata_url: &str,
) -> Result<PluginDescription, CommandError> {
    let url = marketplace::validate_url(metadata_url, "插件描述 metadataUrl")
        .map_err(marketplace_error)?;
    let bytes = fetch_remote_bytes(
        network,
        &url,
        "插件描述",
        marketplace::MAX_METADATA_BYTES as u64,
    )
    .await?;
    marketplace::parse_description(&bytes).map_err(marketplace_error)
}

/// Fetch and validate a marketplace index from an explicit source URL.
#[tauri::command]
pub async fn fetch_plugin_marketplace(
    source_url: String,
    window: WebviewWindow,
) -> Result<MarketplaceIndex, CommandError> {
    require_main_window(&window)?;
    let network = UpdateNetwork::new().await.map_err(marketplace_error)?;
    fetch_index(&network, &source_url).await
}

/// Check every metadata URL in the configured marketplace index.
#[tauri::command]
pub async fn check_plugin_updates(
    source_url: Option<String>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Vec<MarketplaceUpdate>, CommandError> {
    require_main_window(&window)?;
    let source_url = source_url
        .filter(|url| !url.trim().is_empty())
        .unwrap_or(configured_marketplace_url(&state)?);
    let network = UpdateNetwork::new().await.map_err(marketplace_error)?;
    let index = fetch_index(&network, &source_url).await?;

    // Take only immutable version facts before network I/O.  No config mutex is
    // held while metadata URLs are fetched.
    let installed: std::collections::HashSet<String> = {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager
            .get_config()
            .entities
            .plugin_configs
            .iter()
            .filter(|entry| !entry.install_generation.is_empty())
            .map(|entry| entry.id.clone())
            .collect()
    };
    // The map above intentionally stores identity only; installed versions are
    // authoritative on disk, so resolve them from manifests without taking the
    // config lock across network operations.  A missing/corrupt local install is
    // represented as no current version (and is therefore installable).
    let installed_root = {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager.plugins_dir().to_path_buf()
    };

    let mut updates = Vec::with_capacity(index.plugins.len());
    for metadata_url in index.plugins {
        let description = fetch_description(&network, &metadata_url).await?;
        let current_version = if installed.contains(&description.manifest.id) {
            plugin::load_manifest_lite(&installed_root.join(&description.manifest.id))
                .ok()
                .map(|manifest| manifest.version)
        } else {
            None
        };
        let update_available = marketplace::is_update_available(
            current_version.as_deref(),
            &description.manifest.version,
        );
        updates.push(MarketplaceUpdate {
            id: description.manifest.id.clone(),
            latest_version: description.manifest.version.clone(),
            description_url: metadata_url,
            manifest: description.manifest,
            download_url: description.download_url,
            homepage: description.homepage,
            release_notes: description.release_notes,
            current_version,
            update_available,
        });
    }
    Ok(updates)
}

fn archive_path() -> Result<RemoteArchive, CommandError> {
    let parent = std::env::temp_dir()
        .canonicalize()
        .map_err(|e| marketplace_error(format!("系统临时目录不可达: {e}")))?;
    let directory = parent.join(format!("hypercom_marketplace_{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&directory)
        .map_err(|e| marketplace_error(format!("创建插件市场临时目录失败: {e}")))?;
    Ok(RemoteArchive {
        path: directory.join("plugin.zip"),
        directory,
    })
}

async fn download_archive(
    network: &UpdateNetwork,
    download_url: &str,
) -> Result<RemoteArchive, CommandError> {
    let url = marketplace::validate_url(download_url, "插件描述 downloadUrl")
        .map_err(marketplace_error)?;
    let bytes =
        fetch_remote_bytes(network, &url, "插件 ZIP", plugin::MAX_ZIP_ARCHIVE_BYTES).await?;
    let archive = archive_path()?;
    let path = archive.path.clone();
    tokio::task::spawn_blocking(move || std::fs::write(&path, bytes))
        .await
        .map_err(|e| marketplace_error(format!("写入插件 ZIP 临时文件失败: {e}")))?
        .map_err(|e| marketplace_error(format!("写入插件 ZIP 临时文件失败: {e}")))?;
    Ok(archive)
}

/// Download, verify and transactionally install one marketplace plugin.
///
/// `expected_generation` is optional only for a new install.  For an existing
/// plugin the commit path rejects a missing or stale generation, after all
/// network and package preparation has completed.
#[tauri::command]
pub async fn install_marketplace_plugin(
    metadata_url: String,
    expected_id: String,
    expected_version: String,
    expected_generation: Option<String>,
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<PluginStateSnapshot, CommandError> {
    require_main_window(&window)?;
    plugin::validate_plugin_id(&expected_id).map_err(CommandError::Other)?;
    if plugin::parse_semver(&expected_version).is_none() {
        return Err(marketplace_error("expectedVersion 不是合法 semver"));
    }

    // All network work intentionally precedes plugin_io acquisition.
    let network = UpdateNetwork::new().await.map_err(marketplace_error)?;
    let description = fetch_description(&network, &metadata_url).await?;
    marketplace::metadata_matches(&description, &expected_id, &expected_version)
        .map_err(marketplace_error)?;
    let archive = download_archive(&network, &description.download_url).await?;

    let plugin_io = acquire_plugin_io(&state).await?;
    let root = {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        manager.plugins_dir().to_path_buf()
    };
    let zip_path = archive.path.clone();
    let download_url = description.download_url.clone();
    let prepared = tokio::task::spawn_blocking(move || {
        super::plugin::prepare_plugin_install_with_metadata(
            zip_path
                .to_str()
                .ok_or_else(|| marketplace_error("插件 ZIP 路径无效"))?,
            &root,
            false,
            Some("marketplace"),
            Some(download_url),
        )
    })
    .await
    .map_err(|e| marketplace_error(format!("插件安装暂存 join 失败: {e}")))??;

    let package_manifest = super::plugin::prepared_manifest(&prepared);
    if package_manifest.id != description.manifest.id
        || package_manifest.version != description.manifest.version
    {
        return Err(marketplace_error(
            "插件 ZIP manifest 与插件描述的 id/version 不一致",
        ));
    }

    // Recheck current identity before retiring runtime views and again inside
    // install_prepared immediately before the first durable rename.
    {
        let manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        if manager
            .get_config()
            .entities
            .plugin_configs
            .iter()
            .any(|entry| entry.id == expected_id)
            && expected_generation.as_deref().is_none_or(str::is_empty)
        {
            return Err(marketplace_error(
                "更新已安装插件必须携带 expectedGeneration",
            ));
        }
    }
    state.plugin_http.cancel_plugin(&expected_id);
    state.plugin_shell.cancel_plugin(&expected_id);
    super::plugin::retire_plugin_file_io(&state, &expected_id);
    plugin::view_runtime::retire_plugin(window.app_handle(), &expected_id).await?;

    let result = tokio::task::block_in_place(|| {
        let mut manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        install_prepared(&mut manager, prepared, expected_generation.as_deref())
    });
    drop(plugin_io);
    schedule_plugin_sweep(window.app_handle().clone());
    result
}

#[cfg(test)]
mod tests {
    use super::MarketplaceUpdate;
    use crate::plugin::marketplace::is_update_available;

    #[test]
    fn update_wire_shape_serializes_expected_fields() {
        let value = serde_json::to_value(MarketplaceUpdate {
            id: "com.example.test".into(),
            latest_version: "1.1.0".into(),
            description_url: "https://example.test/plugin.json".into(),
            manifest: serde_json::from_value(serde_json::json!({
                "id":"com.example.test", "name":"Test", "version":"1.1.0",
                "apiVersion":"1.0", "entry":"main.js", "permissions":[]
            }))
            .unwrap(),
            download_url: "https://example.test/plugin.zip".into(),
            homepage: None,
            release_notes: Some("Fixes".into()),
            current_version: Some("1.0.0".into()),
            update_available: true,
        })
        .unwrap();
        assert_eq!(value["id"], "com.example.test");
        assert_eq!(value["latestVersion"], "1.1.0");
        assert_eq!(value["descriptionUrl"], "https://example.test/plugin.json");
        assert_eq!(value["manifest"]["version"], "1.1.0");
        assert_eq!(value["updateAvailable"], true);
        assert!(value.get("homepage").is_none());
        assert_eq!(value["releaseNotes"], "Fixes");
    }

    #[test]
    fn update_comparison_uses_strict_semver() {
        assert!(is_update_available(Some("1.0.0"), "1.0.1"));
        assert!(!is_update_available(Some("1.0.1"), "1.0.0"));
        assert!(is_update_available(None, "1.0.0"));
    }
}
