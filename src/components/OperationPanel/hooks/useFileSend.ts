/**
 * 文件发送（分块写串口）的完整关注点：守卫 → 选文件 → 进度 → 取消 → TX 统计。
 *
 * 原先这段逻辑内联在 SendSection 里，且**绕过了 `isSendablePort` 守卫**
 * （未连接端口也能选文件、只在后端报错）且**不计入 TX 流量**——文件发送了
 * 几 MB，状态栏的 TX 计数器纹丝不动。两个不变量现在都在这里收口：
 * 1. 端口不可发送 → 直接告警返回，连文件选择框都不弹；
 * 2. 每块落盘后按增量累加 TX 字节（`sentBytes` 是本次运行的累计值，取差量）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useAppStore } from '../../../stores/useAppStore';
import { notifyError, notifySuccess, useToastStore } from '../../../stores/useToastStore';
import { eventService, serialService } from '../../../services/tauri';
import type { FileProgressPayload } from '../../../services/tauri';
import { isSendablePort } from '../../../utils/sendGuard';
import { trafficStats } from '../../../utils/trafficStats';
import type { PortTrafficLease } from '../../../utils/trafficStats';

export interface FileSendProgress {
  sent: number;
  total: number;
}

export interface FileSendControls {
  progress: FileSendProgress | null;
  startFileSend: () => Promise<void>;
  cancelFileSend: () => void;
}

interface ActiveTransfer {
  transferId: string;
  portId: string;
  lease: PortTrafficLease;
  countedBytes: number;
  generation: number;
}

function newTransferId(): string {
  return crypto.randomUUID();
}

export function useFileSend(portId: string | null): FileSendControls {
  const [progress, setProgress] = useState<FileSendProgress | null>(null);
  const activeRef = useRef<ActiveTransfer | null>(null);
  const generationRef = useRef(0);
  const listenerReadyRef = useRef<Promise<void> | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const generation = ++generationRef.current;
    const old = activeRef.current;
    activeRef.current = null;
    setProgress(null);
    if (old) {
      void serialService.cancelFileSend(old.portId, old.transferId).catch(() => undefined);
    }
    return () => {
      if (generationRef.current === generation) {
        generationRef.current += 1;
        const current = activeRef.current;
        activeRef.current = null;
        if (current) void serialService.cancelFileSend(current.portId, current.transferId).catch(() => undefined);
      }
    };
  }, [portId]);

  useEffect(() => {
    let cancelled = false;
    const setup = eventService.onFileProgress((payload: FileProgressPayload) => {
      if (cancelled) return;
      const active = activeRef.current;
      if (!active || payload.transferId !== active.transferId || payload.portId !== active.portId) return;
      const delta = payload.sentBytes - active.countedBytes;
      if (delta > 0) trafficStats.addTx(active.portId, delta, active.lease);
      active.countedBytes = payload.done ? 0 : Math.max(active.countedBytes, payload.sentBytes);
      if (payload.done) {
        activeRef.current = null;
        setProgress(null);
        if (payload.totalBytes > 0 && payload.sentBytes >= payload.totalBytes) notifySuccess('sendSection.file.sent');
      } else {
        setProgress({ sent: payload.sentBytes, total: payload.totalBytes });
      }
    });
    listenerReadyRef.current = setup.then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }
      unlistenRef.current = unlisten;
    }).catch((e) => {
      console.debug('[useFileSend] onFileProgress failed:', e);
    });
    return () => {
      cancelled = true;
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  const startFileSend = useCallback(async () => {
    const id = portId;
    if (!id || activeRef.current) return;
    if (!isSendablePort(useAppStore.getState().ports.find((p) => p.id === id))) {
      useToastStore.getState().push({ severity: 'warning', messageKey: 'sendSection.portClosedWarning', portId: id });
      return;
    }
    const path = await open({ multiple: false });
    if (!path || typeof path !== 'string') return;
    if (portId !== id || !isSendablePort(useAppStore.getState().ports.find((p) => p.id === id))) return;
    const listenerReady = listenerReadyRef.current;
    if (!listenerReady) return;
    await listenerReady;
    if (portId !== id) return;
    const generation = generationRef.current;
    const transfer: ActiveTransfer = {
      transferId: newTransferId(),
      portId: id,
      lease: trafficStats.capture(id),
      countedBytes: 0,
      generation,
    };
    activeRef.current = transfer;
    setProgress({ sent: 0, total: 0 });
    try {
      await serialService.sendFile({
        portId: id,
        transferId: transfer.transferId,
        path,
        chunkSize: 1024,
        delayMs: 10,
        expectedGeneration: useAppStore.getState().ports.find((p) => p.id === id)?.connectionGeneration,
      });
    } catch (e) {
      if (generationRef.current === generation) {
        if (activeRef.current?.transferId === transfer.transferId) {
          activeRef.current = null;
          setProgress(null);
        }
        // The backend emits the final done event before the command returns Err;
        // by then the listener has already cleared activeRef. Report the failure
        // for the same generation regardless of that state.
        notifyError(e);
      }
    } finally {
      if (activeRef.current?.generation === generation && activeRef.current.transferId === transfer.transferId) {
        activeRef.current = null;
        setProgress(null);
      }
    }
  }, [portId]);

  const cancelFileSend = useCallback(() => {
    const active = activeRef.current;
    if (!active) return;
    void serialService.cancelFileSend(active.portId, active.transferId).catch((e) =>
      console.debug('[useFileSend] cancelFileSend failed:', e)
    );
  }, []);

  return { progress, startFileSend, cancelFileSend };
}
