# HyperCom 示例插件（issue #17）

演示插件系统的四个核心能力：RX 行旁路观察、`terminal.append` 旁注、声明式 UI 按钮、
`serial.send` 端口作用域。

从零编写插件、manifest 字段、完整 Worker API 和打包调试流程见[插件开发指南](../../docs/plugin-development.md)。本页只说明此示例的具体行为；普通用户安装和授权注意事项见[使用手册](../../docs/userwiki/设置.md#插件)。

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
2. 在权限区先勾选 `terminal:read` / `terminal:write`（`serial:send` 可选，仅用于端口作用域演示）；插件未启用时也可授权。
3. 点击启用（本示例声明敏感权限 `serial:send`，启用时弹确认框）。升级后需重新审阅权限再启用。
4. 打开任意 TRX 端口标签页；设备收到发送内容后若返回含 `PING` 的 RX 行，终端会出现 `PONG<...>`（本示例不观察本地 TX 回显）。
   点击工具栏“统计行数”会在活动端口追加旁注，无活动端口则写入插件输出面板。

## 行为说明

- `rx.line`（需 `terminal:read`）：每行回调载荷
  `{portId, seq, rawData: Uint8Array, encoding, ts}`——rawData 未解码，插件按
  `encoding` 自行解码。
- `rx.detached`：`reason: 'mode-tty'`（端口切 TTY，字节流无行语义）或
  `'port-disconnected'`（端口断线）——两种断流都通知。
- `serial.portWhitelist: ["COM9"]`：授予 serial:send 后，每次调用仍检查目标端口。示例启用事件尝试向 COM1 发送 demo-handshake，会被桥拒绝，不实际发送；若存在 COM1 终端，拒绝原因写为 NOTE 旁注。未授予 serial:send 时则先因缺权限被拒绝。
- 插件 label 不做宿主翻译；需要多语言时作者自管（本示例用中文单语）。
