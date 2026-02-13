// 串口相关类型定义

export interface SerialConfig {
  portName: string;
  baudRate: number;
  dataBits: DataBits;
  stopBits: StopBits;
  parity: Parity;
  flowControl: FlowControl;
}

export type DataBits = 5 | 6 | 7 | 8;

export type StopBits = 1 | 1.5 | 2;

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
  dataBits: 8,
  stopBits: 1,
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
