/**
 * One virtualized terminal row — extracted from TerminalView.
 *
 * Pure render, no state: protocol-field coloring when parsedFields exist,
 * otherwise the highlight engine over the displayed text (HEX display falls
 * back to rawData). Timestamp cells mute to '-' for non-first lines of a
 * round in perRound mode. The injected HTML comes only from
 * renderProtocolLine / applyHighlightSets, both of which escapeHtml their
 * input — this is the single sanctioned dangerouslySetInnerHTML site.
 */
import React from 'react';
import type { HighlightRuleSet, TerminalLine, TerminalState, TimestampFormat } from '../../types';
import { applyHighlightSets } from '../../utils/highlightEngine';
import { renderProtocolLine } from '../../utils/protocolRenderer';
import { formatTerminalTimestamp } from '../../utils/timeFormat';

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
  /** Full buffer — formatTerminalTimestamp needs neighboring lines. */
  lines: TerminalLine[];
  terminal: TerminalState | undefined;
  highlightRuleSets: HighlightRuleSet[];
  timestampFormat: TimestampFormat;
  timestampMode: 'perLine' | 'perRound';
  firstInRound: boolean[] | null;
  selectedRange: { start: number; end: number } | null;
  searchOpen: boolean;
  matchSet: Set<number>;
  currentMatchLineIdx: number;
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
  lines,
  terminal,
  highlightRuleSets,
  timestampFormat,
  timestampMode,
  firstInRound,
  selectedRange,
  searchOpen,
  matchSet,
  currentMatchLineIdx,
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
    const displayText = terminal?.displayFormat === 'hex' && line.rawData
      ? line.rawData.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')
      : line.content;
    lineHtml = applyHighlightSets(displayText, highlightRuleSets);
  }

  const isSelected = selectedRange !== null
    && origIdx >= selectedRange.start
    && origIdx <= selectedRange.end;
  const isMatch = searchOpen && matchSet.has(origIdx);
  const isCurrent = searchOpen && origIdx === currentMatchLineIdx;
  const muted = timestampMode === 'perRound' && origIdx > 0 && !firstInRound?.[origIdx];
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
      {terminal?.showTimestamp !== false && (
        <span className={`terminal-timestamp${muted ? ' terminal-timestamp-muted' : ''}`}>
          {muted
            ? '-'
            : formatTerminalTimestamp(lines, origIdx, terminal?.connectedAt, timestampFormat)}
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

export default TerminalRow;
