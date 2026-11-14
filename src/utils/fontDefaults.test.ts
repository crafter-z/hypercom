import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TERMINAL_FONT,
  DEFAULT_UI_FONT,
  LEGACY_TERMINAL_FONT,
  LEGACY_UI_FONT,
  migrateLegacyFontConfig,
} from './fontDefaults';

describe('migrateLegacyFontConfig', () => {
  it('upgrades UI and terminal fonts only when both exact legacy values match', () => {
    const config = { uiFont: LEGACY_UI_FONT, terminalFont: LEGACY_TERMINAL_FONT };

    expect(migrateLegacyFontConfig(config)).toEqual({
      uiFont: DEFAULT_UI_FONT,
      terminalFont: DEFAULT_TERMINAL_FONT,
    });
    expect(config).toEqual({ uiFont: LEGACY_UI_FONT, terminalFont: LEGACY_TERMINAL_FONT });
  });

  it('does not upgrade when only the UI font is legacy', () => {
    const config = { uiFont: LEGACY_UI_FONT, terminalFont: DEFAULT_TERMINAL_FONT };

    expect(migrateLegacyFontConfig(config)).toBe(config);
  });

  it('does not upgrade when only the terminal font is legacy', () => {
    const config = { uiFont: DEFAULT_UI_FONT, terminalFont: LEGACY_TERMINAL_FONT };

    expect(migrateLegacyFontConfig(config)).toBe(config);
  });

  it('does not alter customized font values', () => {
    const config = { uiFont: 'Custom UI', terminalFont: 'Custom terminal' };

    expect(migrateLegacyFontConfig(config)).toBe(config);
  });
});
