/**
 * 文件发送的两个展示件：动作按钮（发送 / 取消）与进度条。
 *
 * 分成两个组件是因为它们在外层 DOM 里不在同一位置——按钮属于发送动作列
 * （`.op-send-actions`），进度条贴在整行下方；状态与副作用统一由
 * `useFileSend`（SendSection 内唯一实例）提供，这里只负责渲染。
 */
import { FileUp, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FileSendProgress } from '../hooks/useFileSend';

export interface SendFileButtonProps {
  progress: FileSendProgress | null;
  isConnected: boolean;
  onStart: () => void;
  onCancel: () => void;
}

export function SendFileButton({ progress, isConnected, onStart, onCancel }: SendFileButtonProps) {
  const { t } = useTranslation();

  if (progress !== null) {
    return (
      <button className="btn btn-sm btn-danger" title={t('sendSection.file.cancel')} onClick={onCancel}>
        <Square size={13} /> {t('sendSection.file.cancel')}
      </button>
    );
  }
  return (
    <button
      className="btn btn-sm"
      title={t('sendSection.file.button')}
      onClick={onStart}
      disabled={!isConnected}
    >
      <FileUp size={13} /> {t('sendSection.file.button')}
    </button>
  );
}

export function FileSendProgress({ progress }: { progress: FileSendProgress }) {
  const percent =
    progress.total > 0 ? Math.round((progress.sent / progress.total) * 100) : 0;
  return (
    <div className="op-file-progress">
      <div className="op-file-progress-track">
        <div className="op-file-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="op-file-progress-label">
        {progress.sent} / {progress.total} B
      </span>
    </div>
  );
}
