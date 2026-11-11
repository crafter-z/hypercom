import { describe, it, expect } from 'vitest';
import { roundDurationMs, totalDurationMs, formatDurationMs } from './flowTiming';

/** 只关心 `delay`，其余字段与估算无关。 */
const step = (delay: number) => ({ delay });
const stepNaN = () => ({ delay: Number.NaN });

describe('roundDurationMs — 轮内耗时', () => {
  it('空集合轮内耗时为 0', () => {
    expect(roundDurationMs([])).toBe(0);
  });

  it('单步集合轮内耗时为 0，末步 delay 不生效', () => {
    expect(roundDurationMs([step(5000)])).toBe(0);
  });

  it('多步集合只累加非末步的 delay', () => {
    // 末步的 999 属于轮边界，由集合级 loopDelay 接管。
    expect(roundDurationMs([step(100), step(200), step(999)])).toBe(300);
  });

  it('两步集合只算第一步', () => {
    expect(roundDurationMs([step(120), step(340)])).toBe(120);
  });

  it('缺省/负值/NaN delay 一律按 0，不产生 NaN', () => {
    expect(roundDurationMs([step(-100), { delay: undefined as unknown as number }, step(250)])).toBe(0);
    expect(roundDurationMs([stepNaN(), step(50)])).toBe(0);
    const result = roundDurationMs([stepNaN(), stepNaN(), stepNaN()]);
    expect(Number.isNaN(result)).toBe(false);
    expect(result).toBe(0);
  });
});

describe('totalDurationMs — 一次运行总耗时', () => {
  it('rounds = 1 时等于一轮耗时，不含轮间间隔', () => {
    const commands = [step(100), step(200), step(999)];
    expect(totalDurationMs(commands, 5000, 1)).toBe(300);
  });

  it('rounds = 3 时 = 3×轮耗时 + 2×loopDelay', () => {
    const commands = [step(100), step(200), step(999)];
    expect(totalDurationMs(commands, 5000, 3)).toBe(3 * 300 + 2 * 5000);
  });

  it('loopDelay 为 0 或缺失时不加轮间间隔', () => {
    const commands = [step(100), step(200), step(999)];
    expect(totalDurationMs(commands, 0, 3)).toBe(900);
    expect(totalDurationMs(commands, undefined as unknown as number, 3)).toBe(900);
  });

  it('单步/空集合时只剩轮间间隔', () => {
    expect(totalDurationMs([step(999)], 1000, 3)).toBe(2000);
    expect(totalDurationMs([], 1000, 3)).toBe(2000);
  });

  it('rounds <= 0 表示不限轮数 → null', () => {
    const commands = [step(100), step(200)];
    expect(totalDurationMs(commands, 1000, 0)).toBeNull();
    expect(totalDurationMs(commands, 1000, -3)).toBeNull();
    expect(totalDurationMs(commands, 1000, Number.NaN)).toBeNull();
    expect(totalDurationMs(commands, 1000, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('负 delay / NaN delay 不产生 NaN 或负值', () => {
    const commands = [step(-50), stepNaN(), stepNaN()];
    const total = totalDurationMs(commands, -1000, 3);
    expect(Number.isNaN(total)).toBe(false);
    expect(total).toBe(0);
  });

  it('正常入参结果永远有限', () => {
    const commands = [step(1200), step(800), step(50_000)];
    for (const rounds of [1, 2, 10]) {
      const total = totalDurationMs(commands, 2000, rounds);
      expect(total).not.toBeNull();
      expect(Number.isFinite(total as number)).toBe(true);
    }
  });
});

describe('formatDurationMs — 人类可读时长', () => {
  it('小于 1000 ms 用毫秒并取整', () => {
    expect(formatDurationMs(0)).toBe('0 ms');
    expect(formatDurationMs(850)).toBe('850 ms');
    expect(formatDurationMs(999)).toBe('999 ms');
    expect(formatDurationMs(12.6)).toBe('13 ms');
  });

  it('小于 60 s 用秒，保留 1 位小数并去掉多余的 .0', () => {
    expect(formatDurationMs(1000)).toBe('1 s');
    expect(formatDurationMs(1200)).toBe('1.2 s');
    expect(formatDurationMs(2000)).toBe('2 s');
    expect(formatDurationMs(59_900)).toBe('59.9 s');
  });

  it('小于 60 min 用「min + s」，秒为 0 时省略秒', () => {
    expect(formatDurationMs(60_000)).toBe('1 min');
    expect(formatDurationMs(90_000)).toBe('1 min 30 s');
    expect(formatDurationMs(180_000)).toBe('3 min');
    expect(formatDurationMs(3_599_000)).toBe('59 min 59 s');
  });

  it('60 min 及以上用「h + min」，分钟为 0 时省略', () => {
    expect(formatDurationMs(3_600_000)).toBe('1 h');
    expect(formatDurationMs(7_200_000)).toBe('2 h');
    expect(formatDurationMs(7_500_000)).toBe('2 h 5 min');
  });

  it('负数 / NaN / Infinity 按 0 → "0 ms"', () => {
    expect(formatDurationMs(-1)).toBe('0 ms');
    expect(formatDurationMs(Number.NaN)).toBe('0 ms');
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe('0 ms');
    expect(formatDurationMs(Number.NEGATIVE_INFINITY)).toBe('0 ms');
  });
});
