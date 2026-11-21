/**
 * IndexedDB 封装 (带 TTL)
 * 基于 indexdb-DBTHFlgI.js 逆向分析
 */

import localforage from 'localforage'
import dayjs from 'dayjs'

// ==================== 类型定义 ====================

/**
 * 带 TTL 的存储项
 */
interface StorageItem<T> {
  exp: number    // 过期时间戳
  data: T        // 实际数据
}

/**
 * 存储项详细信息
 */
interface StorageItemDetail<T> {
  data: T
  isExp: boolean  // 是否已过期
}

// ==================== IndexedDB 封装 ====================

/**
 * IndexedDB 封装类
 *
 * 功能:
 * - 支持设置过期时间 (TTL)
 * - 自动清理过期数据
 * - 兼容 localforage API
 */
class IndexedDBWrapper {
  private localforage: LocalForage

  constructor() {
    this.localforage = localforage.createInstance({
      name: 'itab-storage',
      storeName: 'keyvaluepairs'
    })
  }

  /**
   * 设置键值 (带 TTL)
   * @param key 键名
   * @param value 值
   * @param ttl 过期时间 (毫秒), 不传则永不过期
   */
  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    if (ttl) {
      const item: StorageItem<T> = {
        exp: dayjs().valueOf() + ttl,
        data: value
      }
      await this.localforage.setItem(key, item)
    } else {
      await this.localforage.setItem(key, value)
    }
  }

  /**
   * 获取值
   * @param key 键名
   * @param checkExp 是否检查过期 (默认 true)
   */
  async get<T>(key: string, checkExp: boolean = true): Promise<T | null> {
    const item = await this.localforage.getItem<StorageItem<T> | T>(key)

    // 没有 exp 字段，直接返回
    if (!item || typeof item !== 'object' || !('exp' in item)) {
      return (item as T) ?? null
    }

    // 有 exp 字段
    if (item.exp && checkExp) {
      // 已过期
      if (dayjs().valueOf() > item.exp) {
        await this.localforage.removeItem(key)
        return null
      }
      return item.data
    }

    // 不检查过期，返回数据
    return item.data
  }

  /**
   * 获取值及其详细信息
   * @param key 键名
   */
  async getItem<T>(key: string): Promise<StorageItemDetail<T>> {
    const item = await this.localforage.getItem<StorageItem<T>>()

    if (!item) {
      return { data: null as any, isExp: true }
    }

    if (item.exp) {
      return {
        data: item.data,
        isExp: dayjs().valueOf() > item.exp
      }
    }

    return {
      data: item.data as any,
      isExp: true
    }
  }

  /**
   * 删除值
   */
  async removeItem(key: string): Promise<void> {
    await this.localforage.removeItem(key)
  }

  /**
   * 获取所有键名
   */
  async keys(): Promise<string[]> {
    return await this.localforage.keys()
  }

  /**
   * 清空所有数据
   */
  async clear(): Promise<void> {
    await this.localforage.clear()
  }

  /**
   * 获取数据数量
   */
  async length(): Promise<number> {
    return await this.localforage.length()
  }

  /**
   * 遍历所有数据
   */
  async iterate<T>(
    callback: (value: T, key: string, iterationNumber: number) => void | boolean
  ): Promise<void> {
    await this.localforage.iterate(callback)
  }
}

// ==================== 默认导出 ====================

const indexdb = new IndexedDBWrapper()

export default indexdb
export { IndexedDBWrapper }
export type { StorageItem, StorageItemDetail }
