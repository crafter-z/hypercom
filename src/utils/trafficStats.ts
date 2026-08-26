/**
 * trafficStats — 流量统计 1s 聚合器（性能修复 P1-1）
 *
 * 背景：RX 侧 `useSerialReceive` 对**每个** serial:data 事件调用 setTrafficStats →
 * Zustand 更新 → StatusBar（订阅 trafficStats）每事件重渲染；TX 侧 `sendToPort`
 * / `ttyService.send` 每发送一次也各调一次。高频事件（SIM 周期输出 200/s、突发
 * 数据、快速键入）下形成持续主线程负载（TTY 卡顿根因 #3）。
 *
 * 修法：事件字节数先本地累计，每 TRAFFIC_AGGREGATE_MS（1s）统一写一次 store。
 * - 总量语义不变：全部字节都被累计、一次不少（StatusBar 本就按 1s 窗口差分算
 *   速率，与「写入时机」无关，不会双重计算）；
 * - store 接口与字段不变（仍是 setTrafficStats），其它订阅者不受影响；
 * - RX / TX 三个写点（useSerialReceive / sendToPort / ttyService.send）共用
 *   同一聚合器与同一 1s 定时器，避免各写点重复实现。
 */

import { useAppStore } from '../stores/useAppStore';

/** 聚合窗口（ms）：窗口内字节本地累计，到期统一写 store。 */
export const TRAFFIC_AGGREGATE_MS = 1000;

interface PortAccum {
  rx: number;
  tx: number;
}

/** 每端口待写累计（仅内存，flush 后清空） */
const accum = new Map<string, PortAccum>();
/** 聚合定时器句柄（null = 无 pending 累计） */
let timer: ReturnType<typeof setTimeout> | null = null;

/** 首字节到达启动定时器（惰性：无累计时不跑定时器）。 */
function ensureTimer(): void {
  if (timer !== null) return;
  timer = setTimeout(flush, TRAFFIC_AGGREGATE_MS);
}

/** 把全部累计值写入 store 并清空（定时器到期 / flushNow / 测试收尾）。 */
function flush(): void {
  timer = null;
  if (accum.size === 0) return;
  const app = useAppStore.getState();
  const stats = app.trafficStats;
  for (const [portId, acc] of accum) {
    const prev = stats[portId];
    app.setTrafficStats(portId, {
      rxTotal: (prev?.rxTotal ?? 0) + acc.rx,
      txTotal: (prev?.txTotal ?? 0) + acc.tx,
    });
  }
  accum.clear();
}

export const trafficStats = {
  /** 累计 RX 字节数（≤0 忽略，不启动定时器）。 */
  addRx(portId: string, bytes: number): void {
    if (bytes <= 0) return;
    const acc = accum.get(portId) ?? { rx: 0, tx: 0 };
    acc.rx += bytes;
    accum.set(portId, acc);
    ensureTimer();
  },

  /** 累计 TX 字节数（≤0 忽略，不启动定时器）。 */
  addTx(portId: string, bytes: number): void {
    if (bytes <= 0) return;
    const acc = accum.get(portId) ?? { rx: 0, tx: 0 };
    acc.tx += bytes;
    accum.set(portId, acc);
    ensureTimer();
  },

  /** 立即把 pending 累计写入 store（测试用；断线收尾时亦可保证总量即时）。 */
  flushNow(): void {
    flush();
  },

  /** 清空累计与定时器（仅测试用；应用生命周期内不得调用）。 */
  reset(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    accum.clear();
  },
};
