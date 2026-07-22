import { useEffect, useRef } from 'react';
import { useRuleStore } from '../../../stores/useRuleStore';
import { useOperationStore } from '../../../stores/useOperationStore';
import { notifyError } from '../../../stores/useToastStore';
import type { SendCommand } from '../../../types';

export interface UseCyclicSendOptions {
  activeTabId: string | null;
  /** Commands of the active send-command set — used for the initial guard. */
  commands: SendCommand[];
  /** Store-driven loop flag (isLoopSending). The loop runs while this is true. */
  isLooping: boolean;
  isPortActive: boolean;
  isConnected: boolean;
  activeSendCommandSetId: string | null;
  loopInterval: number;
  sendData: (portId: string, data: string, isHex: boolean, lineEnding: string) => Promise<number>;
  setOpState: (partial: { isLoopSending?: boolean }) => void;
}

export interface UseCyclicSendReturn {
  isLooping: boolean;
  startLoop: () => void;
  stopLoop: () => void;
  currentCmdIdx: number;
}

/**
 * Cyclic send state machine — extracted from OperationPanel.
 *
 * Encapsulates the recursive-setTimeout loop that iterates over the active
  * send-command set. The loop is driven by `isLooping` (store's isLoopSending);
 * `startLoop` / `stopLoop` are thin wrappers that flip that store flag.
 *
 * Inside the loop, the active command set is re-read from the store on every
 * tick so that edits to commands / isLoop / loopDelay take effect immediately
 * (same behaviour as the original inline implementation).
 */
export function useCyclicSend(options: UseCyclicSendOptions): UseCyclicSendReturn {
  const {
    activeTabId,
    commands,
    isLooping,
    isPortActive,
    isConnected,
    activeSendCommandSetId,
    loopInterval,
    sendData,
    setOpState,
  } = options;

  const loopRef = useRef<{
    timeoutId: ReturnType<typeof setTimeout> | null;
    currentCmdIdx: number;
    completedRounds: number;
    stopped: boolean;
  }>({
    timeoutId: null,
    currentCmdIdx: 0,
    completedRounds: 0,
    stopped: false,
  });

  // Spam guard: the loop retries on failure, so only surface the FIRST
  // error of each cyclic-run session as a toast. Reset when a run starts.
  const notifiedRef = useRef(false);

  useEffect(() => {
    const ref = loopRef.current;
    if (!isLooping || !isPortActive || !isConnected) {
      ref.stopped = true;
      if (ref.timeoutId) { clearTimeout(ref.timeoutId); ref.timeoutId = null; }
      return;
    }

    // Initial guard — if the active set has no commands, bail out.
    if (commands.length === 0) {
      setOpState({ isLoopSending: false });
      return;
    }

    ref.stopped = false;
    ref.currentCmdIdx = 0;
    ref.completedRounds = 0;
    notifiedRef.current = false;

    const sendNext = async () => {
      if (ref.stopped || !activeTabId) return;
      // Re-read from store for freshness (same as original behaviour).
      const store = useRuleStore.getState();
      const currentSet = store.sendCommandSets.find(s => s.id === store.activeSendCommandSetId);
      if (!currentSet || currentSet.commands.length === 0) {
        setOpState({ isLoopSending: false });
        return;
      }
      const cmd = currentSet.commands[ref.currentCmdIdx % currentSet.commands.length];

      try {
        await sendData(
          activeTabId,
          cmd.content,
          cmd.type === 'hex',
          cmd.appendLineEnding,
        );

        // 重复轮数优先：>0 时发送 N 轮后停止（覆盖命令集 isLoop）；
        // 0 时跟随命令集 isLoop（无限循环或单轮）。
        const loopRepeatCount = useOperationStore.getState().loopRepeatCount;
        const nextIdx = ref.currentCmdIdx + 1;
        const completedRound = nextIdx >= currentSet.commands.length;
        if (completedRound) {
          ref.completedRounds += 1;
          const reachedLimit = loopRepeatCount > 0
            ? ref.completedRounds >= loopRepeatCount
            : !currentSet.isLoop;
          if (reachedLimit) {
            setOpState({ isLoopSending: false });
            ref.stopped = true;
            return;
          }
        }
        ref.currentCmdIdx = nextIdx;

        const delay = completedRound && (currentSet.isLoop || loopRepeatCount > 0)
          ? (currentSet.loopDelay || loopInterval)
          : cmd.delay ?? loopInterval;

        ref.timeoutId = setTimeout(sendNext, delay);
      } catch (err) {
        console.warn('[useCyclicSend] Cyclic send failed:', err);
        if (!notifiedRef.current) {
          notifiedRef.current = true;
          notifyError(err);
        }
        ref.timeoutId = setTimeout(sendNext, loopInterval);
      }
    };

    ref.timeoutId = setTimeout(sendNext, 100);
    return () => {
      ref.stopped = true;
      if (ref.timeoutId) { clearTimeout(ref.timeoutId); ref.timeoutId = null; }
    };
  }, [isLooping, isPortActive, isConnected, activeSendCommandSetId, commands.length, loopInterval, activeTabId, sendData, setOpState]);

  const startLoop = () => setOpState({ isLoopSending: true });
  const stopLoop = () => setOpState({ isLoopSending: false });

  return {
    isLooping,
    startLoop,
    stopLoop,
    currentCmdIdx: loopRef.current.currentCmdIdx,
  };
}
