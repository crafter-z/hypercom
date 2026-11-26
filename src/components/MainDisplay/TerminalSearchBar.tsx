/** Presentational search strip: all scans and hit metadata live in the manager. */
import React, { useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ChevronUp, ChevronDown, AlertCircle, Globe } from 'lucide-react';
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
  /** Incrementing signal to refocus & select the search field when already open. */
  focusSignal?: number;
}

const TerminalSearchBar: React.FC<TerminalSearchBarProps> = ({
  query, onQueryChange, caseSensitive, onToggleCase, matchIndex, matchCount,
  onNext, onPrev, onClose, options, onOptionsChange, snapshot, onCancel, focusSignal = 0,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const lastFocusSignalRef = useRef(focusSignal);
  useEffect(() => {
    // Switching the input shape must not steal focus from the secondary panel.
    if (document.activeElement?.closest('.search-advanced-panel')) return;
    inputRef.current?.focus(); inputRef.current?.select();
  }, [options.multiline]);
  useEffect(() => {
    if (focusSignal === lastFocusSignalRef.current) return;
    lastFocusSignalRef.current = focusSignal;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusSignal]);
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
  const openGlobalSearch = () => {
    window.dispatchEvent(new CustomEvent('hypercom:open-global-search', { detail: { query } }));
  };
  const isScanning = snapshot?.status === 'scanning';
  const hasError = snapshot?.status === 'error' || !!snapshot?.error;
  const showNoResults = query.length > 0 && !isScanning && !hasError && matchCount === 0;
  const activeChips: string[] = [];
  if (options.mode === 'regex') activeChips.push('REGEX');
  else if (options.mode === 'hex') activeChips.push('HEX');
  else if (options.mode === 'fuzzy') activeChips.push(t('terminal.search.mode.fuzzy'));
  if (options.wholeWord && options.mode !== 'hex' && options.mode !== 'fuzzy') activeChips.push(t('terminal.search.wholeWord'));
  if (options.multiline && options.mode !== 'hex') activeChips.push(t('terminal.search.multiline'));
  if (options.scope === 'visible') activeChips.push(t('terminal.search.scope.visible'));
  const hasFeedback = !!(snapshot?.error || isScanning || snapshot?.status === 'cancelled' || snapshot?.truncated || snapshot?.incomplete);
  const inputProps = {
    className: 'toolbar-input terminal-search-input', value: query,
    placeholder: t('terminal.search.placeholder'), 'aria-label': t('terminal.search.placeholder'),
    title: t(options.multiline ? 'terminal.search.multilineHelp' : 'terminal.search.tooltip.shortcut'),
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onQueryChange(event.target.value),
    onKeyDown: handleKeyDown, 'aria-invalid': hasError || undefined,
  };
  return <div className="terminal-search-container">
    <div className="terminal-search-bar" role="search">
      {options.multiline
        ? <textarea {...inputProps} rows={2} ref={node => { inputRef.current = node; }} />
        : <input {...inputProps} type="text" ref={node => { inputRef.current = node; }} />}
      {query.length > 0 && (
        <span className={`chip terminal-search-counter${showNoResults ? ' no-results' : ''}`}>
          {matchCount > 0
            ? t('terminal.search.counter', { current: matchIndex + 1, total: matchCount })
            : isScanning
              ? '…'
              : hasError
                ? '!'
                : t('terminal.search.noResults')}
        </span>
      )}
      <button type="button" className="icon-btn" onClick={onPrev} disabled={!matchCount}
        aria-label={t('terminal.search.previous')} title={t('terminal.search.previous')}><ChevronUp size={14} /></button>
      <button type="button" className="icon-btn" onClick={onNext} disabled={!matchCount}
        aria-label={t('terminal.search.next')} title={t('terminal.search.next')}><ChevronDown size={14} /></button>
      <button
        type="button"
        className={`icon-btn terminal-search-case-btn${caseSensitive && options.mode !== 'hex' ? ' active' : ''}`}
        disabled={options.mode === 'hex'}
        aria-pressed={caseSensitive && options.mode !== 'hex'}
        aria-label={t(caseSensitive ? 'terminal.search.caseSensitiveActive' : 'terminal.search.caseSensitive')}
        title={t(caseSensitive ? 'terminal.search.caseSensitiveActive' : 'terminal.search.caseSensitive')}
        onClick={onToggleCase}
      >Aa</button>
      {activeChips.map(chip => (
        <span key={chip} className="chip terminal-search-active-chip">{chip}</span>
      ))}
      <SearchAdvancedOptions spec={{ ...options, caseSensitive }} onChange={next => {
        if (next.caseSensitive !== caseSensitive) onToggleCase();
        onOptionsChange(next);
      }} />
      <button
        type="button"
        className="icon-btn terminal-search-global-btn"
        onClick={openGlobalSearch}
        aria-label={t('globalSearch.open')}
        title={t('globalSearch.shortcut')}
      ><Globe size={14} /></button>
      <button type="button" className="icon-btn" onClick={onClose}
        aria-label={t('terminal.search.close')} title={t('terminal.search.close')}><X size={14} /></button>
    </div>
    {hasFeedback && (
      <div className={`terminal-search-feedback${snapshot?.error ? ' has-error' : ''}`} role="status" aria-live="polite">
        {snapshot?.error ? (
          <span className="terminal-search-error">
            <AlertCircle size={13} aria-hidden="true" />
            {t(snapshot.error)}
          </span>
        ) : isScanning ? (
          <span>{t('terminal.search.scanning', { count: snapshot.scanned })}</span>
        ) : snapshot?.status === 'cancelled' ? (
          <span>{t('terminal.search.cancelled')}</span>
        ) : null}
        {snapshot?.truncated && <span className="terminal-search-warning">{t('terminal.search.truncated')}</span>}
        {snapshot?.incomplete && <span className="terminal-search-warning">{t('terminal.search.incomplete')}</span>}
        {isScanning && <button type="button" className="btn btn-sm" onClick={onCancel}>{t('terminal.search.cancel')}</button>}
      </div>
    )}
  </div>;
};
export default TerminalSearchBar;
