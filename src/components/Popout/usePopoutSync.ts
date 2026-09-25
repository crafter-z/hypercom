import { useCallback, useEffect, useRef, useState } from 'react';
import {
  eventService,
  popoutEventService,
  serialService,
  storageService,
  type AvailablePortInfo,
} from '../../services/tauri';
import type { SendCommandSet } from '../../types';

export interface PopoutSync {
  /** 主窗命令集活实体（含未保存编辑）——弹窗的读侧唯一来源。 */
  sets: SendCommandSet[];
  /** 主窗活动标签：弹窗未手选端口时的缺省发送目标。 */
  activePortId: string | null;
  /** 后端枚举出的串口（目标端口选择器的选项）。 */
  ports: AvailablePortInfo[];
  /** 已连接端口集合（「发送到」提示灯跟随真实连接状态）。 */
  connectedPortIds: ReadonlySet<string>;
  /** 请求主窗打开配置弹窗的命令集页（命令集的新建/删除/排序在那里）。 */
  openSetEditor: () => void;
}

/**
 * 快捷发送面板与主窗的同步（事件总线 + 基线）。
 *
 * 弹窗是独立 webview、自带 store 实例：命令集 / 活动标签 / 端口状态全部只能靠
 * 事件交换，本 hook 把这些订阅收在一处，面板组件只管渲染。
 *
 * - 命令集：mount 先读 `load_command_sets` 取持久化基线，随后
 *   `command-sets:changed` 携带主窗活实体（含未保存编辑）直接覆盖——不回库重读，
 *   否则配置弹窗里未点「保存」的编辑不会同步过来。
 * - 对表：监听器注册就绪后才 emit `popout:request-sync`，否则主窗回放的
 *   active-tab:changed 可能早于监听器到达而丢失（指示器失真）。
 * - 端口状态：`serial:status` 广播 + `port-statuses:sync` 全量回放，弹窗在已连接
 *   状态下打开时提示灯即刻准确。
 */
export function usePopoutSync(): PopoutSync {
  const [sets, setSets] = useState<SendCommandSet[]>([]);
  const [activePortId, setActivePortId] = useState<string | null>(null);
  const [ports, setPorts] = useState<AvailablePortInfo[]>([]);
  const [connectedPortIds, setConnectedPortIds] = useState<ReadonlySet<string>>(new Set());

  // 持久化基线：主窗的载荷到达前先显示盘上的内容。载荷是活实体（含未保存编辑），
  // 一旦到达就不再让盘上快照覆盖它——SQLite 读有可能比事件回得晚，晚到的基线会把
  // 刚拿到的活实体冲掉。
  const liveRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    storageService
      .loadCommandSets()
      .then((list) => {
        if (!cancelled && !liveRef.current) setSets(list);
      })
      .catch((e) => console.debug('[usePopoutSync] loadCommandSets failed:', e));
    return () => {
      cancelled = true;
    };
  }, []);

  // 窗口间事件总线。
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      try {
        const [unSets, unActiveTab] = await Promise.all([
          popoutEventService.onCommandSetsChanged((next) => {
            liveRef.current = true;
            setSets(next);
          }),
          popoutEventService.onActiveTabChanged((payload) => setActivePortId(payload.portId)),
        ]);
        if (cancelled) {
          unSets();
          unActiveTab();
          return;
        }
        unlisteners.push(unSets, unActiveTab);
        await popoutEventService.emitRequestSync();
      } catch (e) {
        console.debug('[usePopoutSync] event bus registration failed:', e);
      }
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, []);

  // 端口列表：弹窗是独立 webview，无同步的 store——按需调用全局后端。
  useEffect(() => {
    let cancelled = false;
    serialService
      .listAvailablePorts()
      .then((list) => {
        if (!cancelled) setPorts(list);
      })
      .catch((e) => console.debug('[usePopoutSync] listAvailablePorts failed:', e));
    return () => {
      cancelled = true;
    };
  }, []);

  // issue #7-5：「发送到」提示灯跟随串口真实连接状态。
  useEffect(() => {
    let cancelled = false;
    let unlisteners: Array<() => void> = [];
    Promise.all([
      eventService.onSerialStatus((event) => {
        if (cancelled) return;
        setConnectedPortIds((prev) => {
          const next = new Set(prev);
          if (event.status === 'connected') next.add(event.port_id);
          else next.delete(event.port_id);
          return next;
        });
      }),
      popoutEventService.onPortStatusesSync((items) => {
        if (cancelled) return;
        setConnectedPortIds(
          new Set(items.filter((i) => i.status === 'connected').map((i) => i.portId)),
        );
      }),
    ])
      .then(([u1, u2]) => {
        if (cancelled) {
          u1();
          u2();
          return;
        }
        unlisteners = [u1, u2];
      })
      .catch((e) => console.debug('[usePopoutSync] status listeners failed:', e));
    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
    };
  }, []);

  const openSetEditor = useCallback(() => {
    void popoutEventService
      .emitOpenConfig({ page: 'commands' })
      .catch((e) => console.debug('[usePopoutSync] emitOpenConfig failed:', e));
  }, []);

  return { sets, activePortId, ports, connectedPortIds, openSetEditor };
}
