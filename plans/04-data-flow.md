# 关键数据流

## 1. 串口连接

```
用户点击连接
  → Sidebar.onToggleConnect(portId)
    → useSerialConnection().toggleConnection(portId)
      → useSerialConnection().openPort(portId, baud)
        → updatePort(portId, { status: 'connected' })   // 乐观更新
        → serialService.openSerialPort({
            port_id, baud_rate, data_bits, parity, stop_bits, handshake, dtr, rts
          })  // 从 useAppStore.getState().op* 读取参数
          → invoke('open_serial_port', { args })
            → Rust: SerialManager.open_real_port() 或 open_sim_port()
              → serialport::new().open() 或 创建 mpsc channel
              → spawn 读线程
              → emit serial:status("connected")
            ← Ok(())
          ← Promise<void>
        → updatePort(portId, { status: 'connected', baudRate, ... })

同时: serial:status("connected") 事件
  → eventService.onSerialStatus(callback)
    → useAppStore.getState().updatePort(port_id, { status: 'connected' })
```

## 2. 串口数据接收

```
读线程 (50ms 轮询)
  → port.read(&mut buffer) → Ok(n > 0)
    → emit serial:data({
        port_id, timestamp, direction: "RX",
        data: buffer[..n].to_vec(), is_hex: false
      })
    → 前端 eventService.onSerialData(callback)
      → TextDecoder.decode(event.data)
      → appendTerminalLine(port_id, {
          id, timestamp, direction, content, isHex
        })
        → terminals[portId].lines.push(line)
        → 超出 maxLines 则 shift
      → setTrafficStats(port_id, {
          rxTotal: prev + event.data.length
        })  // 累加 RX
    → TerminalView 重渲染 (Zustand 订阅)
    → useEffect 检测 lines.length 变化
      → scrollRef.current.scrollTop = scrollHeight  // 自动滚底
```

## 3. 串口数据发送

```
用户输入 + 点击发送
  → OperationPanel.handleSend()
    → useSerialData().sendData(portId, data, isHex, lineEnding)
      → serialService.sendSerialData({
          port_id, data, is_hex, append_line_ending
        })
        → invoke('send_serial_data', { args })
          → Rust: 模拟端口 → channel.send(Echo) → 读线程 emit serial:data 回显
                   真实端口 → port.write(bytes) → port.flush()
          ← bytesWritten
      → appendTerminalLine(portId, { direction: 'TX', content: prefix + data })
      → setTrafficStats(portId, { txTotal: prev + bytesWritten })  // 累加 TX
      → setOpState({ opSendInput: '' })  // 清空输入框
```

## 4. 循环发送

```
用户点击开始循环
  → OperationPanel.handleToggleLoop()
    → setOpState({ opIsLoopSending: true })
    → useEffect 触发:
      ├─ 获取 activeSendCommandSet.commands
      ├─ 从第 0 条开始:
      │   └─ sendData(port, cmd.content, cmd.type, cmd.appendLineEnding)
      │       → await 完成
      │       → currentCmdIdx++
      │       → 如果是最后一条:
      │           ├─ 非循环模式 → setOpState({ opIsLoopSending: false }), 停止
      │           └─ 循环模式 → 等待 loopDelay ms, currentCmdIdx=0 重新开始
      │       → 否则: 等待 cmd.delay 或 opLoopInterval ms, 发送下一条
      └─ 停止:
          → setOpState({ opIsLoopSending: false })
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
      → setConfig(config)  // 写入 Store

用户保存配置
  → ConfigModal 保存按钮
    → useConfigPersistence().saveConfig(config)
      → configService.setConfig(config)
        → invoke('set_config', { new_config })
          → Rust: ConfigManager.set_config() → JSON 文件写入
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
    → setPorts(merged)
```

## 7. 数据库 CRUD

```
ConfigModal 加载规则集
  → HighlightSettings useEffect
    → storageService.loadHighlightSets()
      → invoke('load_highlight_sets')
        → Rust: lock → clone pool → drop lock
          → load_highlight_sets_from_db(&pool).await
            → SELECT * FROM highlight_rule_sets + highlight_rules
        ← Vec<HighlightSetInfo>
    → setHighlightRuleSets(transformed)

ConfigModal 保存规则集
  → handleSaveSet(set)
    → storageService.saveHighlightSet({ name, is_enabled, rules })
      → invoke('save_highlight_set', { args })
        → Rust: lock → clone pool → drop lock
          → save_highlight_set_to_db(&pool, &set).await
            → INSERT/REPLACE INTO highlight_rule_sets + highlight_rules
        ← set_id (UUID v4)
```

## 8. 语法高亮渲染

```
TerminalView 渲染每行
  → applyHighlightSets(line.content, highlightRuleSets)
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
