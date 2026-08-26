import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CornerDownRight,
  ListRestart,
  Pencil,
  Play,
  Repeat,
  Save,
  Search,
  SkipForward,
  Square,
  X,
} from 'lucide-react';
import {
  eventService,
  popoutEventService,
  serialService,
  storageService,
  type AvailablePortInfo,
} from '../../services/tauri';
import { useRuleStore } from '../../stores/useRuleStore';
import { notifyError, notifyInfo } from '../../stores/useToastStore';
import { LINE_ENDING_VALUES, lineEndingLabelKey } from '../../utils/sendUtils';
import { clampInterval, clampRoundInterval, isValidHexLine, splitSendLines } from '../../utils/textSend';
import { usePanelCyclicSend, type PanelRunMode } from './usePanelCyclicSend';
import type { LineEnding, SendCommand, SendCommandSet, TextSendConfig } from '../../types';

/** 发送成功的行内闪烁时长（与内联条共用"短促闪烁"反馈语言）。 */
const FLASH_MS = 260;

/** 文本模式发送间隔 / 轮次间隔的可调上限（ms）。 */
const SEND_INTERVAL_MAX = 60_000;
const ROUND_INTERVAL_MAX = 600_000;

/** 面板文本模式配置的 localStorage 键（弹窗独立 webview 的本地持久化）。 */
const TEXT_CONFIG_KEY = 'hypercom.quickSend.textConfig';

const DEFAULT_TEXT_CONFIG: TextSendConfig = {
  portId: '',
  lineEnding: '\\r\\n',
  isHex: false,
  sendIntervalMs: 200,
  roundIntervalMs: 1000,
};

/** 读取上次使用的文本发送配置；JSON 损坏/缺字段时回退默认值。 */
function loadTextConfig(): TextSendConfig {
  try {
    const raw = localStorage.getItem(TEXT_CONFIG_KEY);
    if (!raw) return { ...DEFAULT_TEXT_CONFIG };
    const parsed = JSON.parse(raw) as Partial<TextSendConfig>;
    const lineEnding = (LINE_ENDING_VALUES as readonly string[]).includes(parsed.lineEnding ?? '')
      ? (parsed.lineEnding as LineEnding)
      : DEFAULT_TEXT_CONFIG.lineEnding;
    return {
      portId: typeof parsed.portId === 'string' ? parsed.portId : '',
      lineEnding,
      isHex: typeof parsed.isHex === 'boolean' ? parsed.isHex : DEFAULT_TEXT_CONFIG.isHex,
      sendIntervalMs: clampInterval(parsed.sendIntervalMs ?? DEFAULT_TEXT_CONFIG.sendIntervalMs),
      roundIntervalMs: clampRoundInterval(
        parsed.roundIntervalMs ?? DEFAULT_TEXT_CONFIG.roundIntervalMs
      ),
    };
  } catch {
    return { ...DEFAULT_TEXT_CONFIG };
  }
}

interface EditDraft {
  name: string;
  content: string;
  appendLineEnding: LineEnding;
  type: 'string' | 'hex';
}

/**
 * 快捷发送面板（瘦高独立窗内容，宿主无关组件，issue #5-4 双模式重构）。
 *
 * 架构原则：弹窗与主窗不共享可变前端态，只交换意图/事件。
 * - 数据：主窗 `useRuleStore` 是唯一真相——mount 时先读 `load_command_sets`
 *   取持久化基线，随后 `command-sets:changed` 携带完整命令集载荷到达直接消费；
 *   request-sync 触发主窗回放一次当前命令集。
 * - 模式 A（命令列表）：整行可点 = 发送；行内「修改」按钮展开就地编辑器
 *   （名称/内容/行尾/STR·HEX），保存后经 `save_command_set` 持久化并同步本地。
 *   目标端口来自共享参数栏（`portId` 直传主窗，缺省跟随主窗活动标签）。
 * - 模式 B（文本）：textarea 每行一条命令；当前行 / 顺序 / 从光标处 / 循环
 *   四种执行方式，由 `usePanelCyclicSend` 递归 setTimeout 状态机驱动；
 *   空行与非法 HEX 行跳过，运行中编辑文本自动停止。
 * - 键盘流（列表模式）：`/` 聚焦搜索，`↑/↓` 移动光标，`Enter` 发送高亮命令。
 */
const QuickSendPanel: React.FC = () => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'list' | 'text'>('list');

  // ---- 模式 A（列表）----
  const [sets, setSets] = useState<SendCommandSet[]>([]);
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [flashingId, setFlashingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);

  // ---- 共享参数（两种模式）----
  const [config, setConfig] = useState<TextSendConfig>(loadTextConfig);
  const [ports, setPorts] = useState<AvailablePortInfo[]>([]);
  const [activePortId, setActivePortId] = useState<string | null>(null);

  // ---- 模式 B（文本）----
  const [text, setText] = useState('');
  const [textCursorLine, setTextCursorLine] = useState(0);
  const [flashLine, setFlashLine] = useState<number | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 应用一组命令集；选中集被删除时回退到第一个。 */
  const applySets = useCallback((next: SendCommandSet[]) => {
    setSets(next);
    setSelectedSetId((prev) =>
      prev != null && next.some((s) => s.id === prev) ? prev : next[0]?.id ?? null
    );
  }, []);

  /** 回库重读命令集（mount 时取持久化基线；随后 request-sync 载荷纠正为含未保存编辑的实时态）。 */
  const reload = useCallback(() => {
    storageService
      .loadCommandSets()
      .then(applySets)
      .catch((e) => console.debug('[QuickSendPanel] loadCommandSets failed:', e));
  }, [applySets]);

  useEffect(() => {
    reload();
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    // 监听器注册是异步的：必须 await 就绪后再发 request-sync，
    // 否则主窗回放的 active-tab:changed 可能早于监听器到达而丢失。
    void (async () => {
      try {
        const [unCmdSets, unActiveTab] = await Promise.all([
          popoutEventService.onCommandSetsChanged(applySets),
          popoutEventService.onActiveTabChanged((payload) => setActivePortId(payload.portId)),
        ]);
        if (cancelled) {
          unCmdSets();
          unActiveTab();
          return;
        }
        unlisteners.push(unCmdSets, unActiveTab);
        // 挂载并对表完毕 → 请求主窗回放一次活动标签，指示器即刻显示真实目标。
        await popoutEventService.emitRequestSync();
      } catch (e) {
        console.debug('[QuickSendPanel] listener registration failed:', e);
      }
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, [reload]);

  // 端口列表：弹窗是独立 webview，无同步的 store——按需调用全局后端。
  useEffect(() => {
    let cancelled = false;
    serialService
      .listAvailablePorts()
      .then((list) => {
        if (!cancelled) setPorts(list);
      })
      .catch((e) => console.debug('[QuickSendPanel] listAvailablePorts failed:', e));
    return () => {
      cancelled = true;
    };
  }, []);

  // issue #7-5：「发送到」提示灯跟随串口真实连接状态——订阅全局 serial:status
  // 事件维护已连接端口集合（Tauri 事件对全部 webview 可见，弹窗可直接监听）；
  // 挂载对表时主窗经 port-statuses:sync 回放一次全量状态，弹窗在已连接状态下
  // 打开时提示灯也立即准确。
  const [connectedPortIds, setConnectedPortIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    let cancelled = false;
    let unlisteners: Array<() => void> = [];
    Promise.all([
      eventService.onSerialStatus((event) => {
        if (cancelled) return;
        setConnectedPortIds((prev) => {
          const next = new Set(prev);
          if (event.status === 'connected') {
            next.add(event.port_id);
          } else {
            next.delete(event.port_id);
          }
          return next;
        });
      }),
      popoutEventService.onPortStatusesSync((items) => {
        if (cancelled) return;
        setConnectedPortIds(new Set(items.filter((i) => i.status === 'connected').map((i) => i.portId)));
      }),
    ])
      .then(([u1, u2]) => {
        if (cancelled) {
          u1();
          u2();
          return;
        }
        unlisteners = [u1, u2];
      })
      .catch((e) => console.debug('[QuickSendPanel] status listeners failed:', e));
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, []);

  // 持久化的 portId 已不存在（端口拔出/改名）→ 回退到跟随活动标签。
  useEffect(() => {
    if (config.portId && !ports.some((p) => p.id === config.portId)) {
      setConfig((c) => ({ ...c, portId: '' }));
    }
  }, [ports, config.portId]);

  // 面板参数变更即写 localStorage（下次打开恢复；损坏 JSON 由 loadTextConfig 兜底）。
  useEffect(() => {
    try {
      localStorage.setItem(TEXT_CONFIG_KEY, JSON.stringify(config));
    } catch {
      // 存储不可用（隐私模式等）时静默跳过，不影响功能。
    }
  }, [config]);

  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    []
  );

  const selectedSet = useMemo(
    () => sets.find((s) => s.id === selectedSetId) ?? null,
    [sets, selectedSetId]
  );

  /** 选中集按 order 排序后按 名称+内容 模糊过滤（大小写不敏感）。 */
  const filtered = useMemo(() => {
    if (!selectedSet) return [];
    const sorted = [...selectedSet.commands].sort((a, b) => a.order - b.order);
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (c) => c.name.toLowerCase().includes(q) || c.content.toLowerCase().includes(q)
    );
  }, [selectedSet, query]);

  // 列表收缩（过滤/重载）时把光标夹回合法区间。
  useEffect(() => {
    setCursor((c) => (filtered.length === 0 ? 0 : Math.min(c, filtered.length - 1)));
  }, [filtered.length]);

  // 光标高亮行保持可见。
  useEffect(() => {
    listRef.current
      ?.querySelector('.quicksend-row.is-cursor')
      ?.scrollIntoView({ block: 'nearest' });
  }, [cursor, filtered.length]);

  // ---- 共享参数 / 目标端口 ----

  /** 实际发送目标：手动选择的端口优先，缺省跟随主窗活动标签。 */
  const effectivePortId = config.portId || activePortId;
  const canSend = effectivePortId != null;

  /** 发出一条命令（意图事件；portId 缺省时主窗发送到自己的活动标签）。 */
  const emitSendLine = useCallback(
    (content: string, isHex: boolean, lineEnding: LineEnding) =>
      popoutEventService.emitSendCommand({
        content,
        isHex,
        lineEnding,
        portId: config.portId || undefined,
      }),
    [config.portId]
  );

  /** 行内闪烁反馈。 */
  const flashRow = useCallback((id: string | null) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    if (id != null) {
      setFlashingId(id);
      setFlashLine(null);
      flashTimerRef.current = setTimeout(() => setFlashingId(null), FLASH_MS);
    }
  }, []);

  /** 模式 A：发送 = 命令自身携带的类型/行尾；目标端口来自共享参数栏。 */
  const sendCommand = useCallback(
    (cmd: SendCommand) => {
      if (!canSend) return;
      void emitSendLine(cmd.content, cmd.type === 'hex', cmd.appendLineEnding).catch((e) =>
        console.debug('[QuickSendPanel] emitSendCommand failed:', e)
      );
      flashRow(cmd.id);
    },
    [canSend, emitSendLine, flashRow]
  );

  // ---- 模式 A：就地编辑 ----

  const startEdit = useCallback((cmd: SendCommand) => {
    setEditingId(cmd.id);
    setEditDraft({
      name: cmd.name,
      content: cmd.content,
      appendLineEnding: cmd.appendLineEnding,
      type: cmd.type,
    });
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditDraft(null);
  }, []);

  /** 命令集管理（新建/删除/排序）仍由主窗配置弹窗负责（面板内仅支持逐条编辑）。 */
  const handleOpenSetEditor = useCallback(() => {
    void popoutEventService
      .emitOpenConfig({ page: 'commands' })
      .catch((e) => console.debug('[QuickSendPanel] emitOpenConfig failed:', e));
  }, []);

  /** 保存编辑：写回当前命令集并持久化（主窗经 command-sets:changed 最终对齐）。 */
  const saveEdit = useCallback(() => {
    if (!selectedSet || !editDraft || editingId == null) return;
    const updatedCommands = selectedSet.commands.map((c) =>
      c.id === editingId ? { ...c, ...editDraft } : c
    );
    const updatedSet: SendCommandSet = { ...selectedSet, commands: updatedCommands };
    useRuleStore.getState().updateSendCommandSet(updatedSet.id, { commands: updatedCommands });
    void storageService.saveCommandSet(updatedSet).catch((e) => notifyError(e));
    setSets((prev) => prev.map((s) => (s.id === updatedSet.id ? updatedSet : s)));
    cancelEdit();
  }, [selectedSet, editDraft, editingId, cancelEdit]);

  // ---- 模式 B：文本 ----

  const lines = useMemo(() => splitSendLines(text), [text]);
  const hasContent = useMemo(() => lines.some((l) => l.trim() !== ''), [lines]);

  /** textarea 光标 → 行号（selectionStart 换算）。 */
  const updateCursorLine = useCallback(
    (el: HTMLTextAreaElement) => {
      const pos = el.selectionStart ?? 0;
      const upTo = el.value.slice(0, pos).split(/\r?\n/).length - 1;
      setTextCursorLine(Math.min(upTo, Math.max(lines.length - 1, 0)));
    },
    [lines.length]
  );

  // 文本收缩时夹回光标行号。
  useEffect(() => {
    setTextCursorLine((c) => Math.min(c, Math.max(lines.length - 1, 0)));
  }, [lines.length]);

  const handleSendLine = useCallback(
    async (line: string) => {
      await emitSendLine(line, config.isHex, config.lineEnding);
    },
    [emitSendLine, config.isHex, config.lineEnding]
  );

  const handleRunError = useCallback((err: unknown) => notifyError(err), []);
  const handleInvalidHex = useCallback(() => notifyInfo('quickSend.invalidHex'), []);

  const [runMode, setRunMode] = useState<PanelRunMode>('all');
  const { running, currentLine: runLine, start, stop } = usePanelCyclicSend({
    lines,
    sendIntervalMs: config.sendIntervalMs,
    roundIntervalMs: config.roundIntervalMs,
    mode: runMode,
    startIndex: textCursorLine,
    isHex: config.isHex,
    onSend: handleSendLine,
    onError: handleRunError,
    onInvalidHex: handleInvalidHex,
  });

  const startRun = useCallback(
    (m: PanelRunMode) => {
      setRunMode(m);
      start();
    },
    [start]
  );

  /** 单发当前行（不经执行器：无时序，直接 emit + 短暂闪烁）。 */
  const runCurrentLineOnly = useCallback(() => {
    if (running || !canSend) return;
    const idx = Math.min(textCursorLine, Math.max(lines.length - 1, 0));
    const line = lines[idx];
    if (!line || line.trim() === '') return;
    if (config.isHex && !isValidHexLine(line)) {
      notifyInfo('quickSend.invalidHex');
      return;
    }
    setFlashLine(idx);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashLine(null), FLASH_MS);
    void emitSendLine(line, config.isHex, config.lineEnding).catch((e) => notifyError(e));
  }, [running, canSend, textCursorLine, lines, config.isHex, config.lineEnding, emitSendLine]);

  /** 把 textarea 光标移动到下一行行首（issue #6-3）。 */
  const moveCursorToNextLine = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const value = el.value;
    const pos = el.selectionStart ?? 0;
    const lineStart = value.lastIndexOf('\n', pos - 1) + 1;
    const lineEndIdx = value.indexOf('\n', lineStart);
    const nextPos = lineEndIdx === -1 ? value.length : lineEndIdx + 1;
    el.setSelectionRange(nextPos, nextPos);
    el.focus();
    // setSelectionRange 不触发 onSelect/onClick，手动同步光标行号
    const upTo = value.slice(0, nextPos).split(/\r?\n/).length - 1;
    setTextCursorLine(Math.min(upTo, Math.max(lines.length - 1, 0)));
  }, [lines.length]);

  /** 执行当前行，执行完毕后把光标移到下一行（issue #6-3 新增按钮）。 */
  const runCurrentLineAndAdvance = useCallback(() => {
    if (running || !canSend) return;
    const idx = Math.min(textCursorLine, Math.max(lines.length - 1, 0));
    const line = lines[idx];
    if (!line || line.trim() === '') {
      moveCursorToNextLine();
      return;
    }
    if (config.isHex && !isValidHexLine(line)) {
      notifyInfo('quickSend.invalidHex');
      return;
    }
    setFlashLine(idx);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashLine(null), FLASH_MS);
    void emitSendLine(line, config.isHex, config.lineEnding).catch((e) => notifyError(e));
    moveCursorToNextLine();
  }, [running, canSend, textCursorLine, lines, config.isHex, config.lineEnding, emitSendLine, moveCursorToNextLine]);

  /** 切换模式：运行中先停止；就地编辑一并收起。 */
  const switchMode = useCallback(
    (m: 'list' | 'text') => {
      if (m === mode) return;
      if (running) stop();
      setEditingId(null);
      setEditDraft(null);
      setMode(m);
    },
    [mode, running, stop]
  );

  /** 当前行指示（运行行优先，其次单发闪烁行，最后光标行）。 */
  const displayLineIdx =
    runLine ?? flashLine ?? Math.min(textCursorLine, Math.max(lines.length - 1, 0));
  const lineLabel =
    lines.length === 0 ? '0/0' : `${Math.min(displayLineIdx, lines.length - 1) + 1}/${lines.length}`;

  // 全局键盘流（仅列表模式）：`/` 聚焦搜索；未在输入时 ↑/↓ 导航、Enter 发送。
  // 搜索框内仅接管 ↑/↓（移入列表）与 Escape（清空）；编辑表单/文本区输入不接管。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const isTyping =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

      if (e.key === '/') {
        if (isTyping || mode !== 'list') return;
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (mode !== 'list') return;

      const inSearch = el === searchRef.current;
      if (inSearch && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (el instanceof HTMLElement && (el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return;
      if (isTyping) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (inSearch) searchRef.current?.blur();
        setCursor((c) => Math.min(c + 1, Math.max(filtered.length - 1, 0)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (inSearch) searchRef.current?.blur();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === 'Enter') {
        const cmd = filtered[cursor];
        if (cmd) {
          e.preventDefault();
          sendCommand(cmd);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, cursor, sendCommand, mode]);

  const editSaveKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  };

  return (
    <div className="quicksend-panel">
      {/* 模式切换 */}
      <div className="quicksend-mode-tabs" role="tablist" aria-label={t('quickSend.setLabel')}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'list'}
          className={`quicksend-mode-tab${mode === 'list' ? ' active' : ''}`}
          onClick={() => switchMode('list')}
        >
          {t('quickSend.mode.list')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'text'}
          className={`quicksend-mode-tab${mode === 'text' ? ' active' : ''}`}
          onClick={() => switchMode('text')}
        >
          {t('quickSend.mode.text')}
        </button>
      </div>

      {/* 共享参数栏（两种模式） */}
      <div className="quicksend-params">
        <div className="quicksend-param-row">
          <label className="quicksend-param-label">{t('quickSend.targetPort')}</label>
          <select
            className="select quicksend-param-control"
            value={config.portId || activePortId || ''}
            disabled={ports.length === 0}
            onChange={(e) => setConfig((c) => ({ ...c, portId: e.target.value }))}
            title={t('quickSend.targetPort')}
          >
            <option value="">
              {ports.length === 0 ? t('quickSend.noPorts') : activePortId ?? t('quickSend.noActivePort')}
            </option>
            {ports.map((p) => (
              <option key={p.id} value={p.id}>
                {/* issue #7-4：去掉无意义的「· REAL/VIRTUAL」类型后缀，只显示串口号 */}
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="quicksend-param-row">
          <label className="quicksend-param-label">{t('quickSend.lineEnding')}</label>
          <select
            className="select quicksend-param-control"
            value={config.lineEnding}
            onChange={(e) =>
              setConfig((c) => ({ ...c, lineEnding: e.target.value as LineEnding }))
            }
          >
            {LINE_ENDING_VALUES.map((v) => (
              <option key={v} value={v}>
                {t(lineEndingLabelKey(v, 'sendSection'))}
              </option>
            ))}
          </select>
          <label className="quicksend-param-label">{t('quickSend.format')}</label>
          <div className="quicksend-format-toggle">
            <button
              type="button"
              className={!config.isHex ? 'active' : ''}
              onClick={() => setConfig((c) => ({ ...c, isHex: false }))}
            >
              STR
            </button>
            <button
              type="button"
              className={config.isHex ? 'active' : ''}
              onClick={() => setConfig((c) => ({ ...c, isHex: true }))}
            >
              HEX
            </button>
          </div>
        </div>
        {mode === 'text' && (
          <>
            <div className="quicksend-param-row">
              <label className="quicksend-param-label">{t('quickSend.sendInterval')}</label>
              <input
                type="number"
                className="input quicksend-param-number"
                min={1}
                max={SEND_INTERVAL_MAX}
                step={1}
                value={config.sendIntervalMs}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    sendIntervalMs: Math.min(SEND_INTERVAL_MAX, clampInterval(Number(e.target.value))),
                  }))
                }
              />
            </div>
            <div className="quicksend-param-row">
              <label className="quicksend-param-label">{t('quickSend.roundInterval')}</label>
              <input
                type="number"
                className="input quicksend-param-number"
                min={0}
                max={ROUND_INTERVAL_MAX}
                step={1}
                value={config.roundIntervalMs}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    roundIntervalMs: Math.min(ROUND_INTERVAL_MAX, clampRoundInterval(Number(e.target.value))),
                  }))
                }
              />
            </div>
          </>
        )}
      </div>

      {mode === 'list' ? (
        <>
          <div className="quicksend-toolbar">
            <div className="quicksend-search-wrap">
              <Search size={12} className="quicksend-search-icon" />
              <input
                ref={searchRef}
                className="input quicksend-search"
                placeholder={t('quickSend.searchPlaceholder')}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setCursor(0);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setQuery('');
                }}
              />
            </div>
            <div className="quicksend-set-row">
              <select
                className="select quicksend-set-select"
                value={selectedSetId ?? ''}
                onChange={(e) => {
                  setSelectedSetId(e.target.value);
                  setCursor(0);
                  cancelEdit();
                }}
                disabled={sets.length === 0}
                title={t('quickSend.setLabel')}
              >
                {sets.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button className="icon-btn" title={t('quickSend.editSet')} onClick={handleOpenSetEditor}>
                <Pencil size={13} />
              </button>
            </div>
          </div>

          <div className="quicksend-list" ref={listRef}>
            {sets.length === 0 ? (
              <div className="quicksend-empty">{t('quickSend.noSets')}</div>
            ) : filtered.length === 0 ? (
              <div className="quicksend-empty">{t('quickSend.empty')}</div>
            ) : (
              filtered.map((cmd, idx) => (
                <div
                  key={cmd.id}
                  className={`quicksend-row${idx === cursor ? ' is-cursor' : ''}${
                    flashingId === cmd.id ? ' is-flash' : ''
                  }`}
                  onClick={() => sendCommand(cmd)}
                  onMouseEnter={() => setCursor(idx)}
                  title={cmd.content}
                >
                  <span className="quicksend-row-head">
                    <span className="quicksend-name">{cmd.name || cmd.content}</span>
                    <span className={`quicksend-badge quicksend-badge-${cmd.type}`}>
                      {cmd.type === 'hex' ? 'HEX' : 'STR'}
                    </span>
                    <span className="quicksend-le">{t(lineEndingLabelKey(cmd.appendLineEnding, 'sendSection'))}</span>
                    <button
                      type="button"
                      className="icon-btn quicksend-edit-btn"
                      title={t('quickSend.editHint')}
                      aria-label={t('quickSend.editCommand')}
                      onClick={(e) => {
                        e.stopPropagation();
                        startEdit(cmd);
                      }}
                    >
                      <Pencil size={12} />
                    </button>
                  </span>
                  {editingId === cmd.id && editDraft ? (
                    <div
                      className="quicksend-edit-form"
                      onClick={(e) => e.stopPropagation()}
                      onMouseEnter={() => setCursor(idx)}
                    >
                      <input
                        className="input quicksend-edit-input"
                        value={editDraft.name}
                        placeholder={t('quickSend.namePlaceholder')}
                        onChange={(e) => setEditDraft((d) => (d ? { ...d, name: e.target.value } : d))}
                        onKeyDown={editSaveKeyDown}
                      />
                      <input
                        className="input quicksend-edit-input"
                        value={editDraft.content}
                        placeholder={t('quickSend.contentPlaceholder')}
                        onChange={(e) =>
                          setEditDraft((d) => (d ? { ...d, content: e.target.value } : d))
                        }
                        onKeyDown={editSaveKeyDown}
                      />
                      <div className="quicksend-edit-row">
                        <select
                          className="select quicksend-edit-select"
                          value={editDraft.appendLineEnding}
                          onChange={(e) =>
                            setEditDraft((d) =>
                              d ? { ...d, appendLineEnding: e.target.value as LineEnding } : d
                            )
                          }
                        >
                          {LINE_ENDING_VALUES.map((v) => (
                            <option key={v} value={v}>
                              {t(lineEndingLabelKey(v, 'sendSection'))}
                            </option>
                          ))}
                        </select>
                        <div className="quicksend-format-toggle">
                          <button
                            type="button"
                            className={editDraft.type === 'string' ? 'active' : ''}
                            onClick={() => setEditDraft((d) => (d ? { ...d, type: 'string' } : d))}
                          >
                            STR
                          </button>
                          <button
                            type="button"
                            className={editDraft.type === 'hex' ? 'active' : ''}
                            onClick={() => setEditDraft((d) => (d ? { ...d, type: 'hex' } : d))}
                          >
                            HEX
                          </button>
                        </div>
                        <button
                          type="button"
                          className="icon-btn"
                          title={t('quickSend.editSave')}
                          aria-label={t('quickSend.editSave')}
                          onClick={saveEdit}
                        >
                          <Save size={12} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title={t('quickSend.editCancel')}
                          aria-label={t('quickSend.editCancel')}
                          onClick={cancelEdit}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    </div>
                  ) : (
                    <span className="quicksend-content">{cmd.content}</span>
                  )}
                </div>
              ))
            )}
          </div>
        </>
      ) : (
        <div className="quicksend-text-mode">
          <textarea
            ref={textareaRef}
            className="quicksend-textarea"
            value={text}
            placeholder={t('quickSend.textPlaceholder')}
            spellCheck={false}
            onChange={(e) => {
              if (running) stop();
              setText(e.target.value);
            }}
            onSelect={(e) => updateCursorLine(e.currentTarget)}
            onClick={(e) => updateCursorLine(e.currentTarget)}
            onKeyUp={(e) => updateCursorLine(e.currentTarget)}
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
                onClick={runCurrentLineOnly}
                title={t('quickSend.runCurrentLine')}
                aria-label={t('quickSend.runCurrentLine')}
              >
                <Play size={12} />
              </button>
              {/* issue #6-3：执行当前行，且执行完毕后把光标移到下一行 */}
              <button
                type="button"
                className="quicksend-run-btn"
                disabled={running || !canSend || !hasContent}
                onClick={runCurrentLineAndAdvance}
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
                  onClick={stop}
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
      )}

      <div className="quicksend-footer">
        {effectivePortId ? (
          <span className="quicksend-target">
            {t('quickSend.sendTo')}
            {/* issue #7-5：提示灯跟随真实连接状态——已连接绿色（呼吸）、未连接灰色 */}
            <span
              className={`quicksend-dot${connectedPortIds.has(effectivePortId) ? ' is-connected' : ''}`}
              aria-hidden="true"
            />
            <span className="quicksend-target-port">{effectivePortId}</span>
          </span>
        ) : (
          <span className="quicksend-target quicksend-target-muted">
            {ports.length === 0 ? t('quickSend.noActivePort') : t('quickSend.portClosed')}
          </span>
        )}
      </div>
    </div>
  );
};

export default QuickSendPanel;
