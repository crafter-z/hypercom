/**
 * 条件触发引擎
 * 纯函数：根据触发规则匹配接收数据，返回需要执行的动作列表
 * 实际的动作执行（toast / 自动回复）由调用方处理
 */

import type { TriggerRule } from '../types';
import { bytesToSpacedHex } from './hexFormat';
import { parseHexBytes } from './hexUtils';
import { tryCreateSafeRegex } from './safeRegex';

/** 触发匹配结果：匹配到的规则 + 匹配文本 */
export interface TriggerAction {
  rule: TriggerRule;
  matchedText: string;
}

/** 模式最大长度（ReDoS 防护，与 highlightEngine 一致） */
const MAX_PATTERN_LENGTH = 200;

/**
 * 规范化 HEX 模式为完整字节：紧凑或空白分隔写法使用同一严格解析。
 * 例: "aa55bb" / "aa  55 bb" → "AA 55 BB"；非法或空模式 → ""。
 */
export function normalizeHexPattern(pattern: string): string {
  return bytesToSpacedHex(parseHexBytes(pattern));
}

/**
 * 评估所有已启用的触发规则，返回匹配到的动作列表
 *
 * @param content  接收到的文本内容（已解码）
 * @param rawData  原始字节数组（用于 HEX 匹配，可选）
 * @param triggers 触发规则列表
 * @param portId   当前数据来源的串口 ID（可选）。
 *                 规则声明了 portId 且与当前端口不符时跳过；
 *                 未声明（undefined / 空字符串）的规则对所有端口生效。
 * @returns 匹配到的触发动作数组
 */
export function evaluateTriggers(
  content: string,
  rawData: number[] | undefined,
  triggers: TriggerRule[],
  portId?: string
): TriggerAction[] {
  const actions: TriggerAction[] = [];
  // Several enabled HEX rules can inspect the same frame. Convert once per
  // evaluation instead of allocating the spaced representation per rule.
  let normalizedHexContent: string | undefined;

  for (const rule of triggers) {
    if (!rule.isEnabled) continue;
    if (!rule.pattern) continue;
    // 长度上限只针对正则：contains/exact/hex 是线性匹配，长模式是合法输入
    // （例如较长的 HEX 帧）。超过上限的正则跳过以限制 ReDoS 面。
    if (rule.matchType === 'regex' && rule.pattern.length > MAX_PATTERN_LENGTH) continue;
    // 端口过滤：rule.portId 声明了具体串口时，仅匹配该端口的数据
    if (rule.portId && rule.portId !== portId) continue;

    let matched = false;

    switch (rule.matchType) {
      case 'contains':
        matched = content.includes(rule.pattern);
        break;

      case 'exact':
        matched = content === rule.pattern;
        break;

      case 'regex':
        // Length/input truncation alone does not prevent exponential
        // backtracking. Reject nested-quantifier patterns before they run on
        // the RX/UI thread.
        const regex = tryCreateSafeRegex(rule.pattern);
        if (!regex) continue;
        const safeContent = content.length > 5000 ? content.slice(0, 5000) : content;
        matched = regex.test(safeContent);
        break;

      case 'hex': {
        if (!rawData || rawData.length === 0) continue;
        normalizedHexContent ??= bytesToSpacedHex(rawData);
        const normalizedPattern = normalizeHexPattern(rule.pattern);
        if (!normalizedPattern) continue;
        matched = normalizedHexContent.includes(normalizedPattern);
        break;
      }

      default:
        continue;
    }

    if (matched) {
      actions.push({ rule, matchedText: content });
    }
  }

  return actions;
}