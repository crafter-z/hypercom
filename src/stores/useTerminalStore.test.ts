import { describe, it, expect, beforeEach } from 'vitest';
import { useTerminalStore } from './useTerminalStore';

// 纯显示态（方案B, issue #14）：行缓冲已移入 TerminalViewportManager 的环形缓冲区，
// 行追加/裁剪/清空/内存预算由 src/utils/terminal/TerminalBuffer.test.ts 覆盖，
// 本文件只测显示字段（scrollLocked / showTimestamp / displayFormat / encoding / connectedAt）。
beforeEach(() => {
  useTerminalStore.setState({ terminals: {} });
});

// ==================== ensureTerminal ====================

describe('ensureTerminal', () => {
  it('creates terminal with correct display defaults', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    const t = useTerminalStore.getState().terminals['COM1'];
    expect(t).toBeDefined();
    expect(t.scrollLocked).toBe(true);
    expect(t.showTimestamp).toBe(true);
    expect(t.displayFormat).toBe('string');
    expect(t.encoding).toBe('ASCII');
    expect(t.connectedAt).toBeNull();
  });

  it('is idempotent — calling twice does not reset changed config', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().setTerminalConfig('COM1', {
      scrollLocked: false,
      displayFormat: 'hex',
    });
    // Call again — must not clobber the patched fields
    useTerminalStore.getState().ensureTerminal('COM1');
    const t = useTerminalStore.getState().terminals['COM1'];
    expect(t.scrollLocked).toBe(false);
    expect(t.displayFormat).toBe('hex');
    expect(t.encoding).toBe('ASCII'); // untouched defaults preserved
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
    expect(t.encoding).toBe('ASCII'); // unchanged
    expect(t.connectedAt).toBeNull(); // unchanged
  });

  it('is no-op for non-existent port', () => {
    useTerminalStore.getState().setTerminalConfig('GHOST', { scrollLocked: false });
    expect(useTerminalStore.getState().terminals['GHOST']).toBeUndefined();
  });
});

// ==================== setTerminalEncoding ====================

describe('setTerminalEncoding', () => {
  it('updates only the encoding field', () => {
    useTerminalStore.getState().ensureTerminal('COM1');
    useTerminalStore.getState().setTerminalConfig('COM1', { scrollLocked: false });
    useTerminalStore.getState().setTerminalEncoding('COM1', 'UTF-8');
    const t = useTerminalStore.getState().terminals['COM1'];
    expect(t.encoding).toBe('UTF-8');
    expect(t.scrollLocked).toBe(false); // unchanged
    expect(t.showTimestamp).toBe(true); // unchanged
    expect(t.displayFormat).toBe('string'); // unchanged
    expect(t.connectedAt).toBeNull(); // unchanged
  });

  it('is no-op for non-existent port', () => {
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

  it('is no-op for non-existent port', () => {
    useTerminalStore.getState().setTerminalConnectedAt('GHOST', 12345);
    expect(useTerminalStore.getState().terminals['GHOST']).toBeUndefined();
  });
});
