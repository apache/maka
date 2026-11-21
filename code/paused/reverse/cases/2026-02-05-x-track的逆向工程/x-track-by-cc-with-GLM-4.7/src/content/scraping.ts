/**
 * X-Track Content Script - 智能抓取模块
 *
 * 支持手动和自动两种抓取模式
 */

import type { Tweet } from '../types'
import { extractTweetId, scrapeTweetData } from './scraper'
import { getSaveTypeFromUrl } from './interceptor'

/**
 * 页面类型
 */
export type PageType = 'PROFILE' | 'BOOKMARKS' | 'LIKES' | 'UNKNOWN'

/**
 * 抓取模式
 */
export type ScrapingMode = 'MANUAL' | 'AUTO' | null

/**
 * 抓取状态
 */
export interface ScrapingState {
  isActive: boolean
  mode: ScrapingMode
  pageType: PageType | null
  scrapedIds: Set<string>
  totalScraped: number
  lastScrollHeight: number
  noNewContentCount: number
  startTime: number | null
  lastActionTime: number | null
}

/**
 * 自动抓取配置
 */
export interface AutoScrapingConfig {
  minDelay: number
  maxDelay: number
  batchSize: number
  maxTweets: number
  maxDuration: number
  pauseProbability: number
  pauseMinDuration: number
  pauseMaxDuration: number
  scrollMinAmount: number
  scrollMaxAmount: number
  reverseScrollChance: number
  reverseScrollAmount: number
}

/**
 * 默认抓取配置
 */
const DEFAULT_SCRAPING_CONFIG = {
  mode: 'MANUAL' as const,
  auto: {
    minDelay: 1000,
    maxDelay: 2500,
    batchSize: 50,
    maxTweets: 200,
    maxDuration: 10 * 60 * 1000, // 10分钟
    pauseProbability: 0.2,
    pauseMinDuration: 1500,
    pauseMaxDuration: 4000,
    scrollMinAmount: 300,
    scrollMaxAmount: 800,
    reverseScrollChance: 0.1,
    reverseScrollAmount: 200
  }
}

/**
 * 当前抓取配置
 */
let scrapingConfig = { ...DEFAULT_SCRAPING_CONFIG }

/**
 * 当前抓取状态
 */
let scrapingState: ScrapingState = {
  isActive: false,
  mode: null,
  pageType: null,
  scrapedIds: new Set(),
  totalScraped: 0,
  lastScrollHeight: 0,
  noNewContentCount: 0,
  startTime: null,
  lastActionTime: null
}

// 手动收集间隔
let manualCollectionInterval: ReturnType<typeof setInterval> | null = null

// 自动抓取超时
let autoScrapingTimeout: ReturnType<typeof setTimeout> | null = null

/**
 * 检测当前页面类型
 */
export function detectPageType(): PageType {
  const url = window.location.href
  console.log('X-Track: Detecting page type for URL:', url)

  let pageType: PageType = 'UNKNOWN'

  if (url.includes('/i/bookmarks') || url.includes('/bookmarks')) {
    pageType = 'BOOKMARKS'
  } else if (url.includes('/likes')) {
    pageType = 'LIKES'
  } else if (url.match(/^https?:\/\/(x|twitter)\.com\/[^/]+\/?($|\?)/)) {
    // 配置文件页模式: x.com/username (但不是 /status 或其他子页面)
    pageType = 'PROFILE'
  }

  console.log('X-Track: Detected page type:', pageType)
  return pageType
}

/**
 * 获取抓取配置
 */
export function getScrapingConfig(): typeof scrapingConfig {
  return { ...scrapingConfig }
}

/**
 * 更新抓取配置
 */
export function updateScrapingConfig(config: Partial<typeof scrapingConfig>): void {
  scrapingConfig = { ...scrapingConfig, ...config }
  // 保存到 chrome.storage
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.set({ xtrack_scraping_config: scrapingConfig }, () => {
      console.log('X-Track: Saved scraping config')
    })
  }
}

/**
 * 加载抓取配置
 */
export function loadScrapingConfig(): void {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get(['xtrack_scraping_config'], result => {
      if (result.xtrack_scraping_config) {
        scrapingConfig = { ...scrapingConfig, ...result.xtrack_scraping_config }
        console.log('X-Track: Loaded scraping config', scrapingConfig)
      }
    })
  }
}

/**
 * 获取抓取状态
 */
export function getScrapingStatus(): {
  isActive: boolean
  mode: ScrapingMode
  pageType: PageType | null
  totalScraped: number
  duration: number | null
} {
  return {
    isActive: scrapingState.isActive,
    mode: scrapingState.mode,
    pageType: scrapingState.pageType,
    totalScraped: scrapingState.totalScraped,
    duration: scrapingState.startTime ? Date.now() - scrapingState.startTime : null
  }
}

/**
 * 保存推文到存储
 */
async function saveTweetsToStorage(
  tweets: Awaited<ReturnType<typeof scrapeTweetData>>[],
  pageType: PageType
): Promise<void> {
  const validTweets = tweets.filter(
    (t): t is NonNullable<typeof t> => t !== null && t.id !== 'unknown' && t.handle !== 'unknown'
  )

  if (validTweets.length === 0) {
    console.warn('X-Track: No valid tweets to save')
    return
  }

  // 根据页面类型确定保存类型
  let saveType: 'BOOKMARK' | 'LIKE' | 'MYTWEET' | null = null

  if (pageType === 'BOOKMARKS') {
    saveType = 'BOOKMARK'
  } else if (pageType === 'LIKES') {
    saveType = 'LIKE'
  } else if (pageType === 'PROFILE') {
    saveType = 'MYTWEET'
  }

  console.log(`X-Track: Saving ${validTweets.length} tweets as ${saveType}`)

  chrome.runtime.sendMessage(
    {
      action: 'SAVE_BATCH',
      data: {
        type: saveType,
        tweets: validTweets.map(t => ({
          id: t.id,
          authorId: t.handle,
          author: {
            id: t.handle,
            screenName: t.handle,
            name: t.author,
            avatarUrl: t.avatarUrl || undefined
          },
          content: t.content,
          createdAt: t.timestamp,
          stats: {
            likes: t.likes,
            retweets: t.retweets,
            replies: t.replies,
            views: t.views
          },
          tweetType: t.isReply ? 'REPLY' : ('ORIGINAL' as const),
          media:
            t.media.length > 0
              ? t.media.map(m => ({
                  type: m.type === 'video' ? 'video' : 'photo',
                  url: m.url,
                  thumbnailUrl: m.type === 'video' ? undefined : m.url
                }))
              : undefined
        }))
      }
    },
    response => {
      if (chrome.runtime.lastError) {
        console.error('X-Track: Error saving tweets:', chrome.runtime.lastError.message)
      } else if (response?.success) {
        console.log(`✅ X-Track: Saved ${response.count} tweets`)
      }
    }
  )
}

/**
 * 验证推文数据是否有效
 */
function isValidTweetData(tweetData: Awaited<ReturnType<typeof scrapeTweetData>>): boolean {
  if (!tweetData) return false
  if (!tweetData.id || tweetData.id === 'unknown' || tweetData.id.startsWith('unknown-')) {
    console.warn('X-Track: Tweet missing valid ID')
    return false
  }
  if (!tweetData.handle || tweetData.handle === 'unknown') {
    console.warn(`X-Track: Tweet ${tweetData.id} missing user handle`)
    return false
  }
  // 记录缺少头像的警告但不拒绝
  if (!tweetData.avatarUrl) {
    console.warn(`X-Track: Tweet ${tweetData.id} from @${tweetData.handle} missing avatar URL`)
  }
  return true
}

/**
 * 提取所有可见推文（并行处理以提高速度）
 */
async function extractVisibleTweets(): Promise<Awaited<ReturnType<typeof scrapeTweetData>>[]> {
  const articles = document.querySelectorAll('article[data-testid="tweet"]')

  // 首先过滤掉已抓取的文章（快速同步检查）
  const unscrapedArticles: Element[] = []
  for (const article of articles) {
    const tweetId = extractTweetId(article)
    if (tweetId && !scrapingState.scrapedIds.has(tweetId)) {
      unscrapedArticles.push(article)
    }
  }

  if (unscrapedArticles.length === 0) {
    return []
  }

  // 并行处理所有未抓取的文章
  const tweetPromises = unscrapedArticles.map(article => scrapeTweetData(article))
  const tweetResults = await Promise.all(tweetPromises)

  const newTweets: Awaited<ReturnType<typeof scrapeTweetData>>[] = []
  let skippedCount = 0

  for (const tweetData of tweetResults) {
    if (tweetData && !scrapingState.scrapedIds.has(tweetData.id)) {
      if (isValidTweetData(tweetData)) {
        newTweets.push(tweetData)
        scrapingState.scrapedIds.add(tweetData.id)
      } else {
        skippedCount++
      }
    }
  }

  if (skippedCount > 0) {
    console.log(`X-Track: Skipped ${skippedCount} tweets due to missing data`)
  }

  return newTweets
}

/**
 * 检查是否有新内容加载
 */
function hasNewContent(): boolean {
  const currentHeight = document.documentElement.scrollHeight
  const heightChanged = currentHeight > scrapingState.lastScrollHeight
  scrapingState.lastScrollHeight = currentHeight

  // 也检查是否有任何未抓取的推文可见
  const articles = document.querySelectorAll('article[data-testid="tweet"]')
  let hasUnscrapedTweets = false
  for (const article of articles) {
    const tweetId = extractTweetId(article)
    if (tweetId && !scrapingState.scrapedIds.has(tweetId)) {
      hasUnscrapedTweets = true
      break
    }
  }

  return heightChanged || hasUnscrapedTweets
}

/**
 * 随机延迟（模拟人类行为）
 */
function randomDelay(min: number, max: number): Promise<void> {
  const duration = Math.random() * (max - min) + min
  return new Promise(resolve => setTimeout(resolve, duration))
}

/**
 * 获取配置的延迟
 */
function getConfiguredDelay(): Promise<void> {
  return randomDelay(scrapingConfig.auto.minDelay, scrapingConfig.auto.maxDelay)
}

/**
 * 人类化平滑滚动
 */
async function smoothScroll(): Promise<void> {
  const config = scrapingConfig.auto

  // 很少向上滚动（5% 概率，从 10% 降低）
  if (Math.random() < 0.05) {
    window.scrollBy({
      top: -150,
      behavior: 'smooth'
    })
    await randomDelay(200, 400)
    return
  }

  // 带变化的正常向下滚动
  const scrollAmount =
    Math.random() * (config.scrollMaxAmount - config.scrollMinAmount) + config.scrollMinAmount
  window.scrollBy({
    top: scrollAmount,
    behavior: 'smooth'
  })

  // 滚动后的最小暂停（足够平滑滚动动画）
  await randomDelay(150, 300)
}

// ============================================================================
// 手动模式 - 被动收集
// ============================================================================

/**
 * 开始手动收集
 */
export function startManualCollection(pageType: PageType): void {
  if (manualCollectionInterval) {
    console.log('X-Track Manual: Already collecting')
    return
  }

  scrapingState = {
    isActive: true,
    mode: 'MANUAL',
    pageType: pageType,
    scrapedIds: new Set(),
    totalScraped: 0,
    lastScrollHeight: document.documentElement.scrollHeight,
    noNewContentCount: 0,
    startTime: Date.now(),
    lastActionTime: Date.now()
  }

  console.log(`X-Track Manual: Started passive collection for ${pageType}`)

  // 通知 popup
  chrome.runtime.sendMessage({
    action: 'SCRAPE_STARTED',
    data: { mode: 'MANUAL', pageType }
  })

  // 被动收集：每 2 秒检查新推文
  manualCollectionInterval = setInterval(async () => {
    const newTweets = await extractVisibleTweets()
    if (newTweets.length > 0) {
      scrapingState.totalScraped += newTweets.length
      scrapingState.lastActionTime = Date.now()

      console.log(`X-Track Manual: Saving ${newTweets.length} tweets to ${scrapingState.pageType}`)
      await saveTweetsToStorage(newTweets, scrapingState.pageType!)

      console.log(
        `X-Track Manual: Collected ${newTweets.length} tweets (Total: ${scrapingState.totalScraped})`
      )
    }
  }, 2000)
}

/**
 * 停止手动收集
 */
export function stopManualCollection(reason = 'Stopped'): void {
  if (manualCollectionInterval) {
    clearInterval(manualCollectionInterval)
    manualCollectionInterval = null
  }

  scrapingState.isActive = false
  scrapingState.mode = null

  console.log(`X-Track Manual: Stopped collection (${reason})`)

  // 通知 popup
  chrome.runtime.sendMessage({
    action: 'SCRAPE_STOPPED',
    data: {
      mode: 'MANUAL',
      totalScraped: scrapingState.totalScraped,
      reason
    }
  })
}

// ============================================================================
// 自动模式 - 自动化抓取
// ============================================================================

/**
 * 开始自动抓取
 */
export async function startAutoScraping(
  pageType: PageType,
  config?: Partial<AutoScrapingConfig>
): Promise<void> {
  if (scrapingState.isActive && scrapingState.mode === 'AUTO') {
    console.log('X-Track Auto: Already scraping')
    return
  }

  // 如果提供了配置，更新配置
  if (config) {
    scrapingConfig.auto = { ...scrapingConfig.auto, ...config }
  }

  scrapingState = {
    isActive: true,
    mode: 'AUTO',
    pageType: pageType,
    scrapedIds: new Set(),
    totalScraped: 0,
    lastScrollHeight: document.documentElement.scrollHeight,
    noNewContentCount: 0,
    startTime: Date.now(),
    lastActionTime: Date.now()
  }

  console.log(`X-Track Auto: Started automated scraping for ${pageType}`)

  // 通知 popup
  chrome.runtime.sendMessage({
    action: 'SCRAPE_STARTED',
    data: { mode: 'AUTO', pageType }
  })

  // 开始自动抓取循环
  runAutoScrapingLoop()
}

/**
 * 停止自动抓取
 */
export function stopAutoScraping(reason = 'Stopped'): void {
  if (autoScrapingTimeout) {
    clearTimeout(autoScrapingTimeout)
    autoScrapingTimeout = null
  }

  scrapingState.isActive = false
  scrapingState.mode = null

  console.log(`X-Track Auto: Stopped scraping (${reason})`)

  // 通知 popup
  chrome.runtime.sendMessage({
    action: 'SCRAPE_STOPPED',
    data: {
      mode: 'AUTO',
      totalScraped: scrapingState.totalScraped,
      reason
    }
  })
}

/**
 * 自动抓取主循环
 */
async function runAutoScrapingLoop(): Promise<void> {
  const config = scrapingConfig.auto
  const startTime = Date.now()

  while (scrapingState.isActive && scrapingState.mode === 'AUTO') {
    // 检查是否超过最大时长
    if (Date.now() - startTime > config.maxDuration) {
      stopAutoScraping('Max duration reached')
      break
    }

    // 检查是否达到最大推文数
    if (scrapingState.totalScraped >= config.maxTweets) {
      stopAutoScraping('Max tweets reached')
      break
    }

    // 滚动页面
    await smoothScroll()

    // 等待内容加载
    await getConfiguredDelay()

    // 提取可见推文
    const newTweets = await extractVisibleTweets()

    if (newTweets.length > 0) {
      scrapingState.totalScraped += newTweets.length
      scrapingState.lastActionTime = Date.now()
      scrapingState.noNewContentCount = 0

      console.log(`X-Track Auto: Saving ${newTweets.length} tweets`)
      await saveTweetsToStorage(newTweets, scrapingState.pageType!)

      console.log(
        `X-Track Auto: Collected ${newTweets.length} tweets (Total: ${scrapingState.totalScraped})`
      )

      // 随机暂停（模拟人类行为）
      if (Math.random() < config.pauseProbability) {
        console.log('X-Track Auto: Taking a short pause...')
        await randomDelay(config.pauseMinDuration, config.pauseMaxDuration)
      }
    } else {
      scrapingState.noNewContentCount++

      // 如果多次没有新内容，可能已到达页面底部
      if (scrapingState.noNewContentCount >= 3) {
        console.log('X-Track Auto: No new content detected, stopping')
        stopAutoScraping('Reached end of page')
        break
      }
    }

    // 小延迟后再继续
    await randomDelay(500, 1000)
  }
}

// 初始化时加载配置
loadScrapingConfig()
