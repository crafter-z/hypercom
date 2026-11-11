/**
 * 流程步骤推进的纯语义（唯一实现）。
 *
 * 从 `useCyclicSend` 的 step 里抽出：轮次边界、轮内间隔、轮间间隔、重复轮数
 * 的判定历史上出过真实缺陷——曾用 `nextIdx >= length` 判轮末，导致第二轮起
 * 每条命令都误用 `loopDelay`、`completedRounds` 按「条」而非「轮」累加而提前停发。
 * 这里把它变成可直测的纯函数，旧命令集与增强流程共用同一份推进规则。
 *
 * 只有一条时间规则，两句话：
 * 1. **步骤之间**用这一步自己的 `delay`（对发送、改参等所有动作类型都生效）；
 * 2. **轮与轮之间**用集合级 `loopDelay`——轮末那一步的 `delay` 不参与，
 *    因为轮边界属于「轮之间」而不是「步骤之间」。
 */

export interface FlowScheduleInput {
  /** 当前步骤索引（0-based）。 */
  stepIndex: number;
  stepCount: number;
  /** 该步骤执行后的「之后等待」(ms)。 */
  stepDelay?: number;
  /** 集合级轮间间隔。 */
  loopDelay?: number;
  /** 重复轮数：0 = 跟随 isLoop，>0 = 发满 N 轮后停止。 */
  repeatCount?: number;
  isLoop: boolean;
  /** 本次运行已完成轮数。 */
  completedRounds: number;
}

export type FlowScheduleResult =
  /** 本轮还有下一步：索引前移，返回下一次迭代延时。 */
  | { kind: 'continue'; nextIndex: number; delayMs: number; completedRounds: number }
  /** 本轮结束且还要继续下一轮：索引归零，返回轮间延时。 */
  | { kind: 'next-round'; delayMs: number; completedRounds: number }
  /** 达到重复轮数上限，或单轮集合已跑完：流程结束。 */
  | { kind: 'finish'; completedRounds: number };

export function advanceFlow(input: FlowScheduleInput): FlowScheduleResult {
  const { stepIndex, stepCount, stepDelay, loopDelay, repeatCount = 0, isLoop } = input;

  if (stepIndex < stepCount - 1) {
    return {
      kind: 'continue',
      nextIndex: stepIndex + 1,
      delayMs: stepDelay ?? 0,
      completedRounds: input.completedRounds,
    };
  }

  const completedRounds = input.completedRounds + 1;
  const reachedLimit = repeatCount > 0 ? completedRounds >= repeatCount : !isLoop;
  if (reachedLimit) return { kind: 'finish', completedRounds };
  return { kind: 'next-round', delayMs: loopDelay ?? 0, completedRounds };
}
