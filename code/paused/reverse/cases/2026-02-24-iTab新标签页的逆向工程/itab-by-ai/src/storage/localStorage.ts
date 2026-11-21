/**
 * LocalStorage 封装
 * 提供类型安全的 LocalStorage 操作
 */

import type { LocalStorageKey, LocalStorageValues } from '../types/storage'

// ==================== LocalStorage 封装 ====================

/**
 * LocalStorage 工具类
 */
class LocalStorageWrapper {
  /**
   * 设置值
   */
  set<K extends LocalStorageKey>(key: K, value: LocalStorageValues[K]): void {
    if (value === undefined) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, String(value))
    }
  }

  /**
   * 获取值
   */
  get<K extends LocalStorageKey>(
    key: K,
    parse = true
  ): LocalStorageValues[K] | null {
    const value = localStorage.getItem(key)
    if (value === null) return null

    if (!parse) return value as LocalStorageValues[K]

    try {
      return JSON.parse(value) as LocalStorageValues[K]
    } catch {
      return value as LocalStorageValues[K]
    }
  }

  /**
   * 删除值
   */
  remove(key: LocalStorageKey): void {
    localStorage.removeItem(key)
  }

  /**
   * 清空所有值
   */
  clear(): void {
    localStorage.clear()
  }

  /**
   * 检查键是否存在
   */
  has(key: LocalStorageKey): boolean {
    return localStorage.getItem(key) !== null
  }
}

// ==================== 默认导出 ====================

const localStorage = new LocalStorageWrapper()

export default localStorage
export { LocalStorageWrapper }
