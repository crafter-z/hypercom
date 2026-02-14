// 串口相关类型定义

export interface SerialConfig {
  portName: string;
  baudRate: number;
  dataBits: DataBits;
  stopBits: StopBits;
  parity: Parity;
  flowControl: FlowControl;
}

// 后端使用 lowercase 枚举，所以前端需要发送字符串
export type DataBits = 'five' | 'six' | 'seven' | 'eight';

export type StopBits = 'one' | 'two';

export type Parity = 'none' | 'odd' | 'even';

export type FlowControl = 'none' | 'software' | 'hardware';

export type SerialStatus = 'closed' | 'open' | 'error';

export interface PortInfo {
  name: string;
  portType: string;
  manufacturer?: string;
  product?: string;
}

export interface DataPacket {
  id: string;
  data: string;
  timestamp: number;
  direction: 'rx' | 'tx';
  format: 'hex' | 'ascii';
}

// 默认串口配置
export const DEFAULT_SERIAL_CONFIG: SerialConfig = {
  portName: '',
  baudRate: 115200,
  dataBits: 'eight',
  stopBits: 'one',
  parity: 'none',
  flowControl: 'none',
};

// 常用波特率
export const BAUD_RATES = [
  9600,
  19200,
  38400,
  57600,
  115200,
  230400,
  460800,
  921600,
];

// 数据位选项
export const DATA_BITS_OPTIONS: { value: DataBits; label: string }[] = [
  { value: 'five', label: '5' },
  { value: 'six', label: '6' },
  { value: 'seven', label: '7' },
  { value: 'eight', label: '8' },
];

// 停止位选项
export const STOP_BITS_OPTIONS: { value: StopBits; label: string }[] = [
  { value: 'one', label: '1' },
  { value: 'two', label: '2' },
];
