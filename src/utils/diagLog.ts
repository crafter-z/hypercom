/**
 * 前端诊断日志捕获器
 *
 * 拦截 `console.*`，在不改变原有输出的前提下，把前端日志批量转发到后端，
 * 与后端 `log::*` 统一写入诊断日志文件（issue：诊断日志查看器）。
 *
 * 设计要点:
 * - 模块单例，`setupDiagLogCapture()` 在 App.tsx 调用一次。
 * - 覆盖前先把原始 console 方法存为 `original`，内部错误用原始方法记录，
 *   避免递归进捕获链路。
 * - `forwardEnabled` 随配置 `diagLogEnabled` 同步；默认 true（配置默认开启）。
 * - 批量转发：累计到 50 条或 500ms 静默即 flush，降低 IPC 频率。
 * - 诊断日志弹窗读取的是后端文件（含后端日志 + 转发的前端日志），无独立内存缓冲。
 */
import { diagLogService, type DiagLogEntry } from '../services/tauri';

const CONSOLE_METHODS = ['log', 'debug', 'info', 'warn', 'error'] as const;
type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

const LEVEL_MAP: Record<ConsoleMethod, string> = {
  log: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

/** 原始 console 方法（内部错误日志用，避免递归）。 */
const original: Record<string, (...args: unknown[]) => void> = {};

let installed = false;
/** 是否向前端转发（随 config.diagLogEnabled 同步）。 */
let forwardEnabled = true;
let batch: DiagLogEntry[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

/** 与后端时间戳格式一致的本地时间（%Y-%m-%d %H:%M:%S.mmm）。 */
function now(): string {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

function safeStringify(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (typeof v === 'function') return String(v);
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

function armTimer(): void {
  batchTimer = setTimeout(() => {
    batchTimer = null;
    flush();
  }, 500);
}

function push(method: ConsoleMethod, args: unknown[]): void {
  if (!forwardEnabled) return;
  const message = args.map(safeStringify).join(' ');
  batch.push({ timestamp: now(), level: LEVEL_MAP[method], message });
  if (batch.length >= 50) {
    flush();
    // flush() 在 flushing 时直接 return，该批会滞留；补一个定时器兜底重试。
    if (flushing && !batchTimer) armTimer();
  } else if (!batchTimer) {
    armTimer();
  }
}

function flush(): void {
  if (flushing || batch.length === 0) return;
  const entries = batch;
  batch = [];
  flushing = true;
  diagLogService
    .appendDiagLog(entries)
    .catch((e) => {
      // 用原始方法记录，避免递归进捕获链路。
      original.debug?.('[diagLog] append failed:', e);
    })
    .finally(() => {
      flushing = false;
    });
}

/** 安装 console 捕获（幂等，App.tsx 调用一次）。 */
export function setupDiagLogCapture(): void {
  if (installed) return;
  installed = true;
  for (const m of CONSOLE_METHODS) {
    original[m] = console[m].bind(console);
  }
  for (const m of CONSOLE_METHODS) {
    const method = m;
    (console as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
      original[method](...args);
      push(method, args);
    };
  }
}

/** 随配置同步是否转发前端日志。 */
export function setDiagLogForwardEnabled(enabled: boolean): void {
  forwardEnabled = enabled;
}

/** 丢弃尚未 flush 的前端日志批次（清空诊断日志前调用，避免清完又回写）。 */
export function dropDiagLogPending(): void {
  batch = [];
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
}

/** 解析后的诊断日志行。 */
export interface ParsedLogLine {
  level: string;
  text: string;
}

/**
 * 解析诊断日志行 `YYYY-MM-DD HH:mm:ss.mmm [LEVEL] [target] message`。
 * 无法识别级别时回退为 INFO（保留原文）。
 */
export function parseDiagLogLine(line: string): ParsedLogLine {
  const m = /^.*\s\[(TRACE|DEBUG|INFO|WARN|ERROR)\]\s/.exec(line);
  if (!m) return { level: 'INFO', text: line };
  return { level: m[1], text: line };
}