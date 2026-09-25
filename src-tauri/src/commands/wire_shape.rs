/**
 * 命令参数 wire 形状守卫（前端 `invoke(cmd, { args })` ↔ Rust 反序列化）。
 *
 * 为什么需要这层守卫：e2e 的 mock 忽略 args、tsc 看不见字符串、vitest 也跑不到 Rust
 * 反序列化——所以「把参数约定统一成 camelCase」这类改动只会在运行时以 serde
 * `missing field` 爆掉（本轮重构就改过 `close_popout` 的参数名）。每个测试断言两件事：
 *   1) 前端**实际传的 key**（读 `src/services` 下的 service 文件得到）能反序列化成功；
 *   2) 换成另一种大小写风格会失败——将来有人加/删 `#[serde(rename_all = "camelCase")]`
 *      会立刻杠红。
 *
 * **两类 key 不要混**（参数约定见 `src/services/tauri.ts` 文件头）：
 *   - **结构体字段**（`invoke(cmd, { args: {...} })` 的嵌套对象）：wire 名 = serde
 *     字段名。命令入参结构体**没有** `rename_all`，所以是 snake_case（`port_id`）；
 *     持久化实体结构体有 `#[serde(rename_all = "camelCase")]`，所以是 camelCase
 *     （`isLoop`）。
 *   - **命令形参**（`fn close_popout(kind, target_id, on)`）：不是 serde 结构体。
 *     Tauri 默认把形参 ident 转 lowerCamelCase 当 IPC key（tauri-macros 的
 *     `ArgumentCase::Camel`），所以是 `targetId`——见文件末尾的 popout 测试。
 *
 * 测试模块显式 import（绝不用 `use super::*`）：glob 会把 serialport FFI 相关符号拖进
 * 测试二进制，Windows 下 `cargo test` 加载失败（0xc0000139）。
 */
use serde::Deserialize;

use crate::commands::{
    DiagLogEntry, OpenPortArgs, RunPortToolArgs, SendDataArgs, SendFileArgs, SetSerialParamsArgs,
};
use crate::config::{
    AppConfig, HighlightRuleSetEntry, PortGroupEntry, PortMetaEntry, PortPresetEntry,
    PortToolConfigEntry, ProtocolTemplateEntry, SendCommandEntry, SendCommandSetEntry,
    TriggerRuleEntry,
};

// ==================== 命令入参结构体（snake_case：无 rename_all）====================

/// `src/services/serial.ts::openSerialPort` → `{ args: { port_id, … } }`。
#[test]
fn open_port_args_wire_keys_are_snake_case() {
    let args: OpenPortArgs = serde_json::from_value(serde_json::json!({
        "port_id": "COM3", "baud_rate": 115200, "data_bits": 8,
        "parity": "None", "stop_bits": "One", "handshake": "None",
        "dtr": false, "rts": true, "cols": 120, "rows": 30,
    }))
    .expect("frontend wire keys must deserialize");
    assert_eq!(args.port_id, "COM3");
    assert_eq!(args.baud_rate, 115200);
    assert_eq!((args.cols, args.rows), (120, 30));

    // TTY 尺寸可省：前端 undefined 的 cols/rows 被 JSON.stringify 丢掉 → serde 默认 80×24。
    let args: OpenPortArgs = serde_json::from_value(serde_json::json!({
        "port_id": "COM3", "baud_rate": 9600, "data_bits": 8,
        "parity": "None", "stop_bits": "One", "handshake": "None", "dtr": false, "rts": false,
    }))
    .unwrap();
    assert_eq!((args.cols, args.rows), (80, 24));

    // camelCase 拼写必须失败（结构体无 rename_all，wire 名就是字段名）。
    assert!(serde_json::from_value::<OpenPortArgs>(serde_json::json!({
        "portId": "COM3", "baudRate": 9600, "dataBits": 8,
        "parity": "None", "stopBits": "One", "handshake": "None", "dtr": false, "rts": false,
    }))
    .is_err());
}

/// `src/services/serial.ts::sendSerialData` → `{ args: { port_id, is_hex, append_line_ending } }`。
#[test]
fn send_data_args_wire_keys_are_snake_case() {
    let args: SendDataArgs = serde_json::from_value(serde_json::json!({
        "port_id": "COM3", "data": "AT", "is_hex": false, "append_line_ending": "\\r\\n",
    }))
    .expect("frontend wire keys must deserialize");
    assert_eq!(args.append_line_ending, "\\r\\n");

    assert!(serde_json::from_value::<SendDataArgs>(serde_json::json!({
        "portId": "COM3", "data": "AT", "isHex": false, "appendLineEnding": "None",
    }))
    .is_err());
}

/// `src/services/serial.ts::sendFile` → `{ args: { port_id, path, chunk_size, delay_ms } }`。
#[test]
fn send_file_args_wire_keys_are_snake_case() {
    let args: SendFileArgs = serde_json::from_value(serde_json::json!({
        "port_id": "COM3", "path": "C:\\fw.bin", "chunk_size": 1024, "delay_ms": 5,
    }))
    .expect("frontend wire keys must deserialize");
    assert_eq!(args.chunk_size, 1024);
    assert_eq!(args.delay_ms, 5);

    assert!(serde_json::from_value::<SendFileArgs>(serde_json::json!({
        "portId": "COM3", "path": "C:\\fw.bin", "chunkSize": 1024, "delayMs": 5,
    }))
    .is_err());
}

/// `src/services/serial.ts::setSerialParams` → `{ args: { port_id, baud_rate, … } }`。
#[test]
fn set_serial_params_args_wire_keys_are_snake_case() {
    let args: SetSerialParamsArgs = serde_json::from_value(serde_json::json!({
        "port_id": "COM3", "baud_rate": 115200, "data_bits": 8,
        "parity": "Odd", "stop_bits": "Two", "handshake": "RequestToSend",
    }))
    .expect("frontend wire keys must deserialize");
    assert_eq!(args.parity, "Odd");
    assert_eq!(args.handshake, "RequestToSend");

    assert!(serde_json::from_value::<SetSerialParamsArgs>(serde_json::json!({
        "portId": "COM3", "baudRate": 115200, "dataBits": 8,
        "parity": "Odd", "stopBits": "Two", "handshake": "RequestToSend",
    }))
    .is_err());
}

/// `src/services/tool.ts::runPortTool` → `{ args: { port_id, command, workdir } }`；
/// 无工作目录时前端显式传 `null`（`workdir ?? null`）。
#[test]
fn run_port_tool_args_wire_keys_are_snake_case() {
    let args: RunPortToolArgs = serde_json::from_value(serde_json::json!({
        "port_id": "COM3", "command": "openocd {port}", "workdir": "C:\\tools",
    }))
    .expect("frontend wire keys must deserialize");
    assert_eq!(args.workdir.as_deref(), Some("C:\\tools"));

    let args: RunPortToolArgs = serde_json::from_value(serde_json::json!({
        "port_id": "COM3", "command": "openocd {port}", "workdir": null,
    }))
    .unwrap();
    assert_eq!(args.workdir, None);

    assert!(serde_json::from_value::<RunPortToolArgs>(serde_json::json!({
        "portId": "COM3", "command": "openocd {port}", "workDir": null,
    }))
    .is_err());
}

/// `src/services/diag.ts::appendDiagLog` → `{ entries: [...] }`（`Vec<DiagLogEntry>`）。
/// 三个字段都是单词小写，不存在大小写拼写歧义——负例只针对字段名本身。
#[test]
fn diag_log_entry_wire_keys() {
    let entries: Vec<DiagLogEntry> = serde_json::from_value(serde_json::json!([
        { "timestamp": "2026-09-25 10:00:00.123", "level": "error", "message": "boom" },
    ]))
    .expect("frontend wire keys must deserialize");
    assert_eq!(entries[0].level, "error");

    // 改字段名（或漏掉必填字段）必须失败——前端 payload 里 message 永远存在。
    assert!(serde_json::from_value::<Vec<DiagLogEntry>>(serde_json::json!([
        { "timestamp": "t", "level": "error", "msg": "boom" },
    ]))
    .is_err());
}

// ==================== 持久化实体（camelCase：rename_all）====================
//
// 这些结构体既进 config.json，也作为 `commands/storage.rs` 的命令入参（`{ args }`）。
// 前端 store 里的对象逐字段镜像它们（src/types/index.ts）。

/// `save_command_set` → `SendCommandSetEntry`（含嵌套 `SendCommandEntry`）。
/// 注意 `cmd_type` 的 serde rename：wire key 是 `type`，不是 `cmdType`。
#[test]
fn send_command_set_entry_wire_keys_are_camel_case() {
    let set: SendCommandSetEntry = serde_json::from_value(serde_json::json!({
        "id": "s1", "name": "上电序列", "isLoop": true, "loopDelay": 200, "repeatCount": 0,
        "commands": [{
            "id": "c1", "name": "Ping", "order": 0, "delay": 50,
            "type": "string", "content": "AT", "appendLineEnding": "\\r\\n",
        }],
    }))
    .expect("frontend wire keys must deserialize");
    assert!(set.is_loop);
    assert_eq!(set.commands[0].cmd_type, "string");

    // snake_case 拼写必须失败（含嵌套字段 `type` 的正确 wire 名）。
    assert!(serde_json::from_value::<SendCommandSetEntry>(serde_json::json!({
        "id": "s1", "name": "n", "is_loop": true, "loopDelay": 0, "repeatCount": 0,
        "commands": [],
    }))
    .is_err());
    assert!(serde_json::from_value::<SendCommandEntry>(serde_json::json!({
        "id": "c1", "name": "Ping", "order": 0, "delay": 50,
        "cmdType": "string", "content": "AT", "appendLineEnding": "None",
    }))
    .is_err());
}

/// `save_highlight_set` → `HighlightRuleSetEntry`（含嵌套 `HighlightRuleEntry`）。
#[test]
fn highlight_rule_set_entry_wire_keys_are_camel_case() {
    let set: HighlightRuleSetEntry = serde_json::from_value(serde_json::json!({
        "id": "h1", "name": "关键字", "isEnabled": true,
        "rules": [{
            "id": "r1", "name": "ERROR", "pattern": "ERROR", "isRegex": false,
            "color": "#ff0000", "bold": true, "italic": false,
        }],
    }))
    .expect("frontend wire keys must deserialize");
    assert!(set.is_enabled);
    assert!(set.rules[0].bold);

    assert!(serde_json::from_value::<HighlightRuleSetEntry>(serde_json::json!({
        "id": "h1", "name": "n", "is_enabled": true, "rules": [],
    }))
    .is_err());
    assert!(serde_json::from_value::<HighlightRuleSetEntry>(serde_json::json!({
        "id": "h1", "name": "n", "isEnabled": true,
        "rules": [{
            "id": "r1", "name": "ERROR", "pattern": "ERROR", "is_regex": false,
            "color": "#ff0000", "bold": true, "italic": false,
        }],
    }))
    .is_err());
}

/// `save_protocol_template` → `ProtocolTemplateEntry`。
#[test]
fn protocol_template_entry_wire_keys_are_camel_case() {
    let tpl: ProtocolTemplateEntry = serde_json::from_value(serde_json::json!({
        "id": "p1", "name": "帧解析", "isEnabled": true,
        "headerBytes": "AA BB", "lengthFieldOffset": 2, "lengthFieldSize": 2,
        "lengthEndian": "little", "lengthAdjust": 0, "checksumAlgorithm": "sum8",
        "checksumOffset": 0, "footerBytes": "0D 0A",
        "colorHeader": "#ff0000", "colorLength": "#00ff00", "colorPayload": "#00ffff",
        "colorChecksum": "#f48771", "colorFooter": "#0000ff",
    }))
    .expect("frontend wire keys must deserialize");
    assert_eq!(tpl.length_endian, "little");
    assert_eq!(tpl.checksum_algorithm, "sum8");

    assert!(serde_json::from_value::<ProtocolTemplateEntry>(serde_json::json!({
        "id": "p1", "name": "n", "is_enabled": true,
        "headerBytes": "", "lengthFieldOffset": 0, "lengthFieldSize": 2,
        "lengthEndian": "little", "lengthAdjust": 0, "checksumAlgorithm": "none",
        "checksumOffset": 0, "footerBytes": "",
        "colorHeader": "", "colorLength": "", "colorPayload": "",
        "colorChecksum": "", "colorFooter": "",
    }))
    .is_err());
}

/// `save_trigger_rule` → `TriggerRuleEntry`（`portId` 可缺省 = 全部端口）。
#[test]
fn trigger_rule_entry_wire_keys_are_camel_case() {
    let rule: TriggerRuleEntry = serde_json::from_value(serde_json::json!({
        "id": "t1", "name": "重启", "pattern": "reset", "isRegex": false,
        "matchType": "contains", "actionType": "alert", "actionContent": "复位",
        "actionIsHex": false, "isEnabled": true, "portId": "COM3",
    }))
    .expect("frontend wire keys must deserialize");
    assert_eq!(rule.match_type, "contains");
    assert_eq!(rule.port_id.as_deref(), Some("COM3"));

    // 旧规则无 portId → None（issue #3-1）。
    let rule: TriggerRuleEntry = serde_json::from_value(serde_json::json!({
        "id": "t1", "name": "n", "pattern": "p", "isRegex": false,
        "matchType": "contains", "actionType": "alert", "actionContent": "",
        "actionIsHex": false, "isEnabled": true,
    }))
    .unwrap();
    assert_eq!(rule.port_id, None);

    assert!(serde_json::from_value::<TriggerRuleEntry>(serde_json::json!({
        "id": "t1", "name": "n", "pattern": "p", "isRegex": false,
        "match_type": "contains", "actionType": "alert", "actionContent": "",
        "actionIsHex": false, "isEnabled": true,
    }))
    .is_err());
}

/// `save_port_preset` → `PortPresetEntry`。
#[test]
fn port_preset_entry_wire_keys_are_camel_case() {
    let preset: PortPresetEntry = serde_json::from_value(serde_json::json!({
        "id": "p1", "name": "STM32", "baudRate": 115200, "dataBits": 8,
        "parity": "None", "stopBits": "One", "handshake": "None", "dtr": false, "rts": true,
    }))
    .expect("frontend wire keys must deserialize");
    assert_eq!(preset.baud_rate, 115200);
    assert_eq!(preset.stop_bits, "One");

    assert!(serde_json::from_value::<PortPresetEntry>(serde_json::json!({
        "id": "p1", "name": "STM32", "baud_rate": 115200, "dataBits": 8,
        "parity": "None", "stopBits": "One", "handshake": "None", "dtr": false, "rts": true,
    }))
    .is_err());
}

/// `save_port_tool_config` → `PortToolConfigEntry`。
#[test]
fn port_tool_config_entry_wire_keys_are_camel_case() {
    let cfg: PortToolConfigEntry = serde_json::from_value(serde_json::json!({
        "id": "c1", "name": "烧录", "portId": "COM5",
        "command": "openocd -c {port}", "workdir": "",
    }))
    .expect("frontend wire keys must deserialize");
    assert_eq!(cfg.port_id, "COM5");

    assert!(serde_json::from_value::<PortToolConfigEntry>(serde_json::json!({
        "id": "c1", "name": "烧录", "port_id": "COM5",
        "command": "openocd -c {port}", "workdir": "",
    }))
    .is_err());
}

/// `save_port_groups` → `Vec<PortGroupEntry>`（整体替换，前端直传数组）。
#[test]
fn port_group_entry_wire_keys_are_camel_case() {
    let groups: Vec<PortGroupEntry> = serde_json::from_value(serde_json::json!([{
        "id": "g1", "name": "开发板", "isExpanded": true,
        "portIds": ["COM1", "COM12"], "order": 0,
    }]))
    .expect("frontend wire keys must deserialize");
    assert_eq!(groups[0].port_ids.len(), 2);

    assert!(serde_json::from_value::<Vec<PortGroupEntry>>(serde_json::json!([{
        "id": "g1", "name": "开发板", "is_expanded": true,
        "portIds": ["COM1"], "order": 0,
    }]))
    .is_err());
}

/// `save_port_meta` → `Vec<PortMetaEntry>`（整体替换，前端直传数组）。
#[test]
fn port_meta_entry_wire_keys_are_camel_case() {
    let meta: Vec<PortMetaEntry> = serde_json::from_value(serde_json::json!([{
        "portId": "COM3", "alias": "温度计", "isHidden": true, "mode": "tty",
    }]))
    .expect("frontend wire keys must deserialize");
    assert_eq!(meta[0].mode.as_deref(), Some("tty"));

    // 旧版 config.json 缺 alias/isHidden/mode（#[serde(default)]）仍可反序列化。
    let meta: Vec<PortMetaEntry> =
        serde_json::from_value(serde_json::json!([{ "portId": "COM3" }])).unwrap();
    assert_eq!(meta[0].mode, None);

    assert!(serde_json::from_value::<Vec<PortMetaEntry>>(serde_json::json!([{
        "port_id": "COM3",
    }]))
    .is_err());
}

/// `set_config(new_config: AppConfig)` → 顶层形参 key 由 Tauri 映射为 `newConfig`
/// （前端 `src/services/config.ts` 正是 `{ newConfig: config }`），嵌套字段是 camelCase。
///
/// `AppConfig` 是容器级 `#[serde(default)]`，**任何** key 拼错都不会失败——所以这里
/// 的负例换成「snake_case key 被忽略、字段保持默认值」，同样能钉住 wire 名。
#[test]
fn app_config_wire_keys_are_camel_case() {
    let cfg: AppConfig = serde_json::from_value(serde_json::json!({
        "closeBehavior": "minimize",
        "maxDisplayLines": 200000,
        "logSubdirMode": "port",
        "autoReconnect": true,
    }))
    .expect("frontend wire keys must deserialize");
    assert_eq!(cfg.close_behavior, "minimize");
    assert_eq!(cfg.max_display_lines, 200000);
    assert_eq!(cfg.log_subdir_mode, "port");
    assert!(cfg.auto_reconnect);

    // snake_case 拼写不是 wire 名 → 整个对象被 serde 当未知字段丢弃，全部回默认值。
    let snake: AppConfig = serde_json::from_value(serde_json::json!({
        "close_behavior": "minimize",
        "max_display_lines": 200000,
        "log_subdir_mode": "port",
    }))
    .expect("unknown keys are ignored, not rejected");
    assert_eq!(snake.close_behavior, "exit");
    assert_eq!(snake.max_display_lines, 100000);
    assert_eq!(snake.log_subdir_mode, "date");
}

// ==================== 命令形参（Tauri camelCase 映射，不是 serde 结构体）====================
//
// `open_popout` / `close_popout` / `set_popout_always_on_top` 收的是**形参**而非结构体
// payload：Tauri 默认把形参 ident 转 lowerCamelCase 当 IPC key（`target_id` →
// `targetId`），前端 src/services/popout.ts 正是传 `{ kind, targetId }` /
// `{ kind, targetId, on }`。
//
// 这里用字段名与签名逐字相同的镜像结构体复现这层映射（Rust 无法在测试里构造 Tauri
// 内部的 InvokeMessage，故无法直接驱动真实签名）。`popout_command_signature_matches_mirror`
// 从 popout.rs 源码解析真实形参并断言与镜像一致——改签名不同步改这里会杠红。

/// 镜像 `open_popout(app, state, kind, target_id)` 与 `close_popout(app, state, kind,
/// target_id)`：两者 IPC 形状相同（`app` / `state` 是 Tauri 状态形参，不占 IPC key）。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClosePopoutParams {
    kind: String,
    target_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetAlwaysOnTopParams {
    kind: String,
    target_id: Option<String>,
    on: bool,
}

#[test]
fn popout_command_params_use_camel_case_ipc_keys() {
    let params: ClosePopoutParams =
        serde_json::from_value(serde_json::json!({ "kind": "terminal", "targetId": "COM3" }))
            .expect("frontend wire keys must deserialize");
    assert_eq!(params.kind, "terminal");
    assert_eq!(params.target_id.as_deref(), Some("COM3"));

    // 无目标端口时前端传 null（`targetId ?? null`）→ Option None。
    let params: ClosePopoutParams =
        serde_json::from_value(serde_json::json!({ "kind": "quick-send", "targetId": null }))
            .unwrap();
    assert_eq!(params.target_id, None);

    // snake_case 形参名不是 IPC key。`target_id: Option` 缺 key 时 serde 回 None（不报错），
    // 所以这里断言**值被丢弃**——若有人把命令改成 `rename_all = "snake_case"`（或 Tauri
    // 把 case 策略改掉），target_id 会突然读出来，这条立刻杠红。
    let params: ClosePopoutParams =
        serde_json::from_value(serde_json::json!({ "kind": "terminal", "target_id": "COM3" }))
            .expect("missing Option key is None, not an error");
    assert_eq!(
        params.target_id, None,
        "snake_case target_id must not be the IPC key"
    );

    let params: SetAlwaysOnTopParams = serde_json::from_value(
        serde_json::json!({ "kind": "terminal", "targetId": "COM3", "on": true }),
    )
    .expect("frontend wire keys must deserialize");
    assert_eq!(params.kind, "terminal");
    assert_eq!(params.target_id.as_deref(), Some("COM3"));
    assert!(params.on);

    // `on: bool` 是必填形参（前端总是传）：漏掉必须失败。
    assert!(serde_json::from_value::<SetAlwaysOnTopParams>(
        serde_json::json!({ "kind": "terminal", "targetId": "COM3" })
    )
    .is_err());
}

/// 从源码解析 `pub [async] fn <name>(...)` 的形参 ident 列表（按 `<`/`(` 深度切逗号）。
fn command_param_idents(src: &str, fn_name: &str) -> Vec<String> {
    let needle = format!("fn {fn_name}(");
    let mut search_from = 0;
    // 只认 `pub fn` / `pub async fn` 定义行——避免匹配到调用点或注释里的同名片段。
    let fn_pos = loop {
        let pos = search_from
            + src[search_from..]
                .find(&needle)
                .unwrap_or_else(|| panic!("popout.rs must declare pub fn {fn_name}"));
        let line_start = src[..pos].rfind('\n').map(|i| i + 1).unwrap_or(0);
        let prefix = src[line_start..pos].trim();
        if prefix == "pub" || prefix == "pub async" {
            break pos;
        }
        search_from = pos + needle.len();
    };
    let start = fn_pos + needle.len();
    let mut depth = 0usize;
    let mut end = None;
    for (i, ch) in src[start..].char_indices() {
        match ch {
            '<' | '(' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            ')' => {
                if depth == 0 {
                    end = Some(start + i);
                    break;
                }
                depth -= 1;
            }
            _ => {}
        }
    }
    let params = &src[start..end.expect("unterminated parameter list")];

    let mut idents = Vec::new();
    let mut depth = 0usize;
    let mut current = String::new();
    let flush = |current: &mut String, idents: &mut Vec<String>| {
        let ident = current.split(':').next().unwrap_or("").trim();
        if !ident.is_empty() {
            idents.push(ident.to_string());
        }
        current.clear();
    };
    for ch in params.chars() {
        match ch {
            '<' | '(' => {
                depth += 1;
                current.push(ch);
            }
            '>' | ')' => {
                depth = depth.saturating_sub(1);
                current.push(ch);
            }
            ',' if depth == 0 => flush(&mut current, &mut idents),
            _ => current.push(ch),
        }
    }
    flush(&mut current, &mut idents);
    idents
}

/// 签名漂移守卫：真实 `#[tauri::command]` 形参集合必须与上面的镜像结构体一致。
/// `app` / `state` 是 Tauri 状态形参（不占 IPC key），其余 ident 经 lowerCamelCase
/// 就是前端传的 key（`target_id` → `targetId`）。
#[test]
fn popout_command_signature_matches_mirror() {
    let src = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/commands/popout.rs"),
    )
    .unwrap();

    assert_eq!(
        command_param_idents(&src, "open_popout"),
        ["app", "state", "kind", "target_id"]
    );
    assert_eq!(
        command_param_idents(&src, "close_popout"),
        ["app", "state", "kind", "target_id"]
    );
    assert_eq!(
        command_param_idents(&src, "set_popout_always_on_top"),
        ["app", "kind", "target_id", "on"]
    );
}
