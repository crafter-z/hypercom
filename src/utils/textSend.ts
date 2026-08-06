/**
 * QuickSend text-mode pure helpers (issue #5-4).
 *
 * Line splitting, HEX-line validity and interval clamping for the popout's
 * text mode. DOM-free so they can be unit-tested under vitest's
 * `environment: 'node'`.
 */

/**
 * 按 CRLF/LF 切行，并裁掉尾部空行（含纯空白行）。
 * 每行 = 一条独立命令；内部空行保留（执行时跳过，索引与文本区行号对应）。
 */
export function splitSendLines(text: string): string[] {
  const raw = text.split(/\r?\n/);
  let end = raw.length;
  while (end > 0 && raw[end - 1].trim() === '') {
    end -= 1;
  }
  return raw.slice(0, end);
}

/**
 * 是否为合法 HEX 行：去掉全部空白后非空、长度为偶数、且只含 0-9a-fA-F。
 * 「48 65 6C」/「AABBCC」合法；「4」「zz」「0x48」非法（含奇数半字节或非 HEX 字符）。
 * 空行（空白）不算非法——调用方应先判空。
 */
export function isValidHexLine(line: string): boolean {
  const cleaned = line.replace(/\s+/g, '');
  if (cleaned.length === 0 || cleaned.length % 2 !== 0) return false;
  return /^[0-9a-fA-F]+$/.test(cleaned);
}

/**
 * 行间发送间隔钳制：非法输入（NaN/Infinity）→ 1，最小 1ms，四舍五入取整。
 */
export function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return 1;
  return Math.max(1, Math.round(ms));
}

/**
 * 轮次间隔钳制：非法输入 → 0，最小 0ms（轮间无间隔），四舍五入取整。
 */
export function clampRoundInterval(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.round(ms));
}
