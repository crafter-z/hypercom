# HyperCom 示例插件（issue #17）

演示插件系统的四个核心能力：RX 行旁路观察、`terminal.append` 旁注、声明式 UI 按钮、
`serial.send` 端口作用域。

## 目录格式

```
com.example.hypercom-demo/     # 目录名 = manifest id
├── manifest.json              # 元数据 + 权限 + 作用域 + 声明式 UI
└── main.js                    # 入口（普通脚本，无 ESM import/require）
```

## 使用

1. 设置 → 插件 → “安装目录…”选择 `plugin-demo/`；或把插件打包为含
   `<插件id>/` 顶层目录的 ZIP，点击“安装 ZIP…”选择归档。安装后目录由宿主复制
   到 config.json 同目录的 `plugins/<id>/`；不要手动复制文件取代安装步骤。
2. 设置 → 插件 → 启用（本示例声明敏感权限 `serial:send`，启用时弹确认框）。
3. 在权限区勾选 `terminal:read` / `terminal:write`（`serial:send` 可选，仅用于
   端口作用域演示）。
4. 打开任意 TRX 端口标签页，发送含 `PING` 的数据，终端会出现 `PONG<...>`；
   点击工具栏“统计行数”会在活动端口追加旁注，无活动端口则写入插件输出面板。

## 行为说明

- `rx.line`（需 `terminal:read`）：每行回调载荷
  `{portId, seq, rawData: Uint8Array, encoding, ts}`——rawData 未解码，插件按
  `encoding` 自行解码。
- `rx.detached`：`reason: 'mode-tty'`（端口切 TTY，字节流无行语义）或
  `'port-disconnected'`（端口断线）——两种断流都通知。
- `serial.portWhitelist: ["COM9"]`：manifest 声明端口作用域——启用时对白名单外
  端口 `serial.send` 会被桥拒绝（拒绝串可在 catch 里拿到，本插件写成旁注）。
- 插件 label 不做宿主翻译；需要多语言时作者自管（本示例用中文单语）。
