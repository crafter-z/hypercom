import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { getVersion } from '@tauri-apps/api/app';
import { open } from '@tauri-apps/plugin-shell';
import { X, ExternalLink, ScrollText, Bug, Download } from 'lucide-react';
import LicensesDialog from './LicensesDialog';
import DiagnosticLogDialog from './DiagnosticLogDialog';
import { manualCheck } from '../../utils/updateService';
import { useToastStore } from '../../stores/useToastStore';
import { channelLabelKey } from '../../utils/channel';
import type { ReleaseChannel } from '../../types';

/** 项目 GitHub 仓库地址（issue #4-6，「关于」界面一键跳转）。 */
const GITHUB_URL = 'https://github.com/crafter-z/hypercom';

const AboutDialog: React.FC = () => {
  const { t } = useTranslation();
  const isOpen = useAppStore((s) => s.ui.isAboutOpen);
  const setUIState = useAppStore((s) => s.setUIState);
  const [version, setVersion] = useState('');
  const [showLicenses, setShowLicenses] = useState(false);
  const [showDiagLog, setShowDiagLog] = useState(false);
  // issue #12：手动检查状态（checking → 已完成），disable 期间防重复点击
  const [checking, setChecking] = useState<ReleaseChannel | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    getVersion()
      .then(setVersion)
      .catch((e) => console.debug('[AboutDialog] getVersion failed:', e));
  }, [isOpen]);

  if (!isOpen) return null;

  const close = () => setUIState({ isAboutOpen: false });

  const openGithub = () => {
    open(GITHUB_URL).catch((e) => console.debug('[AboutDialog] open GitHub failed:', e));
  };

  /**
   * issue #12：手动检查更新（bypass 周期/snooze，两种通道可选）。
   * - 有更新 → 打开 UpdateDialog（关掉 About 避免叠层）
   * - 无更新 → info toast「已是最新」
   * - 失败 → error toast（手动检查失败要告知用户；自动检查才静默）
   */
  const handleManualCheck = async (channel: ReleaseChannel) => {
    if (checking) return;
    setChecking(channel);
    try {
      // 手动检查不过 DEV 门控：显式用户意图，后端 debug 构建返回 Ok(None)
      // 双保险（开发时不触网）。E2E 在 dev server 上 mock check_for_update 驱动。
      const outcome = await manualCheck(channel);
      if (outcome.failed) {
        // 固定文案用 messageKey（notifyError 的 raw 优先会吞掉 fallbackKey）
        useToastStore.getState().push({ severity: 'error', messageKey: 'update.checkFailed' });
      } else if (outcome.update) {
        setUIState({ isAboutOpen: false });
        setUIState({ isUpdateOpen: true, updateCandidate: outcome.update });
      } else {
        // manualNoUpdate 带 {{channel}} 插值，经 t() 渲染后以 message 投递
        useToastStore.getState().push({
          severity: 'info',
          message: t('update.manualNoUpdate', { channel: t(channelLabelKey(channel)) }),
        });
      }
    } finally {
      setChecking(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal-dialog-compact animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 className="modal-dialog-title" style={{ margin: 0 }}>{t('about.title')}</h3>
          <button className="btn btn-icon btn-sm" onClick={close} title={t('hotkeys.close')}>
            <X size={14} />
          </button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '8px 0 16px' }}>
          <svg width="48" height="48" viewBox="0 0 96 96" fill="none">
            <path d="M25 18 V78 M71 18 V78 M25 48 H36 V38 H48 V58 H60 V48 H71"
                  stroke="var(--accent-color, #4fc3f7)" strokeWidth="10" strokeLinecap="round" strokeLinejoin="miter"/>
          </svg>
          <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>{t('titleBar.appName')}</div>
          {/* issue #4-7：版本号只显示真实版本（getVersion），不再叠加硬编码的 v0.1.0。 */}
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {t('about.version')} {version ? `v${version}` : ''}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', marginTop: 4 }}>
            {t('about.description')}
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
          <div style={{ marginBottom: 6, fontWeight: 500, color: 'var(--text-primary)' }}>{t('about.techStack')}</div>
          <div>Tauri v2 · React 18 · Rust · TypeScript</div>
          <div style={{ marginTop: 4 }}>serialport-rs · tokio · Zustand · i18next</div>
        </div>

        <div className="about-actions">
          <button className="btn btn-sm" onClick={openGithub}>
            <ExternalLink size={14} />
            {t('about.github')}
          </button>
          <button className="btn btn-sm" onClick={() => setShowLicenses(true)}>
            <ScrollText size={14} />
            {t('about.licenses')}
          </button>
          <button className="btn btn-sm" onClick={() => setShowDiagLog(true)}>
            <Bug size={14} />
            {t('about.diagLog')}
          </button>
        </div>

        {/* issue #12：手动检查更新（正式版 / preview 任选，不受 updateCheckMode=none 限制） */}
        <div className="about-actions">
          <button
            className="btn btn-sm"
            onClick={() => handleManualCheck('stable')}
            disabled={checking !== null}
          >
            <Download size={14} />
            {checking === 'stable' ? t('update.checking') : t('update.manualCheckStable')}
          </button>
          <button
            className="btn btn-sm"
            onClick={() => handleManualCheck('preview')}
            disabled={checking !== null}
          >
            <Download size={14} />
            {checking === 'preview' ? t('update.checking') : t('update.manualCheckPreview')}
          </button>
        </div>

        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center' }}>
          {t('about.license')} · © 2026 HyperCom
        </div>
      </div>

      {showLicenses && <LicensesDialog onClose={() => setShowLicenses(false)} />}
      {showDiagLog && <DiagnosticLogDialog onClose={() => setShowDiagLog(false)} />}
    </div>
  );
};

export default AboutDialog;