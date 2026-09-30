/**
 * Send-area pure helpers (byte count, HEX parsing, line-ending bytes).
 * DOM-free so they can be unit-tested under vitest's `environment: 'node'`.
 */
import type { Encoding, LineEnding } from '../types';
import { bytesToSpacedHex } from './hexFormat';

/**
 * Return the raw bytes represented by a line-ending selector value.
 * Values mirror the `LineEnding` type sent to the backend.
 */
export function getLineEndingBytes(lineEnding: LineEnding): number[] {
  switch (lineEnding) {
    case '\\r\\n':
      return [0x0d, 0x0a];
    case '\\r':
      return [0x0d];
    case '\\n':
      return [0x0a];
    default:
      return [];
  }
}

/**
 * HEX 输入非法时返回的 i18n key（合法 / 空输入 → null）。
 *
 * 契约来源是后端 `parse_hex_string`（src-tauri/src/serial/codec.rs）：忽略空白后
 * 要求「半字节个数为偶数 且 全为 0-9a-fA-F」，否则返回 Err。前端必须用同一把尺子
 * 判定可发送性——旧实现给奇数位补零，于是发送区为一个后端**必然拒绝**的输入
 * 显示「N B」，用户看到的是假可用状态。两侧同尺由 `src/utils/hexContract.test.ts`
 * 解析 Rust 源文本断言。
 */
export const HEX_INPUT_ERROR_KEY = 'sendSection.hexInput.invalid';

/** HEX 输入是否可发送：合法 / 空输入 → null，否则返回 {@link HEX_INPUT_ERROR_KEY}。 */
export function hexInputError(input: string): string | null {
  const cleaned = input.replace(/\s+/g, '');
  if (cleaned.length === 0) return null;
  if (cleaned.length % 2 !== 0) return HEX_INPUT_ERROR_KEY;
  return /^[0-9a-fA-F]+$/.test(cleaned) ? null : HEX_INPUT_ERROR_KEY;
}

/**
 * Parse a space-separated or compact HEX string into a byte array.
 *
 * Strict, mirroring the backend: odd nibble counts and non-HEX characters yield `[]`
 * (no zero-padding, no skipping) — callers gate on {@link hexInputError} and must
 * never fabricate bytes the backend would reject.
 */
export function parseHexBytes(input: string): number[] {
  if (hexInputError(input) !== null) return [];
  const cleaned = input.replace(/\s+/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return bytes;
}

export interface ByteCountResult {
  count: number;
  /** Ready-to-display label, e.g. "42 B" or "3 chars · ? bytes". Empty when `errorKey` is set. */
  label: string;
  /** Optional tooltip for ambiguous encodings. */
  tooltip?: string;
  /** Set when the input cannot be sent (HEX mode) — UI renders the error instead of a count. */
  errorKey?: string;
}

/**
 * Compute the byte count for the current send input.
 *
 * - HEX mode: parsed byte count + line-ending suffix bytes; invalid HEX yields
 *   `errorKey` and an empty label (never a bogus count).
 * - UTF-8 / ASCII text: `TextEncoder` byte count + suffix.
 * - GBK / ISO-8859-1 text: shows character count with a "? bytes" hint,
 *   because the final byte length depends on the backend encoding_rs pass.
 */
export function computeByteCount(
  input: string,
  isHex: boolean,
  encoding: Encoding,
  lineEnding: LineEnding
): ByteCountResult {
  const suffixLen = getLineEndingBytes(lineEnding).length;

  if (isHex) {
    const errorKey = hexInputError(input);
    if (errorKey !== null) return { count: 0, label: '', errorKey };
    const count = parseHexBytes(input).length + suffixLen;
    return { count, label: `${count} B` };
  }

  if (encoding === 'UTF-8' || encoding === 'ASCII') {
    const count = new TextEncoder().encode(input).length + suffixLen;
    return { count, label: `${count} B` };
  }

  // GBK / ISO-8859-1: exact bytes require encoding_rs; show chars + hint.
  return {
    count: input.length + suffixLen,
    label: `${input.length} chars · ? bytes`,
    tooltip:
      'Exact byte count depends on the actual bytes after encoding; showing character count.',
  };
}

/**
 * Format a line-ending selector value as a display string of its HEX bytes,
 * e.g. "\\r\\n" -> "0D 0A". Returns `null` when there is no suffix.
 */
export function formatLineEndingHex(lineEnding: LineEnding): string | null {
  const bytes = getLineEndingBytes(lineEnding);
  if (bytes.length === 0) return null;
  return bytesToSpacedHex(bytes);
}

/** Convert plain text to a spaced uppercase HEX byte preview (UTF-8 bytes). '' → ''. */
export function textToHexPreview(text: string): string {
  if (!text) return '';
  return bytesToSpacedHex(new TextEncoder().encode(text));
}

/** Decode a HEX byte string back to text (UTF-8, non-fatal). Invalid HEX / empty → ''. */
export function hexToTextPreview(hex: string): string {
  const bytes = parseHexBytes(hex);
  if (bytes.length === 0) return '';
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
}

/** Strip anything that isn't a HEX digit or whitespace (HEX-mode input guard). */
export function sanitizeHexInput(input: string): string {
  return input.replace(/[^0-9a-fA-F\s]/g, '');
}

/**
 * 行尾枚举的规范取值（issue #5-6 回归锁）。
 *
 * ⚠️ 这些值必须以 JS 字符串字面量形式使用（`value={'\r\n'}`），
 * 不能写成 JSX 属性字符串（`value="\\r\\n"`）——@vitejs/plugin-react
 * 的 Babel 转义管线不会对 JSX 属性字符串做转义处理，运行时值会变成
 * 6 字符的 `\\r\\n`，导致 `formatLineEndingHex` / `getLineEndingBytes`
 * 匹配失败（行尾提示不跟随、行尾字节丢失）。
 */
export const LINE_ENDING_VALUES: readonly LineEnding[] = [
  '\\r\\n',
  '\\r',
  '\\n',
  'None',
] as const;

/** 行尾选项对应的 i18n label key（按命名空间，供各组件复用同一组取值）。 */
export function lineEndingLabelKey(
  v: LineEnding,
  ns: 'sendSection' | 'displaySettings' | 'sendCmdEditor' | 'quickSend' = 'sendSection'
): string {
  const suffix =
    v === 'None' ? 'none' : v === '\\r\\n' ? 'crlf' : v === '\\r' ? 'cr' : 'lf';
  return `${ns}.lineEnding.${suffix}`;
}
