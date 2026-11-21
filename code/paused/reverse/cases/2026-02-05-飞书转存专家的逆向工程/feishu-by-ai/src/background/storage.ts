// src/background/storage.ts
// ========================================
// 存储管理器
// ========================================

import type { ExportHistory, FeishuDocument, ExportFormat } from '../types';
import { StorageKey } from '../types';

/**
 * 存储管理器
 */
export class StorageManager {
  /**
   * 获取配置
   */
  async getConfig(): Promise<any> {
    const result = await chrome.storage.local.get(StorageKey.CONFIG);
    return result[StorageKey.CONFIG] || this.getDefaultConfig();
  }

  /**
   * 保存配置
   */
  async saveConfig(config: any): Promise<void> {
    await chrome.storage.local.set({ [StorageKey.CONFIG]: config });
  }

  /**
   * 获取历史记录
   */
  async getHistory(limit: number = 50): Promise<ExportHistory[]> {
    const result = await chrome.storage.local.get(StorageKey.HISTORY);
    const history = result[StorageKey.HISTORY] || [];
    return history.slice(0, limit);
  }

  /**
   * 添加到历史记录
   */
  async addToHistory(entry: ExportHistory): Promise<void> {
    const result = await chrome.storage.local.get(StorageKey.HISTORY);
    const history = result[StorageKey.HISTORY] || [];

    history.unshift(entry);

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

  /**
   * 获取默认配置
   */
  private getDefaultConfig(): any {
    return {
      defaultFormat: 'pdf',
      autoDownload: true,
      showProgress: true,
      imageOptions: {
        quality: 95,
        maxWidth: 1920,
        format: 'png'
      },
      pdfOptions: {
        orientation: 'portrait',
        pageSize: 'a4',
        margin: 10
      }
    };
  }
}
