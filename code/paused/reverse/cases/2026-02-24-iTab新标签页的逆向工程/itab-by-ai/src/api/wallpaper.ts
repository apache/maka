/**
 * 壁纸 API
 * 基于 wallpaper-tfepPeaw.js 逆向分析
 */

import { getApiClient } from './baseRequest'
import type {
  WallpaperCategoryResponse,
  WallpaperListResponse,
  RandomWallpaperResponse,
  UnsplashCategoryResponse,
  VideoWallpaperResponse
} from '../types/api'

/**
 * 壁纸 API 参数
 */
export interface WallpaperCategoryParams {
  category?: string
  page?: number
}

export interface WallpaperListParams {
  category: string
  page?: number
  pageSize?: number
}

export interface RandomWallpaperParams {
  category?: string
}

export interface UnsplashParams {
  page?: number
}

export interface VideoWallpaperParams {
  page?: number
}

export interface LikeWallpaperParams {
  id: string
}

// ==================== 壁纸 API ====================

/**
 * 获取壁纸分类
 */
export async function getWallpaperCategory(
  params?: WallpaperCategoryParams
): Promise<WallpaperCategoryResponse> {
  const client = getApiClient()
  return client.get('/wallpaper/category', { params })
}

/**
 * 获取壁纸列表
 */
export async function getWallpaperList(
  params: WallpaperListParams
): Promise<WallpaperListResponse> {
  const client = getApiClient()
  return client.get('/wallpaper/list', { params })
}

/**
 * 记录壁纸使用
 */
export async function recordWallpaperUse(id: string): Promise<any> {
  const client = getApiClient()
  return client.get('/wallpaper/use', { params: { id } })
}

/**
 * 获取随机壁纸
 */
export async function getRandomWallpaper(
  params?: RandomWallpaperParams
): Promise<RandomWallpaperResponse> {
  const client = getApiClient()
  return client.get('/wallpaper/random', { params })
}

/**
 * 获取 Unsplash 壁纸
 */
export async function getUnsplashWallpaper(
  params?: UnsplashParams
): Promise<WallpaperListResponse> {
  const client = getApiClient()
  return client.get('/wallpaper/unsplash', { params })
}

/**
 * 获取 Unsplash 分类
 */
export async function getUnsplashCategory(): Promise<UnsplashCategoryResponse> {
  const client = getApiClient()
  return client.get('/wallpaper/unsplash/category')
}

/**
 * 获取视频壁纸列表
 */
export async function getVideoWallpaperList(
  params?: VideoWallpaperParams
): Promise<VideoWallpaperResponse> {
  const client = getApiClient()
  return client.get('/wallpaper/video/list', { params })
}

/**
 * 点赞壁纸
 */
export async function likeWallpaper(params: LikeWallpaperParams): Promise<any> {
  const client = getApiClient()
  return client.get('/wallpaper/like', { params })
}

/**
 * 获取 Wallhaven 分类
 */
export async function getWallhavenCategory(): Promise<WallpaperCategoryResponse> {
  const client = getApiClient()
  return client.get('/wallhaven/category')
}

// ==================== 导出 ====================

export const wallpaperApi = {
  getWallpaperCategory,
  getWallpaperList,
  recordWallpaperUse,
  getRandomWallpaper,
  getUnsplashWallpaper,
  getUnsplashCategory,
  getVideoWallpaperList,
  likeWallpaper,
  getWallhavenCategory
}
