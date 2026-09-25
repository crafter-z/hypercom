/**
 * 文件发送（分块写串口）的完整关注点：守卫 → 选文件 → 进度 → 取消 → TX 统计。
 *
 * 原先这段逻辑内联在 SendSection 里，且**绕过了 `isSendablePort` 守卫**
 * （未连接端口也能选文件、只在后端报错）且**不计入 TX 流量**——文件发送了
 * 几 MB，状态栏的 TX 计数器纹丝不动。两个不变量现在都在这里收口：
 * 1. 端口不可发送 → 直接告警返回，连文件选择框都不弹；
 * 2. 每块落盘后按增量累加 TX 字节（`sent_bytes` 是本次运行的累计值，取差量）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../../../stores/useAppStore';
import { notifyError, notifySuccess, useToastStore } from '../../../stores/useToastStore';
import { eventService, serialService } from '../../../services/tauri';
import type { FileProgressPayload } from '../../../services/tauri';
import { isSendablePort } from '../../../utils/sendGuard';
import { trafficStats } from '../../../utils/trafficStats';

export interface FileSendProgress {
  sent: number;
  total: number;
}

export interface FileSendControls {
  progress: FileSendProgress | null;
  startFileSend: () => Promise<void>;
  cancelFileSend: () => void;
}

export function useFileSend(portId: string | null): FileSendControls {
  const [progress, setProgress] = useState<FileSendProgress | null>(null);
  const portIdRef = useRef(portId);
  portIdRef.current = portId;
  /** 本端口已计入 TX 统计的字节数（进度事件是累计值，按差量入账）。 */
  const countedBytesRef = useRef(0);

  // 切换标签/端口：清掉上一个端口残留的进度条与计数基线。进度事件按当前端口
  // 过滤，若不清理，新端口会一直显示别的端口的进度；计数基线错位也会让本次
  // 运行的增量算错。
  useEffect(() => {
    setProgress(null);
    countedBytesRef.current = 0;
  }, [portId]);

  // 进度事件订阅：挂载一次即可（用 ref 读当前端口），切换标签页不必重订阅。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    eventService
      .onFileProgress((p: FileProgressPayload) => {
        const id = portIdRef.current;
        // 别的端口的进度不得影响本面板的进度条与统计。
        if (!id || p.port_id !== id) return;

        const delta = p.sent_bytes - countedBytesRef.current;
        if (delta > 0) trafficStats.addTx(p.port_id, delta);
        // done 归零：下一次运行从 0 重新计数（后端每次 send_file 从头累计）。
        countedBytesRef.current = p.done ? 0 : p.sent_bytes;

        if (p.done) {
          setProgress(null);
          // 仅「真正发完」才提示成功；取消(sent<total)与空文件(total==0)静默清除
          // 进度条，否则取消时误报「已发送」、空文件残留 0/0 进度条。
          if (p.total_bytes > 0 && p.sent_bytes >= p.total_bytes) {
            notifySuccess('sendSection.file.sent');
          }
        } else {
          setProgress({ sent: p.sent_bytes, total: p.total_bytes });
        }
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch((e) => console.debug('[useFileSend] onFileProgress failed:', e));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const startFileSend = useCallback(async () => {
    const id = portIdRef.current;
    if (!id) return;
    // 守卫在弹文件选择框之前：不该让用户先挑完文件再被告知端口没连。
    if (!isSendablePort(useAppStore.getState().ports.find((p) => p.id === id))) {
      useToastStore.getState().push({
        severity: 'warning',
        messageKey: 'sendSection.portClosedWarning',
        portId: id,
      });
      return;
    }
    const path = await open({ multiple: false });
    if (!path || typeof path !== 'string') return;
    try {
      setProgress({ sent: 0, total: 0 });
      await serialService.sendFile({ portId: id, path, chunkSize: 1024, delayMs: 10 });
      // 成功提示由 serial:file_progress 的 done 事件统一触发（见上方订阅），
      // 此处不再 toast——否则取消或出错时也会误报「已发送」。
    } catch (e) {
      setProgress(null);
      notifyError(e);
    }
  }, []);

  // 取消正在进行的文件发送：置位后端 per-port 取消标志，读循环在下一块前退出，
  // 随后后端必发 done 事件清除进度条（取消不弹成功提示）。
  const cancelFileSend = useCallback(() => {
    const id = portIdRef.current;
    if (!id) return;
    serialService
      .cancelFileSend(id)
      .catch((e) => console.debug('[useFileSend] cancelFileSend failed:', e));
  }, []);

  return { progress, startFileSend, cancelFileSend };
}
