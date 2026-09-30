import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CornerDownRight, ListRestart, Play, Repeat, SkipForward, Square } from 'lucide-react';
import { notifyError, notifyInfo } from '../../stores/useToastStore';
import { clampInterval, clampRoundInterval, isValidHexLine, splitSendLines } from '../../utils/textSend';
import { useSequentialSend } from '../OperationPanel/hooks/useSequentialSend';
import type { LineEnding, TextSendConfig } from '../../types';

/** 发送成功的行内闪烁时长（与列表模式共用"短促闪烁"反馈语言）。 */
const FLASH_MS = 260;

/** 文本模式的三种顺序执行方式；loop 会回到首行并按轮次间隔重跑。 */
type PanelRunMode = 'all' | 'fromCursor' | 'loop';

interface QuickSendTextProps {
  /** 文本内容由面板持有：切到列表模式再切回来不能丢。 */
  text: string;
  onTextChange: (text: string) => void;
  config: TextSendConfig;
  canSend: boolean;
  /** 发送一行（拒绝 = 发送失败），顺序执行靠它 await 保序。 */
  onSendLine: (content: string, isHex: boolean, lineEnding: LineEnding) => Promise<void>;
}

/**
 * 快捷发送面板 · 文本模式。
 *
 * 每行一条命令，四种执行方式（当前行 / 当前行并下移 / 顺序 / 从光标 / 循环）。
 * 调度交给共享引擎 `useSequentialSend`（S-F1）：计时器、可见性补发、重入防护、
 * 编辑自停、卸载自停都在引擎里，这里只决定「这一轮做什么」。
 *
 * 语义保持与原面板一致：空行跳过；HEX 模式下非法行跳过并计数（每次运行至多提示
 * 一次）；发送失败即中止本轮（不重试）。
 */
const QuickSendText: React.FC<QuickSendTextProps> = ({
  text,
  onTextChange,
  config,
  canSend,
  onSendLine,
}) => {
  const { t } = useTranslation();
  const [cursorLine, setCursorLine] = useState(0);
  const [flashLine, setFlashLine] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [runLine, setRunLine] = useState<number | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lines = useMemo(() => splitSendLines(text), [text]);
  const hasContent = useMemo(() => lines.some((l) => l.trim() !== ''), [lines]);

  // 运行期参数全部经 ref 读取：一次运行中途改间隔/模式即时生效，且不必重建引擎。
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const configRef = useRef(config);
  configRef.current = config;
  const cursorLineRef = useRef(cursorLine);
  cursorLineRef.current = cursorLine;
  const sendRef = useRef(onSendLine);
  sendRef.current = onSendLine;
  const runRef = useRef({
    mode: 'all' as PanelRunMode,
    /** 下一次迭代才解析起始行——start() 时 configRef 还是旧值。 */
    pendingStart: true,
    idx: 0,
    invalidCount: 0,
    invalidNotified: false,
  });

  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  // 文本收缩时夹回光标行号。
  useEffect(() => {
    setCursorLine((c) => Math.min(c, Math.max(lines.length - 1, 0)));
  }, [lines.length]);

  /** 本轮推进一格：返回下一次迭代的延迟；本轮结束返回 null。 */
  const advance = useCallback((): number | null => {
    const run = runRef.current;
    const ls = linesRef.current;
    const cfg = configRef.current;
    if (run.idx >= ls.length - 1) {
      if (run.mode !== 'loop') return null;
      run.idx = 0;
      setRunLine(0);
      return clampRoundInterval(cfg.roundIntervalMs);
    }
    run.idx += 1;
    setRunLine(run.idx);
    return clampInterval(cfg.sendIntervalMs);
  }, []);

  /** 非法 HEX 行数每次运行至多提示一次（收敛点：本轮结束）。 */
  const reportInvalidHex = useCallback(() => {
    const run = runRef.current;
    if (run.invalidNotified || run.invalidCount === 0) return;
    run.invalidNotified = true;
    notifyInfo('quickSend.invalidHex');
  }, []);

  const loop = useSequentialSend({
    // 首个迭代与旧实现一致走 0ms 定时器：立即发送，但不同步递归。
    firstTickMs: 0,
    // 运行中文本被编辑 → 自动停止（行索引与内容错位后继续发送会串行）。
    autoStopOnChange: lines,
    step: async () => {
      const run = runRef.current;
      const ls = linesRef.current;
      const cfg = configRef.current;
      if (run.pendingStart) {
        run.pendingStart = false;
        run.idx =
          run.mode === 'fromCursor'
            ? Math.min(Math.max(0, cursorLineRef.current), Math.max(ls.length - 1, 0))
            : 0;
        setRunLine(run.idx);
      }
      const idx = run.idx;
      if (idx < 0 || idx >= ls.length) return null;
      const line = ls[idx];
      const isEmpty = line.trim() === '';
      const invalidHex = cfg.isHex && !isEmpty && !isValidHexLine(line);
      if (isEmpty || invalidHex) {
        if (invalidHex) run.invalidCount += 1;
        return advance();
      }
      await sendRef.current(line, cfg.isHex, cfg.lineEnding);
      return advance();
    },
    onStepError: (err) => {
      // 发送失败即中止本轮：循环里重试失败发送会变成风暴。
      notifyError(err);
      return null;
    },
    onStop: () => {
      setRunning(false);
      setRunLine(null);
      reportInvalidHex();
    },
  });

  const startRun = (mode: PanelRunMode) => {
    const run = runRef.current;
    if (loop.isRunning()) return;
    const ls = linesRef.current;
    const cfg = configRef.current;
    // 无可发送行（全空 / HEX 模式全非法）时不动状态，按钮语义等同禁用。
    if (!ls.some((l) => l.trim() !== '' && (!cfg.isHex || isValidHexLine(l)))) return;
    run.mode = mode;
    run.pendingStart = true;
    run.invalidCount = 0;
    run.invalidNotified = false;
    setRunning(true);
    loop.start();
  };

  /** textarea 光标 → 行号（selectionStart 换算）。 */
  const syncCursorLine = (el: HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? 0;
    const upTo = el.value.slice(0, pos).split(/\r?\n/).length - 1;
    setCursorLine(Math.min(upTo, Math.max(lines.length - 1, 0)));
  };

  /** 把 textarea 光标移动到下一行行首（issue #6-3）。 */
  const moveCursorToNextLine = () => {
    const el = textareaRef.current;
    if (!el) return;
    const value = el.value;
    const pos = el.selectionStart ?? 0;
    const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
    const lineEndIdx = value.indexOf('\n', lineStart);
    const nextPos = lineEndIdx === -1 ? value.length : lineEndIdx + 1;
    el.setSelectionRange(nextPos, nextPos);
    el.focus();
    // setSelectionRange 不触发 onSelect/onClick，手动同步光标行号。
    const upTo = value.slice(0, nextPos).split(/\r?\n/).length - 1;
    setCursorLine(Math.min(upTo, Math.max(lines.length - 1, 0)));
  };

  const flashLineAt = (idx: number) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    setFlashLine(idx);
    flashTimerRef.current = setTimeout(() => setFlashLine(null), FLASH_MS);
  };

  /**
   * 执行当前行。`advanceCursor = true` 时随后把光标移到下一行（issue #6-3 的
   * 「执行并下移」按钮）——两者只差这一步，合并成一个实现，HEX 校验等前置条件
   * 只写一遍。
   */
  const runCurrentLine = (advanceCursor: boolean) => {
    if (running || !canSend) return;
    const idx = Math.min(cursorLine, Math.max(lines.length - 1, 0));
    const line = lines[idx];
    if (!line || line.trim() === '') {
      if (advanceCursor) moveCursorToNextLine();
      return;
    }
    if (config.isHex && !isValidHexLine(line)) {
      notifyInfo('quickSend.invalidHex');
      return;
    }
    flashLineAt(idx);
    void onSendLine(line, config.isHex, config.lineEnding).catch((e) => notifyError(e));
    if (advanceCursor) moveCursorToNextLine();
  };

  /** 当前行指示（运行行优先，其次单发闪烁行，最后光标行）。 */
  const displayLineIdx = runLine ?? flashLine ?? Math.min(cursorLine, Math.max(lines.length - 1, 0));
  const lineLabel =
    lines.length === 0 ? '0/0' : `${Math.min(displayLineIdx, lines.length - 1) + 1}/${lines.length}`;

  return (
    <div className="quicksend-text-mode">
      <textarea
        ref={textareaRef}
        className="quicksend-textarea"
        value={text}
        placeholder={t('quickSend.textPlaceholder')}
        spellCheck={false}
        onChange={(e) => onTextChange(e.target.value)}
        onSelect={(e) => syncCursorLine(e.currentTarget)}
        onClick={(e) => syncCursorLine(e.currentTarget)}
        onKeyUp={(e) => syncCursorLine(e.currentTarget)}
      />
      <div className="quicksend-run-controls">
        <span className={`quicksend-current-line${running ? ' is-running' : ''}`}>
          {t('quickSend.currentLine')}: {lineLabel}
        </span>
        <div className="quicksend-run-buttons">
          <button
            type="button"
            className="quicksend-run-btn"
            disabled={running || !canSend || !hasContent}
            onClick={() => runCurrentLine(false)}
            title={t('quickSend.runCurrentLine')}
            aria-label={t('quickSend.runCurrentLine')}
          >
            <Play size={12} />
          </button>
          <button
            type="button"
            className="quicksend-run-btn"
            disabled={running || !canSend || !hasContent}
            onClick={() => runCurrentLine(true)}
            title={t('quickSend.runCurrentLineAdvance')}
            aria-label={t('quickSend.runCurrentLineAdvance')}
          >
            <CornerDownRight size={12} />
          </button>
          <button
            type="button"
            className="quicksend-run-btn"
            disabled={running || !canSend || !hasContent}
            onClick={() => startRun('all')}
            title={t('quickSend.runAll')}
            aria-label={t('quickSend.runAll')}
          >
            <ListRestart size={12} />
          </button>
          <button
            type="button"
            className="quicksend-run-btn"
            disabled={running || !canSend || !hasContent}
            onClick={() => startRun('fromCursor')}
            title={t('quickSend.runFromCursor')}
            aria-label={t('quickSend.runFromCursor')}
          >
            <SkipForward size={12} />
          </button>
          {running ? (
            <button
              type="button"
              className="quicksend-run-btn is-stop"
              onClick={loop.stop}
              title={t('quickSend.stopLoop')}
              aria-label={t('quickSend.stopLoop')}
            >
              <Square size={12} />
            </button>
          ) : (
            <button
              type="button"
              className="quicksend-run-btn is-loop"
              disabled={!canSend || !hasContent}
              onClick={() => startRun('loop')}
              title={t('quickSend.runLoop')}
              aria-label={t('quickSend.runLoop')}
            >
              <Repeat size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default QuickSendText;
