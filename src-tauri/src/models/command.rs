use serde::{Deserialize, Serialize};

/// 单条命令
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    /// 命令 ID
    pub id: String,
    /// 命令名称
    pub name: String,
    /// 命令数据（Hex 格式）
    pub data: String,
    /// 描述
    pub description: Option<String>,
    /// 创建时间
    pub created_at: i64,
}

/// 命令组
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandGroup {
    /// 组 ID
    pub id: String,
    /// 组名称
    pub name: String,
    /// 命令列表
    pub commands: Vec<Command>,
    /// 创建时间
    pub created_at: i64,
    /// 更新时间
    pub updated_at: i64,
}

impl Command {
    /// 创建新命令
    pub fn new(name: String, data: String, description: Option<String>) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            data,
            description,
            created_at: chrono::Utc::now().timestamp_millis(),
        }
    }
}

impl CommandGroup {
    /// 创建新命令组
    pub fn new(name: String) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            commands: Vec::new(),
            created_at: now,
            updated_at: now,
        }
    }
}
