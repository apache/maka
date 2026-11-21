/**
 * File Watch Service
 * 负责监听文件系统变更
 * 基于 PRD-00 决策：Node 后端 + 500ms 去抖
 */

/**
 * 文件变更事件类型
 */
export type FileChangeType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir'

/**
 * 文件变更事件
 */
export interface FileChangeEvent {
  /** 变更类型 */
  readonly type: FileChangeType

  /** 变更文件/目录路径 */
  readonly path: string

  /** 事件时间戳 */
  readonly timestamp: Date
}

/**
 * 文件监听器选项
 */
export interface FileWatcherOptions {
  /** 去抖时间（毫秒），默认 500ms */
  readonly debounceMs?: number

  /** 是否忽略初始扫描事件 */
  readonly ignoreInitial?: boolean
}

/**
 * 文件监听器状态
 */
export type FileWatcherStatus =
  | 'idle'
  | 'watching'
  | 'error'
  | 'degraded' // 降级模式（轮询）

/**
 * 文件监听器接口
 * 用于抽象监听实现，便于测试和多运行时支持
 */
export interface IFileWatcher {
  /** 当前状态 */
  readonly status: FileWatcherStatus

  /** 开始监听 */
  start(): Promise<void>

  /** 停止监听 */
  stop(): Promise<void>

  /** 注册变更回调 */
  onChange(callback: (events: readonly FileChangeEvent[]) => void): () => void

  /** 注册错误回调 */
  onError(callback: (error: Error) => void): () => void
}

/**
 * 默认去抖时间（毫秒）
 */
export const DEFAULT_DEBOUNCE_MS = 500

/**
 * 默认监听目录（相对于 FS_ROOT）
 */
export const DEFAULT_WATCH_DIRS = ['.ggbdpq/actions', '.kiro/specs'] as const

/**
 * 去抖函数
 * @param fn 要去抖的函数
 * @param delayMs 延迟时间（毫秒）
 * @returns 去抖后的函数和取消函数
 */
export function createDebouncer<T extends (...args: Parameters<T>) => void>(
  fn: T,
  delayMs: number
): { debounced: T; cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const debounced = ((...args: Parameters<T>) => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
    }
    timeoutId = setTimeout(() => {
      timeoutId = null
      fn(...args)
    }, delayMs)
  }) as T

  const cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
  }

  return { debounced, cancel }
}

/**
 * 事件累积器
 * 在去抖期间累积事件，去抖结束后批量处理
 */
export class EventAccumulator {
  private events: FileChangeEvent[] = []
  private readonly debouncer: ReturnType<typeof createDebouncer<() => void>>
  private readonly callback: (events: readonly FileChangeEvent[]) => void

  constructor(
    callback: (events: readonly FileChangeEvent[]) => void,
    debounceMs: number = DEFAULT_DEBOUNCE_MS
  ) {
    this.callback = callback
    this.debouncer = createDebouncer(() => this.flush(), debounceMs)
  }

  /**
   * 添加事件
   */
  push(event: FileChangeEvent): void {
    this.events.push(event)
    this.debouncer.debounced()
  }

  /**
   * 立即刷新（取消去抖）
   */
  flush(): void {
    if (this.events.length > 0) {
      const events = [...this.events]
      this.events = []
      this.callback(events)
    }
  }

  /**
   * 取消待处理的去抖
   */
  cancel(): void {
    this.debouncer.cancel()
    this.events = []
  }

  /**
   * 获取当前累积的事件数量
   */
  get pendingCount(): number {
    return this.events.length
  }
}

/**
 * Mock 文件监听器（用于测试）
 */
export class MockFileWatcher implements IFileWatcher {
  private _status: FileWatcherStatus = 'idle'
  private changeCallbacks: Set<(events: readonly FileChangeEvent[]) => void> = new Set()
  private errorCallbacks: Set<(error: Error) => void> = new Set()
  private accumulator: EventAccumulator | null = null

  constructor(private readonly options: FileWatcherOptions = {}) {}

  get status(): FileWatcherStatus {
    return this._status
  }

  async start(): Promise<void> {
    this._status = 'watching'
    this.accumulator = new EventAccumulator(
      (events) => {
        for (const cb of this.changeCallbacks) {
          cb(events)
        }
      },
      this.options.debounceMs ?? DEFAULT_DEBOUNCE_MS
    )
  }

  async stop(): Promise<void> {
    this._status = 'idle'
    this.accumulator?.cancel()
    this.accumulator = null
  }

  onChange(callback: (events: readonly FileChangeEvent[]) => void): () => void {
    this.changeCallbacks.add(callback)
    return () => {
      this.changeCallbacks.delete(callback)
    }
  }

  onError(callback: (error: Error) => void): () => void {
    this.errorCallbacks.add(callback)
    return () => {
      this.errorCallbacks.delete(callback)
    }
  }

  /**
   * 模拟文件变更事件
   */
  simulateChange(event: FileChangeEvent): void {
    if (this._status !== 'watching') {
      return
    }
    this.accumulator?.push(event)
  }

  /**
   * 模拟错误
   */
  simulateError(error: Error): void {
    this._status = 'error'
    for (const cb of this.errorCallbacks) {
      cb(error)
    }
  }

  /**
   * 立即刷新累积的事件
   */
  flushEvents(): void {
    this.accumulator?.flush()
  }
}

/**
 * 检查路径是否在监听范围内
 */
export function isPathInWatchScope(
  path: string,
  watchDirs: readonly string[] = DEFAULT_WATCH_DIRS
): boolean {
  const normalizedPath = path.replace(/\\/g, '/')
  return watchDirs.some(
    (dir) => normalizedPath.startsWith(dir + '/') || normalizedPath === dir
  )
}

/**
 * 创建文件变更事件
 */
export function createFileChangeEvent(
  type: FileChangeType,
  path: string
): FileChangeEvent {
  return {
    type,
    path,
    timestamp: new Date(),
  }
}
