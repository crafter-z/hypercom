/**
 * RxLineAssembler — 纯字节级行聚合器（RX 管线第一层）。
 *
 * 串口读事件按 ≤1024B/次切分，与行边界无关：一次设备响应可能横跨多个
 * serial:data 事件，一个事件里也可能有多行。旧的「一事件一行」逻辑会直接
 * 把跨事件的响应切成碎片行（首字符独占一行）。本类按 0x0A (LF) /
 * 0x0D (CR) 在**字节级**把流切成「已完成行的字节块」：
 *
 * - CR、LF 均为分隔符；跨两次 feed 的 CRLF 对识别为**一个**分隔符——
 *   CR 处发射当前行并置 pendingCR 标记，下一字节是 LF 则静默吞掉，
 *   是其它字节则照常处理（标记随之清除）。
 * - 单独的 CR 也是分隔符（classic Mac 风格 / 部分设备）。
 * - 连续分隔符发射空块（[]）表示空行；是否过滤空行由上层（wrapper）决定。
 * - pending 达到 maxPendingBytes 时无分隔符强制发射——防止无换行的
 *   二进制流让缓冲无限增长。
 *
 * 0x0A/0x0D 不可能出现在 UTF-8 / GBK 的多字节序列内部（ISO-8859-1 与
 * ASCII 本就是单字节），因此字节级切分对全部四种受支持编码都安全。
 *
 * 纯逻辑：无 React/store/timer/TextDecoder 依赖，可独立单测。
 */

const LF = 0x0a;
const CR = 0x0d;

export interface RxLineAssemblerOptions {
  /** 强制发射阈值（字节）：pending 达到该长度即无分隔符发射。默认 4096 */
  maxPendingBytes?: number;
}

export class RxLineAssembler {
  private readonly maxPendingBytes: number;
  /** 尚未终结的行字节（不含分隔符） */
  private pending: number[] = [];
  /** 上一个发射的分隔符是 CR：下一字节若是 LF 则视为 CRLF 对的后半，静默吞掉 */
  private pendingCR = false;

  constructor(opts?: RxLineAssemblerOptions) {
    this.maxPendingBytes = opts?.maxPendingBytes ?? 4096;
  }

  /**
   * 喂入一段字节，返回按流顺序完成的行字节块（块内容不含分隔符）。
   * 输入可为任意 ArrayLike<number>（number[] / Uint8Array），不会被修改。
   */
  feed(bytes: ArrayLike<number>): number[][] {
    const lines: number[][] = [];
    for (let i = 0; i < bytes.length; i++) {
      const b = (bytes[i] ?? 0) & 0xff;
      if (this.pendingCR) {
        this.pendingCR = false;
        if (b === LF) {
          // CRLF 对的后半：行已在 CR 处发射，静默消费
          continue;
        }
        // 非 LF：标记已清除，按普通字节继续处理
      }
      if (b === CR || b === LF) {
        // 分隔符：发射当前行（pending 为空时即空块 = 空行），重置 pending。
        // CR 额外置 pendingCR，用于识别跨 feed 的 CRLF 对。
        lines.push(this.pending);
        this.pending = [];
        if (b === CR) this.pendingCR = true;
      } else {
        this.pending.push(b);
        if (this.pending.length >= this.maxPendingBytes) {
          // 强制发射：防止无换行二进制流无界增长。发射后继续扫描本段剩余字节
          lines.push(this.pending);
          this.pending = [];
        }
      }
    }
    return lines;
  }

  /** 取出未终结的尾部字节并重置状态（静默 flush / 断线 / 编码切换用）。可能为空数组 */
  takeTail(): number[] {
    const tail = this.pending;
    this.pending = [];
    this.pendingCR = false;
    return tail;
  }

  /** 是否存在未终结的尾部字节 */
  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** 丢弃所有缓冲字节与分隔符标记（重连 / 编码切换时从干净状态开始） */
  reset(): void {
    this.pending = [];
    this.pendingCR = false;
  }
}
