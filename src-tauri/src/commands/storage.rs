use tauri::State;

use super::CommandError;
use crate::{config, AppState};

// ==================== 命令集 ====================

#[tauri::command]
pub fn save_command_set(
    args: config::SendCommandSetEntry,
    state: State<AppState>,
) -> Result<String, CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let cfg = manager.get_config_mut();
    let id = if args.id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        args.id.clone()
    };
    let mut entry = args;
    entry.id = id.clone();
    if let Some(existing) = cfg.send_command_sets.iter_mut().find(|s| s.id == id) {
        *existing = entry;
    } else {
        cfg.send_command_sets.push(entry);
    }
    manager.save().map_err(|e| CommandError::Config(e.to_string()))?;
    Ok(id)
}

#[tauri::command]
pub fn load_command_sets(
    state: State<AppState>,
) -> Result<Vec<config::SendCommandSetEntry>, CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    Ok(manager.get_config().send_command_sets.clone())
}

#[tauri::command]
pub fn delete_command_set(
    set_id: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager.get_config_mut().send_command_sets.retain(|s| s.id != set_id);
    manager.save().map_err(|e| CommandError::Config(e.to_string()))
}

// ==================== 高亮规则集 ====================

#[tauri::command]
pub fn save_highlight_set(
    args: config::HighlightRuleSetEntry,
    state: State<AppState>,
) -> Result<String, CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let cfg = manager.get_config_mut();
    let id = if args.id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        args.id.clone()
    };
    let mut entry = args;
    entry.id = id.clone();
    if let Some(existing) = cfg.highlight_rule_sets.iter_mut().find(|s| s.id == id) {
        *existing = entry;
    } else {
        cfg.highlight_rule_sets.push(entry);
    }
    manager.save().map_err(|e| CommandError::Config(e.to_string()))?;
    Ok(id)
}

#[tauri::command]
pub fn load_highlight_sets(
    state: State<AppState>,
) -> Result<Vec<config::HighlightRuleSetEntry>, CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    Ok(manager.get_config().highlight_rule_sets.clone())
}

#[tauri::command]
pub fn delete_highlight_set(
    set_id: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager.get_config_mut().highlight_rule_sets.retain(|s| s.id != set_id);
    manager.save().map_err(|e| CommandError::Config(e.to_string()))
}

// ==================== 协议模板 ====================

#[tauri::command]
pub fn save_protocol_template(
    args: config::ProtocolTemplateEntry,
    state: State<AppState>,
) -> Result<String, CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let cfg = manager.get_config_mut();
    let id = if args.id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        args.id.clone()
    };
    let mut entry = args;
    entry.id = id.clone();
    if let Some(existing) = cfg.protocol_templates.iter_mut().find(|s| s.id == id) {
        *existing = entry;
    } else {
        cfg.protocol_templates.push(entry);
    }
    manager.save().map_err(|e| CommandError::Config(e.to_string()))?;
    Ok(id)
}

#[tauri::command]
pub fn load_protocol_templates(
    state: State<AppState>,
) -> Result<Vec<config::ProtocolTemplateEntry>, CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    Ok(manager.get_config().protocol_templates.clone())
}

#[tauri::command]
pub fn delete_protocol_template(
    set_id: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager.get_config_mut().protocol_templates.retain(|s| s.id != set_id);
    manager.save().map_err(|e| CommandError::Config(e.to_string()))
}

// ==================== 端口参数预设 ====================

#[tauri::command]
pub fn save_port_preset(
    args: config::PortPresetEntry,
    state: State<AppState>,
) -> Result<String, CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let cfg = manager.get_config_mut();
    let id = if args.id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        args.id.clone()
    };
    let mut entry = args;
    entry.id = id.clone();
    if let Some(existing) = cfg.port_presets.iter_mut().find(|s| s.id == id) {
        *existing = entry;
    } else {
        cfg.port_presets.push(entry);
    }
    manager.save().map_err(|e| CommandError::Config(e.to_string()))?;
    Ok(id)
}

#[tauri::command]
pub fn load_port_presets(
    state: State<AppState>,
) -> Result<Vec<config::PortPresetEntry>, CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    Ok(manager.get_config().port_presets.clone())
}

#[tauri::command]
pub fn delete_port_preset(
    preset_id: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager.get_config_mut().port_presets.retain(|s| s.id != preset_id);
    manager.save().map_err(|e| CommandError::Config(e.to_string()))
}

// ==================== 外部工具配置 ====================

#[tauri::command]
pub fn save_port_tool_config(
    args: config::PortToolConfigEntry,
    state: State<AppState>,
) -> Result<String, CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let cfg = manager.get_config_mut();
    let id = if args.id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        args.id.clone()
    };
    let mut entry = args;
    entry.id = id.clone();
    if let Some(existing) = cfg.port_tool_configs.iter_mut().find(|s| s.id == id) {
        *existing = entry;
    } else {
        cfg.port_tool_configs.push(entry);
    }
    manager.save().map_err(|e| CommandError::Config(e.to_string()))?;
    Ok(id)
}

#[tauri::command]
pub fn load_port_tool_configs(
    state: State<AppState>,
) -> Result<Vec<config::PortToolConfigEntry>, CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    Ok(manager.get_config().port_tool_configs.clone())
}

#[tauri::command]
pub fn delete_port_tool_config(
    config_id: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager.get_config_mut().port_tool_configs.retain(|s| s.id != config_id);
    manager.save().map_err(|e| CommandError::Config(e.to_string()))
}

// ==================== 串口分组 ====================

/// 整体替换保存全部串口分组（issue #2-3）。
/// 分组是「一个整体布局」而非独立实体：前端在分组变更（增删/改名/展开/
/// 拖拽成员）后防抖发送完整列表，这里一次替换并落盘 config.json。
/// 读取不需要专门命令——`get_config` 已随 `AppConfig.port_groups` 返回。
#[tauri::command]
pub fn save_port_groups(
    args: Vec<config::PortGroupEntry>,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager.get_config_mut().port_groups = args;
    manager.save().map_err(|e| CommandError::Config(e.to_string()))
}

// ==================== 条件触发规则 ====================

#[tauri::command]
pub fn save_trigger_rule(
    args: config::TriggerRuleEntry,
    state: State<AppState>,
) -> Result<String, CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    let cfg = manager.get_config_mut();
    let id = if args.id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        args.id.clone()
    };
    let mut entry = args;
    entry.id = id.clone();
    if let Some(existing) = cfg.trigger_rules.iter_mut().find(|s| s.id == id) {
        *existing = entry;
    } else {
        cfg.trigger_rules.push(entry);
    }
    manager.save().map_err(|e| CommandError::Config(e.to_string()))?;
    Ok(id)
}

#[tauri::command]
pub fn load_trigger_rules(
    state: State<AppState>,
) -> Result<Vec<config::TriggerRuleEntry>, CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    Ok(manager.get_config().trigger_rules.clone())
}

#[tauri::command]
pub fn delete_trigger_rule(
    rule_id: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    manager.get_config_mut().trigger_rules.retain(|s| s.id != rule_id);
    manager.save().map_err(|e| CommandError::Config(e.to_string()))
}
