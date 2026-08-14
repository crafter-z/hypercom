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

  it('uses maxLines derived from config.memoryPerPortBudgetMb (issue #6-2)', () => {
    // 每端口预算默认 200 → 200 * 500 = 100000
    useTerminalStore.getState().ensureTerminal('COM1');
    const t = useTerminalStore.getState().terminals['COM1'];
    expect(t.maxLines).toBe(INITIAL_CONFIG.memoryPerPortBudgetMb * 500 || 10000);
  });

  it('uses fallback maxLines=10000 when memoryPerPortBudgetMb=0', () => {
    useAppStore.getState().setConfig({ memoryPerPortBudgetMb: 0 });
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

  it('trims to half (not one-by-one shift) when maxLines exceeded (issue #6-2)', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.setState((state) => {
      state.terminals['COM1'].maxLines = 3;
    });
    const append = useTerminalStore.getState().appendTerminalLine;
    append('COM1', makeLine('l1'));
    append('COM1', makeLine('l2'));
    append('COM1', makeLine('l3'));
    append('COM1', makeLine('l4')); // 4 > 3 → 一次性裁到一半 → 保留 2 行
    const lines = useTerminalStore.getState().terminals['COM1'].lines;
    expect(lines.map(l => l.id)).toEqual(['l3', 'l4']);
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
      rawData: new Uint8Array([65, 66]),
    }));
    useTerminalStore.getState().setTerminalEncoding('COM1', 'UTF-8');
    const line = useTerminalStore.getState().terminals['COM1'].lines[0];
    expect(line.content).toBe('AB');
  });

  it('skips lines with non-empty parsedFields (protocol-parsed)', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('l1', {
      content: 'original',
      rawData: new Uint8Array([65, 66]),
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
      rawData: new Uint8Array(0),
    }));
    useTerminalStore.getState().setTerminalEncoding('COM1', 'UTF-8');
    const line = useTerminalStore.getState().terminals['COM1'].lines[0];
    expect(line.content).toBe('empty-raw'); // unchanged
  });

  it('uses utf-8 decoder for ASCII encoding label', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('l1', {
      content: 'old',
      rawData: new Uint8Array([72, 105]), // "Hi"
    }));
    useTerminalStore.getState().setTerminalEncoding('COM1', 'ASCII');
    const line = useTerminalStore.getState().terminals['COM1'].lines[0];
    expect(line.content).toBe('Hi');
  });

  it('falls back to utf-8 for invalid encoding label', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('l1', {
      content: 'old',
      rawData: new Uint8Array([79, 75]), // "OK"
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

  it('trims to half in a single splice when bulk exceeds capacity (issue #6-2)', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().setTerminalConfig('COM1', { maxLines: 5 });
    const lines: TerminalLine[] = Array.from({ length: 8 }, (_, i) => makeLine(`b${i}`));
    const trimmed = useTerminalStore.getState().appendTerminalLines('COM1', lines);
    const result = useTerminalStore.getState().terminals['COM1'].lines;
    // 8 行 > 5 → 一次性裁到一半 → 保留 4 行
    expect(trimmed).toBe(true);
    expect(result.map(l => l.id)).toEqual(['b4', 'b5', 'b6', 'b7']);
  });

  it('trims combined single + bulk lines to half', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().setTerminalConfig('COM1', { maxLines: 4 });
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('pre1'));
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('pre2'));
    useTerminalStore.getState().appendTerminalLines('COM1', [
      makeLine('b1'), makeLine('b2'), makeLine('b3'), makeLine('b4'),
    ]);
    const result = useTerminalStore.getState().terminals['COM1'].lines;
    // 6 行 > 4 → 裁到一半 → 保留 3 行
    expect(result.map(l => l.id)).toEqual(['b2', 'b3', 'b4']);
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

// ==================== issue #6-2：字节记账 + 每端口预算裁剪 ====================

describe('memory budget (issue #6-2)', () => {
  const byteLine = (id: string, len: number): TerminalLine =>
    makeLine(id, { rawData: new Uint8Array(len), content: 'x'.repeat(len) });

  it('accumulates totalBytes on append (rawData length)', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    const append = useTerminalStore.getState().appendTerminalLine;
    append('COM1', byteLine('a', 3));
    append('COM1', byteLine('b', 5));
    expect(useTerminalStore.getState().terminals['COM1'].totalBytes).toBe(8);
  });

  it('accumulates totalBytes for lines without rawData via content bytes', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().appendTerminalLine('COM1', makeLine('a', { content: 'ab' }));
    expect(useTerminalStore.getState().terminals['COM1'].totalBytes).toBe(2);
  });

  it('trims to half when per-port maxBytes (hard constraint) is exceeded', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.setState((state) => {
      state.terminals['COM1'].maxBytes = 9; // 4 行 × 3B = 12B 超出
    });
    const append = useTerminalStore.getState().appendTerminalLine;
    append('COM1', byteLine('a', 3));
    append('COM1', byteLine('b', 3));
    append('COM1', byteLine('c', 3));
    const trimmed = append('COM1', byteLine('d', 3)); // totalBytes 12 > 9
    expect(trimmed).toBe(true);
    const t = useTerminalStore.getState().terminals['COM1'];
    // 4 行 → 一次性裁到一半 → 保留 2 行
    expect(t.lines.map(l => l.id)).toEqual(['c', 'd']);
    expect(t.totalBytes).toBe(6); // 记账重算准确
  });

  it('does not trim while within budget (returns false)', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    const trimmed = useTerminalStore.getState().appendTerminalLine('COM1', byteLine('a', 3));
    expect(trimmed).toBe(false);
    expect(useTerminalStore.getState().terminals['COM1'].lines).toHaveLength(1);
  });

  it('batch append triggers a single 50% trim on byte overflow', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.setState((state) => {
      state.terminals['COM1'].maxBytes = 100;
    });
    // 6 行 × 30B = 180B > 100 → 一次性裁到一半 → 保留 3 行
    const lines: TerminalLine[] = Array.from({ length: 6 }, (_, i) => byteLine(`b${i}`, 30));
    const trimmed = useTerminalStore.getState().appendTerminalLines('COM1', lines);
    expect(trimmed).toBe(true);
    const t = useTerminalStore.getState().terminals['COM1'];
    expect(t.lines.map(l => l.id)).toEqual(['b3', 'b4', 'b5']);
    expect(t.totalBytes).toBe(90);
  });

  it('clearTerminal resets totalBytes', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().appendTerminalLine('COM1', byteLine('a', 10));
    useTerminalStore.getState().clearTerminal('COM1');
    const t = useTerminalStore.getState().terminals['COM1'];
    expect(t.lines).toEqual([]);
    expect(t.totalBytes).toBe(0);
  });

  it('total-budget soft backstop trims when app memory exceeds memoryLimitMb', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    // 模拟状态栏轮询到的应用内存已超总预算（2048MB 默认）
    useAppStore.getState().setSystemStatus({ memoryUsedMb: 3000 });
    useTerminalStore.setState((state) => {
      state.terminals['COM1'].maxBytes = 10_000; // 硬约束不触发
    });
    // 缓冲必须「相当可观」（totalBytes > maxBytes/2）才软裁：12 行 × 600B =
    // 7200B > 5000B，触发软兜底裁剪
    const lines: TerminalLine[] = Array.from({ length: 12 }, (_, i) => byteLine(`s${i}`, 600));
    const trimmed = useTerminalStore.getState().appendTerminalLines('COM1', lines);
    expect(trimmed).toBe(true); // 总预算软兜底触发
    expect(useTerminalStore.getState().terminals['COM1'].lines.map(l => l.id)).toEqual(
      lines.slice(6).map(l => l.id) // 12 行裁到一半 → 保留后 6 行
    );
    // 清理：复位系统状态，避免影响其它用例
    useAppStore.getState().setSystemStatus({ memoryUsedMb: 0 });
  });

  it('does NOT soft-trim a small buffer even when app memory exceeds the budget (half-page refresh fix)', () => {
    // 复现 issue：多串口压测 RSS 超预算，小缓冲（半页）被反复裁掉——
    // 软兜底必须跳过不构成内存元凶的小端口缓冲。
    useTerminalStore.getState().ensureTerminal('COM1');
    useAppStore.getState().setSystemStatus({ memoryUsedMb: 3000 });
    useTerminalStore.setState((state) => {
      state.terminals['COM1'].maxBytes = 10_000;
    });
    const lines: TerminalLine[] = [
      byteLine('a', 100), byteLine('b', 100), byteLine('c', 100), byteLine('d', 100),
    ]; // 400B << maxBytes/2 (5000B)
    const trimmed = useTerminalStore.getState().appendTerminalLines('COM1', lines);
    expect(trimmed).toBe(false); // 小缓冲不裁
    expect(useTerminalStore.getState().terminals['COM1'].lines.map(l => l.id)).toEqual(['a', 'b', 'c', 'd']);
    useAppStore.getState().setSystemStatus({ memoryUsedMb: 0 });
  });

  it('soft total-budget trim is cooldown-gated per port (no repeated halving every batch)', () => {
    // 用独立端口隔离模块级冷却表（同一文件内多个用例共享 lastSoftTrimAt Map）
    useTerminalStore.getState().ensureTerminal('COOL');
    useAppStore.getState().setSystemStatus({ memoryUsedMb: 3000 });
    useTerminalStore.setState((state) => {
      state.terminals['COOL'].maxBytes = 10_000;
    });
    // 第一批：超过 maxBytes/2 → 触发软裁
    const batch = (n: number, base: string, size = 600): TerminalLine[] =>
      Array.from({ length: n }, (_, i) => byteLine(`${base}${i}`, size));
    const t1 = useTerminalStore.getState().appendTerminalLines('COOL', batch(12, 'a'));
    expect(t1).toBe(true);
    // 第二批（同一端口、冷却窗口内）：RSS 仍超预算但冷却未过 → 不再裁
    const t2 = useTerminalStore.getState().appendTerminalLines('COOL', batch(4, 'b'));
    expect(t2).toBe(false);
    useAppStore.getState().setSystemStatus({ memoryUsedMb: 0 });
  });

  it('hard per-port overBytes still trims immediately (not cooldown-gated)', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.setState((state) => {
      state.terminals['COM1'].maxBytes = 100;
    });
    const append = useTerminalStore.getState().appendTerminalLine;
    // 硬约束：无论冷却如何，超 maxBytes 立即裁
    const t1 = append('COM1', byteLine('h1', 60)); // 60 < 100
    expect(t1).toBe(false);
    const t2 = append('COM1', byteLine('h2', 60)); // 120 > 100 → 立即裁（保留 1 行）
    expect(t2).toBe(true);
    expect(useTerminalStore.getState().terminals['COM1'].lines.map(l => l.id)).toEqual(['h2']);
  });
});
