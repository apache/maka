/**
 * 应用主入口文件
 *
 * 初始化流程:
 * 1. 初始化 API 客户端
 * 2. 初始化用户状态
 * 3. 初始化配置
 * 4. 初始化壁纸
 * 5. 初始化天气
 * 6. 挂载应用
 */

import { createApp } from 'vue'
import { initApiClient } from './api'
import { generateFingerprint } from './utils/fingerprint'
import { useUser } from './composables/useUser'
import { useConfig } from './composables/useConfig'
import { useWallpaper } from './composables/useWallpaper'
import { useWeather } from './composables/useWeather'
import App from './app.vue'

// ==================== 版本信息 ====================

/**
 * 扩展版本号
 */
export const VERSION = '1.0.0'

/**
 * API 版本号
 */
export const API_VERSION = '1.6.36'

// ==================== 初始化函数 ====================

/**
 * 获取 Token
 */
async function getToken(): Promise<string | null> {
  return localStorage.getItem('token') || null
}

/**
 * 获取设备指纹签名
 */
let cachedFingerprint: string | null = null

async function getSignature(): Promise<string> {
  if (cachedFingerprint) {
    return cachedFingerprint
  }

  try {
    cachedFingerprint = await generateFingerprint()
    return cachedFingerprint
  } catch (error) {
    console.error('生成设备指纹失败:', error)
    return 'unknown'
  }
}

// ==================== 应用初始化 ====================

/**
 * 初始化应用
 */
async function initApp() {
  console.log('[iTab] 正在初始化应用...')

  // 1. 初始化 API 客户端
  console.log('[iTab] 初始化 API 客户端...')
  initApiClient(getToken, getSignature, API_VERSION)

  // 2. 初始化用户状态
  console.log('[iTab] 初始化用户状态...')
  const { initUser } = useUser()
  await initUser()

  // 3. 初始化配置
  console.log('[iTab] 初始化配置...')
  const { initConfig } = useConfig()
  await initConfig()

  // 4. 初始化壁纸
  console.log('[iTab] 初始化壁纸...')
  const { initWallpaper } = useWallpaper()
  await initWallpaper()

  // 5. 初始化天气
  console.log('[iTab] 初始化天气...')
  const { initWeather } = useWeather()
  await initWeather().catch(() => {
    console.warn('[iTab] 天气初始化失败')
  })

  console.log('[iTab] 应用初始化完成')
}

/**
 * 启动应用
 */
async function startApp() {
  try {
    await initApp()

    // 创建 Vue 应用并挂载
    const app = createApp(App)

    // 导入全局样式
    await import('./styles/global.css')
    await import('./styles/components.css')

    app.mount('#app')

    console.log('[iTab] 应用已启动')
  } catch (error) {
    console.error('[iTab] 应用启动失败:', error)
  }
}

// ==================== 错误处理 ====================

/**
 * 全局错误处理
 */
window.addEventListener('error', (event) => {
  console.error('[iTab] 全局错误:', event.error)
})

/**
 * 未处理的 Promise 错误
 */
window.addEventListener('unhandledrejection', (event) => {
  console.error('[iTab] 未处理的 Promise 错误:', event.reason)
})

// ==================== 启动 ====================

// DOM 加载完成后启动
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startApp)
} else {
  startApp()
}

// ==================== 导出 ====================

export { initApp, startApp }
