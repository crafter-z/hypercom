use serde::{Deserialize, Serialize};
/**
 * 存储管理模块 (Storage Manager)
 * 负责 SQLite 数据库的初始化与操作
 *
 * 存储内容:
 * - 串口分组布局
 * - 自定义命令组/规则集
 * - 高亮规则集
 *
 * 使用 sqlx 实现异步数据库操作
 */
use sqlx::{sqlite::SqlitePoolOptions, Pool, Sqlite};

// ==================== 存储类型 ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortGroupRow {
    pub id: String,
    pub name: String,
    pub order_idx: i32,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendCommandRow {
    pub id: String,
    pub set_id: String,
    pub name: String,
    pub order_idx: i32,
    pub delay_ms: i32,
    pub cmd_type: String,
    pub content: String,
    pub append_line_ending: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HighlightRuleRow {
    pub id: String,
    pub set_id: String,
    pub name: String,
    pub pattern: String,
    pub is_regex: bool,
    pub color: String,
    pub bold: bool,
    pub italic: bool,
}

// ==================== 聚合类型（用于前端） ====================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendCommandSet {
    pub id: String,
    pub name: String,
    pub is_loop: bool,
    pub loop_delay_ms: i32,
    pub commands: Vec<SendCommandRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HighlightRuleSet {
    pub id: String,
    pub name: String,
    pub is_enabled: bool,
    pub rules: Vec<HighlightRuleRow>,
}

// ==================== StorageManager ====================

pub struct StorageManager {
    db_pool: Option<Pool<Sqlite>>,
}

impl StorageManager {
    pub fn new() -> anyhow::Result<Self> {
        keep_port_group_api_reachable();
        Ok(Self { db_pool: None })
    }

    /// 获取数据库连接池引用
    pub fn pool(&self) -> anyhow::Result<&Pool<Sqlite>> {
        self.db_pool
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Database not initialized"))
    }

    /// 设置数据库连接池（由外部在异步上下文中创建后注入）
    pub fn set_pool(&mut self, pool: Pool<Sqlite>) {
        self.db_pool = Some(pool);
    }
}

fn keep_port_group_api_reachable() {
    let _ = save_port_groups_to_db;
    let _ = load_port_groups_from_db;
    let _ = save_port_group_members_to_db;
    let _ = load_port_group_members_from_db;
}

/// 初始化数据库连接池（不持有锁）
pub async fn create_pool() -> anyhow::Result<Pool<Sqlite>> {
    let db_dir = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("hypercom");
    std::fs::create_dir_all(&db_dir)?;
    let db_path = db_dir.join("data.db");

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect(&format!("sqlite:{}", db_path.display()))
        .await?;

    Ok(pool)
}

/// 初始化数据库表结构（不持有锁）
pub async fn init_schema_on_pool(pool: &Pool<Sqlite>) -> anyhow::Result<()> {
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS port_groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            order_idx INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS port_group_members (
            group_id TEXT NOT NULL,
            port_id TEXT NOT NULL,
            PRIMARY KEY (group_id, port_id)
        );
        CREATE TABLE IF NOT EXISTS send_command_sets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            is_loop INTEGER DEFAULT 0,
            loop_delay_ms INTEGER DEFAULT 1000
        );
        CREATE TABLE IF NOT EXISTS send_commands (
            id TEXT PRIMARY KEY,
            set_id TEXT NOT NULL,
            name TEXT DEFAULT '',
            order_idx INTEGER DEFAULT 0,
            delay_ms INTEGER DEFAULT 0,
            cmd_type TEXT DEFAULT 'string',
            content TEXT DEFAULT '',
            append_line_ending TEXT DEFAULT 'None',
            FOREIGN KEY (set_id) REFERENCES send_command_sets(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS highlight_rule_sets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            is_enabled INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS highlight_rules (
            id TEXT PRIMARY KEY,
            set_id TEXT NOT NULL,
            name TEXT DEFAULT '',
            pattern TEXT NOT NULL,
            is_regex INTEGER DEFAULT 0,
            color TEXT DEFAULT '',
            bold INTEGER DEFAULT 0,
            italic INTEGER DEFAULT 0,
            FOREIGN KEY (set_id) REFERENCES highlight_rule_sets(id) ON DELETE CASCADE
        );
        "#,
    )
    .execute(pool)
    .await?;
    log::info!("Database schema initialized");
    Ok(())
}

pub async fn save_port_groups_to_db(
    pool: &Pool<Sqlite>,
    groups: &[PortGroupRow],
) -> anyhow::Result<()> {
    for group in groups {
        sqlx::query(
            "INSERT OR REPLACE INTO port_groups (id, name, order_idx, created_at) VALUES (?, ?, ?, ?)"
        )
        .bind(&group.id).bind(&group.name).bind(group.order_idx).bind(&group.created_at)
        .execute(pool).await?;
    }
    Ok(())
}

pub async fn load_port_groups_from_db(pool: &Pool<Sqlite>) -> anyhow::Result<Vec<PortGroupRow>> {
    let rows = sqlx::query_as::<_, (String, String, i32, String)>(
        "SELECT id, name, order_idx, created_at FROM port_groups ORDER BY order_idx",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, name, order_idx, created_at)| PortGroupRow {
            id,
            name,
            order_idx,
            created_at,
        })
        .collect())
}

pub async fn save_port_group_members_to_db(
    pool: &Pool<Sqlite>,
    group_id: &str,
    port_ids: &[String],
) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM port_group_members WHERE group_id = ?")
        .bind(group_id)
        .execute(pool)
        .await?;
    for port_id in port_ids {
        sqlx::query("INSERT OR REPLACE INTO port_group_members (group_id, port_id) VALUES (?, ?)")
            .bind(group_id)
            .bind(port_id)
            .execute(pool)
            .await?;
    }
    Ok(())
}

pub async fn load_port_group_members_from_db(
    pool: &Pool<Sqlite>,
    group_id: &str,
) -> anyhow::Result<Vec<String>> {
    let rows =
        sqlx::query_as::<_, (String,)>("SELECT port_id FROM port_group_members WHERE group_id = ?")
            .bind(group_id)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(port_id,)| port_id).collect())
}

pub async fn save_command_set_to_db(
    pool: &Pool<Sqlite>,
    set: &SendCommandSet,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO send_command_sets (id, name, is_loop, loop_delay_ms) VALUES (?, ?, ?, ?)"
    )
    .bind(&set.id).bind(&set.name).bind(set.is_loop as i32).bind(set.loop_delay_ms)
    .execute(pool).await?;

    sqlx::query("DELETE FROM send_commands WHERE set_id = ?")
        .bind(&set.id)
        .execute(pool)
        .await?;
    for cmd in &set.commands {
        sqlx::query(
            "INSERT OR REPLACE INTO send_commands (id, set_id, name, order_idx, delay_ms, cmd_type, content, append_line_ending) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&cmd.id).bind(&set.id).bind(&cmd.name).bind(cmd.order_idx)
        .bind(cmd.delay_ms).bind(&cmd.cmd_type).bind(&cmd.content).bind(&cmd.append_line_ending)
        .execute(pool).await?;
    }
    Ok(())
}

pub async fn load_command_sets_from_db(pool: &Pool<Sqlite>) -> anyhow::Result<Vec<SendCommandSet>> {
    let set_rows = sqlx::query_as::<_, (String, String, i32, i32)>(
        "SELECT id, name, is_loop, loop_delay_ms FROM send_command_sets ORDER BY id",
    )
    .fetch_all(pool)
    .await?;

    let mut result = Vec::new();
    for (id, name, is_loop, loop_delay_ms) in set_rows {
        let cmd_rows = sqlx::query_as::<_, (String, String, String, i32, i32, String, String, String)>(
            "SELECT id, set_id, name, order_idx, delay_ms, cmd_type, content, append_line_ending FROM send_commands WHERE set_id = ? ORDER BY order_idx"
        ).bind(&id).fetch_all(pool).await?;

        let commands = cmd_rows
            .into_iter()
            .map(|(cid, sid, cn, oi, dm, ct, c, al)| SendCommandRow {
                id: cid,
                set_id: sid,
                name: cn,
                order_idx: oi,
                delay_ms: dm,
                cmd_type: ct,
                content: c,
                append_line_ending: al,
            })
            .collect();

        result.push(SendCommandSet {
            id,
            name,
            is_loop: is_loop != 0,
            loop_delay_ms,
            commands,
        });
    }
    Ok(result)
}

pub async fn delete_command_set_from_db(pool: &Pool<Sqlite>, set_id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM send_commands WHERE set_id = ?")
        .bind(set_id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM send_command_sets WHERE id = ?")
        .bind(set_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn save_highlight_set_to_db(
    pool: &Pool<Sqlite>,
    set: &HighlightRuleSet,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO highlight_rule_sets (id, name, is_enabled) VALUES (?, ?, ?)",
    )
    .bind(&set.id)
    .bind(&set.name)
    .bind(set.is_enabled as i32)
    .execute(pool)
    .await?;

    sqlx::query("DELETE FROM highlight_rules WHERE set_id = ?")
        .bind(&set.id)
        .execute(pool)
        .await?;
    for rule in &set.rules {
        sqlx::query(
            "INSERT OR REPLACE INTO highlight_rules (id, set_id, name, pattern, is_regex, color, bold, italic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&rule.id).bind(&set.id).bind(&rule.name).bind(&rule.pattern)
        .bind(rule.is_regex as i32).bind(&rule.color).bind(rule.bold as i32).bind(rule.italic as i32)
        .execute(pool).await?;
    }
    Ok(())
}

pub async fn load_highlight_sets_from_db(
    pool: &Pool<Sqlite>,
) -> anyhow::Result<Vec<HighlightRuleSet>> {
    let set_rows = sqlx::query_as::<_, (String, String, i32)>(
        "SELECT id, name, is_enabled FROM highlight_rule_sets ORDER BY id",
    )
    .fetch_all(pool)
    .await?;

    let mut result = Vec::new();
    for (id, name, is_enabled) in set_rows {
        let rule_rows = sqlx::query_as::<_, (String, String, String, String, i32, String, i32, i32)>(
            "SELECT id, set_id, name, pattern, is_regex, color, bold, italic FROM highlight_rules WHERE set_id = ? ORDER BY id"
        ).bind(&id).fetch_all(pool).await?;

        let rules = rule_rows
            .into_iter()
            .map(|(rid, sid, rn, pat, ir, col, b, i)| HighlightRuleRow {
                id: rid,
                set_id: sid,
                name: rn,
                pattern: pat,
                is_regex: ir != 0,
                color: col,
                bold: b != 0,
                italic: i != 0,
            })
            .collect();

        result.push(HighlightRuleSet {
            id,
            name,
            is_enabled: is_enabled != 0,
            rules,
        });
    }
    Ok(result)
}

pub async fn delete_highlight_set_from_db(pool: &Pool<Sqlite>, set_id: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM highlight_rules WHERE set_id = ?")
        .bind(set_id)
        .execute(pool)
        .await?;
    sqlx::query("DELETE FROM highlight_rule_sets WHERE id = ?")
        .bind(set_id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn setup_test_db() -> Pool<Sqlite> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        init_schema_on_pool(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn test_init_schema_creates_tables() {
        let pool = setup_test_db().await;
        // Verify tables exist by querying sqlite_master
        let tables: Vec<String> =
            sqlx::query_scalar("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert!(tables.contains(&"port_groups".to_string()));
        assert!(tables.contains(&"port_group_members".to_string()));
        assert!(tables.contains(&"send_command_sets".to_string()));
        assert!(tables.contains(&"send_commands".to_string()));
        assert!(tables.contains(&"highlight_rule_sets".to_string()));
        assert!(tables.contains(&"highlight_rules".to_string()));
        assert_eq!(tables.len(), 6);
    }

    #[tokio::test]
    async fn test_save_and_load_command_set() {
        let pool = setup_test_db().await;
        let set = SendCommandSet {
            id: "set-1".into(),
            name: "AT Commands".into(),
            is_loop: true,
            loop_delay_ms: 1000,
            commands: vec![
                SendCommandRow {
                    id: "cmd-1".into(),
                    set_id: "set-1".into(),
                    name: "Ping".into(),
                    order_idx: 0,
                    delay_ms: 100,
                    cmd_type: "string".into(),
                    content: "AT+PING".into(),
                    append_line_ending: "\\r\\n".into(),
                },
                SendCommandRow {
                    id: "cmd-2".into(),
                    set_id: "set-1".into(),
                    name: "Status".into(),
                    order_idx: 1,
                    delay_ms: 200,
                    cmd_type: "string".into(),
                    content: "AT+STATUS".into(),
                    append_line_ending: "\\r\\n".into(),
                },
            ],
        };

        save_command_set_to_db(&pool, &set).await.unwrap();
        let loaded = load_command_sets_from_db(&pool).await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "AT Commands");
        assert_eq!(loaded[0].is_loop, true);
        assert_eq!(loaded[0].loop_delay_ms, 1000);
        assert_eq!(loaded[0].commands.len(), 2);
        assert_eq!(loaded[0].commands[0].name, "Ping");
        assert_eq!(loaded[0].commands[0].content, "AT+PING");
        assert_eq!(loaded[0].commands[1].content, "AT+STATUS");
    }

    #[tokio::test]
    async fn test_delete_command_set_cascade() {
        let pool = setup_test_db().await;
        let set = SendCommandSet {
            id: "to-delete".into(),
            name: "Test".into(),
            is_loop: false,
            loop_delay_ms: 500,
            commands: vec![SendCommandRow {
                id: "cmd-x".into(),
                set_id: "to-delete".into(),
                name: "TestCmd".into(),
                order_idx: 0,
                delay_ms: 0,
                cmd_type: "string".into(),
                content: "test".into(),
                append_line_ending: "None".into(),
            }],
        };
        save_command_set_to_db(&pool, &set).await.unwrap();
        assert_eq!(load_command_sets_from_db(&pool).await.unwrap().len(), 1);

        delete_command_set_from_db(&pool, "to-delete")
            .await
            .unwrap();
        assert!(load_command_sets_from_db(&pool).await.unwrap().is_empty());

        // Verify commands are also deleted
        let cmd_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM send_commands")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(cmd_count, 0);
    }

    #[tokio::test]
    async fn test_save_and_load_highlight_set() {
        let pool = setup_test_db().await;
        let set = HighlightRuleSet {
            id: "hl-1".into(),
            name: "Errors".into(),
            is_enabled: true,
            rules: vec![
                HighlightRuleRow {
                    id: "r-1".into(),
                    set_id: "hl-1".into(),
                    name: "ERROR".into(),
                    pattern: "error".into(),
                    is_regex: false,
                    color: "#ff0000".into(),
                    bold: true,
                    italic: false,
                },
                HighlightRuleRow {
                    id: "r-2".into(),
                    set_id: "hl-1".into(),
                    name: "WARN".into(),
                    pattern: "warn\\s+\\d+".into(),
                    is_regex: true,
                    color: "#ffaa00".into(),
                    bold: false,
                    italic: true,
                },
            ],
        };

        save_highlight_set_to_db(&pool, &set).await.unwrap();
        let loaded = load_highlight_sets_from_db(&pool).await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Errors");
        assert!(loaded[0].is_enabled);
        assert_eq!(loaded[0].rules.len(), 2);
        assert_eq!(loaded[0].rules[0].pattern, "error");
        assert!(loaded[0].rules[0].bold);
        assert!(loaded[0].rules[1].is_regex);
        assert_eq!(loaded[0].rules[1].color, "#ffaa00");
    }

    #[tokio::test]
    async fn test_delete_highlight_set_cascade() {
        let pool = setup_test_db().await;
        let set = HighlightRuleSet {
            id: "hl-del".into(),
            name: "ToDelete".into(),
            is_enabled: false,
            rules: vec![HighlightRuleRow {
                id: "r-x".into(),
                set_id: "hl-del".into(),
                name: "X".into(),
                pattern: "x".into(),
                is_regex: false,
                color: "".into(),
                bold: false,
                italic: false,
            }],
        };
        save_highlight_set_to_db(&pool, &set).await.unwrap();
        delete_highlight_set_from_db(&pool, "hl-del").await.unwrap();
        assert!(load_highlight_sets_from_db(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_update_command_set_replaces_commands() {
        let pool = setup_test_db().await;
        let mut set = SendCommandSet {
            id: "update-test".into(),
            name: "V1".into(),
            is_loop: false,
            loop_delay_ms: 0,
            commands: vec![SendCommandRow {
                id: "old".into(),
                set_id: "update-test".into(),
                name: "OldCmd".into(),
                order_idx: 0,
                delay_ms: 0,
                cmd_type: "string".into(),
                content: "old".into(),
                append_line_ending: "None".into(),
            }],
        };
        save_command_set_to_db(&pool, &set).await.unwrap();

        // Update with new commands
        set.name = "V2".into();
        set.commands = vec![
            SendCommandRow {
                id: "new-1".into(),
                set_id: "update-test".into(),
                name: "NewCmd1".into(),
                order_idx: 0,
                delay_ms: 10,
                cmd_type: "hex".into(),
                content: "AABB".into(),
                append_line_ending: "None".into(),
            },
            SendCommandRow {
                id: "new-2".into(),
                set_id: "update-test".into(),
                name: "NewCmd2".into(),
                order_idx: 1,
                delay_ms: 20,
                cmd_type: "string".into(),
                content: "hello".into(),
                append_line_ending: "\\n".into(),
            },
        ];
        save_command_set_to_db(&pool, &set).await.unwrap();

        let loaded = load_command_sets_from_db(&pool).await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "V2");
        assert_eq!(loaded[0].commands.len(), 2);
        assert_eq!(loaded[0].commands[0].content, "AABB");
        assert_eq!(loaded[0].commands[0].cmd_type, "hex");
        assert_eq!(loaded[0].commands[1].content, "hello");
    }

    #[tokio::test]
    async fn test_empty_load_returns_empty_vec() {
        let pool = setup_test_db().await;
        assert!(load_command_sets_from_db(&pool).await.unwrap().is_empty());
        assert!(load_highlight_sets_from_db(&pool).await.unwrap().is_empty());
    }
}
