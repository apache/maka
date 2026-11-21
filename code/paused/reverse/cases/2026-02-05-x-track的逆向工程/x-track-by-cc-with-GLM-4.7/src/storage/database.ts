/**
 * X-Track Storage - IndexedDB 数据库模块
 *
 * 使用 Dexie.js 封装的 IndexedDB 操作
 */

import Dexie, { Table } from 'dexie'
import type { StoredTweet, StoredUser, StoredHistoryEntry, StoredBookmark, StoredLike, StoredMyTweet } from '../types/storage'

/**
 * X-Track 数据库类
 */
export class XTrackDatabase extends Dexie {
  // 表定义
  tweets!: Table<StoredTweet, string>
  users!: Table<StoredUser, string>
  history!: Table<StoredHistoryEntry, number>
  bookmarks!: Table<StoredBookmark, string>
  likes!: Table<StoredLike, string>
  myTweets!: Table<StoredMyTweet, string>

  constructor() {
    super('xtrack_db')

    // 定义数据库版本和表结构
    this.version(1).stores({
      // 推文表
      tweets: 'id, authorId, createdAt, storedAt, tweetType',

      // 用户表
      users: 'id, screenName, storedAt',

      // 浏览历史表（使用自增键）
      history: '++id, tweetId, viewedAt, type',

      // 书签表
      bookmarks: 'tweetId, addedAt',

      // 点赞表
      likes: 'tweetId, addedAt',

      // 用户推文表
      myTweets: 'id, createdAt'
    })
  }
}

/**
 * 数据库实例（单例）
 */
export const db = new XTrackDatabase()

/**
 * 初始化数据库
 */
export async function initDatabase(): Promise<void> {
  try {
    await db.open()
    console.log('X-Track: Database opened successfully')
  } catch (error) {
    console.error('X-Track: Failed to open database:', error)
    throw error
  }
}

/**
 * 关闭数据库
 */
export async function closeDatabase(): Promise<void> {
  await db.close()
  console.log('X-Track: Database closed')
}

/**
 * 清空所有表
 */
export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) {
      await table.clear()
    }
  })
  console.log('X-Track: All tables cleared')
}

/**
 * 获取数据库统计
 */
export async function getDatabaseStats(): Promise<{
  tweets: number
  users: number
  history: number
  bookmarks: number
  likes: number
  myTweets: number
}> {
  const [tweets, users, history, bookmarks, likes, myTweets] = await Promise.all([
    db.tweets.count(),
    db.users.count(),
    db.history.count(),
    db.bookmarks.count(),
    db.likes.count(),
    db.myTweets.count()
  ])

  return { tweets, users, history, bookmarks, likes, myTweets }
}

/**
 * 删除数据库
 */
export async function deleteDatabase(): Promise<void> {
  await db.delete()
  console.log('X-Track: Database deleted')
}

// 导出表实例的直接引用（便于使用）
export const tweets = db.tweets
export const users = db.users
export const history = db.history
export const bookmarks = db.bookmarks
export const likes = db.likes
export const myTweets = db.myTweets
