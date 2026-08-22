import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { appendTerminalLine } from '../utils/terminal/viewportManager';
import { eventService } from '../services/tauri';
import i18n from '../i18n';

/**
 * Hook: 外部工具输出监听
 * 监听 tool:output / tool:exit 事件，将工具输出写入终端（TOOL 方向），
 * 并在工具退出时更新端口 toolRunning 状态。
 * 必须在 App.tsx 挂载一次（与 useSerialReceive 同级）。
 */
export function useToolOutput() {
  useEffect(() => {
    let cancelled = false;
    const cleanups: Array<() => void> = [];

    const setup = async () => {
      const unlistenOutput = await eventService.onToolOutput((event) => {
        if (cancelled) return;
        appendTerminalLine(event.port_id, {
          timestamp: Date.now(),
          direction: 'TOOL',
          content: event.line,
          isHex: false,
          toolStream: event.stream as 'stdout' | 'stderr',
        });
      });

      const unlistenExit = await eventService.onToolExit((event) => {
        if (cancelled) return;
        // 更新端口状态：工具不再运行
        useAppStore.getState().updatePort(event.port_id, { toolRunning: false });
        // 写入退出信息行
        const exitText = event.code === 0
          ? i18n.t('terminal.toolExitSuccess')
          : i18n.t('terminal.toolExitCode', { code: event.code });
        appendTerminalLine(event.port_id, {
          timestamp: Date.now(),
          direction: 'TOOL',
          content: exitText,
          isHex: false,
          toolStream: 'stdout',
        });
      });

      if (cancelled) {
        unlistenOutput();
        unlistenExit();
        return;
      }
      cleanups.push(unlistenOutput, unlistenExit);
    };

    setup().catch((e) => {
      console.error('[useToolOutput] Failed to subscribe to tool events:', e);
    });

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, []);
}
