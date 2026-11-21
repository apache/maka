/**
 * Chrome Storage 封装
 * 用于扩展配置同步
 */

import type { ChromeStorageKey } from '../types/storage'
import type { AppConfig } from '../types'

// ==================== Chrome Storage 封装 ====================

/**
 * Chrome Storage 操作类
 */
class ChromeStorageWrapper {
  /**
   * 获取配置
   */
  async get<K extends ChromeStorageKey>(
    key: K
  ): Promise<{ [K2 in K]?: AppConfig[K2] } | null> {
    return new Promise((resolve) => {
      chrome.storage.sync.get([key], (result) => {
        resolve(result as { [K2 in K]?: AppConfig[K2] })
      })
    })
  }

  /**
   * 设置配置
   */
  async set<K extends ChromeStorageKey>(
    key: K,
    value: AppConfig[K]
  ): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.sync.set({ [key]: value }, () => {
        resolve()
      })
    })
  }

  /**
   * 删除配置
   */
  async remove(key: ChromeStorageKey): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.sync.remove(key, () => {
        resolve()
      })
    })
  }

  /**
   * 清空所有配置
   */
  async clear(): Promise<void> {
    return new Promise((resolve) => {
      chrome.storage.sync.clear(() => {
        resolve()
      })
    })
  }

  /**
   * 监听配置变化
   */
  onChanged<K extends ChromeStorageKey>(
    callback: (changes: { [key in K]?: chrome.storage.StorageChange }) => void
  ): void {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName === 'sync') {
        callback(changes)
      }
    })
  }
}

// ==================== 默认导出 ====================

const chromeStorage = new ChromeStorageWrapper()

export default chromeStorage
export { ChromeStorageWrapper }
