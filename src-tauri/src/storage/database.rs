use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;
use tauri::AppHandle;
use tauri::Runtime;
use rusqlite::OptionalExtension;

/// 数据库配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct DatabaseConfig {
    /// 数据库文件路径
    pub path: String,
    /// 是否启用
    pub enabled: bool,
}

impl Default for DatabaseConfig {
    fn default() -> Self {
        Self {
            path: "hypercom.db".to_string(),
            enabled: true,
        }
    }
}

/// 数据库管理器
#[allow(dead_code)]
pub struct DatabaseManager {
    /// 数据库路径
    path: PathBuf,
    /// 是否已初始化
    initialized: bool,
}

#[allow(dead_code)]
impl DatabaseManager {
    /// 创建新的数据库管理器
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            initialized: false,
        }
    }

    /// 获取默认数据库路径
    pub fn default_path<R: Runtime>(app_handle: &AppHandle<R>) -> PathBuf {
        let app_data_dir = app_handle.path().app_data_dir()
            .expect("Failed to get app data directory");
        
        // 确保目录存在
        if !app_data_dir.exists() {
            std::fs::create_dir_all(&app_data_dir)
                .expect("Failed to create app data directory");
        }
        
        app_data_dir.join("hypercom.db")
    }

    /// 初始化数据库
    pub fn initialize(&mut self) -> Result<(), String> {
        if self.initialized {
            return Ok(());
        }

        // 确保父目录存在
        if let Some(parent) = self.path.parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create database directory: {}", e))?;
            }
        }

        // 创建数据库文件（如果不存在）
        let conn = rusqlite::Connection::open(&self.path)
            .map_err(|e| format!("Failed to open database: {}", e))?;

        // 创建表
        self.create_tables(&conn)?;

        self.initialized = true;
        Ok(())
    }

    /// 创建数据表
    fn create_tables(&self, conn: &rusqlite::Connection) -> Result<(), String> {
        // 命令组表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS command_groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )",
            [],
        ).map_err(|e| format!("Failed to create command_groups table: {}", e))?;

        // 命令表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS commands (
                id TEXT PRIMARY KEY,
                group_id TEXT NOT NULL,
                name TEXT NOT NULL,
                data TEXT NOT NULL,
                description TEXT,
                sort_order INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (group_id) REFERENCES command_groups(id) ON DELETE CASCADE
            )",
            [],
        ).map_err(|e| format!("Failed to create commands table: {}", e))?;

        // 设置表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
            [],
        ).map_err(|e| format!("Failed to create settings table: {}", e))?;

        // 日志索引
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_commands_group_id ON commands(group_id)",
            [],
        ).map_err(|e| format!("Failed to create index: {}", e))?;

        Ok(())
    }

    /// 获取数据库连接
    pub fn get_connection(&self) -> Result<rusqlite::Connection, String> {
        rusqlite::Connection::open(&self.path)
            .map_err(|e| format!("Failed to open database: {}", e))
    }

    /// 保存设置
    pub fn save_setting(&self, key: &str, value: &str) -> Result<(), String> {
        let conn = self.get_connection()?;
        
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            [key, value],
        ).map_err(|e| format!("Failed to save setting: {}", e))?;

        Ok(())
    }

    /// 获取设置
    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        let conn = self.get_connection()?;
        
        let mut stmt = conn.prepare(
            "SELECT value FROM settings WHERE key = ?1"
        ).map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let result = stmt.query_row([key], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|e| format!("Failed to get setting: {}", e))?;

        Ok(result)
    }

    /// 获取所有设置
    pub fn get_all_settings(&self) -> Result<std::collections::HashMap<String, String>, String> {
        let conn = self.get_connection()?;
        
        let mut stmt = conn.prepare("SELECT key, value FROM settings")
            .map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let settings = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("Failed to query settings: {}", e))?
        .collect::<Result<std::collections::HashMap<String, String>, _>>()
        .map_err(|e| format!("Failed to collect settings: {}", e))?;

        Ok(settings)
    }

    /// 检查是否已初始化
    pub fn is_initialized(&self) -> bool {
        self.initialized
    }

    /// 获取数据库路径
    pub fn get_path(&self) -> &PathBuf {
        &self.path
    }
}

/// 应用状态中的数据库管理器
#[allow(dead_code)]
pub struct DbState {
    pub manager: Mutex<DatabaseManager>,
}

impl DbState {
    pub fn new(manager: DatabaseManager) -> Self {
        Self {
            manager: Mutex::new(manager),
        }
    }
}
