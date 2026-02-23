// 协议解析器相关类型定义

export type FieldType =
  | 'uint8'
  | 'uint16'
  | 'uint32'
  | 'uint64'
  | 'int8'
  | 'int16'
  | 'int32'
  | 'int64'
  | 'float32'
  | 'float64'
  | 'string'
  | 'bytes'
  | 'hex';

export type ByteOrder = 'bigEndian' | 'littleEndian';

export type ChecksumType =
  | 'none'
  | 'sum8'
  | 'sum16'
  | 'crc8'
  | 'crc16'
  | 'crc32'
  | 'xor8';

export interface ProtocolField {
  name: string;
  fieldType: FieldType;
  offset: number;
  length?: number;
  byteOrder: ByteOrder;
  description?: string;
  visible: boolean;
}

export interface Protocol {
  id: string;
  name: string;
  description?: string;
  header?: number[];
  footer?: number[];
  fields: ProtocolField[];
  checksum?: ChecksumType;
  createdAt: number;
  updatedAt: number;
}

export interface ParsedField {
  name: string;
  fieldType: FieldType;
  rawBytes: number[];
  value: string;
  description?: string;
}

export interface ParsedFrame {
  protocolName: string;
  rawData: number[];
  fields: ParsedField[];
  valid: boolean;
  error?: string;
}

// 字段类型选项
export const FIELD_TYPE_OPTIONS: { value: FieldType; label: string; size?: number }[] = [
  { value: 'uint8', label: 'UINT8', size: 1 },
  { value: 'int8', label: 'INT8', size: 1 },
  { value: 'uint16', label: 'UINT16', size: 2 },
  { value: 'int16', label: 'INT16', size: 2 },
  { value: 'uint32', label: 'UINT32', size: 4 },
  { value: 'int32', label: 'INT32', size: 4 },
  { value: 'uint64', label: 'UINT64', size: 8 },
  { value: 'int64', label: 'INT64', size: 8 },
  { value: 'float32', label: 'FLOAT32', size: 4 },
  { value: 'float64', label: 'FLOAT64', size: 8 },
  { value: 'string', label: 'STRING' },
  { value: 'bytes', label: 'BYTES' },
  { value: 'hex', label: 'HEX' },
];

// 创建空协议
export const createEmptyProtocol = (): Omit<Protocol, 'id' | 'createdAt' | 'updatedAt'> => ({
  name: '',
  description: '',
  header: undefined,
  footer: undefined,
  fields: [],
  checksum: undefined,
});

// 创建空字段
export const createEmptyField = (): ProtocolField => ({
  name: '',
  fieldType: 'uint8',
  offset: 0,
  length: undefined,
  byteOrder: 'bigEndian',
  description: '',
  visible: true,
});
