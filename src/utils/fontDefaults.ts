/**
 * Shared font defaults for the frontend configuration and legacy migration.
 *
 * Keep these values in lockstep with `src-tauri/src/config/mod.rs`: Rust applies
 * the same migration while loading config.json, while the frontend mirrors it
 * for older/backward-compatible config responses.
 */
export const LEGACY_UI_FONT = 'Inter, sans-serif';
export const LEGACY_TERMINAL_FONT = 'Consolas, monospace';

export const DEFAULT_UI_FONT = 'Inter, "Noto Sans SC", "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif';
export const DEFAULT_TERMINAL_FONT = 'Consolas, "Noto Sans SC", "Microsoft YaHei", "PingFang SC", "Segoe UI", monospace';

export interface FontConfigValues {
  uiFont: string;
  terminalFont: string;
}

/**
 * Upgrade the legacy pair only when both fields are the exact old defaults.
 *
 * A user may have customized either field independently, so matching one old
 * value must not overwrite the other field or infer that a migration is safe.
 * The function is deliberately pure: callers decide when the upgraded
 * snapshot is committed/persisted.
 */
export function isLegacyFontPair(config: FontConfigValues): boolean {
  return config.uiFont === LEGACY_UI_FONT && config.terminalFont === LEGACY_TERMINAL_FONT;
}

export function migrateLegacyFontConfig<T extends FontConfigValues>(config: T): T {
  if (!isLegacyFontPair(config)) return config;
  return {
    ...config,
    uiFont: DEFAULT_UI_FONT,
    terminalFont: DEFAULT_TERMINAL_FONT,
  };
}
