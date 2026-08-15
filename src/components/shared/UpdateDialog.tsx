import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { relaunch } from '@tauri-apps/plugin-process';
import { open } from '@tauri-apps/plugin-shell';
import { useAppStore } from '../../stores/useAppStore';
import { useRuleStore } from '../../stores/useRuleStore';
import { configService, updateService } from '../../services/tauri';
import { mergeLiveRuleEntities } from '../../utils/configMerge';
import { notifyError, notifySuccess } from '../../stores/useToastStore';
import { channelLabelKey, releaseUrl } from '../../utils/channel';
import { parseChangelog, splitBold } from '../../utils/changelog';
import { updateTiming } from '../../utils/updateService';
import type { UpdateProgressPayload } from '../../types';
import { X, Download, Clock, Ban, ExternalLink } from 'lucide-react';

/** changelog 块 → React 节点（issue #12 二轮：Markdown 轻量渲染替代 <pre> 原文）。 */
const ChangelogBlocks: React.FC<{ notes: string }> = ({ notes }) => (
  <div className="update-changelog-body">
    {parseChangelog(notes).map((block, i) => {
      // 行内加粗拆分；React 文本子节点天然转义，无注入面。
      const segments = splitBold(block.text).map((seg, j) =>
        seg.bold ? <strong key={j}>{seg.text}</strong> : <span key={j}>{seg.text}</span>,
      );
      if (block.kind === 'heading') {
        return (
          <div key={i} className={`update-changelog-h${block.level}`}>{segments}</div>
        );
      }
      if (block.kind === 'bullet') {
        return <div key={i} className="update-changelog-bullet">{segments}</div>;
      }
      return <div key={i} className="update-changelog-para">{segments}</div>;
    })}
  </div>
);

/** 更新弹窗（issue #12）：展示版本/日期/changelog + 三动作决策流。 */
const UpdateDialog: React.FC = () => {
  const { t } = useTranslation();
  const isOpen = useAppStore((s) => s.ui.isUpdateOpen);
  const candidate = useAppStore((s) => s.ui.updateCandidate);
  const setUIState = useAppStore((s) => s.setUIState);

  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<UpdateProgressPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  // 订阅下载进度（仅弹窗打开时）
  useEffect(() => {
    if (!isOpen) return;
    unlistenRef.current = updateService.onProgress((p) => setProgress(p));
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, [isOpen]);

  // 关闭时复位状态
  useEffect(() => {
    if (!isOpen) {
      setDownloading(false);
      setProgress(null);
      setError(null);
    }
  }, [isOpen]);

  if (!isOpen || !candidate) return null;

  const close = () => setUIState({ isUpdateOpen: false, updateCandidate: null });

  /** 同步「永不提醒」→ 设置项 updateCheckMode=none（全量保存，含活实体合并）。 */
  const disableAutoCheck = async () => {
    const store = useAppStore.getState();
    store.setConfig({ updateCheckMode: 'none' });
    try {
      await configService.setConfig(
        mergeLiveRuleEntities(useAppStore.getState().config, useRuleStore.getState()),
      );
      notifySuccess('update.neverReminderDone');
    } catch (e) {
      notifyError(e);
    }
  };

  /** 立即更新：下载+安装 → relaunch（Windows 由 installer 重启，此调用无害）。 */
  const installNow = async () => {
    setError(null);
    setDownloading(true);
    setProgress({ downloaded: 0, total: null, phase: 'download' });
    try {
      // 传候选版本做 TOCTOU 防护：安装前重检查若版本已变（展示后发布了新版），
      // 后端拒绝安装并报错——重新检查即可（issue #12 复审）。
      await updateService.downloadAndInstall(candidate.channel, candidate.version);
      // 安装完成后清除 snooze（用户已主动更新）
      updateTiming.clearSnooze();
      await relaunch();
    } catch (e) {
      console.error('[UpdateDialog] install failed:', e);
      setError(t('update.installFailed'));
      setDownloading(false);
      setProgress(null);
      notifyError(e, 'update.installFailed');
    }
  };

  /** 7 天后提醒：记 snooze，关闭弹窗。 */
  const remindLater = () => {
    updateTiming.setSnooze(7);
    close();
  };

  /** 不更新（永不提醒）：同步设置项 + 关闭弹窗。 */
  const neverRemind = async () => {
    await disableAutoCheck();
    close();
  };

  const channelKey = channelLabelKey(candidate.channel);
  const dateStr = candidate.date
    ? new Date(candidate.date * 1000).toLocaleString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
      })
    : '';

  return (
    // issue #12 复审：下载中遮罩点击不可关闭——X 与三个动作按钮都 disabled，
    // 遮罩是同一意图的漏网之口（否则点外面关弹窗，后台装完仍无预警 relaunch）。
    <div className="modal-overlay" onClick={downloading ? undefined : close}>
      <div className="modal-dialog-compact animate-slide-up" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 className="modal-dialog-title" style={{ margin: 0 }}>{t('update.title')}</h3>
          <button className="btn btn-icon btn-sm" onClick={close} title={t('hotkeys.close')} disabled={downloading}>
            <X size={14} />
          </button>
        </div>

        <div className="update-dialog-meta">
          <span className={`update-channel-badge update-channel-${candidate.channel}`}>{t(channelKey)}</span>
          <span className="update-version">{candidate.version}</span>
          {dateStr && <span className="update-date">{dateStr}</span>}
        </div>

        <div className="update-dialog-current">
          {t('update.currentVersion')}: v{candidate.currentVersion}
        </div>

        <div className="update-changelog">
          <div className="update-changelog-title">{t('update.changelogTitle')}</div>
          {candidate.notes ? (
            <ChangelogBlocks notes={candidate.notes} />
          ) : (
            <div className="update-changelog-empty">{t('update.noChangelog')}</div>
          )}
        </div>

        {progress && (
          <div className="update-download-progress">
            {progress.phase === 'download'
              ? t('update.downloading', {
                  percent: progress.total ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100)) : 0,
                })
              : t('update.installing')}
          </div>
        )}
        {error && <div className="update-error">{error}</div>}

        <div className="update-actions">
          {/* issue #12 二轮：跳转该版本 GitHub Release 页（方案 §2.5 rawJson 预留的落地） */}
          <button
            className="btn update-release-link"
            onClick={() =>
              open(releaseUrl(candidate.version)).catch((e) =>
                console.debug('[UpdateDialog] open release page failed:', e),
              )
            }
          >
            <ExternalLink size={14} />
            {t('update.viewRelease')}
          </button>
          <button className="btn" onClick={remindLater} disabled={downloading}>
            <Clock size={14} />
            {t('update.later')}
          </button>
          <button className="btn" onClick={neverRemind} disabled={downloading}>
            <Ban size={14} />
            {t('update.never')}
          </button>
          <button className="btn btn-primary" onClick={installNow} disabled={downloading}>
            <Download size={14} />
            {t('update.installNow')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default UpdateDialog;