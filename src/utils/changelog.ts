/**
 * changelog 轻量解析（issue #12 二轮）
 *
 * release notes 源是 RELEASE_NOTES.md 章节（Markdown），弹窗不再用 `<pre>`
 * 原文渲染：解析 标题/列表/加粗 三个高频语法为结构化 tokens，组件层渲染成
 * React 节点（不走 dangerouslySetInnerHTML——notes 虽自有发布产物，仍按
 * 渲染层防注入纪律）。纯函数，便于单测。
 */

export type ChangelogBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'para'; text: string };

/** 切分一行内的加粗段 `**文本**` → 有序段列表（无加粗 → 单段）。 */
export function splitBold(text: string): Array<{ text: string; bold: boolean }> {
  const parts: Array<{ text: string; bold: boolean }> = [];
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), bold: false });
    parts.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), bold: false });
  return parts;
}

/**
 * 按行解析整篇 notes 为块序列：
 * - `# / ## / ###`（更深级别 clamp 到 3）→ heading
 * - `- ` / `* ` 开头 → bullet
 * - 其余非空行 → para
 * 空行跳过。行尾空白剥除。
 */
export function parseChangelog(notes: string): ChangelogBlock[] {
  const blocks: ChangelogBlock[] = [];
  for (const rawLine of notes.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3) as 1 | 2 | 3;
      blocks.push({ kind: 'heading', level, text: heading[2].trim() });
      continue;
    }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ kind: 'bullet', text: bullet[1].trim() });
      continue;
    }
    blocks.push({ kind: 'para', text: line });
  }
  return blocks;
}
