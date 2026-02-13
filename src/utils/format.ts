import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * 合并 Tailwind CSS 类名
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 将字节数组转换为十六进制字符串
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

/**
 * 将十六进制字符串转换为字节数组
 */
export function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.replace(/\s+/g, '');
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < cleanHex.length; i += 2) {
    bytes[i / 2] = parseInt(cleanHex.substr(i, 2), 16);
  }
  return bytes;
}

/**
 * 将字节数组转换为 ASCII 字符串
 */
export function bytesToAscii(bytes: Uint8Array): string {
  return new TextDecoder('ascii', { fatal: false }).decode(bytes);
}

/**
 * 将 ASCII 字符串转换为字节数组
 */
export function asciiToBytes(ascii: string): Uint8Array {
  return new TextEncoder().encode(ascii);
}

/**
 * 格式化时间戳
 */
export function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
  });
}

/**
 * 验证十六进制字符串
 */
export function isValidHex(str: string): boolean {
  return /^[0-9A-Fa-f\s]*$/.test(str);
}

/**
 * 清理十六进制字符串（移除空格和非十六进制字符）
 */
export function cleanHexString(str: string): string {
  return str.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
}

/**
 * 格式化十六进制字符串（每两个字符添加空格）
 */
export function formatHexString(str: string): string {
  const cleaned = cleanHexString(str);
  return cleaned.match(/.{1,2}/g)?.join(' ') || '';
}
