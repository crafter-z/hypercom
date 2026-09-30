/**
 * 跨语言 HEX 契约测试（C4/K7）：前端 `hexInputError` / `parseHexBytes`
 * (`src/utils/sendUtils.ts`) 必须与 Rust `serial/codec.rs::parse_hex_string` 同一把尺子：
 *
 * - 奇数个半字节 → 两侧都拒（前端不补零、后端不补齐）
 * - 空输入（含纯空白）→ 两侧都接受为空字节
 * - 大小写混合 → 两侧都接受
 * - 含非 HEX 字符 → 两侧都拒
 *
 * Rust 侧没法在 vitest 里执行（不是 JS，且项目里也没有 wasm 构建），所以这里从
 * **源文本提取判定规则**，用一个参照解析器按同一套规则算出期望值，再拿前端函数逐一比对：
 *   - 接受字符集 ← `parse_hex_string` 内 `nibble` 闭包的 `b'x'..=b'y'` 匹配臂
 *     （后端唯一决定「哪些字符算 HEX」的地方）
 *   - 奇数拒绝 ← 该函数体里的 `is_multiple_of(2)` 守卫
 *   - 非法字符拒绝 ← 该函数体里的 `Invalid HEX byte` 错误分支
 * 任一侧改了尺子（后端放宽/收紧、前端没跟上）本文件立即红。源文本模式对不上会
 * `throw`，不会退化成永远通过的空壳。
 *
 * 局限（明确写出来，别把它当完整证明）：
 * 1. 这是**源文本级**契约，不是运行后端；只有上面三类判定与字符表被提取。
 * 2. 空白分隔类：Rust 用 `is_ascii_whitespace`（仅 ASCII 空白），前端用 `/\s+/`
 *    （JS 空白超集，另含 NBSP / U+FEFF 等）。二者对 ASCII 空白判定一致，本文件只用
 *    ASCII 空白做样例；该差异是前端更宽松，不影响上面四条口径。
 * 3. 不覆盖解码后的 BOM / UTF-8 处理（那是 `ignoreBOM: false` 的另一条契约）。
 */
import { describe, it, expect } from 'vitest';
// 源文本经 `?raw` 导入（vite 转换），不依赖 node:fs —— 项目未装 `@types/node`。
import rustCodecSource from '../../src-tauri/src/serial/codec.rs?raw';
import { hexInputError, parseHexBytes } from './sendUtils';

/** 取 `parse_hex_string` 的函数体源文本（到下一个顶格的 `}` 为止）。 */
function extractParseHexStringBody(source: string): string {
  const match = source.match(/^pub fn parse_hex_string\b[\s\S]*?\n\}/m);
  if (!match) throw new Error('parse_hex_string not found in serial/codec.rs');
  return match[0];
}

/** 从 `nibble` 闭包提取后端接受的字符集（字符 → 数值由该集合唯一决定）。 */
function extractAcceptedNibbles(body: string): Set<string> {
  const closure = body.match(/let nibble = \|b: u8\|[\s\S]*?\};/);
  if (!closure) throw new Error('nibble decoder not found in parse_hex_string');
  const accepted = new Set<string>();
  let arms = 0;
  for (const m of closure[0].matchAll(/b'(.)'\s*\.\.=\s*b'(.)'\s*=>/g)) {
    const lo = m[1].charCodeAt(0);
    const hi = m[2].charCodeAt(0);
    for (let c = lo; c <= hi; c++) accepted.add(String.fromCharCode(c));
    arms++;
  }
  if (arms === 0) throw new Error('nibble decoder has no character ranges');
  return accepted;
}

const CODE_BODY = extractParseHexStringBody(rustCodecSource);
const ACCEPTED_NIBBLES = extractAcceptedNibbles(CODE_BODY);
/** 后端是否仍然拒绝奇数个半字节（`len().is_multiple_of(2)` 守卫）。 */
const RUST_REJECTS_ODD = /is_multiple_of\(2\)/.test(CODE_BODY);
/** 后端是否仍然在遇到非 HEX 字符时报错（而不是跳过）。 */
const RUST_REJECTS_INVALID_CHARS = /Invalid HEX byte/.test(CODE_BODY);

/** 后端只跳过 ASCII 空白（`u8::is_ascii_whitespace`）。 */
const ASCII_WHITESPACE: Record<string, true> = {
  ' ': true,
  '\t': true,
  '\n': true,
  '\r': true,
  '\x0b': true,
  '\x0c': true,
};

const HEX_VALUE: Record<string, number> = {};
for (const ch of ACCEPTED_NIBBLES) HEX_VALUE[ch] = parseInt(ch, 16);

type Verdict = { ok: true; bytes: number[] } | { ok: false };

/**
 * 按从后端源文本提取出的规则解析输入 —— 期望值的唯一来源。
 * 前端函数若与它不同，说明两侧尺子已经分家。
 */
function rustReference(input: string): Verdict {
  if (!RUST_REJECTS_ODD) throw new Error('Rust parse_hex_string no longer rejects odd nibbles');
  const nibbles = [...input].filter((ch) => !ASCII_WHITESPACE[ch]);
  if (nibbles.length % 2 !== 0) return { ok: false };
  const bytes: number[] = [];
  for (let i = 0; i < nibbles.length; i += 2) {
    const hi = HEX_VALUE[nibbles[i]];
    const lo = HEX_VALUE[nibbles[i + 1]];
    if (hi === undefined || lo === undefined) {
      if (!RUST_REJECTS_INVALID_CHARS) {
        throw new Error('Rust parse_hex_string no longer rejects invalid characters');
      }
      return { ok: false };
    }
    bytes.push((hi << 4) | lo);
  }
  return { ok: true, bytes };
}

/** 覆盖四条口径的样例（ASCII 空白，见文件头局限 2）。 */
const CASES: ReadonlyArray<[label: string, input: string]> = [
  ['empty input', ''],
  ['whitespace only', '   '],
  ['tab and newline separators', '\t\n'],
  ['space separated', '48 65 6C'],
  ['compact', '48656C'],
  ['lowercase', 'af'],
  ['uppercase', 'AF'],
  ['mixed case', 'aF b0'],
  ['leading/trailing whitespace', '  4a \n '],
  ['single nibble', 'C'],
  ['odd count (3 nibbles)', '486'],
  ['odd across separator', '48 6'],
  ['non-hex letter', '4Z'],
  ['letters past f', 'GG'],
  ['two invalid pairs', '4G 5H'],
  ['0x prefix is not part of the alphabet', '0x41'],
  ['dash separator', '48-65'],
];

describe('HEX contract: frontend hexInputError/parseHexBytes ↔ Rust parse_hex_string', () => {
  it('extracts the backend rules from serial/codec.rs', () => {
    // 字符表被钉死：后端若收窄/放宽 HEX 字母表而前端不动，这里先红。
    expect([...ACCEPTED_NIBBLES].sort().join('')).toBe('0123456789ABCDEFabcdef');
    expect(RUST_REJECTS_ODD).toBe(true);
    expect(RUST_REJECTS_INVALID_CHARS).toBe(true);
  });

  it('reference model reproduces the backend verdicts', () => {
    // 参考模型自己也要对：空 → 接受为空字节，奇数/非法字符 → 拒绝
    expect(rustReference('')).toEqual({ ok: true, bytes: [] });
    expect(rustReference('   ')).toEqual({ ok: true, bytes: [] });
    expect(rustReference('48 65 6C')).toEqual({ ok: true, bytes: [0x48, 0x65, 0x6c] });
    expect(rustReference('aF b0')).toEqual({ ok: true, bytes: [0xaf, 0xb0] });
    expect(rustReference('C').ok).toBe(false);
    expect(rustReference('48 6').ok).toBe(false);
    expect(rustReference('4Z').ok).toBe(false);
  });

  for (const [label, input] of CASES) {
    it(`${label} — both sides agree (${JSON.stringify(input)})`, () => {
      const expected = rustReference(input);
      expect(hexInputError(input) === null, `hexInputError(${JSON.stringify(input)})`).toBe(
        expected.ok,
      );
      // 非法输入前端必须给不出字节（不能补零造出后端必然拒绝的输入）
      expect(parseHexBytes(input).slice(), `parseHexBytes(${JSON.stringify(input)})`).toEqual(
        expected.ok ? expected.bytes : [],
      );
    });
  }
});
