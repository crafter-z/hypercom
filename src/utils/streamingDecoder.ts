/**
 * StreamingDecoderCache — 持久化流式 TextDecoder 缓存（按 `${portId}:${label}` 索引）。
 *
 * 从 useSerialReceive 抽取的共享解码基础设施，弹出窗（TerminalPopout）与主窗
 * 接收路径复用同一份「防 GBK 乱码」逻辑，避免两处各自实现后漂移。
 *
 * 为什么必须流式（{stream:true}）+ 持久化：每次事件 new 一个 TextDecoder 时，
 * 跨两个 serial:data 事件的多字节字符（GBK 2 字节、UTF-8 3 字节）会在**两半**
 * 各解码出一个 U+FFFD——GBK 流量下必然乱码。流式解码让 decoder 保留尾部不完整
 * 字符，待下一事件补全后再输出。故 decoder 必须跨事件存活（本缓存即其生命周期）。
 *
 * 纯逻辑、无 React/store 依赖，可单测。
 */
export class StreamingDecoderCache {
  private readonly decoders = new Map<string, TextDecoder>();

  /**
   * 取（或惰性创建）portId+label 对应的流式 decoder。
   *
   * 在**新 label** 下创建时，先删除该端口所有旧 label 条目——切换编码后，
   * 上一编码 buffered 的尾部字节不能复活（否则乱码）。label 无效时回退 utf-8。
   */
  get(portId: string, label: string): TextDecoder {
    const key = `${portId}:${label}`;
    let decoder = this.decoders.get(key);
    if (!decoder) {
      const prefix = `${portId}:`;
      for (const k of this.decoders.keys()) {
        if (k.startsWith(prefix)) this.decoders.delete(k);
      }
      try {
        decoder = new TextDecoder(label, { fatal: false });
      } catch {
        console.warn('[StreamingDecoderCache] TextDecoder failed for encoding:', label, 'falling back to utf-8');
        decoder = new TextDecoder('utf-8', { fatal: false });
      }
      this.decoders.set(key, decoder);
    }
    return decoder;
  }

  /**
   * 丢弃某端口的全部 decoder（断线/重连时调用），使重连从干净状态开始。
   * 键为 `${portId}:${suffix}`——按前缀匹配，无论 suffix（label）为何。
   */
  clearPort(portId: string): void {
    const prefix = `${portId}:`;
    for (const key of this.decoders.keys()) {
      if (key.startsWith(prefix)) this.decoders.delete(key);
    }
  }
}
