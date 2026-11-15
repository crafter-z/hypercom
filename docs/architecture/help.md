# Help Center 架构

Help Center 是只读的本地 UserWiki 浏览器。它把 `docs/userwiki/` 在构建阶段编译成受限的文档模型，再由主窗口通过弹出窗服务打开一个单例 native webview。帮助内容不读取任意文件、不执行 HTML，也不把帮助状态写入串口工作区。

## 边界与数据流

```text
docs/userwiki/*.md + images/*
        │
        ▼
scripts/build-help.mjs
  Markdown/GFM token → closed HelpBlock/HelpInline model
  link/image/anchor/locale validation
        │
        ▼
src/utils/help/generated.json (checked-in build artifact)
        │
        ├─ src/utils/help/index.ts       helpManifest / helpCatalog / searchHelp
        ├─ src/utils/help/HelpDocument.tsx  closed React renderer
        └─ src/components/Help/HelpCenter.tsx
                                      │
main window ─ openHelpCenter ─ popoutService.openHelp
                                      │
                                      ▼
        Rust open_popout(kind="help") ── singleton WebView label "help"
                                      │
                                      ▼
        ?popout=help&article=<id>&anchor=<heading>
```

主窗口只记录 `UIState.isHelpOpen` 与 `UIState.helpArticleId`，帮助弹窗拥有独立的 React/Zustand 实例。打开另一个文章不会再创建窗口：`src/services/popout.ts` 的 `popoutService.openHelp` 复用 help lane，Rust `open_popout` 在已有窗口上发送 `help:open`，HelpCenter 通过 `popoutEventService.onHelpOpen` 更新文章和历史。

## 内容管线

`scripts/build-help.mjs` 的 `ARTICLE_SOURCES` 是稳定 ID 与源文件的唯一映射，当前 ID 为 `home`、`quick-start`、`ports`、`terminal`、`transmission`、`logging`、`timeline`、`rules`、`tools`、`settings`、`plugins`、`shortcuts`。编译器执行以下检查：

- 每篇文章必须以 H1 开始；标题 slug 稳定化并对重复标题追加后缀。
- 内部 Markdown 链接必须解析到已登记文章及存在的 heading anchor；允许的作者/架构文档链接被转换为固定 GitHub URL；未知页面、错误编码、遍历和不安全协议被拒绝。
- 图片只能引用 `docs/userwiki/images/` 中枚举的普通仓库文件，文件名匹配安全扩展名；符号链接、缺失文件和任意 URL 不进入产物。
- Markdown 被降低为 `HelpBlock`/`HelpInline`，不保留可执行 raw HTML。搜索文本由同一模型生成，避免搜索索引与显示内容漂移。
- 产物固定为 `src/utils/help/generated.json`，携带版本、`zh-CN` locale、home ID、文章模型和 source digest。`src/utils/help/index.ts` 仅从这个本地产物读取；`loadHelpArticle` 不发起网络或 IPC 请求。

构建和校验入口在 `package.json`：

- `npm run help:build`：从 UserWiki 重建 `generated.json`。
- `npm run help:check`：在不修改工作树的情况下验证提交的产物是最新的。
- `npm run test:help`：运行 `scripts/build-help.test.mjs` 的编译器/安全测试，以及 `src/utils/help` 的运行时 catalog/renderer 测试。
- `npm run build`、`npm run dev` 在前端构建/开发服务前先运行 `help:build`。

## React 渲染与导航

`src/utils/help/HelpDocument.tsx` 只渲染闭合文档模型：文本、代码、强调、列表、表格、引用、标题、已校验的内部链接和本地图片。原始 HTML 作为文本显示；外部链接再次通过协议白名单检查并交给 HelpCenter 的外部链接事件，不直接调用任意宿主能力。

`src/components/Help/HelpCenter.tsx` 负责展示层状态：

- 左侧目录、home/文章切换、面包屑和页面目录（TOC）；
- 编译 catalog 的全文搜索、结果摘要和文章跳转；
- 前进/后退历史、深链接文章/anchor、`Ctrl/Cmd+F`、`/` 和 `Alt+Arrow` 快捷键；
- heading anchor 的焦点与滚动；
- `help:open` 事件到达时更新当前文章，不修改主窗口串口标签或配置。

标题栏、空端口 GuideCard 和快捷键 F1 入口统一调用 `src/utils/help/helpNavigation.ts` 的 `openHelpCenter`。该 helper 先记录 UI 意图，再调用 `popoutService.openHelp`；旧测试替身没有该方法时，使用 `openPopout('help')` 兼容路径。

## Native popout 契约

`src-tauri/src/commands/popout.rs` 是 label、URL 和安全参数的权威实现：

- `help` 是固定单例 label；article/anchor 不参与 label 计算。
- 首次创建使用 `popout=help`、可选 `article` 和 `anchor` 查询，并使用 Help 默认尺寸/标题。
- 已存在窗口只 `show`/`set_focus` 并发送 `help:open`；关闭和置顶仍沿用统一 popout 命令。
- article ID 与 anchor 经过长度、控制字符、分隔符和路径遍历检查；前端不复制 Rust 的 label 净化规则。
- `src-tauri/capabilities/help.json` 只授予 Help 所需的窗口关闭、拖动、置顶、标题、事件和缩放权限；Help read-only 页面不加载编辑器关闭守卫或剪贴板菜单。

## 质量门与验证边界

`.github/workflows/ci.yml` 在依赖安装后运行 `npm run help:check` 与 `npm run test:help`，然后继续应用 TypeScript、Vitest、release-test 和 production build。Help 专用行为测试位于 `src/components/HelpCenter/`：

- `HelpCenter.help.test.tsx` 覆盖深链接、目录历史、搜索结果和安全内部链接导航；
- `HelpNavigation.help.test.ts` 覆盖 UI 意图、singleton open/anchor 传递、旧替身兼容和关闭状态；
- `HelpManifest.help.test.ts` 覆盖稳定文章 ID、locale、source path、内部 anchor、外部协议和已打包图片。

`src/utils/help/help.test.tsx` 与 `scripts/build-help.test.mjs` 负责内容编译和 renderer 的底层契约，Rust popout 测试负责窗口 label、URL、权限及拒绝不安全目标。自动化检查不替代最终安装包上 Windows/WebView2 的窗口层级、焦点、缩放、外部打开策略验收。

## 相关文件

| 文件 | 责任 |
|---|---|
| `scripts/build-help.mjs` / `scripts/build-help.test.mjs` | UserWiki 编译、资源校验与安全测试 |
| `src/types/help.ts` | Help manifest、文档节点、链接和搜索结果类型 |
| `src/utils/help/index.ts` | 本地 catalog、按 ID 加载、搜索和链接解析 |
| `src/utils/help/HelpDocument.tsx` | HTML-free React 文档渲染 |
| `src/components/Help/HelpCenter.tsx` | 目录、文章、搜索、TOC 和历史 |
| `src/utils/help/helpNavigation.ts` | 主窗口到 Help singleton 的入口 |
| `src/services/popout.ts` | Help lane 与 `help:open` 事件服务 |
| `src-tauri/src/commands/popout.rs` | native Help 窗口、URL、label 和安全参数 |
| `src-tauri/capabilities/help.json` | Help webview 最小权限 |
| `.github/workflows/ci.yml` | Help build/manifest/test quality gate |
