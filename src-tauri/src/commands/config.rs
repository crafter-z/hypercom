use tauri::{Manager, State};

use super::CommandError;
use crate::{config, AppState};

/// 获取当前应用配置
#[tauri::command]
pub fn get_config(state: State<AppState>) -> Result<config::AppConfig, CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    Ok(manager.get_config().clone())
}

fn preserve_plugin_configs(
    new_config: &mut config::AppConfig,
    current: &config::AppConfig,
    restore_plugin_configs: bool,
) {
    if !restore_plugin_configs {
        new_config.entities.plugin_configs = current.entities.plugin_configs.clone();
    } else {
        let imported = std::mem::take(&mut new_config.entities.plugin_configs);
        // Restore grants only for the exact installed code originally reviewed.
        new_config.entities.plugin_configs = current.entities.plugin_configs.iter().map(|entry| {
            let mut restored = entry.clone();
            if let Some(saved) = imported.iter().find(|saved| saved.id == entry.id
                && !saved.install_generation.is_empty()
                && saved.install_generation == entry.install_generation) {
                restored.enabled = saved.enabled;
                restored.granted_permissions = saved.granted_permissions.clone();
            } else if imported.iter().any(|saved| saved.id == entry.id) {
                restored.enabled = false;
                restored.granted_permissions.clear();
            }
            restored
        }).collect();
    }
}

/// 更新应用配置。
///
/// 落盘后把配置中属于「运行期镜像」的部分（日志设置 + 诊断日志开关）应用到
/// `AppState::apply_runtime_config`——唯一同步入口。此前这里是逐字段手抄的
/// setter 列表，与 `AppState::new` 的第二份列表并存，新增字段时必然漏同步一处。
#[tauri::command]
pub async fn set_config(
    mut new_config: config::AppConfig,
    expected_revision: Option<u64>,
    restore_plugin_configs: Option<bool>,
    source: tauri::Webview,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    let _plugin_io = state.plugin_io.lock().await;
    crate::plugin::view_runtime::require_main(&source)?;
    if restore_plugin_configs.unwrap_or(false) {
        let restored = {
            let manager = state.config_manager.lock().map_err(|e| CommandError::Lock(e.to_string()))?;
            preserve_plugin_configs(&mut new_config, manager.get_config(), true);
            new_config.entities.plugin_configs.clone()
        };
        for entry in restored {
            if !entry.enabled { crate::plugin::view_runtime::retire_plugin(source.app_handle(), &entry.id).await?; }
            else { crate::plugin::view_runtime::retire_denied(source.app_handle(), &entry.id, &entry.granted_permissions).await?; }
        }
    }
    let (saved, cfg) = {
        let mut manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        // Backup import deliberately replaces the entire configuration. Ordinary saves
        // need the revision observed before collecting their frontend snapshot.
        let restore = restore_plugin_configs.unwrap_or(false);
        let saved = if restore {
            preserve_plugin_configs(&mut new_config, manager.get_config(), true);
            manager.set_config(new_config)
                .map_err(|e| CommandError::Config(e.to_string()))?;
            true
        } else {
            let expected = expected_revision.ok_or_else(|| {
                CommandError::Config("Normal config saves require expectedRevision".into())
            })?;
            if manager.get_config().revision != expected {
                false
            } else {
                // The revision check, plugin grant preservation, and disk write all
                // happen under the same config_manager lock.
                preserve_plugin_configs(&mut new_config, manager.get_config(), false);
                manager.set_config_if_revision(new_config, expected)
                    .map_err(|e| CommandError::Config(e.to_string()))?
            }
        };
        (saved, saved.then(|| manager.get_config().clone()))
    };
    if let Some(cfg) = cfg {
        state.apply_runtime_config(&cfg);
    }
    Ok(saved)
}

/// 保存会话快照到独立 session.json（不触发 config .bak 备份）
#[tauri::command]
pub fn update_session_snapshot(
    snapshot: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager
        .save_session_snapshot(&snapshot)
        .map_err(|e| CommandError::Config(e.to_string()))
}

/// 读取会话快照
#[tauri::command]
pub fn get_session_snapshot(state: State<AppState>) -> Result<String, CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    Ok(manager.load_session_snapshot())
}

/// 返回当前生效的配置文件绝对路径
#[tauri::command]
pub fn get_config_path(state: State<AppState>) -> Result<String, CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    Ok(manager.config_path().display().to_string())
}

#[cfg(test)]
mod tests {
    use crate::commands::config::preserve_plugin_configs;
    use crate::config::{AppConfig, PluginConfigEntry};

    #[test]
    fn normal_config_save_keeps_current_plugin_authorization() {
        let mut current = AppConfig::default();
        current.entities.plugin_configs.push(PluginConfigEntry {
            id: "com.example.plugin".into(),
            install_generation: "test-generation".into(),
            enabled: false,
            granted_permissions: Vec::new(),
            installed_at: None,
            source: None,
        });
        let mut old_draft = current.clone();
        old_draft.entities.plugin_configs[0].enabled = true;
        old_draft.entities.plugin_configs[0].granted_permissions.push("serial:send".into());

        preserve_plugin_configs(&mut old_draft, &current, false);
        assert!(!old_draft.entities.plugin_configs[0].enabled);
        assert!(old_draft.entities.plugin_configs[0].granted_permissions.is_empty());

        let mut restore = old_draft.clone();
        restore.entities.plugin_configs[0].enabled = true;
        preserve_plugin_configs(&mut restore, &current, true);
        assert!(restore.entities.plugin_configs[0].enabled);
    }

    #[test]
    fn import_cannot_revive_prior_install_identity_or_grants() {
        let mut current = AppConfig::default();
        current.entities.plugin_configs.push(PluginConfigEntry {
            id: "com.example.plugin".into(), install_generation: "new".into(),
            enabled: false, granted_permissions: Vec::new(), installed_at: None, source: None,
        });
        let mut imported = current.clone();
        imported.entities.plugin_configs[0].install_generation = "old".into();
        imported.entities.plugin_configs[0].enabled = true;
        imported.entities.plugin_configs[0].granted_permissions.push("serial:send".into());
        preserve_plugin_configs(&mut imported, &current, true);
        assert_eq!(imported.entities.plugin_configs[0].install_generation, "new");
        assert!(!imported.entities.plugin_configs[0].enabled);
        assert!(imported.entities.plugin_configs[0].granted_permissions.is_empty());
    }
}
