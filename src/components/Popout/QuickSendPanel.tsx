import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Search } from 'lucide-react';
import { storageService, popoutEventService } from '../../services/tauri';
import { mapCommandSetInfo } from '../../hooks/useAppInit';
import type { LineEnding, SendCommand, SendCommandSet } from '../../types';

/** 行尾符 → i18n key（与发送区共用同一套词汇，协议词汇不翻译）。 */
const LINE_ENDING_LABEL_KEY: Record<LineEnding, string> = {
  '\\r\\n': 'sendSection.lineEnding.crlf',
  '\\r': 'sendSection.lineEnding.cr',
  '\\n': 'sendSection.lineEnding.lf',
  'None': 'sendSection.lineEnding.none',
};

/** 发送成功的行内闪烁时长（与内联条共用"短促闪烁"反馈语言）。 */
const FLASH_MS = 260;

/**
 * 快捷发送面板（瘦高独立窗内容，宿主无关组件）。
 *
 * 架构原则：弹窗与主窗不共享可变前端态，只交换意图/事件。
 * - 数据：SQLite 是唯一真相——mount 时直读 `load_command_sets`，
 *   收到 `command-sets:changed` 信号后自行回库重读（信号不携带数据）。
 * - 发送：整行可点 = emit `popout:send-command` 意图，主窗经 sendToPort
 *   走既有管线（TX 回显 / 流量 / 历史因此与手动发送完全一致）。
 * - 键盘流：`/` 聚焦搜索，`↑/↓` 移动光标，`Enter` 发送高亮命令。
 */
const QuickSendPanel: React.FC = () => {
  const { t } = useTranslation();
  const [sets, setSets] = useState<SendCommandSet[]>([]);
  const [selectedSetId, setSelectedSetId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [targetPortId, setTargetPortId] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [flashingId, setFlashingId] = useState<string | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 回库重读命令集；选中集被删除时回退到第一个。 */
  const reload = useCallback(() => {
    storageService
      .loadCommandSets()
      .then((infos) => {
        const mapped = infos.map(mapCommandSetInfo);
        setSets(mapped);
        setSelectedSetId((prev) =>
          prev != null && mapped.some((s) => s.id === prev) ? prev : mapped[0]?.id ?? null
        );
      })
      .catch((e) => console.debug('[QuickSendPanel] loadCommandSets failed:', e));
  }, []);

  useEffect(() => {
    reload();
    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    // 监听器注册是异步的：必须 await 就绪后再发 request-sync，
    // 否则主窗回放的 active-tab:changed 可能早于监听器到达而丢失。
    void (async () => {
      try {
        const [unCmdSets, unActiveTab] = await Promise.all([
          popoutEventService.onCommandSetsChanged(reload),
          popoutEventService.onActiveTabChanged((payload) => setTargetPortId(payload.portId)),
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

  /** 发送 = 发出意图事件（主窗执行真实发送），行内短促闪烁反馈。 */
  const sendCommand = useCallback((cmd: SendCommand) => {
    void popoutEventService
      .emitSendCommand({
        content: cmd.content,
        isHex: cmd.type === 'hex',
        lineEnding: cmd.appendLineEnding,
      })
      .catch((e) => console.debug('[QuickSendPanel] emitSendCommand failed:', e));
    setFlashingId(cmd.id);
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    flashTimerRef.current = setTimeout(() => setFlashingId(null), FLASH_MS);
  }, []);

  // 全局键盘流：`/` 聚焦搜索；未在输入时 ↑/↓ 导航、Enter 发送高亮项。
  // 搜索框内仅接管 ↑/↓（移入列表）与 Escape（清空），其余留给输入法。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      const isTyping =
        el instanceof HTMLElement &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

      if (e.key === '/') {
        if (isTyping) return;
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }

      const inSearch = el === searchRef.current;
      if (inSearch && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (el instanceof HTMLElement && el.tagName === 'SELECT') return;

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
  }, [filtered, cursor, sendCommand]);

  const handleEdit = () => {
    void popoutEventService
      .emitOpenConfig({ page: 'commands' })
      .catch((e) => console.debug('[QuickSendPanel] emitOpenConfig failed:', e));
  };

  return (
    <div className="quicksend-panel">
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
          <button className="icon-btn" title={t('quickSend.editSet')} onClick={handleEdit}>
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
            <button
              key={cmd.id}
              type="button"
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
                <span className="quicksend-le">{t(LINE_ENDING_LABEL_KEY[cmd.appendLineEnding])}</span>
              </span>
              <span className="quicksend-content">{cmd.content}</span>
            </button>
          ))
        )}
      </div>

      <div className="quicksend-footer">
        {targetPortId ? (
          <span className="quicksend-target">
            {t('quickSend.sendTo')}
            <span className="quicksend-dot" aria-hidden="true" />
            <span className="quicksend-target-port">{targetPortId}</span>
          </span>
        ) : (
          <span className="quicksend-target quicksend-target-muted">{t('quickSend.noActivePort')}</span>
        )}
      </div>
    </div>
  );
};

export default QuickSendPanel;
