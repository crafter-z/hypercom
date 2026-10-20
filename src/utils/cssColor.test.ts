import { describe, expect, it } from 'vitest';
import { safeCssColor } from './cssColor';

describe('safeCssColor', () => {
  it('accepts the color spellings the UI offers', () => {
    for (const value of ['#fff', '#ffffffff', 'red', 'tomato', 'currentColor', 'rgb(0, 0, 0)', 'rgba(1,2,3,.5)', 'hsl(120 50% 50%)', 'hsla(0,0%,0%,0.5)']) {
      expect(safeCssColor(value)).toBe(value);
    }
  });

  it('trims surrounding whitespace', () => {
    expect(safeCssColor('  #ff0000 ')).toBe('#ff0000');
  });

  it('rejects values that can break out of a style attribute', () => {
    for (const value of [
      'rgb(0" onmouseover="alert(1)',
      'rgb(0"><img src=x onerror=alert(1)>',
      'red;background:url(javascript:alert(1))',
      'url(javascript:alert(1))',
      '#fff"',
      '<script>',
      '',
      '   ',
      'a'.repeat(65),
    ]) {
      expect(safeCssColor(value)).toBeNull();
    }
  });
});
