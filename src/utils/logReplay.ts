/**
 * 日志回放解析工具
 * 解析 logger 写出的日志行格式：`[YYYY-MM-DD HH:MM:SS.mmm] DIRECTION content`
 * 纯函数，无副作用，便于单测。
 */

export interface ParsedLogLine {
  /** 时间戳（ms epoch） */
  time: number;
  direction: 'RX' | 'TX';
  content: string;
}

// 例: [2026-07-21 22:30:15.123] RX hello world
const LOG_LINE_REGEX = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\] (RX|TX) (.*)$/;

/** 解析单行日志；格式不匹配或时间戳非法时返回 null */
export function parseLogLine(line: string): ParsedLogLine | null {
  const m = LOG_LINE_REGEX.exec(line);
  if (!m) return null;
  // 将 "YYYY-MM-DD HH:MM:SS.mmm" 转为 ISO 形式以便 Date 解析
  const time = new Date(m[1].replace(' ', 'T')).getTime();
  if (Number.isNaN(time)) return null;
  return { time, direction: m[2] as 'RX' | 'TX', content: m[3] };
}

/** 解析整段日志内容，按原顺序返回有效日志行（跳过无法解析的行） */
export function parseLogContent(content: string): ParsedLogLine[] {
  const result: ParsedLogLine[] = [];
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseLogLine(line);
    if (parsed) result.push(parsed);
  }
  return result;
}
