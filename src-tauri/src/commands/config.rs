use tauri::State;

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
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    let _plugin_io = state.plugin_io.lock().await;
    let (saved, cfg) = {
        let mut manager = state
            .config_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        // Backup import deliberately replaces the entire configuration. Ordinary saves
        // need the revision observed before collecting their frontend snapshot.
        let restore = restore_plugin_configs.unwrap_or(false);
        let saved = if restore {
            // Import is an intentional full replacement, including plugin grants.
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
}
