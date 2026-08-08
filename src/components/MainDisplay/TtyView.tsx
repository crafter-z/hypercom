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
 */

import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useAppStore } from '../../stores/useAppStore';
import { ttyService } from '../../utils/ttyService';

interface TtyViewProps {
  portId: string;
}

/** 从设计系统 CSS 变量读取主题色；缺省时回退到暗色 token 的写死值。 */
function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const TtyView: React.FC<TtyViewProps> = ({ portId }) => {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalFont = useAppStore((s) => s.config.terminalFont);
  const terminalFontSize = useAppStore((s) => s.config.terminalFontSize);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // 挂载时刻的配置值（字体/字号）——Terminal 实例不随配置变更重建，
    // 保持终端缓冲与滚动位置；改配置后下次挂载生效。
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

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    // TX：用户键入/粘贴 → 发送到串口（无本地回显，由对端 echo）。
    const onDataDisposable = term.onData((data) => {
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
    // 即当前实际值；容器 0 尺寸时为默认 80×24，待 ResizeObserver 校正）。
    ttyService.resize(portId, term.cols, term.rows);

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
      term.dispose();
    };
  }, [portId, terminalFont, terminalFontSize]);

  return (
    <div className="tty-view">
      <div className="tty-titlebar">
        <span className="tty-titlebar-label eyebrow">{t('tty.title')}</span>
        <span className="tty-titlebar-port">{portId}</span>
      </div>
      <div className="tty-container" ref={containerRef} />
    </div>
  );
};

export default TtyView;