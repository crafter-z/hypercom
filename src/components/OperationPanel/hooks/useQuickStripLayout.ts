/**
 * 快捷发送条的宽度自适应测量（issue #5-4）。
 *
 * 内联条在一行内尽量多显示命令药丸：ResizeObserver 跟踪容器、隐藏测量行跟踪
 * 每个药丸的真实宽度，`computeFitCount` 据此算出可见切片 + 溢出条数。测量逻辑
 * 属于「布局」而不是「发送」，故从 SendSection 抽成独立 hook——它只关心宽度，
 * 换任何一组命令/任何容器都成立。
 */
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { SendCommand } from '../../../types';
import { computeFitCount } from '../../../utils/sendStrip';

/** Strip layout constants — must mirror the CSS:
 * - gap = var(--space-1) = 4px (`.op-quick-send-row` gap)
 * - panel button estimate used before the first measurement lands. */
const QUICK_STRIP_GAP = 4;
const PANEL_BUTTON_ESTIMATE = 32;

export interface QuickStripLayout {
  /** 条容器（也用作测量容器）。 */
  stripRef: RefObject<HTMLDivElement>;
  /** 隐藏测量行：渲染全部命令以取得真实宽度。 */
  measureRowRef: RefObject<HTMLDivElement>;
  panelBtnRef: RefObject<HTMLButtonElement>;
  /** 实际渲染的可见命令（宽度驱动）。 */
  visibleCommands: SendCommand[];
  /** 未能显示、折叠进「⋯ +K」的命令数。 */
  overflowCount: number;
}

/**
 * @param commands 当前激活命令集的全部命令（按 order 排序）
 * @param enabled  条是否已挂载（`quickSendInlineCount > 0`）——未挂载时 ref 为
 *                 null，必须重新测量，故进 effect 依赖
 */
export function useQuickStripLayout(commands: SendCommand[], enabled: boolean): QuickStripLayout {
  const stripRef = useRef<HTMLDivElement>(null);
  const measureRowRef = useRef<HTMLDivElement>(null);
  const panelBtnRef = useRef<HTMLButtonElement>(null);
  const [stripWidth, setStripWidth] = useState(0);
  const [panelBtnWidth, setPanelBtnWidth] = useState(0);
  const [cmdWidths, setCmdWidths] = useState<number[]>([]);

  // 容器宽度 + 面板按钮宽度：挂载即测（useLayoutEffect 保证首帧前就有值），
  // 之后由 ResizeObserver 跟踪窗口/面板缩放。
  useLayoutEffect(() => {
    if (!enabled) return;
    const el = stripRef.current;
    if (!el) return;
    const update = () => {
      setStripWidth(el.getBoundingClientRect().width);
      setPanelBtnWidth(panelBtnRef.current?.getBoundingClientRect().width ?? 0);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]);

  // 命令药丸宽度：隐藏测量行渲染全部命令，其尺寸变化（命令集切换/字体加载）
  // 由 ResizeObserver 捕获；等值守卫避免无谓的重渲染循环。
  useLayoutEffect(() => {
    if (!enabled) return;
    const row = measureRowRef.current;
    if (!row) {
      setCmdWidths([]);
      return;
    }
    const update = () => {
      const widths = Array.from(row.children).map((c) => Math.ceil(c.getBoundingClientRect().width));
      setCmdWidths((prev) =>
        prev.length === widths.length && prev.every((w, i) => w === widths[i]) ? prev : widths
      );
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(row);
    return () => ro.disconnect();
  }, [commands, enabled]);

  // 布局：按实际测量宽度计算「放得下几条 + 溢出几条」。测量未落地前保守
  // 回退为 0 可见（useLayoutEffect 保证首帧前完成测量，用户看不到回退态）。
  const visibleCommands = useMemo(() => {
    if (commands.length === 0) return [];
    if (stripWidth <= 0 || cmdWidths.length === 0) return [];
    const layout = computeFitCount(stripWidth, cmdWidths, {
      panelButtonWidth: panelBtnWidth > 0 ? panelBtnWidth : PANEL_BUTTON_ESTIMATE,
      gap: QUICK_STRIP_GAP,
      minButtons: 1, // 有条命令时至少露一条（容器放得下面板按钮的前提下）
      maxButtons: commands.length, // 纯宽度驱动，不按 config 条数截断
    });
    return commands.slice(0, layout.visibleCount);
  }, [commands, stripWidth, cmdWidths, panelBtnWidth]);

  return {
    stripRef,
    measureRowRef,
    panelBtnRef,
    visibleCommands,
    overflowCount: commands.length - visibleCommands.length,
  };
}
