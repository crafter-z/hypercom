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

function extractRustStruct(source: string, name: string): { attributes: string; body: string } {
  const match = source.match(
    new RegExp(`((?:#\\[[^\\]]*\\]\\s*)*)pub struct ${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  if (!match) throw new Error(`struct ${name} not found`);
  return { attributes: match[1], body: match[2] };
}

function extractTsInterface(source: string, name: string): string {
  const match = source.match(new RegExp(`export interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`interface ${name} not found`);
  return match[1];
}

function snakeToCamel(value: string): string {
  return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

describe('serial:file_progress contract', () => {
  it('matches Rust camelCase wire names', () => {
    const rust = extractRustStruct(rustSerialSource, 'FileProgressPayload');
    expect(rust.attributes).toContain('rename_all = "camelCase"');
    const rustFields = [...rust.body.matchAll(/pub\s+([a-z0-9_]+)\s*:/g)].map((m) => snakeToCamel(m[1]));
    const tsFields = [...extractTsInterface(eventSource, 'FileProgressPayload').matchAll(/^\s*([A-Za-z0-9_]+)\??:/gm)].map((m) => m[1]);
    expect(tsFields.sort()).toEqual(rustFields.sort());
    expect(tsFields).toContain('sentBytes');
    expect(tsFields).toContain('totalBytes');
  });
});
