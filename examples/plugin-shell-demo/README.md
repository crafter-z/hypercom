# HyperCom Shell Execute 示例

这个最小示例演示 `shell.execute` 能力：插件只声明 `shell:execute`，侧边栏按钮点击后运行 `git --version`，把完整 stdout/stderr 和退出码写入插件输出面板。Worker 启动时不会自动运行任何本机程序。

## 安装与授权

1. 打开「设置 → 插件 → 安装目录…」，选择本目录（也可将其打包为 ZIP）。
2. 阅读插件来源和 `shell:execute` 风险提示后，授予权限并启用。授权是一次性的，不会在每次按钮点击前重复确认。
3. 点击侧边栏的「显示 Git 版本」。本机未安装 Git 时，面板会显示执行失败。

本示例不声明 `shell.executableWhitelist`；该字段仅作为旧 manifest 的兼容保留字段，不限制 `shell.execute`。

## API 重点

- `program`、`args` 和 `cwd` 采用操作系统进程语义，不自动拼接 shell 命令；可按需要显式选择系统解释器。
- 可选 `env` 会叠加继承环境；可选 `stdin` 发送 UTF-8 文本，省略则关闭输入。
- `timeoutMs` 缺省或为 `0` 表示不设截止，正整数由调用方自行选择。
- 不额外设置命令专用并发、输出或参数业务配额，但仍受操作系统、可用内存和宿主通用 RPC 在途限制。
- 禁用、撤权或重载会终止并等待直接子进程；不能承诺终止进程树或撤销已经发生的副作用。
