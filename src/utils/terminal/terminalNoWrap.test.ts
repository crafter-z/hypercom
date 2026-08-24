// @vitest-environment jsdom
/**
 * issue #9 regression guard — terminal rows must never wrap.
 *
 * The 方案B renderer (v0.6.0) positions rows on a fixed-height lattice
 * (translateY(visIdx × rowHeight), zero DOM measurement). CSS wrapping
 * (white-space: pre-wrap + word-break: break-all) made an over-wide line
 * paint a second visual line OVER the next row — the reported overlap bug
 * (v0.5.x didn't overlap because @tanstack/react-virtual measured real row
 * heights; the fixed-lattice engine cannot).
 *
 * These assertions pin the CSS contract that keeps the lattice valid:
 * .terminal-content never wraps at the container edge, and .terminal-view
 * scrolls horizontally so over-wide lines stay fully readable. The import
 * injects the stylesheet into the jsdom document (vite.config test.css),
 * so getComputedStyle reflects the real rules.
 */
import { describe, it, expect } from 'vitest';
import '../../styles/terminal-view.css';

function computed(selector: string, prop: string): string {
  const el = document.createElement('div');
  el.className = selector.slice(1);
  document.body.appendChild(el);
  try {
    return getComputedStyle(el).getPropertyValue(prop).trim();
  } finally {
    el.remove();
  }
}

describe('terminal no-wrap contract (issue #9)', () => {
  it('.terminal-content must not wrap at the container edge', () => {
    // `pre` preserves data (spaces/newlines) but never wraps at the
    // container edge — an over-wide line stays one fixed-height row.
    expect(computed('.terminal-content', 'white-space')).toBe('pre');
    // No wrap-enabling fallbacks in the same rule (or its cascade).
    expect(computed('.terminal-content', 'word-break')).not.toBe('break-all');
  });

  it('.terminal-view scrolls over-wide lines horizontally', () => {
    expect(computed('.terminal-view', 'overflow-x')).toBe('auto');
  });
});
