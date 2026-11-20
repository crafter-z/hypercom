/** Presentational search strip: all scans and hit metadata live in the manager. */
import React, { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ChevronUp, ChevronDown } from 'lucide-react';
import SearchAdvancedOptions from './SearchAdvancedOptions';
import type { SearchSnapshot, SearchSpec } from '../../utils/terminal/search/searchTypes';

interface TerminalSearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  caseSensitive: boolean;
  onToggleCase: () => void;
  matchIndex: number;
  matchCount: number;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  options: SearchSpec;
  onOptionsChange: (spec: SearchSpec) => void;
  snapshot: SearchSnapshot | null;
  onCancel: () => void;
}

const TerminalSearchBar: React.FC<TerminalSearchBarProps> = ({
  query, onQueryChange, caseSensitive, onToggleCase, matchIndex, matchCount,
  onNext, onPrev, onClose, options, onOptionsChange, snapshot, onCancel,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  useEffect(() => {
    // Switching the input shape must not steal focus from the secondary panel.
    if (document.activeElement?.closest('.search-advanced-panel')) return;
    inputRef.current?.focus(); inputRef.current?.select();
  }, [options.multiline]);
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); onClose();
    } else if (event.key === 'Enter') {
      // A real newline is editable in multiline mode; Ctrl/Cmd+Enter navigates.
      if (options.multiline && !event.ctrlKey && !event.metaKey) { event.stopPropagation(); return; }
      event.preventDefault(); event.stopPropagation();
      if (event.shiftKey) onPrev(); else onNext();
    }
  };
  const inputProps = {
    className: 'toolbar-input terminal-search-input', value: query,
    placeholder: t('terminal.search.placeholder'), 'aria-label': t('terminal.search.placeholder'),
    title: t(options.multiline ? 'terminal.search.multilineHelp' : 'terminal.search.tooltip.shortcut'),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onQueryChange(event.target.value),
    onKeyDown: handleKeyDown, 'aria-invalid': snapshot?.status === 'error' || undefined,
  };
  return <div className="terminal-search-container">
    <div className="terminal-search-bar" role="search">
      {options.multiline
        ? <textarea {...inputProps} rows={2} ref={node => { inputRef.current = node; }} />
        : <input {...inputProps} type="text" ref={node => { inputRef.current = node; }} />}
      <span className={`chip terminal-search-counter${matchCount === 0 ? ' no-results' : ''}`}>
        {matchCount ? t('terminal.search.counter', { current: matchIndex + 1, total: matchCount }) : t('terminal.search.noResults')}
      </span>
      <button type="button" className="icon-btn" onClick={onPrev} disabled={!matchCount}
        aria-label={t('terminal.search.previous')} title={t('terminal.search.previous')}><ChevronUp size={14} /></button>
      <button type="button" className="icon-btn" onClick={onNext} disabled={!matchCount}
        aria-label={t('terminal.search.next')} title={t('terminal.search.next')}><ChevronDown size={14} /></button>
      <SearchAdvancedOptions spec={{ ...options, caseSensitive }} onChange={next => {
        if (next.caseSensitive !== caseSensitive) onToggleCase();
        onOptionsChange(next);
      }} />
      <button type="button" className="icon-btn" onClick={onClose}
        aria-label={t('terminal.search.close')} title={t('terminal.search.close')}><X size={14} /></button>
    </div>
    <div className="terminal-search-feedback" role="status" aria-live="polite">
      {snapshot?.error ? t(snapshot.error) : snapshot?.status === 'scanning' ? t('terminal.search.scanning', { count: snapshot.scanned })
        : snapshot?.status === 'cancelled' ? t('terminal.search.cancelled') : ''}
      {snapshot?.truncated && <span> {t('terminal.search.truncated')}</span>}
      {snapshot?.incomplete && <span> {t('terminal.search.incomplete')}</span>}
      {snapshot?.status === 'scanning' && <button type="button" className="btn btn-sm" onClick={onCancel}>{t('terminal.search.cancel')}</button>}
    </div>
  </div>;
};
export default TerminalSearchBar;
