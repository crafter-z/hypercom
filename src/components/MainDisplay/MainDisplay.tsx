/**
 * 主串口显示窗口区
 * 包含标签页系统、分屏支持、终端显示
 * 占据界面核心位置
 */

import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
import TabBar from './TabBar';
import TerminalView from './TerminalView';

const MainDisplay: React.FC = () => {
  const {
    tabs,
    activeTabId,
    terminals,
    setActiveTab,
    closeTab,
    pinTab,
    closeTabsToRight,
    closeTabsToLeft,
    closeOtherTabs,
    splitPane,
  } = useAppStore();

  const activeTab = tabs.find(t => t.id === activeTabId);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* 标签栏 */}
      <div style={{ display: 'flex', alignItems: 'center', background: 'var(--bg-secondary)' }}>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onTabClick={setActiveTab}
            onTabClose={closeTab}
            onTabPin={pinTab}
            onCloseToRight={closeTabsToRight}
            onCloseToLeft={closeTabsToLeft}
            onCloseOthers={closeOtherTabs}
          />
        </div>

        {/* 分屏与更多操作 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '0 8px', flexShrink: 0 }}>
          <button className="btn btn-icon btn-sm" title="新建标签页">+</button>
          <button className="btn btn-icon btn-sm" title="分屏" onClick={() => splitPane('main', 'horizontal')}>
            ⧉
          </button>
          <button className="btn btn-icon btn-sm" title="更多">⋯</button>
        </div>
      </div>

      {/* 终端显示区 */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {activeTab ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {/* 终端工具栏 */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '4px 12px',
              background: 'var(--bg-secondary)',
              borderBottom: '1px solid var(--border-color)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="status-dot connected" />
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {activeTab.title}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  (115200, 8N1)
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>编码:</span>
                <select className="select" style={{ fontSize: 11, padding: '2px 18px 2px 4px' }}>
                  <option>ASCII</option>
                  <option>UTF-8</option>
                  <option>GBK</option>
                </select>
              </div>
            </div>

            {/* 终端内容 */}
            <TerminalView
              portId={activeTab.id}
              terminal={terminals[activeTab.id]}
            />
          </div>
        ) : (
          <div style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-secondary)',
            fontSize: 14,
          }}>
            请从左侧选择一个串口打开标签页
          </div>
        )}
      </div>
    </div>
  );
};

export default MainDisplay;
