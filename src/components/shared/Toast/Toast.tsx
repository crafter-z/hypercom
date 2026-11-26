import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, Info, AlertTriangle, X, Copy, Check } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ToastItem, ToastSeverity } from '../../../stores/useToastStore';
import { useToastStore } from '../../../stores/useToastStore';
import { useSystemStore } from '../../../stores/useSystemStore';
import { writeClipboardText } from '../../../utils/clipboard';

export const severityIcon: Record<ToastSeverity, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
};

const severityClass: Record<ToastSeverity, string> = {
  info: 'toast-info',
  success: 'toast-success',
  warning: 'toast-warning',
  error: 'toast-error',
};

interface ToastProps {
  toast: ToastItem;
}

const Toast: React.FC<ToastProps> = ({ toast }) => {
  const { t } = useTranslation();
  const dismiss = useToastStore((s) => s.dismiss);
  const [paused, setPaused] = useState(false);
  const [copied, setCopied] = useState(false);
  const remainingRef = useRef(toast.durationMs);
  const startedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    remainingRef.current = toast.durationMs;
  }, [toast.id, toast.durationMs]);

  useEffect(() => {
    // Sticky toasts (durationMs === 0) never auto-dismiss — they persist
    // until the user closes them or clears the notification center.
    if (toast.durationMs <= 0) return;
    if (paused) return;
    const delay = Math.max(0, remainingRef.current);
    startedAtRef.current = Date.now();
    const timer = setTimeout(() => dismiss(toast.id), delay);
    return () => {
      clearTimeout(timer);
      const elapsed = Date.now() - startedAtRef.current;
      remainingRef.current = Math.max(0, remainingRef.current - elapsed);
    };
  }, [toast.id, toast.durationMs, dismiss, paused]);

  const Icon = severityIcon[toast.severity];
  const text = toast.messageKey ? t(toast.messageKey) : (toast.message ?? '');
  // The linked-plugin-update toast is the only host notification that carries
  // an action: clicking it (or Enter/Space) opens Settings → Plugins and
  // dismisses the toast. Plugin notifications cannot set `action`.
  const actionable = toast.action === 'open-plugin-settings';
  const activate = () => {
    if (!actionable) return;
    dismiss(toast.id);
    useSystemStore.getState().setConfigActiveTab('plugins');
    useSystemStore.getState().toggleConfigModal(true);
  };

  const handleCopy = (event: React.MouseEvent) => {
    event.stopPropagation();
    const copyContent = toast.title ? `${toast.title}: ${text}` : text;
    if (!copyContent) return;
    void writeClipboardText(copyContent)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };

  return (
    <div
      className={`toast ${severityClass[toast.severity]}${actionable ? ' toast-actionable' : ''}`}
      role={actionable ? 'button' : 'alert'}
      tabIndex={actionable ? 0 : undefined}
      title={actionable ? t('notify.openPluginSettings') : undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      onClick={activate}
      onKeyDown={(event) => {
        // Keyboard activation belongs to the toast row itself; Enter/Space on
        // nested buttons must not trigger the outer row action.
        if (!actionable || event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        activate();
      }}
    >
      <span className="toast-icon"><Icon size={16} /></span>
      <div className="toast-body">
        {(toast.title || toast.portId) && (
          <div className="toast-header">
            {toast.title && <span className="toast-title">{toast.title}</span>}
            {toast.portId && <span className="toast-port-chip">{toast.portId}</span>}
          </div>
        )}
        <span className="toast-message">{text}</span>
        {actionable && (
          <span className="toast-action-hint">{t('notify.openPluginSettings')} →</span>
        )}
      </div>
      <div className="toast-actions">
        {toast.severity === 'error' && (
          <button
            className="toast-close"
            type="button"
            onClick={handleCopy}
            title={t('toast.copyError')}
            aria-label={t('toast.copyError')}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        )}
        <button
          className="toast-close"
          type="button"
          onClick={(event) => { event.stopPropagation(); dismiss(toast.id); }}
          aria-label={t('toast.close')}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};

export default Toast;