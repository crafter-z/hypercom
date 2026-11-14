import { describe, expect, it } from 'vitest';
import css from './base.css?raw';

function themeBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}
function hexToken(block: string, name: string): string {
  const value = block.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`))?.[1];
  if (!value) throw new Error(`Missing opaque token ${name}`);
  return value;
}
function luminance(hex: string): number {
  const rgb = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

describe('UI surface and boundary hierarchy', () => {
  it('retains light control contrast while keeping decorative dividers quieter', () => {
    const light = themeBlock(':root[data-theme="light"]');
    const border = hexToken(light, '--border-color');
    const divider = hexToken(light, '--border-subtle');
    for (const name of ['--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-elevated']) {
      const background = hexToken(light, name);
      expect(contrast(border, background), `${name} control boundary`).toBeGreaterThanOrEqual(3);
      expect(contrast(divider, background), `${name} decorative divider`).toBeLessThan(contrast(border, background));
    }
  });
  it('themes native form controls and preserves visible keyboard focus', () => {
    expect(themeBlock(':root')).toContain('color-scheme: dark');
    expect(themeBlock(':root[data-theme="light"]')).toContain('color-scheme: light');
    expect(css).toContain('--border-control: var(--border-color)');
    expect(css).toContain('.input:focus-visible');
    expect(css).toContain('outline: 2px solid var(--accent-color)');
  });
});
