/**
 * X-Track Content Script - 主入口
 *
 * 这是 X-Track Chrome 扩展的入口脚本，负责：
 * 1. 注入网络拦截脚本
 * 2. 处理拦截的数据
 * 3. 追踪用户浏览行为
 * 4. 提供智能抓取功能
 * 5. 显示浮动 UI
 */

import { processInterceptedData } from './interceptor'
import { observeTweet, finalizeTweetObservation } from './observer'
import { initFloatingUI } from './floating-ui'
import { loadScrapingConfig } from './scraping'
import type { ScrapedTweetData } from './scraper'

// ============================================================================
// 常量定义
// ============================================================================

const DWELL_THRESHOLD = 1000 // 计为"浏览"的时间阈值（毫秒）
const OBSERVED_ATTR = 'data-xtrack-observed'

// ============================================================================
// 初始化标志
// ============================================================================

let isInitialized = false
let periodicObserverInterval: ReturnType<typeof setInterval> | null = null

// ============================================================================
// 网络拦截与注入
// ============================================================================

/**
 * 注入网络拦截脚本
 */
function injectInterceptorScript(): void {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.getURL) {
    console.warn('X-Track: Chrome runtime not available')
    return
  }

  const script = document.createElement('script')
  script.src = chrome.runtime.getURL('inject.js')
  script.onload = function () {
    this.remove()
  }
  ;(document.head || document.documentElement).appendChild(script)
  console.log('X-Track: Injected network interceptor')
}

/**
 * 设置网络拦截监听器
 */
function setupNetworkInterception(): void {
  // 监听拦截的数据
  window.addEventListener('message', event => {
    if (event.source !== window || !event.data || event.data.source !== 'XTRACK_INJECT') {
      return
    }

    if (event.data.type === 'XTRACK_INTERCEPT_DATA') {
      console.log('X-Track: Received intercepted data from', event.data.url)
      processInterceptedData(event.data.data, event.data.url)
    }
  })
}

// ============================================================================
// 消息处理
// ============================================================================

/**
 * 设置消息监听器
 */
function setupMessageListener(): void {
  if (typeof chrome === 'undefined' || !chrome.runtime) {
    return
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 获取用户信息
    if (request.action === 'GET_USER_INFO') {
      const userInfo = extractUserInfo()
      sendResponse({ success: !!userInfo, user: userInfo })
      return true
    }

    // 开始手动抓取
    if (request.action === 'START_MANUAL_SCRAPE') {
      // 导入 startManualCollection 动态避免循环依赖
      import('./scraping').then(({ startManualCollection, detectPageType }) => {
        const pageType = request.pageType || detectPageType()
        if (pageType === 'UNKNOWN') {
          sendResponse({ success: false, error: 'Unknown page type' })
        } else {
          startManualCollection(pageType)
          sendResponse({ success: true, mode: 'MANUAL', pageType })
        }
      })
      return true
    }

    // 开始自动抓取
    if (request.action === 'START_AUTO_SCRAPE') {
      import('./scraping').then(({ startAutoScraping, detectPageType }) => {
        const pageType = request.pageType || detectPageType()
        if (pageType === 'UNKNOWN') {
          sendResponse({ success: false, error: 'Unknown page type' })
        } else {
          startAutoScraping(pageType, request.config)
          sendResponse({ success: true, mode: 'AUTO', pageType })
        }
      })
      return true
    }

    // 停止抓取
    if (request.action === 'STOP_SCRAPE') {
      import('./scraping').then(({ stopManualCollection, stopAutoScraping, getScrapingStatus }) => {
        const status = getScrapingStatus()
        if (status.mode === 'MANUAL') {
          stopManualCollection('User stopped')
        } else if (status.mode === 'AUTO') {
          stopAutoScraping('User stopped')
        }
        sendResponse({ success: true })
      })
      return true
    }

    // 获取抓取状态
    if (request.action === 'GET_SCRAPE_STATUS') {
      import('./scraping').then(({ getScrapingStatus }) => {
        sendResponse(getScrapingStatus())
      })
      return true
    }

    // 更新抓取配置
    if (request.action === 'UPDATE_SCRAPE_CONFIG') {
      import('./scraping').then(({ updateScrapingConfig, getScrapingConfig }) => {
        if (request.config) {
          updateScrapingConfig(request.config)
          sendResponse({ success: true, config: getScrapingConfig() })
        } else {
          sendResponse({ success: false, error: 'No config provided' })
        }
      })
      return true
    }

    // 获取抓取配置
    if (request.action === 'GET_SCRAPE_CONFIG') {
      import('./scraping').then(({ getScrapingConfig }) => {
        sendResponse({ success: true, config: getScrapingConfig() })
      })
      return true
    }

    return false
  })
}

/**
 * 从页面提取用户信息
 */
function extractUserInfo():
  | {
      screen_name: string
      name: string
      profile_image_url_https: string
    }
  | undefined {
  // 方法1: 检查侧边栏账户切换器
  const accountSwitcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')
  if (accountSwitcher) {
    const img = accountSwitcher.querySelector('img')
    const allSpans = accountSwitcher.querySelectorAll('span')
    let screenName = ''
    let displayName = ''

    for (const span of allSpans) {
      const text = span.textContent || ''
      if (text.startsWith('@')) {
        screenName = text.replace('@', '')
      } else if (text.trim() && !screenName && !text.includes('@')) {
        displayName = text.trim()
      }
    }

    if (img && screenName) {
      return {
        screen_name: screenName,
        name: displayName || img.alt || screenName,
        profile_image_url_https: img.src || ''
      }
    }
  }

  return undefined
}

// ============================================================================
// DOM 监听与初始化
// ============================================================================

/**
 * 设置定期观察器
 */
function setupPeriodicObserver(): void {
  if (periodicObserverInterval) {
    return
  }

  // 每秒检查新推文并开始观察
  periodicObserverInterval = setInterval(() => {
    const articles = document.querySelectorAll('article[data-testid="tweet"]')

    articles.forEach(article => {
      observeTweet(article)
    })
  }, 1000)
}

/**
 * 清理定期观察器
 */
function cleanupPeriodicObserver(): void {
  if (periodicObserverInterval) {
    clearInterval(periodicObserverInterval)
    periodicObserverInterval = null
  }
}

/**
 * 初始化内容脚本
 */
function initialize(): void {
  if (isInitialized) {
    console.log('X-Track: Already initialized')
    return
  }

  console.log('X-Track: Initializing content script...')

  // 1. 注入网络拦截脚本
  injectInterceptorScript()

  // 2. 设置网络拦截监听
  setupNetworkInterception()

  // 3. 设置消息监听器
  setupMessageListener()

  // 4. 设置定期观察器
  setupPeriodicObserver()

  // 5. 加载抓取配置
  loadScrapingConfig()

  // 6. 初始化浮动 UI
  initFloatingUI()

  isInitialized = true
  console.log('X-Track: Content script initialized successfully')
}

/**
 * 清理资源
 */
function cleanup(): void {
  console.log('X-Track: Cleaning up...')

  // 停止定期观察器
  cleanupPeriodicObserver()

  // 销毁浮动 UI
  import('./floating-ui').then(({ destroyFloatingUI }) => {
    destroyFloatingUI()
  })

  // 停止抓取
  import('./scraping').then(({ stopManualCollection, stopAutoScraping }) => {
    stopManualCollection('Cleanup')
    stopAutoScraping('Cleanup')
  })

  // 断开观察器
  import('./observer').then(({ disconnectObserver, clearViewingTimers }) => {
    disconnectObserver()
    clearViewingTimers()
  })

  isInitialized = false
  console.log('X-Track: Cleanup complete')
}

// ============================================================================
// 页面加载时初始化
// ============================================================================

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initialize)
} else {
  // DOM 已加载，立即初始化
  initialize()
}

// ============================================================================
// 页面卸载时清理
// ============================================================================

window.addEventListener('beforeunload', () => {
  cleanup()
})

// ============================================================================
// 导出（用于测试）
// ============================================================================

export { isInitialized, initialize, cleanup }
