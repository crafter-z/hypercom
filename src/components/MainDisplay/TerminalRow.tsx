/**
 * One virtualized terminal row — extracted from TerminalView.
 *
 * Pure render, no state: protocol-field coloring when parsedFields exist,
 * otherwise the highlight engine over the displayed text (HEX display falls
 * back to rawData). Timestamp cells mute to '-' for non-first lines of a
 * round in perRound mode. The injected HTML comes only from
 * renderProtocolLine / applyHighlightSets, both of which escapeHtml their
 * input — this is the single sanctioned dangerouslySetInnerHTML site.
 *
 * Wrapped in React.memo: props are stable primitives (no `terminal` object —
 * its identity changes on every appended line — and no `lines` array) so an
 * unchanged row skips re-render entirely during high-frequency output.
 */
import React from 'react';
import type { DisplayFormat, HighlightRuleSet, TerminalLine, TimestampFormat } from '../../types';
import { applyHighlightSets } from '../../utils/highlightEngine';
import { renderProtocolLine } from '../../utils/protocolRenderer';
import { formatTerminalTimestampAdj } from '../../utils/timeFormat';
import { markSearchMatchesInHtml } from './terminalSearch';

/** TX/RX/TOOL direction coloring — the terminal's signal semantics. */
const directionColor = (dir: string, stream?: string) => {
  if (dir === 'TX') return 'var(--terminal-tx-color)';
  if (dir === 'TOOL') return stream === 'stderr' ? 'var(--terminal-tool-stderr-color, #f48771)' : 'var(--terminal-tool-color, #dcdcaa)';
  return 'var(--terminal-rx-color)';
};

interface TerminalRowProps {
  line: TerminalLine;
  /** Original index into the full `lines` buffer. */
  origIdx: number;
  /** The line immediately before `line` in the buffer (undefined for the
   *  first row) — adjacency input for the relative timestamp formatter. */
  prevLine: TerminalLine | undefined;
  /** Primitive display-state slices (the `terminal` object itself changes
   *  identity on every append, which would defeat React.memo). */
  displayFormat: DisplayFormat | undefined;
  showTimestamp: boolean | undefined;
  connectedAt: number | null | undefined;
  highlightRuleSets: HighlightRuleSet[];
  timestampFormat: TimestampFormat;
  timestampMode: 'perLine' | 'perRound';
  /** O(1) per-row round boundary flag (computed in TerminalView). */
  isFirstInRound: boolean;
  selectedRange: { start: number; end: number } | null;
  searchOpen: boolean;
  matchSet: Set<number>;
  currentMatchLineIdx: number;
  /** Debounced search query + case flag — feeds the character-level `<mark>`
   *  layer (issue #2-8). '' when the search bar is closed. */
  searchQuery: string;
  searchCaseSensitive: boolean;
  /* ---- Virtualizer plumbing ---- */
  /** Filtered row index, written to data-index for the virtualizer. */
  rowIndex: number;
  /** translateY offset computed by the virtualizer. */
  rowStart: number;
  measureRef: (node: HTMLElement | null) => void;
  onRowClick: (e: React.MouseEvent, index: number) => void;
  onRowContextMenu: (e: React.MouseEvent, index: number) => void;
}

const TerminalRow: React.FC<TerminalRowProps> = ({
  line,
  origIdx,
  prevLine,
  displayFormat,
  showTimestamp,
  connectedAt,
  highlightRuleSets,
  timestampFormat,
  timestampMode,
  isFirstInRound,
  selectedRange,
  searchOpen,
  matchSet,
  currentMatchLineIdx,
  searchQuery,
  searchCaseSensitive,
  rowIndex,
  rowStart,
  measureRef,
  onRowClick,
  onRowContextMenu,
}) => {
  let lineHtml: string;
  if (line.parsedFields && line.parsedFields.length > 0) {
    lineHtml = renderProtocolLine(line);
  } else {
    const displayText = displayFormat === 'hex' && line.rawData
      // Uint8Array 无 .map：Array.from 逐字节格式化（issue #6-2）
      ? Array.from(line.rawData, b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
      : line.content;
    lineHtml = applyHighlightSets(displayText, highlightRuleSets);
  }

  const isSelected = selectedRange !== null
    && origIdx >= selectedRange.start
    && origIdx <= selectedRange.end;
  const isMatch = searchOpen && matchSet.has(origIdx);
  const isCurrent = searchOpen && origIdx === currentMatchLineIdx;

  // 搜索字符级高亮（issue #2-8）：只在命中行上把 query 出现处包 <mark>，
  // 叠加在用户高亮/协议着色之上（tag/实体感知，不改标签与属性）。
  if (isMatch && searchQuery) {
    lineHtml = markSearchMatchesInHtml(lineHtml, searchQuery, searchCaseSensitive, isCurrent);
  }

  const muted = timestampMode === 'perRound' && !isFirstInRound;
  const classes = [
    'terminal-line',
    isSelected ? 'selected' : '',
    isCurrent ? 'current-match' : (isMatch ? 'search-hit-line' : ''),
  ].filter(Boolean).join(' ');

  return (
    <div
      data-index={rowIndex}
      ref={measureRef}
      className={classes}
      onClick={(e) => onRowClick(e, origIdx)}
      onContextMenu={(e) => onRowContextMenu(e, origIdx)}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        transform: `translateY(${rowStart}px)`,
      }}
    >
      {showTimestamp !== false && (
        <span className={`terminal-timestamp${muted ? ' terminal-timestamp-muted' : ''}`}>
          {muted
            ? '-'
            : formatTerminalTimestampAdj(line, prevLine, connectedAt, timestampFormat)}
        </span>
      )}
      <span
        className={`terminal-direction${line.direction === 'TOOL' ? ' terminal-direction-tool' : ''}`}
        style={{ color: directionColor(line.direction, line.toolStream) }}
      >
        {line.direction}
      </span>
      <span className="terminal-content"
        dangerouslySetInnerHTML={{ __html: lineHtml }}
      />
    </div>
  );
};

export default React.memo(TerminalRow);
