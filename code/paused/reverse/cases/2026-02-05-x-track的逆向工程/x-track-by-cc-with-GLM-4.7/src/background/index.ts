/**
 * X-Track Background Script - 主入口
 *
 * 这是 X-Track Chrome 扩展的后台服务工作者入口
 */

import { needsMigration, migrateFromChromeStorage } from './migration'
import { setupMessageListener } from './messages'

console.log('X-Track: Background service worker loaded')

/**
 * 扩展安装/更新时处理
 */
chrome.runtime.onInstalled.addListener(async () => {
  console.log('X-Track: Extension installed/updated')

  try {
    const shouldMigrate = await needsMigration()

    if (shouldMigrate) {
      console.log('X-Track: Running migration from chrome.storage to IndexedDB...')
      await migrateFromChromeStorage()
      console.log('✅ X-Track: Migration completed')
    } else {
      console.log('X-Track: No migration needed')
    }
  } catch (error) {
    console.error('X-Track: Migration error:', error)
  }
})

/**
 * 设置消息监听器
 */
setupMessageListener()
