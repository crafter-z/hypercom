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

  it('.terminal-content must not shrink below its content width (issue #15)', () => {
    // issue #15: 行内容 span 是 .terminal-line（flex）的 flex item，内联
    // overflow:hidden 把自动最小尺寸归零（flexbox §4.5），默认 flex-shrink:1
    // 会让 span 缩到行宽、超宽内容在 span 内部被裁——.terminal-view 的
    // overflow-x: auto 永远拿不到溢出，横向滚动条不出现。flex: none
    // （0 0 auto）把 span 钉在内容宽度（max-content），超宽盒子才能溢出到
    // 滚动容器。这条是 overflow-x: auto 真正生效的前提——只断言 overflow-x
    // 是流于形式。
    expect(computed('.terminal-content', 'flex-shrink')).toBe('0');
    expect(computed('.terminal-content', 'flex-grow')).toBe('0');
    expect(computed('.terminal-content', 'flex-basis')).toBe('auto');
  });

  it('.terminal-line must not clip the wide span box (issue #15)', () => {
    // 传播链：span 盒子溢出 .terminal-line（width:100%）→ .terminal-content-layer
    // （width:100%）→ .terminal-view 滚动容器。任一环节 overflow 非 visible
    // 都会截断传播、滚动条消失。
    expect(computed('.terminal-line', 'overflow-x')).toBe('visible');
    expect(computed('.terminal-line', 'overflow-y')).toBe('visible');
  });
});
