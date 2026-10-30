/** Event time is nullable; legacy timestamps require a confirmed UTC offset. */
export interface ParsedLogLine { time: number | null; direction: 'RX' | 'TX'; content: string }
export interface LogParseOptions { timezoneOffsetMinutes?: number }
const PREFIX = /^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)\]\s?(.*)$/;
export function parseLogTimestamp(value: string, options: LogParseOptions = {}): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac, zone] = m;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s].map(Number);
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(hour, minute, second, Number((frac ?? '').padEnd(3, '0')));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  let offset = options.timezoneOffsetMinutes;
  if (zone === 'Z') offset = 0;
  else if (zone) { const zh = Number(zone.slice(1, 3)), zm = Number(zone.slice(4, 6)); if (zh > 14 || zm > 59) return null; offset = (zh * 60 + zm) * (zone[0] === '+' ? 1 : -1); }
  if (offset === undefined || !Number.isInteger(offset) || Math.abs(offset) > 840) return null;
  return date.getTime() - offset * 60_000;
}
export function parseReplayRecord(line: string, options: LogParseOptions = {}): ParsedLogLine {
  const prefix = PREFIX.exec(line), text = prefix ? prefix[2] : line, direction = /^(RX|TX) (.*)$/.exec(text);
  return { time: prefix ? parseLogTimestamp(prefix[1], options) : null, direction: direction ? direction[1] as 'RX' | 'TX' : 'RX', content: direction ? direction[2] : text };
}
export function parseLogLine(line: string, options: LogParseOptions = {}): ParsedLogLine | null {
  const prefix = PREFIX.exec(line); if (!prefix || !/^(RX|TX) /.test(prefix[2])) return null;
  const parsed = parseReplayRecord(line, options); return parsed.time === null ? null : parsed;
}
export function parseLogContent(content: string, options: LogParseOptions = {}): ParsedLogLine[] {
  const lines = content.split(/\r\n|\n|\r/); if (lines[lines.length - 1] === '') lines.pop(); return lines.map(line => parseReplayRecord(line, options));
}
