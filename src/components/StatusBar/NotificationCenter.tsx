import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, Pin, Trash2 } from 'lucide-react';
import type { ToastItem } from '../../stores/useToastStore';
import { useToastStore } from '../../stores/useToastStore';

/** Badge caps at 99+ so the status bar chip never blows out. */
const MAX_BADGE_COUNT = 99;

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

  const wrapRef = useRef<HTMLDivElement>(null);

  // All notifications, newest first. The live stack is newest-at-end and the
  // stash holds older overflow — sorting by createdAt is the single source of
  // order regardless of where each toast currently lives.
  const all: ToastItem[] = [...stashed, ...toasts].sort((a, b) => b.createdAt - a.createdAt);
  const count = all.length;

  // Outside click / Escape closes the panel (mirrors ContextMenu).
  useEffect(() => {
    if (!centerOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      // The bell button lives inside wrapRef, so clicking it never fires this
      // handler — the button's own onClick toggles instead.
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setCenterOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCenterOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [centerOpen, setCenterOpen]);

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

      {centerOpen && (
        <div className="notify-panel" role="dialog" aria-label={t('notify.title')}>
          <div className="notify-header">
            <span className="notify-title">{t('notify.title')}</span>
            <button
              type="button"
              className="notify-clear-all"
              onClick={clearAll}
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
                const text = toast.messageKey ? t(toast.messageKey) : (toast.message ?? '');
                return (
                  <button
                    key={toast.id}
                    type="button"
                    className={`notify-row notify-${toast.severity}`}
                    title={t('toast.close')}
                    onClick={() => dismiss(toast.id)}
                  >
                    {toast.title && <div className="notify-row-title">{toast.title}</div>}
                    <div className="notify-row-msg">{text}</div>
                    <div className="notify-row-meta">
                      <span>{t(`toast.severity.${toast.severity}`)}</span>
                      {toast.durationMs === 0 && <Pin size={10} aria-hidden="true" />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default NotificationCenter;
