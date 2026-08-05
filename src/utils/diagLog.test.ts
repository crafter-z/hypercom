import { describe, it, expect } from 'vitest';
import { parseDiagLogLine } from './diagLog';

describe('parseDiagLogLine', () => {
  it('parses level from a standard log line', () => {
    const line = '2026-08-05 20:00:00.123 [INFO] [serial] port opened';
    expect(parseDiagLogLine(line)).toEqual({ level: 'INFO', text: line });
  });

  it('parses ERROR and WARN levels', () => {
    expect(parseDiagLogLine('2026-08-05 20:00:00.123 [ERROR] [a] boom').level).toBe('ERROR');
    expect(parseDiagLogLine('2026-08-05 20:00:00.123 [WARN] [b] watch').level).toBe('WARN');
  });

  it('parses frontend-forwarded entries (frontend target)', () => {
    const line = '2026-08-05 20:00:00.123 [DEBUG] [frontend] console.log hello';
    expect(parseDiagLogLine(line)).toEqual({ level: 'DEBUG', text: line });
  });

  it('falls back to INFO for a line without a recognizable level', () => {
    const bare = 'just some text';
    expect(parseDiagLogLine(bare)).toEqual({ level: 'INFO', text: bare });
  });

  it('keeps the full raw text regardless of level', () => {
    const line = '2026-08-05 [ERROR] [x] msg with spaces and 123';
    expect(parseDiagLogLine(line).text).toBe(line);
  });
});