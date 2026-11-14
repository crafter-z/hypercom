// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HighlightRule } from '../../../types';
import HighlightRuleEditor, { getHighlightContrast } from './HighlightRuleEditor';
import baseCss from '../../../styles/base.css?raw';
import previewCss from '../../../styles/rule-preview.css?raw';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => {
  if (!values) return key;
  return `${key} ${Object.entries(values).map(([name, value]) => `${name}=${value}`).join(' ')}`;
} }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
const change = vi.fn();
const remove = vi.fn();
const rule: HighlightRule = {
  id: 'rule-1', name: 'Error', pattern: 'ERROR', isRegex: false, color: '#ff0000', bold: true, italic: false,
};

function render(nextRule: HighlightRule = rule): void {
  act(() => { root.render(createElement(HighlightRuleEditor, { rule: nextRule, onChange: change, onDelete: remove })); });
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('highlight rule preview', () => {
  it('measures the actual opaque terminal backgrounds and composites alpha', () => {
    const dark = baseCss.match(/--bg-primary:\s*(#[0-9a-f]{6})/)![1];
    expect(previewCss).toContain(`--preview-background: ${dark}`);
    expect(getHighlightContrast(dark)?.dark).toBeCloseTo(1);
    expect(getHighlightContrast('#ffffff')?.light).toBeCloseTo(1);
    expect(getHighlightContrast('#ffffff00')).toEqual({ light: 1, dark: 1 });
    expect(getHighlightContrast('red; background:url(x)')).toBeNull();
  });
  it('shows the same rule on both light and dark surfaces without changing the color', () => {
    render();
    const samples = container.querySelectorAll('.rule-preview__sample');
    expect(samples).toHaveLength(2);
    expect(Array.from(samples).map(sample => sample.textContent)).toEqual([
      expect.stringContaining('ERROR'),
      expect.stringContaining('ERROR'),
    ]);
    expect((samples[0] as HTMLElement).style.getPropertyValue('--preview-color')).toBe('#ff0000');
  });

  it('reports measurable contrast and warns when one theme surface is low contrast', () => {
    const contrast = getHighlightContrast('#ff0000');
    expect(contrast?.light).toBeCloseTo(4, 1);
    expect(contrast?.dark).toBeLessThan(5);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('highlightRuleEditor.contrastWarning');
  });

  it('does not claim contrast for safe but non-hex CSS colors', () => {
    expect(getHighlightContrast('tomato')).toBeNull();
    render({ ...rule, color: 'tomato' });
    expect(container.querySelector('.rule-preview__contrast--unknown')?.textContent)
      .toContain('highlightRuleEditor.contrastUnavailable');
  });
});
