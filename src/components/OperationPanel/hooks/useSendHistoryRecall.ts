/**
 * 发送历史召回（输入框 ↑/↓）：把历史条目回填到操作面板的发送态。
 *
 * 历史本身由 `useSerialSend` 持有（每端口内存 Map，cap 50）；这里只管「按方向
 * 取一条并回填」这一件事——包括「取不到（已到最新）时清空输入框」的既有语义。
 */
import { useCallback } from 'react';
import { useOperationStore } from '../../../stores/useOperationStore';
import type { SendHistoryEntry } from '../../../types';

export interface SendHistoryRecall {
  recallUp: () => void;
  recallDown: () => void;
}

export function useSendHistoryRecall(
  historyUp: () => SendHistoryEntry | null,
  historyDown: () => SendHistoryEntry | null
): SendHistoryRecall {
  const apply = useCallback((item: SendHistoryEntry | null) => {
    const setOpState = useOperationStore.getState().setOpState;
    if (item) {
      setOpState({
        sendInput: item.content,
        sendIsHex: item.format === 'hex',
        sendAppendLineEnding: item.lineEnding,
      });
    } else {
      setOpState({ sendInput: '' });
    }
  }, []);

  return {
    recallUp: useCallback(() => apply(historyUp()), [apply, historyUp]),
    recallDown: useCallback(() => apply(historyDown()), [apply, historyDown]),
  };
}
