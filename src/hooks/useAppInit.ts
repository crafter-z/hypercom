import { useEffect } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useRuleStore } from '../stores/useRuleStore';
import type { AppConfig } from '../types';
import { configService, storageService } from '../services/tauri';
import { parseSessionSnapshot } from '../utils/sessionSnapshot';
import { collectPortMeta, saveCurrentPortMeta, useConfigPersistence } from './useConfigPersistence';
import { useSerialPorts } from './useSerialPorts';

interface StartupResult {
  config: AppConfig;
  sessionSnapshot: string | null;
}
let startupPromise: Promise<StartupResult> | null = null;
let sessionRestoreClaimed = false;

/**
 * Hook: 应用初始化
 * 在 App 挂载时调用，加载配置、刷新串口列表等
 */
export function useAppInit() {
  const { loadConfig } = useConfigPersistence();
  const { refreshPorts } = useSerialPorts(0);

  useEffect(() => {
    let cancelled = false;
    const baseline = useAppStore.getState();
    if (!startupPromise) {
      startupPromise = (async (): Promise<StartupResult> => {
        await loadConfig();
        const cfg = useAppStore.getState().config;
        useRuleStore.getState().setSendCommandSets(cfg.sendCommandSets);
        useRuleStore.getState().setHighlightRuleSets(cfg.highlightRuleSets);
        useRuleStore.getState().setProtocolTemplates(cfg.protocolTemplates);
        useRuleStore.getState().setTriggerRules(
          cfg.triggerRules.map((r) => (String(r.actionType) === 'bookmark' ? { ...r, actionType: 'alert' } : r))
        );
        useRuleStore.getState().setPortToolConfigs(cfg.portToolConfigs);
        useAppStore.getState().setGroups(cfg.portGroups ?? []);
        await refreshPorts();
        for (const group of useAppStore.getState().groups) {
          for (const portId of group.portIds) useAppStore.getState().updatePort(portId, { groupId: group.id });
        }
        for (const meta of useAppStore.getState().config.portMeta ?? []) {
          useAppStore.getState().updatePort(meta.portId, {
            alias: meta.alias,
            isHidden: meta.isHidden,
            mode: meta.mode,
            displayView: meta.displayView,
          });
        }
        let sessionSnapshot: string | null = null;
        if (cfg.restoreSession) {
          try {
            sessionSnapshot = await configService.getSessionSnapshot();
          } catch (e) {
            console.warn('[useAppInit] Failed to restore session snapshot:', e);
          }
        }
        return { config: cfg, sessionSnapshot };
      })();
    }
    startupPromise.then(({ config: cfg, sessionSnapshot }) => {
      if (cancelled || sessionRestoreClaimed || !cfg.restoreSession || !sessionSnapshot) return;
      const current = useAppStore.getState();
      if (current.tabs !== baseline.tabs || current.paneTree !== baseline.paneTree || current.activeTabId !== baseline.activeTabId || current.focusedPaneId !== baseline.focusedPaneId) return;
      sessionRestoreClaimed = true;
      try {
        const snapshot = parseSessionSnapshot(JSON.parse(sessionSnapshot), new Set(current.ports.map((port) => port.id)));
        for (const [portId, patch] of Object.entries(snapshot.portConfigs)) {
          const baselinePort = baseline.ports.find((port) => port.id === portId);
          const currentPort = useAppStore.getState().ports.find((port) => port.id === portId);
          const unchanged = baselinePort && currentPort && Object.keys(patch).every((key) =>
            (currentPort as unknown as Record<string, unknown>)[key] === (baselinePort as unknown as Record<string, unknown>)[key]
          );
          if (!baselinePort || unchanged) useAppStore.getState().updatePort(portId, patch);
        }
        if (snapshot.tabs.length > 0) useAppStore.getState().restoreSessionSnapshot(snapshot);
      } catch (e) {
        console.warn('[useAppInit] Failed to restore session snapshot:', e);
      }
    }).catch((e) => console.warn('[useAppInit] Initialization failed:', e));
    return () => { cancelled = true; };
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
    let retryId: ReturnType<typeof setTimeout> | null = null;
    let pendingSignature: string | null = null;
    const capture = () => {
      const ports = useAppStore.getState().ports;
      return { entries: collectPortMeta(ports), presentIds: ports.map((port) => port.id) };
    };
    // 签名只包含在线端口的元数据；端口移除也触发保存，但不会删除其后端条目。
    const computeSignature = () => JSON.stringify(collectPortMeta(useAppStore.getState().ports));
    let lastSignature = computeSignature();
    // Cleanup 若仍有待触发防抖，同样将最新端口状态排入写队列。签名只在
    // 保存成功后推进：瞬时失败会保留脏状态并在 2s 后重试，而不是永久丢弃。
    const flushMeta = () => {
      if (retryId !== null) {
        clearTimeout(retryId);
        retryId = null;
      }
      const signature = pendingSignature ?? computeSignature();
      const snapshot = capture();
      saveCurrentPortMeta(snapshot).then(() => {
        lastSignature = signature;
        if (pendingSignature === signature) pendingSignature = null;
      }).catch((e) => {
        console.warn('[useAppInit] Failed to auto-save port meta:', e);
        retryId = setTimeout(() => {
          retryId = null;
          if (pendingSignature !== null) flushMeta();
        }, 2000);
      });
    };
    const unsubscribe = useAppStore.subscribe((state, prevState) => {
      // 端口数组引用未变（仅流量/UI 等其它字段更新）时跳过，避免每次 TX/RX
      // 统计都重算签名；3s 轮询会重建数组但这不携带 alias/isHidden 变化，
      // 签名比较仍能正确去重。
      if (state.ports === prevState.ports) return;
      const sig = computeSignature();
      if (sig === lastSignature) return;
      pendingSignature = sig;
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        timeoutId = null;
        flushMeta();
      }, 500);
    });
    return () => {
      unsubscribe();
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (retryId !== null) clearTimeout(retryId);
      if (pendingSignature !== null) flushMeta();
    };
  }, []);
}
