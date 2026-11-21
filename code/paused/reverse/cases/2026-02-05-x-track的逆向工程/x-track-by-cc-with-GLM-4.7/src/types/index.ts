/**
 * X-Track Chrome 扩展 - 核心类型定义
 *
 * 此文件包含扩展中使用的核心数据结构类型定义
 */

/**
 * 推文类型枚举
 */
export enum TweetType {
  ORIGINAL = 'ORIGINAL',
  RETWEET = 'RETWEET',
  QUOTE = 'QUOTE',
  REPLY = 'REPLY',
  ARTICLE = 'ARTICLE'
}

/**
 * 媒体项类型
 */
export enum MediaType {
  PHOTO = 'photo',
  VIDEO = 'video',
  GIF = 'gif',
  UNKNOWN = 'unknown'
}

/**
 * 媒体项接口
 */
export interface MediaItem {
  type: MediaType
  url: string
  thumbnailUrl?: string
  width?: number
  height?: number
  altText?: string
}

/**
 * 推文统计数据
 */
export interface TweetStats {
  likes: number
  retweets: number
  replies: number
  views: number
}

/**
 * 用户基本信息
 */
export interface User {
  id: string
  screenName: string
  name: string
  avatarUrl?: string
  verified?: boolean
  followerCount?: number
  followingCount?: number
  tweetCount?: number
  createdAt?: string
}

/**
 * 转发来源信息
 */
export interface RetweetSource {
  id: string
  author: User
  content: string
  createdAt: string
}

/**
 * 引用推文信息
 */
export interface QuotedTweet {
  id: string
  author: User
  content: string
  createdAt: string
  media?: MediaItem[]
}

/**
 * 推文接口
 */
export interface Tweet {
  /** 推文唯一ID */
  id: string
  /** 作者用户ID */
  authorId: string
  /** 作者完整信息（可选） */
  author?: User
  /** 推文文本内容 */
  content: string
  /** 创建时间（ISO 8601） */
  createdAt: string
  /** 统计数据 */
  stats: TweetStats
  /** 推文类型 */
  tweetType: TweetType
  /** 转发来源（如果是转推） */
  retweetedFrom?: RetweetSource
  /** 引用推文（如果是引用推文） */
  quotedTweet?: QuotedTweet
  /** 媒体内容 */
  media?: MediaItem[]
  /** 回复的推文ID（如果是回复） */
  inReplyToTweetId?: string
  /** 回复的用户ID（如果是回复） */
  inReplyToUserId?: string
  /** 语言代码 */
  lang?: string
  /** 话题标签 */
  hashtags?: string[]
  /** 提及的用户 */
  mentions?: string[]
  /** URL链接 */
  urls?: string[]
}

/**
 * 浏览历史条目类型
 */
export enum HistoryType {
  TIMELINE = 'timeline',
  PROFILE = 'profile',
  BOOKMARKS = 'bookmarks',
  LIKES = 'likes',
  TWEET_DETAIL = 'tweet_detail',
  SEARCH = 'search'
}

/**
 * 浏览历史记录
 */
export interface HistoryEntry {
  /** 推文ID */
  tweetId: string
  /** 浏览时间戳 */
  viewedAt: string
  /** 浏览时长（秒） */
  durationSeconds: number
  /** 浏览类型 */
  type: HistoryType
  /** 页面URL */
  pageUrl?: string
}

/**
 * 书签条目
 */
export interface Bookmark {
  /** 推文ID */
  tweetId: string
  /** 添加时间 */
  addedAt: string
  /** 用户标签 */
  tags?: string[]
  /** 是否已同步 */
  synced?: boolean
  /** 备注 */
  notes?: string
}

/**
 * 点赞条目
 */
export interface Like {
  /** 推文ID */
  tweetId: string
  /** 点赞时间 */
  addedAt: string
  /** 是否已同步 */
  synced?: boolean
}

/**
 * 用户自己的推文
 */
export interface MyTweet {
  /** 推文ID */
  id: string
  /** 创建时间 */
  createdAt: string
  /** 是否已同步 */
  synced?: boolean
}

/**
 * 网络拦截数据
 */
export interface InterceptedData {
  /** 请求URL */
  url: string
  /** 响应数据 */
  data: unknown
  /** 拦截时间戳 */
  timestamp: number
  /** 请求方法 */
  method?: string
}

/**
 * 抓取配置
 */
export interface ScrapingConfig {
  /** 是否启用自动抓取 */
  enabled: boolean
  /** 抓取延迟（毫秒） */
  delayMs: number
  /** 每次抓取数量 */
  batchSize: number
  /** 最大抓取时长（毫秒） */
  maxDuration: number
  /** 是否启用人类化行为 */
  humanizeBehavior: boolean
}

/**
 * 浏览追踪配置
 */
export interface TrackingConfig {
  /** 浏览阈值（毫秒） */
  dwellThreshold: number
  /** 可见性阈值（百分比） */
  visibilityThreshold: number
  /** 观察边距（像素） */
  rootMargin: string
}

/**
 * 扩展配置
 */
export interface ExtensionConfig {
  /** 抓取配置 */
  scraping: ScrapingConfig
  /** 浏览追踪配置 */
  tracking: TrackingConfig
  /** 是否启用调试模式 */
  debugMode: boolean
  /** 数据保留天数 */
  dataRetentionDays: number
  /** 是否启用AI分析 */
  aiEnabled: boolean
}

/**
 * 数据导出格式
 */
export enum ExportFormat {
  JSON = 'json',
  CSV = 'csv',
  EXCEL = 'excel'
}

/**
 * 导出选项
 */
export interface ExportOptions {
  /** 导出格式 */
  format: ExportFormat
  /** 是否包含用户信息 */
  includeUserInfo: boolean
  /** 是否包含浏览历史 */
  includeHistory: boolean
  /** 是否包含媒体信息 */
  includeMedia: boolean
  /** 时间范围过滤 */
  dateRange?: {
    start: string
    end: string
  }
}

/**
 * AI分析结果
 */
export interface AIAnalysis {
  /** 推文ID */
  tweetId: string
  /** 分析时间 */
  analyzedAt: string
  /** 情感分析 */
  sentiment?: {
    score: number
    label: 'positive' | 'neutral' | 'negative'
  }
  /** 主题分类 */
  topics?: string[]
  /** 关键词提取 */
  keywords?: string[]
  /** 摘要 */
  summary?: string
  /** 语言检测 */
  language?: string
}

/**
 * 统计数据
 */
export interface Statistics {
  /** 总推文数 */
  totalTweets: number
  /** 总用户数 */
  totalUsers: number
  /** 总浏览时长（秒） */
  totalViewTime: number
  /** 最活跃作者 */
  topAuthors: Array<{
    userId: string
    screenName: string
    tweetCount: number
  }>
  /** 最常浏览的推文 */
  mostViewed: Array<{
    tweetId: string
    viewCount: number
    totalDuration: number
  }>
}

/**
 * 数据存储状态
 */
export interface StorageStats {
  /** 推文数量 */
  tweetCount: number
  /** 用户数量 */
  userCount: number
  /** 历史记录数量 */
  historyCount: number
  /** 书签数量 */
  bookmarkCount: number
  /** 点赞数量 */
  likeCount: number
  /** 存储使用情况（字节） */
  storageUsed: number
  /** 最后更新时间 */
  lastUpdated: string
}
