/**
 * 命令集时长的纯估算（唯一实现）。
 *
 * 语义与 `flowSchedule.ts` 的推进规则严格对齐——只有两条时间规则：
 * 1. **步骤之间**用这一步自己的 `delay`；
 * 2. **轮与轮之间**用集合级 `loopDelay`，轮末那一步的 `delay` 不参与。
 *
 * 因此「一轮自身的耗时」= 除最后一步外各步 `delay` 之和；末步的 `delay`
 * 被轮间间隔取代，估算里必须显式丢掉，否则每轮都会多算一段。
 *
 * 纯函数：无 DOM / React / Tauri 依赖，可在 vitest node 环境下直测。
 */
import type { SendCommand } from '../types';

/**
 * 单个延时值的兜底：非有限值（NaN / ±Infinity）/ 负值 / 非数字一律按 0。
 * 这是「绝不返回 NaN/Infinity」的唯一归一入口。
 */
function safeDelayMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** 一轮自身的耗时（不含轮间间隔）：除最后一步外，各步 delay 之和。 */
export function roundDurationMs(commands: readonly Pick<SendCommand, 'delay'>[]): number {
  // 空集合与单步集合都没有「步骤之间」，轮内耗时为 0。
  if (!Array.isArray(commands) || commands.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < commands.length - 1; i += 1) {
    total += safeDelayMs(commands[i]?.delay);
  }
  return Number.isFinite(total) ? total : 0;
}

/**
 * 一次运行的总耗时（不含发送本身与设备响应耗时）。
 * 语义：rounds 轮 × 每轮耗时 + (rounds - 1) × loopDelay。
 * rounds <= 0（含非有限值）表示不限轮数（跟随 isLoop 的无限循环）→ 返回 null。
 * 非有限值/负值一律按 0 处理，绝不返回 NaN/Infinity。
 */
export function totalDurationMs(
  commands: readonly Pick<SendCommand, 'delay'>[],
  loopDelay: number,
  rounds: number,
): number | null {
  const safeRounds = Number.isFinite(rounds) ? rounds : 0;
  if (safeRounds <= 0) return null;

  const perRound = roundDurationMs(commands);
  const gap = safeDelayMs(loopDelay);
  const total = perRound * safeRounds + gap * (safeRounds - 1);
  // 极端入参（如超大 rounds）可能溢出为 Infinity：兜底为 0 而不是 Infinity。
  if (!Number.isFinite(total)) return 0;
  return Math.max(0, total);
}

/** 去掉 `toFixed(1)` 结果里多余的 `.0`（'2.0' → '2'，'1.2' 保持不变）。 */
function trimTrailingZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

/** 人类可读时长，语言无关（不是 i18n 文案）：'850 ms' / '1.2 s' / '1 min 30 s' / '2 h 5 min'。 */
export function formatDurationMs(ms: number): string {
  const safe = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;

  if (safe < 1000) return `${Math.round(safe)} ms`;

  if (safe < 60_000) {
    return `${trimTrailingZero((safe / 1000).toFixed(1))} s`;
  }

  if (safe < 3_600_000) {
    const minutes = Math.floor(safe / 60_000);
    const seconds = Math.floor((safe % 60_000) / 1000);
    return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
  }

  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}
