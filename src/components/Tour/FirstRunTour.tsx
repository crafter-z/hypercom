import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Cable, Terminal, SlidersHorizontal } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { useConfigPersistence } from '../../hooks';

/** 引导步骤定义（模块级常量，避免每次渲染重建） */
const TOUR_STEPS: ReadonlyArray<{ icon: React.ReactNode; titleKey: string; bodyKey: string }> = [
  { icon: <Cable size={24} />, titleKey: 'tour.step1.title', bodyKey: 'tour.step1.body' },
  { icon: <Terminal size={24} />, titleKey: 'tour.step2.title', bodyKey: 'tour.step2.body' },
  { icon: <SlidersHorizontal size={24} />, titleKey: 'tour.step3.title', bodyKey: 'tour.step3.body' },
];

/**
 * 首次启动引导（3 步轻量弹窗）：
 * - 仅在配置加载完成（ui.configLoaded）且 config.hasSeenTour === false 时渲染，
 *   避免 loadConfig 异步返回前对老用户一闪而过
 * - 完成最后一步或跳过后：setConfig({ hasSeenTour: true }) 并持久化到后端
 * - TitleBar 帮助按钮 setConfig({ hasSeenTour: false }) 后自动重新挂载
 */
const FirstRunTour: React.FC = () => {
  const { t } = useTranslation();
  const hasSeenTour = useAppStore((s) => s.config.hasSeenTour);
  const configLoaded = useAppStore((s) => s.ui.configLoaded);
  const { saveConfig } = useConfigPersistence();
  const [step, setStep] = useState(0);

  const finish = useCallback(() => {
    useAppStore.getState().setConfig({ hasSeenTour: true });
    // 持久化，下次启动不再显示（saveConfig 内部已处理错误）
    saveConfig(useAppStore.getState().config);
  }, [saveConfig]);

  const handleNext = useCallback(() => {
    if (step >= TOUR_STEPS.length - 1) {
      finish();
    } else {
      setStep((s) => s + 1);
    }
  }, [step, finish]);

  // Esc = 跳过引导
  useEffect(() => {
    if (!configLoaded || hasSeenTour) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [configLoaded, hasSeenTour, finish]);

  if (!configLoaded || hasSeenTour) return null;

  const current = TOUR_STEPS[step];
  const isLast = step === TOUR_STEPS.length - 1;

  return (
    <div className="tour-backdrop">
      <div className="tour-modal" role="dialog" aria-modal="true" aria-label={t('tour.welcome')}>
        <div className="tour-accent-bar" />
        <div className="tour-welcome">{t('tour.welcome')}</div>
        {/* key={step} 使切换步骤时重新触发入场动画 */}
        <div className="tour-body" key={step}>
          <div className="tour-step-icon">{current.icon}</div>
          <div className="tour-step-title">{t(current.titleKey)}</div>
          <div className="tour-step-body">{t(current.bodyKey)}</div>
        </div>
        <div className="tour-footer">
          <div className="tour-dots" aria-hidden="true">
            {TOUR_STEPS.map((s, i) => (
              <span key={s.titleKey} className={`tour-dot${i === step ? ' active' : ''}`} />
            ))}
          </div>
          <span className="tour-counter">{step + 1}/{TOUR_STEPS.length}</span>
          <div className="tour-actions">
            <button className="btn btn-sm" onClick={finish}>{t('tour.skip')}</button>
            <button className="btn btn-primary btn-sm" onClick={handleNext}>
              {isLast ? t('tour.finish') : t('tour.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FirstRunTour;
