import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil, Save, Search, X } from 'lucide-react';
import { LINE_ENDING_VALUES, lineEndingLabelKey } from '../../utils/sendUtils';
import type { LineEnding, SendCommand, SendCommandSet } from '../../types';

interface EditDraft {
  name: string;
  content: string;
  appendLineEnding: LineEnding;
  type: 'string' | 'hex';
}

interface QuickSendListProps {
  sets: SendCommandSet[];
  /** 已解析的有效选中集（失效回退由面板派生）。 */
  selectedSet: SendCommandSet | null;
  onSelectSet: (setId: string) => void;
  /** 刚发出那条命令的 id，用于行内闪烁反馈。 */
  flashingId: string | null;
  onSend: (cmd: SendCommand) => void;
  onOpenSetEditor: () => void;
  /** 就地编辑保存：回传整集（面板负责回传主窗 + 落盘）。 */
  onSaveSet: (set: SendCommandSet) => void;
}

/**
 * 快捷发送面板 · 命令列表模式。
 *
 * 整行可点 = 发送；行内「修改」按钮展开就地编辑器（名称/内容/行尾/STR·HEX），
 * 保存后整集回传主窗并持久化。
 *
 * 键盘流：`/` 聚焦搜索，`↑/↓` 移动光标，`Enter` 发送高亮命令。搜索框内只接管
 * ↑/↓（移入列表）与 Escape（清空）；编辑表单与其它输入框不接管。
 */
const QuickSendList: React.FC<QuickSendListProps> = ({
  sets,
  selectedSet,
  onSelectSet,
  flashingId,
  onSend,
  onOpenSetEditor,
  onSaveSet,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  /** 选中集按 order 排序后按 名称+内容 模糊过滤（大小写不敏感）。 */
  const filtered = useMemo(() => {
    if (!selectedSet) return [];
    const sorted = [...selectedSet.commands].sort((a, b) => a.order - b.order);
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (c) => c.name.toLowerCase().includes(q) || c.content.toLowerCase().includes(q),
    );
  }, [selectedSet, query]);

  // 列表收缩（过滤/切换命令集）时把光标夹回合法区间。
  useEffect(() => {
    setCursor((c) => (filtered.length === 0 ? 0 : Math.min(c, filtered.length - 1)));
  }, [filtered.length]);

  // 光标高亮行保持可见。
  useEffect(() => {
    listRef.current?.querySelector('.quicksend-row.is-cursor')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, filtered.length]);

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
          onSend(cmd);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, cursor, onSend]);

  const startEdit = (cmd: SendCommand) => {
    setEditingId(cmd.id);
    setEditDraft({
      name: cmd.name,
      content: cmd.content,
      appendLineEnding: cmd.appendLineEnding,
      type: cmd.type,
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft(null);
  };

  const saveEdit = () => {
    if (!selectedSet || !editDraft || editingId == null) return;
    const commands = selectedSet.commands.map((c) =>
      c.id === editingId ? { ...c, ...editDraft } : c,
    );
    onSaveSet({ ...selectedSet, commands });
    cancelEdit();
  };

  const editSaveKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  };

  const selectSet = (setId: string) => {
    onSelectSet(setId);
    setCursor(0);
    cancelEdit();
  };

  return (
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
            value={selectedSet?.id ?? ''}
            onChange={(e) => selectSet(e.target.value)}
            disabled={sets.length === 0}
            title={t('quickSend.setLabel')}
          >
            {sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="icon-btn" title={t('quickSend.editSet')} onClick={onOpenSetEditor}>
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
              onClick={() => onSend(cmd)}
              onMouseEnter={() => setCursor(idx)}
              title={cmd.content}
            >
              <span className="quicksend-row-head">
                <span className="quicksend-name">{cmd.name || cmd.content}</span>
                <span className={`quicksend-badge quicksend-badge-${cmd.type}`}>
                  {cmd.type === 'hex' ? 'HEX' : 'STR'}
                </span>
                <span className="quicksend-le">
                  {t(lineEndingLabelKey(cmd.appendLineEnding, 'sendSection'))}
                </span>
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
                          d ? { ...d, appendLineEnding: e.target.value as LineEnding } : d,
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
  );
};

export default QuickSendList;
