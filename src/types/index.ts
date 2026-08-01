/**
 * HyperCom 串口调试工具 - 全局类型定义
 * 涵盖串口、配置、日志、UI状态等所有核心数据结构
 */

// ==================== 串口相关 ====================

/** 串口连接状态 */
export type PortStatus = 'disconnected' | 'connecting' | 'error' | 'connected';

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

/** 单行终端数据 */
export interface TerminalLine {
  id: string;
  timestamp: number;       // 时间戳
  direction: 'RX' | 'TX' | 'TOOL';
  content: string;         // 原始内容（文本格式）
  displayContent?: string; // 格式化后的显示内容（带高亮）
  rawData?: number[];      // 原始字节数组（用于 HEX 显示）
  isHex: boolean;          // 是否为HEX显示
  parsedFields?: ParsedField[]; // 协议解析字段标注（存在时按字段着色渲染）
  toolStream?: 'stdout' | 'stderr'; // TOOL 方向行的来源流
}

/** 终端视图状态 */
export interface TerminalState {
  lines: TerminalLine[];
  maxLines: number;        // 最大保留行数
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
  loopDelay: number;       // 循环间隔
}

/** 发送历史条目 — 仅内存态（不持久化，关应用即清空），按端口隔离 */
export interface SendHistoryEntry {
  content: string;
  format: 'hex' | 'string';
  lineEnding: LineEnding;
}

/** 外部工具配置：端口号 → 命令行工具的映射（SQLite 持久化，不依赖串口存在） */
export interface PortToolConfig {
  id: string;
  name: string;            // 配置名称，如 "STM32 烧录"
  portId: string;          // 端口号，如 "COM5"
  command: string;         // 命令模板，{port} 运行时替换
  workdir: string;         // 工作目录（可选，空串表示默认）
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
  memoryLimitMb: number;
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
  backgroundImage?: string;
  
  // 串口默认设置
  defaultBaudRates: number[];
  defaultLineEnding: LineEnding;
  sendPrefix: string;      // 发送提示前缀，默认 ">>>>>>SEND>>>>>>>>"
  showPortType: boolean;   // 显示串口类型
  sendOnEnter: boolean;     // 聚焦发送框时 Enter 是否直接发送
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
  
  // 备份设置
  backupEnabled: boolean;
  backupInterval: number;  // 备份周期 (小时)
  backupDirectory: string;

  // 引导设置
  hasSeenTour: boolean;    // 是否已完成首次启动引导（false 时显示新手引导）

  // 会话恢复
  restoreSession: boolean;   // 启动时是否恢复上次会话
  sessionSnapshot: string;   // 序列化的会话快照 JSON（退出时写入）
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
  memoryLimitMb: number;
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
  configLoaded: boolean;   // 配置是否已从后端加载完成（避免引导弹窗在加载前闪烁）
  isHotkeyHelpOpen: boolean; // 快捷键帮助弹窗是否打开
  isAboutOpen: boolean;    // 关于对话框是否打开
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
export type TriggerActionType = 'alert' | 'respond' | 'bookmark';

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
}
