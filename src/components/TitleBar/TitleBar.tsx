import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { Settings, Minus, Square, X } from 'lucide-react';

const TitleBar: React.FC = () => {
  const toggleConfigModal = useAppStore((state) => state.toggleConfigModal);

  return (
    <div className="titlebar-drag titlebar">
      <div className="titlebar-nodrag titlebar-left">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-link)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
        <span className="titlebar-title">HyperCom</span>
        <span className="titlebar-version">v0.1.0</span>
      </div>

      <div className="titlebar-nodrag titlebar-right">
        <button className="btn btn-icon btn-sm" title="设置" onClick={() => toggleConfigModal(true)}>
          <Settings size={15} />
        </button>
        <div className="titlebar-separator" />
        <button className="btn btn-icon btn-sm titlebar-control" title="最小化">
          <Minus size={15} />
        </button>
        <button className="btn btn-icon btn-sm titlebar-control" title="最大化">
          <Square size={13} />
        </button>
        <button className="btn btn-icon btn-sm titlebar-control titlebar-close" title="关闭">
          <X size={15} />
        </button>
      </div>
    </div>
  );
};

export default TitleBar;