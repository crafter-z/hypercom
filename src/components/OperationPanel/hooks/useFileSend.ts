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
import { notifyError, notifyInfo, notifySuccess, useToastStore } from '../../../stores/useToastStore';
import { eventService, serialService } from '../../../services/tauri';
import type { FileProgressPayload } from '../../../services/tauri';
import { isSendablePort } from '../../../utils/sendGuard';
import { isFlowRunning, isSerialTaskRunning } from '../../../utils/flowRuntime';
import { trafficStats } from '../../../utils/trafficStats';
import type { PortTrafficLease } from '../../../utils/trafficStats';

export interface FileSendProgress {
  sent: number;
  total: number;
  fileName: string;
  cancelling?: boolean;
}

export interface FileSendControls {
  progress: FileSendProgress | null;
  startFileSend: () => Promise<void>;
  cancelFileSend: () => void;
}

interface ActiveTransfer {
  transferId: string;
  portId: string;
  fileName: string;
  lease: PortTrafficLease;
  countedBytes: number;
  phase: 'picking' | 'sending';
  progress: FileSendProgress | null;
  cancelling: boolean;
  settled: boolean;
  pickerGeneration: number;
  connectionGeneration?: number;
}

function newTransferId(): string {
  return crypto.randomUUID();
}

function extractFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

export function useFileSend(portId: string | null): FileSendControls {
  const [progress, setProgress] = useState<FileSendProgress | null>(null);
  const transfersRef = useRef<Map<string, ActiveTransfer>>(new Map());
  const currentPortIdRef = useRef<string | null>(portId);
  currentPortIdRef.current = portId;
  const pickerGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const ensureListenerRef = useRef<(() => Promise<boolean>) | null>(null);

  // Switching tabs retires any open file picker (not yet sending), while keeping
  // active in-flight transfers running per-port so switching back restores live progress.
  useEffect(() => {
    const nextGen = ++pickerGenerationRef.current;
    for (const [key, transfer] of [...transfersRef.current.entries()]) {
      if (transfer.phase === 'picking' && transfer.pickerGeneration !== nextGen) {
        transfersRef.current.delete(key);
      }
    }
    const activeForPort = portId ? transfersRef.current.get(portId) : undefined;
    setProgress(activeForPort?.phase === 'sending' ? activeForPort.progress : null);
  }, [portId]);

  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let pending: Promise<boolean> | null = null;
    const onProgress = (payload: FileProgressPayload) => {
      if (cancelled) return;
      const active = transfersRef.current.get(payload.portId);
      if (!active || active.phase !== 'sending' || payload.transferId !== active.transferId) return;
      const delta = payload.sentBytes - active.countedBytes;
      if (delta > 0) trafficStats.addTx(active.portId, delta, active.lease);
      active.countedBytes = payload.done ? 0 : Math.max(active.countedBytes, payload.sentBytes);
      if (payload.done) {
        active.settled = true;
        transfersRef.current.delete(active.portId);
        if (currentPortIdRef.current === active.portId) setProgress(null);
        if (payload.totalBytes > 0 && payload.sentBytes >= payload.totalBytes) {
          notifySuccess('sendSection.file.sent');
        } else if (active.cancelling) {
          notifyInfo('sendSection.file.cancelled');
        }
      } else {
        active.progress = {
          sent: payload.sentBytes,
          total: payload.totalBytes,
          fileName: active.fileName,
          cancelling: active.cancelling,
        };
        if (currentPortIdRef.current === active.portId) setProgress(active.progress);
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
      mountedRef.current = false;
      cancelled = true;
      pickerGenerationRef.current += 1;
      for (const transfer of transfersRef.current.values()) {
        if (transfer.phase === 'sending') {
          void serialService.cancelFileSend(transfer.portId, transfer.transferId).catch(() => undefined);
        }
      }
      transfersRef.current.clear();
      unlisten?.();
      if (ensureListenerRef.current === ensureListener) ensureListenerRef.current = null;
    };
  }, []);

  const startFileSend = useCallback(async () => {
    const id = portId;
    if (!id || transfersRef.current.has(id)) return;
    const port = useAppStore.getState().ports.find((p) => p.id === id);
    if (!isSendablePort(port)) {
      useToastStore.getState().push({ severity: 'warning', messageKey: 'sendSection.portClosedWarning', portId: id });
      return;
    }
    if (isSerialTaskRunning(id)) {
      notifyError(new Error('Port is occupied by a plugin send task'));
      return;
    }
    if (isFlowRunning(id)) {
      useToastStore.getState().push({ severity: 'warning', messageKey: 'sendSection.flowBusy', portId: id });
      return;
    }
    // Reserve ownership BEFORE the dialog: repeated clicks must not create
    // competing dialogs, and a tab change must retire the pending selection.
    const pickerGen = pickerGenerationRef.current;
    const transfer: ActiveTransfer = {
      transferId: newTransferId(),
      portId: id,
      fileName: '',
      lease: trafficStats.capture(id),
      countedBytes: 0,
      phase: 'picking',
      progress: null,
      cancelling: false,
      settled: false,
      pickerGeneration: pickerGen,
      connectionGeneration: port?.connectionGeneration,
    };
    transfersRef.current.set(id, transfer);
    const ownsPicker = () =>
      mountedRef.current &&
      pickerGenerationRef.current === pickerGen &&
      transfersRef.current.get(id) === transfer;
    try {
      const path = await open({ multiple: false });
      if (!ownsPicker() || !path || typeof path !== 'string') return;
      const ready = await ensureListenerRef.current?.();
      if (!ownsPicker()) return;
      if (!ready) throw new Error('Unable to subscribe to file transfer progress');
      // Both dialog and listener registration are asynchronous. Recheck the
      // fixed session and the flow lock at the actual I/O boundary, not against
      // the stale portId captured by this callback.
      const currentPort = useAppStore.getState().ports.find((p) => p.id === id);
      if (!isSendablePort(currentPort) || currentPort?.connectionGeneration !== transfer.connectionGeneration ||
          !trafficStats.isCurrent(id, transfer.lease)) return;
      if (isSerialTaskRunning(id)) throw new Error('Port is occupied by a plugin send task');
      if (isFlowRunning(id)) {
        useToastStore.getState().push({ severity: 'warning', messageKey: 'sendSection.flowBusy', portId: id });
        return;
      }
      transfer.phase = 'sending';
      transfer.fileName = extractFileName(path);
      transfer.progress = { sent: 0, total: 0, fileName: transfer.fileName, cancelling: false };
      if (currentPortIdRef.current === id) setProgress(transfer.progress);
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
      if (transfersRef.current.get(id) === transfer && delta > 0) trafficStats.addTx(id, delta, transfer.lease);
    } catch (e) {
      if (mountedRef.current && (transfer.phase === 'sending' || pickerGenerationRef.current === pickerGen)) {
        // A done event may already have cleared the map entry before invoke rejects.
        notifyError(e);
      }
    } finally {
      if (transfersRef.current.get(id) === transfer) {
        transfersRef.current.delete(id);
        if (mountedRef.current && currentPortIdRef.current === id) setProgress(null);
        if (transfer.cancelling && !transfer.settled) {
          transfer.settled = true;
          notifyInfo('sendSection.file.cancelled');
        }
      }
    }
  }, [portId]);

  const cancelFileSend = useCallback(() => {
    const id = currentPortIdRef.current;
    const active = id ? transfersRef.current.get(id) : undefined;
    if (!active || active.phase !== 'sending' || active.cancelling) return;
    active.cancelling = true;
    active.progress = {
      ...(active.progress ?? { sent: 0, total: 0, fileName: active.fileName }),
      cancelling: true,
    };
    setProgress(active.progress);
    void serialService.cancelFileSend(active.portId, active.transferId).catch((e) =>
      console.debug('[useFileSend] cancelFileSend failed:', e)
    );
  }, []);

  return { progress, startFileSend, cancelFileSend };
}
