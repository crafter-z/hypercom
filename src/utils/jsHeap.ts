/**
 * 前端 V8 JS 堆占用读取（Chromium/WebView2 专属 `performance.memory`）。
 *
 * 量的是软件逻辑真实持有（缓冲/行对象/字符串），清屏/GC 后会回落，比进程
 * RSS 更能反映"我们控的内存"。不存在时返回 0（降级为只有硬约束）。
 *
 * 单一实现：viewportManager 软兜底（字节）与 StatusBar 显示（MB）共用，
 * 避免两份重复的 performance.memory 读取。
 */

/** JS 堆占用（字节）。不可用时返回 0。 */
export function readJsHeapBytes(): number {
  const perf = performance as Performance & { memory?: { usedJSHeapSize?: number } };
  return perf.memory?.usedJSHeapSize ?? 0;
}

/** JS 堆占用（MB，四舍五入）。不可用时返回 0。 */
export function readJsHeapMb(): number {
  const bytes = readJsHeapBytes();
  return bytes ? Math.round(bytes / (1024 * 1024)) : 0;
}
