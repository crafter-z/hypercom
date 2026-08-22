import React, { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { useAppStore } from '../../stores/useAppStore';
import {
  popoutEventService,
  eventService,
  storageService,
  configService,
} from '../../services/tauri';
import { getRxPipeline } from '../../utils/rxPipeline';
import TerminalView from '../MainDisplay/TerminalView';
import { replaceTerminalLines } from '../../utils/terminal/viewportManager';

interface TerminalPopoutProps {
  portId: string;
}

/**
 * 终端弹出窗内容（detach 语义的独立窗）。复用主窗 `<TerminalView>` 不改一行——
 * 喂给它**本窗自己的** useTerminalStore 实例即可白拿虚拟滚动 / 搜索 / 显示控制 / 右键菜单。
 *
 * 架构原则（贯穿柔性工作区）：弹窗与主窗不共享可变前端态，只交换意图/事件。
 * - 历史：终端行是主窗内存态（不在 SQLite）。mount 时发 `popout:terminal:request-snapshot`，
 *   主窗经 `popout:terminal:snapshot` 一次性回推当前缓冲 + 显示态（request→reply 避免竞态）。
 * - 实时：后端 `serial:data` 是广播，本窗直接订阅并按 portId 过滤，走与主窗相同的
 *   RxPipeline（字节级行聚合 + rAF 批写）。弹窗是独立 webview —— getRxPipeline()
 *   自然接线到本窗自己的 store。
 *
 * v1 限制（已记录）：
 * - 协议帧重组（ProtocolFrameReassembler）不在弹窗复刻——绑定协议模板的端口在弹窗里
 *   按原始流解码显示（无字段着色）。快照里既有的 parsedFields 行仍按字段着色渲染。
 * - TX 回显是主窗前端行为（后端不发 TX 事件），故弹窗只显示 RX（及环回模拟回声）。
 */
const TerminalPopout: React.FC<TerminalPopoutProps> = ({ portId }) => {
  useEffect(() => {
    // OS window title mirrors the main-window convention: "HyperCom — <portId>"
    // so the user can identify the window from the taskbar/Alt-Tab. Fire-and-forget;
    // a failure (webview not yet attached) only logs at debug level.
    getCurrentWindow()
      .setTitle(`HyperCom — ${portId}`)
      .catch((e) => console.debug('[TerminalPopout] setTitle failed:', e));

    const store = useTerminalStore.getState();
    store.ensureTerminal(portId);

    // 视觉一致性：加载高亮规则 + 全局配置（时间戳格式/字体），使 detached 终端
    // 与主窗观感一致。均为一次性只读，fire-and-forget；失败仅退化为无高亮/默认配置。
    storageService
      .loadHighlightSets()
      .then((sets) => useRuleStore.getState().setHighlightRuleSets(sets))
      .catch((e) => console.debug('[TerminalPopout] loadHighlightSets failed:', e));
    configService
      .getConfig()
      .then((config) => useAppStore.getState().setConfig(config))
      .catch((e) => console.debug('[TerminalPopout] getConfig failed:', e));

    const unlisteners: Array<() => void> = [];
    let cancelled = false;
    // Pipeline singleton for THIS webview — separate module scope from the
    // main window yields a separate instance wired to this window's stores.
    const pipeline = getRxPipeline();

    void (async () => {
      try {
        const [unSnapshot, unData] = await Promise.all([
          // 主窗回推快照：套用显示态 + 灌入历史行。encoding 经 setTerminalConfig
          // 直接赋值（**不**走 setTerminalEncoding）——快照行的 content 已按该编码
          // 解码好，重解码既冗余又可能扰动。先设显示态（含 maxLines）再灌行。
          popoutEventService.onTerminalSnapshot((payload) => {
            if (payload.portId !== portId) return;
            const { lines, ...display } = payload.terminal;
            const t = useTerminalStore.getState();
            t.setTerminalConfig(portId, display);
            replaceTerminalLines(portId, lines);
          }),
          // 实时流：广播按 portId 过滤，经 RxPipeline 完成字节级行聚合 +
          // rAF 批写。ignoreEmptyChars / 编码切换 / 静默 flush 全部管线内部处理。
          eventService.onSerialData((event) => {
            if (event.port_id !== portId) return;
            pipeline.feedBytes(portId, event.data, event.timestamp);
          }),
        ]);
        if (cancelled) {
          unSnapshot();
          unData();
          return;
        }
        unlisteners.push(unSnapshot, unData);
        // 监听器就绪后再请求快照，保证主窗 reply 不会早于监听器到达而丢失。
        await popoutEventService.emitTerminalRequestSnapshot({ portId });
      } catch (e) {
        console.debug('[TerminalPopout] listener registration failed:', e);
      }
    })();

    return () => {
      cancelled = true;
      unlisteners.forEach((u) => u());
      // Do NOT dispose the pipeline singleton — it has app lifetime.
    };
  }, [portId]);

  return <TerminalView portId={portId} />;
};

export default TerminalPopout;
