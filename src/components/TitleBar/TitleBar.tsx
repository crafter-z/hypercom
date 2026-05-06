/**
 * 标题栏组件
 * 包含软件图标、名称、全局配置按钮、窗口控制按钮
 * 位于界面最顶部
 */

import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
// TODO: 安装 lucide-react
// import { Settings, Minus, Square, X } from 'lucide-react';

const TitleBar: React.FC = () => {
  const toggleConfigModal = useAppStore((state) => state.toggleConfigModal);

  return (
    <div
      className="titlebar-drag"
      style={{
        height: 'var(--titlebar-height)',
        background: 'var(--bg-titlebar)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 12px',
        borderBottom: '1px solid var(--border-color)',
        userSelect: 'none',
      }}
    >
      {/* 左侧：图标与标题 */}
      <div className="titlebar-nodrag" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <img
          src="/app-icon.png"
          alt="HyperCom"
          style={{ width: 20, height: 20 }}
        />
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
          HyperCom 串口调试工具 v0.1.0
        </span>
      </div>

      {/* 右侧：配置按钮与窗口控制 */}
      <div className="titlebar-nodrag" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button
          className="btn btn-icon"
          title="配置"
          onClick={() => toggleConfigModal(true)}
        >
          {/* <Settings size={16} /> */}
          <span style={{ fontSize: 14 }}>⚙</span>
        </button>

        <div className="divider" style={{ margin: '0 8px', height: 16 }} />

        {/* 窗口控制按钮 */}
        <button className="btn btn-icon" title="最小化">
          {/* <Minus size={16} /> */}
          <span style={{ fontSize: 14 }}>−</span>
        </button>
        <button className="btn btn-icon" title="最大化">
          {/* <Square size={14} /> */}
          <span style={{ fontSize: 14 }}>□</span>
        </button>
        <button className="btn btn-icon" title="关闭" style={{ color: 'var(--text-error)' }}>
          {/* <X size={16} /> */}
          <span style={{ fontSize: 14 }}>✕</span>
        </button>
      </div>
    </div>
  );
};

export default TitleBar;
