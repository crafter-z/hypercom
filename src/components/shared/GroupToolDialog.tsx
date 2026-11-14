import React from 'react';
import { useTranslation } from 'react-i18next';
import type { PortGroup, SerialPort } from '../../types';
import { usePluginViewOverlay } from './usePluginViewOverlay';
import Modal from './Modal';

export interface GroupToolDialogProps {
  group: PortGroup;
  configured: SerialPort[];
  unconfigured: SerialPort[];
  onRun: () => void;
  onConfigure: () => void;
  onClose: () => void;
}

/**
 * 整组执行外部工具前的确认/警告弹窗（issue #5-7）。
 * 组内存在未配置工具的串口时提示数量；全部未配置时显示"无已配置"文案；
 * 全部已配置时不应出现（runToolForGroup 直接执行）。
 */
const GroupToolDialog: React.FC<GroupToolDialogProps> = ({
  configured,
  unconfigured,
  onRun,
  onConfigure,
  onClose,
}) => {
  const { t } = useTranslation();
  const hasUnconfigured = unconfigured.length > 0;
  const overlayReady = usePluginViewOverlay();
  if (!overlayReady) return null;

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy="group-tool-dialog-title"
      dialogClassName="modal-dialog-compact animate-slide-up"
      onOverlayClick={onClose}
    >
      <h3 className="modal-dialog-title" id="group-tool-dialog-title">{t('groupTool.title')}</h3>
      <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 12 }}>
        {hasUnconfigured
          ? t('groupTool.message', { configured: configured.length, unconfigured: unconfigured.length })
          : t('groupTool.noConfigured')}
      </p>
      <div className="modal-dialog-actions">
        <button className="btn" onClick={onClose}>{t('groupTool.cancel')}</button>
        {hasUnconfigured && (
          <button className="btn" onClick={onConfigure}>{t('groupTool.configureMissing')}</button>
        )}
        <button
          className="btn btn-primary"
          disabled={configured.length === 0}
          onClick={onRun}
        >
          {t('groupTool.runConfigured')}
        </button>
      </div>
    </Modal>
  );
};

export default GroupToolDialog;
