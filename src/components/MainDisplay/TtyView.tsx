/**
 * TtyView — TTY 模式（xterm.js）终端宿主组件（issue #11）。
 *
 * 每个 TTY 端口一个实例：挂载时创建 xterm Terminal（字体/字号/主题取自应用配置与
 * CSS 变量），`term.open(container)` + FitAddon 随容器尺寸 fit（ResizeObserver +
 * rAF 防抖），onData → `ttyService.send`（TX），onResize → `ttyService.resize`
 * （尺寸协商，对端 `\x1b[18t` 查询的应答由 xterm 经 onData 自动回）。
 *
 * 与 TerminalView（TRX 行缓冲）零共享状态；Terminal 实例由本组件拥有，
 * 卸载时 dispose（ttyService.detach 不清实例）。
 *
 * 字体/字号变更走 `term.options.fontSize/fontFamily` **活更新**（不重建 Terminal）
 * ——重建会清空整个终端缓冲（曾因此改配置即丢会话）；Ctrl+滚轮缩放镜像
 * TerminalView（8–48px，同步 config + `--font-size-terminal` CSS 变量）。
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useAppStore } from '../../stores/useAppStore';
import { ttyService } from '../../utils/ttyService';

interface TtyViewProps {
  portId: string;
  /** true = 该标签非当前展示（Pane 常驻挂载 + display:none 隐藏）。xterm 实例与
   *  缓冲跨标签切换保留（issue #11：会话跨标签保留）；恢复可见时自动 re-fit。 */
  hidden?: boolean;
}

/** 从设计系统 CSS 变量读取主题色；缺省时回退到暗色 token 的写死值。 */
function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** 字体缩放夹取区间（与 TerminalView 的 Ctrl+wheel 一致）。 */
const FONT_MIN = 8;
const FONT_MAX = 48;

const TtyView: React.FC<TtyViewProps> = ({ portId, hidden }) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalFont = useAppStore((s) => s.config.terminalFont);
  const terminalFontSize = useAppStore((s) => s.config.terminalFontSize);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // 挂载一次性用当前配置创建 Terminal。字体/字号**不入依赖**——变更走下方
    // options 活更新；若把字体字段放进 deps，effect 重跑 → cleanup dispose →
    // 整个终端缓冲被清空（修复 issue #11 的字体切换丢会话缺陷）。
    const term = new Terminal({
      fontFamily: terminalFont || 'monospace',
      fontSize: terminalFontSize,
      scrollback: 5000,
      cursorBlink: true,
      theme: {
        background: cssVar('--bg-primary', '#191a1e'),
        foreground: cssVar('--text-primary', '#c9cdd6'),
        cursor: cssVar('--accent-color', '#5eafff'),
        selectionBackground: cssVar('--bg-active', 'rgba(94, 175, 255, 0.16)'),
      },
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    fitRef.current = fitAddon;

    // TX：用户键入/粘贴 → 发送到串口（无本地回显，由对端 echo）。
    const onDataDisposable = term.onData((data) => {
      // issue #11：GIT:BASH 模拟终端的 DSR（\x1b[6n 光标位置查询）由后端应答
      // （TRX 模式没有终端模拟器，后端必须应答 bash 才不阻塞）；xterm 也会自动
      // 应答 \x1b[row;colR——对 GIT: 端口过滤掉 xterm 的应答，避免 pty 收到双应答
      // （后端应答使用的 pty 尺寸已与 xterm 尺寸同步，数值一致）。
      if (portId.startsWith('GIT:') && /^\x1b\[\d+;\d+R$/.test(data)) return;
      ttyService.send(portId, data);
    });
    // issue #11：onResize 必须在 open/fit **之前**注册——初始 fit 把 xterm 从
    // 默认 80×24 变到实际尺寸时会触发一次 onResize，注册过晚该事件被漏掉，
    // 首帧尺寸从未上报：打开 GIT:BASH 时 pty 拿不到正确尺寸（固定 80×24），
    // vim/top 全屏应用按错误尺寸渲染（开屏混乱 / 编辑只用约 3/4 宽度）。
    // 尺寸协商：cols/rows 变化 → 同步对端（GIT: 模拟端口走后端 pty resize；
    // 真实串口由对端经 `\x1b[18t` 查询，xterm 经 onData 自动回尺寸）。
    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      ttyService.resize(portId, cols, rows);
    });

    term.open(container);
    try {
      fitAddon.fit();
    } catch {
      // 容器尺寸为 0（隐藏/未布局）时 fit 抛错——交给 ResizeObserver 稍后重试
    }
    // 兜底：无论初始 fit 是否触发 onResize，显式上报当前尺寸（term.cols/rows
    // 即当前实际值）。**隐藏挂载**（display:none → 容器 0 尺寸）时 fit 未生效、
    // term 仍是默认 80×24——此时上报会用 80×24 覆盖已记录的正确尺寸
    // （lastCols/lastRows），使重开 GIT:BASH 再次回退 80×24；跳过，尺寸留待
    // 恢复可见时的 re-fit（onResize → resize）校正。
    if (container.clientWidth > 0 && container.clientHeight > 0) {
      ttyService.resize(portId, term.cols, term.rows);
    }

    // 字体加载兜底：monospace 字体异步加载导致首帧 fit 按错误 cell 尺寸测算
    // （终端偏小）——字体就绪后重新 fit 覆盖该竞态。
    let cancelled = false;
    let fontRaf = 0;
    if (typeof document !== 'undefined' && document.fonts?.ready) {
      document.fonts.ready
        .then(() => {
          if (cancelled) return;
          fontRaf = requestAnimationFrame(() => {
            try {
              fitAddon.fit();
            } catch {
              // 容器仍无尺寸——下一次回调再试
            }
          });
        })
        .catch(() => {});
    }

    ttyService.attach(portId, term);

    // 容器尺寸变化 → 防抖 fit（rAF 合并同帧多次 ResizeObserver 回调）。
    let rafId = 0;
    const ro = new ResizeObserver(() => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        try {
          fitAddon.fit();
        } catch {
          // 容器仍无尺寸——下一次回调再试
        }
      });
    });
    ro.observe(container);

    return () => {
      cancelled = true;
      ttyService.detach(portId);
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      ro.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
      if (fontRaf) cancelAnimationFrame(fontRaf);
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
    // 字体/字号经下方 effect 活更新；挂载 effect 只认 portId。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portId]);

  // 字体/字号变更 → 直接写 xterm options（不重建 Terminal，保缓冲与滚动位置）。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = terminalFont || 'monospace';
    term.options.fontSize = terminalFontSize;
  }, [terminalFont, terminalFontSize]);

  // 隐藏（display:none → 容器 0 尺寸）恢复可见 → 显式 re-fit。ResizeObserver
  // 也会在 display:none→block 时触发，这里再补一次保证确定性（隐藏期间 fit 被
  // 跳过、尺寸未更新，恢复后立即按真实容器尺寸重排，vim/top 全屏应用据此重绘）。
  useEffect(() => {
    if (hidden) return;
    const raf = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // 容器仍无尺寸——RO/下一次可见再试
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [hidden]);

  // Ctrl+滚轮缩放（镜像 TerminalView：8–48px，同步 config + CSS 变量）。
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const store = useAppStore.getState();
    const current = store.config.terminalFontSize;
    const delta = e.deltaY > 0 ? -1 : 1;
    const next = Math.max(FONT_MIN, Math.min(FONT_MAX, current + delta));
    if (next !== current) {
      document.documentElement.style.setProperty('--font-size-terminal', `${next}px`);
      store.setConfig({ terminalFontSize: next });
    }
  }, []);

  return (
    <div className={`tty-view${hidden ? ' tty-view-hidden' : ''}`} onWheel={handleWheel}>
      <div className="tty-titlebar">
        <span className="tty-titlebar-label eyebrow">{t('tty.title')}</span>
        <span className="tty-titlebar-port">{portId}</span>
      </div>
      <div className="tty-container" ref={containerRef} />
    </div>
  );
};

export default TtyView;