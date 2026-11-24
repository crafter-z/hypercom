# HyperCom 插件开发指南

面向编写和分发 JavaScript 插件的开发者。本文集中说明可用的 manifest、权限、Worker API、开发流程和交付约束；宿主内部 IPC、授权一致性与磁盘事务实现见[插件架构](architecture/plugins.md)。只想安装或使用插件的用户请看[插件使用](userwiki/插件.md)。

## 目录

- [运行模型](#运行模型)
- [创建第一个插件](#创建第一个插件)
- [manifest 字段](#manifest-字段)
- [权限与作用域](#权限与作用域)
- [调用 API 与处理事件](#调用-api-与处理事件)
- [API 参考](#api-参考)
- [隔离 UI 与工作区标签](#隔离-ui-与工作区标签)
- [常见功能示例](#常见功能示例)
- [限制与错误处理](#限制与错误处理)
- [本地调试](#本地调试)
- [打包与升级](#打包与升级)
- [插件市场发布与更新](#插件市场发布与更新)
- [交付前自检](#交付前自检)

## 运行模型

- 有根 Worker 的启用插件对应主窗口中的一个 Web Worker；纯网页插件没有 Worker（见[可信网页模式](#可信网页模式windows)）。入口是**单文件普通脚本**，不是 ESM；不能在运行时使用 `import` / `require`，也不直接加载 npm 包。使用 TypeScript 或第三方依赖时，先在自己的构建流程中打包为普通脚本，再把产物作为 entry。生产与开发 CSP 已允许 Worker 内的 WebAssembly 编译/实例化；插件仍需自行把 `.wasm` 作为包内资产，通过 `fs.read({format:'binary'})` 加载，并处理 RX 丢包/gap。
- 每次安装、升级或用户确认替换都会生成新的安装身份（`installGeneration`）并重置授权（含可信网页信任）；旧身份下排队或迟到的操作会被拒绝，Worker 内存状态也不跨安装身份保留。
- 宿主注入 Worker 的 `self.plugin`。Worker 无 DOM、window、Tauri invoke 或 localStorage；不要操作宿主 React/store，不要覆盖桥使用的 self.onmessage/self.plugin。
- 可声明侧边栏按钮、端口菜单、文本面板及隔离视图。隔离 UI 有自己的 DOM 和浏览器上下文，可以使用打包后的 React/Vue/普通 JS，但不访问主窗 DOM 或 Tauri 通用接口。Windows 原生承载已实现，其他平台在隔离策略验收前明确拒绝；桌面弹出窗不运行插件。
- 出站 HTTP 使用 `http.request`，不要直接调用 `fetch` / WebSocket；生产 CSP 不允许任意直接网络连接。读取用户文件使用原生 `fs.openDialog`，读写用户目录使用原生 `fs.openDirectoryDialog`；两者都不接受插件提供的任意本机路径。
- 安装是用户的信任决定。权限和额度不能替第三方代码提供安全认证；只声明真正需要的能力，不在启动时自动向设备发送控制指令或自动弹文件对话框。

## 创建第一个插件

只需两个 UTF-8 文件，不需要编译 HyperCom，也不需要 Rust 或 npm 工程：

```text
com.example.hello/
├── manifest.json
└── main.js
```

### manifest.json

以下示例不需要敏感权限，只有专属输出面板和一个声明式按钮：

```json
{
  "id": "com.example.hello",
  "name": "Hello HyperCom",
  "version": "1.0.0",
  "description": "在插件面板输出启动信息，并统计按钮点击次数。",
  "apiVersion": "1.0",
  "entry": "main.js",
  "permissions": [],
  "ui": {
    "buttons": [
      { "id": "hello", "label": "问候", "icon": "Play", "target": "sidebar" }
    ]
  }
}
```

### main.js

op 名带点号，必须用 `api['ui.panel.append'](...)`，**不是** `api.ui.panel.append(...)`。所有 API 调用均返回 Promise，示例显式处理失败：

```js
const api = self.plugin.api;
let clicks = 0;

self.plugin.on('ui.buttonClick', async ({ buttonId }) => {
  if (buttonId !== 'hello') return;
  try {
    clicks += 1;
    await api['ui.panel.append']({ text: `Hello HyperCom #${clicks}\n` });
  } catch (error) {
    console.error('hello action failed', error);
  }
});

api['ui.panel.append']({ text: 'Hello HyperCom ready\n' })
  .catch((error) => console.error('hello startup failed', error));
```

### 安装并观察

1. 打开「设置 → 插件 → 安装目录…」，选择包含 manifest.json 的 `com.example.hello/`。
2. 安装完成后宿主会打开按“观察设备数据、向设备发送或改变连接、读取/保存/导出文件、访问网络/系统程序/剪贴板、应用内显示与设置”等任务分组的权限审阅。默认选择实际声明且宿主支持的普通能力，但高风险 `shell:execute` 默认不勾选，需用户明确加入；审阅基于实际安装包而不是市场预览。若包含 `trusted-web` 视图，还须单独勾选网页信任；混合包在未获网页信任时保持禁用。用户可稍后在插件设置中重新审阅或撤权；取消会保留插件但不运行。
3. 主窗口出现「插件输出」，包含 `Hello HyperCom ready`；点侧边栏的「问候」，依次出现 `Hello HyperCom #1`、`#2`。
4. 此时计数只在 Worker 内存中。禁用或重启会重置；需要持久化时使用 storage。

安装会把源文件复制到配置目录旁的 `plugins/<id>/`；修改源 main.js 不会热更新已安装插件。后续改动按[本地调试](#本地调试)重新安装。

## manifest 字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | 是 | 稳定的反向域名标识，如 com.example.hello；至少两段，每段非空，只使用小写 ASCII 字母、数字、`-`、`_`。不要在升级时改 id |
|
ame` | 是 | 非空显示名 |
| `version` | 是 | 写 `x`、`x.y` 或 `x.y.z` 纯数字（缺省段按 0）；比较按数字元组，不按字符串。当前不支持 `-preview.1`、`+build` 等后缀或第四段 |
| `description` | 否 | 设置页显示的说明，建议交代用途和权限原因 |
| `apiVersion` | 是 | 当前写 `"1.0"`；宿主校验主版本为 1，不是最低软件版本字段，也不按次版本自动提供未来能力 |
| `entry` | 纯网页插件可省 | 插件内现存普通脚本文件的相对路径，如 main.js 或 dist/main.js；不能是绝对路径、`..` 穿越或 data/ 内文件。省略表示没有根 Worker：此时 `ui.views` 必须非空且**全部**为 `trusted-web` + `input:"none"` 视图，并不得声明 Worker 专用的 `ui.buttons`/`ui.menuItems` |
| `permissions` | 是 | 所需权限字符串数组；可为空，不能含重复或空项。声明不等于用户授权；可以声明宿主尚未实现的权限，但安装时只能授予当前已支持的能力 |
| `serial.portWhitelist` | 否 | serial.open/close/send 共用的精确端口 ID 数组，语义见下一节 |
| `http.urlWhitelist` | 否 | 可选的 HTTP URL 作用域：缺失或空数组表示不限制；非空时初始 URL 与每个重定向目标都必须匹配 |
| `ui.buttons` | 否 | 侧边栏按钮数组：`{id, label, icon?, target?}`；target 缺省或 sidebar 才显示 |
| `ui.menuItems` | 否 | 端口菜单数组：`{id, label, target?}`；target 缺省或 port-context 才显示 |
| `ui.views` | 否 | 视图声明；`mode` 缺省为 `isolated`，显式 `trusted-web` 加载包内 HTML 文档；`worker:false` 表示该可信页不依附 Worker（仅允许 `input:"none"`），见下文 |
| `requires` | 有视图时必需 | 每个 `ui.views` 项必须声明对应能力：隔离视图 `isolated-tab-view@1`、可信网页 `trusted-web-view@1`；声明 workspace-tab 放置时另需 `plugin-workspace-tabs@1`。未知或重复能力拒绝 |
| `shell.executableWhitelist` | 否 | 兼容保留字段，不限制 `shell.execute`；也不约束 `shell.openExternal`。当前版本不需要声明它来执行程序 |

按钮与菜单 id 应在插件内唯一，并在代码中按 buttonId 分派；label 由插件作者负责语言，不经过宿主翻译。支持的 icon 名见 `src/components/Sidebar/pluginIcon.tsx`；未识别的名称使用默认插头图标，入门示例使用已支持的 Play。

manifest 不能超过 1 MiB；包内路径统一使用 `/`。包不应包含符号链接、设备文件、Windows ADS/尾点/尾空格别名或用户私有数据。安装包中的 data/ 不会作为初始用户数据导入；需要默认资源时放 assets/，由代码决定如何初始化。

## 权限与作用域

| 权限 | 开放能力 |
|---|---|
| `terminal:read` | 订阅 TRX 的 rx.line |
| `rx:bytes` | 订阅包括 TTY 在内的原始 RX 块 |
| `terminal:write` | 在已打开 TRX 终端写 NOTE 旁注，不发送串口数据 |
| `serial:control` | **敏感**：打开/关闭串口，受 serial.portWhitelist 约束；与发送分开授权，关闭需绑定观察到的连接代次 |
| `serial:send` | 向已连接端口发送，仍需通过 serial.portWhitelist；不隐式获得打开/关闭权限 |
| `fs:assets` | 读取插件自身包内文件，可返回文本或原始二进制 |
| `fs:storage` | 读取自身 data/ 文件（文本/二进制）及写入文本或原始字节 |
| `fs:open` | 经用户原生选择器读取外部文件（文本/二进制） |
| `fs:open-dir` | 经用户原生目录选择器获得只读目录授权：列出目录、读取文件和元数据；根目录只能由选择器产生 |
| `fs:export-dir` | **推荐的目录导出最小权限**：只向用户原生选择的白名单目录根 + 相对路径创建/覆盖文件，按需创建父目录；不读取、不删除、不重命名、不追加。属于敏感权限 |
| `fs:save` | **任意目录 Save As 最小权限**：每次由用户通过原生另存为选择目标，支持文本/原始字节；插件只能提供文件名提示，不能传绝对目标路径，不获得后续目录访问权。属于敏感权限 |
| `fs:write-dir` | 兼容保留的高风险目录修改权限：可创建/覆盖/追加文件、建目录、删除和重命名；根目录只能由原生选择器产生。仅导出时优先使用 fs:export-dir，宿主授权确认会单独提示 |
| `http:request` | 经宿主发起完整 HTTP（文本/二进制/流式/重定向/取消）；可选 urlWhitelist 收紧 |
| `shell:open` | 在系统默认程序打开 http/https/mailto URL；不是执行 shell |
| `shell:execute` | **高风险**：经宿主按操作系统语义启动程序并返回退出码及 UTF-8 stdout/stderr；程序可读写本机数据、访问网络或运行其他程序。需一次性授予敏感权限，用户负责审阅插件代码和参数 |
| `clipboard` | 读/写剪贴板文本 |
|
otify` | 发出受限的非粘滞通知 |
| `storage` | 通过 get/set 访问专属 JSON KV；只覆盖 data/state.json，不等于整个 data/ 的文件权限 |
| `ui:view` | 显示声明的隔离页面、发布 JSON 模型及接收本页面交互，不隐含其他权限 |
| `ui:tabs` | Worker 打开/激活/关闭/改标题/列出自身独立标签；不能管理其他插件或原始串口标签 |

`ports.list`、`ports.status`、log 和自身 ui.panel 操作无需声明额外权限，但插件必须已启用。授权在调用时检查；运行中撤权后，旧 API 引用也不能继续使用该能力。RX 事件同样受当前读取权限控制。

### 串口作用域

在已有 manifest 中声明以下字段时，发送需把 `serial:send` 加入 permissions；打开/关闭需独立声明并授予 `serial:control`。同一白名单同时约束 open、close 和 send：

```json
{
  "serial": { "portWhitelist": ["COM9"] }
}
```

这是 **manifest 字段片段，不是完整 manifest**。数组成员按端口 ID 精确匹配；空数组表示全拒绝。完全不声明 serial scope 则该权限不限端口，所以推荐显式列出目标。端口关闭、缺失或 HEX 输入非法时，serial.send 可以成功返回 `{bytesWritten: 0}`；不要只以 Promise resolve 判断设备已收到指令。

### HTTP 作用域

同样需要声明并授予 http:request；以下为 manifest 字段片段：

```json
{
  "http": {
    "urlWhitelist": [
      "https://api.example.com/v1/status?device=board-a",
      "https://api.example.com/v1/events/*"
    ]
  }
}
```

模式匹配规范化后的完整 URL：`*` 匹配不含 `/` 的字符，`**` 可跨 `/`，其他字符按字面匹配，**`?` 是查询分隔符，不是通配符**。建议 scheme/host 写小写，避免白名单中写默认端口或 `..` 路径段。**白名单是可选的收紧手段**：不声明或空数组表示不限制，非空后初始 URL 与每个重定向目标都要匹配；空数组不能用来"全部拒绝"，要完全禁止出站就不要声明 `http:request`。请求默认跟随重定向（最多 10 跳），也可用 `redirect:'manual'`（不跟随、原样返回 3xx）或 `'error'`（遇重定向直接失败）改变行为。插件 HTTP 默认继承系统代理；用户在设置中显式配置的插件代理优先，插件本身不能指定代理或注入凭据。

## 调用 API 与处理事件

```js
(async function () {
  try {
    const ports = await self.plugin.api['ports.list']();
    await self.plugin.api['ui.panel.append']({
      text: `${ports.map((port) => `${port.id}: ${port.status}`).join('\n')}\n`
    });
  } catch (error) {
    console.error('list ports failed', error);
  }
})();
```

参数与返回值通过结构化克隆传递，不能把函数、DOM 或宿主对象放进 RPC 参数。订阅事件使用 `plugin.on(type, callback)` 或 `plugin.rx.onLine/onBytes/onDetached/onDropped(callback)`，**不要**调用 `api['rx.onLine'](callback)`。

- `on(...)` 返回注销函数；不需要订阅时调用它。
- RX 行和字节回调收到**数组批次**，不是单条记录。
- 异步回调应返回 Promise（async 函数会自动返回）；桥在本批回调完成后发送 ACK。不要 fire-and-forget 大量任务或在回调里永久等待。
- 宿主对普通 RPC 的回执期限为 10 秒，Worker 侧留 11 秒等待回执；超时只让该次调用 reject。以下调用等待真实完成、用户、网络或进程，不设通用 RPC 期限：`serial.open`、`serial.close`、`fs.exportFile`、`fs.saveFile`、`fs.read`、`fs.readRange`、`fs.readRanges`、`fs.listDirectoryPage`、`fs.write`、`storage.set`、`fs.openDialog`、`fs.openDirectoryDialog`、`fs.listDirectory`、`fs.readDirectoryFile`、`fs.statDirectoryEntry`、`fs.writeDirectoryFile`、`fs.createDirectory`、`fs.removeDirectoryEntry`、`fs.renameDirectoryEntry`、`ui.panel.export`、`fs.openFile`、`fs.createFile`、`fs.readFileWindow`、`fs.writeFileChunk`、`fs.commitFile`、`shell.execute`、`shell.start`、`shell.read`、`shell.status`、`shell.cancel`、`shell.release` 与全部 `http.*`。`shell.execute` 的业务 `timeoutMs` 由调用方指定（缺省或 `0` 不设截止），不因 RPC 回执期限被隐式改写；`view.sendBinary` 另有 10 分钟传输 RPC 资源期限与逐块 30 秒 ACK 期限。HTTP 的业务期限仍只由请求的 `timeout` 决定；未消费的 stream 会在闲置 60 秒后回收，正在进行的 `read` 不计闲置。
- 超时只是回执失败，不表示已经开始的串口写入、文件写入、HTTP 请求或本机进程已被撤销。避免对可能已成功的副作用盲目重试。

## API 参考

以下均为 **Worker API**。安装、授权管理等原生 Tauri 命令不是插件可用 API；不要复制架构文档中的 invoke 调用。

### 端口与串口

| 调用 | 权限 | 参数与结果 |
|---|---|---|
| `api['ports.list']()` | 无 | 原生权威端口摘要数组；成员含 id/name/status/type/mode/connectionGeneration，可含 baudRate；mode 优先保留已有宿主显示模式，连接状态/代次始终来自 native；失败 reject，不回退过期前端连接缓存 |
| `api['ports.status']({portId})` | 无 | 原生权威单端口摘要；未知且从未成功连接返回 null，曾成功连接但已消失的目标可返回 disconnected + 历史 connectionGeneration |
| `api['serial.open']({portId, params?})` | serial:control | 打开端口，不创建/激活标签或发送数据；返回 `{port, result:'opened'\|'already-open', connectionGeneration}`。已连接时不重开、不修改现有参数 |
| `api['serial.close']({portId, expectedConnectionGeneration})` | serial:control | 关闭观察到的连接代次；必填非负安全整数代次，匹配时返回 `{port,result:'closed'\|'already-closed'}`；旧代次拒绝，不误关后来的新连接 |
| `api['serial.send']({portId, data, isHex?, lineEnding?})` | serial:send | data 为非空字符串（≤1048576 个 UTF-16 代码单元）；默认文本、不加行尾；返回 `{bytesWritten}`，0 表示没有发送 |
| `api['terminal.append']({portId, text})` | terminal:write | 非空 text（单次 ≤65536 个 UTF-16 代码单元），写 NOTE，不进入 TX 流量或历史；未打开对应终端显示目标时不保留旁注 |

serial.send 的 HEX 使用偶数个十六进制字符，可含空白，不自动补零。行尾值是字面量反斜杠表示：JavaScript 源码写 `lineEnding: '\\r\\n'`、`'\\r'`、`'\\n'` 或 `'None'`，不要写成真实换行字符串 `lineEnding: '\r\n'`。TTY 无本地 TX 回显，终端行旁注不是 TTY 画面注入接口。

`serial.open` 的 `params` 可省略；未提供字段沿用宿主当前端口参数与默认值。允许 `baudRate`（1..4294967295 整数）、`dataBits`（5/6/7/8）、`parity`（`None`/`Even`/`Odd`）、`stopBits`（`One`/`Two`）、`handshake`（`None`/`XonXoff`/`RequestToSend`/`RequestToSendXonXoff`）、布尔 `dtr`/`rts` 以及 TTY `cols`/`rows`（1..65535 整数）；未知字段、非法枚举/数值明确 reject，不静默钳制。虚拟端口仍受宿主开发能力开关约束，控制权限不能绕过它。

打开、关闭与用户连接按钮/自动重连共用每端口顺序 lane；排队后再次检查启用态、安装身份、授权与白名单。连接/权限/过期意图错误 reject，不使用 `serial.send` 的零字节兼容成功语义。`expectedConnectionGeneration` 不是端口所有权证明：用户明确授权后，插件也能关闭白名单内由用户或其他插件打开、且代次仍匹配的连接。不要失败后自动删除代次并盲目重试关闭。

#### 分块串口任务（字节与已选文件）

除一次性的 `serial.send` 外，Worker 还可使用 `self.plugin.serial.sendBytes` / `sendFile` 建立一个固定端口的分块任务。两者都要求 `serial:send`、端口白名单和调用方观察到的 `expectedConnectionGeneration`；任务不会随焦点或自动重连漂移。

```js
const task = self.plugin.serial.sendBytes({
  portId: 'COM9',
  expectedConnectionGeneration: 12,
  bytes: new Uint8Array([0x55, 0xaa, 0x01]),
  signal: controller.signal,
});
task.onProgress((progress) => console.log(progress.status, progress.bytesWritten, progress.totalBytes));
const result = await task.done;
```

- `sendBytes({portId, expectedConnectionGeneration, bytes, signal?})` 接受 `Uint8Array` 或 `ArrayBuffer`；`sendFile({portId, expectedConnectionGeneration, handleId, signal?})` 只接受 `fs.openFile()` 产生的只读句柄 ID，不接受路径。每次 IPC 窗口最多 64 KiB，宿主可按串口速率选择更小窗口。
- 返回任务对象 `{taskId, done, cancel, getProgress, onProgress}`。进度状态为 `starting`、`running`、`cancelling`、`completed`、`cancelled`、`disconnected`、`failed` 或 `unknown`；`bytesWritten` 是已确认的最低写入量，`unknown` 时最后一次窗口可能已经到达驱动。
- `AbortSignal` 或 `task.cancel()` 只取消该任务；已经交给驱动的字节不能撤回。拔插/重连导致连接代次不匹配时，旧任务结束为 `disconnected` 或 `unknown`，新连接不会接收旧任务尾部。零字节任务可直接 `completed`；部分写入、超时或失败都**不自动重发**，调用方必须先核对设备状态再决定。
- 任务在两次窗口之间闲置约 60 秒会被回收；这不是执行总期限。`done` 会在任务状态结算（也可能是 `unknown`）时 resolve，不代表设备或驱动结果已知。撤权、禁用、换代会取消相关任务；撤销 `fs:open` 只影响文件任务，不影响仍在运行的纯字节任务。

### 面板、通知与日志

| 调用 | 权限 | 参数与结果 |
|---|---|---|
| `api['ui.panel.append']({text})` | 无 | 向自身面板追加文本；仅文本显示，不解析成自定义 DOM |
| `api['ui.panel.clear']()` | 无 | 清空自身面板，截断累计不重置 |
| `api['ui.panel.export']()` | 无 | 经原生另存为导出当前面板；用户取消不写文件 |
| `api['notify']({title?, body?, level?, durationMs?})` | notify | level 用 info/warn/error；受速率与积压限制，超额静默丢弃；resolve 不保证通知已显示 |
| `api['log']({msg, level?})` | 无 | level 用 info/warn/error，经宿主诊断日志通道限流记录，带插件 ID 前缀 |

### KV、文件与剪贴板

| 调用 | 权限 | 参数与结果 |
|---|---|---|
| `api['storage.get']({key})` | storage | key 非空；返回保存的 JSON 值，不存在为 undefined |
| `api['storage.set']({key, value})` | storage | value 必须可无损 JSON 化（见下）；顶层 undefined 删除此键；按插件串行提交 |
| `api['fs.read']({rel, format?})` | fs:assets 或 fs:storage | rel 为包内或 data/ 相对路径（≤4096 字符）；format 缺省/`text` 返回 UTF-8 文本，非法字节用替代字符；`binary` 返回 `Uint8Array`。空文件为 `''` 或零长度字节数组，缺文件/IO 错误 reject；data/ 与包资产分开授权 |
| `api['fs.write']({rel, content?} \| {rel, bytes?})` | fs:storage | rel 只允许 data/ 下相对路径；`content`（可为空字符串）或 `bytes`（`Uint8Array`/`ArrayBuffer`，可为零长度）二选一；原子覆盖写入，自动创建父目录；无内容大小上限 |
| `api['fs.openDialog']({multiple?, filters?, title?, encoding?, format?})` | fs:open | format 缺省/`text` 返回 `{files:[{path, content}]}`，`binary` 返回 `{files:[{path, bytes: Uint8Array}]}`；取消为 `{files:[]}`。文本 encoding 默认 utf-8，可用浏览器 TextDecoder 支持的标签（如 gbk）；二进制忽略 encoding；multiple 缺省 false，无选择数量上限，每插件同时最多 8 个对话框；filters 仅为选择提示，始终可选所有文件 |
| `api['fs.exportFile']({grantId, rel, content? \| bytes?})` | fs:export-dir | 向用户所选白名单目录内的相对路径创建/原子覆盖文件，自动创建父目录；文本/原始字节二选一，允许空内容；返回 `{path,bytesWritten}`。不接受 mode、读取、删除或重命名能力；rel ≤4096 UTF-8 字节，拒绝绝对路径、`..` 和链接/重解析点 |
| `api['fs.saveFile']({content? \| bytes?, options?})` | fs:save | 每次原生 Save As，由用户选择任意保存位置；成功返回 `{path,bytesWritten}`，取消返回 null。options 仅含 `{title?,defaultFileName?,filters?}`，defaultFileName 是文件名不是路径；不能传绝对目标或默认目录，不产生 grant |
| `api['fs.openDirectoryDialog']({title?, multiple?})` | fs:open-dir、fs:export-dir 或 fs:write-dir | 经原生目录选择器获得目录授权；返回 `{directories:[{grantId, name, path}]}`，取消为 `{directories:[]}`。`path` 仅供展示；后续访问必须使用 `grantId`。无 TTL、无数量上限；授权保存在宿主内存，应用重启后失效 |
| `api['fs.listDirectory']({grantId, rel?, recursive?})` | fs:open-dir | 列出授权根或 `rel` 子目录的条目；返回 `{entries:[{name, rel, kind, size, modifiedMs}]}`，`kind` 为 `file`/`directory`/`other`。`recursive` 默认 false；为 true 时返回整棵树，不设深度或条目上限。`rel` 使用 `/`；链接/重解析点与特殊文件标记为 `other` |
| `api['fs.readDirectoryFile']({grantId, rel, format?, encoding?})` | fs:open-dir | 读取授权目录内的普通文件；返回 `{path, content}`（text，encoding 默认 utf-8）或 `{path, bytes: Uint8Array}`（binary）。`rel` 必填且必须解析到授权根内；绝对路径、`..`、链接和重解析点拒绝。无内容大小上限，一次性读取整个文件 |
| `api['fs.statDirectoryEntry']({grantId, rel})` | fs:open-dir | 读取单个条目的元数据：`{name, rel, kind, size, modifiedMs}`；不读取文件内容；链接/重解析点拒绝 |
| `api['fs.writeDirectoryFile']({grantId, rel, content? \| bytes?, mode?, createParents?})` | fs:write-dir | 写入授权目录内的文件；`content`（UTF-8 文本，可为空串）与 `bytes`（`Uint8Array`/`ArrayBuffer`）二选一；`mode` 为 `overwrite`（默认，临时文件同步后原子替换）或 `append`；`createParents` 默认 true；返回 `{path, bytesWritten}`，无内容大小上限 |
| `api['fs.createDirectory']({grantId, rel, recursive?})` | fs:write-dir | 创建目录；`recursive` 默认 true；已存在目录视为成功；逐组件拒绝链接/重解析点 |
| `api['fs.removeDirectoryEntry']({grantId, rel, recursive?})` | fs:write-dir | 删除文件/目录；`recursive` 默认 false；非递归删除非空目录会失败；不能删除授权根 |
| `api['fs.renameDirectoryEntry']({grantId, fromRel, toRel})` | fs:write-dir | 重命名/移动；源必须存在，目标父目录必须存在，目标不能已存在；源/目标都必须在授权根内 |
| `api['fs.releaseDirectory']({grantId})` | 无 | 提前释放目录授权；未知或已失效的 `grantId` 视为成功。授权也会在插件禁用、撤销全部三种目录权限、卸载、替换或重载时失效 |
| `api['clipboard.readText']()` | clipboard | 返回剪贴板文本 |
| `api['clipboard.writeText']({text})` | clipboard | 写入文本；空字符串表示清空剪贴板 |

storage 的文件是 data/state.json。只有确认文件不存在才初始化空对象；暂时读失败、非法 JSON、非对象内容都会 reject，不能用空缓存覆盖旧键。键只要求非空字符串；值必须是可无损 JSON 化的数据——除顶层 `undefined`（删除键）外，拒绝函数、嵌套 `undefined`、NaN/Infinity、Map/Set/Date/类型化数组、getter、可调用的 `toJSON`、稀疏数组与循环引用，但**不设键长、值大小、节点数或文件大小上限**。不要同时用 fs.write 手工改这个文件和 storage.set 操作 KV，两条路径没有共享 KV 缓存更新契约。配置导出不包含 KV、其他 data/ 或插件代码。

**旧全文件读写接口继续保留，不设文件格式、内容、大小、总量或选择数量的业务上限，也不增加隐式读取期限；所有插件一致，不要求可信网页模式。** `fs.read` 仍只访问已授权插件目录，`fs.openDialog` 只读取用户选择的路径，`fs.openDirectoryDialog` 只能获得用户原生选择器产生的目录根（只读、最小导出或完整目录写任一授权均可发起选择），`fs.write` 只写 data/；二进制保留全部字节，不经过文本解码。文本解码可能替换非法字节，要求无损时必须使用 binary。目录授权是内存能力，插件不能把任意本机路径或目录根传给宿主；所有目录操作每次调用都重新校验权限、安装代次和路径围栏。旧接口一次性读取/写入整个文件，实际可处理大小受可用内存及 JS/浏览器运行时约束，并非流式接口；大文件预览和目录扫描优先使用下面的有界窗口与分页 API。安装包与网页声明资源的限额仍属于安装/视图加载，不限制此处的数据读取或私有写入。

### 保存文件时选择最小权限

- **反复导出到同一白名单目录**：声明并授予 `fs:export-dir`，通过 `fs.openDirectoryDialog` 让用户选择根，随后只用 `grantId` + 相对路径调用 `fs.exportFile`。自动创建父目录，原子覆盖而不是追加；不能列/读文件或元数据、删除、重命名，也不能调用旧完整目录写 API。要读同一目录还须另授 `fs:open-dir`；需要追加/删除/重命名时才申请旧 `fs:write-dir`，它不会自动涵盖新导出权限。
- **每次由用户决定任意保存位置**：只授予 `fs:save`，调用 `fs.saveFile`，每次均打开原生 Save As；插件不能传绝对路径、`defaultPath`、目录路径或自报 grant。`defaultFileName` ≤255 个 UTF-16 代码单元、只能是非空 basename（拒绝分隔符、冒号、控制字符、`.`、`..`）；title ≤256 个 UTF-16 单元且不含控制字符，filters 与 open 共用结构边界（扩展名不得含路径分隔符、冒号或控制字符），都是提示而不是访问能力。成功返回展示用 path，不可用于下一次免确认写入。
- 两者都接受且只接受 `content`（UTF-8 文本，可空）或 `bytes`（`Uint8Array` / `ArrayBuffer`，可零长度），无内容业务大小限额，无隐式保存期限；仍受可用内存、磁盘和宿主普通 RPC 在途槽位约束。`fs.saveFile` 与其他文件选择/面板导出共用每插件最多 8 个对话框许可；不要在后台循环弹出对话框。
- 撤权、禁用或安装身份变化会拒绝排队请求并丢弃迟到回执；原生选择后/提交前再次校验。取消 Save As 返回 null，不是写入零字节。撤销不回滚已经完成的文件写入；失败不应盲目重放。旧 `fs:write-dir` 和仅导出自身面板的 `ui.panel.export` 保持原契约，不被两个新权限隐式扩大或替代。

### 单文件句柄：只读选择与只写另存为

这是新增 API，不替换旧 `fs.openDialog`/`fs.saveFile` 契约。`fs.openFile` 只开一个文件的只读句柄；`fs.createFile` 每次打开原生 Save As，产生独立的只写暂存目标。二者不能合并成双向句柄，也不把路径交给插件。

```js
const reader = await self.plugin.fs.openFile({ title: '选择日志', signal: controller.signal });
if (reader) {
  for await (const chunk of reader.windows({ chunkSize: 1024 * 1024, signal: controller.signal })) {
    consume(chunk);
  }
  // windows() 完成或取消时会 close；也可显式 reader.close()/reader.cancel()
}

const writer = await self.plugin.fs.createFile({ defaultFileName: 'report.bin' });
if (writer) {
  await writer.write(new Uint8Array([1, 2, 3]), { signal: controller.signal });
  const committed = await writer.commit();
  console.log(committed.bytesWritten, committed.durabilityWarning);
}
```

- 读句柄结果含 `{handleId, name, size, read, windows, close, cancel}`；`read(offset,length,{signal?})` 单窗口最多 1 MiB，EOF 可短读或返回零字节。`windows()` 是顺序窗口迭代器，按需交付，不把 1 GiB 文件整读到 JS 内存。
- 写目标结果含 `{name, write, commit, close, cancel}`；`write(bytes,{signal?})` 每块 1..1 MiB，必须按顺序追加。`commit()` 先在暂存文件上完成提交前校验，再发布目标；成功后返回 `{bytesWritten,durabilityWarning?}`。发布后的原子替换不可回滚，即使父目录同步只得到 warning，也不要重放 commit。
- 句柄/写目标最多每插件 4 个、全局 32 个；请求并发受新文件 lane 及共享 IO 调度约束。打开、窗口读取、分块写入和关闭都可被 `AbortSignal`/显式取消；`commit()` 不接受 signal，竞态中若回执丢失，结果是未知，必须先核实目标再重试。
- 句柄绑定插件安装代次、Worker epoch 和 FS session；关闭、撤权、禁用、重载、替换、卸载或 Worker 停止会使迟到请求失效。`fs:open` 只产生读句柄，`fs:save` 只产生写目标；选择目录不会升级为目录授权。

### 范围读取、批量与目录分页

这些是新增 Worker API，不替换旧接口；无需为已有插件改返回类型。`range` 指 `{rel, offset, length, grantId?}`，偏移与长度均以**字节**计：

| 调用 | 权限 | 参数与结果 |
|---|---|---|
| `api['fs.readRange']({rel, offset, length, grantId?, priority?, signal?})` | 见路径规则 | 返回 `Uint8Array`，只读取一个窗口，不先读取整文件再切片；单次 `length` 为 0..4 MiB |
| `api['fs.readRanges']({ranges, priority?, signal?})` | 每项单独校验 | `ranges` 为 1..64 个 range，申请长度之和 ≤8 MiB，单项仍 ≤4 MiB；返回 `{results:[{rel, bytes: Uint8Array} \| {rel, error: string}]}`，顺序与输入一致 |
| `api['fs.listDirectoryPage']({grantId, rel?, recursive?, cursor?, limit?, priority?, signal?})` | fs:open-dir | 返回 `{entries, nextCursor: string \| null}`；entries 使用旧 list 的 `{name, rel, kind, size, modifiedMs}` 字段；`limit` 默认 256，允许 1..1000，`recursive` 默认 false |

- **路径与授权**：不传 `grantId` 时，`rel` 是插件包内相对路径，`data/` 需要 `fs:storage`，其余资产需要 `fs:assets`；传 `grantId` 时，`rel` 是所选目录内相对路径，需要 `fs:open-dir`，按本机目录文件名规则保留大小写；Unix 合法的 `~`、`:`、尾点/尾空格不套用包路径限制，无 grant 的资产/私有路径仍遵守严格包路径规则。`rel` 的 UTF-8 编码长度 ≤4096 字节，拒绝绝对路径、`..`、链接/重解析点与硬链接文件。`fs:open` 的文件选择结果不能充当目录 grant；`storage` 权限或宿主启动时读取入口的特例也不能代替普通范围读取权限。整个批次先完成授权，任一项权限不足不会先返回其他项内容。与此不同，旧 `fs.readDirectoryFile` 为保持兼容，仍允许授权目录内的最终普通硬链接文件，不代表可用新范围接口读取它。
- **数值与 EOF**：`offset`、`length` 及 `offset + length` 必须是非负 JS 安全整数。零长度合法；越过或刚好位于 EOF 返回空字节，碰到 EOF 可以短读。文件内容不是快照，两个窗口之间可能被外部修改；不能以首次 stat 的 size 推断所有后续窗口一定存在。
- **错误**：批量里的缺文件或普通 IO 错误通过该项 `{rel,error}` 表达，其他项仍可成功；参数、权限、会话失效或取消会 reject 整次调用。单窗口遇到该项错误直接 reject，不返回错误对象。扫描时应逐项处理错误，不盲目重试整批。
- **分页**：首调省略 `cursor`，后续把 `nextCursor` 原样带回，直到为 null；允许最后一次返回空 `entries` 且 `nextCursor:null`，扫描应只以 cursor 判断结束，不能以本页条数推断是否结束；继续使用相同 grant，`rel` / `recursive` 可省略以沿用游标记录值，显式传值时必须与首次请求一致。页是原生句柄迭代器的增量结果，不预收集整棵树、不保证排序，也不是一致性快照；遍历期间的新增/删除可能影响后续页。除条数外，每页还有约 1 MiB 元数据软预算，因此可能少于 limit；递归游标最多保留 128 层目录栈，条目 rel 最多 4096 UTF-8 字节，超出会 reject 而非静默截断。`size`（字节）和 `modifiedMs`（Unix 毫秒，未知为 0）均是非负安全整数，超出可表示范围时整页 reject；链接/重解析点、特殊文件及硬链接文件作为 `kind:'other'` 返回，不向下遍历或读取。cursor 是会话内不透明句柄，闲置达到 60 秒后失效并由回收器清理，不能保存到 storage、跨重载或跨 Worker 继续用。若处理一页耗时过长、cursor 过期或会话失效，应结束本轮扫描并让用户重新发起；分页失败或取消后也不要假定旧 cursor 仍可继续，不能把旧 cursor 自动交给新会话重试。旧 `fs.listDirectory` 仍一次性返回完整、排序后的列表，且不新增该分页深度/页预算限制；不要把旧接口当成分页实现。
- **优先级与取消**：`priority` 只接受 `'interactive'` / `'background'`，默认 background；用户当前可见窗口可用 interactive，整树扫描应保持 background。优先级是调度提示，不绕过每插件聚合预算。`signal` 是标准 `AbortSignal`，仅在 Worker 内消费，不跨结构化克隆；`AbortController.abort()` 使挂起调用以 `AbortError` reject，并经独立取消通道通知原生层。新文件 API 不设隐式总读取期限；取消不表示 OS 已同步结束阻塞 IO，资源只在真实任务结束后归还。
- **传输与所有权**：范围读取只支持原生 raw custom-protocol 通道，不将文件字节转成 base64、JSON 数字数组或可执行脚本；不支持该通道时明确失败，不静默退回大文本路径。少量请求、分页和 frame 描述元数据仍使用 JSON。宿主向 Worker 使用 transfer list，批量各项可能共享同一 payload buffer，处理单项时使用其 `byteOffset` / `byteLength`；需要独立保留某项时调用 `bytes.slice()`。raw、frame 解析和 transfer 不意味着端到端零拷贝。旧 `fs.read({format:'binary'})` 与 `fs.readDirectoryFile`（text/binary）优先走 raw 字节快速路径，目录文本仍按指定 encoding 解码；仅明确不支持 raw 时兼容回退旧 base64 wire，公开返回形状不变。`fs.openDialog` 仍走原有文件选择 wire，`view.sendBinary` 的传输也不由此改变。

新增读取会话绑定插件 ID、`installGeneration` 与根 Worker epoch，原生 session 懒创建；禁用、撤权、重载、替换或 Worker 停止会使旧会话失效，迟到结果不能投给新 Worker。**soft IO budgets 是宿主运行时的准入/在途资源预算，不是文件总大小、整个插件内存或 JS 堆的限额。** 当前调度默认全局 4、每插件 2、每会话 2 个实际 IO，background 全局最多 3，保留 1 个交互容量；受控在途字节预留预算全局 64 MiB、每插件 32 MiB；background 的全局/每插件/每会话令牌桶各为 8 MiB/s、突发 8 MiB，带宽成本与内存预留分开计账。批量/窗口限额只约束单次请求，可按窗口读取更大的文件；旧资产读写和目录 raw 快速路径共享 IO 并发但不新增文件大小上限，未将文件选择器改成新范围通道。新文件 RPC 有独立的 8 个在途槽，不占 32 个普通 RPC 槽；取消另有有界通道。它们独立于 RX/control 事件背压，也不能保证其他插件、插件自行保存的数据或浏览器总内存有硬上限；本实现没有独立插件进程或堆配额。上述并发/速率数字是调度配置，不是实测吞吐或响应延迟承诺；约 9 MiB 资源的隐藏 WebView2 生产 selector 加载与 SHA 校验已通过，但尚未完成发行包全流程与真实磁盘上的多插件大文件扫描压测，不能据此推断主窗绝不会卡顿或总内存一定受控。

### 网络与外部链接

| 调用 | 权限 | 参数与结果 |
|---|---|---|
| `api['http.request'](options)` / `plugin.http.request(options)` | http:request | 完整请求，默认 GET/文本；`responseType` 取 `text` 或 `binary`，决定 `body` 是字符串还是 `Uint8Array`；返回 `{status, headers, url, body}` |
| `plugin.http.stream(options)` | http:request | 返回 `{status, headers, url, body: AsyncIterable<Uint8Array>, cancel()}`；逐块读取，适合 SSE、大文件与流式模型响应 |
| `api['shell.openExternal']({url})` | shell:open | 仅 http/https/mailto，交给系统程序；不是本机命令执行 |

options 字段：`method?`（缺省 GET，建议大写）、`url`（仅 http/https）、`headers?`（`Record<string,string>`）、`body?`（字符串或 `Uint8Array`/`ArrayBuffer`；二进制会由宿主转标准 base64，也可直接传 `bodyBase64?` 字符串，二者互斥）、`timeout?`（秒；必须非负有限，缺省或 `0` 不设总期限，正数是**整个请求**的总期限——连接加全部读取，不是每块重置）、`redirect?`（`follow` 默认、最多 10 跳；`manual` 不跟随并原样返回 3xx；`error` 遇重定向直接失败）、`responseType?`（`text` 缺省，body 为 UTF-8 解码字符串、非法字节替换；`binary` 时 body 为 `Uint8Array`；`stream` 忽略此字段，始终给字节）、`signal?`（标准 `AbortSignal`，在 Worker 内处理，不会跨结构化克隆）。响应头名字转小写，重复头以 `", "` 合并。

```js
(async () => {
  // 流式读取，逐块处理（SSE 也是字节流）
  const stream = await self.plugin.http.stream({ url: 'http://localhost:8723/events' });
  const decoder = new TextDecoder();
  try {
    for await (const chunk of stream.body) {
      // 用 stream:true 拼接跨块 UTF-8 多字节字符；不要为每块新建解码器
      console.log(decoder.decode(chunk, { stream: true }));
    }
  } catch (error) {
    console.error('stream failed', error);
  }
  // 提前 break 会取消请求；也可显式 await stream.cancel()
})();

(async () => {
  const controller = new AbortController();
  const pending = self.plugin.http.request({ url: 'http://localhost:8723/large', signal: controller.signal });
  controller.abort(); // 连接尚未建立也能取消
  await pending.catch((error) => console.error('request aborted', error.name === 'AbortError' ? 'AbortError' : error));
})();
```

仅 http/https URL；响应体与请求体不设宿主业务大小上限；非 2xx 仍返回响应对象，应检查 status。非法 URL/header/method、`body` 与 `bodyBase64` 同时提供都会在发网前 reject；并发上限为每插件 64、全应用 64。`signal` 取消与超时会让进行中的调用 reject（AbortError 或超时错误）；`stream.cancel()` 与提前 break 会取消原生请求并终止迭代，挂起的
ext()` 以 AbortError reject。取消后不要假定已产生的服务端副作用被撤销。不自动注入 cookies、Referer 或宿主凭据；跨源重定向仅保留 Accept/Accept-Language/Content-Language/Content-Type/Content-Encoding/Range 等明确安全头，Authorization、Cookie 和任意未知自定义凭据头不随跳转发送；需要认证时请直接请求最终源。同源保留合法业务头，Host/Content-Length/Transfer-Encoding 等框架头拒绝。URL 最多 8192 字符，headers 最多 64 个、名字 256/值 8192 字符（这是通道结构保护，不是 body 业务配额）；错误日志去除 URL userinfo/query/fragment。默认继承系统代理，宿主显式配置的插件代理优先。`http.urlWhitelist` 仍是**可选**作用域：缺失或空数组表示不限制，非空时初始 URL 与每个重定向目标都要匹配；需要收紧时才声明。`shell.openExternal` 不受 `http.urlWhitelist` 限制。

### 本机程序执行（高风险）

| 调用 | 权限 | 参数与结果 |
|---|---|---|
| `api['shell.execute']({program, args?, cwd?, env?, stdin?, timeoutMs?})` | shell:execute | 返回 `{exitCode: number | null, stdout: string, stderr: string}`；非零退出码仍是正常结果，输出是 UTF-8 文本（非法字节按运行时替换） |

`shell.execute` 由主窗口 Worker 经宿主执行，隔离视图不能直接启动程序。`program`、`args` 和 `cwd` 直接采用操作系统进程语义，不会自动拼成 shell 命令；可传相对或绝对路径，`cwd` 省略时使用应用默认工作目录。`env` 是在继承环境上叠加的字符串键值；`stdin` 是可选 UTF-8 文本，省略则关闭输入。`timeoutMs` 省略或为 `0` 表示不设截止，正整数表示调用方选择的毫秒截止（仅受安全整数数据表示约束，不设业务上限）。不额外设置命令专用并发、输出或参数业务配额；实际仍受 OS、进程、可用内存及宿主通用 RPC 在途限制。

这是一次性敏感权限授权，不会在每次命令前重复确认。用户应在授权前审阅插件代码和它传给程序的参数；插件可显式选择 `cmd.exe`、PowerShell、`sh` 等解释器来执行 shell 脚本，参数因此可能包含任意代码。禁用、撤权、显式重载、卸载或替换会取消并等待直接子进程，但仅 Worker 崩溃或停止时，宿主可能只丢弃 RPC 回执，不保证取消已启动的原生命令；该命令可能运行至自身结束、调用方 timeout 或后续用户禁用。任何情况下都不承诺终止其创建的进程树，也不撤销已经发生的文件、网络或其他副作用。

```js
self.plugin.on('ui.buttonClick', async ({ buttonId }) => {
  if (buttonId !== 'show-git-version') return; // 不在启动时自动执行
  try {
    const result = await self.plugin.api['shell.execute']({
      program: 'git',
      args: ['--version'],
      timeoutMs: 10_000,
    });
    await self.plugin.api['ui.panel.append']({
      text: `[stdout]\n${result.stdout}\n[stderr]\n${result.stderr}\n[exit] ${result.exitCode}\n`,
    });
  } catch (error) {
    console.error('shell.execute failed', error);
  }
});
```

#### 持续输出任务

需要实时观察工具输出时，使用同一 `shell:execute` 授权下的 `self.plugin.shell.start`。它只在显式调用时启动程序，默认不设执行时间或输出总量业务配额；通用 IPC、操作系统和内存约束仍适用。两个管道各自有序，不能把 stdout 与 stderr 的到达顺序拼成全局时序。

```js
const task = await self.plugin.shell.start(
  { program: 'git', args: ['--version'] },
  { stdout: 'pipe', stderr: 'pipe' },
);
const decoder = () => new TextDecoder();
async function drain(stream, label) {
  const text = decoder();
  for await (const bytes of stream) {
    const part = text.decode(bytes, { stream: true });
    if (part) await self.plugin.api['ui.panel.append']({ text: `[${label}] ${part}` });
  }
  const tail = text.decode(); // flush 跨块 UTF-8 尾字节
  if (tail) await self.plugin.api['ui.panel.append']({ text: `[${label}] ${tail}` });
}
try {
  await Promise.all([drain(task.stdout, 'stdout'), drain(task.stderr, 'stderr'), task.wait()]);
} finally {
  await task.release();
}
// 用户点击“取消”时：await task.cancel();
```

- `shell.start(request, options?)` 返回 `{stdout, stderr, status, wait, cancel, release}`。每个流只能有一个 reader；必须并行 drain 两个 `pipe`，或在启动时把不需要的一侧设为 `{stdout:'discard'|'pipe', stderr:'discard'|'pipe'}`，否则子进程可能因有界管道背压停住。即使 discard，该流也有自己的 EOF。
- `stream` 每块最多 16 KiB；每个管道分别保持顺序。使用独立 `TextDecoder` 并以 `decode(bytes,{stream:true})` 处理块，EOF 后调用无参 `decode()` flush；二进制工具请直接保留 `Uint8Array`，不要强制当 UTF-8。
- `task.status()` 立即取状态，`task.wait()` 等待 `running/cancelling` 以外的 `exited/cancelled/timed-out/failed`；状态含 `exitCode`（失败/取消可为 null）与 `error`。`task.cancel()` 只请求该任务的直接子进程取消；`task.release()` 释放持有的任务记录，仍运行的进程由宿主继续回收，不能撤销进程树或已发生副作用。
- `timeoutMs` 仍是调用方显式设置的单任务截止；缺省/0 不设默认时间。流任务的槽位是运行时资源准入（每 Worker 最多 8 个任务、全局最多 64 个），不是 stdout 总量配额；不要用槽位数字宣称吞吐 SLA。既有一次性 `shell.execute` 保持原返回形状。

#### 将一个串口临时借给工具

需要让下载器独占串口时，在 `shell.start` 的**第二个参数**中传 `serialLoan: {portId, expectedConnectionGeneration}`。从 `ports.status({portId})` 取得当前代次；未知目标或无法确认物理设备身份时不要启动。授权要求同时具备 `shell:execute` 和 `serial:control`，后者受 manifest 的端口白名单约束。该选项只接受操作系统串口，不接受 HyperCom 的 SIM/GIT 模拟端口。USB/J-Link 工具若不占用调试串口，不传这个选项即可。旧宿主不认识该选项时会拒绝；不要降级为插件自行 close/run/open。

```js
const port = await self.plugin.api['ports.status']({ portId });
if (!port) throw new Error('未找到工位绑定的端口');
const task = await self.plugin.shell.start({ program, args }, {
  serialLoan: { portId, expectedConnectionGeneration: port.connectionGeneration },
  stderr: 'discard', // 示例只需 stdout；保留两路时必须并行消费
});
try {
  for await (const bytes of task.stdout) consumeToolOutput(bytes);
  const { state, exitCode, error, serialRecovery } = await task.wait();
  // state/exitCode/error 是进程结果；serialRecovery 是独立的串口归还结果。
} finally { await task.release(); }
```

- 宿主先预留串口、等待旧读写句柄释放，再启动指定程序。`program`/`args` 按原样传递，**不**自动追加端口或替换 `{port}`。拿到任务并不代表设备或下载器已就绪；需要等待上电窗口时，消费下载器的就绪输出，再切电。
- 启动前授权、代次或占用冲突会拒绝。已借出后，即使工具无法启动，也以任务结果报告失败与恢复结果。正常退出、非零退出、取消、超时、撤权或 Worker 退休均由宿主收尾，不依赖插件的 `finally` 重新打开串口。退休后旧 Worker 不能再读取结果。
- 终态的 `serialRecovery.state` 是 `restored`（按原参数重开）、`not-connected`（原本未连，不打开）、`superseded`（新的连接意图或宿主关闭，不再恢复）或 `failed`（附 `error`）。普通无借用任务没有该字段。`task.cancel()` 是请求，**`task.wait()` 的终态才包括归还结果**；即使退出码为 0 也要检查恢复状态。断开期间的日志不能补回。
- 直接启动持有串口的下载器，不要启动立即返回的 GUI 启动器、后台服务或脱离父进程的脚本。任务管理直接子进程，不承诺终止其全部后代；端口消失、重枚举或仍被占用时，重开可以失败，不会猜另一个 COM 口或自动重烧。

### 事件

| 订阅 | 载荷 | 语义 |
|---|---|---|
| `plugin.rx.onLine(cb)` / `plugin.on('rx.line', cb)` | `[{portId, seq, rawData: Uint8Array, encoding, ts}]` | terminal:read；TRX 组装行/协议帧，原始 RX 字节；不包含 TX、NOTE 或日志回放 |
| `plugin.rx.onBytes(cb)` / `plugin.on('rx.bytes', cb)` | `[{portId, bytes: Uint8Array, ts}]` | rx:bytes；协议/TTY 分流前原始 RX 块，注意字段是 bytes，不是 rawData |
| `plugin.rx.onDetached(cb)` | `{portId, reason}` | 有对应 RX 授权时的断流提示；reason 为 mode-tty 或 port-disconnected；字节观察不因 TTY 失效 |
| `plugin.rx.onDropped(cb)` | `{reason, portId?, count?}` | queue-overflow / oversized-frame / worker-backpressure；不能假定所有原因都有端口和数量 |
| `plugin.on('ui.buttonClick', cb)` | `{buttonId, context?, actionToken?}` | 端口菜单携带 context.portId 及端口作用域动作票据；侧边栏可带活动端口信息，但票据不因此限定目标端口 |
| `plugin.on('lifecycle', cb)` | `{state: 'enabled'}` | Worker 创建后的启用通知；禁用会直接终止 Worker，不保证 disable/dispose 回调 |

seq 不是跨应用会话的持久数据 ID；ts 为毫秒时间戳。不要把 RX 块当完整行，也不要按每块重新建解码器处理跨块 UTF-8 多字节字符。

当前**没有** ports.onChange、rx.getBuffer、包资产目录遍历（`fs.list`）、自定义 events.on/emit 或远程调试协议；`shell.execute` 按上文的 `shell:execute` 权限和操作系统进程语义提供。插件市场提供的是宿主侧索引、更新检查和用户确认后的安装流程，不是 Worker API；声明未来权限不能使未实现接口可用。目录读写只针对用户通过原生选择器选定的目录，不是任意路径 API；插件不能用自报路径绕过选择器。

## 隔离 UI 与工作区标签

隔离页面既可替换 serial 标签内容，也可额外打开 workspace-tab；两者共用 Worker 的解析会话。独立页面可以不绑定串口，例如插件配置器；原始标签、表格和波形可以同时关联一个端口，关闭其中一个不停止其他输入。

### 声明与打包

```json
{
  "requires": ["isolated-tab-view@1", "plugin-workspace-tabs@1"],
  "permissions": ["rx:bytes", "ui:view", "ui:tabs"],
  "ui": {
    "views": [{
      "id": "table",
      "label": "Sensor table",
      "entry": "ui/table.js",
      "styles": ["ui/table.css"],
      "assets": [],
      "modes": ["trx", "tty"],
      "input": "bytes",
      "placements": ["serial-content", "workspace-tab"],
      "portBinding": "required",
      "restoreOnStartup": true
    }]
  }
}
```

这是隔离模式的字段片段，完整包仍需 id/name/version/apiVersion/entry。`mode` 缺省或为 `isolated` 时，ui entry 为单个普通脚本 bundle；框架及第三方依赖必须打包进脚本，不加载 CDN 或任意页面。宿主 shell 提供 `#plugin-root`，脚本创建本页面 DOM。styles/assets 可省略，默认空数组；需要的静态文件必须明确列入。路径使用普通包内文件，禁止 data/、链接、穿越、URL、宿主保留命名空间和 ADS。

声明约束：视图 `id` 由 ASCII 字母/数字/`-`/`_` 组成且 ≤128 字符、插件内唯一；`label` 非空且 ≤128 字符。`modes` 至少一个、至多 `trx`/`tty` 各一次，绑定端口的当前模式必须匹配。`placements` 至少一个、至多两项；`serial-content` 不接受 `portBinding:"none"`。隔离视图 `entry` 必须以 `.js`、`styles` 项必须以 `.css` 结尾。每插件最多声明 32 个视图，每个视图的 styles+assets 最多 256 个文件，单个包内路径 ≤512 字符。声明任何视图必须同时声明 `ui:view`（运行时还需用户授予）；Worker 的 `tabs.*` 另需 `ui:tabs`。

input 为 bytes/lines/none：分别需要 rx:bytes、terminal:read 或无 RX 权限；lines 仅 TRX。portBinding 为 required/optional/none，bytes/lines 必须绑定端口，serial-content 始终使用原标签端口。restoreOnStartup 默认 false；true 恢复描述和布局，不恢复 params、解析残帧或采样历史。

### 可信网页模式（Windows）

`mode: "trusted-web"` 把 HTML 当完整文档原样加载，不生成外壳或 `#plugin-root`。以下是独立工具页的声明片段：

```json
{
  "requires": ["trusted-web-view@1", "plugin-workspace-tabs@1"],
  "permissions": ["ui:view"],
  "ui": {
    "views": [{
      "id": "assistant",
      "label": "AI assistant",
      "mode": "trusted-web",
      "entry": "ui/index.html",
      "assets": ["ui/app.js", "ui/app.css"],
      "modes": ["trx", "tty"],
      "input": "none",
      "placements": ["workspace-tab"],
      "portBinding": "none",
      "restoreOnStartup": true
    }]
  }
}
```

- 完整插件通常保留普通 Worker `entry`；纯网页插件可以**完全省略插件根 `entry`**，此时宿主不创建根 Worker，页面独立运行（视图自身的 `entry` 仍必填）。给视图加 `"worker": false` 表示该可信页不依附 Worker：只允许 `trusted-web` + `input:"none"`，没有 Worker 侧会话对象、不接收 RX，也不能发布模型或发送串口；但它不会阻止根 Worker 启动——若 manifest 仍声明 `entry`，根 Worker 照常运行并可供其他视图使用。纯网页或 `worker:false` 页面没有 Worker 对端，`view.send` / `view.preview` 会同步报错，`view.sendAction` 返回 `unavailable`，`view.sendBinary` 会 reject。HTML 无需主动调用 SDK 即可显示。
- 同源本地页面之间可以正常导航与刷新（路径、查询串、锚点均可），其他声明的 HTML 页面放进 `assets`；除纯锚点变化外，导航/刷新生成新文档，宿主重建 SDK 身份、重放当前模型并拒绝旧文档迟到的 ACK/消息/二进制块；纯锚点后再刷新仍会生成新身份。只有用户**真实点击**的外部 http/https 链接或新窗口才交给系统浏览器，不获得 SDK；脚本发起的顶层跳转只取消、不弹浏览器；其他协议拒绝。在起始时直接拒绝的外部跳转不退休页面；已准许的本地导航后来被取消则明确报错并退休，避免旧文档身份已失效却永久 loading。若链接指向声明过的本地 HTML，则按本地导航处理。
- 视图自身 `entry` 必须是 `.html` / `.htm`，`styles` 必须为空；HTML 自己引用 CSS/JS，包内文件列入 `assets`。支持内联脚本、模块脚本及资源查询参数；未声明的本地文件不回退到网络。
- 浏览器直接支持 HTTP/HTTPS、WebSocket、SSE、普通网页资源、文件选择器、Blob 下载、剪贴板和 localStorage/IndexedDB；无需为这些网页操作另授 Worker 的 `http:request` / `fs:open` / `clipboard` / `storage` 权限。Worker API 的原权限规则不变。
- 网络不使用宿主端点白名单，也不使用 Worker 代理设置。浏览器 CORS、TLS 和混合内容规则仍生效；模型服务不支持跨域时，应配置服务 CORS 或使用本地桥接，不关闭浏览器安全检查。
- 文件读取通过 `<input type="file">` 及 File API；下载需确认原生保存对话框，不自动执行下载文件。剪贴板遵循浏览器焦点与用户操作要求。摄像头、麦克风等无关权限不开放。
- 宿主在文档脚本前注入现有 `view` SDK，不修改 HTML；本地顶层页面获得 SDK，iframe 不获得。页面普通资源/请求错误不会导致插件视图退休；原生进程崩溃、文档加载失败或已准许导航取消会报告失败。可信文档加载期间不设固定期限，但成功加载后 30 秒仍未 ready 会报错；隔离页面仍适用 5 秒初始化期限。
- 可信模式默认拒绝；安装或首次启用时，在同一权限审阅中以独立的网页信任勾选项明确确认，普通权限选择不会代替它。若从设置单独管理网页信任，也必须明确确认。批准绑定安装代次，升级重新确认，重启不重复询问；配置导入不能新增或恢复已撤销的网页信任。
- 浏览器数据位于配置目录旁 `plugin-web-data/<pluginId>/<installGeneration>/`，与插件可写 `data/` 分离。origin 按 pluginId + viewId 稳定，同代次同视图多实例共享存储；不同视图来源隔离，不同安装代次目录隔离。普通重载保留，新代次升级/重装不复用旧站点数据，卸载或“清除网页数据”清除全部站点数据；空浏览器配置文件可能保留。清除操作先禁用插件，普通 `data/` 不受影响。
- 可信网页仍没有主窗口 DOM、Tauri 通用 IPC、Shell 或任意磁盘路径 API。它能够把选中的日志、剪贴板内容上传网络，因此只应信任用户认可的插件及其加载的网页代码。

### Worker 会话 API

| 接口 | 行为 |
|---|---|
| `plugin.views.onOpen(cb)` | 收到会话对象，含只读 context、初始 params；异步初始化完成后宿主才将其标为 ready |
| `plugin.views.onClose(cb)` | `{view, reason}`；不等待未完成输入回调才 retire，退出应用仍不保证持久化回调完成 |
| `plugin.views.onMessage(cb)` | `{view, type, payload}`；亦可用会话 view.onMessage(cb) 注册 |
| `view.onInput(cb)` | 固定绑定端口的数组批次；元素形状与 `rx.line` / `rx.bytes` 对应的 `rawData` / `bytes` 一致；每会话串行处理，包括异步回调 |
| `view.onDiscontinuity(cb)` | `{reason, streamEpoch}`；先清解析/流式解码残留，再处理缺口后的批次；常见 reason 有 input-gap、queue-overflow、port-connected、port-disconnected、mode-tty、mode-trx、delivery-failed |
| `view.onStatus(cb)` | `{instanceId, status, streamEpoch}`；断开/重连不关闭页面 |
| `view.publish(snapshot)` | 当前有界 JSON 模型；合并未发送快照，resolve 不保证每个版本都显示 |
| `view.sendSerial({data,isHex?,lineEnding?})` | 需要 serial:send 及白名单，不接受 portId，由会话固定端口决定；无端口页拒绝；单次 data ≤65536 个 UTF-16 代码单元 |
| `view.sendBinary(type, bytes)` | 把 `Uint8Array`/`ArrayBuffer` 原始字节经 8 KiB 分块、一块在途逐块 ACK 发给本页，单条最多 256 MiB、受共享传输资源预算限制；非末块由接收端入缓存后立即确认，末块等完整字节交付异步回调结算；页面导航、关闭或实例退休会取消并拒绝未完成传输 |
| `view.onBinary(cb)` | 接收页面的完整传输 `{type, bytes: Uint8Array}`；末块的确认等待回调 Promise settle，最多 30 秒 |

`plugin.views.*` 只对依附 Worker 的视图触发；纯网页插件与 `worker:false` 视图没有 Worker 侧会话对象。`view.*` 需要 `ui:view`（`view.sendSerial` 另需 `serial:send` 与端口白名单），`tabs.*` 另需 `ui:tabs`。

context 包含 tabId、placement、boundPortId、portMode、pluginId、installGeneration、viewId、tabSessionId、viewInstanceId、workerEpoch、streamEpoch。tabId 是工作区身份，不是端口号；streamEpoch 只是初始化值，后续连续性以事件为准。实例退休后 publish/sendSerial/sendBinary 拒绝；切焦点不改端口，切分屏不重建模型。

### UI SDK

UI 脚本全局 `view` 与 Worker 会话对象不是同一对象：

- `view.context`：宿主赋值的只读身份，不能自报别的端口或插件。
- `view.documentId`：当前文档身份，仅供诊断/关联；导航或刷新后变化，旧文档异步结果应丢弃。
- `view.onState(cb)`：完整 JSON 模型；回调 Promise 完成后 ACK，失败显示错误，不把“收到”当“已应用”。
- `view.onEnvironment(cb)`：theme/language/fontFamily/fontSize/zoomPercent/visible/focused/portStatus；变化合并，不从父窗读取样式。
- `view.send(type, payload)`：兼容保留的普通交互入口，向自身 Worker **尝试发送一次**，不是宿主 API，也不表示设备命令已完成；返回 `void`，只对未初始化、无 Worker 或参数非法抛出同步错误。宿主拥塞或 Worker 未确认时不会返回拒绝 Promise；页面会显示节流的“未发送/未获确认”提示，重试前应核实可能已发生的副作用。
- `view.preview(type, payload)`：适用于拖动、筛选等可替换预览。每个文档只保留最新候选，约每 50ms 尝试一次；旧候选会被合并，文档 `pagehide`、关闭、导航或换代时丢弃。该方法返回 `void`；宿主内部以 ACK 管理接纳状态，但不向页面承诺业务处理完成。
- `await view.sendAction(type, payload)`：离散动作的一次性发送，返回 `{status:'accepted'|'busy'|'unavailable'|'unknown'}`。`accepted` 仅表示进入当前 Worker 桥，不表示动作完成；`busy`/`unavailable` 不会自动重发，`unknown` 表示在等待确认期间发生超时或换代，重试前应核实副作用。每个文档的在途动作有界，单次 payload 仍受 16 KiB UTF-8 包络限制。
- `view.sendBinary(type, bytes)`：把 `Uint8Array`/`ArrayBuffer` 原始字节发给 Worker；每块原始字节 ≤8 KiB、base64 编码后整条信封 ≤16 KiB，`transferType` ≤128 字符全程一致，保持一块在途并等对应 ACK，单条最多 256 MiB，不与实时 JSON 状态争用合并通道。发送 Promise 可能因接收端 nack、页面导航/关闭/换代或通道关闭而拒绝。
- `view.onBinary(cb)`：接收 Worker 的完整传输 `{type, bytes: Uint8Array}`——按 `seq` 严格顺序重组，全部到齐后一次性交付；非末块在接收端入缓存后立即确认，**只有末块**要等回调 Promise 结算后才确认，可安全异步处理。两个方向的接收端各自最多同时保留 4 个未完成入站传输；乱序、类型变化、非法块或单块超 8 KiB 会 nack 并丢弃半成品。
- 二进制通道有独立资源期限：逐块/末块异步回调 ACK 最多等待 30 秒，发送排队等 ready 最多 60 秒；接收半成品闲置 60 秒会主动释放并 nack。Worker 二进制 RPC 及宿主 sender 自发送入口起的整体资源持有最长 10 分钟，排队计入且持续 ACK 不续期；到期不影响健康后继。超时会明确 reject，不能把迟到 ACK 交给新传输；已经运行的插件回调不假装被撤销。
- 共享预算涵盖传输拥有的原始缓冲与拼接峰值：主窗双向跨视图每插件安装代次 512 MiB/16 条、全应用 1024 MiB（1 GiB）/32 条；每 sender 排队+在途最多 256 MiB/4 条。页内 SDK 每文档双向共享 512 MiB/4 条。单条均最多 256 MiB；SDK 二进制处理与状态 ACK 使用独立有界队列。预算不是整个 OS 堆或插件自行保留数据的硬配额。

Worker 侧对象对称：`view.sendBinary(type, bytes)` / `view.onBinary(async ({type, bytes}) => …)`。二进制通道按「视图实例 + 当前文档 + Worker 代次」绑定；页面导航、关闭或插件交换代次会拒绝未完成传输，迟到的确认不会影响新页面。已在执行的插件异步逻辑本身不能假装被撤销。通道分块/ACK/取消细节见[视图二进制通道](architecture/plugin-views.md#视图二进制通道)。

隔离模式 UI 不直接 fetch/WebSocket、不创建 frame/Worker、不打开文件或运行 Tauri 命令；需要敏感能力时发交互让 Worker 经已有授权 API 执行。**浏览器真实用户操作的原生复制/剪切是允许的边界例外**。可信网页的浏览器能力见上节；两种模式都不直接运行 Tauri 命令。

### 可选时间联动 API（UI 专用）

`view.timeline?.register(...)` 是运行时 opt-in，不需要新增 manifest 能力或 Worker 对端；旧插件不注册即不参加时间联动。用户在宿主选择组成员，插件不能自行加入组、指定其他标签或冒充其他端口。原生视图的平台与授权边界不变。

```js
const timeline = view.timeline?.register({
  version: 1,
  clock: { kind: 'bound-input' },
  capabilities: { preview: 'bounded', canDrive: true },
  async onSeek({ timeMs, phase, align, signal }) {
    const row = findRetainedVisibleRecordAtOrBefore(timeMs);
    if (!row) return { status: 'no-time' };
    if (signal.aborted) return { status: 'held' };
    await applyChartPosition(row, { phase, align });
    // 在最终 DOM/图表写入前也要检查 signal；返回表示本地定位已完成，
    // 不是仅入队成功，更不是不同 WebView 已物理同帧呈现。
    if (signal.aborted) return { status: 'held' };
    return { status: row.ts === timeMs ? 'exact' : 'nearest', actualTimeMs: row.ts, recordKey: row.id };
  },
});
timeline?.setAvailability({ available: true, range: { startMs, endMs } });
// 仅在真实明确导航时调用，不在焦点、普通行点击、数据更新或程序滚动时调用。
const navigation = timeline?.beginNavigation('scrollbar');
navigation?.update({ timeMs: row.ts, recordKey: row.id });
navigation?.end(); // 立即携带最终锚点，不等待预览节流；也可 end(finalAnchor)
```

- `clock:{kind:'bound-input'}` 仅允许实际依附输入 Worker、且声明 bytes/lines 的绑定视图，使用宿主确认的采集时间域。保留输入 `ts`，帧完成采用完成块的采集时间，不用处理时 `Date.now()` 重打时间。
- 自有/设备时间使用 `clock:{kind:'custom',id:'device-clock'}`；宿主按插件与安装代次隔离来源/时钟身份，不能把 id 写成宿主时间域来获取公共时钟。与其他来源比较前由用户确认时间映射。纯网页与 `worker:false` 页面可使用 custom 时间域，即使 `view.send` / `view.sendBinary` 因无 Worker 拒绝，时间通道仍可用。
- `preview:'bounded'` 表示单次预览的查找与定位有界且支持合作取消；全量昂贵重画应声明 `'commit-only'`。`canDrive:false` 禁止取得驾驶权但仍能跟随，例如表格按温度而非时间排序时。`updateCapabilities({preview,canDrive})` 可更新这两个字段。
- `onSeek` 的 `phase` 是 preview/commit、`align` 当前是 center，另含宿主绑定的导航/映射/来源版本；`signal` 是 SDK 本地 AbortSignal，不经 JSON。返回 `status` 为 exact/nearest/before-range/after-range/no-time/filtered/held/loading/unsupported，实际可定位结果附有限 `actualTimeMs` 和可选 ≤128 UTF-8 字节 `recordKey`（custom clock.id 同上限，拒绝孤立 UTF-16 代理项）。越界结果只报告本成员实际位置，不修改组共同时间。
- `setAvailability({available,range?})` 只发布有限范围摘要，不传整条时间数组；`range` 为有限的 `{startMs,endMs}`。宿主可见性由宿主决定，页面不能自行报告“可见”。`dispose()` 注销能力并取消等待；重新 register 创建新的能力代次。
- `beginNavigation(intent)` 支持 scrollbar/wheel/keyboard/search/jump/align/scrub，返回 update/end/cancel；每个能力只保留一个本地主动手势。update 约 10Hz 合并最新值，end 独立携带最后一次锚点，不被待发 preview 吞掉。需要自行补齐 pointerup/pointercancel/blur/visibilitychange 等本地手势收尾；取消或关闭时可调用 cancel。
- 时间控制走独立 UI↔宿主原生 lane，**不走 `view.send`、Worker、业务 state Promise 队列或二进制通道**。每目标一条实际在途回调加一条最新候选，commit 优先于同代 preview。新目标/取消会 abort 旧回调，但不会用超时假装旧 JS 已停止；旧回调未结束时不并发绕过它。SDK 只在回调真正结束后发送结果 ACK。
- 初始慢成员阈值：preview 150ms、commit 2s，慢时间成员显示 slow/待对齐，不因此退休整个插件页面；迟到 ACK 不覆盖更新的导航、映射或文档。导航/刷新、实例关闭、Worker 换代或撤权会释放适配器与等待者。隐藏页面不追赶历史定位，恢复只处理当前目标。独立 lane 不是 CPU/线程隔离，同步重画仍能卡住页面。
- 原生时间信封 ≤8KiB、页面控制 payload ≤4KiB；页面 preview 独立桶 20/s、突发20，注册/ACK/end 等控制独立桶64/s、突发64，不与普通交互、状态 ACK 或二进制争用。SDK去重能力/范围摘要；勿高频滥发注册或最终控制。

[Sensor Workspace](../examples/plugin-views-demo/README.md) 的表格和波形保留输入时间、明确限制 200 条，因此声明有界预览；其中 [workerless 示例](../examples/plugin-views-demo/workerless/manifest.json) 是可单独安装的无 Worker 自有时钟页。插件只能定位自己保留的数据，时间 API 不会补发历史输入或把回放伪造为实时 RX。

### 动作标签 API

```js
self.plugin.on('ui.buttonClick', async function (event) {
  if (event.buttonId !== 'open-table' || !event.context?.portId) return;
  await self.plugin.tabs.open({
    viewId: 'table',
    portId: event.context.portId,
    instanceKey: 'live',
    activation: 'foreground',
    actionToken: event.actionToken
  });
});
```

- `tabs.open({viewId,portId?,instanceKey?,params?,activation?,actionToken?})` 返回 `{tabId,created,state}`。默认 background，固定键 `(插件/安装代次/视图/端口/instanceKey)` 去重；已有页面不被新 params 重置，loading 不代表 ready。
- 宿主加号未显式指定实例键时，会优先聚焦同插件/安装代次/视图/绑定端口的已有页面，再复用其 `instanceKey`；没有匹配才以 `default` 新建。希望插件按钮与宿主入口无论打开顺序都共用页面时，省略 `instanceKey`（同样取 `default`）；只有确实需要独立会话时才使用不同键。
- foreground 及 `tabs.activate({tabId,actionToken})` 需要宿主单次动作票据（5 秒）。端口菜单票据限定端口，侧边栏票据仅插件/代次/pane；后台 RX/定时请求不能抢焦点。UI 自报 userGesture 不能产生票据，UI 按钮可请求后台打开。
- `tabs.close({tabId})` 仅自身未固定标签；`tabs.setTitle({tabId,title})` 只改自身纯文本标题，保留宿主来源标识；`tabs.list()` 只返回自身有界摘要。
- 用户关闭后，同键后台重开拒绝；明确用户打开可解除。新建不自动连接串口、不开原始终端、不发送数据；无端口页没有默认发送目标。

### 额度与恢复

替换与独立实例合计每插件最多 8 个、全应用 16 个。每个视图最多声明 256 个 styles/assets 路径；资源只快照元数据并在 WebView 请求时按需流式供给，不把单文件 8 MiB/视图 32 MiB 当作当前运行时硬上限。约 9 MiB 资源已通过隐藏 WebView2 生产 selector 加载并完成 SHA 校验，但不等于发行包全流程验收。快照至多 256 KiB UTF-8、只接受 JSON（另限 65536 个节点、嵌套 64 层）；ArrayBuffer/类型化数组/Map/Set/Date、非有限数、getter、稀疏或循环对象拒绝。每视图一条在途快照及一个最新候选，全插件待发送至多 1 MiB，可见发送至多约 30/s；隐藏不积压历史，恢复显示重发当前模型。

params 至多 16 KiB；instanceKey/title 至多 128 字符。tabs 管理按令牌桶 2/s、突发 4 限制；UI 交互至多 16 KiB 原生消息包、约 30/s，页面→原生普通交互另有每视图 64 条/秒上限；ready/state-ack/error 独立控制桶为 128/s、突发 128，二进制分片/确认按插件共享 512/s、突发 1024，二进制首次超额会使视图明确失败而非永久等 ACK。隔离视图 UI ready 5 秒、Worker 初始化 10 秒；可信文档加载成功后才启动 30 秒 ready 看门狗，加载过程本身不设固定期限。状态 ACK 可见时 5 秒，隐藏/宿主遮挡时不误杀。后台关闭记录每插件最多 128 项，达到后暂停后台新建，用户入口仍受总额度。

串口替换偏好在 portMeta，独立可恢复标签在 session.json。禁用/撤 ui:view 或输入权限/升级/故障使执行环境失效：替换回原始，独立页显示不可用/重试。旧安装代次不能恢复到新代码；新用户选择必须重新审阅。ui:tabs 撤销停止 Worker 标签管理，不自动授予或撤销 ui:view。插件桌面弹出窗未开放。

完整示例见[Sensor Workspace](../examples/plugin-views-demo/README.md)，安全和生命周期实现见[工作区视图契约](architecture/plugin-views.md)。原生隔离不等于每视图独立 OS 进程或硬内存配额。

## 常见功能示例

下面每个 JavaScript 代码块是独立普通脚本示例；按用途选择或合并，不要覆盖 self.plugin 的消息桥。涉及权限时，先同步 manifest.permissions 并让用户授权。

### 观察 RX 行并写旁注

需要 terminal:read 和 terminal:write。按行携带的编码解码；回调顺序完成本批写入，不产生串口 TX：

```js
self.plugin.rx.onLine(async (lines) => {
  try {
    for (const line of lines) {
      const text = new TextDecoder(line.encoding).decode(line.rawData);
      if (text.includes('PING')) {
        await self.plugin.api['terminal.append']({
          portId: line.portId,
          text: `PONG<${text.trim()}>`
        });
      }
    }
  } catch (error) {
    console.error('RX processing failed', error);
  }
});
```

TTY 不产 rx.line；需要原始流时改为 rx.onBytes，并维护每端口流式解码状态。对二进制协议保留 bytes，不强制转成字符串。

### 保存插件设置

需要 storage。读取失败进入错误分支，**不执行写入**；升级保留此私有数据，但每次升级需要用户重新授权：

```js
(async function () {
  const api = self.plugin.api;
  try {
    const settings = await api['storage.get']({ key: 'settings' });
    if (settings === undefined) {
      await api['storage.set']({ key: 'settings', value: { format: 'text' } });
    }
    await api['ui.panel.append']({ text: 'Settings ready\n' });
  } catch (error) {
    await api['ui.panel.append']({ text: `Settings unavailable: ${String(error)}\n` })
      .catch((reportError) => console.error('report failed', reportError));
  }
})();
```

### 从用户选择的文件读取文本

需要 fs:open。将操作挂到声明式按钮上；以下入口搭配 `ui.buttons` 或 `ui.menuItems` 中 id 为 open-text 的项：

```js
self.plugin.on('ui.buttonClick', async ({ buttonId }) => {
  if (buttonId !== 'open-text') return;
  try {
    const result = await self.plugin.api['fs.openDialog']({
      multiple: false,
      filters: [{ name: 'Text', extensions: ['txt', 'log'] }],
      encoding: 'utf-8'
    });
    for (const file of result.files) {
      await self.plugin.api['ui.panel.append']({ text: `${file.path}\n${file.content}\n` });
    }
  } catch (error) {
    console.error('file selection failed', error);
  }
});
```

读取 GBK 文本时显式设 encoding 为 gbk；取消选择不当成失败。选择器打开期间若插件被禁用、撤权或换代，结果可能被拒绝，不要绕过授权重读 path。

### 读取原始二进制

以下代码放在用户按钮回调中；读取包内资源需 `fs:assets`，读取 `data/` 需 `fs:storage`，外部选择需 `fs:open`，均不需要可信网页授权：

```js
(async () => {
  try {
    const bytes = await self.plugin.api['fs.read']({
      rel: 'assets/firmware.bin',
      format: 'binary'
    });
    const selected = await self.plugin.api['fs.openDialog']({
      multiple: true,
      format: 'binary'
    });
    for (const file of selected.files) {
      // file.bytes 是 Uint8Array；无需 base64 解码或数组转换。
      const data = new DataView(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength);
      if (data.byteLength >= 4) console.log(file.path, data.getUint32(0, true));
    }
    console.log('package bytes', bytes.byteLength);
  } catch (error) {
    console.error('binary read failed', error);
  }
})();
```

宿主向 Worker 转移字节缓冲区，减少交付时的重复复制；这不代表原生读取、frame 解析和 JS 处理端到端零拷贝。要只看文件头或当前可见区域，使用 `fs.readRange`，不要先完整读取再 `subarray`。可信网页本身仍可用 `File.arrayBuffer()` / `File.stream()` 或 `fetch(...).arrayBuffer()` 读取，和 Worker API 的返回格式独立。

### 选择目录并读写文件

读取需要 `fs:open-dir`，仅导出汇总使用最小 `fs:export-dir`；追加/显式建目录/删除/重命名才需要旧 `fs:write-dir`。任一目录权限均能打开目录选择器，但仅有导出/写权限不能 list/read。目录选择只应在用户操作（按钮/菜单）中发生；宿主不接受插件提供的任意目录路径。以下示例需要 `fs:open-dir` + `fs:export-dir`，并在 manifest 声明 `open-log-dir` / `stop-log-scan` 按钮：分页扫描 `.log`，每个文件只查看前 64 KiB，并以相对路径导出预览汇总；每次只保留一页目录和一个文件窗口，不收集完整树或所有文件内容，也不对所有文件启动 `Promise.all`。

```js
let logScanController = null;

self.plugin.on('ui.buttonClick', async ({ buttonId }) => {
  if (buttonId === 'stop-log-scan') {
    logScanController?.abort();
    return;
  }
  if (buttonId !== 'open-log-dir' || logScanController) return;
  const api = self.plugin.api;
  const controller = new AbortController();
  logScanController = controller;
  const signal = controller.signal;
  let grantId;
  try {
    const { directories } = await api['fs.openDirectoryDialog']({ title: '选择日志目录' });
    if (directories.length === 0) return; // 用户取消
    grantId = directories[0].grantId;
    if (signal.aborted) return; // 选择器本身不接受 signal

    let cursor;
    let files = 0;
    let totalBytes = 0;
    const windowBytes = 64 * 1024;
    do {
      const page = await api['fs.listDirectoryPage']({
        grantId, recursive: true, cursor, limit: 128,
        priority: 'background', signal
      });
      for (const entry of page.entries) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.log')) continue;
        const bytes = await api['fs.readRange']({
          grantId, rel: entry.rel, offset: 0, length: windowBytes,
          priority: 'background', signal
        });
        // 在这里解析/消费文件头；不把 bytes 推入累计数组。
        totalBytes += bytes.byteLength;
        files += 1;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    if (signal.aborted) return;
    await api['fs.exportFile']({
      grantId,
      rel: 'exports/summary.txt',
      content: `files: ${files}, preview bytes: ${totalBytes}\n`
    });
  } catch (error) {
    if (error?.name === 'AbortError') console.log('scan cancelled');
    else console.error('directory scan failed', error);
  } finally {
    if (grantId) await api['fs.releaseDirectory']({ grantId }).catch(() => {});
    if (logScanController === controller) logScanController = null;
  }
});
```

`listDirectory` 默认只列一层，`recursive:true` 返回整棵树且不设深度/条数上限。`path` 仅供展示，所有访问必须使用 `grantId` + `rel`。目录内符号链接/重解析点和特殊文件标记为 `kind:"other"`，不可读取；路径解析后越出所选目录、绝对路径或 `..` 一律拒绝。`writeDirectoryFile` 的 `mode` 默认 `overwrite`（原子替换），`append` 用于追加；`createParents` 默认 true。`removeDirectoryEntry` 递归删除需要显式 `recursive:true`。目录权限不等于 `fs:open`：使用文件选择器和目录选择器时，manifest 需分别声明 `fs:open` 与目录权限。

### 两种最小权限导出

下面是 Worker 片段。分别在 manifest 声明 `export-report` / `save-report` 按钮与实际需要的 `fs:export-dir` / `fs:save`；只需其中一种时不要申请另一种。示例保留原始字节（含 NUL 和非 UTF-8），不把展示用 path 当后续写权限：

```js
self.plugin.on('ui.buttonClick', async ({ buttonId }) => {
  const api = self.plugin.api;
  const bytes = new Uint8Array([0x00, 0xff, 0x80]);
  try {
    if (buttonId === 'export-report') {
      const { directories } = await api['fs.openDirectoryDialog']({ title: '选择导出白名单目录' });
      if (!directories.length) return;
      const { grantId } = directories[0];
      try {
        await api['fs.exportFile']({ grantId, rel: 'reports/sample.bin', bytes });
      } finally {
        await api['fs.releaseDirectory']({ grantId });
      }
    } else if (buttonId === 'save-report') {
      const saved = await api['fs.saveFile']({
        bytes,
        options: { title: 'Save As', defaultFileName: 'sample.bin', filters: [{ name: 'Binary', extensions: ['bin'] }] }
      });
      if (saved === null) return; // 用户取消，不等于成功保存空文件
      await api['ui.panel.append']({ text: `Saved ${saved.bytesWritten} bytes\n` });
    }
  } catch (error) {
    console.error('export failed', error); // 不盲目重放可能已提交的写入
  }
});
```

### 打开与按代次关闭串口

声明 `serial:control`、匹配的 `serial.portWhitelist`，以及 `open-device` / `close-device` 端口菜单按钮；如果还需要发送，另加 `serial:send`。只在用户按钮事件执行，不在插件启动时抢设备。打开不切换当前标签；关闭不能沿用旧连接代次去影响新会话：

```js
const openedGenerations = new Map();
self.plugin.on('ui.buttonClick', async ({ buttonId, context }) => {
  const portId = context?.portId;
  if (!portId) return;
  try {
    if (buttonId === 'open-device') {
      const opened = await self.plugin.api['serial.open']({ portId, params: { baudRate: 115200 } });
      openedGenerations.set(portId, opened.connectionGeneration);
    } else if (buttonId === 'close-device') {
      const expectedConnectionGeneration = openedGenerations.get(portId);
      if (expectedConnectionGeneration === undefined) return; // 或显式查询 ports.status 并由用户决定
      await self.plugin.api['serial.close']({ portId, expectedConnectionGeneration });
      openedGenerations.delete(portId);
    }
  } catch (error) {
    console.error('serial control failed', error); // 过期代次/撤权失败不自动重试
  }
});
```

### 向指定串口发送

需要 serial:send 和匹配作用域。把同样的 send-ping 按钮 id 声明在 ui.menuItems 中，让用户明确选中端口；以下不会在启动时自动发送：

```js
self.plugin.on('ui.buttonClick', async ({ buttonId, context }) => {
  if (buttonId !== 'send-ping' || !context?.portId) return;
  try {
    const result = await self.plugin.api['serial.send']({
      portId: context.portId,
      data: 'PING',
      isHex: false,
      lineEnding: 'None'
    });
    await self.plugin.api['ui.panel.append']({ text: `Wrote ${result.bytesWritten} bytes\n` });
  } catch (error) {
    console.error('send failed', error);
  }
});
```

不要用此返回值推断设备完成业务操作；若协议需要应答，应另观察对应 RX 并按协议关联。

## 限制与错误处理

| 资源 | 当前限制 / 行为 |
|---|---|
| manifest | 1 MiB，UTF-8 普通文件 |
| 目录 / ZIP 包 | 本地目录复制先在控制闸门外做无跟随扫描、条目计数/总字节与目标卷可用空间预检，再以 256 KiB 窗口复制并报告进度；本地复制仍守 64 MiB 总解压/复制数据、2000 条、32 层边界。源在扫描与复制间变化会失败，取消不发布 staging；拒绝穿越/链接/特殊文件/硬链接；目录根与祖先也须为真实非链接路径 |
| ZIP元数据 | 压缩输入96MiB、中央目录16MiB、单条名称/extra/comment合计64KiB；实体记录≤2000且不得重复，支持限额内ZIP64；这些是不受信归档解析/展开保护，不等同合法本地目录复制上限 |
| 声明视图资源 | manifest 仍限制每插件最多 32 个视图、每视图最多 256 个 styles/assets 路径；安装/启用时只快照声明资源的身份、大小、修改时间和 MIME，WebView 请求时再按已打开句柄校验并流式供给；不把资源整包读入内存。约 9 MiB 资源已在隐藏 WebView2 的生产 selector 路径加载并完成 SHA 校验，但不等于发行包全流程验收 |
| data/ 写入 | 不设单文件/总量/文件数上限；路径与原子写约束保留；每次写入不再扫描整个 data/ |
| 旧全文件读取 | 保留 `fs.read` / `fs.openDialog` / `fs.readDirectoryFile` 的参数、返回类型；不限制扩展名/内容/文件大小/总量/多选数量，无固定读取期限；完整读取所需内存由运行环境决定 |
| 范围/批量读取 | 单 range ≤4 MiB，批量 1..64 项且申请长度之和 ≤8 MiB；是单次传输窗口，不是文件总大小上限；支持 signal，无隐式总期限 |
| 目录分页 | 每页默认 256、最多 1000 项，另有约 1 MiB 元数据软预算，递归栈最多 128 层、rel ≤4096 UTF-8 字节；真正增量、不保证排序/快照；cursor 闲置 60 秒失效且不能跨会话复用 |
| 插件目录授权 | `fs.openDirectoryDialog` 只能打开原生选择器；grant 本身无 TTL、无数量上限，不等于有 TTL 的分页 cursor。旧 `listDirectory` 默认一层，`recursive:true` 返回完整排序树且不设深度/条数上限；`readDirectoryFile`/`writeDirectoryFile` 无内容大小上限，一次性读写整个文件。`other` 条目不可读；禁止绝对路径、`..`、链接/重解析点和越界路径。写文件 `overwrite` 使用同目录临时文件 + 原子替换，`append` 直接追加 |
| 插件 IO 准入 | 控制面闸门等待最多 5 秒，繁忙时可重试；公平文件 IO 调度独立于 RX/control 事件预算；soft IO budgets 不是总内存或堆限额，见[范围读取、批量与目录分页](#范围读取批量与目录分页)；已开始的 IO 不因回执退休而提前归还资源 |
| 串口与终端写入 | `serial.send` 单次 data ≤1048576 个 UTF-16 代码单元；`view.sendSerial` 单次 data ≤65536 个；`terminal.append` 单次 text ≤65536 个 |
| HTTP | 仅 http/https；无宿主业务大小上限、无固定 timeout；`timeout` 为调用显式给出的非负有限秒数（0/缺省=不设总期限），重定向默认最多 10 跳；并发上限每插件 64、全应用 64 |
| Shell 流任务 | 同一 `shell:execute` 权限；stdout/stderr 各自单 reader、每块 ≤16 KiB、可 pipe/discard；每 Worker 最多 8 个、全局最多 64 个任务槽；无默认时间或输出总量业务配额，`timeoutMs` 仅按调用方设置 |
| 单文件句柄 | `fs.openFile` 只读、`fs.createFile` 只写另存为；单窗口/写块 ≤1 MiB；每插件最多 4、全局最多 32 个句柄；AbortSignal/close 可取消，commit 不自动重试且发布后不回滚 |
| 文件保存 | `fs.exportFile` 仅白名单 grant + 相对路径，原子覆盖/建父目录；`fs.saveFile` 每次原生 Save As；二者无内容业务大小限额/隐式期限，取消另存为返回 null，不能以 path 复用授权 |
| 串口任务 | `serial.sendBytes` / `serial.sendFile` 每窗口最多 64 KiB，固定 `portId` + `expectedConnectionGeneration`；每端口一项发送流程（同一 Worker 不同端口可并行）；闲置约 60 秒回收，无默认执行期限；`done` 可结算 `unknown` |
| 串口控制 | open/close 需独立 `serial:control` + 端口白名单；close 必须带观察到的 connectionGeneration CAS；参数严格校验、错误 reject、无通用 RPC 隐式截止 |
| 文件对话框 | 旧 `fs.openDialog` / `fs.openDirectoryDialog` / `fs.saveFile` / `ui.panel.export` 每插件同时最多 8 个；新单文件句柄另受每插件 4、全局 32 个句柄限制；均等待用户完成且不把路径交给插件作为长期授权 |
| 插件面板 | 单次 append ≤65536 个 UTF-16 代码单元、约 200 条/s；面板总计 524288 个 UTF-16 代码单元，超限丢最旧文本；不是 UTF-8 字节数 |
| KV | 无键长/值大小/节点数/文件大小上限；值须可无损 JSON 化 |
| 剪贴板 | 读写文本无长度上限；空字符串清空剪贴板 |
| notify | 突发 5 条、每秒补 1 条；积压每插件 20 条、全部插件合计 100 条；标题/正文 256/4096 个 UTF-16 单元（超长截断）；时长 2–30 秒，非有限值归一为 4 秒 |
| log | 单条 msg ≤65536 个 UTF-16 代码单元；突发 20 条、每秒补 4 条，超额丢弃并有节流告警 |
| RX 行观察 | 每批最多 2000 行 / 256 KiB；每端口队列最多 10000 行 / 1 MiB，超限丢最旧 |
| RX 字节观察 | 每批最多 256 KiB、每端口队列最多 1 MiB，超限丢最旧 |
| Worker 背压 | RX 最多 32 个未 ACK 消息 / 1 MiB；控制消息另有独立限额，仍非无限可靠队列 |

监听 rx.dropped 并让用户知道数据不完整；宿主终端仍可接收不代表插件没有缺口。不要依赖插件旁路实现无损采集，不要通过高频 notify/log 记录每个字节。

处理每个可能拒绝的 Promise。初始化（同步执行入口脚本）期间的异常属于启动失败：未达阈值时按「500ms × 当前窗口内失败计数」延迟自动重试，10 秒窗口内累计三次失败后尝试持久化禁用；显式重载会等待新 Worker 就绪，ready 前的失败直接 reject 给重载调用方。**启动完成后的未处理 Promise 拒绝或运行错误只记入诊断日志并限流提示，不终止 Worker**，因此长驻任务失败不会清空你的内存状态；但也不要依赖这一点——失败的操作本身仍需自行重试或提示用户。禁用、重载或升级仍会直接终止 Worker（并取消该插件进行中的 HTTP 请求、退休原生视图），不能依赖退出回调保存数据；应在成功操作时 await storage.set / fs.write。

## 本地调试

1. 保留独立的源目录；从设置安装其副本，安装完成后在弹窗中授予 manifest 声明且宿主支持的全部权限并启用，或选择稍后处理后再逐项授权。先验证输出面板和按钮，再接串口或网络。
2. 修改 main.js 或 manifest 后递增 version，例如 1.0.0 → 1.0.1，再通过安装目录覆盖安装。每次成功升级都会重新弹出权限确认，旧 Worker 会被终止；升级保留 data/。
3. 同版本或降级安装默认被拒绝，随后弹出替换确认（确认框文案说明会使用所选来源的代码、保留插件数据，但生成新的安装版本并重置权限与网页信任）；确认后以 `replaceExisting` 重装，取消则保留原安装。替换会保留 `data/`，但生成新的安装身份；网页数据按安装代次隔离，不复用旧代次，普通授权与网页信任也会重置。只想让已安装代码重新生效时用「重载已安装代码」：它不重新读取来源文件，也不影响安装身份、权限、网页信任或私有数据；重载只对已启用插件可用，会终止旧 Worker、取消进行中的 HTTP 请求并重建视图，新代码同步初始化失败时重载报错。
4. 设置页「刷新」重新取得权威状态，可尝试恢复未运行会话；自动禁用后先定位错误、授权不足或初始化问题，再手动启用。刷新不会重新复制源代码。
5. 用 ui.panel 输出插件可见结果；需要诊断记录时使用 api.log，并在「关于 → 诊断日志」查看/导出。直接 Worker console 输出不等于 api.log 已经写入宿主诊断文件。
6. 源码开发宿主时可用 `npm run tauri dev`，但 Vite 浏览器 + 模拟 IPC 不能证明原生选择器或生产 CSP。插件交付前在实际应用上验证，不以开发环境直连网络成功为依据。

| 现象 | 优先检查 |
|---|---|
| 安装报 manifest 错误 | JSON 语法、必填字段、ID、纯数字版本、apiVersion 主版本、entry 存在且不在 data/ |
| 按钮不显示 | 插件是否启用；ui target 是否 sidebar / port-context；是否在主窗口 |
| `api.ui...` 报错 | op 名必须方括号访问，例如 api['ui.panel.append'] |
| 未授予权限 / 自动禁用 | manifest 声明只是上限；先授权，检查初始化 Promise 是否已处理 |
| 没有 RX 行回调 | terminal:read 授权、真实 RX、TRX 模式；不要用 TX 回显/回放验证 |
| 发送返回 0 | 端口连接状态、portId、严格 HEX 输入；字节成功发送也不等于设备执行业务成功 |
| HTTP 被拒绝 | http:request 授权；若 manifest 显式声明了非空 urlWhitelist，检查初始 URL 与每个重定向目标；代理默认继承系统 |
| 流式结果迟迟没有数据 | `stream` 逐块交付；SSE 需要服务端 flush；提前 break 会取消请求 |
| 改源码后仍在跑旧逻辑 | 用「重载已安装代码」重启已安装副本；要换文件内容则覆盖安装（同版/降级会先弹替换确认）|

遇到事务恢复失败时保留目录和 journal，不要手动删除恢复依据；按[用户插件故障处理](userwiki/插件.md#故障处理)提供诊断信息。

## 打包与升级

推荐 ZIP 内只有一个顶层插件目录，目录名使用 manifest.id：

```text
com.example.hello-1.0.0.zip
└── com.example.hello/
    ├── manifest.json
    ├── main.js
    └── assets/                 # 可选只读资源，不含用户 data/
```

Windows PowerShell 从该目录的父级执行：

```powershell
Compress-Archive -Path .\com.example.hello -DestinationPath .\com.example.hello-1.0.0.zip -Force
```

不要把 ZIP 输出放进插件源目录，不打包 node_modules、构建缓存、秘密或用户 data/。ZIP 名不参与插件身份或版本判断；真正依据是 manifest.id / version。用户用「安装 ZIP…」选择成品，安装完成后按弹窗决定授予权限并启用。

升级保持相同 id 并严格提高 version。选择同版/降级来源时，安装器会先要求明确确认 `replaceExisting`；确认后替换代码及资产并保留旧 `data/`，同时生成新的安装身份、清空授权并重新弹出权限确认；取消则保留原安装。卸载再安装是新身份，私有数据不会自动恢复。配置备份不打包代码/KV，不能用旧备份代替新版授权。

如果持久数据结构随版本变化，插件负责自己的数据迁移：先成功读到旧对象，识别自己的数据格式，再提交迁移结果；读取或迁移失败时保留旧数据并报告，不能把宿主的 installGeneration 当插件数据 schema 版本。

## 插件市场发布与更新

插件市场由宿主读取远程 JSON，不是插件 Worker API。用户在设置中配置一个索引 URL 后，宿主先读取索引，再读取其中的插件描述；两种文档都按不可信输入处理。市场不会自动安装、自动授予权限或替代用户对代码的审阅。

在设置页填写源地址后，点击「同步市场」或「检查更新」会使用当前输入立即检查；检查成功前端通过 field-only revision CAS 保存 `pluginMarketplaceUrl`，不要求先点击普通设置的「保存全部」。

### 索引文件

索引当前使用 `schemaVersion: 1`，`plugins` 是插件描述 JSON 的 URL 数组，最多 256 项：

```json
{
  "schemaVersion": 1,
  "plugins": [
    "https://downloads.example.com/hypercom/com.example.hello.json"
  ]
}
```

索引及每份描述不得超过 1 MiB。URL 必须是 `http` 或 `https`，不能包含用户名、密码或 URL fragment；生产发布建议全程使用 HTTPS。索引 URL 只用于发现元数据，不能把插件代码直接嵌入索引。

HyperCom 官方示例市场源仓库为 [`crafter-z/hypercom-plugin-marketplace`](https://github.com/crafter-z/hypercom-plugin-marketplace)。仓库中的 `index.json` 只维护 metadata 链接；示例插件 ZIP 作为 GitHub Release Asset 发布，metadata 的 `downloadUrl` 固定指向该 Release Asset。

### 发布描述 JSON

每个插件描述包含一个与待下载归档**完全一致**的 `manifest`，以及归档地址。`homepage` 和 `releaseNotes` 可省略，其他未知字段不要添加：

```json
{
  "schemaVersion": 1,
  "manifest": {
    "id": "com.example.hello",
    "name": "Hello HyperCom",
    "version": "1.1.0",
    "description": "在插件面板输出启动信息，并统计按钮点击次数。",
    "apiVersion": "1.0",
    "entry": "main.js",
    "permissions": [],
    "ui": {
      "buttons": [
        {
          "id": "hello",
          "label": "问候",
          "icon": "Play",
          "target": "sidebar"
        }
      ]
    }
  },
  "downloadUrl": "https://downloads.example.com/hypercom/com.example.hello-1.1.0.zip",
  "homepage": "https://example.com/hypercom/hello",
  "releaseNotes": "修复启动提示并改进错误处理。"
}
```

宿主会重新校验描述中的 schema、URL、manifest id/version/API/路径/权限和归档内容；描述中的 manifest 不是对归档 `manifest.json` 的替代。`downloadUrl` 不能带凭据或 fragment，市场服务器不应要求插件权限来读取公开元数据。

### 更新与安装流程

1. 宿主以数字 semver 比较描述版本与已安装版本，更新检查只读；结果通过 `updateAvailable` 标记是否有更高版本，已安装插件带 `currentVersion`，未安装插件省略该字段。检查失败不改变现有安装。
2. 用户打开更新项，核对插件 id、版本、权限、主页、发布说明和下载来源，再明确确认安装。不要把“检查到更新”当作“已安装”。
3. 确认操作绑定 metadata URL、期望 id/version 及当前 `installGeneration`；如果期间插件被替换或描述内容改变，宿主拒绝安装并要求重新检查。
4. 成功市场安装会保留 `data/`，但产生新的安装代次并清除普通权限和可信网页信任；用户必须重新授权后才运行。取消、同版/降级拒绝、网络失败或 manifest/ZIP 校验失败都不替换旧代码。
5. 发布新版本时保持相同 `id` 并提高 `version`，更新索引中的描述 URL 或描述内容；不要复用旧版本 ZIP 地址指向不同代码。安装后配置记录 `source: "marketplace"` 和归档 `updateUrl`（`downloadUrl`），但这些字段不是签名或供应链证明。

发布前至少验证：索引和描述可用 UTF-8 JSON 解析、schemaVersion 为 1、HTTPS 无凭据/fragment、描述 manifest 与 ZIP 完全一致、ZIP 不含 data/ 或秘密、下载地址可重复取得同一版本、权限和 releaseNotes 与实际行为相符。需要强完整性保证时，在 HTTPS 之外提供签名或可信镜像，并在发布渠道记录校验值。

## 交付前自检

- [ ] 从本文两个文件或自己的源包，在干净配置下完成安装 → 授权 → 启用，不依赖本机源码路径和 npm 运行时。
- [ ] 只声明当前已实现且必要的权限；串口与 HTTP 白名单足够窄，说明授权用途。
- [ ] 断开端口、拒绝授权、运行中撤权、取消对话框、网络非 2xx / 截断和暂时 IO 失败有可观察的处理。
- [ ] RX 按批处理，TTY/编码/丢弃通知已考虑；不把旁路当无损日志或 TX 观察器。
- [ ] 所有异步副作用有 await/catch，不在启动时自动发危险命令，不依赖退出回调保存。
- [ ] 从旧版升级成功，KV 保留且插件数据迁移不会因读失败覆盖；新代码重新授权后才能运行。
- [ ] ZIP 结构、entry、纯数字 version、额度与资源路径符合约束，不含 data/、密钥或本地依赖目录。
- [ ] 若发布到插件市场，索引/描述 schemaVersion 为 1，描述 manifest 与 ZIP 一致，URL 无凭据/fragment，并完成 HTTPS 或可信镜像验收。
- [ ] 市场更新只在用户确认后安装；确认后预期会生成新的 installGeneration 并要求重新授权，不把旧权限或可信网页信任当作升级成功条件。
- [ ] 在准备支持的实际应用/平台验证 Worker、文件选择器和生产网络限制；开发浏览器模拟 IPC 的通过不替代原生验收。

现有 RX/旁注/声明式按钮/串口作用域演示见[基础示例插件](../examples/plugin-demo/README.md)，本机命令按钮触发演示见[shell.execute 示例](../examples/plugin-shell-demo/README.md)；宿主磁盘恢复和权限实现见[架构说明](architecture/plugins.md)，应用发行包验证边界见[发布验收](architecture/release.md#自动更新与平台边界)。
