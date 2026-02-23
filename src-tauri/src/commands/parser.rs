use crate::parser::{Protocol, ParsedFrame, ParserState};
use tauri::State;

/// 获取所有协议
#[tauri::command]
pub async fn list_protocols(
    state: State<'_, ParserState>,
) -> Result<Vec<Protocol>, String> {
    let parser = state.parser.lock()
        .map_err(|e| format!("Failed to lock parser: {}", e))?;
    
    Ok(parser.get_protocols().into_iter().cloned().collect())
}

/// 保存协议
#[tauri::command]
pub async fn save_protocol(
    state: State<'_, ParserState>,
    protocol: Protocol,
) -> Result<(), String> {
    let mut parser = state.parser.lock()
        .map_err(|e| format!("Failed to lock parser: {}", e))?;
    
    parser.register_protocol(protocol);
    Ok(())
}

/// 删除协议
#[tauri::command]
pub async fn delete_protocol(
    state: State<'_, ParserState>,
    id: String,
) -> Result<(), String> {
    let mut parser = state.parser.lock()
        .map_err(|e| format!("Failed to lock parser: {}", e))?;
    
    parser.remove_protocol(&id);
    Ok(())
}

/// 设置激活的协议
#[tauri::command]
pub async fn set_active_protocol(
    state: State<'_, ParserState>,
    id: Option<String>,
) -> Result<(), String> {
    let mut parser = state.parser.lock()
        .map_err(|e| format!("Failed to lock parser: {}", e))?;
    
    parser.set_active_protocol(id);
    Ok(())
}

/// 解析数据
#[tauri::command]
pub async fn parse_data(
    state: State<'_, ParserState>,
    data: Vec<u8>,
) -> Result<Option<ParsedFrame>, String> {
    let parser = state.parser.lock()
        .map_err(|e| format!("Failed to lock parser: {}", e))?;
    
    Ok(parser.parse(&data))
}

/// 使用指定协议解析数据
#[tauri::command]
pub async fn parse_data_with_protocol(
    state: State<'_, ParserState>,
    data: Vec<u8>,
    protocol_id: String,
) -> Result<ParsedFrame, String> {
    let parser = state.parser.lock()
        .map_err(|e| format!("Failed to lock parser: {}", e))?;
    
    let protocol = parser.get_protocol(&protocol_id)
        .ok_or("Protocol not found")?;
    
    Ok(parser.parse_with_protocol(&data, protocol))
}
