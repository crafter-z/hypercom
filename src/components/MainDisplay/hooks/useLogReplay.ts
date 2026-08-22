import { useCallback, useRef, useState } from 'react';
import { appendTerminalLine } from '../../../utils/terminal/viewportManager';
import { fileService } from '../../../services/tauri';
import { parseLogContent } from '../../../utils/logReplay';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 日志回放 hook：读取日志文件，按原始时间戳间隔把日志行写回终端。
 * @param portId 目标终端端口 id
 * 返回 isReplaying 状态、startReplay(path, speed) 与 stopReplay()。
 * speed 为倍速（1/4/16…），0 表示最快（无延时）。
 */
export function useLogReplay(portId: string) {
  const [isReplaying, setIsReplaying] = useState(false);
  const cancelRef = useRef(false);
  const busyRef = useRef(false);

  const stopReplay = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const startReplay = useCallback(async (path: string, speed: number) => {
    if (busyRef.current) return;
    let content: string;
    try {
      content = await fileService.readTextFile(path);
    } catch (e) {
      console.debug('[useLogReplay] read file failed:', e);
      return;
    }
    const lines = parseLogContent(content);
    if (lines.length === 0) return;

    busyRef.current = true;
    cancelRef.current = false;
    setIsReplaying(true);

    for (let i = 0; i < lines.length; i++) {
      if (cancelRef.current) break;
      const line = lines[i];
      appendTerminalLine(portId, {
        timestamp: line.time,
        direction: line.direction,
        content: line.content,
        isHex: false,
      });
      // 按相邻行时间差 / 倍速延时；单帧上限 1s 避免日志中的大空档卡住回放
      if (speed > 0 && i < lines.length - 1) {
        const delta = Math.max(0, lines[i + 1].time - line.time);
        if (delta > 0) await sleep(Math.min(delta / speed, 1000));
      }
    }

    busyRef.current = false;
    setIsReplaying(false);
  }, [portId]);

  return { isReplaying, startReplay, stopReplay };
}
