/**
 * pluginLogQuota 测试（issue #17 评审复审：P13 日志配额）。
 *
 * 时钟注入（nowMs）——确定性覆盖：突发额度、按秒回填、超限丢弃、
 * 告警窗口每 5s 一次。
 */
import { describe, expect, it } from 'vitest';
import { PluginLogQuota } from './pluginLogQuota';

describe('PluginLogQuota（P13 日志配额）', () => {
  it('突发额度内全放行，用尽后丢弃', () => {
    const q = new PluginLogQuota(3, 4);
    expect(q.tryConsume(0).allowed).toBe(true);
    expect(q.tryConsume(0).allowed).toBe(true);
    expect(q.tryConsume(0).allowed).toBe(true);
    const denied = q.tryConsume(0);
    expect(denied.allowed).toBe(false);
    expect(denied.droppedTotal).toBe(1);
  });

  it('按秒回填：250ms 后恢复 1 条额度', () => {
    const q = new PluginLogQuota(2, 4); // 4 条/秒 → 250ms 回填 1 条
    q.tryConsume(0);
    q.tryConsume(0);
    expect(q.tryConsume(0).allowed).toBe(false);
    expect(q.tryConsume(250).allowed).toBe(true);
    expect(q.tryConsume(250).allowed).toBe(false);
  });

  it('回填不超过突发上限', () => {
    const q = new PluginLogQuota(2, 4);
    q.tryConsume(0);
    q.tryConsume(0);
    // 等 10s（可回填 40）→ 只回满 burst=2。
    expect(q.tryConsume(10_000).allowed).toBe(true);
    expect(q.tryConsume(10_000).allowed).toBe(true);
    expect(q.tryConsume(10_000).allowed).toBe(false);
  });

  it('丢弃告警每 5s 窗口最多一次，窗口过后再告警', () => {
    const q = new PluginLogQuota(0, 0); // 恒无额度（纯丢弃路径测试）
    expect(q.tryConsume(0)).toMatchObject({ allowed: false, warn: true, droppedTotal: 1 });
    expect(q.tryConsume(1000)).toMatchObject({ allowed: false, warn: false, droppedTotal: 2 });
    expect(q.tryConsume(4999)).toMatchObject({ allowed: false, warn: false, droppedTotal: 3 });
    expect(q.tryConsume(5000)).toMatchObject({ allowed: false, warn: true, droppedTotal: 4 });
  });
});
