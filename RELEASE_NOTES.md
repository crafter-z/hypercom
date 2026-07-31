# HyperCom v0.1.0

首个公开版本。现代化串口调试工具，目标替代 SSCOM / SuperCom。Rust 处理底层 I/O，React 负责 UI 交互。

## 功能亮点

**串口与连接**
- 串口自动枚举（每 3 秒刷新，保留连接态/别名/分组）
- 模拟串口 `SIM:Loopback`，无硬件即可调试
- 完整参数：波特率（含自定义）、数据位、停止位、校验位、流控、DTR/RTS

**终端与显示**
- 多标签 + 上下/左右分屏，跨 Pane 拖拽
- 虚拟滚动、正则/关键词语法高亮、时间戳、TX/RX 着色
- 字符串 / HEX / 二进制切换；UTF-8 / GBK / ISO-8859-1 / ASCII 实时切换

**收发与命令**
- 手动发送、发送历史（↑/↓ 回溯）、循环发送、命令集编辑器
- 文件分块发送（带进度条）、批量发送

**日志与导出**
- 连接即自动写日志、按大小分片续写、多编码
- 导出 TXT/CSV、日志按原始时间戳回放

**其他**
- 条件触发器：接收匹配（包含/精确/正则/HEX）→ 自动回复 / 弹窗告警 / 书签
- 7 页配置弹窗、配置版本化与备份恢复、自定义配置路径
- 跨平台防休眠、进程级资源监控、系统托盘、窗口置顶

## 下载安装包

- **Windows**：`hypercom_0.1.0_x64-setup.exe`（推荐，NSIS 安装包，支持中英文）或 `hypercom_0.1.0_x64_en-US.msi`
- **macOS (Apple Silicon)**：`hypercom_0.1.0_aarch64.dmg`
- **macOS (Intel)**：`hypercom_0.1.0_x64.dmg`
- **Linux**：`hypercom_0.1.0_amd64.deb` / `hypercom-0.1.0-1.x86_64.rpm` / `hypercom_0.1.0_amd64.AppImage`

> macOS 版本暂未做代码签名与公证，首次打开可能被 Gatekeeper 拦截，请在「系统设置 → 隐私与安全性」中允许运行。详见仓库 `plans/code-signing.md`。

## 自动更新

应用已内置 updater 插件，后续发布新版本时将在应用内提示更新。

完整功能列表与开发文档见仓库 README 与 `AGENTS.md`。
