/**
 * pluginLogQuota — 插件日志配额（issue #17 评审复审，设计 D6/P13）
 *
 * 设计 v1 曾要求「插件日志独立通道 + 配额，不挤占 diaglog」。v1 落地为：
 * 日志仍进宿主 console→diaglog（保可见性），但按插件加 **令牌桶配额**
 * （突发 {{burst}} 条，{{refill}} 条/秒 回填）——坏插件高频 log 不再把应用
 * 自身诊断日志的 512KB 轮转窗口刷掉；超限丢弃并在每个 5s 窗口首次丢弃时
 * 告警一次（宿主 console.warn，带累计丢弃数）。真正的独立文件通道留待增量。
 *
 * 纯逻辑类（时钟注入 nowMs，vitest 确定性测试）。
 */

/** 突发额度（条）：允许插件短暂批量日志。 */
export const PLUGIN_LOG_BURST = 20;
/** 回填速率（条/秒）：持续速率上限。 */
export const PLUGIN_LOG_REFILL_PER_SEC = 4;
/** 丢弃告警窗口（ms）：窗口内首次丢弃告警一次，不逐条刷屏。 */
export const PLUGIN_LOG_WARN_WINDOW_MS = 5000;

export interface LogQuotaResult {
  allowed: boolean;
  /** 本次丢弃是否应输出一条告警（每个窗口最多一次）。 */
  warn: boolean;
  /** 累计已丢弃条数（warn 时拼进告警文案）。 */
  droppedTotal: number;
}

export class PluginLogQuota {
  private tokens: number;
  private lastRefillMs: number;
  private droppedTotal = 0;
  private lastWarnMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly burst: number = PLUGIN_LOG_BURST,
    private readonly refillPerSec: number = PLUGIN_LOG_REFILL_PER_SEC,
    private readonly warnWindowMs: number = PLUGIN_LOG_WARN_WINDOW_MS,
  ) {
    this.tokens = burst;
    this.lastRefillMs = 0;
  }

  /** 尝试消耗一条日志额度（调用方持有每插件一个实例）。 */
  tryConsume(nowMs: number): LogQuotaResult {
    const elapsedMs = nowMs - this.lastRefillMs;
    if (elapsedMs > 0) {
      const refilled = Math.floor((elapsedMs / 1000) * this.refillPerSec);
      if (refilled > 0) {
        this.tokens = Math.min(this.burst, this.tokens + refilled);
        this.lastRefillMs = nowMs;
      }
    }
    if (this.tokens > 0) {
      this.tokens--;
      return { allowed: true, warn: false, droppedTotal: this.droppedTotal };
    }
    this.droppedTotal++;
    const warn = nowMs - this.lastWarnMs >= this.warnWindowMs;
    if (warn) this.lastWarnMs = nowMs;
    return { allowed: false, warn, droppedTotal: this.droppedTotal };
  }
}
