/**
 * API 相关类型定义
 */

import type {
  ApiResponse,
  PaginatedResponse,
  WallpaperCategory,
  WallpaperItem,
  WeatherData,
  YiyanData,
  UserInfo,
  AppConfig
} from './index'

// ==================== 壁纸 API ====================

/**
 * 壁纸分类响应
 */
export type WallpaperCategoryResponse = ApiResponse<WallpaperCategory[]>

/**
 * 壁纸列表响应
 */
export type WallpaperListResponse = PaginatedResponse<WallpaperItem>

/**
 * 随机壁纸响应
 */
export type RandomWallpaperResponse = ApiResponse<{
  src: string
  thumb?: string
}>

/**
 * Unsplash 分类响应
 */
export type UnsplashCategoryResponse = ApiResponse<Array<{
  id: string
  title: string
  cover?: string
}>>

/**
 * 视频壁纸响应
 */
export type VideoWallpaperResponse = PaginatedResponse<{
  id: string
  src: string
  thumb: string
  title?: string
}>

// ==================== 天气 API ====================

/**
 * 天气 API 响应 (和风天气格式)
 */
export interface QWeatherResponse {
  code: string        // '200' 表示成功
  status?: string     // 'ok'
  now?: {
    temp: string
    text: string
    icon: string
    humidity: string
    windDir: string
    windScale: string
  }
  daily?: Array<{
    fxDate: string
    tempMax: string
    tempMin: string
    textDay: string
    textNight: string
    iconDay: string
    iconNight: string
  }>
  location?: Array<{
    id: string
    name: string
    adm1: string
    adm2: string
    country: string
    ip?: string
  }>
}

/**
 * 地理位置查询响应
 */
export interface GeoLocationResponse {
  status: number
  data?: {
    id: string
    name: string
    adm1: string
    adm2: string
    country: string
    location: string
    ip: string
  }
}

// ==================== 用户 API ====================

/**
 * 登录请求参数
 */
export interface LoginRequest {
  phone?: string
  password?: string
  email?: string
  openid?: string
}

/**
 * 验证码登录请求
 */
export interface PhoneLoginRequest {
  phone: string
  code: string
}

/**
 * 发送验证码请求
 */
export interface SendCodeRequest {
  phone: string
}

/**
 * 绑定手机请求
 */
export interface BindPhoneRequest {
  phone: string
  code: string
}

/**
 * 验证密码请求
 */
export interface VerifyPasswordRequest {
  password: string
}

/**
 * 验证邮箱请求
 */
export interface VerifyEmailRequest {
  email: string
  code: string
}

/**
 * 更新用户请求
 */
export interface UpdateUserRequest {
  avatar?: string
  nickname?: string
}

/**
 * 修改密码请求
 */
export interface UpdatePasswordRequest {
  oldPass: string
  newPass: string
}

/**
 * 注册请求
 */
export interface RegistryRequest {
  phone?: string
  email?: string
  password: string
  code?: string
}

/**
 * 获取配置响应
 */
export type GetConfigResponse = ApiResponse<AppConfig>

/**
 * 更新配置请求
 */
export interface UpdateConfigRequest extends AppConfig {}

/**
 * 更新配置响应
 */
export type UpdateConfigResponse = ApiResponse

// ==================== 其他 API ====================

/**
 * 一言响应
 */
export type YiyanResponse = ApiResponse<YiyanData>

/**
 * 安装统计响应
 */
export type AnalyticsResponse = ApiResponse

/**
 * 错误上报请求
 */
export interface ErrorReportRequest {
  err: string
  info: string
}
