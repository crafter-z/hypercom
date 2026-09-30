/**
 * releaseTerminalState — 关闭标签页 / 端口后的统一回收（S-E4）。
 *
 * 三份按 portId 索引的内存状态各自独立生长、各自都有消费者，但原先没有任何一处
 * 回收它们：
 * - `useTerminalStore.terminals`：每打开一个端口留一条显示态（滚动锁/编码/连接时刻）；
 * - `useSystemStore.trafficStats`：每端口累计字节，条目只增不删，StatusBar 查询
 *   已关闭端口时会命中陈旧总量；
 * - `useSerialSend` 的 sendHistoryMap：整段 TX 历史（含发送内容）常驻内存。
 *
 * 放在 store 层而不是组件里：关闭标签有多个入口（单个关闭、批量关闭左/右/其它），
 * 任何一个漏调都会留下幽灵端口——单一入口让「标签消失 = 三处数据一起消失」成为
 * 不变量。触发点是**关标签**而非断连：断连后标签仍在，编码/滚动锁要跨重连保留。
 */
import { trafficStats } from '../utils/trafficStats';
import { useTerminalStore } from './useTerminalStore';
import { releaseSendHistory } from '../hooks/useSerialSend';

export function releaseTerminalState(portId: string): void {
  useTerminalStore.getState().releaseTerminal(portId);
  // 必须经聚合器的 release（而非直接 clearTrafficStats）：它同时丢弃该端口尚未
  // flush 的本地累计，否则下一次 flush 会把刚清掉的幽灵条目写回来。
  trafficStats.release(portId);
  releaseSendHistory(portId);
}
