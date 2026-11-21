/**
 * X-Track Chrome 扩展 - 工具类型定义
 *
 * 此文件定义了通用工具类型和辅助类型
 */

/**
 * 可选类型（所有属性可选）
 */
export type Partial<T> = {
  [P in keyof T]?: T[P]
}

/**
 * 必需类型（所有属性必需）
 */
export type Required<T> = {
  [P in keyof T]-?: T[P]
}

/**
 * 只读类型
 */
export type Readonly<T> = {
  readonly [P in keyof T]: T[P]
}

/**
 * 提取某些属性
 */
export type Pick<T, K extends keyof T> = {
  [P in K]: T[P]
}

/**
 * 排除某些属性
 */
export type Omit<T, K extends keyof T> = Pick<T, Exclude<keyof T, K>>

/**
 * 函数类型
 */
export type Fn<Args extends unknown[] = unknown[], Result = unknown> = (...args: Args) => Result

/**
 * 异步函数类型
 */
export type AsyncFn<Args extends unknown[] = unknown[], Result = unknown> = (
  ...args: Args
) => Promise<Result>

/**
 * 可能的类型
 */
export type Maybe<T> = T | null | undefined

/**
 * 值或Promise
 */
export type ValueOrPromise<T> = T | Promise<T>

/**
 * 键值对
 */
export type KeyValuePair<K extends string | number, V> = {
  key: K
  value: V
}

/**
 * 记录（键值对集合）
 */
export type Record<K extends string | number, V> = {
  [key in K]: V
}

/**
 * 元组
 */
export type Tuple<T, N extends number> = N extends N
  ? number extends N
    ? T[]
    : _TupleOf<T, N, []>
  : never

type _TupleOf<T, N extends number, R extends unknown[]> = R['length'] extends N
  ? R
  : _TupleOf<T, N, [...R, T]>

/**
 * 事件监听器
 */
export type EventListener<T = unknown> = (event: T) => void

/**
 * 事件监听器集合
 */
export type EventListeners<T = unknown> = Set<EventListener<T>>

/**
 * 事件发射器接口
 */
export interface EventEmitter<T = unknown> {
  on(event: string, listener: EventListener<T>): void
  off(event: string, listener: EventListener<T>): void
  emit(event: string, data: T): void
  once(event: string, listener: EventListener<T>): void
}

/**
 * Promise状态
 */
export type PromiseState = 'pending' | 'fulfilled' | 'rejected'

/**
 * 延迟Promise
 */
export interface DeferredPromise<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

/**
 * 重试配置
 */
export interface RetryConfig {
  /** 最大重试次数 */
  maxRetries: number
  /** 初始延迟（毫秒） */
  initialDelay: number
  /** 最大延迟（毫秒） */
  maxDelay: number
  /** 退避倍数 */
  backoffMultiplier: number
  /** 是否抖动 */
  jitter: boolean
}

/**
 * 节流配置
 */
export interface ThrottleConfig {
  /** 等待时间（毫秒） */
  wait: number
  /** 是否在开始时调用 */
  leading?: boolean
  /** 是否在结束时调用 */
  trailing?: boolean
}

/**
 * 防抖配置
 */
export interface DebounceConfig {
  /** 等待时间（毫秒） */
  wait: number
  /** 是否在开始时调用 */
  leading?: boolean
  /** 最大等待时间（毫秒） */
  maxWait?: number
}

/**
 * 缓存配置
 */
export interface CacheConfig<K = unknown, V = unknown> {
  /** 最大条目数 */
  maxSize?: number
  /** 过期时间（毫秒） */
  ttl?: number
  /** 键序列化函数 */
  keySerializer?: (key: K) => string
  /** 值序列化函数 */
  valueSerializer?: (value: V) => unknown
  /** 值反序列化函数 */
  valueDeserializer?: (value: unknown) => V
}

/**
 * 缓存条目
 */
export interface CacheEntry<V> {
  /** 缓存的值 */
  value: V
  /** 过期时间戳 */
  expiresAt: number
  /** 访问次数 */
  hits: number
  /** 最后访问时间 */
  lastAccess: number
}

/**
 * 观察器配置
 */
export interface ObserverConfig {
  /** 根边距 */
  rootMargin?: string
  /** 可见性阈值 */
  threshold?: number | number[]
  /** 根元素 */
  root?: Element | null
}

/**
 * 观察器条目
 */
export interface ObserverEntry {
  /** 目标元素 */
  target: Element
  /** 是否相交 */
  isIntersecting: boolean
  /** 相交比例 */
  intersectionRatio: number
  /** 相交矩形 */
  intersectionRect: DOMRectReadOnly
  /** 根边界矩形 */
  rootBounds: DOMRectReadOnly | null
  /** 目标边界矩形 */
  boundingClientRect: DOMRectReadOnly
  /** 时间戳 */
  time: number
}

/**
 * DOM 选择器配置
 */
export interface SelectorConfig {
  /** 选择器 */
  selector: string
  /** 父元素 */
  parent?: Element | Document
  /** 等待时间（毫秒） */
  timeout?: number
  /** 轮询间隔（毫秒） */
  interval?: number
}

/**
 * 性能指标
 */
export interface PerformanceMetrics {
  /** 操作名称 */
  name: string
  /** 开始时间 */
  startTime: number
  /** 结束时间 */
  endTime: number
  /** 持续时间（毫秒） */
  duration: number
  /** 内存使用（字节） */
  memoryUsed?: number
  /** 自定义数据 */
  data?: Record<string, unknown>
}

/**
 * 日志级别
 */
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4
}

/**
 * 日志条目
 */
export interface LogEntry {
  /** 时间戳 */
  timestamp: number
  /** 级别 */
  level: LogLevel
  /** 标签 */
  tag?: string
  /** 消息 */
  message: string
  /** 附加数据 */
  data?: unknown
  /** 错误对象 */
  error?: Error
}

/**
 * 验证结果
 */
export interface ValidationResult {
  /** 是否有效 */
  valid: boolean
  /** 错误信息 */
  errors: string[]
  /** 警告信息 */
  warnings: string[]
}

/**
 * 验证规则
 */
export interface ValidationRule<T = unknown> {
  /** 规则名称 */
  name: string
  /** 验证函数 */
  validate: (value: T) => boolean
  /** 错误消息 */
  message: string
}

/**
 * 模式匹配结果
 */
export interface PatternMatchResult {
  /** 是否匹配 */
  matches: boolean
  /** 捕获组 */
  groups: Record<string, string>
  /** 索引 */
  index: number
}

/**
 * URL 解析结果
 */
export interface UrlParseResult {
  /** 协议 */
  protocol: string
  /** 主机名 */
  hostname: string
  /** 端口 */
  port?: string
  /** 路径 */
  pathname: string
  /** 查询参数 */
  search: string
  /** 哈希 */
  hash: string
  /** 完整URL */
  href: string
}

/**
 * Twitter/X URL 类型
 */
export enum TwitterUrlType {
  HOME = 'home',
  PROFILE = 'profile',
  TWEET = 'tweet',
  BOOKMARKS = 'bookmarks',
  LIKES = 'likes',
  LIST = 'list',
  SEARCH = 'search',
  NOTIFICATION = 'notification',
  MESSAGES = 'messages',
  SETTINGS = 'settings',
  UNKNOWN = 'unknown'
}

/**
 * Twitter URL 解析结果
 */
export interface TwitterUrlParseResult {
  /** URL类型 */
  type: TwitterUrlType
  /** 用户名（profile页面） */
  screenName?: string
  /** 推文ID（tweet详情页） */
  tweetId?: string
  /** 列表ID */
  listId?: string
  /** 搜索查询 */
  searchQuery?: string
  /** 标签页 */
  tab?: string
}

/**
 * 浏览器存储类型
 */
export enum StorageType {
  LOCAL = 'local',
  SYNC = 'sync',
  SESSION = 'session'
}

/**
 * 浏览器存储项
 */
export interface StorageItem<T = unknown> {
  /** 键 */
  key: string
  /** 值 */
  value: T
  /** 过期时间戳（可选） */
  expiresAt?: number
}
