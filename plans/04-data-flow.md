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

## 4. 循环发送 (useCyclicSend) —— 每端口独立引擎 (issue #12)

```
用户点击 SendSection 紧凑头部的循环图标按钮 (当前聚焦端口 = COM3)
  → SendSection.handleToggleLoop()
    → useOperationStore.setCyclicLoop('COM3', true)   // 每端口运行标志 Record<portId, boolean>
    → useCyclicSend 的 reconcile useEffect 检测到 COM3 开启且无 runtime:
      ├─ startRuntime('COM3') — 为该端口创建独立 runtime (目标端口固定、聚焦无关)
      ├─ 每个 runtime 每 tick 从 useRuleStore.getState() 取 sendCommandSets
      │   按 activeSendCommandSetId 找到当前命令集 currentSet
      ├─ 从 currentCmdIdx = 0 开始, 每 tick 重读 store 取最新命令:
      │   └─ sendData('COM3', cmd.content, cmd.type, cmd.appendLineEnding, silent=true)
      │       → await 完成
      │       → 用「是否本轮最后一条」(currentCmdIdx === length-1) 判轮次边界:
      │           ├─ 非末条 → currentCmdIdx += 1, 等待 cmd.delay 发下一条
      │           └─ 末条   → completedRounds += 1
      │               ├─ 达到上限? (repeatCount>0 ? completedRounds>=repeatCount : !isLoop)
      │               │     → 是: setCyclicLoop('COM3', false), 停止
      │               │     → 否: currentCmdIdx = 0, 等待 loopDelay 进入下一轮
      ├─ 端口未连接 → 跳过 tick 不推进索引, 500ms 重试 (切聚焦/短暂断开不中断)
      └─ 停止:
          → 用户切回 COM3 聚焦, 按钮读 cyclicLoops['COM3'] 显示「停止」
          → setCyclicLoop('COM3', false) → reconcile 停掉 COM3 runtime
          → rt.stopped = true → clearTimeout
多端口并行: COM3 循环运行期间切到 COM4 再启动循环 → setCyclicLoop('COM4', true)
          → 独立 runtime 并行发送, 互不影响; 停止任一端口只影响该端口
注: 重复轮数 repeatCount 是命令集自有字段 (config.json); 轮内一律用 per-command
    delay, 仅轮间用 loopDelay; 各端口共享当前激活命令集 (activeSendCommandSetId)。
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
