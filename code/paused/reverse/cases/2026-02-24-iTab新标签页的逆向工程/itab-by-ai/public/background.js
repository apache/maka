/**
 * Background Service Worker
 *
 * 功能:
 * - 安装追踪
 * - 消息处理
 * - 定时任务
 */

// ==================== 常量 ====================

const ANALYTICS_URL = 'https://api.codelife.cc/analytics/dailyInstall'

// ==================== 安装处理 ====================

/**
 * 扩展安装时的处理
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  console.log('[iTab Background] Extension installed/updated:', details.reason)

  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    // 记录安装统计
    await trackInstall()

    // 打开新标签页
    chrome.tabs.create({
      url: 'chrome://newtab'
    })
  }
})

/**
 * 记录安装统计
 */
async function trackInstall() {
  try {
    const response = await fetch(ANALYTICS_URL, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'browser': navigator.userAgent,
        'mode': 'itab',
        'version': chrome.runtime.getManifest().version
      }
    })

    if (!response.ok) {
      console.warn('[iTab Background] Failed to track install')
    }
  } catch (error) {
    console.error('[iTab Background] Track install error:', error)
  }
}

// ==================== 消息处理 ====================

/**
 * 处理来自 content script 和 popup 的消息
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[iTab Background] Received message:', message)

  // 根据消息类型处理
  switch (message.type) {
    case 'GET_CONFIG':
      handleGetConfig(sendResponse)
      return true

    case 'SET_CONFIG':
      handleSetConfig(message.payload, sendResponse)
      return true

    case 'GET_BOOKMARKS':
      handleGetBookmarks(sendResponse)
      return true

    case 'OPEN_TAB':
      handleOpenTab(message.payload)
      break

    default:
      console.warn('[iTab Background] Unknown message type:', message.type)
  }
})

/**
 * 获取配置
 */
async function handleGetConfig(sendResponse: (response?: any) => void) {
  try {
    const result = await chrome.storage.local.get(['config'])
    sendResponse({ success: true, data: result.config || {} })
  } catch (error) {
    sendResponse({ success: false, error: String(error) })
  }
}

/**
 * 设置配置
 */
async function handleSetConfig(payload: any, sendResponse: (response?: any) => void) {
  try {
    await chrome.storage.local.set({ config: payload })
    sendResponse({ success: true })
  } catch (error) {
    sendResponse({ success: false, error: String(error) })
  }
}

/**
 * 获取书签
 */
async function handleGetBookmarks(sendResponse: (response?: any) => void) {
  try {
    const tree = await chrome.bookmarks.getTree()
    sendResponse({ success: true, data: tree })
  } catch (error) {
    sendResponse({ success: false, error: String(error) })
  }
}

/**
 * 打开标签页
 */
async function handleOpenTab(payload: { url: string }) {
  try {
    await chrome.tabs.create({
      url: payload.url
    })
  } catch (error) {
    console.error('[iTab Background] Failed to open tab:', error)
  }
}

// ==================== 定时任务 ====================

/**
 * 每日数据清理
 */
async function dailyCleanup() {
  try {
    // 清理过期缓存
    const data = await chrome.storage.local.get(null)
    const now = Date.now()
    const ttl = 24 * 60 * 60 * 1000 // 24 小时

    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'exp' in value) {
        if (now > (value as any).exp) {
          await chrome.storage.local.remove(key)
        }
      }
    }

    console.log('[iTab Background] Daily cleanup completed')
  } catch (error) {
    console.error('[iTab Background] Daily cleanup error:', error)
  }
}

// 定时执行清理任务 (每天执行一次)
chrome.alarms.create('dailyCleanup', {
  delayInMinutes: 60, // 首次延迟1小时
  periodInMinutes: 60 * 24 // 之后每24小时执行一次
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'dailyCleanup') {
    dailyCleanup()
  }
})

// ==================== 导出 ====================

console.log('[iTab Background] Service worker loaded')
