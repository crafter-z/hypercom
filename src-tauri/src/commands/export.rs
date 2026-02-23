use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;

/// 导出格式
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Txt,
    Csv,
    Json,
}

/// 导出数据请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    /// 数据内容
    pub data: String,
    /// 导出格式
    pub format: ExportFormat,
    /// 文件路径
    pub path: String,
}

/// 导出结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// 是否成功
    pub success: bool,
    /// 文件路径
    pub path: String,
    /// 文件大小 (字节)
    pub size: u64,
    /// 错误信息
    pub error: Option<String>,
}

/// 导出数据到文件
#[tauri::command]
pub async fn export_data(request: ExportRequest) -> Result<ExportResult, String> {
    let path = PathBuf::from(&request.path);
    
    // 确保父目录存在
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
    }

    // 根据格式处理数据
    let content = match request.format {
        ExportFormat::Txt => request.data,
        ExportFormat::Csv => format_as_csv(&request.data)?,
        ExportFormat::Json => format_as_json(&request.data)?,
    };

    // 写入文件
    let mut file = File::create(&path)
        .map_err(|e| format!("Failed to create file: {}", e))?;

    file.write_all(content.as_bytes())
        .map_err(|e| format!("Failed to write file: {}", e))?;

    // 获取文件大小
    let metadata = std::fs::metadata(&path)
        .map_err(|e| format!("Failed to get file metadata: {}", e))?;

    Ok(ExportResult {
        success: true,
        path: request.path,
        size: metadata.len(),
        error: None,
    })
}

/// CSV 字段转义，防止 CSV 注入和格式错误
fn escape_csv_field(value: &str) -> String {
    // 检查是否需要转义
    let needs_escape = value.contains(',')
        || value.contains('"')
        || value.contains('\n')
        || value.contains('\r')
        // 防止 CSV 注入：以这些字符开头的字段可能被电子表格软件解释为公式
        || value.starts_with('=')
        || value.starts_with('+')
        || value.starts_with('-')
        || value.starts_with('@')
        || value.starts_with('\t');

    if needs_escape {
        // 用双引号包围，并转义内部的双引号
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

/// 将数据格式化为 CSV
fn format_as_csv(data: &str) -> Result<String, String> {
    let mut lines = Vec::new();
    lines.push("timestamp,direction,data".to_string());

    for line in data.lines() {
        // 解析格式: [timestamp] RX/TX data
        let parts: Vec<&str> = line.splitn(3, ' ').collect();
        if parts.len() >= 3 {
            let timestamp = parts[0].trim_start_matches('[').trim_end_matches(']');
            let direction = parts[1];
            let data_content = parts[2..].join(" ");
            
            // 对每个字段进行转义
            let escaped_timestamp = escape_csv_field(timestamp);
            let escaped_direction = escape_csv_field(direction);
            let escaped_data = escape_csv_field(&data_content);
            
            lines.push(format!("{},{},{}", escaped_timestamp, escaped_direction, escaped_data));
        } else {
            // 对原始行进行转义
            let escaped_line = escape_csv_field(line);
            lines.push(format!(",,{}", escaped_line));
        }
    }

    Ok(lines.join("\n"))
}

/// 将数据格式化为 JSON
fn format_as_json(data: &str) -> Result<String, String> {
    let mut entries: Vec<serde_json::Value> = Vec::new();

    for line in data.lines() {
        // 解析格式: [timestamp] RX/TX data
        let parts: Vec<&str> = line.splitn(3, ' ').collect();
        if parts.len() >= 3 {
            let timestamp = parts[0].trim_start_matches('[').trim_end_matches(']');
            let direction = parts[1];
            let data = parts[2..].join(" ");

            entries.push(serde_json::json!({
                "timestamp": timestamp,
                "direction": direction,
                "data": data
            }));
        } else {
            entries.push(serde_json::json!({
                "raw": line
            }));
        }
    }

    serde_json::to_string_pretty(&entries)
        .map_err(|e| format!("Failed to serialize JSON: {}", e))
}
