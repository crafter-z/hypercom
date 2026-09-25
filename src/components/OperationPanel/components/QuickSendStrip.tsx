/**
 * 快捷发送条：一行内尽量多显示当前激活命令集的命令药丸，首槽是常驻的
 * 「打开独立发送面板」入口，放不下的折叠进「⋯ +K」。
 *
 * 纯展示组件：命令与回调来自 SendSection，宽度测量来自 `useQuickStripLayout`。
 */
import { Plus, PanelRightOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../../stores/useAppStore';
import { popoutService } from '../../../services/tauri';
import type { SendCommand } from '../../../types';
import { useQuickStripLayout } from '../hooks/useQuickStripLayout';

/**
 * 命令药丸的单点渲染源：可见行与隐藏测量行共用同一份 JSX，保证测量宽度
 * 与真实渲染宽度一致。
 */
function QuickCmdPill({
  cmd,
  disabled,
  onClick,
}: {
  cmd: SendCommand;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className="btn btn-sm op-quick-cmd"
      disabled={disabled}
      title={cmd.name && cmd.name !== cmd.content ? `${cmd.name} — ${cmd.content}` : cmd.content}
      onClick={onClick}
    >
      {/* issue #6-9：名称在上（HEX 徽标与名称同行）、内容在下，两行显示 */}
      <span className="op-quick-cmd-name-row">
        {cmd.type === 'hex' && <span className="op-quick-cmd-hex">HEX</span>}
        <span className="op-quick-cmd-name">{cmd.name || cmd.content}</span>
      </span>
      <span className="op-quick-cmd-content">{cmd.content}</span>
    </button>
  );
}

export interface QuickSendStripProps {
  /** 当前激活命令集的命令，已按 order 排序。 */
  commands: SendCommand[];
  isPortActive: boolean;
  onSendCommand: (cmd: SendCommand) => void;
  /** 「配置命令集」入口（交由 SendSection 打开设置页，避免两处各自写导航）。 */
  onConfigure: () => void;
}

export function QuickSendStrip({
  commands,
  isPortActive,
  onSendCommand,
  onConfigure,
}: QuickSendStripProps) {
  const { t } = useTranslation();
  const quickSendInlineCount = useAppStore((s) => s.config.quickSendInlineCount);
  const visible = quickSendInlineCount > 0;
  const { stripRef, measureRowRef, panelBtnRef, visibleCommands, overflowCount } =
    useQuickStripLayout(commands, visible);

  const openQuickPanel = () => {
    popoutService
      .openPopout('quick-send')
      .catch((e) => console.debug('[QuickSendStrip] openPopout failed:', e));
  };

  // 0 = 纯弹窗模式：条整体不渲染（测量 hook 已按 enabled=false 跳过测量）。
  if (!visible) return null;

  return (
    <div className="op-quick-send-row" ref={stripRef}>
      {/* 首槽：常驻「打开独立发送面板」入口——issue #7-2：明显的按压按钮样式
          （accent 填充 + 文字标签，区别于滚动锁定等带状态的图标按钮），
          高度与两行药丸对齐；0 条命令时也保留（面板仍有内容可看）。 */}
      <button
        ref={panelBtnRef}
        className="btn btn-sm op-quick-panel-btn"
        title={t('quickSend.openPanel')}
        onClick={openQuickPanel}
      >
        <PanelRightOpen size={14} />
        <span className="op-quick-panel-btn-label">{t('quickSend.openPanelShort')}</span>
      </button>
      {commands.length > 0 ? (
        <>
          {visibleCommands.map((cmd) => (
            <QuickCmdPill
              key={cmd.id}
              cmd={cmd}
              disabled={!isPortActive}
              onClick={() => onSendCommand(cmd)}
            />
          ))}
          {overflowCount > 0 && (
            <button
              className="btn btn-sm op-quick-cmd op-quick-cmd-overflow"
              title={t('quickSend.overflow')}
              onClick={openQuickPanel}
            >
              ⋯ +{overflowCount}
            </button>
          )}
        </>
      ) : (
        <div className="op-quick-send-empty">
          <span>{t('sendSection.quickCommands.emptyHint')}</span>
          <button className="btn btn-sm op-quick-cmd-configure" onClick={onConfigure}>
            <Plus size={12} /> {t('sendSection.quickCommands.configure')}
          </button>
        </div>
      )}
      {/* 隐藏测量行：绝对定位 + visibility:hidden，渲染全部命令以测量
          真实宽度；与可见药丸共用 QuickCmdPill，宽度严格一致。 */}
      {commands.length > 0 && (
        <div className="op-quick-measure-row" ref={measureRowRef} aria-hidden="true">
          {commands.map((cmd) => (
            <QuickCmdPill key={cmd.id} cmd={cmd} disabled={!isPortActive} onClick={() => {}} />
          ))}
        </div>
      )}
    </div>
  );
}
