/**
 * 发送输入框的 HEX/文本关注点：字节计数（含非法 HEX 的错误态）、行尾字节提示、
 * HEX 模式切换时的就地转换。
 *
 * 抽出来的原因不只是行数：HEX 契约（C4/K7）要求「后端必然拒绝的输入不得显示
 * 字节数」，这条规则必须和解析器（sendUtils）绑在一起，而不是散在 JSX 的
 * 条件表达式里。
 */
import { useCallback, useMemo } from 'react';
import { useOperationStore } from '../../../stores/useOperationStore';
import type { Encoding } from '../../../types';
import {
  computeByteCount,
  formatLineEndingHex,
  hexInputError,
  hexToTextPreview,
  sanitizeHexInput,
  textToHexPreview,
  type ByteCountResult,
} from '../../../utils/sendUtils';

export interface HexCompose {
  byteCount: ByteCountResult;
  /** 行尾追加字节的 HEX 展示（"0D 0A"）；无追加 → null。 */
  hexSuffix: string | null;
  /** HEX 模式且输入非法时的 i18n key —— UI 显示错误态并禁用发送。 */
  inputErrorKey: string | null;
  /** textarea 取值清洗：HEX 模式剥离非 HEX 字符。 */
  toEditableValue: (raw: string) => string;
  /** HEX 复选框切换：就地转换当前内容（非法 HEX 转文本时原样保留，不静默清空）。 */
  toggleHexMode: (next: boolean) => void;
}

export function useHexCompose(args: {
  sendInput: string;
  isHex: boolean;
  encoding: Encoding;
}): HexCompose {
  const { sendInput, isHex, encoding } = args;
  const sendAppendLineEnding = useOperationStore((s) => s.sendAppendLineEnding);
  const setOpState = useOperationStore((s) => s.setOpState);

  const byteCount = useMemo(
    () => computeByteCount(sendInput, isHex, encoding, sendAppendLineEnding),
    [sendInput, isHex, encoding, sendAppendLineEnding]
  );

  const hexSuffix = useMemo(
    () => formatLineEndingHex(sendAppendLineEnding),
    [sendAppendLineEnding]
  );

  const toEditableValue = useCallback(
    (raw: string) => (isHex ? sanitizeHexInput(raw) : raw),
    [isHex]
  );

  // HEX 模式切换时就地转换，用户不会丢失已输入内容；HEX → 文本时若当前不是合法
  // HEX（打了一半/含非法字符）则只切模式、保留原文——清空会静默吃掉用户输入。
  const toggleHexMode = useCallback(
    (next: boolean) => {
      if (next === isHex) return;
      if (next) {
        setOpState({ sendIsHex: true, sendInput: textToHexPreview(sendInput) });
        return;
      }
      setOpState(
        hexInputError(sendInput) !== null
          ? { sendIsHex: false }
          : { sendIsHex: false, sendInput: hexToTextPreview(sendInput) }
      );
    },
    [isHex, sendInput, setOpState]
  );

  return {
    byteCount,
    hexSuffix,
    inputErrorKey: byteCount.errorKey ?? null,
    toEditableValue,
    toggleHexMode,
  };
}
