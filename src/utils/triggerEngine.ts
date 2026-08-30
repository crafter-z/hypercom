/**
 * 条件触发引擎
 * 纯函数：根据触发规则匹配接收数据，返回需要执行的动作列表
 * 实际的动作执行（toast / 自动回复）由调用方处理
 */

import type { TriggerRule } from '../types';

/** 触发匹配结果：匹配到的规则 + 匹配文本 */
export interface TriggerAction {
  rule: TriggerRule;
  matchedText: string;
}

/** 模式最大长度（ReDoS 防护，与 highlightEngine 一致） */
const MAX_PATTERN_LENGTH = 200;

/**
 * 将字节数组转为大写、空格分隔的 HEX 字符串
 * 例: [0xAA, 0x55] → "AA 55"
 */
export function bytesToHexString(data: number[]): string {
  return data.map((b) => (b & 0xff).toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

/**
 * 规范化 HEX 模式字符串：去多余空格、转大写
 * 例: "aa  55 bb" → "AA 55 BB"
 */
export function normalizeHexPattern(pattern: string): string {
  return pattern.trim().toUpperCase().replace(/\s+/g, ' ');
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

  for (const rule of triggers) {
    if (!rule.isEnabled) continue;
    if (!rule.pattern) continue;
    if (rule.pattern.length > MAX_PATTERN_LENGTH) continue;
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
        try {
          // ReDoS 防护：短模式也可能触发指数回溯（如 (a+)+$），仅对前 5000 字符 test
          const safeContent = content.length > 5000 ? content.slice(0, 5000) : content;
          matched = new RegExp(rule.pattern).test(safeContent);
        } catch {
          // 无效正则，跳过
          continue;
        }
        break;

      case 'hex': {
        if (!rawData || rawData.length === 0) continue;
        const hexStr = bytesToHexString(rawData);
        const normalizedPattern = normalizeHexPattern(rule.pattern);
        matched = hexStr.includes(normalizedPattern);
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