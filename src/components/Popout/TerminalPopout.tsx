import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTerminalStore } from '../../stores/useTerminalStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { popoutEventService, storageService } from '../../services/tauri';
import { useConfigPersistence } from '../../hooks/useConfigPersistence';
import { computeBufferLimits, getViewportManager, replaceTerminalLines } from '../../utils/terminal/viewportManager';
import { usePortSerialFeed } from './usePortSerialFeed';
import TerminalView from '../MainDisplay/TerminalView';

/** 快照交接超时（ms）：超时无条件开闸，见 `openGate` 兜底说明。 */
const SNAPSHOT_FALLBACK_MS = 1000;

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
 * - 实时：后端 `serial:data` 是广播，字节经 `usePortSerialFeed` 交给本窗的 RxPipeline
 *   （与主窗同一条既有管线，弹窗是独立 webview 故单例自然隔离）。
 * - 配置：走主窗同一条 `useConfigPersistence.loadConfig`，不另开一份配置加载路径。
 *
 * 能力缺口（S-I4，在面板顶部显式标注，不静默缺失）：
 * - 协议帧重组不在弹窗复刻——绑定协议模板的端口在弹窗里按原始流解码显示（无字段着色）。
 *   快照里既有的 parsedFields 行仍按字段着色渲染。
 * - TX 回显是主窗前端行为（后端不发 TX 事件），故弹窗只显示 RX（及环回模拟回声）。
 */
const TerminalPopout: React.FC<TerminalPopoutProps> = ({ portId }) => {
  const { t } = useTranslation();
  const { loadConfig } = useConfigPersistence();
  const { openGate } = usePortSerialFeed(portId);

  useEffect(() => {
    // OS window title mirrors the main-window convention: "HyperCom — <portId>"
    // so the user can identify the window from the taskbar/Alt-Tab. Fire-and-forget;
    // a failure (webview not yet attached) only logs at debug level.
    getCurrentWindow()
      .setTitle(`HyperCom — ${portId}`)
      .catch((e) => console.debug('[TerminalPopout] setTitle failed:', e));
  }, [portId]);

  useEffect(() => {
    useTerminalStore.getState().ensureTerminal(portId);

    // 视觉一致性：与主窗同一份配置来源（时间戳格式/字体/最大行数）与同一份高亮
    // 规则来源。均为一次性只读，fire-and-forget；失败仅退化为默认观感。
    void loadConfig().then(() => {
      // 缓冲上限来自 config.maxDisplayLines——配置到位后补一次，覆盖建实例时的默认值。
      getViewportManager(portId).applyLimits(computeBufferLimits());
    });
    storageService
      .loadHighlightSets()
      .then((sets) => useRuleStore.getState().setHighlightRuleSets(sets))
      .catch((e) => console.debug('[TerminalPopout] loadHighlightSets failed:', e));
  }, [portId, loadConfig]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let gateOpened = false;
    const fallbackTimer = setTimeout(() => openSnapshot(null), SNAPSHOT_FALLBACK_MS);

    /** 交接只做一次：快照到达或兜底超时，先到者胜。 */
    function openSnapshot(lastTs: number | null) {
      if (gateOpened) return;
      gateOpened = true;
      clearTimeout(fallbackTimer);
      openGate(lastTs);
    }

    void (async () => {
      try {
        // 监听器注册是异步的：必须 await 就绪后再请求快照，否则主窗的 reply
        // 会早于监听器到达而丢失。
        const u = await popoutEventService.onTerminalSnapshot((payload) => {
          if (payload.portId !== portId) return;
          const { lines, ...display } = payload.terminal;
          const { encoding, ...patch } = display;
          const terminal = useTerminalStore.getState();
          // encoding 只经 setTerminalEncoding（store 契约禁止经 setTerminalConfig
          // 写它——渲染器要靠这次切换重解码惰性行）。
          terminal.setTerminalConfig(portId, patch);
          if (encoding) terminal.setTerminalEncoding(portId, encoding);
          // 闸门打开前管线没写过本窗缓冲，快照是唯一写入者 → 无条件替换。
          replaceTerminalLines(portId, lines);
          openSnapshot(lines.length > 0 ? lines[lines.length - 1].timestamp : null);
        });
        if (cancelled) {
          u();
          return;
        }
        unlisten = u;
        await popoutEventService.emitTerminalRequestSnapshot({ portId });
      } catch (e) {
        console.debug('[TerminalPopout] snapshot handshake failed:', e);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(fallbackTimer);
      unlisten?.();
    };
  }, [portId, openGate]);

  return (
    <div className="popout-terminal">
      {/* S-I4：弹窗与主窗的能力差异显式可见（不新增 i18n key，全部用既有文案组合）。 */}
      <div className="popout-capability-hint">
        <span>{t('terminalPopout.poppedOutHint', { port: portId })}</span>
        <span>
          {t('terminalView.protocolLabel')}
          {t('terminalView.protocolNone')}
        </span>
        <span>{t('terminal.filter.rxOnly')}</span>
      </div>
      <TerminalView portId={portId} />
    </div>
  );
};

export default TerminalPopout;
