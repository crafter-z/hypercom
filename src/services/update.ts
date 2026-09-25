/**
 * 自动更新命令（issue #12）。
 *
 * 参数约定见 `./tauri.ts` 文件头。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { ReleaseChannel, UpdatePayload, UpdateProgressPayload } from '../types';

export const updateService = {
  /** 检查指定通道的更新（Rust 侧运行时选择 endpoint；debug 构建返回 null）。 */
  checkForUpdate: (channel: ReleaseChannel): Promise<UpdatePayload | null> => {
    return invoke<UpdatePayload | null>('check_for_update', { channel });
  },

  /**
   * 下载并安装指定通道的更新（进度经 `update:progress` 事件推送）。
   * `expectedVersion`：弹窗候选版本——安装前重检查版本已变则后端拒绝（TOCTOU）。
   */
  downloadAndInstall: (channel: ReleaseChannel, expectedVersion: string): Promise<void> => {
    return invoke<void>('download_and_install_update', { channel, expectedVersion });
  },

  /** 订阅下载/安装进度。返回取消订阅函数。 */
  onProgress: (callback: (payload: UpdateProgressPayload) => void): (() => void) => {
    const unlisten = listen<UpdateProgressPayload>('update:progress', (event) => {
      callback(event.payload);
    });
    // listen 在 Tauri v2 返回 Promise<UnlistenFn>，调用方 await 不强求
    return () => {
      unlisten.then((fn) => fn());
    };
  },
};
