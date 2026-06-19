use serde::Deserialize;
use tauri::State;

use super::CommandError;
use crate::{storage, AppState};

/// 保存命令集
#[derive(Debug, Deserialize)]
pub struct SaveCommandSetArgs {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub is_loop: bool,
    pub loop_delay_ms: i32,
    pub commands: Vec<SaveCommandArgs>,
}

#[derive(Debug, Deserialize)]
pub struct SaveCommandArgs {
    pub id: String,
    pub name: String,
    pub order_idx: i32,
    pub delay_ms: i32,
    pub cmd_type: String,
    pub content: String,
    pub append_line_ending: String,
}

#[tauri::command]
pub async fn save_command_set(
    args: SaveCommandSetArgs,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    let pool = {
        let storage_mgr = state
            .storage_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let db_pool = storage_mgr
            .pool()
            .map_err(|e| CommandError::Storage(e.to_string()))?;
        db_pool.clone()
    };
    let is_update = args.id.is_some();
    let set_id = args.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // If updating existing set, delete old one first to avoid duplicates
    if is_update {
        let _ = storage::delete_command_set_from_db(&pool, &set_id).await;
    }
    let set = storage::SendCommandSet {
        id: set_id.clone(),
        name: args.name,
        is_loop: args.is_loop,
        loop_delay_ms: args.loop_delay_ms,
        commands: args
            .commands
            .into_iter()
            .map(|c| storage::SendCommandRow {
                id: c.id,
                set_id: set_id.clone(),
                name: c.name,
                order_idx: c.order_idx,
                delay_ms: c.delay_ms,
                cmd_type: c.cmd_type,
                content: c.content,
                append_line_ending: c.append_line_ending,
            })
            .collect(),
    };
    storage::save_command_set_to_db(&pool, &set)
        .await
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    Ok(set_id)
}

#[tauri::command]
pub async fn load_command_sets(
    state: State<'_, AppState>,
) -> Result<Vec<storage::SendCommandSet>, CommandError> {
    let pool = {
        let storage_mgr = state
            .storage_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let db_pool = storage_mgr
            .pool()
            .map_err(|e| CommandError::Storage(e.to_string()))?;
        db_pool.clone()
    };
    let sets = storage::load_command_sets_from_db(&pool)
        .await
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    Ok(sets
        .into_iter()
        .map(|s| storage::SendCommandSet {
            id: s.id,
            name: s.name,
            is_loop: s.is_loop,
            loop_delay_ms: s.loop_delay_ms,
            commands: s
                .commands
                .into_iter()
                .map(|c| storage::SendCommandRow {
                    id: c.id,
                    set_id: c.set_id,
                    name: c.name,
                    order_idx: c.order_idx,
                    delay_ms: c.delay_ms,
                    cmd_type: c.cmd_type,
                    content: c.content,
                    append_line_ending: c.append_line_ending,
                })
                .collect(),
        })
        .collect())
}

#[tauri::command]
pub async fn delete_command_set(
    set_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let pool = {
        let storage_mgr = state
            .storage_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let db_pool = storage_mgr
            .pool()
            .map_err(|e| CommandError::Storage(e.to_string()))?;
        db_pool.clone()
    };
    storage::delete_command_set_from_db(&pool, &set_id)
        .await
        .map_err(|e| CommandError::Storage(e.to_string()))
}

/// 保存高亮规则集
#[derive(Debug, Deserialize)]
pub struct SaveHighlightSetArgs {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub is_enabled: bool,
    pub rules: Vec<SaveHighlightRuleArgs>,
}

#[derive(Debug, Deserialize)]
pub struct SaveHighlightRuleArgs {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub is_regex: bool,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
}

#[tauri::command]
pub async fn save_highlight_set(
    args: SaveHighlightSetArgs,
    state: State<'_, AppState>,
) -> Result<String, CommandError> {
    let pool = {
        let storage_mgr = state
            .storage_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let db_pool = storage_mgr
            .pool()
            .map_err(|e| CommandError::Storage(e.to_string()))?;
        db_pool.clone()
    };
    let is_update = args.id.is_some();
    let set_id = args.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    // If updating existing set, delete old one first to avoid duplicates
    if is_update {
        let _ = storage::delete_highlight_set_from_db(&pool, &set_id).await;
    }
    let set = storage::HighlightRuleSet {
        id: set_id.clone(),
        name: args.name,
        is_enabled: args.is_enabled,
        rules: args
            .rules
            .into_iter()
            .map(|r| storage::HighlightRuleRow {
                id: r.id,
                set_id: set_id.clone(),
                name: r.name,
                pattern: r.pattern,
                is_regex: r.is_regex,
                color: r.color,
                bold: r.bold,
                italic: r.italic,
            })
            .collect(),
    };
    storage::save_highlight_set_to_db(&pool, &set)
        .await
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    Ok(set_id)
}

#[tauri::command]
pub async fn load_highlight_sets(
    state: State<'_, AppState>,
) -> Result<Vec<storage::HighlightRuleSet>, CommandError> {
    let pool = {
        let storage_mgr = state
            .storage_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let db_pool = storage_mgr
            .pool()
            .map_err(|e| CommandError::Storage(e.to_string()))?;
        db_pool.clone()
    };
    let sets = storage::load_highlight_sets_from_db(&pool)
        .await
        .map_err(|e| CommandError::Storage(e.to_string()))?;
    Ok(sets
        .into_iter()
        .map(|s| storage::HighlightRuleSet {
            id: s.id,
            name: s.name,
            is_enabled: s.is_enabled,
            rules: s
                .rules
                .into_iter()
                .map(|r| storage::HighlightRuleRow {
                    id: r.id,
                    set_id: r.set_id,
                    name: r.name,
                    pattern: r.pattern,
                    is_regex: r.is_regex,
                    color: r.color,
                    bold: r.bold,
                    italic: r.italic,
                })
                .collect(),
        })
        .collect())
}

#[tauri::command]
pub async fn delete_highlight_set(
    set_id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let pool = {
        let storage_mgr = state
            .storage_manager
            .lock()
            .map_err(|e| CommandError::Lock(e.to_string()))?;
        let db_pool = storage_mgr
            .pool()
            .map_err(|e| CommandError::Storage(e.to_string()))?;
        db_pool.clone()
    };
    storage::delete_highlight_set_from_db(&pool, &set_id)
        .await
        .map_err(|e| CommandError::Storage(e.to_string()))
}
