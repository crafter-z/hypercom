/**
 * 通用文件命令（配置导入导出 / 背景图读取）。
 *
 * 参数约定见 `./tauri.ts` 文件头。
 */
import { invoke } from '@tauri-apps/api/core';
import { decodeLegacyDirectoryFrame, decodeLegacyPluginBytes, isPluginRawUnsupported } from './pluginBinary';
import type { PluginFileSaveResult, PluginSaveFileOptions } from '../types';

export interface TextFileDialogOptions {
  title?: string;
  defaultFileName?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
}

export interface ReplaySourceDescriptor { sourceId: string; name: string; path: string; size: number; fingerprint: string }
export interface ReplayPickedSources { grantId: string; sources: ReplaySourceDescriptor[] }
export interface ReplaySourceChunk { base64: string; nextOffset: number; done: boolean }

/** 插件经系统对话框选中的目录能力；具体读/写/导出能力每次另按权限校验。 */
export interface PickedPluginDirectory { grantId: string; name: string; path: string }
export type PluginDirectoryEntryKind = 'file' | 'directory' | 'other';
export interface PluginDirectoryEntry {
  name: string;
  rel: string;
  kind: PluginDirectoryEntryKind;
  size: number;
  modifiedMs: number;
}
/** Rust 以 base64 承载文件字节（Tauri 命令的 JSON wire）。 */
export interface PluginDirectoryFile { path: string; base64: string }
export interface PluginDirectoryWriteResult { path: string; bytesWritten: number }

export const fileService = {
  pickReplaySources: (): Promise<ReplayPickedSources | null> => invoke('pick_replay_sources'),
  readReplaySourceChunk: (grantId: string, sourceId: string, offset: number): Promise<ReplaySourceChunk> => invoke('read_replay_source_chunk', { grantId, sourceId, offset }),
  releaseReplaySources: (grantId: string): Promise<void> => invoke('release_replay_sources', { grantId }),
  /** 宿主原生 save 对话框 + 写入；前端不提供路径。取消返回 null。 */
  pickTextFileAndWrite: (content: string, options: TextFileDialogOptions): Promise<string | null> => {
    return invoke<string | null>('pick_text_file_and_write', { content, options });
  },

  /** 宿主原生 open 对话框 + 读取；前端不提供路径。取消返回 null。 */
  pickTextFileAndRead: (options: TextFileDialogOptions): Promise<string | null> => {
    return invoke<string | null>('pick_text_file_and_read', { options });
  },

  /** 读取应用日志文件回放（后端限定在配置的日志根目录内）。 */
  readTextFile: (path: string): Promise<string> => {
    return invoke<string>('read_text_file', { path });
  },
  /** 后端显示文件选择器并只读取本次选中的文件；不接受前端提供的路径。 */
  pickPluginFiles: (pluginId: string, options: {
    multiple: boolean;
    filters?: Array<{ name: string; extensions: string[] }>;
    title?: string;
  }): Promise<{ files: Array<{ path: string; base64: string }> }> => {
    return invoke('plugin_pick_files', { pluginId, options });
  },

  /** 后端显示目录选择器并授予访问；取消返回空数组。 */
  pickPluginDirectory: (pluginId: string, options: { title?: string; multiple?: boolean }): Promise<PickedPluginDirectory[]> => {
    return invoke('plugin_pick_directory', { pluginId, options });
  },

  /** 列出已授权目录（或其中 relPath 子目录）的条目；recursive 默认 false。 */
  listPluginDirectory: (pluginId: string, grantId: string, relPath?: string, recursive?: boolean): Promise<PluginDirectoryEntry[]> => {
    return invoke('plugin_list_directory', { pluginId, grantId, relPath, recursive });
  },

  /** 读取已授权目录内的单个文件；字节以 base64 返回。 */
  readPluginDirectoryFile: (pluginId: string, grantId: string, relPath: string): Promise<PluginDirectoryFile> => {
    return invoke('plugin_read_directory_file', { pluginId, grantId, relPath });
  },

  /** Same whole-file result as the legacy API, with raw bytes on capable IPC. */
  async readPluginDirectoryBytes(pluginId: string, grantId: string, relPath: string): Promise<{ path: string; bytes: Uint8Array }> {
    try {
      return decodeLegacyDirectoryFrame(await invoke<unknown>('plugin_read_directory_file_raw', { pluginId, grantId, relPath }));
    } catch (error) {
      if (!isPluginRawUnsupported(error)) throw error;
      const legacy = await invoke<PluginDirectoryFile>('plugin_read_directory_file', { pluginId, grantId, relPath });
      return { path: legacy.path, bytes: decodeLegacyPluginBytes(legacy.base64) };
    }
  },

  /** 读取已授权目录内单个条目的元数据（含 modifiedMs）。 */
  statPluginDirectoryEntry: (pluginId: string, grantId: string, relPath: string): Promise<PluginDirectoryEntry> => {
    return invoke('plugin_stat_directory_entry', { pluginId, grantId, relPath });
  },

  /**
   * 写入已授权目录内的文件：content（UTF-8 文本，可为空串）与 base64
   * （二进制字节）恰有一个非 undefined；mode 默认 overwrite，
   * createParents 默认 true。
   */
  writePluginDirectoryFile: (pluginId: string, grantId: string, relPath: string, content: string | undefined, base64: string | undefined, mode?: 'overwrite' | 'append', createParents?: boolean): Promise<PluginDirectoryWriteResult> => {
    return invoke('plugin_write_directory_file', { pluginId, grantId, relPath, content, base64, mode, createParents });
  },

  /** fs:export-dir: create/overwrite a relative export, creating parents as needed. */
  exportPluginFile: (pluginId: string, grantId: string, relPath: string, content: string | undefined, base64: string | undefined): Promise<PluginFileSaveResult> => {
    return invoke('plugin_export_file', { pluginId, grantId, relPath, content, base64 });
  },

  /** fs:save: every call uses native Save As; no destination path crosses this API. */
  savePluginFile: (pluginId: string, content: string | undefined, base64: string | undefined, options: PluginSaveFileOptions): Promise<PluginFileSaveResult | null> => {
    return invoke('plugin_save_file', { pluginId, content, base64, options });
  },

  /** 在已授权目录内创建目录；recursive 默认 true。 */
  createPluginDirectory: (pluginId: string, grantId: string, relPath: string, recursive?: boolean): Promise<void> => {
    return invoke('plugin_create_directory', { pluginId, grantId, relPath, recursive });
  },

  /** 移除已授权目录内的条目；recursive 默认 false。 */
  removePluginDirectoryEntry: (pluginId: string, grantId: string, relPath: string, recursive?: boolean): Promise<void> => {
    return invoke('plugin_remove_directory_entry', { pluginId, grantId, relPath, recursive });
  },

  /** 重命名已授权目录内的条目；目标必须不存在。 */
  renamePluginDirectoryEntry: (pluginId: string, grantId: string, fromRel: string, toRel: string): Promise<void> => {
    return invoke('plugin_rename_directory_entry', { pluginId, grantId, fromRel, toRel });
  },

  /** 释放一次目录授权（清理，不再访问磁盘）。 */
  releasePluginDirectory: (pluginId: string, grantId: string): Promise<void> => {
    return invoke('plugin_release_directory', { pluginId, grantId });
  },

  /** 读取图片文件为 base64 data URL（自定义背景图，issue #13）。失败/非图片 → ''。 */
  readImageDataUrl: (path: string): Promise<string> => {
    return invoke<string>('read_image_data_url', { path });
  },
};
