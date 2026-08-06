import { useCallback, useEffect, useRef, useState } from 'react';
import { clampInterval, clampRoundInterval, isValidHexLine } from '../../utils/textSend';

export type PanelRunMode = 'all' | 'fromCursor' | 'loop';

export interface PanelCyclicSendOptions {
  /** 已切分的文本行；空行 / 非法 HEX 行自动跳过（不发送）。 */
  lines: string[];
  /** 行间发送间隔 (ms)；运行时钳制 ≥1ms。 */
  sendIntervalMs: number;
  /** 轮间间隔 (ms)；仅 loop 模式使用；钳制 ≥0ms。 */
  roundIntervalMs: number;
  /** all=从头到尾一次；fromCursor=从 startIndex 到尾一次；loop=循环。 */
  mode: PanelRunMode;
  /** fromCursor 的起始行索引（其余模式忽略；运行时钳制到合法区间）。 */
  startIndex: number;
  /** HEX 模式：逐行做合法性校验，非法行跳过。 */
  isHex: boolean;
  /** 发送一行（await 完成后再排下一行，保序）。 */
  onSend: (line: string, index: number) => Promise<void> | void;
  /** 当前行索引变化回调（null = 运行结束/停止）。 */
  onProgress: (currentLine: number | null) => void;
  /** 发送失败：回调后中止本次运行（不重试，避免循环风暴）。 */
  onError: (err: unknown) => void;
  /** 被跳过的非法 HEX 行数（仅 HEX 模式；每次运行至多回调一次）。 */
  onInvalidHex?: (count: number) => void;
}

export interface PanelCyclicSendReturn {
  running: boolean;
  /** 当前执行到的行索引（null = 未运行）。 */
  currentLine: number | null;
  /** 启动运行。运行中调用为 no-op；无任何可发送行时也为 no-op。 */
  start: () => void;
  /** 停止运行（幂等）。 */
  stop: () => void;
}

function hasSendableLine(lines: string[], isHex: boolean): boolean {
  return lines.some((l) => {
    if (l.trim() === '') return false;
    if (isHex && !isValidHexLine(l)) return false;
    return true;
  });
}

/**
 * 快捷发送面板·文本模式的顺序/循环执行器（递归 setTimeout 状态机）。
 *
 * 设计对照主窗 `useCyclicSend`（互不共享：主窗循环发送命令集，本执行器
 * 只跑面板文本区逐行命令）：
 * - 每次 tick 从 `optsRef` 读取最新参数（间隔/行/模式），主调方改间隔即时生效。
 * - 空行、HEX 模式下非法行自动跳过；非法行计数，单次运行经 `onInvalidHex`
 *   至多回调一次（finish 或手动 stop 时收敛）。
 * - 发送失败 → `onError` 并中止本次运行（不重试）。
 * - 运行中 `lines` 内容变化（面板文本被编辑）自动 stop——行索引与内容错位
 *   后继续发送会串行，宁可终止；组件侧也会在编辑/切模式时主动 stop 兜底。
 * - 卸载时自动停止。
 * - `start()` 在运行中为 no-op；loop 只能在未运行时启动。
 */
export function usePanelCyclicSend(options: PanelCyclicSendOptions): PanelCyclicSendReturn {
  const [running, setRunning] = useState(false);
  const [currentLine, setCurrentLine] = useState<number | null>(null);

  const optsRef = useRef(options);
  optsRef.current = options;

  const ref = useRef({
    timeoutId: null as ReturnType<typeof setTimeout> | null,
    currentIdx: 0,
    pendingStart: false,
    stopped: true,
    invalidCount: 0,
    invalidNotified: false,
  });
  const runningRef = useRef(false);
  const runLinesRef = useRef<string[]>([]);

  /** 收敛运行：清定时器、复位状态、回调进度、按需上报非法 HEX 行数。 */
  const finish = () => {
    const r = ref.current;
    r.stopped = true;
    runningRef.current = false;
    if (r.timeoutId) {
      clearTimeout(r.timeoutId);
      r.timeoutId = null;
    }
    setRunning(false);
    setCurrentLine(null);
    optsRef.current.onProgress(null);
    if (!r.invalidNotified && r.invalidCount > 0) {
      r.invalidNotified = true;
      optsRef.current.onInvalidHex?.(r.invalidCount);
    }
  };

  /** 推进一行 / 处理轮次边界（tick 与 advance 均为普通函数：只读 ref，版本无关）。 */
  const advanceRound = () => {
    const o = optsRef.current;
    const r = ref.current;
    if (r.stopped) return;
    if (r.currentIdx >= o.lines.length - 1) {
      // 本轮最后一行 → 轮次边界。
      if (o.mode === 'loop') {
        r.currentIdx = 0;
        setCurrentLine(0);
        o.onProgress(0);
        r.timeoutId = setTimeout(() => {
          void tick();
        }, clampRoundInterval(o.roundIntervalMs));
      } else {
        finish();
      }
      return;
    }
    r.currentIdx += 1;
    setCurrentLine(r.currentIdx);
    o.onProgress(r.currentIdx);
    r.timeoutId = setTimeout(() => {
      void tick();
    }, clampInterval(o.sendIntervalMs));
  };

  const tick = async () => {
    const o = optsRef.current;
    const r = ref.current;
    if (r.stopped) return;

    // 首次 tick：此刻 optsRef 已含最新 mode/startIndex（start() 内还是旧值）。
    if (r.pendingStart) {
      r.pendingStart = false;
      r.currentIdx =
        o.mode === 'fromCursor'
          ? Math.min(Math.max(0, o.startIndex), o.lines.length - 1)
          : 0;
      setCurrentLine(r.currentIdx);
      o.onProgress(r.currentIdx);
    }

    const idx = r.currentIdx;
    if (idx < 0 || idx >= o.lines.length) {
      finish();
      return;
    }
    const line = o.lines[idx];
    const isEmpty = line.trim() === '';
    const isInvalidHex = o.isHex && !isEmpty && !isValidHexLine(line);
    if (isEmpty || isInvalidHex) {
      if (isInvalidHex) r.invalidCount += 1;
      advanceRound();
      return;
    }

    try {
      await o.onSend(line, idx);
    } catch (err) {
      o.onError(err);
      finish();
      return;
    }
    if (r.stopped) return;
    advanceRound();
  };

  const start = useCallback(() => {
    const o = optsRef.current;
    const r = ref.current;
    if (runningRef.current) return; // 运行中 no-op（loop 也只能在结束后启动）。
    if (!hasSendableLine(o.lines, o.isHex)) return; // 无可发送行。
    r.pendingStart = true;
    r.stopped = false;
    r.invalidCount = 0;
    r.invalidNotified = false;
    runningRef.current = true;
    runLinesRef.current = o.lines;
    setRunning(true);
    r.timeoutId = setTimeout(() => {
      void tick();
    }, 0);
  }, []);

  const stop = useCallback(() => {
    if (!runningRef.current) return;
    finish();
  }, []);

  // 运行中内容变化 → 自动停止（行索引与内容错位保护）。
  useEffect(() => {
    if (runningRef.current && runLinesRef.current !== options.lines) {
      finish();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.lines]);

  // 卸载 → 停止（不触碰 React 状态）。
  useEffect(
    () => () => {
      ref.current.stopped = true;
      runningRef.current = false;
      if (ref.current.timeoutId) {
        clearTimeout(ref.current.timeoutId);
        ref.current.timeoutId = null;
      }
    },
    []
  );

  return { running, currentLine, start, stop };
}
