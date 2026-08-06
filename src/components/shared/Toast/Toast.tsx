import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, Info, AlertTriangle, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ToastItem, ToastSeverity } from '../../../stores/useToastStore';
import { useToastStore } from '../../../stores/useToastStore';

const severityIcon: Record<ToastSeverity, LucideIcon> = {
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

  useEffect(() => {
    // Sticky toasts (durationMs === 0) never auto-dismiss — they persist
    // until the user closes them or clears the notification center.
    if (toast.durationMs <= 0) return;
    const timer = setTimeout(() => dismiss(toast.id), toast.durationMs);
    return () => clearTimeout(timer);
  }, [toast.id, toast.durationMs, dismiss]);

  const Icon = severityIcon[toast.severity];
  const text = toast.messageKey ? t(toast.messageKey) : (toast.message ?? '');

  return (
    <div className={`toast ${severityClass[toast.severity]}`} role="alert">
      <span className="toast-icon"><Icon size={16} /></span>
      <span className="toast-message">{text}</span>
      <button
        className="toast-close"
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label={t('toast.close')}
      >
        <X size={14} />
      </button>
    </div>
  );
};

export default Toast;