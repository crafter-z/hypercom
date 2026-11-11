/**
 * 「之后等待」字段——每一步自带的间隔，命令编辑器与弹窗列表的唯一实现。
 *
 * 等待**不是**一种独立的步骤类型，而是位置属性：这一步执行完到同轮下一步之间
 * 的间隔，发送与改参都生效。所以它由每一步携带，而不是列表里多一种行。
 *
 * 这里同时解决「一个裸数字 100 没人看得懂」的问题：
 * - 有标签（`之后等待`）和单位（`ms`），不再依赖 placeholder / tooltip；
 * - 把它读成一句人话（「等待 100 ms 后执行下一步」/「立即执行下一步」）；
 * - 轮末那一步就地说明为什么它不生效（轮间用集合的「轮间间隔」），并在集合
 *   确实会跑多轮时提供「并入轮间间隔」——只提示问题却不让用户一键解决，
 *   等于把算术题丢回给用户。
 */
import { useTranslation } from 'react-i18next';
import { NumericInput } from './NumericInput';
import { COMMAND_DELAY_MS } from '../../utils/commandSteps';

export interface AfterDelayFieldProps {
  /** 本步的「之后等待」(ms)。 */
  delay: number;
  onCommit: (delay: number) => void;
  /** 本步是这一轮的最后一步。 */
  isRoundFinal?: boolean;
  /** 该集合会跑不止一轮——只有此时「并入轮间间隔」才有意义。 */
  loops?: boolean;
  /** 提供时，轮末且集合会跑多轮的情况下显示「并入轮间间隔」。 */
  onFoldIntoRoundGap?: () => void;
}

export function AfterDelayField({
  delay,
  onCommit,
  isRoundFinal = false,
  loops = false,
  onFoldIntoRoundGap,
}: AfterDelayFieldProps) {
  const { t } = useTranslation();

  const hint = isRoundFinal
    ? (delay > 0 ? t(loops ? 'sendCmdEditor.roundFinalDelayInactive' : 'sendCmdEditor.roundFinalDelayRunEnds') : '')
    : (delay > 0 ? t('sendCmdEditor.gapAnnotation', { ms: delay }) : t('sendCmdEditor.gapImmediate'));
  const canFold = isRoundFinal && loops && delay > 0 && !!onFoldIntoRoundGap;

  return (
    <span className="after-delay-field" style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 11, color: 'var(--text-secondary)' }}>
      {/* 标签与输入同属一个 label：点击文字即可聚焦输入框。
          `.quicksend-edit-form label` 默认纵向堆叠，这里显式压成一行。 */}
      <label style={{ display: 'inline-flex', flexDirection: 'row', alignItems: 'center', gap: 4 }} title={t('sendCmdEditor.delayTooltip')}>
        {t('sendCmdEditor.afterDelayLabel')}
        <NumericInput
          className="input"
          value={delay}
          min={COMMAND_DELAY_MS[0]}
          max={COMMAND_DELAY_MS[1]}
          step={1}
          onCommit={onCommit}
          aria-label={t('sendCmdEditor.afterDelayLabel')}
          title={t('sendCmdEditor.delayTooltip')}
          style={{ width: 80 }}
        />
        {t('sendCmdEditor.delayUnit')}
      </label>
      {hint && <span style={isRoundFinal ? { color: 'var(--text-warning, var(--text-secondary))' } : undefined}>{hint}</span>}
      {canFold && (
        <button
          type="button"
          className="btn btn-sm"
          title={t('sendCmdEditor.foldIntoRoundGapHint')}
          onClick={onFoldIntoRoundGap}
        >
          {t('sendCmdEditor.foldIntoRoundGap')}
        </button>
      )}
    </span>
  );
}
