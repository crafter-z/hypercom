import { describe, it, expect } from 'vitest';
import { parseLogLine, parseLogContent, parseLogTimestamp } from './logReplay';
const utc = { timezoneOffsetMinutes: 0 };
describe('replay timestamp semantics', () => {
  it('does not guess timezone for a legacy log', () => {
    expect(parseLogTimestamp('2026-07-21 22:30:15.123')).toBeNull();
    expect(parseLogContent('[2026-07-21 22:30:15.123] RX hello')[0]).toEqual({ time: null, direction: 'RX', content: 'hello' });
  });
  it('uses confirmed recording offset, not the current machine timezone', () => {
    expect(parseLogLine('[2026-07-21 22:30:15.123] RX hello', { timezoneOffsetMinutes: 480 })).toEqual({ time: Date.parse('2026-07-21T14:30:15.123Z'), direction: 'RX', content: 'hello' });
    expect(parseLogLine('[2026-07-21 22:30:15] TX AT', utc)?.direction).toBe('TX');
  });
  it('honors explicit timezone and crosses midnight correctly', () => {
    const lines = parseLogContent('[2026-10-30 23:59:59.999+08:00] RX a\n[2026-10-31 00:00:00.001+08:00] TX b');
    expect(lines[1].time! - lines[0].time!).toBe(2);
    expect(parseLogTimestamp('2026-10-30 12:00:00Z', { timezoneOffsetMinutes: 480 })).toBe(Date.parse('2026-10-30T12:00:00Z'));
  });
  it.each(['2026-02-30 12:00:00', '2026-01-01 25:00:00', '2026-13-01 12:00:00', '2026-01-01 00:60:00', '2026-01-01 00:00:00+15:00'])('rejects invalid calendar/time %s', value => expect(parseLogTimestamp(value, utc)).toBeNull());
  it('preserves unknown rows, interior blank rows and original record order', () => {
    const lines = parseLogContent('RX a\n\nplain\r\nTX b\r\n');
    expect(lines).toEqual([{ time: null, direction: 'RX', content: 'a' }, { time: null, direction: 'RX', content: '' }, { time: null, direction: 'RX', content: 'plain' }, { time: null, direction: 'TX', content: 'b' }]);
    expect(parseLogContent('')).toEqual([]);
  });
  it('keeps duplicate timestamps, rollback, HEX and empty content verbatim', () => {
    const lines = parseLogContent('[2026-01-01 00:00:02Z] RX 48 65\n[2026-01-01 00:00:02Z] TX \n[2026-01-01 00:00:01Z] RX old');
    expect(lines.map(line => line.content)).toEqual(['48 65', '', 'old']);
    expect(lines[2].time!).toBeLessThan(lines[0].time!);
    expect(parseLogLine('garbage', utc)).toBeNull();
    expect(parseLogLine('[2026-01-01 00:00:00Z] XX nope')).toBeNull();
  });
});
