/**
 * 弹出窗 label 计算（前端侧）。
 *
 * 与 Rust `src-tauri/src/commands/popout.rs` 的 `sanitize` / `compute_label`
 * 保持逐字符一致——置顶 / 关闭命令靠 label 找窗口，两侧逻辑必须同步。
 */

/** 将任意字符串净化为窗口 label 安全的标识符：非 `[A-Za-z0-9_-]` 字符替换为 `_`。 */
export function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * 按 kind + targetId 计算窗口 label。
 *   - "quick-send" → "quick-send"（单例，targetId 忽略）
 *   - "terminal"   → `terminal-${sanitize(targetId)}`
 *   - 其它         → null（未知 kind）
 */
export function popoutLabel(kind: string, targetId: string | null): string | null {
  switch (kind) {
    case 'quick-send':
      return 'quick-send';
    case 'terminal':
      return `terminal-${sanitize(targetId ?? '')}`;
    default:
      return null;
  }
}
