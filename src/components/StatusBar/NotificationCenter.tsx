import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, Pin, Trash2, X } from 'lucide-react';
import { severityIcon } from '../shared/Toast/Toast';
import type { ToastItem } from '../../stores/useToastStore';
import { useToastStore } from '../../stores/useToastStore';
import { getTabPortId, useAppStore } from '../../stores/useAppStore';
import ConfirmDialog from '../shared/ConfirmDialog';
import { useOutsideDismiss } from '../shared/useOutsideDismiss';
import { usePluginViewOverlay } from '../shared/usePluginViewOverlay';

/** Badge caps at 99+ so the status bar chip never blows out. */
const MAX_BADGE_COUNT = 99;

/** Notification row time — HH:MM:SS (issue #7-1: every notification carries a timestamp). */
function formatNotifyTime(ts: number): string {
  const d = new Date(ts);
  const pad2 = (n: number) => String(n).padStart(2, '0');
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * Notification center (VSCode-style, issue #5-3): a persistent bell + badge in
 * the StatusBar. Clicking toggles a popover listing ALL notifications (live
 * stack + overflow stash, newest first) with a one-click clear-all and
 * click-to-dismiss rows. Sticky notifications (durationMs === 0) are marked
 * with a pin hint — they persist until the user clears them.
 *
 * Completely separate from the transient toast stack (bottom-right); the
 * store never drops toasts anymore, it stashes overflow here instead.
 */
const NotificationCenter: React.FC = () => {
  const { t } = useTranslation();
  const toasts = useToastStore((s) => s.toasts);
  const stashed = useToastStore((s) => s.stashed);
  const centerOpen = useToastStore((s) => s.centerOpen);
  const setCenterOpen = useToastStore((s) => s.setCenterOpen);
  const clearAll = useToastStore((s) => s.clearAll);
  const dismiss = useToastStore((s) => s.dismiss);
  const tabs = useAppStore((s) => s.tabs);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const [clearConfirm, setClearConfirm] = useState(false);
  const overlayReady = usePluginViewOverlay(centerOpen);

  const wrapRef = useRef<HTMLDivElement>(null);

  // All notifications, newest first. The live stack is newest-at-end and the
  // stash holds older overflow — sorting by createdAt is the single source of
  // order regardless of where each toast currently lives.
  const all: ToastItem[] = [...stashed, ...toasts].sort((a, b) => b.createdAt - a.createdAt);
  const count = all.length;

  // Outside click / Escape closes the panel. The bell button lives inside
  // wrapRef, so clicking it never dismisses — the button's own onClick toggles.
  const closeCenter = useCallback(() => setCenterOpen(false), [setCenterOpen]);
  useOutsideDismiss(wrapRef, closeCenter, centerOpen);

  return (
    <div className="notify-wrap" ref={wrapRef}>
      <button
        type="button"
        className="statusbar-item notify-btn"
        title={t('notify.openCenter')}
        aria-label={t('notify.openCenter')}
        aria-expanded={centerOpen}
        onClick={() => setCenterOpen(!centerOpen)}
      >
        <Bell size={12} />
        {count > 0 && (
          <span className="notify-badge">{count > MAX_BADGE_COUNT ? `${MAX_BADGE_COUNT}+` : count}</span>
        )}
      </button>

      {centerOpen && overlayReady && (
        <div className="notify-panel" role="dialog" aria-label={t('notify.title')}>
          <div className="notify-header">
            <span className="notify-title">{t('notify.title')} <span className="notify-title-count">{count}</span></span>
            <button
              type="button"
              className="notify-clear-all"
              onClick={() => setClearConfirm(true)}
              disabled={count === 0}
            >
              <Trash2 size={12} />
              {t('notify.clearAll')}
            </button>
          </div>
          {count === 0 ? (
            <div className="notify-empty">{t('notify.empty')}</div>
          ) : (
            <div className="notify-list">
              {all.map((toast) => {
                const Icon = severityIcon[toast.severity];
                const text = toast.messageKey ? t(toast.messageKey) : (toast.message ?? '');
                const sourceTab = toast.portId ? tabs.find((item) => getTabPortId(item) === toast.portId) : undefined;
                const hasSource = !!sourceTab;
                const openSource = () => {
                  if (!hasSource) return;
                  const tab = sourceTab;
                  if (tab) {
                    setActiveTab(tab.id);
                    setCenterOpen(false);
                  }
                };
                return (
                  <div
                    key={toast.id}
                    className={`notify-row notify-${toast.severity}${hasSource ? ' notify-row-actionable' : ''}`}
                    role={hasSource ? 'button' : 'group'}
                    tabIndex={hasSource ? 0 : -1}
                    title={hasSource ? t('notify.openSource') : undefined}
                    onClick={openSource}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget || !hasSource) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openSource();
                      }
                    }}
                  >
                    <div className="notify-row-heading">
                      <span className={`notify-severity-icon notify-severity-${toast.severity}`}><Icon size={14} aria-hidden="true" /></span>
                      {toast.title && <div className="notify-row-title">{toast.title}</div>}
                    </div>
                    <div className="notify-row-msg">{text}</div>
                    <div className="notify-row-meta">
                      <span>{t(`toast.severity.${toast.severity}`)}</span>
                      {/* issue #7-1：串口来源消息携带串口号；每条通知附带时间戳 */}
                      {toast.portId && <span className="notify-row-port">{toast.portId}</span>}
                      <span className="notify-row-time">{formatNotifyTime(toast.createdAt)}</span>
                      {toast.durationMs === 0 && <Pin size={10} aria-hidden="true" />}
                      <button
                        type="button"
                        className="notify-row-dismiss"
                        title={t('notify.dismiss')}
                        aria-label={t('notify.dismiss')}
                        onClick={(event) => { event.stopPropagation(); dismiss(toast.id); }}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      <ConfirmDialog
        open={clearConfirm}
        title={t('notify.clearTitle')}
        message={t('notify.clearMessage', { count })}
        confirmLabel={t('confirmDialog.confirm')}
        cancelLabel={t('confirmDialog.cancel')}
        danger
        onConfirm={() => { setClearConfirm(false); clearAll(); }}
        onCancel={() => setClearConfirm(false)}
      />
    </div>
  );
};

export default NotificationCenter;
