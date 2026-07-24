/**
 * Terminal filter strip — extracted from TerminalView.
 *
 * Direction (All/TX/RX) + keyword filtering with a live match readout,
 * pause/resume of the display, the per-tab display controls (scroll lock,
 * timestamp, string/HEX format), and the per-port encoding selector
 * (encoding switches re-decode existing content via setTerminalEncoding).
 *
 * Built on the .segmented / .toolbar-input / .icon-btn / .chip primitives.
 */
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Filter, Pin, Clock } from 'lucide-react';
import { useTerminalStore } from '../../stores/useTerminalStore';
import type { DisplayFormat, Encoding } from '../../types';
import type { DirectionFilter } from '../../utils/lineFilter';

const DIRECTION_LABEL_KEYS: Record<DirectionFilter, string> = {
  all: 'terminal.filter.all',
  TX: 'terminal.filter.txOnly',
  RX: 'terminal.filter.rxOnly',
};

const DIRECTION_OPTIONS: DirectionFilter[] = ['all', 'TX', 'RX'];

const ENCODING_OPTIONS: Encoding[] = ['ASCII', 'UTF-8', 'GBK', 'ISO-8859-1'];

interface TerminalFilterBarProps {
  portId: string;
  encoding: Encoding | undefined;
  scrollLocked?: boolean;
  showTimestamp?: boolean;
  displayFormat?: DisplayFormat;
  direction: DirectionFilter;
  onDirectionChange: (d: DirectionFilter) => void;
  keyword: string;
  onKeywordChange: (k: string) => void;
  matchCount: number;      // visible line count while the keyword filter is active
  showMatchCount: boolean; // true when the debounced keyword is non-empty
  paused: boolean;
  onTogglePause: () => void;
}

const TerminalFilterBar: React.FC<TerminalFilterBarProps> = ({
  portId,
  encoding,
  scrollLocked,
  showTimestamp,
  displayFormat,
  direction,
  onDirectionChange,
  keyword,
  onKeywordChange,
  matchCount,
  showMatchCount,
  paused,
  onTogglePause,
}) => {
  const { t } = useTranslation();

  // Escape clears the keyword filter (stopPropagation so the terminal
  // container's Escape → close-search handler doesn't also fire).
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onKeywordChange('');
    }
  }, [onKeywordChange]);

  // Encoding switches apply straight to this port's decode pipeline and
  // re-decode existing content; the bar itself needs no re-render, so write
  // through getState() without subscribing.
  const handleEncodingChange = useCallback((value: string) => {
    useTerminalStore.getState().setTerminalEncoding(portId, value as Encoding);
  }, [portId]);

  return (
    <div className="terminal-filter-bar">
      <Filter size={13} className="terminal-filter-icon" aria-hidden="true" />
      <div className="segmented" role="group">
        {DIRECTION_OPTIONS.map((d) => (
          <button
            key={d}
            type="button"
            className={`segmented-btn${direction === d ? ' active' : ''}`}
            onClick={() => onDirectionChange(d)}
            aria-pressed={direction === d}
          >
            {t(DIRECTION_LABEL_KEYS[d])}
          </button>
        ))}
      </div>
      <input
        type="text"
        className="toolbar-input"
        value={keyword}
        placeholder={t('terminal.filter.keywordPlaceholder')}
        onChange={(e) => onKeywordChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {showMatchCount && (
        <span className={`chip terminal-filter-count${matchCount === 0 ? ' no-results' : ''}`}>
          {t('terminal.filter.matchCount', { count: matchCount })}
        </span>
      )}
      <div className="terminal-filter-spacer" />
      {paused && (
        <span className="terminal-filter-paused">
          <span className="terminal-filter-paused-dot" />
          {t('terminal.filter.paused')}
        </span>
      )}
      <button
        type="button"
        className={`icon-btn${paused ? ' active-warn' : ''}`}
        onClick={onTogglePause}
        title={paused ? t('terminal.filter.resume') : t('terminal.filter.pause')}
        aria-pressed={paused}
      >
        {paused ? <Play size={13} /> : <Pause size={13} />}
      </button>
      <span className="toolbar-sep" />
      <div className="terminal-filter-display-group">
        <button
          type="button"
          className={`icon-btn${scrollLocked ? ' active' : ''}`}
          title={t('paramsSection.scrollLock')}
          aria-pressed={!!scrollLocked}
          onClick={() => useTerminalStore.getState().setTerminalConfig(portId, { scrollLocked: !scrollLocked })}
        >
          <Pin size={13} />
        </button>
        <button
          type="button"
          className={`icon-btn${showTimestamp ? ' active' : ''}`}
          title={t('paramsSection.timestamp')}
          aria-pressed={!!showTimestamp}
          onClick={() => useTerminalStore.getState().setTerminalConfig(portId, { showTimestamp: !showTimestamp })}
        >
          <Clock size={13} />
        </button>
        <div className="segmented" role="group">
          <button type="button" className={`segmented-btn${displayFormat === 'hex' ? ' active' : ''}`}
            onClick={() => useTerminalStore.getState().setTerminalConfig(portId, { displayFormat: 'hex' })}>HEX</button>
          <button type="button" className={`segmented-btn${displayFormat === 'string' ? ' active' : ''}`}
            onClick={() => useTerminalStore.getState().setTerminalConfig(portId, { displayFormat: 'string' })}>
            {t('paramsSection.displayFormat.string')}
          </button>
        </div>
      </div>
      <span className="toolbar-sep" />
      <div className="terminal-bar-field" title={t('pane.toolbar.encodingLabel')}>
        <label className="eyebrow" htmlFor={`terminal-encoding-${portId}`}>
          {t('pane.toolbar.encodingLabel')}
        </label>
        <select
          id={`terminal-encoding-${portId}`}
          className="select terminal-bar-select"
          value={encoding || 'UTF-8'}
          onChange={(e) => handleEncodingChange(e.target.value)}
        >
          {ENCODING_OPTIONS.map((enc) => (
            <option key={enc} value={enc}>{enc}</option>
          ))}
        </select>
      </div>
    </div>
  );
};

export default TerminalFilterBar;
