import { describe, it, expect } from 'vitest';
import { parseLogLine, parseLogContent } from './logReplay';

describe('parseLogLine', () => {
  it('parses a standard RX line with milliseconds', () => {
    const line = parseLogLine('[2026-07-21 22:30:15.123] RX hello world');
    expect(line).not.toBeNull();
    expect(line!.direction).toBe('RX');
    expect(line!.content).toBe('hello world');
    expect(line!.time).toBe(new Date('2026-07-21T22:30:15.123').getTime());
  });

  it('parses a TX line without milliseconds', () => {
    const line = parseLogLine('[2026-07-21 22:30:15] TX AT+PING');
    expect(line).not.toBeNull();
    expect(line!.direction).toBe('TX');
    expect(line!.content).toBe('AT+PING');
  });

  it('preserves HEX-style content verbatim', () => {
    const line = parseLogLine('[2026-07-21 22:30:15.001] RX 48 65 6C 6C 6F');
    expect(line!.content).toBe('48 65 6C 6C 6F');
  });

  it('returns null for non-matching lines', () => {
    expect(parseLogLine('garbage line')).toBeNull();
    expect(parseLogLine('')).toBeNull();
    expect(parseLogLine('[bad-timestamp] RX x')).toBeNull();
  });

  it('returns null for invalid direction', () => {
    expect(parseLogLine('[2026-07-21 22:30:15.123] XX hello')).toBeNull();
  });

  it('allows empty content after direction', () => {
    const line = parseLogLine('[2026-07-21 22:30:15.123] RX ');
    expect(line).not.toBeNull();
    expect(line!.content).toBe('');
  });
});

describe('parseLogContent', () => {
  it('parses multiple lines in order, skipping invalid ones', () => {
    const content = [
      '[2026-07-21 22:30:15.000] TX AT',
      'corrupted line without format',
      '[2026-07-21 22:30:15.100] RX OK',
      '',
      '[2026-07-21 22:30:15.200] RX DONE',
    ].join('\n');
    const lines = parseLogContent(content);
    expect(lines).toHaveLength(3);
    expect(lines[0].content).toBe('AT');
    expect(lines[1].content).toBe('OK');
    expect(lines[2].content).toBe('DONE');
  });

  it('handles CRLF line endings', () => {
    const content = '[2026-07-21 22:30:15.000] TX A\r\n[2026-07-21 22:30:15.050] RX B\r\n';
    const lines = parseLogContent(content);
    expect(lines).toHaveLength(2);
    expect(lines[1].content).toBe('B');
  });

  it('returns empty array for empty content', () => {
    expect(parseLogContent('')).toHaveLength(0);
  });

  it('computes increasing timestamps for delay calculation', () => {
    const content = [
      '[2026-07-21 22:30:15.000] RX a',
      '[2026-07-21 22:30:15.250] RX b',
    ].join('\n');
    const lines = parseLogContent(content);
    expect(lines[1].time - lines[0].time).toBe(250);
  });
});
