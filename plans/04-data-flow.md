# 关键数据流

## 1. 串口连接

```
用户点击连接
  → Sidebar.onToggleConnect(portId)
    → useSerialConnection().toggleConnection(portId)
      → useSerialConnection().openPort(portId, baud)
        → useAppStore.updatePort(portId, { status: 'connected' })   // 乐观更新
        → serialService.openSerialPort({
            port_id, baud_rate, data_bits, parity, stop_bits, handshake, dtr, rts
          })  // 从 useOperationStore.getState().op* 读取参数
          → invoke('open_serial_port', { args })
            → Rust: SerialManager.open_real_port() 或 open_sim_port()
              → serialport::new().open() 或 创建 mpsc channel
              → spawn 读线程
              → emit serial:status("connected")
            ← Ok(())
          ← Promise<void>
        → useAppStore.updatePort(portId, { status: 'connected', baudRate, ... })

同时: serial:status("connected") 事件
  → eventService.onSerialStatus(callback)
    → useSerialReceive 回调
      → useAppStore.getState().updatePort(port_id, { status: 'connected' })
```

## 2. 串口数据接收 (useSerialReceive)

```
读线程 (50ms 轮询)
  → port.read(&mut buffer) → Ok(n > 0)
    → emit_data_event(serial:data{
        port_id, timestamp, direction: "RX",
        data: buffer[..n].to_vec(), is_hex: false
      })
    → 前端 eventService.onSerialData(callback)
      → useSerialReceive 回调
        → TextDecoder.decode(event.data)
        → useTerminalStore.getState().appendTerminalLine(port_id, {
            id, timestamp, direction, content, isHex
          })
          → terminals[portId].lines.push(line)
          → 超出 maxLines 则 shift
        → useAppStore.getState().setTrafficStats(port_id, {
            rxTotal: prev + event.data.length
          })  // 累加 RX
    → TerminalView 重渲染 (Zustand 订阅 useTerminalStore)
    → useEffect 检测 lines.length 变化
      → scrollRef.current.scrollTop = scrollHeight  // 自动滚底
```

## 3. 串口数据发送 (useSerialSend)

```
用户输入 + 点击发送
  → SendSection.handleSend()
    → useSerialSend().sendData(portId, data, isHex, lineEnding)
      → serialService.sendSerialData({
          port_id, data, is_hex, append_line_ending
        })
        → invoke('send_serial_data', { args })
          → Rust: 模拟端口 → channel.send(Echo) → 读线程 emit serial:data 回显
                   真实端口 → port.write(bytes) → port.flush()
          ← bytesWritten
      → useTerminalStore.getState().appendTerminalLine(portId, { direction: 'TX', content: prefix + data })
      → useAppStore.getState().setTrafficStats(portId, { txTotal: prev + bytesWritten })  // 累加 TX
      → useOperationStore.getState().setOpState({ opSendInput: '' })  // 清空输入框
```

## 4. 循环发送 (useCyclicSend)

```
用户点击开始循环
  → RulesSection.handleToggleLoop()
    → useOperationStore.setOpState({ opIsLoopSending: true })
    → useCyclicSend useEffect 触发:
      ├─ 从 useRuleStore 获取 sendCommandSets
      │   按 useOperationStore.opActiveSendCommandSetId 找到当前命令集
      ├─ 从第 0 条开始:
      │   └─ useSerialSend().sendData(port, cmd.content, cmd.type, cmd.appendLineEnding)
      │       → await 完成
      │       → useOperationStore.setOpState({ opCurrentCmdIdx: idx++ })
      │       → 如果是最后一条:
      │           ├─ 非循环模式 → setOpState({ opIsLoopSending: false }), 停止
      │           └─ 循环模式 → 等待 loopDelay ms, currentCmdIdx=0 重新开始
      │       → 否则: 等待 cmd.delay 或 opLoopInterval ms, 发送下一条
      └─ 停止:
          → useOperationStore.setOpState({ opIsLoopSending: false })
          → ref.stopped = true → clearTimeout
```

## 5. 配置读写

```
应用启动
  → App.tsx → useAppInit()
    → useConfigPersistence().loadConfig()
      → configService.getConfig()
        → invoke('get_config')
          → Rust: ConfigManager.get_config() → JSON 文件读取
        ← AppConfig
      → useAppStore.setConfig(config)  // 写入主 Store

用户保存配置
  → ConfigModal 保存按钮
    → useConfigPersistence().saveConfig(config)
      → configService.setConfig(config)
        → invoke('set_config', { new_config })
          → Rust: ConfigManager.set_config() → JSON 文件写入
            → sync_log_manager_from_config()  // set_config/reset_config 内部同步日志设置到 LogManager

注: 会话快照 (session snapshot) 走独立命令 get_session_snapshot / update_session_snapshot，
    读写独立的 session.json (不触发 config.json 的 .bak 备份)。
```

## 6. 端口列表刷新 (mergePorts 去重)

```
每 3 秒
  → useSerialPorts(3000).refreshPorts()
    → serialService.listAvailablePorts()
      → invoke('list_available_ports')
        ← AvailablePortInfo[]
    → mapPortInfo: id → SerialPort (status='disconnected')
    → mergePorts(incoming, existing):
        incoming.map(p => {
          prev = existing.find(e => e.id === p.id)
          if (prev) return { ...p, status: prev.status, alias, isHidden, groupId, baudRate, ... }
          return p
        })
    → useAppStore.setPorts(merged)
```

## 7. 设置实体 CRUD (config.json)

```
ConfigModal 加载规则集
  → HighlightSettings useEffect
    → storageService.loadHighlightSets()
      → invoke('load_highlight_sets')
        → Rust: lock config_manager
          → 返回 AppConfig.highlight_rule_sets 的 clone
        ← Vec<HighlightRuleSetEntry>   // camelCase 线格式 == store 格式
    → useRuleStore.setHighlightRuleSets(...)

ConfigModal 保存规则集
  → RuleSetAccordion handleSaveSet(set)
    → storageService.saveHighlightSet({ name, isEnabled, rules })
      → invoke('save_highlight_set', { args })
        → Rust: lock config_manager
          → 通过 get_config_mut() 修改 AppConfig.highlight_rule_sets
          → save() 原子写入 config.json (tmp + rename + .bak)
        ← set_id (UUID v4)
    → useRuleStore 更新对应规则集
```

## 8. 语法高亮渲染

```
TerminalView 渲染每行
  → applyHighlightSets(line.content, highlightRuleSets)
    ├─ 从 useRuleStore 订阅 highlightRuleSets
    ├─ 过滤 isEnabled 的规则集
    ├─ 遍历每条规则:
    │   ├─ isRegex → new RegExp(pattern, 'g').exec(text)
    │   └─ 关键词 → indexOf 循环
    ├─ 收集所有 HighlightMatch[]
    ├─ 按位置排序去重 (优先最长匹配)
    └─ 构建 HTML:
        <span class="terminal-content">
          普通文本<span style="color:#ff6b6b;font-weight:bold">匹配词</span>普通文本
        </span>
    → 通过 dangerouslySetInnerHTML 注入 (escapeHtml 防 XSS)
```

## 9. 协议解析与字段着色

```
串口数据到达 (serial:data 事件)
  → useSerialReceive 回调
    → 检查端口是否绑定协议模板 (port.protocolTemplateId)
    → 如果绑定且模板已启用:
      → 获取/创建 ProtocolFrameReassembler (per-port, useRef Map)
      → reassembler.feed(event.data)
        ├─ 追加字节到内部 buffer
        ├─ 循环:
        │   ├─ buffer > MAX_FRAME_SIZE (64KB)? → 全部 flush 为非帧字节
        │   ├─ headerBytes 非空? → 扫描 buffer 寻找帧头
        │   │   ├─ 未找到 → flush 全部 buffer 为非帧字节
        │   │   └─ 找到 (offset > 0) → flush 帧头之前的字节
        │   ├─ parseFrameBytes(buffer, template):
        │   │   ├─ 验证帧头匹配
        │   │   ├─ 读取长度字段 → totalFrameLength = lengthValue - adjust + fieldSize
        │   │   ├─ 验证帧尾
        │   │   ├─ 计算校验和 (sum8/xor8/crc8) → isValid
        │   │   └─ 构建 ParsedField[] (Header/Length/Payload/Checksum/Footer + 颜色)
        │   ├─ 完整帧 → 提取, 继续循环
        │   └─ 不完整 → break (等待更多字节)
        ├─ 每个 frame → appendTerminalLine(parsedFields: frame.fields, rawData: frame.bytes)
        └─ flushedBytes → appendTerminalLine (无 parsedFields, 普通行)
      → 端口断开时清理 reassembler (onSerialStatus disconnected → delete from Map)

TerminalView 渲染每行
  → line.parsedFields 存在?
    → YES: renderProtocolLine(line)
      ├─ hex 模式: 每字段字节 → 2字符 hex, 包裹 <span style="color:...">
      └─ text 模式: 每字段字节 → TextDecoder 解码, escapeHtml, 包裹 <span>
    → NO: applyHighlightSets(displayText, highlightRuleSets) [原有路径]
  → dangerouslySetInnerHTML 注入
```
