# HyperCom 插件开发指南

面向编写和分发 JavaScript 插件的开发者。本文集中说明可用的 manifest、Worker API、开发流程和交付约束；宿主内部 IPC、授权一致性与磁盘事务实现见[插件架构](architecture/plugins.md)。只想安装插件的用户请看[设置 → 插件](userwiki/设置.md#插件)。

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

- 一个启用的插件对应主窗口中的一个 Web Worker。入口是**单文件普通脚本**，不是 ESM；不能在运行时使用 `import` / `require`，也不直接加载 npm 包。使用 TypeScript 或第三方依赖时，先在自己的构建流程中打包为普通脚本，再把产物作为 entry。
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
2. 新装默认禁用、无授权。本例 `permissions: []`，直接启用即可；其他插件应**先授予初始化所需权限，再启用**。
3. 主窗口出现「插件输出」，包含 `Hello HyperCom ready`；点侧边栏的「问候」，依次出现 `Hello HyperCom #1`、`#2`。
4. 此时计数只在 Worker 内存中。禁用或重启会重置；需要持久化时使用 storage。

安装会把源文件复制到配置目录旁的 `plugins/<id>/`；修改源 main.js 不会热更新已安装插件。后续改动按[本地调试](#本地调试)重新安装。

## manifest 字段

| 字段 | 必填 | 规则 |
|---|---|---|
| `id` | 是 | 稳定的反向域名标识，如 com.example.hello；至少两段，每段非空，只使用小写 ASCII 字母、数字、`-`、`_`。不要在升级时改 id |
| `name` | 是 | 非空显示名 |
| `version` | 是 | 建议固定写三段纯数字 x.y.z；比较按数字元组，不按字符串。当前不支持 `-preview.1`、`+build` 等后缀 |
| `description` | 否 | 设置页显示的说明，建议交代用途和权限原因 |
| `apiVersion` | 是 | 当前写 `"1.0"`；宿主校验主版本为 1，不是最低软件版本字段，也不按次版本自动提供未来能力 |
| `entry` | 是 | 插件内现存普通脚本文件的相对路径，如 main.js 或 dist/main.js；不能是绝对路径、`..` 穿越或 data/ 内文件 |
| `permissions` | 是 | 所需权限字符串数组；可为空，不能含重复或空项。声明不等于用户授权 |
| `serial.portWhitelist` | 否 | serial.send 的精确端口 ID 数组，语义见下一节 |
| `http.urlWhitelist` | 否 | http.request 的 URL 模式数组；缺失或空数组均不允许 HTTP 请求 |
| `ui.buttons` | 否 | 侧边栏按钮数组：`{id, label, icon?, target?}`；target 缺省或 sidebar 才显示 |
| `ui.menuItems` | 否 | 端口菜单数组：`{id, label, target?}`；target 缺省或 port-context 才显示 |
| `ui.views` | 否 | 隔离视图声明，字段和入口见下文；包内 JS/CSS/资产路径受原生边界及额度限制 |
| `requires` | 有视图时必需 | 声明 `isolated-tab-view@1`，workspace-tab 视图另声明 `plugin-workspace-tabs@1`；未知必需能力拒绝 |
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
| `fs:assets` | 读取插件自身包内 UTF-8 资产 |
| `fs:storage` | 读取/写入自身 data/ 文本文件 |
| `fs:open` | 经用户原生选择器读取外部文件为文本 |
| `http:request` | 经宿主 HTTP 转发，仍需通过 http.urlWhitelist |
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

模式匹配规范化后的完整 URL：`*` 匹配不含 `/` 的字符，`**` 可跨 `/`，其他字符按字面匹配，**`?` 是查询分隔符，不是通配符**。建议 scheme/host 写小写，避免白名单中写默认端口或 `..` 路径段。缺 scope / 空数组全拒；请求不会自动跟随重定向，每次请求都要匹配。插件 HTTP 默认直连、不继承系统代理；代理由用户在设置中显式配置，不由插件注入。

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
- 普通宿主 RPC deadline 为 10 秒，HTTP 为 20 秒；Worker 分别留 11/21 秒等待回执。fs.openDialog / ui.panel.export 等待用户，无固定 deadline。
- 超时只是回执失败，不表示已经开始的串口写入、文件写入或 HTTP 已被撤销。避免对可能已成功的副作用盲目重试。

## API 参考

以下均为 **Worker API**。安装、授权管理等原生 Tauri 命令不是插件可用 API；不要复制架构文档中的 invoke 调用。

### 端口与串口

| 调用 | 权限 | 参数与结果 |
|---|---|---|
| `api['ports.list']()` | 无 | 端口摘要数组；成员含 id/name/status/type，可含 mode/baudRate，不暴露完整宿主状态 |
| `api['ports.status']({portId})` | 无 | 单个端口摘要；目标不存在返回 null |
| `api['serial.send']({portId, data, isHex?, lineEnding?})` | serial:send | data 为非空字符串；默认文本、不加行尾；返回 `{bytesWritten}`，0 表示没有发送 |
| `api['terminal.append']({portId, text})` | terminal:write | 非空 text，写 NOTE，不进入 TX 流量或历史；未打开对应终端显示目标时不保留旁注 |

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
| `api['storage.set']({key, value})` | storage | value 必须可 JSON 序列化；undefined 删除此键；按插件串行提交 |
| `api['fs.read']({rel})` | fs:assets 或 fs:storage | 返回 UTF-8 文本；空文件为 `''`，缺文件及其他 IO 错误均 reject；data/ 与包资产分开授权 |
| `api['fs.write']({rel, content})` | fs:storage | rel 只允许 data/ 下相对路径；content 是非空 UTF-8 字符串；覆盖写入，可创建有额度的父目录 |
| `api['fs.openDialog']({multiple?, filters?, title?, encoding?})` | fs:open | 返回 `{files:[{path, content}]}`；取消为空数组。encoding 默认 utf-8，可用 gbk；filters 成员 `{name, extensions: ['txt']}`，扩展名不带点 |
| `api['clipboard.readText']()` | clipboard | 返回剪贴板文本 |
| `api['clipboard.writeText']({text})` | clipboard | 写入非空文本 |

storage 的文件是 data/state.json。只有确认文件不存在才初始化空对象；暂时读失败、非法 JSON、非对象内容都会 reject，不能用空缓存覆盖旧键。不要同时用 fs.write 手工改这个文件和 storage.set 操作 KV，两条路径没有共享 KV 缓存更新契约。配置导出不包含 KV、其他 data/ 或插件代码。

fs.read 不读取任意本机路径，fs.openDialog 返回的是解码文本而不是二进制接口；若需要包内只读 JSON 资源，放 assets/ 并授予 fs:assets。不要把密钥、代理密码或个人数据放进可分发资产。

### 网络与外部链接

| 调用 | 权限 | 参数与结果 |
|---|---|---|
| `api['http.request']({method, url, headers?, body?, timeout?})` | http:request | method/url 非空；body 为文本，timeout 单位秒，默认 10、最大 15；返回 `{status, body, truncated}` |
| `api['shell.openExternal']({url})` | shell:open | 仅 http/https/mailto，交给系统程序；不是本机命令执行 |

HTTP 非 2xx 仍返回响应对象，应检查 status；正文超过 1 MiB 截断并置 truncated，不应将截断 JSON 当完整文档解析。没有 cookies/宿主凭据自动注入，不自动重定向。shell.openExternal 不受 http.urlWhitelist 限制，不要把网络授权与外部链接授权混为一谈。

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

这是新增字段片段，完整包仍需 id/name/version/apiVersion/entry。ui entry 为单个普通脚本 bundle；框架及第三方依赖必须打包进脚本，不加载 CDN 或任意页面。宿主 shell 提供 `#plugin-root`，脚本创建任意本页面 DOM。styles/assets 可省略，默认空数组；需要的静态文件必须明确列入。路径使用普通包内文件，禁止 data/、链接、穿越、URL、宿主保留命名空间和 ADS。

input 为 bytes/lines/none：分别需要 rx:bytes、terminal:read 或无 RX 权限；lines 仅 TRX。portBinding 为 required/optional/none，bytes/lines 必须绑定端口，serial-content 始终使用原标签端口。restoreOnStartup 默认 false；true 恢复描述和布局，不恢复 params、解析残帧或采样历史。

### Worker 会话 API

| 接口 | 行为 |
|---|---|
| `plugin.views.onOpen(cb)` | 收到会话对象，含只读 context、初始 params；异步初始化完成后宿主才将其标为 ready |
| `plugin.views.onClose(cb)` | `{view, reason}`；不等待未完成输入回调才 retire，退出应用仍不保证持久化回调完成 |
| `plugin.views.onMessage(cb)` | `{view, type, payload}`；亦可用会话 view.onMessage(cb) 注册 |
| `view.onInput(cb)` | 固定绑定端口的 bytes/lines 数组批次；每会话串行处理，包括异步回调 |
| `view.onDiscontinuity(cb)` | `{reason, streamEpoch}`；先清解析/流式解码残留，再处理缺口后的批次 |
| `view.onStatus(cb)` | `{instanceId, status, streamEpoch}`；断开/重连不关闭页面 |
| `view.publish(snapshot)` | 当前有界 JSON 模型；合并未发送快照，resolve 不保证每个版本都显示 |
| `view.sendSerial({data,isHex?,lineEnding?})` | 需要 serial:send 及白名单，不接受 portId，由会话固定端口决定；无端口页拒绝 |

context 包含 tabId、placement、boundPortId、portMode、pluginId、installGeneration、viewId、tabSessionId、viewInstanceId、workerEpoch、streamEpoch。tabId 是工作区身份，不是端口号；streamEpoch 只是初始化值，后续连续性以事件为准。实例退休后 publish/sendSerial 拒绝；切焦点不改端口，切分屏不重建模型。

### UI SDK

UI 脚本全局 `view` 与 Worker 会话对象不是同一对象：

- `view.context`：宿主赋值的只读身份，不能自报别的端口或插件。
- `view.onState(cb)`：完整 JSON 模型；回调 Promise 完成后 ACK，失败显示错误，不把“收到”当“已应用”。
- `view.onEnvironment(cb)`：theme/language/fontFamily/fontSize/zoomPercent/visible/focused/portStatus；变化合并，不从父窗读取样式。
- `view.send(type, payload)`：向自身 Worker 发交互，不是宿主 API；返回不表示设备命令已完成。UI 未初始化或参数非法时报错。

UI 不直接 fetch/WebSocket、不创建 frame/Worker、不打开文件或运行 Tauri 命令；需要敏感能力时发交互让 Worker 经已有授权 API 执行。**浏览器真实用户操作的原生复制/剪切是允许的边界例外**，不等于授予 Worker clipboard API 或程序化读剪贴板。

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
- foreground 及 `tabs.activate({tabId,actionToken})` 需要宿主单次动作票据（5 秒）。端口菜单票据限定端口，侧边栏票据仅插件/代次/pane；后台 RX/定时请求不能抢焦点。UI 自报 userGesture 不能产生票据，UI 按钮可请求后台打开。
- `tabs.close({tabId})` 仅自身未固定标签；`tabs.setTitle({tabId,title})` 只改自身纯文本标题，保留宿主来源标识；`tabs.list()` 只返回自身有界摘要。
- 用户关闭后，同键后台重开拒绝；明确用户打开可解除。新建不自动连接串口、不开原始终端、不发送数据；无端口页没有默认发送目标。

### 额度与恢复

替换与独立实例合计每插件最多 8 个、全应用 16 个。UI JS 单文件 8 MiB、声明资产合计 32 MiB，仍受包总限额约束。快照至多 256 KiB UTF-8、只接受 JSON；ArrayBuffer/Map/Set/非有限数/循环对象拒绝。每视图一条在途快照及一个最新候选，全插件待发送至多 1 MiB，可见发送至多约 30/s；隐藏不积压历史，恢复显示重发当前模型。

params 至多 16 KiB；instanceKey/title 至多 128 字符。tabs 管理按令牌桶 2/s、突发 4 限制；UI 交互至多 16 KiB 原生消息包、约 30/s。UI ready 5 秒、Worker 初始化 10 秒；状态 ACK 可见时 5 秒，隐藏/宿主遮挡时不误杀。后台关闭记录每插件最多 128 项，达到后暂停后台新建，用户入口仍受总额度。

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
| 目录 / ZIP 包 | 64 MiB 总解压/复制数据、2000 条、32 层；拒绝穿越/链接 |
| data/ | 单文件 16 MiB、合计 64 MiB、1024 个文件、2000 条目；新增父目录也计入 |
| 普通资产 IO | FIFO 等待磁盘闸门最多 2 秒，超时 reject；拒绝不表示应清空原数据 |
| 原生文件选择 | 单次最多 8 个文件、合计 64 MiB |
| HTTP | 请求 timeout 最大 15 秒；正文最多保留 1 MiB |
| 插件面板 | 524288 个 UTF-16 代码单元，超限丢最旧文本；不是 UTF-8 字节数 |
| notify | 突发 5 条、每秒补 1 条；积压每插件 20 条、全部插件合计 100 条；标题/正文 256/4096 个 UTF-16 单元；时长 2–30 秒，非有限值归一为 4 秒 |
| log | 突发 20 条、每秒补 4 条，超额丢弃并有节流告警 |
| RX 行观察 | 每批最多 2000 行 / 256 KiB；每端口队列最多 10000 行 / 1 MiB，超限丢最旧 |
| RX 字节观察 | 每批最多 256 KiB、每端口队列最多 1 MiB，超限丢最旧 |
| Worker 背压 | RX 最多 32 个未 ACK 消息 / 1 MiB；控制消息另有独立限额，仍非无限可靠队列 |

监听 rx.dropped 并让用户知道数据不完整；宿主终端仍可接收不代表插件没有缺口。不要依赖插件旁路实现无损采集，不要通过高频 notify/log 记录每个字节。

处理每个可能拒绝的 Promise。未处理的 Promise 拒绝和 Worker 异常会触发重启；10 秒窗口内累计三次失败后尝试持久化禁用。禁用、崩溃或升级直接终止 Worker，不能依赖退出回调保存数据；应在成功操作时 await storage.set / fs.write。

## 本地调试

1. 保留独立的源目录；从设置安装其副本，先授权再启用。先验证输出面板和按钮，再接串口或网络。
2. 修改 main.js 或 manifest 后递增 version，例如 1.0.0 → 1.0.1，再通过安装目录覆盖安装。每次成功升级都要重新授权并启用，旧 Worker 会被终止；升级保留 data/。
3. 同版本安装被拒绝不是热重载故障。想以原版本重装可先卸载，但**卸载删除全部私有数据**，不要把它当保数据的调试流程。
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
| HTTP 被拒绝 | http:request 授权及规范化完整 URL 白名单；? 字面、代理、禁止自动重定向 |
| storage 读失败 | 保留错误和原数据；不要把损坏/暂时失败当首次使用覆盖 |
| 改源码后没有变化 | 安装的是副本；提高 version 并重新安装、授权、启用 |

遇到事务恢复失败时保留目录和 journal，不要手动删除恢复依据；按[用户故障处理](userwiki/设置.md#代理与故障处理)提供诊断信息。

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

不要把 ZIP 输出放进插件源目录，不打包 node_modules、构建缓存、秘密或用户 data/。ZIP 名不参与插件身份或版本判断；真正依据是 manifest.id / version。用户用「安装 ZIP…」选择成品，先授权再启用。

升级保持相同 id 并严格提高 version；同版/降级拒绝（旧已安装 manifest 损坏时可走修复安装）。升级替换代码及资产、保留旧 data/，但禁用并清空授权；卸载再安装是新身份，私有数据不会自动恢复。配置备份不打包代码/KV，不能用旧备份代替新版授权。

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
