# HyperCom Stream Tasks 示例

这是第二批能力的最小真实插件示例。它只声明并使用：

- `fs:open`：用户点击后只选择一个文件，取得只读句柄并读取一个窗口；句柄可交给 `serial.sendFile`，不暴露本机路径。
- `fs:save`：用户点击后每次打开原生“另存为”，分块写入并显式 `commit()`；取消或提交结果未知时不盲目重试。
- `serial:send`：从原生端口列表选取当前已连接端口，固定 `portId` 和观察到的 `connectionGeneration`，演示 `sendBytes` 与 `sendFile`。拔插、取消、零/部分/未知结果不会自动重发；`task.done` 可能以 `unknown` 结算，并不证明设备或驱动结果已知。不同端口可由同一 Worker 并行，但每端口保持单一发送流程。
- `shell:execute`：用户点击后运行普通的 `git --version`，并发 drain stdout/stderr；每个流用 `TextDecoder.decode(bytes, {stream:true})`，EOF 后无参 `decode()` flush。取消按钮只取消这一个任务。

插件启动时不会打开文件选择器、访问真实设备、发送字节或启动程序。未安装 Git 时工具按钮会显示失败。示例不使用 `shell.executableWhitelist`，也不声明 `serial:control`。

## 安装

1. 打开「设置 → 插件 → 安装目录…」，选择本目录。
2. 审阅并授予 `fs:open`、`fs:save`、`serial:send` 和 `shell:execute`；`shell:execute` 是高风险能力，只在你信任示例代码和本机工具参数时授权。
3. 在侧边栏按需点击文件和工具按钮；两个发送动作不在侧边栏，而是在目标端口的右键菜单中选择。先打开一个串口标签/端口菜单，再点击“发送示例字节”或“发送已选文件”；`send-file` 必须先通过侧边栏“选择并读文件”保留一个只读句柄。发送只使用这次菜单事件的 `context.portId`，再用 `ports.status({portId})` 读取当前连接代次；缺少上下文、端口掉线或代次无效时拒绝，不改选其他端口。

## 关键代码路径

- `main.js`：只在按钮事件中调用 `self.plugin.fs.openFile/createFile`、`self.plugin.serial.sendBytes/sendFile` 和 `self.plugin.shell.start`；文件/工具按钮是 sidebar，两个发送动作是 `port-context` 菜单，使用 `event.context.portId`，不会取 `ports.list()` 的第一个端口。
- `shell.start` 的 stdout/stderr 是独立有界管道，必须并行消费，或把不用的一侧设为 `discard`。`task.release()` 只释放任务记录，不承诺撤销已经发生的进程副作用。

在仓库根目录可执行 `node --check examples/plugin-stream-tasks/main.js`，并运行 `node --test examples/plugin-stream-tasks/port-context.test.cjs` 验证合成的双端口选择（测试不会打开设备）。真实 WebView、原生选择器、串口和本机工具仍需在应用安装包中按目标平台验收。
