/**
 * 发送历史召回（输入框 ↑/↓）：把历史条目（或离开历史时恢复的暂存草稿）回填到操作面板的发送态。
 *
 * 历史本身与暂存草稿由 `useSerialSend` 持有（每端口内存 Map，cap 50）；
 * 当 `historyUp`/`historyDown` 返回 `null`（空历史或已在实时草稿处按 ↓）时保持原输入不动。
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
    if (!item) return;
    useOperationStore.getState().setOpState({
      sendInput: item.content,
      sendIsHex: item.format === 'hex',
      sendAppendLineEnding: item.lineEnding,
    });
  }, []);

  return {
    recallUp: useCallback(() => apply(historyUp()), [apply, historyUp]),
    recallDown: useCallback(() => apply(historyDown()), [apply, historyDown]),
  };
}
