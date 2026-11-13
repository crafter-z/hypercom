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
import { isFlowRunning } from '../../../utils/flowRuntime';
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
  connectionGeneration?: number;
}

function newTransferId(): string {
  return crypto.randomUUID();
}

export function useFileSend(portId: string | null): FileSendControls {
  const [progress, setProgress] = useState<FileSendProgress | null>(null);
  const activeRef = useRef<ActiveTransfer | null>(null);
  const generationRef = useRef(0);
  const ensureListenerRef = useRef<(() => Promise<boolean>) | null>(null);

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
    let unlisten: (() => void) | null = null;
    let pending: Promise<boolean> | null = null;
    const onProgress = (payload: FileProgressPayload) => {
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
    };
    const ensureListener = (): Promise<boolean> => {
      if (cancelled) return Promise.resolve(false);
      if (unlisten) return Promise.resolve(true);
      if (pending) return pending;
      pending = eventService.onFileProgress(onProgress).then((release) => {
        if (cancelled) {
          release();
          return false;
        }
        unlisten = release;
        return true;
      }).catch((e) => {
        console.debug('[useFileSend] onFileProgress failed:', e);
        // Do not send without progress accounting. A later click can retry a
        // transient subscription failure rather than staying broken forever.
        pending = null;
        return false;
      });
      return pending;
    };
    ensureListenerRef.current = ensureListener;
    void ensureListener();
    return () => {
      cancelled = true;
      unlisten?.();
      if (ensureListenerRef.current === ensureListener) ensureListenerRef.current = null;
    };
  }, []);

  const startFileSend = useCallback(async () => {
    const id = portId;
    if (!id || activeRef.current) return;
    const port = useAppStore.getState().ports.find((p) => p.id === id);
    if (!isSendablePort(port)) {
      useToastStore.getState().push({ severity: 'warning', messageKey: 'sendSection.portClosedWarning', portId: id });
      return;
    }
    if (isFlowRunning(id)) {
      useToastStore.getState().push({ severity: 'warning', messageKey: 'sendSection.flowBusy', portId: id });
      return;
    }
    // Reserve ownership BEFORE the dialog: repeated clicks must not create
    // competing dialogs, and a tab change must retire the pending selection.
    const generation = generationRef.current;
    const transfer: ActiveTransfer = {
      transferId: newTransferId(),
      portId: id,
      lease: trafficStats.capture(id),
      countedBytes: 0,
      generation,
      connectionGeneration: port?.connectionGeneration,
    };
    activeRef.current = transfer;
    const ownsTransfer = () => generationRef.current === generation && activeRef.current === transfer;
    try {
      const path = await open({ multiple: false });
      if (!ownsTransfer() || !path || typeof path !== 'string') return;
      const ready = await ensureListenerRef.current?.();
      if (!ownsTransfer()) return;
      if (!ready) throw new Error('Unable to subscribe to file transfer progress');
      // Both dialog and listener registration are asynchronous. Recheck the
      // fixed session and the flow lock at the actual I/O boundary, not against
      // the stale portId captured by this callback.
      const currentPort = useAppStore.getState().ports.find((p) => p.id === id);
      if (!isSendablePort(currentPort) || currentPort?.connectionGeneration !== transfer.connectionGeneration ||
          !trafficStats.isCurrent(id, transfer.lease)) return;
      if (isFlowRunning(id)) {
        useToastStore.getState().push({ severity: 'warning', messageKey: 'sendSection.flowBusy', portId: id });
        return;
      }
      setProgress({ sent: 0, total: 0 });
      const sentBytes = await serialService.sendFile({
        portId: id,
        transferId: transfer.transferId,
        path,
        chunkSize: 1024,
        delayMs: 10,
        expectedGeneration: transfer.connectionGeneration,
      });
      // invoke settlement can overtake delivery of the last progress event.
      // Reconcile the confirmed total before retiring the owner (no double count).
      const delta = sentBytes - transfer.countedBytes;
      if (activeRef.current === transfer && delta > 0) trafficStats.addTx(id, delta, transfer.lease);
    } catch (e) {
      if (generationRef.current === generation) {
        // A done event may already have cleared activeRef before invoke rejects.
        notifyError(e);
      }
    } finally {
      if (activeRef.current === transfer) {
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
