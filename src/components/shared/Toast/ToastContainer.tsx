import React from 'react';
import { useToastStore } from '../../../stores/useToastStore';
import Toast from './Toast';

/**
 * Toast container — mount ONCE at the app root (see App.tsx).
 *
 * Wrapper is `position: fixed` at bottom-right, above the StatusBar, with
 * `pointer-events: none` so empty areas pass clicks through; each toast has
 * `pointer-events: auto` so its close button stays clickable.
 *
 * Toasts stack vertically upward (newest at the bottom of the visual stack,
 * closest to the StatusBar). Overflow beyond MAX_VISIBLE is moved into the
 * store's `stashed` array (the NotificationCenter shows everything); the
 * live stack here keeps exactly MAX_VISIBLE entries.
 */
const ToastContainer: React.FC = () => {
  const toasts = useToastStore((s) => s.toasts);

  return (
    <div className="toast-container" aria-live="polite">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} />
      ))}
    </div>
  );
};

export default ToastContainer;