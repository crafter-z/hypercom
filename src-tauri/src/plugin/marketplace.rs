//! Marketplace metadata wire types and validation.
//!
//! Marketplace documents are deliberately kept separate from the installed
//! plugin manifest.  The index only contains metadata URLs; each metadata
//! document carries the manifest that is reviewed before its archive is
//! downloaded.

use serde::{Deserialize, Serialize};

use super::PluginManifest;

/// The first marketplace document schema understood by HyperCom.
pub const MARKETPLACE_SCHEMA_VERSION: u32 = 1;
/// Prevent an index from turning one check into an unbounded fan-out.
pub const MAX_MARKETPLACE_PLUGINS: usize = 256;
/// Metadata is small by design; archives are downloaded separately.
pub const MAX_METADATA_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MarketplaceIndex {
    pub schema_version: u32,
    pub plugins: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginDescription {
    pub schema_version: u32,
    pub manifest: PluginManifest,
    pub download_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_notes: Option<String>,
}

/// Validate an external URL used by the marketplace transport.
///
/// Credentials, fragments and non-HTTP schemes are rejected.  HTTPS is
/// recommended by deployment policy; HTTP remains accepted for local/private
/// mirrors, while UpdateNetwork prevents HTTPS-to-HTTP redirect downgrades.
pub fn validate_url(raw: &str, label: &str) -> Result<url::Url, String> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(format!("{label} 不能为空"));
    }
    let parsed = url::Url::parse(value).map_err(|e| format!("{label} URL 无效: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("{label} URL 必须使用 http 或 https"));
    }
    if parsed.host_str().is_none() {
        return Err(format!("{label} URL 缺少主机名"));
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return Err(format!("{label} URL 不得包含凭据"));
    }
    if parsed.fragment().is_some() {
        return Err(format!("{label} URL 不得包含 fragment"));
    }
    Ok(parsed)
}

pub fn parse_index(bytes: &[u8]) -> Result<MarketplaceIndex, String> {
    if bytes.len() > MAX_METADATA_BYTES {
        return Err("插件市场索引超过 1 MiB".into());
    }
    let index: MarketplaceIndex =
        serde_json::from_slice(bytes).map_err(|e| format!("插件市场索引 JSON 无效: {e}"))?;
    if index.schema_version != MARKETPLACE_SCHEMA_VERSION {
        return Err(format!(
            "不支持的插件市场索引 schemaVersion: {}",
            index.schema_version
        ));
    }
    if index.plugins.len() > MAX_MARKETPLACE_PLUGINS {
        return Err(format!(
            "插件市场索引最多包含 {MAX_MARKETPLACE_PLUGINS} 个插件"
        ));
    }
    for (index, raw) in index.plugins.iter().enumerate() {
        validate_url(raw, &format!("插件市场索引 plugins[{index}]"))?;
    }
    Ok(index)
}

pub fn parse_description(bytes: &[u8]) -> Result<PluginDescription, String> {
    if bytes.len() > MAX_METADATA_BYTES {
        return Err("插件市场插件描述超过 1 MiB".into());
    }
    let description: PluginDescription =
        serde_json::from_slice(bytes).map_err(|e| format!("插件描述 JSON 无效: {e}"))?;
    if description.schema_version != MARKETPLACE_SCHEMA_VERSION {
        return Err(format!(
            "不支持的插件描述 schemaVersion: {}",
            description.schema_version
        ));
    }
    description
        .manifest
        .validate()
        .map_err(|e| format!("插件描述 manifest 无效: {e}"))?;
    validate_url(&description.download_url, "插件描述 downloadUrl")?;
    if let Some(homepage) = &description.homepage {
        validate_url(homepage, "插件描述 homepage")?;
    }
    Ok(description)
}

#[cfg(test)]
mod tests {
    use super::{
        metadata_matches, parse_description, parse_index, validate_url, MARKETPLACE_SCHEMA_VERSION,
    };

    fn manifest() -> serde_json::Value {
        serde_json::json!({
            "id": "com.example.market",
            "name": "Market",
            "version": "1.2.3",
            "apiVersion": "1.0",
            "entry": "main.js",
            "permissions": []
        })
    }

    #[test]
    fn parses_index_and_description_wire_shape() {
        let index = parse_index(
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": MARKETPLACE_SCHEMA_VERSION,
                "plugins": ["https://example.test/plugins.json"]
            }))
            .unwrap()
            .as_slice(),
        )
        .unwrap();
        assert_eq!(index.plugins.len(), 1);

        let description = parse_description(
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": MARKETPLACE_SCHEMA_VERSION,
                "manifest": manifest(),
                "downloadUrl": "https://example.test/plugin.zip",
                "homepage": "https://example.test",
                "releaseNotes": "Bug fixes"
            }))
            .unwrap()
            .as_slice(),
        )
        .unwrap();
        assert_eq!(description.manifest.id, "com.example.market");
        assert_eq!(description.manifest.version, "1.2.3");
        assert!(metadata_matches(&description, "com.example.market", "1.2.3").is_ok());
        assert!(metadata_matches(&description, "com.example.other", "1.2.3").is_err());
        assert!(metadata_matches(&description, "com.example.market", "1.2.4").is_err());
    }

    #[test]
    fn rejects_unknown_fields_and_invalid_homepage() {
        let mut value = serde_json::json!({
            "schemaVersion": 1,
            "manifest": manifest(),
            "downloadUrl": "https://example.test/plugin.zip"
        });
        value["unexpected"] = serde_json::Value::Bool(true);
        assert!(parse_description(&serde_json::to_vec(&value).unwrap()).is_err());
        value.as_object_mut().unwrap().remove("unexpected");
        value["homepage"] = serde_json::Value::String("file:///tmp/homepage".into());
        assert!(parse_description(&serde_json::to_vec(&value).unwrap()).is_err());
    }

    #[test]
    fn rejects_index_count_and_metadata_size_limits() {
        let too_many = serde_json::json!({
            "schemaVersion": 1,
            "plugins": (0..257)
                .map(|n| format!("https://example.test/{n}.json"))
                .collect::<Vec<_>>()
        });
        assert!(parse_index(&serde_json::to_vec(&too_many).unwrap()).is_err());
        assert!(parse_index(&vec![b' '; super::MAX_METADATA_BYTES + 1]).is_err());
        assert!(parse_description(&vec![b' '; super::MAX_METADATA_BYTES + 1]).is_err());
    }

    #[test]
    fn rejects_wrong_schema_and_unsafe_urls() {
        let index = serde_json::json!({"schemaVersion": 2, "plugins": []});
        assert!(parse_index(&serde_json::to_vec(&index).unwrap()).is_err());
        assert!(validate_url("file:///tmp/index.json", "source").is_err());
        assert!(validate_url("https://user:password@example.test/index.json", "source").is_err());
        assert!(validate_url("https://example.test/index.json#fragment", "source").is_err());
    }

    #[test]
    fn rejects_invalid_manifest_and_description_url() {
        let description = serde_json::json!({
            "schemaVersion": 1,
            "manifest": manifest(),
            "downloadUrl": "file:///tmp/plugin.zip"
        });
        assert!(parse_description(&serde_json::to_vec(&description).unwrap()).is_err());
    }
}

pub(crate) fn is_update_available(current: Option<&str>, remote: &str) -> bool {
    match current {
        None => true,
        Some(current) => super::version_greater(remote, current),
    }
}

pub(crate) fn metadata_matches(
    description: &PluginDescription,
    expected_id: &str,
    expected_version: &str,
) -> Result<(), String> {
    if description.manifest.id != expected_id {
        return Err(format!(
            "插件描述 id 不匹配：期望 {expected_id}，实际 {}",
            description.manifest.id
        ));
    }
    if description.manifest.version != expected_version {
        return Err(format!(
            "插件描述 version 不匹配：期望 {expected_version}，实际 {}",
            description.manifest.version
        ));
    }
    Ok(())
}
