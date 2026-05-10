/**
 * HyperCom 串口调试工具 - 全局类型定义
 * 涵盖串口、配置、日志、UI状态等所有核心数据结构
 */

// ==================== 串口相关 ====================

/** 串口连接状态 */
export type PortStatus = 'disconnected' | 'error' | 'connected';

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
}

/** 分屏区域 */
export interface SplitPane {
  id: string;
  direction: 'horizontal' | 'vertical';
  tabIds: string[];
  size: number;            // 占比 (0-1)
}

// ==================== 终端内容相关 ====================

/** 单行终端数据 */
export interface TerminalLine {
  id: string;
  timestamp: number;       // 时间戳
  direction: 'RX' | 'TX';
  content: string;         // 原始内容
  displayContent?: string; // 格式化后的显示内容（带高亮）
  isHex: boolean;          // 是否为HEX显示
}

/** 终端视图状态 */
export interface TerminalState {
  lines: TerminalLine[];
  maxLines: number;        // 最大保留行数
  scrollLocked: boolean;   // 是否滚动锁定
  showTimestamp: boolean;
  displayFormat: DisplayFormat;
  encoding: Encoding;
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

// ==================== 配置相关 ====================

/** 应用程序全局配置 */
export interface AppConfig {
  // 通用设置
  closeBehavior: 'minimize' | 'exit';
  memoryLimitMB: number;
  language: 'zh-CN' | 'en-US';
  theme: 'light' | 'dark' | 'system';
  preventScreenOff: boolean;
  preventSleep: boolean;
  
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
  
  // 时间戳设置
  timestampMode: 'perLine' | 'perRound';
  
  // 日志设置
  autoSaveLog: boolean;
  logDirectory: string;
  logFilenameFormat: string;  // 默认 "[com]-[datetime]"
  logFormat: DisplayFormat;
  logEncoding: Encoding;
  logSplitEnabled: boolean;
  logSplitSizeMB: number;
  
  // 备份设置
  backupEnabled: boolean;
  backupInterval: number;  // 备份周期 (小时)
  backupDirectory: string;
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
  memoryUsedMB: number;
  memoryLimitMB: number;
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
