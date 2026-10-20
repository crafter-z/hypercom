/**
 * 语法高亮引擎
 * 根据高亮规则集为终端内容应用颜色、加粗、斜体等样式
 */

import type { HighlightRuleSet, HighlightRule } from '../types';
import { safeCssColor } from './cssColor';

/** 已告警过的非法正则模式（按 pattern 去重，避免随每批 RX 反复刷屏）。 */
const warnedInvalidRegex = new Set<string>();

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
          // ReDoS 防护：短模式也可能触发指数回溯（如 (a+)+$），仅对前 5000 字符跑 exec
          const safeText = text.length > 5000 ? text.slice(0, 5000) : text;
          const regex = new RegExp(rule.pattern, 'g');
          let match: RegExpExecArray | null;
          while ((match = regex.exec(safeText)) !== null) {
            allMatches.push({
              start: match.index,
              end: match.index + match[0].length,
              rule,
            });
            if (match[0].length === 0) regex.lastIndex++;
          }
        } else {
          const lowerText = text.toLowerCase();
          const lowerPattern = rule.pattern.toLowerCase();
          // `toLowerCase` may change string length (e.g. 'İ' → 'i̇'), which
          // would shift every index found in the lowercased copy. Fall back to
          // per-character comparison in that rare case (same rule as search).
          if (lowerText.length === text.length && lowerPattern.length === rule.pattern.length) {
            let startIdx = 0;
            while ((startIdx = lowerText.indexOf(lowerPattern, startIdx)) !== -1) {
              allMatches.push({
                start: startIdx,
                end: startIdx + rule.pattern.length,
                rule,
              });
              startIdx += rule.pattern.length;
            }
          } else {
            for (let s = 0; s + rule.pattern.length <= text.length; s++) {
              let ok = true;
              for (let k = 0; k < rule.pattern.length; k++) {
                if (text[s + k].toLowerCase() !== rule.pattern[k].toLowerCase()) { ok = false; break; }
              }
              if (ok) {
                allMatches.push({ start: s, end: s + rule.pattern.length, rule });
                s += rule.pattern.length - 1;
              }
            }
          }
        }
      } catch {
        // Invalid regex pattern, skip. 同一 pattern 只告警一次，避免随 RX 刷屏。
        if (!warnedInvalidRegex.has(rule.pattern)) {
          warnedInvalidRegex.add(rule.pattern);
          console.warn('[highlightEngine] Invalid regex pattern:', rule.pattern.slice(0, 50));
        }
      }
    }
  }

  if (allMatches.length === 0) return escapeHtml(text);

  // 排序并去重（优先保留最长的匹配）
  allMatches.sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - a.end; // Longer first
  });

  // 合并不重叠的匹配：重叠时保留先出现（更长）的区间，但后者的未覆盖尾部
  // 仍要单独高亮——直接丢弃会让长匹配中真正命中的尾部失去样式。
  const merged: HighlightMatch[] = [];
  for (const m of allMatches) {
    if (m.end <= m.start) continue;
    const last = merged[merged.length - 1];
    if (!last || m.start >= last.end) {
      merged.push(m);
      continue;
    }
    if (m.end > last.end) {
      merged.push({ start: last.end, end: m.end, rule: m.rule });
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
  const color = safeCssColor(rule.color);
  if (color) styles.push(`color:${color}`);
  if (rule.bold) styles.push('font-weight:bold');
  if (rule.italic) styles.push('font-style:italic');
  return styles.join(';');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
