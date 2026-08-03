import { describe, it, expect, beforeEach } from 'vitest';
import { useTerminalStore } from './useTerminalStore';
import { useAppStore } from './useAppStore';
import type { TerminalLine } from '../types';

// Snapshot of initial config for reset
const INITIAL_CONFIG = useAppStore.getState().config;

beforeEach(() => {
  useTerminalStore.setState({ terminals: {} });
  useAppStore.setState({ config: INITIAL_CONFIG });
});

// Helpers
const makeLine = (id: string, overrides?: Partial<TerminalLine>): TerminalLine => ({
  id, timestamp: Date.now(), direction: 'RX', content: 'hello', isHex: false, ...overrides,
});

// ==================== ensureTerminal ====================

describe('ensureTerminal', () => {
  it('creates terminal with correct defaults', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    const t = useTerminalStore.getState().terminals['COM1'];
    expect(t).toBeDefined();
    expect(t.lines).toEqual([]);
    expect(t.scrollLocked).toBe(true);
    expect(t.showTimestamp).toBe(true);
    expect(t.displayFormat).toBe('string');
    expect(t.encoding).toBe('ASCII');
    expect(t.connectedAt).toBeNull();
  });

  it('uses maxLines derived from config.memoryLimitMb', () => {
    // Default memoryLimitMb is 1024 → 1024 * 500 = 512000
    useTerminalStore.getState().ensureTerminal('COM1');
    const t = useTerminalStore.getState().terminals['COM1'];
    expect(t.maxLines).toBe(INITIAL_CONFIG.memoryLimitMb * 500 || 10000);
  });

  it('uses fallback maxLines=10000 when memoryLimitMb=0', () => {
    useAppStore.getState().setConfig({ memoryLimitMb: 0 });
    useTerminalStore.getState().ensureTerminal('COM1');
    const t = useTerminalStore.getState().terminals['COM1'];
    expect(t.maxLines).toBe(10000);
  });

  it('is idempotent — calling twice does not reset existing terminal', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().setTerminalConfig('COM1', { scrollLocked: false });
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('l1'));
    // Call again
    useTerminalStore.getState().ensureTerminal('COM1');
    const t = useTerminalStore.getState().terminals['COM1'];
    expect(t.scrollLocked).toBe(false);
    expect(t.lines).toHaveLength(1);
  });
});

// ==================== appendTerminalLine ====================

describe('appendTerminalLine', () => {
  it('adds a line to the terminal', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('l1'));
    const lines = useTerminalStore.getState().terminals['COM1'].lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe('l1');
  });

  it('appends multiple lines in order', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    const append = useTerminalStore.getState().appendTerminalLine;
    append('COM1', makeLine('l1'));
    append('COM1', makeLine('l2'));
    append('COM1', makeLine('l3'));
    const lines = useTerminalStore.getState().terminals['COM1'].lines;
    expect(lines.map(l => l.id)).toEqual(['l1', 'l2', 'l3']);
  });

  it('respects maxLines — shifts oldest when exceeded', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.setState((state) => {
      state.terminals['COM1'].maxLines = 3;
    });
    const append = useTerminalStore.getState().appendTerminalLine;
    append('COM1', makeLine('l1'));
    append('COM1', makeLine('l2'));
    append('COM1', makeLine('l3'));
    append('COM1', makeLine('l4')); // evicts l1
    const lines = useTerminalStore.getState().terminals['COM1'].lines;
    expect(lines.map(l => l.id)).toEqual(['l2', 'l3', 'l4']);
  });

  it('is no-op for non-existent terminal', () => {
    const before = useTerminalStore.getState().terminals;
    useTerminalStore.getState().appendTerminalLine('GHOST', makeLine('l1'));
    expect(useTerminalStore.getState().terminals).toEqual(before);
  });
});

// ==================== clearTerminal ====================

describe('clearTerminal', () => {
  it('empties the lines array', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    const append = useTerminalStore.getState().appendTerminalLine;
    append('COM1', makeLine('l1'));
    append('COM1', makeLine('l2'));
    useTerminalStore.getState().clearTerminal('COM1');
    expect(useTerminalStore.getState().terminals['COM1'].lines).toEqual([]);
  });

  it('preserves config fields (scrollLocked, displayFormat, encoding)', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().setTerminalConfig('COM1', {
      scrollLocked: false,
      displayFormat: 'hex',
      encoding: 'UTF-8',
    });
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('l1'));
    useTerminalStore.getState().clearTerminal('COM1');
    const t = useTerminalStore.getState().terminals['COM1'];
    expect(t.lines).toEqual([]);
    expect(t.scrollLocked).toBe(false);
    expect(t.displayFormat).toBe('hex');
    expect(t.encoding).toBe('UTF-8');
  });

  it('is no-op for non-existent terminal', () => {
    useTerminalStore.getState().clearTerminal('GHOST');
    expect(useTerminalStore.getState().terminals['GHOST']).toBeUndefined();
  });
});

// ==================== setTerminalConfig ====================

describe('setTerminalConfig', () => {
  it('patches scrollLocked and displayFormat', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().setTerminalConfig('COM1', {
      scrollLocked: false,
      displayFormat: 'binary',
    });
    const t = useTerminalStore.getState().terminals['COM1'];
    expect(t.scrollLocked).toBe(false);
    expect(t.displayFormat).toBe('binary');
  });

  it('patches showTimestamp only, leaving others unchanged', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().setTerminalConfig('COM1', { showTimestamp: false });
    const t = useTerminalStore.getState().terminals['COM1'];
    expect(t.showTimestamp).toBe(false);
    expect(t.scrollLocked).toBe(true); // unchanged
    expect(t.displayFormat).toBe('string'); // unchanged
  });

  it('is no-op for non-existent terminal', () => {
    useTerminalStore.getState().setTerminalConfig('GHOST', { scrollLocked: false });
    expect(useTerminalStore.getState().terminals['GHOST']).toBeUndefined();
  });
});

// ==================== setTerminalEncoding ====================

describe('setTerminalEncoding', () => {
  it('updates the encoding field', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().setTerminalEncoding('COM1', 'UTF-8');
    expect(useTerminalStore.getState().terminals['COM1'].encoding).toBe('UTF-8');
  });

  it('re-decodes existing lines from rawData', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    // "AB" in ASCII/UTF-8 = [65, 66]
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('l1', {
      content: 'old',
      rawData: [65, 66],
    }));
    useTerminalStore.getState().setTerminalEncoding('COM1', 'UTF-8');
    const line = useTerminalStore.getState().terminals['COM1'].lines[0];
    expect(line.content).toBe('AB');
  });

  it('skips lines with non-empty parsedFields (protocol-parsed)', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('l1', {
      content: 'original',
      rawData: [65, 66],
      parsedFields: [{ name: 'Header', byteStart: 0, byteEnd: 1, color: '#ff0000' }],
    }));
    useTerminalStore.getState().setTerminalEncoding('COM1', 'UTF-8');
    const line = useTerminalStore.getState().terminals['COM1'].lines[0];
    expect(line.content).toBe('original'); // unchanged
  });

  it('skips lines without rawData', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('l1', {
      content: 'no-raw',
    }));
    useTerminalStore.getState().setTerminalEncoding('COM1', 'UTF-8');
    const line = useTerminalStore.getState().terminals['COM1'].lines[0];
    expect(line.content).toBe('no-raw'); // unchanged
  });

  it('skips lines with empty rawData array', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('l1', {
      content: 'empty-raw',
      rawData: [],
    }));
    useTerminalStore.getState().setTerminalEncoding('COM1', 'UTF-8');
    const line = useTerminalStore.getState().terminals['COM1'].lines[0];
    expect(line.content).toBe('empty-raw'); // unchanged
  });

  it('uses utf-8 decoder for ASCII encoding label', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('l1', {
      content: 'old',
      rawData: [72, 105], // "Hi"
    }));
    useTerminalStore.getState().setTerminalEncoding('COM1', 'ASCII');
    const line = useTerminalStore.getState().terminals['COM1'].lines[0];
    expect(line.content).toBe('Hi');
  });

  it('falls back to utf-8 for invalid encoding label', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('l1', {
      content: 'old',
      rawData: [79, 75], // "OK"
    }));
    // Cast to bypass type check — simulating an invalid label at runtime
    useTerminalStore.getState().setTerminalEncoding('COM1', 'INVALID' as never);
    const line = useTerminalStore.getState().terminals['COM1'].lines[0];
    // Should still decode via utf-8 fallback
    expect(line.content).toBe('OK');
  });

  it('is no-op for non-existent terminal', () => {
    useTerminalStore.getState().setTerminalEncoding('GHOST', 'UTF-8');
    expect(useTerminalStore.getState().terminals['GHOST']).toBeUndefined();
  });
});

// ==================== setTerminalConnectedAt ====================

describe('setTerminalConnectedAt', () => {
  it('sets connectedAt timestamp', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    const ts = Date.now();
    useTerminalStore.getState().setTerminalConnectedAt('COM1', ts);
    expect(useTerminalStore.getState().terminals['COM1'].connectedAt).toBe(ts);
  });

  it('is no-op for non-existent terminal', () => {
    useTerminalStore.getState().setTerminalConnectedAt('GHOST', 12345);
    expect(useTerminalStore.getState().terminals['GHOST']).toBeUndefined();
  });
});

// ==================== appendTerminalLines (bulk) ====================

describe('appendTerminalLines (bulk)', () => {
  it('appends all lines in a single store update, preserving order', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    const lines: TerminalLine[] = [
      makeLine('b1'), makeLine('b2'), makeLine('b3'),
    ];
    useTerminalStore.getState().appendTerminalLines('COM1', lines);
    const result = useTerminalStore.getState().terminals['COM1'].lines;
    expect(result.map(l => l.id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('interleaves correctly with individual appendTerminalLine calls', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('single1'));
    useTerminalStore.getState().appendTerminalLines('COM1', [makeLine('bulk1'), makeLine('bulk2')]);
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('single2'));
    const lines = useTerminalStore.getState().terminals['COM1'].lines;
    expect(lines.map(l => l.id)).toEqual(['single1', 'bulk1', 'bulk2', 'single2']);
  });

  it('trims to maxLines in a single splice when bulk exceeds capacity', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().setTerminalConfig('COM1', { maxLines: 5 });
    const lines: TerminalLine[] = Array.from({ length: 8 }, (_, i) => makeLine(`b${i}`));
    useTerminalStore.getState().appendTerminalLines('COM1', lines);
    const result = useTerminalStore.getState().terminals['COM1'].lines;
    // Last 5 kept in original order
    expect(result.map(l => l.id)).toEqual(['b3', 'b4', 'b5', 'b6', 'b7']);
  });

  it('trims combined single + bulk lines to maxLines', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().setTerminalConfig('COM1', { maxLines: 4 });
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('pre1'));
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('pre2'));
    useTerminalStore.getState().appendTerminalLines('COM1', [
      makeLine('b1'), makeLine('b2'), makeLine('b3'), makeLine('b4'),
    ]);
    const result = useTerminalStore.getState().terminals['COM1'].lines;
    // 6 total → keep last 4
    expect(result.map(l => l.id)).toEqual(['b1', 'b2', 'b3', 'b4']);
  });

  it('is no-op for non-existent (ghost) terminal', () => {
    const before = useTerminalStore.getState().terminals;
    useTerminalStore.getState().appendTerminalLines('GHOST', [makeLine('x')]);
    expect(useTerminalStore.getState().terminals).toEqual(before);
  });

  it('handles an empty lines array without error', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().appendTerminalLines('COM1', []);
    expect(useTerminalStore.getState().terminals['COM1'].lines).toEqual([]);
  });
});
