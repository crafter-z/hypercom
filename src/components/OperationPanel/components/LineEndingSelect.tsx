/**
 * 行尾追加选择器（发送区）。取值与 i18n key 都来自 `sendUtils` 的单一来源
 * （`LINE_ENDING_VALUES` / `lineEndingLabelKey`），弹窗文本模式复用同一组。
 */
import type { ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useOperationStore } from '../../../stores/useOperationStore';
import type { LineEnding } from '../../../types';
import { LINE_ENDING_VALUES, lineEndingLabelKey } from '../../../utils/sendUtils';

export function LineEndingSelect() {
  const { t } = useTranslation();
  const lineEnding = useOperationStore((s) => s.sendAppendLineEnding);
  const setOpState = useOperationStore((s) => s.setOpState);

  return (
    <select
      className="select op-line-ending-select"
      value={lineEnding}
      onChange={(e: ChangeEvent<HTMLSelectElement>) =>
        setOpState({ sendAppendLineEnding: e.target.value as LineEnding })
      }
    >
      {LINE_ENDING_VALUES.map((v) => (
        <option key={v} value={v}>
          {t(lineEndingLabelKey(v))}
        </option>
      ))}
    </select>
  );
}
