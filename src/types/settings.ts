// 设置相关类型定义

import { SerialConfig } from './serial';

export interface AppSettings {
  display: DisplaySettings;
  serialDefaults: SerialConfig;
  log: LogSettings;
}

export interface DisplaySettings {
  fontSize: number;
  fontFamily: string;
  theme: 'light' | 'dark' | 'system';
  displayFormat: 'hex' | 'ascii' | 'mixed';
  showTimestamp: boolean;
  showDirection: boolean;
}

export interface LogSettings {
  enabled: boolean;
  logDir: string;
  maxFileSize: number; // MB
  autoSplit: boolean;
  includeTimestamp: boolean;
}

// 日志状态
export type LogStatus = 'Stopped' | 'Recording' | 'Paused';

// 日志配置（与后端对应）
export interface LogConfig {
  enabled: boolean;
  logDir: string;
  maxFileSize: number;
  autoSplit: boolean;
  includeTimestamp: boolean;
  includeDirection: boolean;
}

// 默认设置
export const DEFAULT_SETTINGS: AppSettings = {
  display: {
    fontSize: 14,
    fontFamily: 'JetBrains Mono',
    theme: 'system',
    displayFormat: 'hex',
    showTimestamp: true,
    showDirection: true,
  },
  serialDefaults: {
    portName: '',
    baudRate: 115200,
    dataBits: 'eight',
    stopBits: 'one',
    parity: 'none',
    flowControl: 'none',
  },
  log: {
    enabled: false,
    logDir: '',
    maxFileSize: 10,
    autoSplit: true,
    includeTimestamp: true,
  },
};
