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
use sqlx::{
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
    Pool, Sqlite,
};

// ==================== 存储类型 ====================

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolTemplateRow {
    pub id: String,
    pub name: String,
    pub is_enabled: i32,
    pub header_bytes: String,
    pub length_field_offset: i32,
    pub length_field_size: i32,
    pub length_endian: String,
    pub length_adjust: i32,
    pub checksum_algorithm: String,
    pub checksum_offset: i32,
    pub footer_bytes: String,
    pub color_header: String,
    pub color_length: String,
    pub color_payload: String,
    pub color_checksum: String,
    pub color_footer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PortPresetRow {
    pub id: String,
    pub name: String,
    pub baud_rate: i32,
    pub data_bits: i32,
    pub parity: String,
    pub stop_bits: String,
    pub handshake: String,
    pub dtr: i32,
    pub rts: i32,
    pub created_at: String,
}

/// 外部工具配置：端口号 → 命令行工具的映射关系
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct PortToolConfigRow {
    pub id: String,
    pub name: String,
    pub port_id: String,
    pub command: String,
    pub workdir: String,
}

/// 条件触发规则：接收数据匹配模式时自动执行动作
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerRuleRow {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub is_regex: bool,
    pub match_type: String,
    pub action_type: String,
    pub action_content: String,
    pub action_is_hex: bool,
    pub is_enabled: bool,
}

// ==================== StorageManager ====================

pub struct StorageManager {
    db_pool: Option<Pool<Sqlite>>,
}

impl StorageManager {
    pub fn new() -> anyhow::Result<Self> {
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

/// 初始化数据库连接池（不持有锁）
pub async fn create_pool() -> anyhow::Result<Pool<Sqlite>> {
    let db_dir = dirs::data_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("hypercom");
    std::fs::create_dir_all(&db_dir)?;
    let db_path = db_dir.join("data.db");

    // `create_if_missing(true)` 是关键：sqlx 默认 *不会* 创建缺失的数据库
    // 文件，首次运行（data.db 不存在）时连接会直接失败，导致连接池永远为
    // None、所有存储命令报 "Database not initialized"。WAL 与外键约束通过
    // 连接选项下发，确保对池内 *每一个* 连接生效（旧实现只对单条连接 PRAGMA，
    // 其余 4 条连接外键仍是 OFF）。
    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    Ok(pool)
}

/// 初始化数据库表结构（不持有锁）
pub async fn init_schema_on_pool(pool: &Pool<Sqlite>) -> anyhow::Result<()> {
    sqlx::query(
        r#"
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
        CREATE TABLE IF NOT EXISTS protocol_templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            is_enabled INTEGER DEFAULT 1,
            header_bytes TEXT DEFAULT '',
            length_field_offset INTEGER DEFAULT 0,
            length_field_size INTEGER DEFAULT 1,
            length_endian TEXT DEFAULT 'little',
            length_adjust INTEGER DEFAULT 0,
            checksum_algorithm TEXT DEFAULT 'none',
            checksum_offset INTEGER DEFAULT 0,
            footer_bytes TEXT DEFAULT '',
            color_header TEXT DEFAULT '#4fc3f7',
            color_length TEXT DEFAULT '#ce9178',
            color_payload TEXT DEFAULT '#dcdcaa',
            color_checksum TEXT DEFAULT '#b5cea8',
            color_footer TEXT DEFAULT '#6a9955'
        );
        -- DEPRECATED: send_history is no longer used (send history is now kept
        -- in-memory per session and cleared on app close). The table creation is
        -- intentionally retained so existing databases stay valid; do not add new
        -- columns or rely on this table.
        CREATE TABLE IF NOT EXISTS send_history (
            id TEXT PRIMARY KEY,
            port_id TEXT NOT NULL,
            content TEXT NOT NULL,
            format TEXT NOT NULL DEFAULT 'string',
            line_ending TEXT NOT NULL DEFAULT 'None',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_send_history_port_created ON send_history(port_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS port_presets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            baud_rate INTEGER NOT NULL DEFAULT 9600,
            data_bits INTEGER NOT NULL DEFAULT 8,
            parity TEXT NOT NULL DEFAULT 'None',
            stop_bits TEXT NOT NULL DEFAULT 'One',
            handshake TEXT NOT NULL DEFAULT 'None',
            dtr INTEGER NOT NULL DEFAULT 0,
            rts INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS port_tool_configs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            port_id TEXT NOT NULL,
            command TEXT NOT NULL DEFAULT '',
            workdir TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS trigger_rules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            pattern TEXT NOT NULL,
            is_regex INTEGER NOT NULL DEFAULT 0,
            match_type TEXT NOT NULL DEFAULT 'contains',
            action_type TEXT NOT NULL DEFAULT 'alert',
            action_content TEXT NOT NULL DEFAULT '',
            action_is_hex INTEGER NOT NULL DEFAULT 0,
            is_enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
        );
        "#,
    )
    .execute(pool)
    .await?;
    log::info!("Database schema initialized");
    Ok(())
}

pub async fn save_command_set_to_db(
    pool: &Pool<Sqlite>,
    set: &SendCommandSet,
) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;

    sqlx::query(
        "INSERT OR REPLACE INTO send_command_sets (id, name, is_loop, loop_delay_ms) VALUES (?, ?, ?, ?)"
    )
    .bind(&set.id).bind(&set.name).bind(set.is_loop as i32).bind(set.loop_delay_ms)
    .execute(&mut *tx).await?;

    sqlx::query("DELETE FROM send_commands WHERE set_id = ?")
        .bind(&set.id)
        .execute(&mut *tx)
        .await?;
    for cmd in &set.commands {
        sqlx::query(
            "INSERT OR REPLACE INTO send_commands (id, set_id, name, order_idx, delay_ms, cmd_type, content, append_line_ending) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&cmd.id).bind(&set.id).bind(&cmd.name).bind(cmd.order_idx)
        .bind(cmd.delay_ms).bind(&cmd.cmd_type).bind(&cmd.content).bind(&cmd.append_line_ending)
        .execute(&mut *tx).await?;
    }

    tx.commit().await?;
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
    // FK ON DELETE CASCADE 已启用（SqliteConnectOptions.foreign_keys(true)），
    // 删除父行时子行自动级联删除，无需手动 DELETE send_commands。
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
    let mut tx = pool.begin().await?;

    sqlx::query(
        "INSERT OR REPLACE INTO highlight_rule_sets (id, name, is_enabled) VALUES (?, ?, ?)",
    )
    .bind(&set.id)
    .bind(&set.name)
    .bind(set.is_enabled as i32)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM highlight_rules WHERE set_id = ?")
        .bind(&set.id)
        .execute(&mut *tx)
        .await?;
    for rule in &set.rules {
        sqlx::query(
            "INSERT OR REPLACE INTO highlight_rules (id, set_id, name, pattern, is_regex, color, bold, italic) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(&rule.id).bind(&set.id).bind(&rule.name).bind(&rule.pattern)
        .bind(rule.is_regex as i32).bind(&rule.color).bind(rule.bold as i32).bind(rule.italic as i32)
        .execute(&mut *tx).await?;
    }

    tx.commit().await?;
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
    // FK ON DELETE CASCADE 已启用，删除父行时子行自动级联删除。
    sqlx::query("DELETE FROM highlight_rule_sets WHERE id = ?")
        .bind(set_id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn save_protocol_template_to_db(
    pool: &Pool<Sqlite>,
    template: &ProtocolTemplateRow,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO protocol_templates (id, name, is_enabled, header_bytes, length_field_offset, length_field_size, length_endian, length_adjust, checksum_algorithm, checksum_offset, footer_bytes, color_header, color_length, color_payload, color_checksum, color_footer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&template.id)
    .bind(&template.name)
    .bind(template.is_enabled)
    .bind(&template.header_bytes)
    .bind(template.length_field_offset)
    .bind(template.length_field_size)
    .bind(&template.length_endian)
    .bind(template.length_adjust)
    .bind(&template.checksum_algorithm)
    .bind(template.checksum_offset)
    .bind(&template.footer_bytes)
    .bind(&template.color_header)
    .bind(&template.color_length)
    .bind(&template.color_payload)
    .bind(&template.color_checksum)
    .bind(&template.color_footer)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load_protocol_templates_from_db(
    pool: &Pool<Sqlite>,
) -> anyhow::Result<Vec<ProtocolTemplateRow>> {
    let rows = sqlx::query_as::<_, (
        String,
        String,
        i32,
        String,
        i32,
        i32,
        String,
        i32,
        String,
        i32,
        String,
        String,
        String,
        String,
        String,
        String,
    )>(
        "SELECT id, name, is_enabled, header_bytes, length_field_offset, length_field_size, length_endian, length_adjust, checksum_algorithm, checksum_offset, footer_bytes, color_header, color_length, color_payload, color_checksum, color_footer FROM protocol_templates ORDER BY id",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                name,
                is_enabled,
                header_bytes,
                length_field_offset,
                length_field_size,
                length_endian,
                length_adjust,
                checksum_algorithm,
                checksum_offset,
                footer_bytes,
                color_header,
                color_length,
                color_payload,
                color_checksum,
                color_footer,
            )| ProtocolTemplateRow {
                id,
                name,
                is_enabled,
                header_bytes,
                length_field_offset,
                length_field_size,
                length_endian,
                length_adjust,
                checksum_algorithm,
                checksum_offset,
                footer_bytes,
                color_header,
                color_length,
                color_payload,
                color_checksum,
                color_footer,
            },
        )
        .collect())
}

pub async fn delete_protocol_template_from_db(
    pool: &Pool<Sqlite>,
    id: &str,
) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM protocol_templates WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ==================== 端口参数预设 ====================

pub async fn save_port_preset_to_db(
    pool: &Pool<Sqlite>,
    preset: &PortPresetRow,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO port_presets (id, name, baud_rate, data_bits, parity, stop_bits, handshake, dtr, rts) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET 
           name=excluded.name, baud_rate=excluded.baud_rate, data_bits=excluded.data_bits,
           parity=excluded.parity, stop_bits=excluded.stop_bits, handshake=excluded.handshake,
           dtr=excluded.dtr, rts=excluded.rts"
    )
    .bind(&preset.id)
    .bind(&preset.name)
    .bind(preset.baud_rate)
    .bind(preset.data_bits)
    .bind(&preset.parity)
    .bind(&preset.stop_bits)
    .bind(&preset.handshake)
    .bind(preset.dtr)
    .bind(preset.rts)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load_port_presets_from_db(
    pool: &Pool<Sqlite>,
) -> anyhow::Result<Vec<PortPresetRow>> {
    let rows = sqlx::query_as::<_, PortPresetRow>(
        "SELECT id, name, baud_rate, data_bits, parity, stop_bits, handshake, dtr, rts, created_at FROM port_presets ORDER BY created_at ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn delete_port_preset_from_db(
    pool: &Pool<Sqlite>,
    id: &str,
) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM port_presets WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ==================== 外部工具配置 ====================

pub async fn save_port_tool_config_to_db(
    pool: &Pool<Sqlite>,
    config: &PortToolConfigRow,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO port_tool_configs (id, name, port_id, command, workdir) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(&config.id)
    .bind(&config.name)
    .bind(&config.port_id)
    .bind(&config.command)
    .bind(&config.workdir)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load_port_tool_configs_from_db(
    pool: &Pool<Sqlite>,
) -> anyhow::Result<Vec<PortToolConfigRow>> {
    let rows = sqlx::query_as::<_, PortToolConfigRow>(
        "SELECT id, name, port_id, command, workdir FROM port_tool_configs ORDER BY name ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn delete_port_tool_config_from_db(
    pool: &Pool<Sqlite>,
    id: &str,
) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM port_tool_configs WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// ==================== 条件触发规则 ====================

pub async fn save_trigger_rule_to_db(
    pool: &Pool<Sqlite>,
    rule: &TriggerRuleRow,
) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT OR REPLACE INTO trigger_rules (id, name, pattern, is_regex, match_type, action_type, action_content, action_is_hex, is_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(&rule.id)
    .bind(&rule.name)
    .bind(&rule.pattern)
    .bind(rule.is_regex as i32)
    .bind(&rule.match_type)
    .bind(&rule.action_type)
    .bind(&rule.action_content)
    .bind(rule.action_is_hex as i32)
    .bind(rule.is_enabled as i32)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn load_trigger_rules_from_db(
    pool: &Pool<Sqlite>,
) -> anyhow::Result<Vec<TriggerRuleRow>> {
    let rows = sqlx::query_as::<_, (String, String, String, i32, String, String, String, i32, i32)>(
        "SELECT id, name, pattern, is_regex, match_type, action_type, action_content, action_is_hex, is_enabled FROM trigger_rules ORDER BY created_at ASC",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(id, name, pattern, is_regex, match_type, action_type, action_content, action_is_hex, is_enabled)| {
                TriggerRuleRow {
                    id,
                    name,
                    pattern,
                    is_regex: is_regex != 0,
                    match_type,
                    action_type,
                    action_content,
                    action_is_hex: action_is_hex != 0,
                    is_enabled: is_enabled != 0,
                }
            },
        )
        .collect())
}

pub async fn delete_trigger_rule_from_db(
    pool: &Pool<Sqlite>,
    id: &str,
) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM trigger_rules WHERE id = ?")
        .bind(id)
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
        assert!(tables.contains(&"send_command_sets".to_string()));
        assert!(tables.contains(&"send_commands".to_string()));
        assert!(tables.contains(&"highlight_rule_sets".to_string()));
        assert!(tables.contains(&"highlight_rules".to_string()));
        assert!(tables.contains(&"protocol_templates".to_string()));
        assert!(tables.contains(&"send_history".to_string()));
        assert!(tables.contains(&"port_presets".to_string()));
        assert!(tables.contains(&"port_tool_configs".to_string()));
        assert!(tables.contains(&"trigger_rules".to_string()));
        assert_eq!(tables.len(), 9);
    }

    #[tokio::test]
    async fn test_save_load_delete_port_preset() {
        let pool = setup_test_db().await;
        let preset = PortPresetRow {
            id: "preset-1".into(),
            name: "Modbus RTU".into(),
            baud_rate: 19200,
            data_bits: 8,
            parity: "Even".into(),
            stop_bits: "One".into(),
            handshake: "None".into(),
            dtr: 1,
            rts: 0,
            created_at: String::new(),
        };
        save_port_preset_to_db(&pool, &preset).await.unwrap();

        let loaded = load_port_presets_from_db(&pool).await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Modbus RTU");
        assert_eq!(loaded[0].baud_rate, 19200);
        assert_eq!(loaded[0].parity, "Even");
        assert_eq!(loaded[0].dtr, 1);

        delete_port_preset_from_db(&pool, "preset-1").await.unwrap();
        let after_delete = load_port_presets_from_db(&pool).await.unwrap();
        assert!(after_delete.is_empty());
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

    fn sample_protocol_template() -> ProtocolTemplateRow {
        ProtocolTemplateRow {
            id: "proto-1".into(),
            name: "Binary Frame".into(),
            is_enabled: 1,
            header_bytes: "AA55".into(),
            length_field_offset: 2,
            length_field_size: 2,
            length_endian: "big".into(),
            length_adjust: -1,
            checksum_algorithm: "crc16".into(),
            checksum_offset: -2,
            footer_bytes: "0D0A".into(),
            color_header: "#111111".into(),
            color_length: "#222222".into(),
            color_payload: "#333333".into(),
            color_checksum: "#444444".into(),
            color_footer: "#555555".into(),
        }
    }

    #[tokio::test]
    async fn test_save_and_load_protocol_template() {
        let pool = setup_test_db().await;
        let template = sample_protocol_template();

        save_protocol_template_to_db(&pool, &template).await.unwrap();
        let loaded = load_protocol_templates_from_db(&pool).await.unwrap();

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "proto-1");
        assert_eq!(loaded[0].name, "Binary Frame");
        assert_eq!(loaded[0].is_enabled, 1);
        assert_eq!(loaded[0].header_bytes, "AA55");
        assert_eq!(loaded[0].length_field_offset, 2);
        assert_eq!(loaded[0].length_field_size, 2);
        assert_eq!(loaded[0].length_endian, "big");
        assert_eq!(loaded[0].length_adjust, -1);
        assert_eq!(loaded[0].checksum_algorithm, "crc16");
        assert_eq!(loaded[0].checksum_offset, -2);
        assert_eq!(loaded[0].footer_bytes, "0D0A");
        assert_eq!(loaded[0].color_header, "#111111");
        assert_eq!(loaded[0].color_length, "#222222");
        assert_eq!(loaded[0].color_payload, "#333333");
        assert_eq!(loaded[0].color_checksum, "#444444");
        assert_eq!(loaded[0].color_footer, "#555555");
    }

    #[tokio::test]
    async fn test_delete_protocol_template() {
        let pool = setup_test_db().await;
        let template = sample_protocol_template();

        save_protocol_template_to_db(&pool, &template).await.unwrap();
        delete_protocol_template_from_db(&pool, "proto-1")
            .await
            .unwrap();

        assert!(load_protocol_templates_from_db(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_update_protocol_template() {
        let pool = setup_test_db().await;
        let mut template = sample_protocol_template();

        save_protocol_template_to_db(&pool, &template).await.unwrap();
        template.name = "Updated Binary Frame".into();
        save_protocol_template_to_db(&pool, &template).await.unwrap();
        let loaded = load_protocol_templates_from_db(&pool).await.unwrap();

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "proto-1");
        assert_eq!(loaded[0].name, "Updated Binary Frame");
        assert_eq!(loaded[0].header_bytes, "AA55");
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

    fn sample_trigger_rule() -> TriggerRuleRow {
        TriggerRuleRow {
            id: "trig-1".into(),
            name: "Error Alert".into(),
            pattern: "ERROR".into(),
            is_regex: false,
            match_type: "contains".into(),
            action_type: "alert".into(),
            action_content: "Error detected!".into(),
            action_is_hex: false,
            is_enabled: true,
        }
    }

    #[tokio::test]
    async fn test_save_and_load_trigger_rule() {
        let pool = setup_test_db().await;
        let rule = sample_trigger_rule();

        save_trigger_rule_to_db(&pool, &rule).await.unwrap();
        let loaded = load_trigger_rules_from_db(&pool).await.unwrap();

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "trig-1");
        assert_eq!(loaded[0].name, "Error Alert");
        assert_eq!(loaded[0].pattern, "ERROR");
        assert!(!loaded[0].is_regex);
        assert_eq!(loaded[0].match_type, "contains");
        assert_eq!(loaded[0].action_type, "alert");
        assert_eq!(loaded[0].action_content, "Error detected!");
        assert!(!loaded[0].action_is_hex);
        assert!(loaded[0].is_enabled);
    }

    #[tokio::test]
    async fn test_update_trigger_rule() {
        let pool = setup_test_db().await;
        let mut rule = sample_trigger_rule();

        save_trigger_rule_to_db(&pool, &rule).await.unwrap();
        rule.name = "Updated Alert".into();
        rule.pattern = "FATAL".into();
        rule.is_enabled = false;
        save_trigger_rule_to_db(&pool, &rule).await.unwrap();

        let loaded = load_trigger_rules_from_db(&pool).await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].name, "Updated Alert");
        assert_eq!(loaded[0].pattern, "FATAL");
        assert!(!loaded[0].is_enabled);
    }

    #[tokio::test]
    async fn test_delete_trigger_rule() {
        let pool = setup_test_db().await;
        let rule = sample_trigger_rule();

        save_trigger_rule_to_db(&pool, &rule).await.unwrap();
        delete_trigger_rule_from_db(&pool, "trig-1").await.unwrap();

        assert!(load_trigger_rules_from_db(&pool).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_trigger_rule_hex_action() {
        let pool = setup_test_db().await;
        let rule = TriggerRuleRow {
            id: "trig-hex".into(),
            name: "Hex Respond".into(),
            pattern: "AA 55".into(),
            is_regex: false,
            match_type: "hex".into(),
            action_type: "respond".into(),
            action_content: "BB 66".into(),
            action_is_hex: true,
            is_enabled: true,
        };

        save_trigger_rule_to_db(&pool, &rule).await.unwrap();
        let loaded = load_trigger_rules_from_db(&pool).await.unwrap();

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].match_type, "hex");
        assert_eq!(loaded[0].action_type, "respond");
        assert!(loaded[0].action_is_hex);
    }
}
