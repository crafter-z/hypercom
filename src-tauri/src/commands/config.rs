use tauri::{AppHandle, Manager, Runtime};
use std::fs;
use std::path::PathBuf;
use crate::models::*;

/// 获取配置文件路径
fn get_config_path(app_handle: &AppHandle<impl Runtime>) -> PathBuf {
    let app_data_dir = app_handle.path().app_data_dir()
        .expect("无法获取应用数据目录");
    
    // 确保目录存在
    fs::create_dir_all(&app_data_dir).ok();
    
    app_data_dir.join("config.json")
}

/// 获取应用设置
#[tauri::command]
pub fn get_settings<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<AppSettings, String> {
    let config_path = get_config_path(&app_handle);
    
    if !config_path.exists() {
        return Ok(AppSettings::default());
    }
    
    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("读取配置文件失败: {}", e))?;
    
    let settings: AppSettings = serde_json::from_str(&content)
        .map_err(|e| format!("解析配置文件失败: {}", e))?;
    
    Ok(settings)
}

/// 保存应用设置
#[tauri::command]
pub fn save_settings<R: Runtime>(
    app_handle: AppHandle<R>,
    settings: AppSettings,
) -> Result<(), String> {
    let config_path = get_config_path(&app_handle);
    
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("序列化配置失败: {}", e))?;
    
    fs::write(&config_path, content)
        .map_err(|e| format!("写入配置文件失败: {}", e))?;
    
    Ok(())
}

/// 获取命令组存储路径
fn get_commands_path(app_handle: &AppHandle<impl Runtime>) -> PathBuf {
    let app_data_dir = app_handle.path().app_data_dir()
        .expect("无法获取应用数据目录");
    
    fs::create_dir_all(&app_data_dir).ok();
    
    app_data_dir.join("commands.json")
}

/// 获取所有命令组
#[tauri::command]
pub fn list_command_groups<R: Runtime>(
    app_handle: AppHandle<R>,
) -> Result<Vec<CommandGroup>, String> {
    let commands_path = get_commands_path(&app_handle);
    
    if !commands_path.exists() {
        return Ok(Vec::new());
    }
    
    let content = fs::read_to_string(&commands_path)
        .map_err(|e| format!("读取命令组文件失败: {}", e))?;
    
    let groups: Vec<CommandGroup> = serde_json::from_str(&content)
        .map_err(|e| format!("解析命令组文件失败: {}", e))?;
    
    Ok(groups)
}

/// 保存命令组
#[tauri::command]
pub fn save_command_group<R: Runtime>(
    app_handle: AppHandle<R>,
    group: CommandGroup,
) -> Result<(), String> {
    let commands_path = get_commands_path(&app_handle);
    
    // 读取现有命令组
    let mut groups = if commands_path.exists() {
        let content = fs::read_to_string(&commands_path)
            .map_err(|e| format!("读取命令组文件失败: {}", e))?;
        serde_json::from_str::<Vec<CommandGroup>>(&content)
            .map_err(|e| format!("解析命令组文件失败: {}", e))?
    } else {
        Vec::new()
    };
    
    // 查找并更新或添加
    if let Some(existing) = groups.iter_mut().find(|g| g.id == group.id) {
        *existing = group;
    } else {
        groups.push(group);
    }
    
    // 保存
    let content = serde_json::to_string_pretty(&groups)
        .map_err(|e| format!("序列化命令组失败: {}", e))?;
    
    fs::write(&commands_path, content)
        .map_err(|e| format!("写入命令组文件失败: {}", e))?;
    
    Ok(())
}

/// 删除命令组
#[tauri::command]
pub fn delete_command_group<R: Runtime>(
    app_handle: AppHandle<R>,
    id: String,
) -> Result<(), String> {
    let commands_path = get_commands_path(&app_handle);
    
    if !commands_path.exists() {
        return Ok(());
    }
    
    let content = fs::read_to_string(&commands_path)
        .map_err(|e| format!("读取命令组文件失败: {}", e))?;
    
    let mut groups: Vec<CommandGroup> = serde_json::from_str(&content)
        .map_err(|e| format!("解析命令组文件失败: {}", e))?;
    
    groups.retain(|g| g.id != id);
    
    let content = serde_json::to_string_pretty(&groups)
        .map_err(|e| format!("序列化命令组失败: {}", e))?;
    
    fs::write(&commands_path, content)
        .map_err(|e| format!("写入命令组文件失败: {}", e))?;
    
    Ok(())
}

/// 导入命令组
#[tauri::command]
pub fn import_commands<R: Runtime>(
    app_handle: AppHandle<R>,
    json: String,
) -> Result<Vec<CommandGroup>, String> {
    let imported_groups: Vec<CommandGroup> = serde_json::from_str(&json)
        .map_err(|e| format!("解析导入数据失败: {}", e))?;
    
    let commands_path = get_commands_path(&app_handle);
    
    // 读取现有命令组
    let mut groups = if commands_path.exists() {
        let content = fs::read_to_string(&commands_path)
            .map_err(|e| format!("读取命令组文件失败: {}", e))?;
        serde_json::from_str::<Vec<CommandGroup>>(&content)
            .map_err(|e| format!("解析命令组文件失败: {}", e))?
    } else {
        Vec::new()
    };
    
    // 添加导入的命令组
    groups.extend(imported_groups.clone());
    
    // 保存
    let content = serde_json::to_string_pretty(&groups)
        .map_err(|e| format!("序列化命令组失败: {}", e))?;
    
    fs::write(&commands_path, content)
        .map_err(|e| format!("写入命令组文件失败: {}", e))?;
    
    Ok(imported_groups)
}

/// 导出命令组
#[tauri::command]
pub fn export_commands<R: Runtime>(
    app_handle: AppHandle<R>,
    ids: Vec<String>,
) -> Result<String, String> {
    let commands_path = get_commands_path(&app_handle);
    
    if !commands_path.exists() {
        return Ok("[]".to_string());
    }
    
    let content = fs::read_to_string(&commands_path)
        .map_err(|e| format!("读取命令组文件失败: {}", e))?;
    
    let groups: Vec<CommandGroup> = serde_json::from_str(&content)
        .map_err(|e| format!("解析命令组文件失败: {}", e))?;
    
    let exported: Vec<CommandGroup> = groups
        .into_iter()
        .filter(|g| ids.contains(&g.id))
        .collect();
    
    serde_json::to_string_pretty(&exported)
        .map_err(|e| format!("序列化导出数据失败: {}", e))
}
