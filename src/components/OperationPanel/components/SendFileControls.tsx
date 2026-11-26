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

export function formatFileBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export interface SendFileButtonProps {
  progress: FileSendProgress | null;
  isConnected: boolean;
  onStart: () => void;
  onCancel: () => void;
}

export function SendFileButton({ progress, isConnected, onStart, onCancel }: SendFileButtonProps) {
  const { t } = useTranslation();

  if (progress !== null) {
    const label = progress.cancelling
      ? t('sendSection.file.cancelling')
      : t('sendSection.file.cancel');
    return (
      <button
        type="button"
        className="btn btn-sm btn-danger"
        title={label}
        disabled={!!progress.cancelling}
        onClick={onCancel}
      >
        <Square size={13} /> {label}
      </button>
    );
  }
  return (
    <button
      type="button"
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
  const { t } = useTranslation();
  const isIndeterminate = progress.total <= 0;
  const percent = isIndeterminate
    ? 0
    : Math.min(100, Math.round((progress.sent / progress.total) * 100));

  return (
    <div className="op-file-progress">
      {progress.fileName && (
        <span className="op-file-progress-name" title={progress.fileName}>
          {progress.fileName}
        </span>
      )}
      <div
        className="op-file-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={isIndeterminate ? undefined : percent}
        aria-label={progress.fileName || t('sendSection.file.button')}
      >
        <div
          className={`op-file-progress-fill${isIndeterminate ? ' is-indeterminate' : ''}`}
          style={isIndeterminate ? undefined : { width: `${percent}%` }}
        />
      </div>
      <span className="op-file-progress-label">
        {progress.cancelling
          ? t('sendSection.file.cancelling')
          : isIndeterminate
            ? formatFileBytes(progress.sent)
            : `${percent}% · ${formatFileBytes(progress.sent)} / ${formatFileBytes(progress.total)}`}
      </span>
    </div>
  );
}
