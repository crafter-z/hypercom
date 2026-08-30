/**
 * HyperCom 串口调试工具 - 全局类型定义
 * 涵盖串口、配置、日志、UI状态等所有核心数据结构
 */

// ==================== 串口相关 ====================

/** 串口连接状态 */
export type PortStatus = 'disconnected' | 'connecting' | 'error' | 'connected';

/** 端口工作模式：trx=传统收发 | tty=终端模式（issue #11） */
export type PortMode = 'trx' | 'tty';

/** 发布通道（issue #12）：stable=正式版 | preview=预览版 */
export type ReleaseChannel = 'stable' | 'preview';

/** 串口类型 */
export type PortType = 'real' | 'virtual' | 'sim';

/** 串口数据结构 */
export interface SerialPort {
  id: string;              // 唯一标识，如 "COM3"
  name: string;            // 显示名称
  alias?: string;          // 用户备注名
  status: PortStatus;
  type: PortType;
  isHidden: boolean;       // 是否被隐藏
  groupId?: string;        // 所属分组ID
  // 连接参数（连接后有效）
  baudRate?: number;
  dataBits?: DataBits;
  parity?: Parity;
  stopBits?: StopBits;
  handshake?: Handshake;
  // 协议解析绑定（可选，绑定后接收数据按协议模板解析字段着色）
  protocolTemplateId?: string;
  // 外部工具是否正在运行（运行期间串口关闭，工具输出显示在终端）
  toolRunning?: boolean;
  // 端口工作模式：trx=传统收发 | tty=终端模式（issue #11）
  mode?: PortMode;
}

/** 数据位 */
export type DataBits = 5 | 6 | 7 | 8;

/** 校验位 */
export type Parity = 'None' | 'Even' | 'Odd' | 'Mark' | 'Space';

/** 停止位 */
export type StopBits = 'One' | 'Two' | 'OnePointFive';

/** 握手协议 */
export type Handshake = 'None' | 'XonXoff' | 'RequestToSend' | 'RequestToSendXonXoff';

/** 换行方式 */
export type LineEnding = '\\r\\n' | '\\r' | '\\n' | 'None';

/** 编码格式 */
export type Encoding = 'ASCII' | 'UTF-8' | 'GBK' | 'ISO-8859-1';

/** 显示格式 */
export type DisplayFormat = 'string' | 'hex' | 'binary';

/** 时间戳格式 */
export type TimestampFormat = 'absolute' | 'relative' | 'uptime';

// ==================== 分组相关 ====================

/** 串口分组 */
export interface PortGroup {
  id: string;
  name: string;
  isExpanded: boolean;
  portIds: string[];       // 组内串口ID列表
  order: number;           // 排序权重
}

// ==================== 标签页相关 ====================

/** 主窗口标签页 */
export interface TabItem {
  id: string;              // 对应串口ID
  title: string;           // 显示标题
  isPinned: boolean;       // 是否固定
  isActive: boolean;       // 是否当前激活
  splitPaneId: string;     // 所属分屏区域ID
  poppedOut?: boolean;     // 终端已 detach 到独立弹出窗（主窗显示占位，关窗回贴）
}

/** 分屏方向 */
export type SplitDirection = 'horizontal' | 'vertical';

/** 分屏叶子节点（承载标签页） */
export interface LeafPane {
  id: string;
  type: 'leaf';
  tabIds: string[];
  size: number;            // 在父分支子节点中的相对占比 (0-1)
}

/** 分屏分支节点（包含子节点，可嵌套） */
export interface BranchPane {
  id: string;
  type: 'branch';
  direction: SplitDirection;
  children: PaneNode[];
  size: number;            // 在父分支子节点中的相对占比 (0-1)
}

/** 分屏树节点（叶子或分支的联合类型） */
export type PaneNode = LeafPane | BranchPane;

// ==================== 终端内容相关 ====================

/** 协议解析字段标注（运行时生成，不持久化） */
export interface ParsedField {
  name: string;            // 字段名: "Header" | "Length" | "Payload" | "Checksum" | "Footer"
  byteStart: number;       // 在行 rawData 中的起始字节偏移
  byteEnd: number;         // 结束字节偏移（不含）
  color: string;           // 字段着色 (hex color)
}

/** 单行终端数据（方案B：行流存储层重构，issue #14） */
export interface TerminalLine {
  timestamp: number;       // 时间戳
  direction: 'RX' | 'TX' | 'TOOL';
  /** 文本内容（TX/TOOL/回放行）。RX 行**省略**——由 `getLineText` 按
   *   rawData + 当前编码惰性解码（省内存：不再冗余存一份解码字符串）。 */
  content?: string;
  /** 原始字节（RX 行必填；HEX 显示 / 编码切换重解码 / 协议解析字段着色）。
   *   issue #6-2：由 number[] 改为 Uint8Array——内存 8 倍削减（number[] 每
   *   元素占 8B 装箱/指针 vs 每字节 1B）。 */
  rawData?: Uint8Array;
  isHex: boolean;          // 是否为HEX显示
  parsedFields?: ParsedField[]; // 协议解析字段标注（存在时按字段着色渲染）
  toolStream?: 'stdout' | 'stderr'; // TOOL 方向行的来源流
}

/** 终端视图状态（方案B：行缓冲移入 TerminalViewportManager 环形缓冲区，issue #14） */
export interface TerminalState {
  scrollLocked: boolean;   // 是否滚动锁定
  showTimestamp: boolean;
  displayFormat: DisplayFormat;
  encoding: Encoding;
  connectedAt: number | null; // 端口连接成功时间戳 (ms)
}

// ==================== 高亮规则相关 ====================

/** 单条高亮规则 */
export interface HighlightRule {
  id: string;
  name: string;
  pattern: string;         // 正则或关键词
  isRegex: boolean;
  color?: string;          // 颜色 (hex)
  bold?: boolean;
  italic?: boolean;
}

/** 高亮规则集 */
export interface HighlightRuleSet {
  id: string;
  name: string;
  rules: HighlightRule[];
  isEnabled: boolean;
}

// ==================== 发送命令相关 ====================

/** 单条发送命令 */
export interface SendCommand {
  id: string;
  name: string;
  order: number;           // 执行顺序
  delay: number;           // 延时 (ms)
  type: 'string' | 'hex';
  content: string;
  appendLineEnding: LineEnding;
}

/** 发送命令规则集 */
export interface SendCommandSet {
  id: string;
  name: string;
  commands: SendCommand[];
  isLoop: boolean;         // 是否循环发送
  loopDelay: number;       // 轮间间隔 (ms)
  repeatCount: number;     // 重复轮数: 0 = 跟随 isLoop, >0 = 发送 N 轮后停止
}

/** 发送历史条目 — 仅内存态（不持久化，关应用即清空），按端口隔离 */
export interface SendHistoryEntry {
  content: string;
  format: 'hex' | 'string';
  lineEnding: LineEnding;
}

/** 外部工具配置：端口号 → 命令行工具的映射（config.json 持久化，不依赖串口存在） */
export interface PortToolConfig {
  id: string;
  name: string;            // 配置名称，如 "STM32 烧录"
  portId: string;          // 端口号，如 "COM5"
  command: string;         // 命令模板，{port} 运行时替换
  workdir: string;         // 工作目录（可选，空串表示默认）
}

/** 串口参数预设（config.json 持久化） */
export interface PortPreset {
  id: string;
  name: string;
  baudRate: number;
  dataBits: number;
  parity: string;
  stopBits: string;
  handshake: string;
  dtr: boolean;
  rts: boolean;
}

// ==================== 协议解析相关 ====================

/** 校验和算法 */
export type ChecksumAlgorithm = 'none' | 'sum8' | 'xor' | 'crc8';

/** 长度字段字节序 */
export type LengthEndian = 'little' | 'big';

/** 协议解析模板（定义帧结构，用于自动解析接收到的串口数据） */
export interface ProtocolTemplate {
  id: string;
  name: string;
  isEnabled: boolean;
  // 帧结构定义
  headerBytes: string;           // 帧头 hex 字符串，如 "AA BB"（空 = 无帧头，从字节 0 开始解析）
  lengthFieldOffset: number;     // 长度字段在帧中的字节偏移（从帧起始计）
  lengthFieldSize: 1 | 2;        // 长度字段字节数
  lengthEndian: LengthEndian;    // 长度字段字节序
  lengthAdjust: number;          // 长度修正值: 实际负载长度 = 原始长度值 - lengthAdjust
  checksumAlgorithm: ChecksumAlgorithm; // 校验和算法
  checksumOffset: number;        // 校验和位置偏移（0 = 自动，置于帧尾之前）
  footerBytes: string;           // 帧尾 hex 字符串，如 "0D 0A"（空 = 无帧尾）
  // 各结构字段着色
  colorHeader: string;
  colorLength: string;
  colorPayload: string;
  colorChecksum: string;
  colorFooter: string;
}

// ==================== 配置相关 ====================

/** 应用程序全局配置 */
export interface AppConfig {
  // 通用设置
  closeBehavior: 'minimize' | 'exit';
  /** 每端口终端最大显示行数，超限逐行覆盖最旧（issue #16 改版，默认 100000） */
  maxDisplayLines: number;
  language: 'zh-CN' | 'en-US';
  theme: 'light' | 'dark' | 'system';
  preventScreenOff: boolean;
  preventSleep: boolean;

  // 自动重连设置
  autoReconnect: boolean;
  maxRetries: number;

  // 字体设置
  terminalFont: string;
  terminalFontSize: number;
  uiFont: string;
  uiFontSize: number;

  // 背景图设置（自定义背景图片，issue #13）：全应用毛玻璃——启用后各面板表面
  // 变为半透明，露出全局背景图（不透明度/模糊度可调）。
  backgroundImage: string;          // 图片绝对路径，'' = 未设置
  backgroundImageEnabled: boolean;  // 是否启用背景图（触发毛玻璃）
  backgroundImageOpacity: number;   // 不透明度 0–100（%）
  backgroundImageBlur: number;      // 模糊度 0–64（px）
  
  // 串口默认设置
  defaultBaudRates: number[];
  defaultLineEnding: LineEnding;
  sendPrefix: string;      // 发送提示前缀，默认空（issue #7-3：终端已有 TX/RX 方向标识）
  showPortType: boolean;   // 显示串口类型
  sendOnEnter: boolean;     // 聚焦发送框时 Enter 是否直接发送
  clearSendInputAfterSend: boolean; // 点击发送后是否清空输入框（issue #13，默认保留）
  quickSendInlineCount: number; // 快捷发送内联条显示条数（0 = 隐藏内联条，纯弹出窗模式）

  // 时间戳设置
  timestampMode: 'perLine' | 'perRound';
  timestampFormat: TimestampFormat;
  
  // 日志设置
  autoSaveLog: boolean;
  logDirectory: string;
  logFilenameFormat: string;  // 默认 "[com]-[datetime]"
  logFormat: DisplayFormat;
  logEncoding: Encoding;
  logSplitEnabled: boolean;
  logSplitSizeMb: number;
  logIncludeTimestamp: boolean; // 日志行前缀是否包含时间戳（issue #3-4）
  logIncludeDirection: boolean; // 日志行前缀是否包含 RX/TX 方向标记（issue #3-4）
  logSubdirMode: LogSubdirMode; // 日志子目录策略：none | date | port（issue #5-10，默认 date）
  logNewFilePerSession: boolean; // 每次打开串口新建日志文件（不续写已有文件）
  
  // 备份设置
  backupEnabled: boolean;
  backupInterval: number;  // 备份周期 (小时)
  backupDirectory: string;

  // 会话恢复
  restoreSession: boolean;   // 启动时是否恢复上次会话

  // 诊断日志
  diagLogEnabled: boolean; // 是否启用应用自身维测日志（前后端统一落盘；wire 名为 diagLogEnabled，issue #5-2 对齐）

  // 自动更新（issue #12）
  updateCheckMode: UpdateCheckMode; // 自动检查更新模式：none | stable | preview

  // 设置实体（全部存入 config.json）
  sendCommandSets: SendCommandSet[];
  highlightRuleSets: HighlightRuleSet[];
  protocolTemplates: ProtocolTemplate[];
  triggerRules: TriggerRule[];
  portPresets: PortPreset[];
  portToolConfigs: PortToolConfig[];
  portGroups: PortGroup[];   // 串口分组布局（issue #2-3 起 config.json 持久化 + 自动保存）
  portMeta: PortMetaEntry[]; // 串口备注名/隐藏状态（issue #4-9 起 config.json 持久化 + 自动保存）
}

/** 日志保存的子目录策略（issue #5-10）。 */
export type LogSubdirMode = 'none' | 'date' | 'port';

/** 自动检查更新模式（issue #12）：none=不检查，stable=定期到正式版，preview=定期到 preview 版。 */
export type UpdateCheckMode = 'none' | 'stable' | 'preview';

/** 更新检查返回（Rust `UpdatePayload`，camelCase wire 对齐）。 */
export interface UpdatePayload {
  version: string;
  currentVersion: string;
  /** unix 秒（RFC3339 pub_date 转来，前端本地化展示） */
  date: number | null;
  /** 更新日志（latest.json 的 notes 字段） */
  notes: string | null;
  /** 本次检查的通道：stable | preview */
  channel: ReleaseChannel;
}

/** `update:progress` 事件载荷（Rust `UpdateProgressPayload`）。 */
export interface UpdateProgressPayload {
  downloaded: number;
  total: number | null;
  phase: 'download' | 'install';
}

/** 快捷发送面板·文本模式的发送参数（面板内本地态，不持久化，issue #5-4-6）。 */
export interface TextSendConfig {
  portId: string;          // 目标串口（空 = 跟随主窗活动标签）
  lineEnding: LineEnding;
  isHex: boolean;
  sendIntervalMs: number;  // 行间发送间隔
  roundIntervalMs: number; // 轮次间循环间隔
}

// ==================== 串口元数据相关 ====================

/** 串口元数据（备注名 / 隐藏状态 / 工作模式，随 config.json 持久化，issue #4-9；模式字段 issue #11） */
export interface PortMetaEntry {
  portId: string;
  alias?: string;
  isHidden: boolean;
  mode?: PortMode;
}

// ==================== 日志相关 ====================

/** 日志文件信息 */
export interface LogFileInfo {
  path: string;
  portId: string;
  createdAt: number;
  size: number;
}

// ==================== 系统状态相关 ====================

/** 系统资源状态 */
export interface SystemStatus {
  status: string;          // 运行状态文本
  memoryUsedMb: number;
  cpuUsage: number;        // CPU占用率 (%)
}

/** 串口流量统计 */
export interface TrafficStats {
  portId: string;
  txTotal: number;         // 发送总字节
  rxTotal: number;         // 接收总字节
}

// ==================== UI 状态相关 ====================

/** 应用全局UI状态 */
export interface UIState {
  isConfigOpen: boolean;   // 配置弹窗是否打开
  configActiveTab: string; // 配置弹窗当前激活的Tab
  sidebarWidth: number;    // 左侧边栏宽度 (px)
  operationPanelHeight: number; // 操作区高度 (px)
  isOperationPanelCollapsed: boolean;
  isHotkeyHelpOpen: boolean; // 快捷键帮助弹窗是否打开
  isAboutOpen: boolean;    // 关于对话框是否打开
  sidebarCollapsed: boolean; // 左侧边栏是否折叠（仅本次会话有效，不进入重启快照）
  // 更新弹窗（issue #12）：isUpdateOpen + 待展示的更新载荷（null = 仅提示无更新）
  isUpdateOpen: boolean;
  updateCandidate: UpdatePayload | null;
  // config.json 加载完成信号（issue #12 复审）：useConfigPersistence.loadConfig
  // 结束（成功/失败同）置 true；useAutoUpdate 等它就绪再评估，替代 3s 启发式窗口。
  configReady: boolean;
}

// ==================== Tauri 命令参数/返回类型 ====================

/** 打开串口参数 */
export interface OpenPortParams {
  portId: string;
  baudRate: number;
  dataBits: DataBits;
  parity: Parity;
  stopBits: StopBits;
  handshake: Handshake;
  dtr: boolean;
  rts: boolean;
  ignoreEmptyChars: boolean;
}

/** 发送数据参数 */
export interface SendDataParams {
  portId: string;
  data: string;
  isHex: boolean;
  appendLineEnding: LineEnding;
}

/** 后端返回的可用串口列表项 */
export interface AvailablePortInfo {
  id: string;
  name: string;
  type: PortType; // "real" | "virtual" | "sim"
}

// ==================== 条件触发相关 ====================

/** 条件触发器匹配方式 */
export type TriggerMatchType = 'contains' | 'exact' | 'regex' | 'hex';

/** 条件触发器动作类型 */
export type TriggerActionType = 'alert' | 'respond';

/** 条件触发规则 */
export interface TriggerRule {
  id: string;
  name: string;
  pattern: string;
  isRegex: boolean;
  matchType: TriggerMatchType;
  actionType: TriggerActionType;
  actionContent: string;
  actionIsHex: boolean;
  isEnabled: boolean;
  /** 仅对该串口生效；空/缺省 = 全部端口（issue #3-1） */
  portId?: string;
}
