/**
 * 串口名自然排序（issue #2-4）
 *
 * Windows 端口枚举按注册表字典序返回 COM1 / COM12 / COM2，不符合直觉。
 * 此比较器把连续数字段按**数值**比较（COM1 < COM2 < COM12），
 * 其余字符逐位不区分大小写比较。纯函数、无 DOM 依赖，可在 vitest node
 * 环境直接测试。
 */
import type { SerialPort } from '../types';

const isDigit = (ch: string): boolean => ch >= '0' && ch <= '9';

/**
 * 自然序比较两个端口名。返回负数 = a 在前，正数 = b 在前，0 = 等价。
 *
 * 规则：
 * - 数字段按数值比较（"COM2" < "COM12"；数值相同时前导零少的在前）
 * - 非数字字符不区分大小写逐位比较
 * - 一个是另一个的前缀时，短的在前（"COM1" < "COM1X"）
 */
export function naturalCompare(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a[i];
    const cb = b[j];
    if (isDigit(ca) && isDigit(cb)) {
      const startI = i;
      while (i < a.length && isDigit(a[i])) i++;
      const startJ = j;
      while (j < b.length && isDigit(b[j])) j++;
      const rawA = a.slice(startI, i);
      const rawB = b.slice(startJ, j);
      // 去掉前导零后比「数值」：位数不同则位数少的数值小；位数相同按字典序即数值序
      const numA = rawA.replace(/^0+/, '') || '0';
      const numB = rawB.replace(/^0+/, '') || '0';
      if (numA.length !== numB.length) return numA.length - numB.length;
      if (numA !== numB) return numA < numB ? -1 : 1;
      // 数值相同（如 "01" vs "1"）：原始写法短的在前，保证确定性
      if (rawA.length !== rawB.length) return rawA.length - rawB.length;
    } else {
      const la = ca.toLowerCase();
      const lb = cb.toLowerCase();
      if (la !== lb) return la < lb ? -1 : 1;
      i++;
      j++;
    }
  }
  if (i === a.length && j === b.length) return 0;
  return i === a.length ? -1 : 1;
}

/** 按端口名自然序返回新数组（不修改入参，稳定排序）。 */
export function sortPortsByNatural<T extends Pick<SerialPort, 'id'>>(ports: readonly T[]): T[] {
  return [...ports].sort((a, b) => naturalCompare(a.id, b.id));
}
