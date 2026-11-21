/**
 * X-Track Chrome 扩展 - 消息通信类型定义
 *
 * 此文件定义了扩展各部分之间的消息通信类型
 */

import type { Tweet, HistoryEntry, StorageStats } from './index'

/**
 * 消息类型枚举
 */
export enum MessageType {
  // 保存推文
  SAVE_TWEET = 'SAVE_TWEET',
  SAVE_TWEETS = 'SAVE_TWEETS',
  // 获取推文
  GET_TWEET = 'GET_TWEET',
  GET_TWEETS = 'GET_TWEETS',
  // 保存用户
  SAVE_USER = 'SAVE_USER',
  SAVE_USERS = 'SAVE_USERS',
  // 浏览历史
  SAVE_HISTORY = 'SAVE_HISTORY',
  GET_HISTORY = 'GET_HISTORY',
  // 书签
  SAVE_BOOKMARK = 'SAVE_BOOKMARK',
  REMOVE_BOOKMARK = 'REMOVE_BOOKMARK',
  GET_BOOKMARKS = 'GET_BOOKMARKS',
  // 点赞
  SAVE_LIKE = 'SAVE_LIKE',
  REMOVE_LIKE = 'REMOVE_LIKE',
  GET_LIKES = 'GET_LIKES',
  // 用户推文
  SAVE_MY_TWEET = 'SAVE_MY_TWEET',
  GET_MY_TWEETS = 'GET_MY_TWEETS',
  // 统计
  GET_STATS = 'GET_STATS',
  // 导出
  EXPORT_DATA = 'EXPORT_DATA',
  // 配置
  GET_CONFIG = 'GET_CONFIG',
  UPDATE_CONFIG = 'UPDATE_CONFIG',
  // 清理
  CLEAR_DATA = 'CLEAR_DATA',
  // AI分析
  ANALYZE_TWEET = 'ANALYZE_TWEET',
  // 同步
  SYNC_DATA = 'SYNC_DATA'
}

/**
 * 保存推文消息
 */
export interface SaveTweetMessage {
  type: MessageType.SAVE_TWEET
  payload: Tweet
}

/**
 * 批量保存推文消息
 */
export interface SaveTweetsMessage {
  type: MessageType.SAVE_TWEETS
  payload: {
    tweets: Tweet[]
  }
}

/**
 * 获取推文消息
 */
export interface GetTweetMessage {
  type: MessageType.GET_TWEET
  payload: {
    tweetId: string
  }
}

/**
 * 获取多条推文消息
 */
export interface GetTweetsMessage {
  type: MessageType.GET_TWEETS
  payload: {
    tweetIds: string[]
  }
}

/**
 * 保存用户消息
 */
export interface SaveUserMessage {
  type: MessageType.SAVE_USER
  payload: {
    user: {
      id: string
      screenName: string
      name: string
      avatarUrl?: string
    }
  }
}

/**
 * 批量保存用户消息
 */
export interface SaveUsersMessage {
  type: MessageType.SAVE_USERS
  payload: {
    users: Array<{
      id: string
      screenName: string
      name: string
      avatarUrl?: string
    }>
  }
}

/**
 * 保存浏览历史消息
 */
export interface SaveHistoryMessage {
  type: MessageType.SAVE_HISTORY
  payload: HistoryEntry
}

/**
 * 获取浏览历史消息
 */
export interface GetHistoryMessage {
  type: MessageType.GET_HISTORY
  payload: {
    limit?: number
    offset?: number
  }
}

/**
 * 保存书签消息
 */
export interface SaveBookmarkMessage {
  type: MessageType.SAVE_BOOKMARK
  payload: {
    tweetId: string
    tags?: string[]
  }
}

/**
 * 移除书签消息
 */
export interface RemoveBookmarkMessage {
  type: MessageType.REMOVE_BOOKMARK
  payload: {
    tweetId: string
  }
}

/**
 * 获取书签消息
 */
export interface GetBookmarksMessage {
  type: MessageType.GET_BOOKMARKS
  payload?: {
    limit?: number
    offset?: number
  }
}

/**
 * 保存点赞消息
 */
export interface SaveLikeMessage {
  type: MessageType.SAVE_LIKE
  payload: {
    tweetId: string
  }
}

/**
 * 移除点赞消息
 */
export interface RemoveLikeMessage {
  type: MessageType.REMOVE_LIKE
  payload: {
    tweetId: string
  }
}

/**
 * 获取点赞消息
 */
export interface GetLikesMessage {
  type: MessageType.GET_LIKES
  payload?: {
    limit?: number
    offset?: number
  }
}

/**
 * 保存用户推文消息
 */
export interface SaveMyTweetMessage {
  type: MessageType.SAVE_MY_TWEET
  payload: {
    tweetId: string
    createdAt: string
  }
}

/**
 * 获取用户推文消息
 */
export interface GetMyTweetsMessage {
  type: MessageType.GET_MY_TWEETS
  payload?: {
    limit?: number
    offset?: number
  }
}

/**
 * 获取统计消息
 */
export interface GetStatsMessage {
  type: MessageType.GET_STATS
  payload?: {
    includeHistory?: boolean
  }
}

/**
 * 导出数据消息
 */
export interface ExportDataMessage {
  type: MessageType.EXPORT_DATA
  payload: {
    format: 'json' | 'csv'
    includeHistory?: boolean
  }
}

/**
 * 获取配置消息
 */
export interface GetConfigMessage {
  type: MessageType.GET_CONFIG
}

/**
 * 更新配置消息
 */
export interface UpdateConfigMessage {
  type: MessageType.UPDATE_CONFIG
  payload: {
    [key: string]: unknown
  }
}

/**
 * 清理数据消息
 */
export interface ClearDataMessage {
  type: MessageType.CLEAR_DATA
  payload?: {
    tables?: string[]
    beforeDate?: string
  }
}

/**
 * AI分析推文消息
 */
export interface AnalyzeTweetMessage {
  type: MessageType.ANALYZE_TWEET
  payload: {
    tweetId: string
    provider?: 'openai' | 'gemini' | 'claude'
  }
}

/**
 * 同步数据消息
 */
export interface SyncDataMessage {
  type: MessageType.SYNC_DATA
  payload?: {
    forceSync?: boolean
  }
}

/**
 * 消息联合类型
 */
export type Message =
  | SaveTweetMessage
  | SaveTweetsMessage
  | GetTweetMessage
  | GetTweetsMessage
  | SaveUserMessage
  | SaveUsersMessage
  | SaveHistoryMessage
  | GetHistoryMessage
  | SaveBookmarkMessage
  | RemoveBookmarkMessage
  | GetBookmarksMessage
  | SaveLikeMessage
  | RemoveLikeMessage
  | GetLikesMessage
  | SaveMyTweetMessage
  | GetMyTweetsMessage
  | GetStatsMessage
  | ExportDataMessage
  | GetConfigMessage
  | UpdateConfigMessage
  | ClearDataMessage
  | AnalyzeTweetMessage
  | SyncDataMessage

/**
 * 消息响应
 */
export interface MessageResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

/**
 * 统计数据响应
 */
export interface StatsResponse {
  tweets: number
  users: number
  history: number
  bookmarks: number
  likes: number
  myTweets: number
}

/**
 * 推文响应
 */
export interface TweetResponse {
  tweet?: Tweet
  exists: boolean
}

/**
 * 推文列表响应
 */
export interface TweetsResponse {
  tweets: Tweet[]
  total: number
}

/**
 * 浏览历史响应
 */
export interface HistoryResponse {
  history: HistoryEntry[]
  total: number
}

/**
 * 书签列表响应
 */
export interface BookmarksResponse {
  bookmarks: Array<{
    tweetId: string
    addedAt: string
    tags?: string[]
    tweet?: Tweet
  }>
  total: number
}

/**
 * 点赞列表响应
 */
export interface LikesResponse {
  likes: Array<{
    tweetId: string
    addedAt: string
    tweet?: Tweet
  }>
  total: number
}

/**
 * 用户推文列表响应
 */
export interface MyTweetsResponse {
  tweets: Array<{
    id: string
    createdAt: string
    tweet?: Tweet
  }>
  total: number
}

/**
 * 配置响应
 */
export interface ConfigResponse {
  scraping: {
    enabled: boolean
    delayMs: number
    batchSize: number
    maxDuration: number
  }
  tracking: {
    dwellThreshold: number
    visibilityThreshold: number
  }
  debugMode: boolean
  dataRetentionDays: number
  aiEnabled: boolean
}

/**
 * 导出响应
 */
export interface ExportResponse {
  data?: string
  filename: string
  mimeType: string
}

/**
 * AI分析响应
 */
export interface AnalysisResponse {
  tweetId: string
  sentiment?: {
    score: number
    label: 'positive' | 'neutral' | 'negative'
  }
  topics?: string[]
  keywords?: string[]
  summary?: string
}

/**
 * 同步响应
 */
export interface SyncResponse {
  synced: {
    tweets: number
    users: number
    history: number
    bookmarks: number
    likes: number
    myTweets: number
  }
  errors: string[]
}
