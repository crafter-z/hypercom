/**
 * CSS color validation — the single gate for colors interpolated into
 * inline `style` attributes by the terminal HTML renderers.
 *
 * Colors come from user/imported rule sets and protocol templates, so they
 * are untrusted. The renderers build `style="color:${color}"` inside
 * `innerHTML`; a value containing a quote or angle bracket can therefore
 * break out of the attribute (stored XSS). Accept only the three spellings
 * the UI actually offers and reject everything else before interpolation.
 */

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`. */
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
/** Named colors / keywords (`red`, `tomato`, `currentColor`, `transparent`…). */
const NAMED_COLOR = /^[a-zA-Z]+$/;
/**
 * Functional notation with numeric arguments only. Quotes, `<`, `>`, `;`,
 * backslashes and `url(...)` cannot match this character class.
 */
const FUNCTION_COLOR = /^(rgb|rgba|hsl|hsla)\(\s*[-+0-9.%\s,/]+\)$/i;
/** Defensive upper bound: real color strings are short. */
const MAX_COLOR_LENGTH = 64;

/**
 * Return the trimmed color when it is safe to place verbatim in a CSS
 * declaration, otherwise null (caller omits the style entirely).
 */
export function safeCssColor(color: string | null | undefined): string | null {
  if (typeof color !== 'string') return null;
  const value = color.trim();
  if (value.length === 0 || value.length > MAX_COLOR_LENGTH) return null;
  const allowed =
    HEX_COLOR.test(value) || NAMED_COLOR.test(value) || FUNCTION_COLOR.test(value);
  return allowed ? value : null;
}
