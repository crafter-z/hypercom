/**
 * 存储管理模块 (Storage Manager)
 * 负责 SQLite 数据库的初始化与操作
 * 
 * 存储内容:
 * - 自定义命令组/规则集
 * - 历史记录
 * - 串口选项卡布局
 * - 高亮规则集
 * 
 * 使用 sqlx 实现异步数据库操作
 */

use sqlx::{sqlite::SqlitePoolOptions, Pool, Sqlite};

pub struct StorageManager {
    /// TODO: 数据库连接池，需要在 Tokio runtime 中初始化
    db_pool: Option<Pool<Sqlite>>,
}

impl StorageManager {
    pub fn new() -> anyhow::Result<Self> {
        // TODO: 在 setup 钩子中调用 init() 完成异步初始化
        Ok(Self { db_pool: None })
    }

    /// 异步初始化数据库连接池
    /// 应在 Tauri setup 钩子中调用
    pub async fn init(&mut self) -> anyhow::Result<()> {
        let db_path = dirs::data_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("hypercom")
            .join("data.db");
        
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(&format!("sqlite:{}", db_path.display()))
            .await?;
        
        self.db_pool = Some(pool);
        Ok(())
    }

    /// 初始化数据库表结构
    /// TODO: 创建所有必要的表
    pub async fn init_schema(&self) -> anyhow::Result<()> {
        // sqlx::query(
        //     r#"
        //     CREATE TABLE IF NOT EXISTS port_groups (
        //         id TEXT PRIMARY KEY,
        //         name TEXT NOT NULL,
        //         order_idx INTEGER DEFAULT 0,
        //         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        //     );
        //     CREATE TABLE IF NOT EXISTS send_command_sets (
        //         id TEXT PRIMARY KEY,
        //         name TEXT NOT NULL,
        //         is_loop BOOLEAN DEFAULT FALSE,
        //         loop_delay_ms INTEGER DEFAULT 0
        //     );
        //     CREATE TABLE IF NOT EXISTS send_commands (
        //         id TEXT PRIMARY KEY,
        //         set_id TEXT NOT NULL,
        //         name TEXT,
        //         order_idx INTEGER,
        //         delay_ms INTEGER DEFAULT 0,
        //         cmd_type TEXT,
        //         content TEXT,
        //         append_line_ending TEXT
        //     );
        //     CREATE TABLE IF NOT EXISTS highlight_rule_sets (
        //         id TEXT PRIMARY KEY,
        //         name TEXT NOT NULL,
        //         is_enabled BOOLEAN DEFAULT TRUE
        //     );
        //     CREATE TABLE IF NOT EXISTS highlight_rules (
        //         id TEXT PRIMARY KEY,
        //         set_id TEXT NOT NULL,
        //         name TEXT,
        //         pattern TEXT NOT NULL,
        //         is_regex BOOLEAN DEFAULT FALSE,
        //         color TEXT,
        //         bold BOOLEAN DEFAULT FALSE,
        //         italic BOOLEAN DEFAULT FALSE
        //     );
        //     "#
        // ).execute(&self.db_pool).await?;
        
        Ok(())
    }

    // TODO: 实现 CRUD 方法
    // - save_command_set / load_command_sets
    // - save_highlight_set / load_highlight_sets
    // - save_port_layout / load_port_layout
}
