use tauri::State;

use super::CommandError;
use crate::{config, AppState};

// ==================== 通用助手 ====================
//
// 20 个命令此前是逐条复制粘贴的「加锁 → 找同 id → 替换/追加 → save」，
// 各实体的差别只有字段名。这里收敛为「实体访问器 + 三个 CRUD 助手」，
// 命令体只剩「哪个实体」一条信息。
// 命令名 / 参数名 / 返回类型保持不变（前端 storageService 编译期依赖）。

/// 带 `id` 字段的实体。
trait Entity {
    fn entity_id(&self) -> &str;
    fn set_entity_id(&mut self, id: String);
}

macro_rules! impl_entity_id {
    ($($ty:path),+ $(,)?) => {$(
        impl Entity for $ty {
            fn entity_id(&self) -> &str { &self.id }
            fn set_entity_id(&mut self, id: String) { self.id = id; }
        }
    )+};
}

impl_entity_id!(
    config::SendCommandSetEntry,
    config::HighlightRuleSetEntry,
    config::ProtocolTemplateEntry,
    config::PortPresetEntry,
    config::PortToolConfigEntry,
    config::TriggerRuleEntry,
);

/// 实体数组访问器：把「哪个实体」从命令体里抽出来，供 CRUD 助手统一调用。
macro_rules! entity_accessors {
    ($($fn_name:ident : $ty:path => $field:ident),+ $(,)?) => {$(
        fn $fn_name(cfg: &mut config::AppConfig) -> &mut Vec<$ty> { &mut cfg.entities.$field }
    )+};
}

entity_accessors!(
    command_sets: config::SendCommandSetEntry => send_command_sets,
    highlight_sets: config::HighlightRuleSetEntry => highlight_rule_sets,
    protocol_templates: config::ProtocolTemplateEntry => protocol_templates,
    port_presets: config::PortPresetEntry => port_presets,
    port_tool_configs: config::PortToolConfigEntry => port_tool_configs,
    trigger_rules: config::TriggerRuleEntry => trigger_rules,
);

/// 读命令样板：加锁 → 读快照。
fn read_config<T>(
    state: &State<AppState>,
    read: impl FnOnce(&config::AppConfig) -> T,
) -> Result<T, CommandError> {
    let manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    Ok(read(manager.get_config()))
}

/// 写命令样板：加锁 → 变更 → 落盘。
fn mutate_config<T>(
    state: &State<AppState>,
    change: impl FnOnce(&mut config::AppConfig) -> T,
) -> Result<T, CommandError> {
    let mut manager = state
        .config_manager
        .lock()
        .map_err(|e| CommandError::Lock(e.to_string()))?;
    mutate(&mut manager, change)
}

/// `mutate_config` 的无锁内核：变更 → 落盘。
///
/// 单独抽出来是为了可测：`State<AppState>` 在测试里造不出来，而「变更 → save →
/// 重新加载」的真实往返必须在临时目录的 `ConfigManager` 上跑（见本文件 tests）。
fn mutate<T>(
    manager: &mut config::ConfigManager,
    change: impl FnOnce(&mut config::AppConfig) -> T,
) -> Result<T, CommandError> {
    let out = change(manager.get_config_mut());
    manager
        .save()
        .map_err(|e| CommandError::Config(e.to_string()))?;
    Ok(out)
}

/// 按 id upsert，返回最终 id。空 id = 新建（后端生成 UUID）。
fn upsert<T: Entity>(items: &mut Vec<T>, args: T) -> String {
    let id = if args.entity_id().is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        args.entity_id().to_string()
    };
    let mut entry = args;
    entry.set_entity_id(id.clone());
    match items.iter_mut().find(|e| e.entity_id() == id) {
        Some(existing) => *existing = entry,
        None => items.push(entry),
    }
    id
}

fn save_entity<T: Entity>(
    state: State<AppState>,
    args: T,
    select: fn(&mut config::AppConfig) -> &mut Vec<T>,
) -> Result<String, CommandError> {
    mutate_config(&state, move |cfg| upsert(select(cfg), args))
}

fn delete_entity<T: Entity>(
    state: State<AppState>,
    id: &str,
    select: fn(&mut config::AppConfig) -> &mut Vec<T>,
) -> Result<(), CommandError> {
    mutate_config(&state, |cfg| delete_by_id(select(cfg), id))
}

/// 按 id 删除：不存在的 id 是无操作（不报错、不动其它条目、不打乱剩余顺序）。
fn delete_by_id<T: Entity>(items: &mut Vec<T>, id: &str) {
    items.retain(|e| e.entity_id() != id);
}

// ==================== 命令集 ====================

#[tauri::command]
pub fn save_command_set(
    args: config::SendCommandSetEntry,
    state: State<AppState>,
) -> Result<String, CommandError> {
    save_entity(state, args, command_sets)
}

#[tauri::command]
pub fn load_command_sets(
    state: State<AppState>,
) -> Result<Vec<config::SendCommandSetEntry>, CommandError> {
    read_config(&state, |cfg| cfg.entities.send_command_sets.clone())
}

#[tauri::command]
pub fn delete_command_set(
    set_id: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    delete_entity(state, &set_id, command_sets)
}

// ==================== 高亮规则集 ====================

#[tauri::command]
pub fn save_highlight_set(
    args: config::HighlightRuleSetEntry,
    state: State<AppState>,
) -> Result<String, CommandError> {
    save_entity(state, args, highlight_sets)
}

#[tauri::command]
pub fn load_highlight_sets(
    state: State<AppState>,
) -> Result<Vec<config::HighlightRuleSetEntry>, CommandError> {
    read_config(&state, |cfg| cfg.entities.highlight_rule_sets.clone())
}

#[tauri::command]
pub fn delete_highlight_set(
    set_id: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    delete_entity(state, &set_id, highlight_sets)
}

// ==================== 协议模板 ====================

#[tauri::command]
pub fn save_protocol_template(
    args: config::ProtocolTemplateEntry,
    state: State<AppState>,
) -> Result<String, CommandError> {
    save_entity(state, args, protocol_templates)
}

#[tauri::command]
pub fn load_protocol_templates(
    state: State<AppState>,
) -> Result<Vec<config::ProtocolTemplateEntry>, CommandError> {
    read_config(&state, |cfg| cfg.entities.protocol_templates.clone())
}

#[tauri::command]
pub fn delete_protocol_template(
    set_id: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    delete_entity(state, &set_id, protocol_templates)
}

// ==================== 端口参数预设 ====================

#[tauri::command]
pub fn save_port_preset(
    args: config::PortPresetEntry,
    state: State<AppState>,
) -> Result<String, CommandError> {
    save_entity(state, args, port_presets)
}

#[tauri::command]
pub fn load_port_presets(
    state: State<AppState>,
) -> Result<Vec<config::PortPresetEntry>, CommandError> {
    read_config(&state, |cfg| cfg.entities.port_presets.clone())
}

#[tauri::command]
pub fn delete_port_preset(
    preset_id: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    delete_entity(state, &preset_id, port_presets)
}

// ==================== 外部工具配置 ====================

#[tauri::command]
pub fn save_port_tool_config(
    args: config::PortToolConfigEntry,
    state: State<AppState>,
) -> Result<String, CommandError> {
    save_entity(state, args, port_tool_configs)
}

#[tauri::command]
pub fn load_port_tool_configs(
    state: State<AppState>,
) -> Result<Vec<config::PortToolConfigEntry>, CommandError> {
    read_config(&state, |cfg| cfg.entities.port_tool_configs.clone())
}

#[tauri::command]
pub fn delete_port_tool_config(
    config_id: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    delete_entity(state, &config_id, port_tool_configs)
}

// ==================== 串口分组 / 串口元数据 ====================

/// 整体替换保存全部串口分组（issue #2-3）。
/// 分组是「一个整体布局」而非独立实体：前端在分组变更（增删/改名/展开/
/// 拖拽成员）后防抖发送完整列表，这里一次替换并落盘。读取不需要专门命令——
/// `get_config` 已随 `AppConfig.entities.port_groups` 返回。
#[tauri::command]
pub fn save_port_groups(
    args: Vec<config::PortGroupEntry>,
    state: State<AppState>,
) -> Result<(), CommandError> {
    mutate_config(&state, |cfg| cfg.entities.port_groups = args)
}

/// 整体替换保存全部串口元数据（备注名 / 隐藏状态 / 工作模式，issue #4-9）。
/// 与 `save_port_groups` 同款整体替换语义。读取走 `AppConfig.entities.port_meta`。
#[tauri::command]
pub fn save_port_meta(
    args: Vec<config::PortMetaEntry>,
    state: State<AppState>,
) -> Result<(), CommandError> {
    mutate_config(&state, |cfg| cfg.entities.port_meta = args)
}

// ==================== 条件触发规则 ====================

#[tauri::command]
pub fn save_trigger_rule(
    args: config::TriggerRuleEntry,
    state: State<AppState>,
) -> Result<String, CommandError> {
    save_entity(state, args, trigger_rules)
}

#[tauri::command]
pub fn load_trigger_rules(
    state: State<AppState>,
) -> Result<Vec<config::TriggerRuleEntry>, CommandError> {
    read_config(&state, |cfg| cfg.entities.trigger_rules.clone())
}

#[tauri::command]
pub fn delete_trigger_rule(
    rule_id: String,
    state: State<AppState>,
) -> Result<(), CommandError> {
    delete_entity(state, &rule_id, trigger_rules)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    use crate::config::{ConfigManager, PortToolConfigEntry, SendCommandSetEntry};

    // 显式导入被测助手（不用 `use super::*;`：glob 会把本模块的命令/串口相关符号
    // 一并拖进测试二进制）。
    use super::{command_sets, delete_by_id, mutate, port_tool_configs, upsert};

    static NEXT_TEMP_ID: AtomicU32 = AtomicU32::new(0);

    /// 唯一的临时配置路径（进程号 + 自增计数），测试并行时不互相覆盖。
    fn temp_config_path() -> PathBuf {
        let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir()
            .join(format!(
                "hypercom_storage_test_{}_{}",
                std::process::id(),
                id
            ))
            .join("config.json")
    }

    fn command_set(id: &str, name: &str) -> SendCommandSetEntry {
        SendCommandSetEntry {
            id: id.into(),
            name: name.into(),
            is_loop: false,
            loop_delay: 0,
            repeat_count: 0,
            commands: Vec::new(),
        }
    }

    fn tool_config(id: &str, port_id: &str) -> PortToolConfigEntry {
        PortToolConfigEntry {
            id: id.into(),
            name: format!("tool-{port_id}"),
            port_id: port_id.into(),
            command: "ping".into(),
            workdir: String::new(),
        }
    }

    fn ids(items: &[SendCommandSetEntry]) -> Vec<&str> {
        items.iter().map(|e| e.id.as_str()).collect()
    }

    /// 空 id = 新建：补一个 uuid，而不是当成「id 为空的实体」存下来。
    ///
    /// 这也是「未知实体类型不被静默接受」在新结构下的唯一落点：实体种类是编译期的
    /// （`Entity` + 访问器宏，没有运行期字符串可传错），能被静默接受的就只剩空 id。
    #[test]
    fn upsert_generates_uuid_for_blank_id() {
        let mut items = vec![command_set("keep", "existing")];

        let id = upsert(&mut items, command_set("", "new"));

        assert!(uuid::Uuid::parse_str(&id).is_ok(), "not a uuid: {id}");
        assert_eq!(ids(&items), vec!["keep", id.as_str()]);
        // 落盘条目绝不留空 id（UUID 直接落进实体，调用方无需再回写）
        assert!(items.iter().all(|e| !e.id.is_empty()));
        assert_eq!(items[1].name, "new");

        // 两次空 id 新建互不覆盖
        let other = upsert(&mut items, command_set("", "another"));
        assert_ne!(other, id);
        assert_eq!(items.len(), 3);
    }

    /// 已知 id = 原地替换（不追加、不打乱顺序）。
    #[test]
    fn upsert_updates_in_place_by_id() {
        let mut items = vec![command_set("a", "one"), command_set("b", "two")];

        let id = upsert(&mut items, command_set("b", "two-renamed"));

        assert_eq!(id, "b");
        assert_eq!(ids(&items), vec!["a", "b"]);
        assert_eq!(items[1].name, "two-renamed");
        assert_eq!(items[0].name, "one");
    }

    /// 未知 id = 追加，并保留调用方给的 id。
    #[test]
    fn upsert_appends_unknown_id() {
        let mut items = vec![command_set("a", "one")];

        let id = upsert(&mut items, command_set("c", "three"));

        assert_eq!(id, "c");
        assert_eq!(ids(&items), vec!["a", "c"]);
    }

    /// 删除不存在的 id：无操作（不报错、不动其它条目）。
    #[test]
    fn delete_missing_id_is_noop() {
        let mut items = vec![command_set("a", "one"), command_set("b", "two")];

        delete_by_id(&mut items, "nope");

        assert_eq!(ids(&items), vec!["a", "b"]);
        assert_eq!(items[1].name, "two");
    }

    /// 删除只命中目标 id，剩余条目保持原顺序。
    #[test]
    fn delete_removes_only_target_id() {
        let mut items = vec![
            command_set("a", "one"),
            command_set("b", "two"),
            command_set("c", "three"),
        ];

        delete_by_id(&mut items, "b");

        assert_eq!(ids(&items), vec!["a", "c"]);
    }

    /// 真实往返：变更 → `save()` → 用同一路径重新加载，读回相同内容；
    /// 且各实体数组互不串味，删除同样经落盘生效。
    #[test]
    fn mutate_save_reload_roundtrip() {
        let path = temp_config_path();
        let dir = path.parent().expect("temp dir").to_path_buf();
        let mut manager = ConfigManager::new(Some(path.clone())).expect("open temp config");

        let fresh_id =
            mutate(&mut manager, |cfg| upsert(command_sets(cfg), command_set("", "fresh")))
                .expect("save new entry");
        mutate(&mut manager, |cfg| {
            upsert(command_sets(cfg), command_set("fixed", "first"))
        })
        .expect("save fixed entry");
        mutate(&mut manager, |cfg| {
            upsert(command_sets(cfg), command_set("fixed", "second"))
        })
        .expect("update fixed entry");
        mutate(&mut manager, |cfg| {
            upsert(port_tool_configs(cfg), tool_config("t1", "COM9"))
        })
        .expect("save tool config");

        let reloaded = ConfigManager::new(Some(path.clone())).expect("reload temp config");
        let in_memory = serde_json::to_value(&manager.get_config().entities.send_command_sets)
            .expect("serialize in-memory entities");
        let on_disk = serde_json::to_value(&reloaded.get_config().entities.send_command_sets)
            .expect("serialize reloaded entities");
        assert_eq!(on_disk, in_memory);

        let loaded = reloaded.get_config();
        assert_eq!(ids(&loaded.entities.send_command_sets), vec![fresh_id.as_str(), "fixed"]);
        assert_eq!(loaded.entities.send_command_sets[1].name, "second");
        // 类型决定落点：另一类实体写它自己的数组，未写入的数组保持空
        assert_eq!(loaded.entities.port_tool_configs.len(), 1);
        assert_eq!(loaded.entities.port_tool_configs[0].port_id, "COM9");
        assert!(loaded.entities.trigger_rules.is_empty());
        assert!(loaded.entities.highlight_rule_sets.is_empty());

        mutate(&mut manager, |cfg| delete_by_id(command_sets(cfg), "fixed"))
            .expect("delete fixed entry");
        let reloaded = ConfigManager::new(Some(path)).expect("reload after delete");
        assert_eq!(ids(&reloaded.get_config().entities.send_command_sets), vec![fresh_id.as_str()]);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
