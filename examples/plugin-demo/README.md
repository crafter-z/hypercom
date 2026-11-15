# HyperCom 基础插件示例

演示 RX 行旁路观察、`terminal.append` 旁注、声明式侧边栏按钮和 `serial.send` 端口作用域。入口见 [main.js](<main.js>)，权限与按钮声明见 [manifest.json](<manifest.json>)。

从零编写插件、manifest 字段、完整 Worker API 和打包调试流程见[插件开发指南](<../../docs/plugin-development.md>)。本页只说明此示例的具体行为；普通用户安装和授权注意事项见[插件使用](<../../docs/userwiki/插件.md>)。

## 目录格式

```
plugin-demo/                   # 本仓库示例源目录；安装后目录名由 manifest.id 决定
├── manifest.json              # 元数据 + 权限 + 作用域 + 声明式 UI
└── main.js                    # 入口（普通脚本，无 ESM import/require）
```

## 使用

1. 设置 → 插件 → “安装目录…”选择 `plugin-demo/`；或把插件打包为含
   `<插件id>/` 顶层目录的 ZIP，点击“安装 ZIP…”选择归档。安装后目录由宿主复制
   到 config.json 同目录的 `plugins/<id>/`；不要手动复制文件取代安装步骤。
2. 在权限区授予 `terminal:read` / `terminal:write`；`serial:send` 仅用于端口作用域拒绝演示，可不授予。插件未启用时也可授权。
3. 启用插件，按宿主提示确认实际所授权限；升级或替换后需重新审阅权限再启用。
4. 打开并连接一个 TRX 端口。收到含 `PING` 的 RX 行后，终端会出现 `PONG<...>` 旁注；**旁注不会向设备发送 PONG**，也不观察本地 TX 回显。
5. 点击侧边栏「统计行数」，有活动端口时追加旁注，无活动端口时写入插件输出面板。计数是本次 Worker 运行观察到的所有端口 RX 行总数，不是每端口独立计数。

## 行为说明

- `rx.line`（需 `terminal:read`）：回调收到数组批次，每项为 `{portId, seq, rawData: Uint8Array, encoding, ts}`。示例使用默认 UTF-8 `TextDecoder` 识别 ASCII 关键字 `PING`，未按每项 `encoding` 切换解码；若用于其他编码，需要作者自行适配。
- `rx.detached`：`reason: 'mode-tty'`（端口切 TTY，字节流无行语义）或
  `'port-disconnected'`（端口断线）——两种断流都通知。
- `serial.portWhitelist: ["COM9"]`：授予 serial:send 后，每次调用仍检查目标端口。示例启用事件尝试向 COM1 发送 demo-handshake，会被桥拒绝，不实际发送；若存在 COM1 终端，拒绝原因写为 NOTE 旁注。未授予 serial:send 时则先因缺权限被拒绝。
- 插件 label 不做宿主翻译；需要多语言时作者自管（本示例用中文单语）。
