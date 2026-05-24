/**
 * 语法高亮引擎
 * 根据高亮规则集为终端内容应用颜色、加粗、斜体等样式
 */

import type { HighlightRuleSet, HighlightRule } from '../types';

export interface HighlightMatch {
  start: number;
  end: number;
  rule: HighlightRule;
}

/**
 * 对单行文本应用高亮规则集
 * 返回带 <span> 标签的 HTML 字符串
 */
export function applyHighlightSets(
  text: string,
  ruleSets: HighlightRuleSet[]
): string {
  if (!text || ruleSets.length === 0) return escapeHtml(text);

  // 收集所有匹配项
  const enabledSets = ruleSets.filter(s => s.isEnabled);
  const allMatches: HighlightMatch[] = [];

  for (const set of enabledSets) {
    for (const rule of set.rules) {
      if (!rule.pattern) continue;
      try {
        if (rule.isRegex) {
          if (rule.pattern.length > 200) continue;
          const regex = new RegExp(rule.pattern, 'g');
          let match: RegExpExecArray | null;
          while ((match = regex.exec(text)) !== null) {
            allMatches.push({
              start: match.index,
              end: match.index + match[0].length,
              rule,
            });
            if (match[0].length === 0) regex.lastIndex++;
          }
        } else {
          let startIdx = 0;
          const lowerText = text.toLowerCase();
          const lowerPattern = rule.pattern.toLowerCase();
          while ((startIdx = lowerText.indexOf(lowerPattern, startIdx)) !== -1) {
            allMatches.push({
              start: startIdx,
              end: startIdx + rule.pattern.length,
              rule,
            });
            startIdx += rule.pattern.length;
          }
        }
      } catch {
        // Invalid regex, skip
      }
    }
  }

  if (allMatches.length === 0) return escapeHtml(text);

  // 排序并去重（优先保留最长的匹配）
  allMatches.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - a.end; // Longer first
  });

  // 合并不重叠的匹配
  const merged: HighlightMatch[] = [];
  for (const m of allMatches) {
    const last = merged[merged.length - 1];
    if (!last || m.start >= last.end) {
      merged.push(m);
    }
  }

  // 构建 HTML
  const parts: string[] = [];
  let lastEnd = 0;
  for (const m of merged) {
    if (m.start > lastEnd) {
      parts.push(escapeHtml(text.slice(lastEnd, m.start)));
    }
    const highlighted = escapeHtml(text.slice(m.start, m.end));
    const style = buildStyle(m.rule);
    parts.push(`<span style="${style}">${highlighted}</span>`);
    lastEnd = m.end;
  }
  if (lastEnd < text.length) {
    parts.push(escapeHtml(text.slice(lastEnd)));
  }

  return parts.join('');
}

function buildStyle(rule: HighlightRule): string {
  const styles: string[] = [];
  if (rule.color) {
    // Only allow valid CSS color values (#hex, rgb, named colors)
    if (/^#[0-9a-fA-F]{3,8}$/.test(rule.color) || /^(rgb|hsl)a?\(/.test(rule.color) || /^[a-z]+$/i.test(rule.color)) {
      styles.push(`color:${rule.color}`);
    }
  }
  if (rule.bold) styles.push('font-weight:bold');
  if (rule.italic) styles.push('font-style:italic');
  return styles.join(';');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
