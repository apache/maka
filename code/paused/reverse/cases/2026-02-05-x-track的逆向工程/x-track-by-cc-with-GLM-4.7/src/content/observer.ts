/**
 * X-Track Content Script - 浏览追踪模块
 *
 * 使用 IntersectionObserver 追踪用户浏览推文的行为
 */

import type { HistoryEntry, HistoryType } from '../types'
import { extractTweetId, scrapeTweetData } from './scraper'
import { getSaveTypeFromUrl } from './interceptor'

/**
 * 浏览阈值（毫秒）- 计为"浏览"的时间
 */
export const DWELL_THRESHOLD = 1000

/**
 * 观察属性名称
 */
export const OBSERVED_ATTR = 'data-xtrack-observed'

/**
 * 浏览计时器映射
 */
const viewingTimers: Record<string, number> = {}

/**
 * 观察器回调
 */
const observerCallback = (entries: IntersectionObserverEntry[]): void => {
  entries.forEach(entry => {
    const tweetId = extractTweetId(entry.target)
    if (!tweetId) return

    if (entry.isIntersecting) {
      // 推文进入视图
      if (!viewingTimers[tweetId]) {
        viewingTimers[tweetId] = Date.now()
        console.log('X-Track: Tweet entered view:', tweetId)
      }
    } else {
      // 推文离开视图
      const startTime = viewingTimers[tweetId]
      if (startTime) {
        const duration = Date.now() - startTime
        console.log('X-Track: Tweet left view:', tweetId, 'Duration:', duration, 'ms')
        if (duration > DWELL_THRESHOLD) {
          saveFootprint(entry.target as Element, duration)
        }
        delete viewingTimers[tweetId]
      }
    }
  })
}

/**
 * IntersectionObserver 实例
 */
export const observer = new IntersectionObserver(observerCallback, {
  threshold: 0.1, // 降低阈值以便更早检测
  rootMargin: '100px 0px' // 在进入视口前 100px 检测推文
})

/**
 * 观察推文元素
 */
export function observeTweet(article: Element): void {
  if (!article || article.getAttribute(OBSERVED_ATTR) === 'true') return
  observer.observe(article)
  article.setAttribute(OBSERVED_ATTR, 'true')
}

/**
 * 完成推文观察
 */
export function finalizeTweetObservation(article: Element): void {
  if (!article) return
  const tweetId = extractTweetId(article)
  if (tweetId && viewingTimers[tweetId]) {
    const duration = Date.now() - viewingTimers[tweetId]
    if (duration > DWELL_THRESHOLD) {
      saveFootprint(article, duration)
    }
    delete viewingTimers[tweetId]
  }
  try {
    observer.unobserve(article)
  } catch (e) {
    // 如果未观察则忽略
  }
  article.removeAttribute(OBSERVED_ATTR)
}

/**
 * 保存浏览记录
 */
async function saveFootprint(articleElement: Element, durationMs: number): Promise<void> {
  console.log('X-Track: saveFootprint() called with duration:', durationMs)

  const tweetData = await scrapeTweetData(articleElement)
  if (!tweetData) {
    console.warn('X-Track: Failed to scrape tweet data')
    return
  }

  if (!tweetData.id || tweetData.id.startsWith('unknown')) {
    console.warn('X-Track: Skipping save for invalid tweet ID:', tweetData.id)
    return
  }

  // 从 URL 确定浏览类型
  const url = window.location.href
  let historyType: HistoryType = HistoryType.TIMELINE

  if (url.includes('/status/')) {
    historyType = HistoryType.TWEET_DETAIL
  } else if (url.includes('/bookmarks')) {
    historyType = HistoryType.BOOKMARKS
  } else if (url.includes('/likes')) {
    historyType = HistoryType.LIKES
  } else if (url.match(/^\/[^\/]+$/) && !url.startsWith('/i/') && !url.startsWith('/home')) {
    historyType = HistoryType.PROFILE
  } else if (url.includes('/search')) {
    historyType = HistoryType.SEARCH
  }

  const historyEntry: HistoryEntry = {
    tweetId: tweetData.id,
    viewedAt: new Date().toISOString(),
    durationSeconds: Math.round(durationMs / 1000),
    type: historyType,
    pageUrl: window.location.href
  }

  console.log('X-Track: Saving history entry:', historyEntry)

  chrome.runtime.sendMessage(
    {
      action: 'SAVE_HISTORY',
      data: historyEntry
    },
    response => {
      if (chrome.runtime.lastError) {
        console.error('X-Track: Error saving history:', chrome.runtime.lastError.message)
      } else if (response?.success) {
        console.log('✅ X-Track: History entry saved')
      }
    }
  )
}

/**
 * 获取当前浏览的推文计时器
 */
export function getViewingTimers(): Record<string, number> {
  return { ...viewingTimers }
}

/**
 * 清空所有浏览计时器
 */
export function clearViewingTimers(): void {
  for (const tweetId in viewingTimers) {
    delete viewingTimers[tweetId]
  }
}

/**
 * 断开观察器
 */
export function disconnectObserver(): void {
  observer.disconnect()
}
