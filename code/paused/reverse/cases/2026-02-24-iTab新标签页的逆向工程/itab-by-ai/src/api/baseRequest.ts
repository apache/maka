/**
 * API 基础请求配置
 * 基于 baseRequest-cLAYUkE1.js 逆向分析
 */

import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios'
import type { ApiResponse } from '../types'

// ==================== 常量配置 ====================

/**
 * API 基础 URL
 */
export const API_BASE_URL = 'https://api.codelife.cc'

/**
 * 请求超时时间
 */
export const API_TIMEOUT = 15000

/**
 * 请求头配置
 */
export interface ApiHeaders {
  signaturekey: string    // 设备指纹签名
  version: string         // 扩展版本号
  mode: 'itab'            // 固定值
  token?: string          // 用户 token (可选)
  lang?: 'cn' | 'en'      // 语言 (仅 GET 请求)
}

// ==================== 请求拦截器 ====================

/**
 * 创建请求拦截器
 *
 * 功能:
 * 1. 添加 token 到请求头
 * 2. 添加设备指纹签名
 * 3. 添加版本信息
 * 4. GET 请求添加语言参数
 */
async function createRequestInterceptor(
  getToken: () => Promise<string | null>,
  getSignature: () => Promise<string>,
  version: string
) {
  return async (config: AxiosRequestConfig) => {
    const token = await getToken()
    const signature = await getSignature()

    // 设置请求头
    config.headers = {
      ...config.headers,
      signaturekey: signature,
      version: version,
      mode: 'itab',
      ...(token && { token })
    }

    // GET 请求添加语言参数
    if (config.method === 'get') {
      config.params = {
        lang: 'cn',
        ...config.params
      }
    }

    return config
  }
}

// ==================== 响应拦截器 ====================

/**
 * 创建响应拦截器
 *
 * 功能:
 * 1. 处理 401 未响应 - 跳转登录
 * 2. 处理 500/501/413 错误 - 显示错误消息
 * 3. 返回响应数据
 */
function createResponseInterceptor() {
  return (response: any) => {
    const data = response.data

    // 401 未授权
    if (data.code === 401) {
      // TODO: 跳转登录页
      return Promise.reject(data.msg)
    }

    // 服务器错误
    if (data.code === 500 || data.code === 501 || data.code === 413) {
      // TODO: 显示错误消息
      return Promise.reject(data.msg)
    }

    return data
  }
}

// ==================== API 客户端 ====================

/**
 * 创建 API 客户端实例
 */
export function createApiClient(config: {
  getToken: () => Promise<string | null>
  getSignature: () => Promise<string>
  version: string
  baseURL?: string
  timeout?: number
}): AxiosInstance {
  const client = axios.create({
    baseURL: config.baseURL || API_BASE_URL,
    timeout: config.timeout || API_TIMEOUT
  })

  // 请求拦截器
  client.interceptors.request.use(
    createRequestInterceptor(config.getToken, config.getSignature, config.version),
    (error) => Promise.reject(error)
  )

  // 响应拦截器
  client.interceptors.response.use(
    createResponseInterceptor(),
    (error) => Promise.reject(error)
  )

  return client
}

// ==================== 默认导出 ====================

/**
 * 默认 API 客户端
 * 使用前需要配置 getSignature 和 getVersion
 */
let apiClient: AxiosInstance | null = null

export function initApiClient(
  getToken: () => Promise<string | null>,
  getSignature: () => Promise<string>,
  version: string
) {
  apiClient = createApiClient({
    getToken,
    getSignature,
    version
  })
  return apiClient
}

export function getApiClient(): AxiosInstance {
  if (!apiClient) {
    throw new Error('API client not initialized. Call initApiClient first.')
  }
  return apiClient
}
