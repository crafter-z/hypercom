/**
 * Cross-language guard for the view binary protocol.
 *
 * The protocol exists in three places that cannot share types: the page SDK
 * (`src-tauri/src/plugin/view_runtime/sdk.js`), the native validator
 * (`src-tauri/src/plugin/view_runtime/mod.rs`) and the host/Worker transport
 * (`src/utils/pluginViewBinary.ts`). Nothing else would notice if one side renamed
 * a field or changed the 8 KiB chunk size, so this test parses the sources and
 * asserts the contracts still match.
 */
import { describe, it, expect } from 'vitest';
import sdkSource from '../../src-tauri/src/plugin/view_runtime/sdk.js?raw';
import nativeSource from '../../src-tauri/src/plugin/view_runtime/mod.rs?raw';
import { VIEW_BINARY_CHUNK_BYTES, MAX_VIEW_BINARY_TRANSFER_BYTES, VIEW_BINARY_ACK_TIMEOUT_MS, VIEW_BINARY_TRANSFER_IDLE_MS, MAX_ACTIVE_VIEW_BINARY_TRANSFERS, MAX_PLUGIN_VIEW_BINARY_BYTES, MAX_ALL_VIEW_BINARY_BYTES, MAX_VIEW_BINARY_QUEUE_BYTES, MAX_PLUGIN_VIEW_BINARY_TRANSFERS, MAX_ALL_VIEW_BINARY_TRANSFERS, ViewBinaryBudget } from './pluginViewBinary';

const KEYS = [
  'binary-chunk',
  'binary-ack',
  'documentId',
  'transferId',
  'transferType',
  'seq',
  'done',
  'data',
] as const;

function chunkSize(source: string, pattern: RegExp): number {
  const match = pattern.exec(source);
  expect(match, `chunk-size pattern missing: ${pattern}`).not.toBeNull();
  return Number(match![1]);
}

describe('view binary protocol is identical in sdk.js / mod.rs / pluginViewBinary.ts', () => {
  it('all three implementations use an 8 KiB chunk payload', () => {
    const sdkBytes = chunkSize(sdkSource, /const CHUNK_BYTES = (\d+);/);
    const nativeLimit = chunkSize(nativeSource, /if bytes\.len\(\) > (\d+) \* 1024 \{/);
    expect(VIEW_BINARY_CHUNK_BYTES).toBe(sdkBytes);
    expect(sdkBytes).toBe(8 * 1024);
    expect(nativeLimit).toBe(8);
  });

  it('SDK transfer/aggregate/slot and idle/ACK limits match the host transport', () => {
    const constant = (name: string): number => {
      const expression = new RegExp(`const ${name} = ([0-9 *]+);`).exec(sdkSource)?.[1];
      expect(expression, name).toBeDefined();
      return new Function(`return (${expression});`)() as number;
    };
    expect(constant('MAX_BINARY_TRANSFER_BYTES')).toBe(MAX_VIEW_BINARY_TRANSFER_BYTES);
    expect(constant('MAX_BINARY_BYTES')).toBe(MAX_PLUGIN_VIEW_BINARY_BYTES);
    expect(constant('MAX_BINARY_TRANSFERS')).toBe(MAX_ACTIVE_VIEW_BINARY_TRANSFERS);
    expect(constant('BINARY_IDLE_MS')).toBe(VIEW_BINARY_TRANSFER_IDLE_MS);
    expect(constant('BINARY_ACK_MS')).toBe(VIEW_BINARY_ACK_TIMEOUT_MS);
  });

  it('quadruples byte budgets while preserving concurrency and chunk boundaries', () => {
    expect(MAX_VIEW_BINARY_TRANSFER_BYTES).toBe(256 * 1024 * 1024);
    expect(MAX_VIEW_BINARY_QUEUE_BYTES).toBe(MAX_VIEW_BINARY_TRANSFER_BYTES);
    expect(MAX_PLUGIN_VIEW_BINARY_BYTES).toBe(512 * 1024 * 1024);
    expect(MAX_ALL_VIEW_BINARY_BYTES).toBe(1024 * 1024 * 1024);
    expect(MAX_ACTIVE_VIEW_BINARY_TRANSFERS).toBe(4);
    expect(MAX_PLUGIN_VIEW_BINARY_TRANSFERS).toBe(16);
    expect(MAX_ALL_VIEW_BINARY_TRANSFERS).toBe(32);
  });

  it('admits the expanded per-plugin and global bytes exactly, then reclaims them', () => {
    const budget = new ViewBinaryBudget();
    // Ledger-only test: do not allocate 1 GiB to test admission arithmetic.
    const first = budget.reserve('plugin-a', MAX_PLUGIN_VIEW_BINARY_BYTES, 1);
    expect(() => budget.reserve('plugin-a', 1)).toThrow('capacity exceeded');
    const second = budget.reserve('plugin-b', MAX_PLUGIN_VIEW_BINARY_BYTES, 1);
    expect(() => budget.reserve('plugin-c', 1)).toThrow('capacity exceeded');
    first(); first(); // Releases remain idempotent at the larger capacities.
    const replacement = budget.reserve('plugin-c', MAX_PLUGIN_VIEW_BINARY_BYTES, 1);
    second(); replacement();
    const reused = budget.reserve('plugin-a', MAX_PLUGIN_VIEW_BINARY_BYTES, 1);
    reused();
  });

  it('sdk.js and mod.rs both know every wire key', () => {
    for (const key of KEYS) {
      expect(sdkSource, `sdk.js is missing "${key}"`).toContain(key);
      expect(nativeSource, `mod.rs is missing "${key}"`).toContain(key);
    }
  });

  it('sdk.js parses as an ordinary (non-module) script', () => {
    // Syntax only: constructing the function must not execute plugin code.
    expect(() => new Function(sdkSource)).not.toThrow();
  });

  it('the native validator still bounds the envelope before decoding base64', () => {
    // A chunk is base64 encoded inside a JSON envelope; both bounds must exist.
    expect(nativeSource).toMatch(/MAX_BINARY_TRANSFER_ID_LEN/);
    expect(nativeSource).toMatch(/BINARY_MESSAGE_RATE_PER_SECOND/);
    expect(nativeSource).toMatch(/validate_binary_chunk/);
  });
});
