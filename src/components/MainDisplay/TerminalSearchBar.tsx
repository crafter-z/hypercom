/**
 * Terminal search strip (Ctrl+F) — extracted from TerminalView.
 *
 * Pure presentational component: all state lives in useTerminalSearch and
 * flows in via props. Built on the .toolbar-input / .icon-btn / .chip
 * primitives from base.css.
 */
import React, { useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ChevronUp, ChevronDown, Type } from 'lucide-react';

interface TerminalSearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  caseSensitive: boolean;
  onToggleCase: () => void;
  matchIndex: number;   // 0-based index into matchIndices, -1 if none
  matchCount: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
}

const TerminalSearchBar: React.FC<TerminalSearchBarProps> = ({
  query,
  onQueryChange,
  caseSensitive,
  onToggleCase,
  matchIndex,
  matchCount,
  onNext,
  onPrev,
  onClose,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofocus on mount and when re-opened
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Local key handler: Enter / Shift+Enter / Escape. Stop propagation so the
  // terminal container's onKeyDown doesn't also process them.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) onPrev();
      else onNext();
    }
  }, [onClose, onNext, onPrev]);

  const counterText = matchCount === 0
    ? t('terminal.search.noResults')
    : t('terminal.search.counter', { current: matchIndex + 1, total: matchCount });

  return (
    <div className="terminal-search-bar">
      <input
        ref={inputRef}
        type="text"
        className="toolbar-input terminal-search-input"
        value={query}
        placeholder={t('terminal.search.placeholder')}
        title={t('terminal.search.tooltip.shortcut')}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className={`chip terminal-search-counter${matchCount === 0 ? ' no-results' : ''}`}>
        {counterText}
      </span>
      <button
        type="button"
        className={`icon-btn${caseSensitive ? ' active' : ''}`}
        onClick={onToggleCase}
        title={caseSensitive
          ? t('terminal.search.caseSensitiveActive')
          : t('terminal.search.caseSensitive')}
        aria-pressed={caseSensitive}
      >
        <Type size={13} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={onPrev}
        disabled={matchCount === 0}
        title={t('terminal.search.previous')}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={onNext}
        disabled={matchCount === 0}
        title={t('terminal.search.next')}
      >
        <ChevronDown size={14} />
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={onClose}
        title={t('terminal.search.close')}
      >
        <X size={14} />
      </button>
    </div>
  );
};

export default TerminalSearchBar;
