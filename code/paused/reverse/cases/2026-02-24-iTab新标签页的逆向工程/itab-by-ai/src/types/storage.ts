/**
 * 存储相关类型定义
 */

// ==================== LocalStorage 键名 ====================

/**
 * LocalStorage 键名枚举
 */
export enum LocalStorageKey {
  Token = 'token',
  Weather = 'weather',
  WeatherDefaultCity = 'weather-default-city',
  Yiyan = 'yiyan',
  LunarDate = 'lunarDate',
  LayoutViewNotice = 'layoutViewNotice',
  AppBaiduTn = 'app-baiduTn',
  DataCleansing = 'dataCleansing'
}

// ==================== IndexedDB 键名 ====================

/**
 * IndexedDB 键名枚举
 */
export enum IndexedDBKey {
  Yiyan = 'yiyan',
  Weather = 'weather',
  WeatherDefaultCity = 'weather-default-city',
  LayoutViewNotice = 'layoutViewNotice'
}

// ==================== Chrome Storage 键名 ====================

/**
 * Chrome Storage 键名枚举
 */
export enum ChromeStorageKey {
  NavConfig = 'navConfig',
  BaseConfig = 'baseConfig'
}

// ==================== TTL 配置 ====================

/**
 * 存储 TTL 时间配置 (毫秒)
 */
export const StorageTTL = {
  Weather: 10 * 60 * 1000,           // 10 分钟
  WeatherDefaultCity: 30 * 60 * 1000, // 30 分钟
  Yiyan: 10 * 60 * 1000,              // 10 分钟
  Token: Infinity,                    // 永久
  Config: Infinity                    // 永久
} as const

// ==================== 存储值类型 ====================

/**
 * LocalStorage 值类型
 */
export interface LocalStorageValues {
  [LocalStorageKey.Token]?: string
  [LocalStorageKey.Weather]?: string        // JSON 字符串
  [LocalStorageKey.WeatherDefaultCity]?: string
  [LocalStorageKey.Yiyan]?: string
  [LocalStorageKey.LunarDate]?: string      // "MM,DD,YYYYMMDD"
  [LocalStorageKey.LayoutViewNotice]?: string
  [LocalStorageKey.AppBaiduTn]?: string
  [LocalStorageKey.DataCleansing]?: string  // "MMDD"
}
