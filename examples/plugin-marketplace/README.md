# HyperCom 本地静态插件市场示例

这个目录可以直接作为本地静态市场源，用来实际验证插件市场 UI，而不是只依赖 mock IPC。

## 启动静态服务

在仓库根目录执行：

```powershell
python -m http.server 8787 --directory examples/plugin-marketplace
```

如果本机没有 `python`，也可以使用任意静态 HTTP 文件服务器。

## 在 HyperCom 中配置

打开「设置 → 插件」，将市场源设置为：

```text
http://127.0.0.1:8787/index.json
```

保存配置后点击「同步市场」。你应该能看到：

- `HyperCom Demo`
- `com.example.hypercom-demo`
- v1.0.0
- 3 项权限
- 安装按钮

该 metadata 的 ZIP 地址是：

```text
http://127.0.0.1:8787/packages/com.example.hypercom-demo-1.0.0.zip
```

ZIP 内容来自 [`examples/plugin-demo/`](../plugin-demo/)，metadata 中的 manifest 与 ZIP 内 manifest 一致。

## 关闭服务

停止运行 `python -m http.server` 的终端即可。应用访问失败时，市场区域会显示错误，不会影响本地插件管理。
