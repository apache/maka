// ========================================
// WebInk v0.4.9 - 存储类型定义
// ========================================

import type { Config, HistoryItem, MarkdownContent, EditorConfig } from "./index";

/** Chrome Storage Local 结构 */
export interface StorageLocal {
  /** 用户配置 */
  [StorageKey.CONFIG]?: Config;
  /** 历史记录 */
  [StorageKey.HISTORY]?: HistoryItem[];
  /** 内容缓存 */
  [StorageKey.CACHE]?: Record<string, MarkdownContent>;
  /** 编辑器状态 */
  [StorageKey.EDITOR_STATE]?: EditorConfig;
}

/** 存储键枚举 */
export enum StorageKey {
  CONFIG = "webink_config",
  HISTORY = "webink_history",
  CACHE = "webink_cache",
  EDITOR_STATE = "webink_editor_state",
}

/** 默认配置 */
export const DEFAULT_CONFIG: Config = {
  defaultTitle: "Untitled",
  maxHeadingDepth: 6,
  enableGFM: true,
  enableCodeHighlight: true,
  enableDiagram: true,
  enableEditor: false,
  translateLanguage: "en",
};

/** 存储操作工具 */
export class StorageHelper {
  /** 获取配置 */
  static async getConfig(): Promise<Config> {
    const result = await chrome.storage.local.get(StorageKey.CONFIG);
    return result[StorageKey.CONFIG] || DEFAULT_CONFIG;
  }

  /** 保存配置 */
  static async setConfig(config: Partial<Config>): Promise<void> {
    const current = await this.getConfig();
    const updated = { ...current, ...config };
    await chrome.storage.local.set({ [StorageKey.CONFIG]: updated });
  }

  /** 获取历史记录 */
  static async getHistory(): Promise<HistoryItem[]> {
    const result = await chrome.storage.local.get(StorageKey.HISTORY);
    return result[StorageKey.HISTORY] || [];
  }

  /** 添加历史记录 */
  static async addHistory(item: HistoryItem): Promise<void> {
    const history = await this.getHistory();
    const filtered = history.filter((h) => h.url !== item.url);
    filtered.unshift(item);
    // 最多保存 100 条
    const trimmed = filtered.slice(0, 100);
    await chrome.storage.local.set({ [StorageKey.HISTORY]: trimmed });
  }

  /** 删除历史记录 */
  static async deleteHistory(id: string): Promise<void> {
    const history = await this.getHistory();
    const filtered = history.filter((h) => h.id !== id);
    await chrome.storage.local.set({ [StorageKey.HISTORY]: filtered });
  }

  /** 清空历史记录 */
  static async clearHistory(): Promise<void> {
    await chrome.storage.local.set({ [StorageKey.HISTORY]: [] });
  }

  /** 获取缓存 */
  static async getCache(url: string): Promise<MarkdownContent | null> {
    const result = await chrome.storage.local.get(StorageKey.CACHE);
    const cache = result[StorageKey.CACHE] || {};
    return cache[url] || null;
  }

  /** 设置缓存 */
  static async setCache(url: string, content: MarkdownContent): Promise<void> {
    const result = await chrome.storage.local.get(StorageKey.CACHE);
    const cache = result[StorageKey.CACHE] || {};
    cache[url] = content;
    await chrome.storage.local.set({ [StorageKey.CACHE]: cache });
  }

  /** 清空缓存 */
  static async clearCache(): Promise<void> {
    await chrome.storage.local.set({ [StorageKey.CACHE]: {} });
  }
}
