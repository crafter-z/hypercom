import React from 'react';
import { useAppStore } from '../../../stores/useAppStore';
import { open } from '@tauri-apps/plugin-dialog';

const BackupSettings: React.FC = () => {
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);

  return (
    <div className="config-page">
      <h3 className="config-page-title">备份管理</h3>

      <label className="checkbox-wrapper">
        <input type="checkbox" checked={config.backupEnabled} onChange={(e) => setConfig({ backupEnabled: e.target.checked })} />
        开启日志库备份
      </label>

      {config.backupEnabled && (
        <>
          <div className="config-row">
            <label>备份周期 (小时):</label>
            <input className="input" type="number" value={config.backupInterval} onChange={(e) => setConfig({ backupInterval: Number(e.target.value) })} min={1} />
          </div>
          <div className="config-row">
            <label>备份存储目录:</label>
            <input className="input" value={config.backupDirectory} placeholder="选择备份保存路径..." readOnly />
            <button className="btn btn-sm" onClick={async () => {
              const result = await open({ directory: true });
              if (result) setConfig({ backupDirectory: result });
            }}>浏览...</button>
          </div>
        </>
      )}
    </div>
  );
};

export default BackupSettings;
