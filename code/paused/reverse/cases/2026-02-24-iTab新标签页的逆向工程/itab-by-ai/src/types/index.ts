/**
 * iTab 新标签页 - 核心类型定义
 * 基于 v1.6.36 逆向工程分析
 */

// ==================== 壁纸类型 ====================

/**
 * 壁纸类型枚举
 */
export enum WallpaperType {
  BuiltIn = 0,      // 内置壁纸
  Image = 1,        // 图片壁纸
  Video = 2,        // 视频壁纸
  Color = 3,        // 纯色背景
  Unsplash = 4      // Unsplash 壁纸
}

/**
 * 壁纸配置
 */
export interface Wallpaper {
  type: WallpaperType
  src: string           // 图片/视频 URL
  thumb?: string        // 缩略图 (视频壁纸)
  mask?: number         // 遮罩透明度 (0-1)
  blur?: number         // 模糊程度
  switchBtn?: boolean   // 是否显示切换按钮
}

/**
 * 壁纸分类
 */
export interface WallpaperCategory {
  id: string
  name: string
  cover?: string
  count?: number
}

/**
 * 壁纸列表项
 */
export interface WallpaperItem {
  id: string
  src: string
  thumb?: string
  category?: string
  like?: number
}

// ==================== 图标类型 ====================

/**
 * 图标尺寸
 */
export type IconSize = '1x1' | '1x2' | '2x1' | '2x2' | '2x4' | 'small' | 'medium'

/**
 * 图标类型
 */
export type IconType = 'icon' | 'folder' | 'text' | 'component'

/**
 * 图标项
 */
export interface IconItem {
  id: string
  name: string
  url?: string
  type: IconType
  src?: string                // 图标 URL
  iconText?: string           // 文字图标内容
  backgroundColor?: string
  size?: IconSize
  children?: IconItem[]       // 文件夹子项
  component?: string          // 组件名称 (app-xxx)
  config?: Record<string, any> // 组件配置
  insetType?: 'iframe' | 'component'
}

// ==================== 导航组类型 ====================

/**
 * 导航组
 */
export interface NavGroup {
  id: string
  name: string
  children: IconItem[]
}

// ==================== 搜索引擎类型 ====================

/**
 * 搜索引擎配置
 */
export interface SearchEngine {
  key: string          // 搜索引擎标识 (baidu, google, etc.)
  title: string        // 显示名称
  href: string         // 搜索 URL
  icon?: string        // 图标 URL
}

// ==================== 天气类型 ====================

/**
 * 天气时刻
 */
export type WeatherMoment = 'd' | 'n'  // 白天/夜晚

/**
 * 位置信息
 */
export interface WeatherLocation {
  id: string           // 城市 ID
  name: string         // 城市名称
  adm1: string         // 一级行政区
  adm2: string         // 二级行政区
  country: string      // 国家
  ip?: string          // IP 地址
  location?: string    // 经纬度
  isAuto?: boolean     // 是否自动定位
}

/**
 * 当前天气
 */
export interface WeatherNow {
  temp: string         // 温度
  text: string         // 天气描述
  icon: string         // 图标
  humidity: string     // 湿度
  windDir: string      // 风向
  windScale: string    // 风力
}

/**
 * 天气预报
 */
export interface WeatherForecast {
  fxDate: string       // 日期
  tempMax: string      // 最高温度
  tempMin: string      // 最低温度
  textDay: string      // 白天天气
  textNight: string    // 夜间天气
  iconDay: string      // 白天图标
  iconNight: string    // 夜间图标
}

/**
 * 日出日落
 */
export interface SunInfo {
  rise: string         // 日出时间
  set: string          // 日落时间
}

/**
 * 空气质量
 */
export interface AirQuality {
  aqi: string          // AQI 指数
  category: string     // 空气质量等级
}

/**
 * 完整天气数据
 */
export interface WeatherData {
  now: WeatherNow
  location: WeatherLocation
  daily_forecast?: WeatherForecast[]
  moment?: WeatherMoment
  sun?: SunInfo
  air_now_city?: AirQuality
  updateTime?: number
}

// ==================== 用户类型 ====================

/**
 * 用户信息
 */
export interface UserInfo {
  id: string
  phone?: string
  email?: string
  openid?: string
  avatar?: string
  nickname?: string
  createTime?: string
}

/**
 * 登录响应
 */
export interface LoginResponse {
  code: number
  msg?: string
  data?: {
    token: string
    userInfo: UserInfo
  }
}

// ==================== 配置类型 ====================

/**
 * 时间配置
 */
export interface TimeConfig {
  show: boolean
  hour24: boolean
  sec: boolean
  size: string
  font: string
  fontWeight: string
  color?: string
}

/**
 * 搜索配置
 */
export interface SearchConfig {
  show: boolean
  default?: string
}

/**
 * 布局配置
 */
export interface LayoutConfig {
  view: 'widget' | 'simple'
  yiyan: boolean
}

/**
 * 图标配置
 */
export interface IconConfig {
  show: boolean
  showAddIcon: boolean
}

/**
 * 壁纸配置
 */
export interface WallpaperConfig {
  type: WallpaperType
  src: string
  thumb?: string
  mask: number
  blur: number
  switchBtn: boolean
}

/**
 * 基础配置
 */
export interface BaseConfig {
  time: TimeConfig
  search: SearchConfig
  layout: LayoutConfig
  icon: IconConfig
  wallpaper: WallpaperConfig
}

/**
 * 导航配置
 */
export interface NavConfig {
  navGroups: NavGroup[]
}

/**
 * 完整配置
 */
export interface AppConfig extends BaseConfig {
  navConfig: NavConfig
}

// ==================== API 响应类型 ====================

/**
 * 通用 API 响应
 */
export interface ApiResponse<T = any> {
  code: number
  msg?: string
  data?: T
}

/**
 * 分页响应
 */
export interface PaginatedResponse<T> extends ApiResponse {
  data?: {
    list: T[]
    total: number
    page: number
    pageSize: number
  }
}

// ==================== 一言类型 ====================

/**
 * 一言数据
 */
export interface YiyanData {
  hitokoto: string    // 一言内容
  from: string        // 出处
}

// ==================== 存储类型 ====================

/**
 * 存储 TTL 数据
 */
export interface StorageItem<T> {
  exp: number         // 过期时间戳
  data: T            // 实际数据
}

/**
 * LocalForage 配置
 */
export interface LocalForageConfig {
  name: string
  storeName: string
  driver: ('asyncStorage' | 'webSQLStorage' | 'localStorageWrapper')[]
}
