/**
 * 全量配置保存前的「实体合并」助手（issue #5-2）。
 *
 * `useAppStore.config` 的实体数组（sendCommandSets 等）只在启动时从后端读取一次；
 * ConfigModal 各规则页的编辑只写 `useRuleStore`，且单条 ✓ 保存直接走
 * `storageService`（upsert + `manager.save()`）落盘 config.json —— 从不回写
 * `store.config`。于是 ConfigModal 页脚 Save / 诊断日志开关等「全量保存」
 * 路径会用过期的启动快照整体替换后端刚保存的实体，回滚用户编辑。
 *
 * 此函数把 useRuleStore 的实时实体覆盖到 config 快照上再交给 `set_config`，
 * 与 useAppInit 里 portGroups/portMeta 落盘前回写 store.config（issue #4-10）
 * 是同一模式。portPresets 不在 useRuleStore 中（GeneralSettings/ParamsSection
 * 用本地 state + storageService 管理），与 portGroups/portMeta 一样保持 config
 * 原值不动。
 */
import type { AppConfig } from '../types';
import { useRuleStore } from '../stores/useRuleStore';

/** useRuleStore 中承载的、随 config.json 持久化的实体数组字段。 */
export type LiveRuleEntities = Pick<
  ReturnType<typeof useRuleStore.getState>,
  'sendCommandSets' | 'highlightRuleSets' | 'protocolTemplates' | 'triggerRules' | 'portToolConfigs'
>;

/**
 * 返回一个新的 AppConfig：6 项之外的字段浅拷贝自 `config`，
 * 6 项实体数组用 `ruleStore` 的实时值整体替换（空数组也写入，
 * 保证「删除全部规则后全量保存」不会复活旧条目）。
 */
export function mergeLiveRuleEntities(config: AppConfig, ruleStore: LiveRuleEntities): AppConfig {
  return {
    ...config,
    sendCommandSets: ruleStore.sendCommandSets,
    highlightRuleSets: ruleStore.highlightRuleSets,
    protocolTemplates: ruleStore.protocolTemplates,
    triggerRules: ruleStore.triggerRules,
    portToolConfigs: ruleStore.portToolConfigs,
  };
}
