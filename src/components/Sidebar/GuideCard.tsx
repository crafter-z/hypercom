import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Cable, FlaskConical, BookOpen, Send, Highlighter, Split, FileText,
} from 'lucide-react';

/** 快速入门功能条目（模块级常量，避免每次渲染重建） */
const QUICK_START_FEATURES: ReadonlyArray<{ icon: React.ReactNode; titleKey: string; bodyKey: string }> = [
  { icon: <Send size={15} />, titleKey: 'guide.quickStart.sendReceive.title', bodyKey: 'guide.quickStart.sendReceive.body' },
  { icon: <Highlighter size={15} />, titleKey: 'guide.quickStart.highlight.title', bodyKey: 'guide.quickStart.highlight.body' },
  { icon: <Split size={15} />, titleKey: 'guide.quickStart.split.title', bodyKey: 'guide.quickStart.split.body' },
  { icon: <FileText size={15} />, titleKey: 'guide.quickStart.logging.title', bodyKey: 'guide.quickStart.logging.body' },
];

/** 快速入门弹窗：4 个核心功能要点 */
const QuickStartModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="guide-quickstart-backdrop" onClick={onClose}>
      <div
        className="guide-quickstart animate-slide-up"
        role="dialog"
        aria-modal="true"
        aria-label={t('guide.quickStart.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="guide-quickstart-header">
          <BookOpen size={16} className="guide-quickstart-header-icon" />
          <span className="guide-quickstart-title">{t('guide.quickStart.title')}</span>
        </div>
        <ul className="guide-quickstart-list">
          {QUICK_START_FEATURES.map((feature) => (
            <li key={feature.titleKey} className="guide-quickstart-item">
              <span className="guide-quickstart-item-icon">{feature.icon}</span>
              <div className="guide-quickstart-item-text">
                <div className="guide-quickstart-item-title">{t(feature.titleKey)}</div>
                <div className="guide-quickstart-item-body">{t(feature.bodyKey)}</div>
              </div>
            </li>
          ))}
        </ul>
        <div className="guide-quickstart-footer">
          <button className="btn btn-primary btn-sm" onClick={onClose}>
            {t('guide.quickStart.close')}
          </button>
        </div>
      </div>
    </div>
  );
};

interface GuideCardProps {
  /** 复用 Sidebar 工具栏烧瓶按钮的 toggleSimulation handler */
  onEnableSimulation: () => void;
}

/**
 * 空端口列表引导卡片：
 * 仅在 ports 为空且未开启模拟模式时由 Sidebar 渲染，
 * 任意端口（真实 / SIM）出现后自动消失。
 */
const GuideCard: React.FC<GuideCardProps> = ({ onEnableSimulation }) => {
  const { t } = useTranslation();
  const [showQuickStart, setShowQuickStart] = useState(false);

  return (
    <div className="guide-card animate-slide-up">
      <div className="guide-card-icon">
        <Cable size={18} />
      </div>
      <div className="guide-card-title">{t('guide.title')}</div>
      <p className="guide-card-hint">{t('guide.hint')}</p>
      <button className="btn btn-primary btn-sm guide-card-sim-btn" onClick={onEnableSimulation}>
        <FlaskConical size={13} />
        {t('guide.simButton')}
      </button>
      <button className="guide-card-quickstart-link" onClick={() => setShowQuickStart(true)}>
        {t('guide.quickStartLink')}
      </button>
      {showQuickStart && <QuickStartModal onClose={() => setShowQuickStart(false)} />}
    </div>
  );
};

export default GuideCard;
