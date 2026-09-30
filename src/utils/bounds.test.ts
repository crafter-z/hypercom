/**
 * 跨语言契约测试：前端 `CONFIG_BOUNDS` 必须与 Rust `config/mod.rs` 的
 * `CONFIG_BOUNDS` 逐项相等。断言方式是解析 Rust 源文本（编译期无法跨语言链接），
 * 这样任一侧改动而未同步另一侧时立即红。
 *
 * 源文本经 `?raw` 导入（vite 转换），不依赖 node:fs —— 项目未装 `@types/node`。
 */
import { describe, it, expect } from 'vitest';
import rustConfigSource from '../../src-tauri/src/config/mod.rs?raw';
import { CONFIG_BOUNDS } from './bounds';

function parseRustBounds(source: string): Record<string, [number, number]> {
  const blockMatch = source.match(/pub const CONFIG_BOUNDS[^=]*=\s*&\[([\s\S]*?)\];/);
  if (!blockMatch) throw new Error('CONFIG_BOUNDS not found in config/mod.rs');
  const out: Record<string, [number, number]> = {};
  for (const m of blockMatch[1].matchAll(/\("(\w+)",\s*([\d_]+),\s*([\d_]+)\)/g)) {
    out[m[1]] = [Number(m[2].replace(/_/g, '')), Number(m[3].replace(/_/g, ''))];
  }
  return out;
}

describe('CONFIG_BOUNDS parity with Rust validate_and_clamp', () => {
  const rustBounds = parseRustBounds(rustConfigSource);

  it('parses the Rust table', () => {
    expect(Object.keys(rustBounds).length).toBeGreaterThan(0);
  });

  it('defines the same setting keys on both sides', () => {
    expect(Object.keys(rustBounds).sort()).toEqual(Object.keys(CONFIG_BOUNDS).sort());
  });

  it('agrees on min/max for every setting', () => {
    for (const [key, value] of Object.entries(CONFIG_BOUNDS)) {
      expect(rustBounds[key], `bound mismatch for ${key}`).toEqual([value[0], value[1]]);
    }
  });
});
