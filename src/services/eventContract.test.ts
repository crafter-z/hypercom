/**
 * `serial:file_progress` wire-contract guard.
 *
 * Rust emits the payload with `#[serde(rename_all = "camelCase")]`, so the TS
 * interface must use camelCase too. A rename drift is invisible to tsc (the
 * listener just receives undefined fields and silently ignores every event:
 * progress bars never advance, the active transfer never clears and all later
 * file sends are blocked).
 *
 * Both sides are read as source text (same technique as `hexContract.test.ts`):
 * the test fails when either side renames a field without the other.
 */
import { describe, expect, it } from 'vitest';
import rustSerialSource from '../../src-tauri/src/commands/serial.rs?raw';
import eventSource from './event.ts?raw';
import rustUpdateSource from '../../src-tauri/src/commands/update.rs?raw';
import rustPluginSource from '../../src-tauri/src/commands/plugin.rs?raw';
import rustHttpSource from '../../src-tauri/src/commands/plugin_http.rs?raw';
import rustViewSource from '../../src-tauri/src/plugin/view_runtime/mod.rs?raw';
import typesSource from '../types/index.ts?raw';
import viewTypesSource from '../types/pluginViews.ts?raw';
import updateServiceSource from './update.ts?raw';

function bracedBody(source: string, start: number): string {
  let depth = 1;
  for (let index = start; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index);
  }
  throw new Error('unterminated contract declaration');
}

function extractRustStruct(source: string, name: string): { attributes: string; body: string } {
  const match = new RegExp(`((?:#\\[[^\\]]*\\]\\s*)*)pub struct ${name}\\s*\\{`).exec(source);
  if (!match) throw new Error(`struct ${name} not found`);
  return { attributes: match[1], body: bracedBody(source, match.index + match[0].length) };
}

function tsInterfaceFields(source: string, name: string): string[] {
  const match = new RegExp(`export interface ${name}(?:\\s+extends\\s+([^\\{]+))?\\s*\\{`).exec(source);
  if (!match) throw new Error(`interface ${name} not found`);
  const fields = [...bracedBody(source, match.index + match[0].length).matchAll(/^\s*([A-Za-z0-9_]+)\??:/gm)].map(field => field[1]);
  for (const parent of match[1]?.split(',').map(value => value.trim()) ?? []) fields.push(...tsInterfaceFields(source, parent));
  return fields;
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

describe('serial:file_progress contract', () => {
  it('matches Rust camelCase wire names', () => {
    const rust = extractRustStruct(rustSerialSource, 'FileProgressPayload');
    expect(rust.attributes).toContain('rename_all = "camelCase"');
    const rustFields = [...rust.body.matchAll(/pub\s+([a-z0-9_]+)\s*:/g)].map((m) => snakeToCamel(m[1]));
    const tsFields = tsInterfaceFields(eventSource, 'FileProgressPayload');
    expect(tsFields.sort()).toEqual(rustFields.sort());
    expect(tsFields).toContain('sentBytes');
    expect(tsFields).toContain('totalBytes');
  });
});

const payloadContracts = [
  { name: 'HTTP request', rust: rustHttpSource, rustName: 'PluginHttpRequest', ts: typesSource, tsName: 'PluginHttpRequest' },
  { name: 'HTTP head', rust: rustHttpSource, rustName: 'PluginHttpHead', ts: typesSource, tsName: 'PluginHttpHead' },
  { name: 'HTTP chunk', rust: rustHttpSource, rustName: 'PluginHttpChunk', ts: typesSource, tsName: 'PluginHttpChunk' },
  { name: 'plugin state snapshot', rust: rustPluginSource, rustName: 'PluginStateSnapshot', ts: typesSource, tsName: 'PluginStateSnapshot' },
  { name: 'plugin list', rust: rustPluginSource, rustName: 'PluginListResponse', ts: typesSource, tsName: 'PluginListResponse' },
  { name: 'view binding', rust: rustViewSource, rustName: 'Binding', ts: viewTypesSource, tsName: 'PluginViewBinding' },
  { name: 'view rectangle', rust: rustViewSource, rustName: 'Rect', ts: viewTypesSource, tsName: 'PluginViewRect' },
  { name: 'view occlusion', rust: rustViewSource, rustName: 'OcclusionRect', ts: viewTypesSource, tsName: 'PluginViewportRect' },
  { name: 'update result', rust: rustUpdateSource, rustName: 'UpdatePayload', ts: typesSource, tsName: 'UpdatePayload' },
  { name: 'update progress', rust: rustUpdateSource, rustName: 'UpdateProgressPayload', ts: typesSource, tsName: 'UpdateProgressPayload' },
];

describe('plugin / HTTP / native view / update payload fields', () => {
  it.each(payloadContracts)('$name uses the same real wire field names on both sides', contract => {
    const rust = extractRustStruct(contract.rust, contract.rustName);
    expect(rust.attributes).toContain('rename_all = "camelCase"');
    const rustFields = [...rust.body.matchAll(/pub\s+([a-z0-9_]+)\s*:/g)].map(field => snakeToCamel(field[1]));
    const tsFields = tsInterfaceFields(contract.ts, contract.tsName);
    expect(rustFields.length).toBeGreaterThan(0);
    expect(tsFields.sort()).toEqual(rustFields.sort());
  });

  it('publishes and subscribes to the actual update:progress event', () => {
    expect(rustUpdateSource).toMatch(/\.emit\(\s*"update:progress"/);
    expect(updateServiceSource).toMatch(/listen<UpdateProgressPayload>\('update:progress'/);
    expect(tsInterfaceFields(typesSource, 'UpdateProgressPayload').sort()).toEqual(['downloaded', 'phase', 'total']);
  });
});
