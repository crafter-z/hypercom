import { useCallback, useEffect, useRef } from 'react';
import { eventService } from '../../services/tauri';
import { getRxPipeline } from '../../utils/rxPipeline';

/** 交接期间暂存的一个 serial:data 事件（原始 payload，不解析）。 */
interface PendingRxEvent {
  data: number[];
  timestamp: number;
}

/**
 * 终端弹窗的 RX 喂入器（S-I3）。
 *
 * 弹窗与主窗吃同一条后端广播 `serial:data`，但字节只经 G 的既有 RX 管线落行——
 * `getRxPipeline()` 负责字节级行聚合、编码解码、rAF 批写与静默 flush，这里一行
 * 都不重实现（弹窗是独立 webview，管线单例在它的模块作用域里自然接线到本窗
 * 自己的 store 与环形缓冲）。
 *
 * 快照交接（request→reply）用确定的顺序规则，而不是「缓冲是否为空」这种竞态
 * 启发式——后者既会与主窗已冲刷进快照的行重叠，又会把主窗尚未冲刷的行连同判定
 * 一起丢掉：
 *
 * 1. 闸门打开前到达的事件只进 `pending`，不喂管线（此时缓冲由快照独占写入，
 *    `replaceTerminalLines` 不会覆盖任何实时行）；
 * 2. 组件在快照落库后调 `openGate(快照末行时间戳)`：主窗回快照前先 `flushNow`
 *    排空了自己的队列，所以时间戳 ≤ 该值的事件必然已在快照里（丢弃，防重复），
 *    严格晚于该值的才是快照之后的新行（按到达顺序喂入，防丢行）。
 *
 * 兜底：主窗在个别时序下可能根本不回快照（例如端口的终端态尚未建立）。交接
 * 不能因此把实时显示永久静默——调用方在超时后以 `openGate(null)` 无条件开闸。
 */
export function usePortSerialFeed(portId: string): {
  /** 打开闸门：`snapshotLastTs` 为快照末行时间戳，null = 无快照（全部放行）。 */
  openGate: (snapshotLastTs: number | null) => void;
} {
  const pendingRef = useRef<PendingRxEvent[]>([]);
  const gateOpenRef = useRef(false);

  useEffect(() => {
    // 切换端口 = 重新走一次交接，上一个端口的 pending 没有意义。
    pendingRef.current = [];
    gateOpenRef.current = false;
    const pipeline = getRxPipeline();
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    eventService
      .onSerialData((event) => {
        if (event.port_id !== portId) return;
        if (!gateOpenRef.current) {
          pendingRef.current.push({ data: event.data, timestamp: event.timestamp });
          return;
        }
        pipeline.feedBytes(portId, event.data, event.timestamp);
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch((e) => console.debug('[usePortSerialFeed] subscribe failed:', e));

    return () => {
      cancelled = true;
      unlisten?.();
      pendingRef.current = [];
      gateOpenRef.current = false;
    };
  }, [portId]);

  const openGate = useCallback(
    (snapshotLastTs: number | null) => {
      if (gateOpenRef.current) return;
      gateOpenRef.current = true;
      const pipeline = getRxPipeline();
      for (const event of pendingRef.current) {
        if (snapshotLastTs !== null && event.timestamp <= snapshotLastTs) continue;
        pipeline.feedBytes(portId, event.data, event.timestamp);
      }
      pendingRef.current = [];
    },
    [portId],
  );

  return { openGate };
}
