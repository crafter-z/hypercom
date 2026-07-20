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
 * closest to the StatusBar). Overflow beyond MAX_VISIBLE is dropped by the
 * store with a fade-out animation handled in CSS.
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