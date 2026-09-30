/**
 * pluginObserver 性能冒烟（issue #17 设计 §9「性能冒烟：高频 RX 无劣化」的
 * 逻辑层近似——真实 UI 帧率需 `npm run tauri dev` + SIM:Loopback 高频模式手测）。
 *
 * 场景：观察器已接线，1 万行经真实 rxPipeline 行组装 + pluginObserver 批转发，
 * 断言全量投递完成且墙钟在预算内（真实定时器——投递走 rAF/setTimeout 兜底帧）。
 * 预算放宽到 2s：本测试守护的是「无意外 O(n²)/丢行/卡死」，不是精确帧率。
 */
import { describe, expect, it } from 'vitest';
import { addPluginRxObserver, resetPluginObserverForTest } from './pluginObserver';
import { getRxPipeline } from './rxPipeline';

const TOTAL_LINES = 10_000;

function feedLine(portId: string, text: string, ts: number): void {
  getRxPipeline().feedBytes(portId, new TextEncoder().encode(`${text}\n`), ts);
}

describe('pluginObserver 性能冒烟（设计 §9）', () => {
  it('10k 行喂入 + 批转发全量投递，墙钟 < 2s 且无丢行', async () => {
    let received = 0;
    const obs = {
      onRxLines: (lines: Array<{ portId: string }>): void => {
        received += lines.length;
      },
      onRxDetached: (): void => {},
    };
    const unsub = addPluginRxObserver(obs);
    try {
      const t0 = performance.now();
      for (let i = 0; i < TOTAL_LINES; i++) {
        feedLine('COM1', `line-${i}`, 1000 + i);
      }
      const feedMs = performance.now() - t0;
      // 等投递排空（每帧 2000 行 → 5 帧 × 16ms 兜底 tick 量级）。
      const deadline = t0 + 2000;
      while (received < TOTAL_LINES && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const totalMs = performance.now() - t0;
      expect(received).toBe(TOTAL_LINES); // 队列额度 10000 = 恰好无溢出丢行
      expect(totalMs).toBeLessThan(2000);
      // 喂入本身（行组装 + 解码 + 钩子多播）不得异常缓慢。
      expect(feedMs).toBeLessThan(1000);
    } finally {
      unsub();
      resetPluginObserverForTest();
    }
  });
});
