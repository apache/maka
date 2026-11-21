/**
 * X-Track Storage - 数据库适配器
 *
 * 提供对 IndexedDB 的高级操作接口
 */

import { db, getDatabaseStats, clearAllTables } from './database'
import type { StoredTweet, StoredUser } from '../types/storage'
import { tokenizeText, isValidTweetId, isValidScreenName } from './utils'

/**
 * 推文查询选项
 */
export interface TweetQueryOptions {
  limit?: number
  offset?: number
  authorId?: string
  tweetType?: string
  sortBy?: 'createdAt' | 'likes' | 'retweets'
  sortOrder?: 'asc' | 'desc'
  searchQuery?: string
}

/**
 * 用户查询选项
 */
export interface UserQueryOptions {
  limit?: number
  offset?: number
  searchQuery?: string
}

/**
 * 推文统计
 */
export interface TweetStats {
  total: number
  byType: Record<string, number>
  byAuthor: Record<string, number>
}

/**
 * 存储适配器类
 */
export class StorageAdapter {
  /**
   * 保存推文
   */
  async saveTweet(tweet: StoredTweet): Promise<void> {
    if (!isValidTweetId(tweet.id)) {
      throw new Error(`Invalid tweet ID: ${tweet.id}`)
    }

    tweet.storedAt = new Date().toISOString()
    tweet.updatedAt = tweet.storedAt

    await db.tweets.put(tweet)
  }

  /**
   * 批量保存推文
   */
  async saveTweets(tweets: StoredTweet[]): Promise<void> {
    const now = new Date().toISOString()
    const validTweets = tweets.filter(t => isValidTweetId(t.id))

    const tweetsWithMetadata = validTweets.map(tweet => ({
      ...tweet,
      storedAt: now,
      updatedAt: now
    }))

    await db.tweets.bulkPut(tweetsWithMetadata)
  }

  /**
   * 获取推文
   */
  async getTweet(tweetId: string): Promise<StoredTweet | undefined> {
    return db.tweets.get(tweetId)
  }

  /**
   * 查询推文
   */
  async queryTweets(options: TweetQueryOptions = {}): Promise<StoredTweet[]> {
    const {
      limit = 50,
      offset = 0,
      authorId,
      tweetType,
      sortBy = 'createdAt',
      sortOrder = 'desc',
      searchQuery
    } = options

    let collection = db.tweets.orderBy(sortBy)

    if (sortOrder === 'desc') {
      collection = collection.reverse()
    }

    if (authorId) {
      collection = db.tweets.where('authorId').equals(authorId)
    }

    if (tweetType) {
      const filtered = await collection.filter(tweet => tweet.tweetType === tweetType)
      return filtered.offset(offset).limit(limit).toArray()
    }

    if (searchQuery) {
      const tokens = tokenizeText(searchQuery)
      const filtered = await collection.filter(tweet => {
        const tweetTokens = tweet.textTokens || []
        return tokens.some(token => tweetTokens.includes(token))
      })
      return filtered.offset(offset).limit(limit).toArray()
    }

    return collection.offset(offset).limit(limit).toArray()
  }

  /**
   * 删除推文
   */
  async deleteTweet(tweetId: string): Promise<void> {
    await db.tweets.delete(tweetId)
  }

  /**
   * 批量删除推文
   */
  async deleteTweets(tweetIds: string[]): Promise<void> {
    await db.tweets.bulkDelete(tweetIds)
  }

  /**
   * 保存用户
   */
  async saveUser(user: StoredUser): Promise<void> {
    if (!isValidScreenName(user.screenName)) {
      throw new Error(`Invalid screen name: ${user.screenName}`)
    }

    user.storedAt = new Date().toISOString()
    user.updatedAt = user.storedAt

    await db.users.put(user)
  }

  /**
   * 批量保存用户
   */
  async saveUsers(users: StoredUser[]): Promise<void> {
    const now = new Date().toISOString()
    const validUsers = users.filter(u => isValidScreenName(u.screenName))

    const usersWithMetadata = validUsers.map(user => ({
      ...user,
      storedAt: now,
      updatedAt: now
    }))

    await db.users.bulkPut(usersWithMetadata)
  }

  /**
   * 获取用户
   */
  async getUser(userId: string): Promise<StoredUser | undefined> {
    return db.users.get(userId)
  }

  /**
   * 查询用户
   */
  async queryUsers(options: UserQueryOptions = {}): Promise<StoredUser[]> {
    const { limit = 50, offset = 0, searchQuery } = options

    let collection = db.users.orderBy('storedAt').reverse()

    if (searchQuery) {
      const tokens = tokenizeText(searchQuery)
      const filtered = await collection.filter(user => {
        const userName = user.name?.toLowerCase() || ''
        const screenName = user.screenName.toLowerCase()
        return tokens.some(token => userName.includes(token) || screenName.includes(token))
      })
      return filtered.offset(offset).limit(limit).toArray()
    }

    return collection.offset(offset).limit(limit).toArray()
  }

  /**
   * 获取推文统计
   */
  async getTweetStats(): Promise<TweetStats> {
    const tweets = await db.tweets.toArray()
    const total = tweets.length

    const byType: Record<string, number> = {}
    const byAuthor: Record<string, number> = {}

    for (const tweet of tweets) {
      byType[tweet.tweetType] = (byType[tweet.tweetType] || 0) + 1
      byAuthor[tweet.authorId] = (byAuthor[tweet.authorId] || 0) + 1
    }

    return { total, byType, byAuthor }
  }

  /**
   * 获取热门作者
   */
  async getTopAuthors(limit = 10): Promise<Array<{ authorId: string; count: number; user?: StoredUser }>> {
    const stats = await this.getTweetStats()
    const sorted = Object.entries(stats.byAuthor)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit)

    const result = await Promise.all(
      sorted.map(async ([authorId, count]) => {
        const user = await this.getUser(authorId)
        return { authorId, count, user: user || undefined }
      })
    )

    return result
  }

  /**
   * 获取数据库状态
   */
  async getStats() {
    return getDatabaseStats()
  }

  /**
   * 清空所有数据
   */
  async clearAll() {
    await clearAllTables()
  }

  /**
   * 导出所有数据
   */
  async exportAll() {
    const [tweets, users, history, bookmarks, likes, myTweets] = await Promise.all([
      db.tweets.toArray(),
      db.users.toArray(),
      db.history.toArray(),
      db.bookmarks.toArray(),
      db.likes.toArray(),
      db.myTweets.toArray()
    ])

    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      tweets,
      users,
      history,
      bookmarks,
      likes,
      myTweets
    }
  }

  /**
   * 导入数据
   */
  async importAll(data: {
    tweets?: StoredTweet[]
    users?: StoredUser[]
    history?: unknown[]
    bookmarks?: unknown[]
    likes?: unknown[]
    myTweets?: unknown[]
  }) {
    await db.transaction('rw', db.tables, async () => {
      if (data.tweets?.length) {
        await db.tweets.bulkPut(data.tweets)
      }
      if (data.users?.length) {
        await db.users.bulkPut(data.users)
      }
      if (data.history?.length) {
        await db.history.bulkPut(data.history)
      }
      if (data.bookmarks?.length) {
        await db.bookmarks.bulkPut(data.bookmarks)
      }
      if (data.likes?.length) {
        await db.likes.bulkPut(data.likes)
      }
      if (data.myTweets?.length) {
        await db.myTweets.bulkPut(data.myTweets)
      }
    })
  }
}

/**
 * 全局存储适配器实例
 */
export const storageAdapter = new StorageAdapter()

// 重新导出常用函数
export { getDatabaseStats, clearAllTables }
