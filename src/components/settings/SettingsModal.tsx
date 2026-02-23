import { useState } from 'react';
import { X, Type, Palette, FileText, Monitor } from 'lucide-react';
import { FontSettings } from './FontSettings';
import { ThemeSettings } from './ThemeSettings';
import { LogSettings } from './LogSettings';
import { DisplaySettings } from './DisplaySettings';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabKey = 'display' | 'font' | 'theme' | 'log';

interface Tab {
  key: TabKey;
  label: string;
  icon: typeof Monitor;
}

const TABS: Tab[] = [
  { key: 'display', label: '显示', icon: Monitor },
  { key: 'font', label: '字体', icon: Type },
  { key: 'theme', label: '主题', icon: Palette },
  { key: 'log', label: '日志', icon: FileText },
];

export function SettingsModal({ isOpen, onClose }: SettingsModalProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('display');

  if (!isOpen) return null;

  const renderContent = () => {
    switch (activeTab) {
      case 'display':
        return <DisplaySettings />;
      case 'font':
        return <FontSettings />;
      case 'theme':
        return <ThemeSettings />;
      case 'log':
        return <LogSettings />;
      default:
        return null;
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* 模态框 */}
      <div className="relative w-full max-w-2xl max-h-[80vh] bg-background rounded-xl shadow-2xl overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-semibold">设置</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-accent transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* 内容区 */}
        <div className="flex h-[60vh]">
          {/* 侧边导航 */}
          <div className="w-40 border-r bg-muted/30">
            <nav className="p-2 space-y-1">
              {TABS.map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.key;

                return (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors ${
                      isActive
                        ? 'bg-primary/10 text-primary'
                        : 'hover:bg-accent'
                    }`}
                  >
                    <Icon size={16} />
                    {tab.label}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* 设置内容 */}
          <div className="flex-1 overflow-auto p-6">
            {renderContent()}
          </div>
        </div>

        {/* 底部 */}
        <div className="flex justify-end px-6 py-4 border-t bg-muted/30">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
