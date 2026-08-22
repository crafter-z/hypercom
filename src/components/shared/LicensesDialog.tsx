import React from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

interface LicenseRow {
  name: string;
  license: string;
}

const FRONTEND_LICENSES: LicenseRow[] = [
  { name: 'react / react-dom', license: 'MIT' },
  { name: 'typescript', license: 'Apache-2.0' },
  { name: 'vite', license: 'MIT' },
  { name: 'vitest', license: 'MIT' },
  { name: 'zustand', license: 'MIT' },
  { name: 'immer', license: 'MIT' },
  { name: '@dnd-kit (core / sortable / utilities)', license: 'MIT' },
  { name: '@tauri-apps/* (api / plugins / cli)', license: 'Apache-2.0 OR MIT' },
  { name: 'i18next / react-i18next', license: 'MIT' },
  { name: 'lucide-react', license: 'ISC' },
  { name: '@playwright/test', license: 'Apache-2.0' },
];

const BACKEND_LICENSES: LicenseRow[] = [
  { name: 'tauri (v2)', license: 'Apache-2.0 OR MIT' },
  { name: 'serialport', license: 'MIT OR Apache-2.0' },
  { name: 'tokio', license: 'MIT' },
  { name: 'serde / serde_json', license: 'MIT OR Apache-2.0' },
  { name: 'encoding_rs', license: 'MIT OR Apache-2.0' },
  { name: 'chrono', license: 'MIT OR Apache-2.0' },
  { name: 'dirs', license: 'MIT OR Apache-2.0' },
  { name: 'uuid', license: 'Apache-2.0 OR MIT' },
  { name: 'thiserror / anyhow', license: 'MIT OR Apache-2.0' },
  { name: 'log / env_logger', license: 'MIT OR Apache-2.0' },
  { name: 'sysinfo', license: 'MIT' },
];

const LicenseTable: React.FC<{ title: string; rows: LicenseRow[] }> = ({ title, rows }) => (
  <>
    <div className="licenses-section-title">{title}</div>
    <table className="licenses-table">
      <tbody>
        {rows.map((row) => (
          <tr key={row.name}>
            <td className="licenses-dep">{row.name}</td>
            <td className="licenses-spdx">{row.license}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </>
);

interface LicensesDialogProps {
  onClose: () => void;
}

const LicensesDialog: React.FC<LicensesDialogProps> = ({ onClose }) => {
  const { t } = useTranslation();

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-dialog-compact animate-slide-up licenses-dialog" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 className="modal-dialog-title" style={{ margin: 0 }}>{t('about.licenses.title')}</h3>
          <button className="btn btn-icon btn-sm" onClick={onClose} title={t('hotkeys.close')}>
            <X size={14} />
          </button>
        </div>
        <div className="licenses-scroll">
          <LicenseTable title={t('about.licenses.frontend')} rows={FRONTEND_LICENSES} />
          <LicenseTable title={t('about.licenses.backend')} rows={BACKEND_LICENSES} />
        </div>
        <div className="licenses-note">{t('about.licenses.note')}</div>
      </div>
    </div>
  );
};

export default LicensesDialog;