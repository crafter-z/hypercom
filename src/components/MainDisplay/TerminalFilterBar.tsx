/**
 * Terminal filter strip — extracted from TerminalView.
 *
 * Direction (All/TX/RX) + keyword filtering with a live match readout,
 * pause/resume of the display, log replay (the strip owns useLogReplay —
 * nothing outside it reads replay state), and the per-port encoding
 * selector (moved here from Pane's old toolbar strip; that strip's
 * title/status/baud readouts already live in TabBar + StatusBar).
 *
 * Built on the .segmented / .toolbar-input / .icon-btn / .chip primitives.
 */
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pause, Play, Filter, History, Square } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useLogReplay } from './hooks/useLogReplay';
import type { Encoding } from '../../types';
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

  // Log replay is strip-local: pick a log file, replay it into this port's
  // terminal at the chosen speed. Nothing outside the strip reads this state.
  const { isReplaying, startReplay, stopReplay } = useLogReplay(portId);
  const [replaySpeed, setReplaySpeed] = useState(4);

  const handleStartReplay = useCallback(async () => {
    const path = await open({
      multiple: false,
      filters: [{ name: 'Log', extensions: ['log', 'txt'] }],
    });
    if (!path || typeof path !== 'string') return;
    await startReplay(path, replaySpeed);
  }, [startReplay, replaySpeed]);

  // Escape clears the keyword filter (stopPropagation so the terminal
  // container's Escape → close-search handler doesn't also fire).
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onKeywordChange('');
    }
  }, [onKeywordChange]);

  // Encoding switches apply straight to this port's decode pipeline; the bar
  // itself needs no re-render, so write through getState() without subscribing.
  const handleEncodingChange = useCallback((value: string) => {
    useTerminalStore.getState().setTerminalConfig(portId, { encoding: value as Encoding });
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
      <select
        className="select terminal-bar-select"
        value={replaySpeed}
        onChange={(e) => setReplaySpeed(Number(e.target.value))}
        title={t('terminal.replay.speedTooltip')}
        disabled={isReplaying}
      >
        <option value={1}>1×</option>
        <option value={4}>4×</option>
        <option value={16}>16×</option>
        <option value={0}>{t('terminal.replay.speedMax')}</option>
      </select>
      <button
        type="button"
        className={`icon-btn${isReplaying ? ' active-warn' : ''}`}
        onClick={isReplaying ? stopReplay : handleStartReplay}
        title={isReplaying ? t('terminal.replay.stop') : t('terminal.replay.start')}
        aria-pressed={isReplaying}
      >
        {isReplaying ? <Square size={13} /> : <History size={13} />}
      </button>
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
