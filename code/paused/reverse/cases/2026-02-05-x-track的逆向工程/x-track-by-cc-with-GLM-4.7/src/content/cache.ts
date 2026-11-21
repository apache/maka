/**
 * X-Track Content Script - 推文缓存模块
 *
 * 负责缓存从网络拦截的推文数据，避免重复解析
 */

import type { TwitterTweet } from '../types/twitter-api'

/**
 * 缓存的推文数据
 */
export interface CachedTweet {
  /** 原始推文数据 */
  raw: TwitterTweet
  /** 缓存时间戳 */
  timestamp: number
}

/**
 * 推文缓存类
 */
export class TweetCache {
  private cache: Map<string, CachedTweet>
  private readonly maxCacheSize: number
  private readonly cacheTTL: number

  constructor(maxCacheSize: number = 1000, cacheTTL: number = 300000) {
    this.cache = new Map()
    this.maxCacheSize = maxCacheSize
    this.cacheTTL = cacheTTL
  }

  /**
   * 缓存推文
   */
  set(tweetId: string, data: CachedTweet): void {
    // 清理过期缓存
    this.cleanup()

    // 如果缓存已满，删除最旧的条目
    if (this.cache.size >= this.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value
      if (oldestKey) {
        this.cache.delete(oldestKey)
      }
    }

    this.cache.set(tweetId, data)
    console.log('X-Track: Cached tweet', tweetId)
  }

  /**
   * 获取缓存的推文
   */
  get(tweetId: string): CachedTweet | undefined {
    const cached = this.cache.get(tweetId)
    if (!cached) {
      return undefined
    }

    // 检查是否过期
    if (Date.now() - cached.timestamp > this.cacheTTL) {
      this.cache.delete(tweetId)
      return undefined
    }

    return cached
  }

  /**
   * 检查推文是否已缓存
   */
  has(tweetId: string): boolean {
    return this.get(tweetId) !== undefined
  }

  /**
   * 删除指定推文缓存
   */
  delete(tweetId: string): boolean {
    return this.cache.delete(tweetId)
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * 获取缓存大小
   */
  size(): number {
    return this.cache.size
  }

  /**
   * 清理过期缓存
   */
  private cleanup(): void {
    const now = Date.now()
    const keysToDelete: string[] = []

    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.cacheTTL) {
        keysToDelete.push(key)
      }
    }

    keysToDelete.forEach(key => this.cache.delete(key))
  }

  /**
   * 获取所有缓存的推文ID
   */
  keys(): string[] {
    return Array.from(this.cache.keys())
  }

  /**
   * 获取缓存统计
   */
  getStats(): {
    size: number
    oldest: number | null
    newest: number | null
  } {
    const timestamps = Array.from(this.cache.values()).map(v => v.timestamp)
    return {
      size: this.cache.size,
      oldest: timestamps.length > 0 ? Math.min(...timestamps) : null,
      newest: timestamps.length > 0 ? Math.max(...timestamps) : null
    }
  }
}

/**
 * 全局推文缓存实例
 */
export const tweetCache = new TweetCache()

/**
 * 缓存推文的便捷函数
 */
export function cacheTweet(tweet: TwitterTweet): void {
  if (!tweet.rest_id) return

  tweetCache.set(tweet.rest_id, {
    raw: tweet,
    timestamp: Date.now()
  })
}

/**
 * 获取缓存推文的便捷函数
 */
export function getCachedTweet(tweetId: string): CachedTweet | undefined {
  return tweetCache.get(tweetId)
}

/**
 * 检查推文是否已缓存的便捷函数
 */
export function hasCachedTweet(tweetId: string): boolean {
  return tweetCache.has(tweetId)
}
