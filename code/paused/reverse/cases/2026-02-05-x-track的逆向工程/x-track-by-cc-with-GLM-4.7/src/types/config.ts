/**
 * X-Track Chrome 扩展 - 配置类型定义
 *
 * 此文件定义了扩展配置相关的类型
 */

/**
 * 抓取模式
 */
export enum ScrapingMode {
  /** 手动模式 - 用户主动触发 */
  MANUAL = 'manual',
  /** 自动模式 - 自动滚动抓取 */
  AUTO = 'auto'
}

/**
 * 滚动方向
 */
export enum ScrollDirection {
  DOWN = 'down',
  UP = 'up'
}

/**
 * 抓取状态
 */
export enum ScrapingStatus {
  /** 空闲 */
  IDLE = 'idle',
  /** 运行中 */
  RUNNING = 'running',
  /** 暂停 */
  PAUSED = 'paused',
  /** 已停止 */
  STOPPED = 'stopped',
  /** 已完成 */
  COMPLETED = 'completed',
  /** 出错 */
  ERROR = 'error'
}

/**
 * 抓取进度信息
 */
export interface ScrapingProgress {
  /** 当前状态 */
  status: ScrapingStatus
  /** 已抓取数量 */
  scrapedCount: number
  /** 开始时间 */
  startTime?: number
  /** 当前页面URL */
  currentUrl?: string
  /** 错误信息 */
  error?: string
}

/**
 * 手动抓取配置
 */
export interface ManualScrapingConfig {
  /** 扫描间隔（毫秒） */
  scanInterval: number
  /** 每次扫描最大数量 */
  maxPerScan: number
  /** 是否显示通知 */
  showNotification: boolean
}

/**
 * 自动抓取配置
 */
export interface AutoScrapingConfig {
  /** 滚动延迟范围（毫秒） */
  scrollDelayRange: {
    min: number
    max: number
  }
  /** 反向滚动概率（0-1） */
  reverseScrollProbability: number
  /** 反向滚动距离范围（像素） */
  reverseScrollDistance: {
    min: number
    max: number
  }
  /** 最大抓取时长（毫秒） */
  maxDuration: number
  /** 每批抓取数量 */
  batchSize: number
  /** 批次间延迟（毫秒） */
  batchDelay: number
}

/**
 * 浏览追踪配置
 */
export interface TrackingConfig {
  /** 浏览阈值（毫秒） */
  dwellThreshold: number
  /** 可见性阈值（百分比 0-100） */
  visibilityThreshold: number
  /** 根边距（CSS margin语法） */
  rootMargin: string
  /** 是否追踪鼠标悬停 */
  trackHover: boolean
  /** 是否追踪点击 */
  trackClicks: boolean
}

/**
 * 数据存储配置
 */
export interface StorageConfig {
  /** 数据保留天数（0表示永久） */
  retentionDays: number
  /** 最大存储条目数 */
  maxEntries?: number
  /** 是否压缩存储 */
  compressData: boolean
  /** 自动清理频率（小时） */
  autoCleanupInterval: number
}

/**
 * UI 配置
 */
export interface UIConfig {
  /** 是否显示浮动按钮 */
  showFloatingButton: boolean
  /** 浮动按钮位置 */
  floatingButtonPosition: {
    bottom: string
    right: string
  }
  /** 主题 */
  theme: 'light' | 'dark' | 'auto'
  /** 语言 */
  language: string
  /** 是否显示通知 */
  showNotifications: boolean
  /** 通知持续时间（毫秒） */
  notificationDuration: number
}

/**
 * AI 配置
 */
export interface AIConfig {
  /** 是否启用 */
  enabled: boolean
  /** 默认提供商 */
  provider: 'openai' | 'gemini' | 'claude'
  /** API密钥 */
  apiKey?: string
  /** 分析频率 */
  analysisFrequency: 'realtime' | 'batch' | 'manual'
  /** 批处理大小 */
  batchSize: number
  /** 模型配置 */
  modelConfig: {
    openai?: {
      model: string
      temperature: number
      maxTokens: number
    }
    gemini?: {
      model: string
      temperature: number
      maxTokens: number
    }
    claude?: {
      model: string
      temperature: number
      maxTokens: number
    }
  }
}

/**
 * 导出配置
 */
export interface ExportConfig {
  /** 默认格式 */
  defaultFormat: 'json' | 'csv' | 'excel'
  /** 是否包含元数据 */
  includeMetadata: boolean
  /** 日期格式 */
  dateFormat: string
  /** 是否压缩导出文件 */
  compressOutput: boolean
}

/**
 * 调试配置
 */
export interface DebugConfig {
  /** 是否启用调试模式 */
  enabled: boolean
  /** 日志级别 */
  logLevel: 'error' | 'warn' | 'info' | 'debug'
  /** 是否记录网络请求 */
  logNetworkRequests: boolean
  /** 是否记录数据存储 */
  logStorage: boolean
  /** 是否显示性能指标 */
  showPerformanceMetrics: boolean
}

/**
 * 扩展配置
 */
export interface ExtensionConfig {
  /** 抓取模式 */
  scrapingMode: ScrapingMode
  /** 手动抓取配置 */
  manualScraping: ManualScrapingConfig
  /** 自动抓取配置 */
  autoScraping: AutoScrapingConfig
  /** 浏览追踪配置 */
  tracking: TrackingConfig
  /** 数据存储配置 */
  storage: StorageConfig
  /** UI配置 */
  ui: UIConfig
  /** AI配置 */
  ai: AIConfig
  /** 导出配置 */
  export: ExportConfig
  /** 调试配置 */
  debug: DebugConfig
}

/**
 * 默认配置
 */
export const DEFAULT_CONFIG: ExtensionConfig = {
  scrapingMode: ScrapingMode.MANUAL,
  manualScraping: {
    scanInterval: 2000,
    maxPerScan: 50,
    showNotification: true
  },
  autoScraping: {
    scrollDelayRange: {
      min: 1000,
      max: 2500
    },
    reverseScrollProbability: 0.05,
    reverseScrollDistance: {
      min: 50,
      max: 200
    },
    maxDuration: 300000, // 5分钟
    batchSize: 20,
    batchDelay: 1000
  },
  tracking: {
    dwellThreshold: 1000,
    visibilityThreshold: 10,
    rootMargin: '100px',
    trackHover: true,
    trackClicks: true
  },
  storage: {
    retentionDays: 0, // 永久保留
    compressData: false,
    autoCleanupInterval: 24
  },
  ui: {
    showFloatingButton: true,
    floatingButtonPosition: {
      bottom: '20px',
      right: '20px'
    },
    theme: 'auto',
    language: 'en',
    showNotifications: true,
    notificationDuration: 3000
  },
  ai: {
    enabled: false,
    provider: 'openai',
    analysisFrequency: 'manual',
    batchSize: 10,
    modelConfig: {}
  },
  export: {
    defaultFormat: 'json',
    includeMetadata: true,
    dateFormat: 'ISO',
    compressOutput: false
  },
  debug: {
    enabled: false,
    logLevel: 'info',
    logNetworkRequests: false,
    logStorage: false,
    showPerformanceMetrics: false
  }
}

/**
 * 配置键类型
 */
export type ConfigKey = keyof ExtensionConfig

/**
 * 配置更新
 */
export interface ConfigUpdate {
  /** 配置键 */
  key: ConfigKey | string
  /** 新值 */
  value: unknown
}

/**
 * 配置变更事件
 */
export interface ConfigChangeEvent {
  /** 更改的键 */
  key: ConfigKey | string
  /** 旧值 */
  oldValue: unknown
  /** 新值 */
  newValue: unknown
}
