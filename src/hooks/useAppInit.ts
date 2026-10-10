import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import { configService, storageService } from '../services/tauri';
import { parseSessionSnapshot } from '../utils/sessionSnapshot';
import { collectPortMeta, saveCurrentPortMeta, useConfigPersistence } from './useConfigPersistence';
import { useSerialPorts } from './useSerialPorts';


/**
 * Hook: 应用初始化
 * 在 App 挂载时调用，加载配置、刷新串口列表等
 */
export function useAppInit() {
  const { loadConfig } = useConfigPersistence();
  const { refreshPorts } = useSerialPorts(0);

  useEffect(() => {
    const init = async () => {
      await loadConfig();

      // Load persisted rule sets and command sets from config (entities now live in config.json)
      const cfg = useAppStore.getState().config;
      useRuleStore.getState().setSendCommandSets(cfg.sendCommandSets);
      useRuleStore.getState().setHighlightRuleSets(cfg.highlightRuleSets);
      useRuleStore.getState().setProtocolTemplates(cfg.protocolTemplates);
      // 迁移旧版残留的 bookmark 动作（从未实现，issue #3-1）：归一为 alert。
      // 旧 config.json 的 actionType 是任意字符串，用 String() 比较避免与
      // TriggerActionType 联合类型（已移除 'bookmark'）的不重叠比较错误。
      useRuleStore.getState().setTriggerRules(
        cfg.triggerRules.map((r) => (String(r.actionType) === 'bookmark' ? { ...r, actionType: 'alert' } : r))
      );
      useRuleStore.getState().setPortToolConfigs(cfg.portToolConfigs);

      // 串口分组恢复（issue #2-3）：分组布局持久化在 config.json。
      // setGroups 必须在下方 groups 自动保存订阅注册**之前**执行，
      // 否则启动载入本身会触发一次无意义的回写。
      useAppStore.getState().setGroups(cfg.portGroups ?? []);

      await refreshPorts();

      // 按持久化的分组成员关系回填 ports.groupId（端口由枚举产生，
      // 自身不记录分组；mergePorts 之后的每次轮询都会保留该字段）。
      for (const group of useAppStore.getState().groups) {
        for (const portId of group.portIds) {
          useAppStore.getState().updatePort(portId, { groupId: group.id });
        }
      }

      // 回填持久化的端口备注名 / 隐藏状态 / 工作模式（issue #4-9；模式 issue #11）：
      // 端口由枚举产生，`mapPortInfo` 不携带 alias/isHidden/mode，需从 config.portMeta 恢复。
      for (const meta of useAppStore.getState().config.portMeta ?? []) {
        useAppStore.getState().updatePort(meta.portId, {
          alias: meta.alias,
          isHidden: meta.isHidden,
          mode: meta.mode,
          displayView: meta.displayView,
        });
      }

      // F.3: Session restore — recreate tabs + paneTree from snapshot (no auto-connect)
      if (cfg.restoreSession) {
        try {
          const sessionSnapshot = await configService.getSessionSnapshot();
          if (sessionSnapshot) {
            const snapshot = parseSessionSnapshot(JSON.parse(sessionSnapshot), new Set(useAppStore.getState().ports.map((port) => port.id)));
            for (const [portId, patch] of Object.entries(snapshot.portConfigs)) {
              useAppStore.getState().updatePort(portId, patch);
            }
            if (snapshot.tabs.length > 0) {
              useAppStore.getState().restoreSessionSnapshot(snapshot);
            }
          }
        } catch (e) {
          console.warn('[useAppInit] Failed to restore session snapshot:', e);
        }
      }
    };
    init();
  }, [loadConfig, refreshPorts]);

  // 分组自动保存（issue #2-3）：分组增删 / 重命名 / 展开折叠 / 拖拽成员等
  // 任何 groups 变更 → 500ms 防抖 → 整组列表回写 config.json（原子写 + .bak
  // 由后端 ConfigManager.save() 保证）。替代旧的「保存布局」手动按钮。
  // 与 App.tsx 会话快照订阅同款防抖写法；后台持久化失败只记日志不弹 toast，
  // 避免高频操作期间的重复打扰。
  // 这里**不**回写 store.config.portGroups：全量保存（saveConfig）从 store.groups
  // 取实时分组，不再依赖启动快照，回写反而多一条会分叉的写路径。
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    // issue #6-8：防抖 cleanup 原先只 clearTimeout，关窗/崩溃会丢最近 500ms 改动。
    // 兜底 flush：cleanup 时若仍有待触发防抖，同步保存一次再 clear。
    const flushGroups = () => {
      storageService.savePortGroups(useAppStore.getState().groups).catch((e) => {
        console.warn('[useAppInit] Failed to auto-save port groups:', e);
      });
    };
    const unsubscribe = useAppStore.subscribe((state, prevState) => {
      if (state.groups === prevState.groups) return;
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        timeoutId = null;
        flushGroups();
      }, 500);
    });
    return () => {
      unsubscribe();
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        flushGroups();
      }
    };
  }, []);

  // 端口元数据自动保存（备注名 / 隐藏状态 / 工作模式）：比较投影签名，
  // 避免 3s 端口轮询重建数组时无意义回写。写入时以最新后端快照为底，
  // 保留离线端口元数据，并与全量保存串行化，避免旧写入覆盖较新的清空操作。
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    // 签名只包含在线端口的元数据；端口移除也触发保存，但不会删除其后端条目。
    const computeSignature = () => JSON.stringify(collectPortMeta(useAppStore.getState().ports));
    let lastSignature = computeSignature();
    // Cleanup 若仍有待触发防抖，同样将最新端口状态排入写队列。
    const flushMeta = () => {
      saveCurrentPortMeta().catch((e) => {
        console.warn('[useAppInit] Failed to auto-save port meta:', e);
      });
    };
    const unsubscribe = useAppStore.subscribe((state, prevState) => {
      // 端口数组引用未变（仅流量/UI 等其它字段更新）时跳过，避免每次 TX/RX
      // 统计都重算签名；3s 轮询会重建数组但这不携带 alias/isHidden 变化，
      // 签名比较仍能正确去重。
      if (state.ports === prevState.ports) return;
      const sig = computeSignature();
      if (sig === lastSignature) return;
      lastSignature = sig;
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        timeoutId = null;
        flushMeta();
      }, 500);
    });
    return () => {
      unsubscribe();
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        flushMeta();
      }
    };
  }, []);
}
