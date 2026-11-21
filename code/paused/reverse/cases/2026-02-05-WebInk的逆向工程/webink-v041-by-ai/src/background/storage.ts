// src/background/storage.ts
// ========================================
// 存储管理器
// ========================================

import type { WebInkConfig, ExtractedContent } from '../types';

/**
 * 存储键
 */
export enum StorageKey {
  CONFIG = 'webink_config',
  CACHE = 'webink_cache',
  HISTORY = 'webink_history',
}

/**
 * 存储管理器
 */
export class StorageManager {
  /**
   * 获取配置
   */
  async getConfig(): Promise<WebInkConfig | null> {
    const result = await chrome.storage.local.get(StorageKey.CONFIG);
    return result[StorageKey.CONFIG] || null;
  }

  /**
   * 保存配置
   */
  async saveConfig(config: WebInkConfig): Promise<void> {
    await chrome.storage.local.set({ [StorageKey.CONFIG]: config });
  }

  /**
   * 获取缓存
   */
  async getCache(url: string): Promise<ExtractedContent | null> {
    const result = await chrome.storage.local.get(StorageKey.CACHE);
    const cache = result[StorageKey.CACHE] || {};
    return cache[url] || null;
  }

  /**
   * 保存缓存
   */
  async saveCache(url: string, content: ExtractedContent): Promise<void> {
    const result = await chrome.storage.local.get(StorageKey.CACHE);
    const cache = result[StorageKey.CACHE] || {};

    // 限制缓存大小（最多 100 条）
    const keys = Object.keys(cache);
    if (keys.length >= 100) {
      // 删除最旧的缓存
      delete cache[keys[0]];
    }

    cache[url] = content;
    await chrome.storage.local.set({ [StorageKey.CACHE]: cache });
  }

  /**
   * 清除缓存
   */
  async clearCache(): Promise<void> {
    await chrome.storage.local.remove(StorageKey.CACHE);
  }

  /**
   * 获取历史记录
   */
  async getHistory(limit: number = 50): Promise<ExtractedContent[]> {
    const result = await chrome.storage.local.get(StorageKey.HISTORY);
    const history = result[StorageKey.HISTORY] || [];
    return history.slice(0, limit);
  }

  /**
   * 添加到历史记录
   */
  async addToHistory(content: ExtractedContent): Promise<void> {
    const result = await chrome.storage.local.get(StorageKey.HISTORY);
    const history = result[StorageKey.HISTORY] || [];

    // 添加到开头
    history.unshift(content);

    // 限制历史记录大小（最多 500 条）
    if (history.length > 500) {
      history.pop();
    }

    await chrome.storage.local.set({ [StorageKey.HISTORY]: history });
  }

  /**
   * 清除历史记录
   */
  async clearHistory(): Promise<void> {
    await chrome.storage.local.remove(StorageKey.HISTORY);
  }

  /**
   * 清除所有数据
   */
  async clearAll(): Promise<void> {
    await chrome.storage.local.clear();
  }
}
