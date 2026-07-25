import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { getVersion } from '@tauri-apps/api/app';
import { X } from 'lucide-react';

const AboutDialog: React.FC = () => {
  const { t } = useTranslation();
  const isOpen = useAppStore((s) => s.ui.isAboutOpen);
  const setUIState = useAppStore((s) => s.setUIState);
  const [version, setVersion] = useState('');

  useEffect(() => {
    if (!isOpen) return;
    getVersion()
      .then(setVersion)
      .catch((e) => console.debug('[AboutDialog] getVersion failed:', e));
  }, [isOpen]);

  if (!isOpen) return null;

  const close = () => setUIState({ isAboutOpen: false });

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
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {t('titleBar.version')}{version ? ` (${version})` : ''}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', textAlign: 'center', marginTop: 4 }}>
            {t('about.description')}
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
          <div style={{ marginBottom: 6, fontWeight: 500, color: 'var(--text-primary)' }}>{t('about.techStack')}</div>
          <div>Tauri v2 · React 18 · Rust · TypeScript</div>
          <div style={{ marginTop: 4 }}>serialport-rs · sqlx · tokio · Zustand</div>
        </div>

        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-secondary)', textAlign: 'center' }}>
          {t('about.license')} · © 2026 HyperCom
        </div>
      </div>
    </div>
  );
};

export default AboutDialog;
