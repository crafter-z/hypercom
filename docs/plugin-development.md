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
- [交付前自检](#交付前自检)

## 运行模型

- 有根 Worker 的启用插件对应主窗口中的一个 Web Worker；纯网页插件没有 Worker（见[可信网页模式](#可信网页模式windows)）。入口是**单文件普通脚本**，不是 ESM；不能在运行时使用 `import` / `require`，也不直接加载 npm 包。使用 TypeScript 或第三方依赖时，先在自己的构建流程中打包为普通脚本，再把产物作为 entry。生产与开发 CSP 已允许 Worker 内的 WebAssembly 编译/实例化；插件仍需自行把 `.wasm` 作为包内资产，通过 `fs.read({format:'binary'})` 加载，并处理 RX 丢包/gap。
- 每次安装、升级或用户确认替换都会生成新的安装身份（`installGeneration`）并重置授权（含可信网页信任）；旧身份下排队或迟到的操作会被拒绝，Worker 内存状态也不跨安装身份保留。
- 宿主注入 Worker 的 `self.plugin`。Worker 无 DOM、window、Tauri invoke 或 localStorage；不要操作宿主 React/store，不要覆盖桥使用的 self.onmessage/self.plugin。
- 可声明侧边栏按钮、端口菜单、文本面板及隔离视图。隔离 UI 有自己的 DOM 和浏览器上下文，可以使用打包后的 React/Vue/普通 JS，但不访问主窗 DOM 或 Tauri 通用接口。Windows 原生承载已实现，其他平台在隔离策略验收前明确拒绝；桌面弹出窗不运行插件。
- 出站 HTTP 使用 `http.request`，不要直接调用 `fetch` / WebSocket；生产 CSP 不允许任意直接网络连接。读取用户文件使用原生 `fs.openDialog`，不接受任意本机路径。
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
2. 安装完成后宿主会弹出权限确认。用户可以一次性授予 manifest 声明且宿主支持的全部权限并启用插件，也可以稍后在插件设置中逐项授权；取消确认会保留插件但不运行。
3. 主窗口出现「插件输出」，包含 `Hello HyperCom ready`；点侧边栏的「问候」，依次出现 `Hello HyperCom #1`、`#2`。
4. 此时计数只在 Worker 内存中。禁用或重启会重置；需要持久化时使用 storage。

安装会把源文件复制到配置目录旁的 `plugins/<id>/`；修改源 main.js 不会热更新已安装插件。后续改动按[本地调试](#本地调试)重新安装。

## manifest 字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | 是 | 稳定的反向域名标识，如 com.example.hello；至少两段，每段非空，只使用小写 ASCII 字母、数字、`-`、`_`。不要在升级时改 id |
| `name` | 是 | 非空显示名 |
| `version` | 是 | 写 `x`、`x.y` 或 `x.y.z` 纯数字（缺省段按 0）；比较按数字元组，不按字符串。当前不支持 `-preview.1`、`+build` 等后缀或第四段 |
| `description` | 否 | 设置页显示的说明，建议交代用途和权限原因 |
| `apiVersion` | 是 | 当前写 `"1.0"`；宿主校验主版本为 1，不是最低软件版本字段，也不按次版本自动提供未来能力 |
| `entry` | 纯网页插件可省 | 插件内现存普通脚本文件的相对路径，如 main.js 或 dist/main.js；不能是绝对路径、`..` 穿越或 data/ 内文件。省略表示没有根 Worker：此时 `ui.views` 必须非空且**全部**为 `trusted-web` + `input:"none"` 视图，并不得声明 Worker 专用的 `ui.buttons`/`ui.menuItems` |
| `permissions` | 是 | 所需权限字符串数组；可为空，不能含重复或空项。声明不等于用户授权；可以声明宿主尚未实现的权限，但安装时只能授予当前已支持的能力 |
| `serial.portWhitelist` | 否 | serial.send 的精确端口 ID 数组，语义见下一节 |
| `http.urlWhitelist` | 否 | 可选的 HTTP URL 作用域：缺失或空数组表示不限制；非空时初始 URL 与每个重定向目标都必须匹配 |
| `ui.buttons` | 否 | 侧边栏按钮数组：`{id, label, icon?, target?}`；target 缺省或 sidebar 才显示 |
| `ui.menuItems` | 否 | 端口菜单数组：`{id, label, target?}`；target 缺省或 port-context 才显示 |
| `ui.views` | 否 | 视图声明；`mode` 缺省为 `isolated`，显式 `trusted-web` 加载包内 HTML 文档；`worker:false` 表示该可信页不依附 Worker（仅允许 `input:"none"`），见下文 |
| `requires` | 有视图时必需 | 每个 `ui.views` 项必须声明对应能力：隔离视图 `isolated-tab-view@1`、可信网页 `trusted-web-view@1`；声明 workspace-tab 放置时另需 `plugin-workspace-tabs@1`。未知或重复能力拒绝 |
| `shell.executableWhitelist` | 否 | 保留字段；当前没有 shell.execute，不能靠此字段运行本机程序，也不约束 shell.openExternal |

按钮与菜单 id 应在插件内唯一，并在代码中按 buttonId 分派；label 由插件作者负责语言，不经过宿主翻译。支持的 icon 名见 `src/components/Sidebar/pluginIcon.tsx`；未识别的名称使用默认插头图标，入门示例使用已支持的 Play。

manifest 不能超过 1 MiB；包内路径统一使用 `/`。包不应包含符号链接、设备文件、Windows ADS/尾点/尾空格别名或用户私有数据。安装包中的 data/ 不会作为初始用户数据导入；需要默认资源时放 assets/，由代码决定如何初始化。

## 权限与作用域

| 权限 | 开放能力 |
|---|---|
| `terminal:read` | 订阅 TRX 的 rx.line |
| `rx:bytes` | 订阅包括 TTY 在内的原始 RX 块 |
| `terminal:write` | 在已打开 TRX 终端写 NOTE 旁注，不发送串口数据 |
| `serial:send` | 向已连接端口发送，仍需通过 serial.portWhitelist |
| `fs:assets` | 读取插件自身包内文件，可返回文本或原始二进制 |
| `fs:storage` | 读取自身 data/ 文件（文本/二进制）及写入文本或原始字节 |
| `fs:open` | 经用户原生选择器读取外部文件（文本/二进制） |
| `http:request` | 经宿主发起完整 HTTP（文本/二进制/流式/重定向/取消）；可选 urlWhitelist 收紧 |
| `shell:open` | 在系统默认程序打开 http/https/mailto URL；不是执行 shell |
| `clipboard` | 读/写剪贴板文本 |
| `notify` | 发出受限的非粘滞通知 |
| `storage` | 通过 get/set 访问专属 JSON KV；只覆盖 data/state.json，不等于整个 data/ 的文件权限 |
| `ui:view` | 显示声明的隔离页面、发布 JSON 模型及接收本页面交互，不隐含其他权限 |
| `ui:tabs` | Worker 打开/激活/关闭/改标题/列出自身独立标签；不能管理其他插件或原始串口标签 |

`ports.list`、`ports.status`、log 和自身 ui.panel 操作无需声明额外权限，但插件必须已启用。授权在调用时检查；运行中撤权后，旧 API 引用也不能继续使用该能力。RX 事件同样受当前读取权限控制。

### 串口作用域

在已有 manifest 中声明以下字段时，同时把 serial:send 加入 permissions，并让用户授予它：

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
- 宿主对普通 RPC 的回执期限为 10 秒，Worker 侧留 11 秒等待回执；超时只让该次调用 reject。以下调用等待真实完成、用户或网络，不设 RPC 期限：`fs.read`、`fs.write`、`storage.set`、`fs.openDialog`、`ui.panel.export` 与全部 `http.*`。`view.sendBinary` 另有 10 分钟传输 RPC 资源期限与逐块 30 秒 ACK 期限。HTTP 的业务期限仍只由请求的 `timeout` 决定；未消费的 stream 会在闲置 60 秒后回收，正在进行的 `read` 不计闲置。
- 超时只是回执失败，不表示已经开始的串口写入、文件写入或 HTTP 已被撤销。避免对可能已成功的副作用盲目重试。

## API 参考

以下均为 **Worker API**。安装、授权管理等原生 Tauri 命令不是插件可用 API；不要复制架构文档中的 invoke 调用。

### 端口与串口

| 调用 | 权限 | 参数与结果 |
|---|---|---|
| `api['ports.list']()` | 无 | 端口摘要数组；成员含 id/name/status/type，可含 mode/baudRate，不暴露完整宿主状态 |
| `api['ports.status']({portId})` | 无 | 单个端口摘要；目标不存在返回 null |
| `api['serial.send']({portId, data, isHex?, lineEnding?})` | serial:send | data 为非空字符串（≤1048576 个 UTF-16 代码单元）；默认文本、不加行尾；返回 `{bytesWritten}`，0 表示没有发送 |
| `api['terminal.append']({portId, text})` | terminal:write | 非空 text（单次 ≤65536 个 UTF-16 代码单元），写 NOTE，不进入 TX 流量或历史；未打开对应终端显示目标时不保留旁注 |

serial.send 的 HEX 使用偶数个十六进制字符，可含空白，不自动补零。行尾值是字面量反斜杠表示：JavaScript 源码写 `lineEnding: '\\r\\n'`、`'\\r'`、`'\\n'` 或 `'None'`，不要写成真实换行字符串 `lineEnding: '\r\n'`。TTY 无本地 TX 回显，终端行旁注不是 TTY 画面注入接口。

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
| `api['clipboard.readText']()` | clipboard | 返回剪贴板文本 |
| `api['clipboard.writeText']({text})` | clipboard | 写入文本；空字符串表示清空剪贴板 |

storage 的文件是 data/state.json。只有确认文件不存在才初始化空对象；暂时读失败、非法 JSON、非对象内容都会 reject，不能用空缓存覆盖旧键。键只要求非空字符串；值必须是可无损 JSON 化的数据——除顶层 `undefined`（删除键）外，拒绝函数、嵌套 `undefined`、NaN/Infinity、Map/Set/Date/类型化数组、getter、可调用的 `toJSON`、稀疏数组与循环引用，但**不设键长、值大小、节点数或文件大小上限**。不要同时用 fs.write 手工改这个文件和 storage.set 操作 KV，两条路径没有共享 KV 缓存更新契约。配置导出不包含 KV、其他 data/ 或插件代码。

**读写都不设文件格式、内容、大小、总量或选择数量上限，所有插件一致，不要求可信网页模式。** `fs.read` 仍只访问已授权插件目录，`fs.openDialog` 只读取用户选择的路径，`fs.write` 只写 data/；二进制保留全部字节，不经过文本解码。文本解码可能替换非法字节，要求无损时必须使用 binary。接口一次性读取并返回整个文件，实际可处理大小受可用内存及 JS/浏览器运行时约束，并非流式接口。安装包与网页声明资源的限额仍属于安装/视图加载，不限制此处的数据读取或私有写入。

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

仅 http/https URL；响应体与请求体不设宿主业务大小上限；非 2xx 仍返回响应对象，应检查 status。非法 URL/header/method、`body` 与 `bodyBase64` 同时提供都会在发网前 reject；并发上限为每插件 64、全应用 64。`signal` 取消与超时会让进行中的调用 reject（AbortError 或超时错误）；`stream.cancel()` 与提前 break 会取消原生请求并终止迭代，挂起的 `next()` 以 AbortError reject。取消后不要假定已产生的服务端副作用被撤销。不自动注入 cookies、Referer 或宿主凭据；跨源重定向仅保留 Accept/Accept-Language/Content-Language/Content-Type/Content-Encoding/Range 等明确安全头，Authorization、Cookie 和任意未知自定义凭据头不随跳转发送；需要认证时请直接请求最终源。同源保留合法业务头，Host/Content-Length/Transfer-Encoding 等框架头拒绝。URL 最多 8192 字符，headers 最多 64 个、名字 256/值 8192 字符（这是通道结构保护，不是 body 业务配额）；错误日志去除 URL userinfo/query/fragment。默认继承系统代理，宿主显式配置的插件代理优先。`http.urlWhitelist` 仍是**可选**作用域：缺失或空数组表示不限制，非空时初始 URL 与每个重定向目标都要匹配；需要收紧时才声明。`shell.openExternal` 不受 `http.urlWhitelist` 限制。

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

当前**没有** ports.onChange、rx.getBuffer、fs.list、shell.execute、自定义 events.on/emit、插件市场或远程调试协议。声明未来权限不能使这些接口可用。

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

- 完整插件通常保留普通 Worker `entry`；纯网页插件可以**完全省略插件根 `entry`**，此时宿主不创建根 Worker，页面独立运行（视图自身的 `entry` 仍必填）。给视图加 `"worker": false` 表示该可信页不依附 Worker：只允许 `trusted-web` + `input:"none"`，没有 Worker 侧会话对象、不接收 RX，也不能发布模型或发送串口；但它不会阻止根 Worker 启动——若 manifest 仍声明 `entry`，根 Worker 照常运行并可供其他视图使用。纯网页或 `worker:false` 页面没有 Worker 对端，`view.send` / `view.sendBinary` 会报错。HTML 无需主动调用 SDK 即可显示。
- 同源本地页面之间可以正常导航与刷新（路径、查询串、锚点均可），其他声明的 HTML 页面放进 `assets`；除纯锚点变化外，导航/刷新生成新文档，宿主重建 SDK 身份、重放当前模型并拒绝旧文档迟到的 ACK/消息/二进制块；纯锚点后再刷新仍会生成新身份。只有用户**真实点击**的外部 http/https 链接或新窗口才交给系统浏览器，不获得 SDK；脚本发起的顶层跳转只取消、不弹浏览器；其他协议拒绝。在起始时直接拒绝的外部跳转不退休页面；已准许的本地导航后来被取消则明确报错并退休，避免旧文档身份已失效却永久 loading。若链接指向声明过的本地 HTML，则按本地导航处理。
- 视图自身 `entry` 必须是 `.html` / `.htm`，`styles` 必须为空；HTML 自己引用 CSS/JS，包内文件列入 `assets`。支持内联脚本、模块脚本及资源查询参数；未声明的本地文件不回退到网络。
- 浏览器直接支持 HTTP/HTTPS、WebSocket、SSE、普通网页资源、文件选择器、Blob 下载、剪贴板和 localStorage/IndexedDB；无需为这些网页操作另授 Worker 的 `http:request` / `fs:open` / `clipboard` / `storage` 权限。Worker API 的原权限规则不变。
- 网络不使用宿主端点白名单，也不使用 Worker 代理设置。浏览器 CORS、TLS 和混合内容规则仍生效；模型服务不支持跨域时，应配置服务 CORS 或使用本地桥接，不关闭浏览器安全检查。
- 文件读取通过 `<input type="file">` 及 File API；下载需确认原生保存对话框，不自动执行下载文件。剪贴板遵循浏览器焦点与用户操作要求。摄像头、麦克风等无关权限不开放。
- 宿主在文档脚本前注入现有 `view` SDK，不修改 HTML；本地顶层页面获得 SDK，iframe 不获得。页面普通资源/请求错误不会导致插件视图退休；原生进程崩溃、文档加载失败或已准许导航取消会报告失败。可信文档加载期间不设固定期限，但成功加载后 30 秒仍未 ready 会报错；隔离页面仍适用 5 秒初始化期限。
- 可信模式默认拒绝，安装/首次启用须独立确认；普通「授予全部并启用」不授予网页信任。批准绑定安装代次，升级重新确认，重启不重复询问；配置导入不能新增或恢复已撤销的网页信任。
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
- `view.send(type, payload)`：向自身 Worker 发交互，不是宿主 API；返回不表示设备命令已完成。UI 未初始化或参数非法时报错。
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

替换与独立实例合计每插件最多 8 个、全应用 16 个。每个视图声明的 entry/styles/assets 单文件至多 8 MiB、合计至多 32 MiB，仍受包总限额约束。快照至多 256 KiB UTF-8、只接受 JSON（另限 65536 个节点、嵌套 64 层）；ArrayBuffer/类型化数组/Map/Set/Date、非有限数、getter、稀疏或循环对象拒绝。每视图一条在途快照及一个最新候选，全插件待发送至多 1 MiB，可见发送至多约 30/s；隐藏不积压历史，恢复显示重发当前模型。

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

宿主向 Worker 转移字节缓冲区，避免再次复制大文件。可信网页本身仍可用 `File.arrayBuffer()` / `File.stream()` 或 `fetch(...).arrayBuffer()` 读取，和 Worker API 的返回格式独立。

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
| 目录 / ZIP 包 | 64 MiB 总解压/复制数据、2000 条、32 层；拒绝穿越/链接/特殊文件/硬链接；目录根与祖先也须为真实非链接路径，macOS可选`/private/...`规范路径而非`/var`/`/tmp`别名 |
| ZIP元数据 | 压缩文件96MiB、中央目录16MiB、单条名称/extra/comment合计64KiB；实体记录≤2000且不得重复，支持限额内ZIP64 |
| data/ 写入 | 不设单文件/总量/文件数上限；路径与原子写约束保留；每次写入不再扫描整个 data/ |
| 插件文件读取 | 不限制扩展名/内容/大小/总量/多选数量，无固定读取期限；保留权限与路径范围，完整读取所需内存由运行环境决定 |
| 插件文件写入 IO | 闸门准入等待最多 5 秒，繁忙时可重试；已经开始的写入不设隐式业务期限，真实完成后才返回 |
| 串口与终端写入 | `serial.send` 单次 data ≤1048576 个 UTF-16 代码单元；`view.sendSerial` 单次 data ≤65536 个；`terminal.append` 单次 text ≤65536 个 |
| HTTP | 仅 http/https；无宿主业务大小上限、无固定 timeout；`timeout` 为调用显式给出的非负有限秒数（0/缺省=不设总期限），重定向默认最多 10 跳；并发上限每插件 64、全应用 64 |
| 文件对话框 | `fs.openDialog` / `ui.panel.export` 每插件同时最多 8 个；无选择数量/内容上限，等待用户完成 |
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
3. 同版本或降级安装默认被拒绝，随后弹出替换确认（确认框文案说明会使用所选来源的代码、保留插件数据，但生成新的安装版本并重置权限与网页信任）；确认后以 `replaceExisting` 重装，取消则保留原安装。替换会保留 `data/`（网页数据目录也不受安装影响），但生成新的安装身份并重置普通授权与网页信任。只想让已安装代码重新生效时用「重载已安装代码」：它不重新读取来源文件，也不影响安装身份、权限、网页信任或私有数据；重载只对已启用插件可用，会终止旧 Worker、取消进行中的 HTTP 请求并重建视图，新代码同步初始化失败时重载报错。
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

升级保持相同 id 并严格提高 version；同版/降级拒绝（旧已安装 manifest 损坏时可走修复安装）。升级替换代码及资产、保留旧 data/，但清空授权并重新弹出权限确认；卸载再安装是新身份，私有数据不会自动恢复。配置备份不打包代码/KV，不能用旧备份代替新版授权。

如果持久数据结构随版本变化，插件负责自己的数据迁移：先成功读到旧对象，识别自己的数据格式，再提交迁移结果；读取或迁移失败时保留旧数据并报告，不能把宿主的 installGeneration 当插件数据 schema 版本。

## 交付前自检

- [ ] 从本文两个文件或自己的源包，在干净配置下完成安装 → 授权 → 启用，不依赖本机源码路径和 npm 运行时。
- [ ] 只声明当前已实现且必要的权限；串口与 HTTP 白名单足够窄，说明授权用途。
- [ ] 断开端口、拒绝授权、运行中撤权、取消对话框、网络非 2xx / 截断和暂时 IO 失败有可观察的处理。
- [ ] RX 按批处理，TTY/编码/丢弃通知已考虑；不把旁路当无损日志或 TX 观察器。
- [ ] 所有异步副作用有 await/catch，不在启动时自动发危险命令，不依赖退出回调保存。
- [ ] 从旧版升级成功，KV 保留且插件数据迁移不会因读失败覆盖；新代码重新授权后才能运行。
- [ ] ZIP 结构、entry、纯数字 version、额度与资源路径符合约束，不含 data/、密钥或本地依赖目录。
- [ ] 在准备支持的实际应用/平台验证 Worker、文件选择器和生产网络限制；开发浏览器模拟 IPC 的通过不替代原生验收。

现有 RX/旁注/声明式按钮/白名单演示见[示例插件](../examples/plugin-demo/README.md)；宿主磁盘恢复和权限实现见[架构说明](architecture/plugins.md)，应用发行包验证边界见[发布验收](architecture/release.md#插件发版验收门)。
