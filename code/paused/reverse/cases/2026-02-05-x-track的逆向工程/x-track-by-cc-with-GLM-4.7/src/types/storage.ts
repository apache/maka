/**
 * X-Track Chrome 扩展 - 存储类型定义
 *
 * 此文件定义了 IndexedDB 数据库和相关存储操作类型
 */

import type { Tweet, User, HistoryEntry, Bookmark, Like, MyTweet } from './index'

/**
 * IndexedDB 数据库版本
 */
export const DB_VERSION = 1

/**
 * 数据库名称
 */
export const DB_NAME = 'xtrack_db'

/**
 * 存储的推文（添加存储相关字段）
 */
export interface StoredTweet extends Tweet {
  /** 存储时间 */
  storedAt: string
  /** 最后更新时间 */
  updatedAt: string
  /** 数据来源 */
  source?: 'api' | 'dom' | 'import'
}

/**
 * 存储的用户信息
 */
export interface StoredUser extends User {
  /** 存储时间 */
  storedAt: string
  /** 最后更新时间 */
  updatedAt: string
  /** 最后活跃时间 */
  lastActiveAt?: string
}

/**
 * 存储的浏览历史
 */
export interface StoredHistoryEntry extends HistoryEntry {
  /** 存储时间 */
  storedAt: string
}

/**
 * 存储的书签
 */
export interface StoredBookmark extends Bookmark {
  /** 推文内容快照 */
  tweetSnapshot?: Partial<Tweet>
}

/**
 * 存储的点赞
 */
export interface StoredLike extends Like {
  /** 推文内容快照 */
  tweetSnapshot?: Partial<Tweet>
}

/**
 * 存储的用户推文
 */
export interface StoredMyTweet extends MyTweet {
  /** 推文内容快照 */
  tweetSnapshot?: Tweet
}

/**
 * 数据库表结构
 */
export interface DatabaseSchema {
  /** 推文表 */
  tweets: {
    key: string
    value: StoredTweet
    indexes: {
      authorId: string
      createdAt: string
      storedAt: string
      tweetType: string
    }
  }
  /** 用户表 */
  users: {
    key: string
    value: StoredUser
    indexes: {
      screenName: string
      storedAt: string
    }
  }
  /** 浏览历史表 */
  history: {
    key: number
    value: StoredHistoryEntry
    indexes: {
      tweetId: string
      viewedAt: string
      type: string
    }
    autoIncrement: true
  }
  /** 书签表 */
  bookmarks: {
    key: string
    value: StoredBookmark
    indexes: {
      addedAt: string
    }
  }
  /** 点赞表 */
  likes: {
    key: string
    value: StoredLike
    indexes: {
      addedAt: string
    }
  }
  /** 用户推文表 */
  myTweets: {
    key: string
    value: StoredMyTweet
    indexes: {
      createdAt: string
    }
  }
}

/**
 * 查询条件
 */
export interface QueryCondition {
  /** 字段名 */
  field: keyof StoredTweet | keyof StoredUser | keyof StoredHistoryEntry
  /** 操作符 */
  operator: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'startsWith'
  /** 值 */
  value: unknown
}

/**
 * 排序选项
 */
export interface SortOption {
  /** 排序字段 */
  field: string
  /** 排序方向 */
  order: 'asc' | 'desc'
}

/**
 * 分页选项
 */
export interface PaginationOption {
  /** 偏移量 */
  offset: number
  /** 每页数量 */
  limit: number
}

/**
 * 查询选项
 */
export interface QueryOptions {
  /** 查询条件 */
  where?: QueryCondition[]
  /** 排序选项 */
  orderBy?: SortOption[]
  /** 分页选项 */
  pagination?: PaginationOption
}

/**
 * 数据库操作结果
 */
export interface DbOperationResult<T> {
  /** 是否成功 */
  success: boolean
  /** 返回的数据 */
  data?: T
  /** 错误信息 */
  error?: string
}

/**
 * 批量操作结果
 */
export interface BatchOperationResult {
  /** 成功数量 */
  successCount: number
  /** 失败数量 */
  failCount: number
  /** 错误信息 */
  errors: Array<{
    id: string
    error: string
  }>
}

/**
 * 存储适配器接口
 */
export interface StorageAdapter<T = unknown> {
  /** 获取单条记录 */
  get(key: string): Promise<DbOperationResult<T>>
  /** 获取多条记录 */
  getMany(keys: string[]): Promise<DbOperationResult<T[]>>
  /** 添加记录 */
  add(data: T): Promise<DbOperationResult<string>>
  /** 批量添加 */
  addMany(data: T[]): Promise<BatchOperationResult>
  /** 更新记录 */
  update(key: string, data: Partial<T>): Promise<DbOperationResult<T>>
  /** 删除记录 */
  delete(key: string): Promise<DbOperationResult<boolean>>
  /** 批量删除 */
  deleteMany(keys: string[]): Promise<BatchOperationResult>
  /** 清空表 */
  clear(): Promise<DbOperationResult<boolean>>
  /** 查询记录 */
  query(options: QueryOptions): Promise<DbOperationResult<T[]>>
  /** 统计数量 */
  count(): Promise<DbOperationResult<number>>
}

/**
 * 数据库表名
 */
export enum TableName {
  TWEETS = 'tweets',
  USERS = 'users',
  HISTORY = 'history',
  BOOKMARKS = 'bookmarks',
  LIKES = 'likes',
  MY_TWEETS = 'myTweets'
}

/**
 * 索引名称
 */
export enum IndexName {
  // Tweets 索引
  TWEET_AUTHOR_ID = 'authorId',
  TWEET_CREATED_AT = 'createdAt',
  TWEET_STORED_AT = 'storedAt',
  TWEET_TYPE = 'tweetType',

  // Users 索引
  USER_SCREEN_NAME = 'screenName',
  USER_STORED_AT = 'storedAt',

  // History 索引
  HISTORY_TWEET_ID = 'tweetId',
  HISTORY_VIEWED_AT = 'viewedAt',
  HISTORY_TYPE = 'type',

  // Bookmarks 索引
  BOOKMARK_ADDED_AT = 'addedAt',

  // Likes 索引
  LIKE_ADDED_AT = 'addedAt',

  // MyTweets 索引
  MY_TWEET_CREATED_AT = 'createdAt'
}

/**
 * 数据迁移脚本
 */
export interface MigrationScript {
  /** 版本号 */
  version: number
  /** 迁移名称 */
  name: string
  /** 迁移函数 */
  migrate: (db: IDBDatabase) => Promise<void>
}

/**
 * 数据库状态
 */
export interface DatabaseStatus {
  /** 是否已初始化 */
  initialized: boolean
  /** 当前版本 */
  version: number
  /** 表统计 */
  tables: {
    [key in TableName]: {
      count: number
      size: number
    }
  }
  /** 最后同步时间 */
  lastSyncAt?: string
}

/**
 * 数据备份
 */
export interface DataBackup {
  /** 备份时间 */
  backedUpAt: string
  /** 版本 */
  version: number
  /** 推文数据 */
  tweets: StoredTweet[]
  /** 用户数据 */
  users: StoredUser[]
  /** 历史数据 */
  history: StoredHistoryEntry[]
  /** 书签数据 */
  bookmarks: StoredBookmark[]
  /** 点赞数据 */
  likes: StoredLike[]
  /** 用户推文 */
  myTweets: StoredMyTweet[]
}

/**
 * 数据清理策略
 */
export interface CleanupPolicy {
  /** 保留天数（0表示永久保留） */
  retentionDays: number
  /** 最大记录数 */
  maxRecords?: number
  /** 清理的表 */
  tables: TableName[]
}
