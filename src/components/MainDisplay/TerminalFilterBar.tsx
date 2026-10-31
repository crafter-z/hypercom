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
import { Pause, Play, Pin, Clock } from 'lucide-react';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { getRxPipeline } from '../../utils/rxPipeline';
import type { DisplayFormat, Encoding, TerminalState } from '../../types';
import type { DirectionFilter } from '../../utils/lineFilter';

const DIRECTION_LABEL_KEYS: Record<DirectionFilter, string> = {
  all: 'terminal.filter.all',
  TX: 'terminal.filter.txOnly',
  RX: 'terminal.filter.rxOnly',
};

const DIRECTION_OPTIONS: DirectionFilter[] = ['all', 'TX', 'RX'];

const ENCODING_OPTIONS: Encoding[] = ['ASCII', 'UTF-8', 'GBK', 'ISO-8859-1'];

interface TerminalFilterBarProps {
  portId?: string;
  configId?: string;
  onConfigChange?: (patch: Partial<TerminalState>) => void;
  grouped?: boolean;
  /** Effective Pin state comes from group transport when grouped. */
  onToggleScrollLock?: () => void;
  scrollLockDisabled?: boolean;
  timelineControl?: React.ReactNode;
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
  viewPicker?: React.ReactNode;
}

const TerminalFilterBar: React.FC<TerminalFilterBarProps> = ({
  portId,
  configId,
  onConfigChange,
  grouped,
  onToggleScrollLock,
  scrollLockDisabled,
  timelineControl,
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
  viewPicker,
}) => {
  const { t } = useTranslation();
  const updateConfig = useCallback((patch: Partial<TerminalState>) => {
    if (onConfigChange) onConfigChange(patch);
    else if (portId) useTerminalStore.getState().setTerminalConfig(portId, patch);
  }, [portId, onConfigChange]);

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
  // through getState() without subscribing. Flush the RX pipeline's pending
  // tail under the OLD encoding first — otherwise a partially-buffered line
  // (e.g. a half GBK char) would be re-decoded under the new label and
  // corrupt the seam.
  const handleEncodingChange = useCallback((value: string) => {
    if (portId) {
      getRxPipeline().flushAndReset(portId);
      useTerminalStore.getState().setTerminalEncoding(portId, value as Encoding);
    } else updateConfig({ encoding: value as Encoding });
  }, [portId, updateConfig]);

  return (
    <div className="terminal-filter-bar">
      {viewPicker}
      {timelineControl}
      <select
        className="select terminal-bar-select terminal-direction-select"
        aria-label={t('terminal.filter.direction')}
        title={t('terminal.filter.direction')}
        value={direction}
        onChange={event => onDirectionChange(event.target.value as DirectionFilter)}
      >
        {DIRECTION_OPTIONS.map(d => <option key={d} value={d}>{t(DIRECTION_LABEL_KEYS[d])}</option>)}
      </select>
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
      <div className="terminal-filter-actions">
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
        <div className="terminal-filter-display-group">
          <button
            type="button"
            className={`icon-btn${scrollLocked ? ' active' : ''}`}
            title={t(scrollLockDisabled ? 'timeline.liveUnavailable' : grouped ? 'timeline.groupScrollLock' : 'paramsSection.scrollLock')}
            disabled={scrollLockDisabled}
            aria-pressed={!!scrollLocked}
            onClick={onToggleScrollLock ?? (() => updateConfig({ scrollLocked: !scrollLocked }))}
          >
            <Pin size={13} />
          </button>
          <button
            type="button"
            className={`icon-btn${showTimestamp ? ' active' : ''}`}
            title={t('paramsSection.timestamp')}
            aria-pressed={!!showTimestamp}
            onClick={() => updateConfig({ showTimestamp: !showTimestamp })}
          >
            <Clock size={13} />
          </button>
          <div className="segmented" role="group">
            <button type="button" className={`segmented-btn${displayFormat === 'hex' ? ' active' : ''}`}
              onClick={() => updateConfig({ displayFormat: 'hex' })}>HEX</button>
            <button type="button" className={`segmented-btn${displayFormat === 'string' ? ' active' : ''}`}
              onClick={() => updateConfig({ displayFormat: 'string' })}>
              {t('paramsSection.displayFormat.string')}
            </button>
          </div>
        </div>
        <div className="terminal-bar-field" title={t('pane.toolbar.encodingLabel')}>
          <label className="eyebrow" htmlFor={`terminal-encoding-${configId ?? portId}`}>
            {t('pane.toolbar.encodingLabel')}
          </label>
          <select
            id={`terminal-encoding-${configId ?? portId}`}
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
    </div>
  );
};

export default TerminalFilterBar;
