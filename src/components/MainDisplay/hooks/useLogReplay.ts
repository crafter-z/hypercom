import { useCallback, useEffect, useRef, useState } from 'react';
import { appendTerminalLine } from '../../../utils/terminal/viewportManager';
import { fileService } from '../../../services/tauri';
import { parseLogContent } from '../../../utils/logReplay';
import { findSerialTabByPortId, useAppStore } from '../../../stores/useAppStore';
import { trafficStats } from '../../../utils/trafficStats';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface LogReplayActions {
  isReplaying: boolean;
  startReplay(path: string, speed: number): Promise<void>;
  stopReplay(): void;
}

/**
 * 日志回放 hook：读取日志文件，按原始时间戳间隔把日志行写回终端。
 * @param portId 目标终端端口 id
 * 返回 isReplaying 状态、startReplay(path, speed) 与 stopReplay()。
 * speed 为倍速（1/4/16…），0 表示最快（无延时）。
 */
export function useLogReplay(portId: string): LogReplayActions {
  const [isReplaying, setIsReplaying] = useState(false);
  const epochRef = useRef(0);
  const busyRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const portRef = useRef(portId);
  portRef.current = portId;
  const tabRef = useRef<string | null>(null);

  const stopReplay = useCallback(() => {
    epochRef.current++;
    busyRef.current = null;
    if (mountedRef.current) setIsReplaying(false);
  }, []);


  useEffect(() => {
    mountedRef.current = true;
    stopReplay();
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (busyRef.current === null || state.tabs === previous.tabs) return;
      if ((findSerialTabByPortId(state, portId)?.id ?? null) !== tabRef.current) stopReplay();
    });
    return () => {
      mountedRef.current = false;
      epochRef.current++;
      busyRef.current = null;
      unsubscribe();
    };
  }, [portId, stopReplay]);
  const startReplay = useCallback(async (path: string, speed: number) => {
    if (!portId || !mountedRef.current || portRef.current !== portId || busyRef.current !== null) return;
    const epoch = ++epochRef.current;
    const lease = trafficStats.capture(portId);
    const tabId = findSerialTabByPortId(useAppStore.getState(), portId)?.id ?? null;
    tabRef.current = tabId;
    busyRef.current = epoch;
    setIsReplaying(true);
    const isCurrent = () => mountedRef.current && epochRef.current === epoch && portRef.current === portId
      && trafficStats.isCurrent(portId, lease)
      && (findSerialTabByPortId(useAppStore.getState(), portId)?.id ?? null) === tabId;
    try {
      const content = await fileService.readTextFile(path);
      if (!isCurrent()) return;
      const lines = parseLogContent(content);
      for (let i = 0; i < lines.length; i++) {
        if (!isCurrent()) return;
        const line = lines[i];
        appendTerminalLine(portId, {
          timestamp: line.time,
          direction: line.direction,
          content: line.content,
          isHex: false,
        });
        // Cap gaps at 1s; cancellation is checked again after every wait.
        if (speed > 0 && i < lines.length - 1) {
          const delta = Math.max(0, lines[i + 1].time - line.time);
          if (delta > 0) {
            await sleep(Math.min(delta / speed, 1000));
            if (!isCurrent()) return;
          }
        }
      }
    } catch (error) {
      if (isCurrent()) console.debug('[useLogReplay] read file failed:', error);
    } finally {
      if (mountedRef.current && epochRef.current === epoch) {
        busyRef.current = null;
        setIsReplaying(false);
      }
    }
  }, [portId]);

  return { isReplaying, startReplay, stopReplay };
}
