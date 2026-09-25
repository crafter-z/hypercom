/**
 * 字节 → HEX 字符串的唯一实现。
 *
 * 此前全仓有 7 处各自的 `b.toString(16).toUpperCase().padStart(2, '0')` 拷贝
 * （hexUtils / sendUtils ×2 / protocolRenderer / terminalSearch / triggerEngine /
 * TerminalRenderer），只有 triggerEngine 那份做了 `& 0xff` —— 一个概念七份实现，
 * 五份在掩码上不一致。统一走这里。
 */

/** 单字节 → 两位大写 HEX（先掩到低 8 位，负数/越界值不会产生 3+ 字符）。 */
export function hexByte(byte: number): string {
  return (byte & 0xff).toString(16).toUpperCase().padStart(2, '0');
}

/** 字节序列 → 空格分隔的大写 HEX（`"41 42 43"`）。空输入 → `""`。 */
export function bytesToSpacedHex(bytes: ArrayLike<number>): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0) out += ' ';
    out += hexByte(bytes[i]);
  }
  return out;
}
