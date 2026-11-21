/**
 * X-Track Content Script - DOM 抓取模块
 *
 * 负责从 DOM 中抓取推文数据（作为网络拦截的备用方案）
 */

import type { Tweet, TweetType } from '../types'
import { MediaAttachment } from './utils'
import { getCachedTweet } from './cache'
import { parseTweetFromApi } from './parser'
import {
  extractTweetId,
  extractCountFromElement,
  getStatValue,
  STAT_KEYWORDS,
  isPromotedTweet,
  extractMediaAttachments,
  type ProfileUserInfo
} from './utils'

/**
 * DOM 抓取的推文数据
 */
export interface ScrapedTweetData {
  id: string
  author: string
  handle: string
  content: string
  timestamp: string
  avatarUrl: string
  likes: number
  retweets: number
  replies: number
  views: number
  isReply: boolean
  media: MediaAttachment[]
}

/**
 * 提取完整推文文本（使用网络拦截数据时可用，回退到 DOM）
 */
export async function extractFullTweetText(articleElement: Element): Promise<string> {
  const textElement = articleElement.querySelector('div[data-testid="tweetText"]')
  if (!textElement) return '[Image/Video Only]'

  // 首先检查缓存（由网络拦截填充）
  const tweetId = extractTweetId(articleElement)
  if (tweetId && getCachedTweet(tweetId)?.raw) {
    const cached = getCachedTweet(tweetId)!
    if (cached.raw) {
      const parsed = parseTweetFromApi(cached.raw)
      if (parsed && parsed.content) {
        return parsed.content
      }
    }
  }

  // 回退：使用 DOM 文本（如果尚未加载可能被截断）
  // 方法1: 使用 innerText，它保留来自 CSS/BR 标签的换行符
  // innerText 尊重 CSS 样式并将 <br> 转换为换行符
  let fullText = (textElement as HTMLElement).innerText || ''

  // 方法2: 如果 innerText 不起作用，尝试手动遍历 DOM
  if (!fullText || fullText.length < 10) {
    const result: string[] = []

    function walkNodes(node: Node): void {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = child.textContent
          if (text && text.trim() && text.trim() !== '...') {
            result.push(text)
          }
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          const tagName = (child as Element).tagName.toLowerCase()
          // 为块元素和 br 标签添加换行符
          if (tagName === 'br') {
            result.push('\n')
          } else if (tagName === 'div' || tagName === 'p') {
            if (result.length > 0 && !result[result.length - 1].endsWith('\n')) {
              result.push('\n')
            }
            walkNodes(child)
            if (result.length > 0 && !result[result.length - 1].endsWith('\n')) {
              result.push('\n')
            }
          } else {
            walkNodes(child)
          }
        }
      }
    }

    walkNodes(textElement)
    fullText = result.join('')
  }

  // 清理：移除"Show more"文本，将多个连续换行符规范化为最多 2 个
  fullText = fullText
    .replace(/Show more$/i, '')
    .replace(/[ \t]+/g, ' ') // 仅折叠水平空白（保留换行符）
    .replace(/\n{3,}/g, '\n\n') // 最多 2 个连续换行符
    .replace(/^\s+|\s+$/g, '') // 修剪开头和结尾
    .replace(/ *\n */g, '\n') // 移除换行符周围的空格

  return fullText || '[Image/Video Only]'
}

/**
 * 从 DOM 抓取推文数据
 */
export async function scrapeTweetData(
  articleElement: Element
): Promise<ScrapedTweetData | null> {
  try {
    // 跳过推广/广告推文
    if (isPromotedTweet(articleElement)) {
      console.log('X-Track: Skipping promoted/ad tweet')
      return null
    }

    const tweetId = extractTweetId(articleElement)
    if (!tweetId) {
      console.warn('X-Track: Could not extract tweet ID from article element')
      return null
    }

    // 1. 尝试从缓存获取（网络拦截）- 优先
    let apiData: ReturnType<typeof parseTweetFromApi> = null
    if (getCachedTweet(tweetId)?.raw) {
      apiData = parseTweetFromApi(getCachedTweet(tweetId)!.raw)
    }

    // 如果 API 数据完整，使用它
    if (apiData && apiData.author?.screenName !== 'unknown') {
      return {
        id: apiData.id,
        author: apiData.author?.name || 'Unknown',
        handle: apiData.author?.screenName || 'unknown',
        content: apiData.content,
        timestamp: apiData.createdAt,
        avatarUrl: apiData.author?.avatarUrl || '',
        likes: apiData.stats.likes,
        retweets: apiData.stats.retweets,
        replies: apiData.stats.replies,
        views: apiData.stats.views,
        isReply: apiData.tweetType === TweetType.REPLY,
        media: (apiData.media || []).map(m => ({
          url: m.url,
          type: m.type === 'video' ? 'video' : 'image',
          tweetId: apiData.id,
          author: apiData.author?.screenName || 'unknown'
        }))
      }
    }

    // 2. 回退到 DOM 抓取（传统方法）

    const userElement = articleElement.querySelector('div[data-testid="User-Name"]')
    const timeElement = articleElement.querySelector('time')

    // 尝试多个选择器获取头像（Twitter/X 经常更改 DOM 结构）
    // 增强头像提取
    let avatarElement: HTMLImageElement | null = articleElement.querySelector(
      'div[data-testid="Tweet-User-Avatar"] img'
    )
    if (!avatarElement) {
      // 尝试在用户链接区域查找头像
      const userLink = articleElement.querySelector('a[role="link"][href^="/"]')
      if (userLink) {
        avatarElement = userLink.querySelector('img[src*="profile_images"]')
      }
    }
    if (!avatarElement) {
      // 回退：任何带有 twimg 配置文件模式的 img
      avatarElement = articleElement.querySelector('img[src*="twimg.com/profile_images"]')
    }
    if (!avatarElement) {
      // 最后手段：文章中看起来像配置文件图片的第一张 img
      const allImgs = articleElement.querySelectorAll('img')
      for (const img of allImgs) {
        const src = img.getAttribute('src')
        if (src && (src.includes('profile_images') || src.includes('pbs.twimg.com'))) {
          avatarElement = img as HTMLImageElement
          break
        }
      }
    }

    // 增强名称/用户名提取
    let author = 'Unknown'
    let handle = 'unknown'

    if (userElement) {
      const textContent = (userElement as HTMLElement).innerText || ''
      // 按换行符分割并过滤空字符串和点/分隔符
      const lines = textContent
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && l !== '·' && l !== '•')

      // 名称通常是第一行
      if (lines.length > 0) {
        author = lines[0]
      }

      // 用户名通常是以 @ 开头的行
      const handleLine = lines.find(l => l.startsWith('@'))
      if (handleLine) {
        handle = handleLine.replace(/^@/, '').split('·')[0].trim()
      } else {
        // 回退：如果文本解析失败，尝试在链接中查找用户名
        const links = userElement.querySelectorAll('a[href^="/"]')
        for (const link of links) {
          const href = link.getAttribute('href')
          // 避免状态链接或其他非配置文件链接
          if (href && !href.includes('/status/') && !href.includes('/hashtag/')) {
            handle = href.replace('/', '')
            break
          }
        }
      }
    }

    // 提取统计数据（点赞/转推）
    const likes = getStatValue(articleElement, ['like', 'unlike'], STAT_KEYWORDS.likes)
    const retweets = getStatValue(articleElement, ['retweet', 'unretweet'], STAT_KEYWORDS.retweets)
    const replies = getStatValue(articleElement, ['reply'], STAT_KEYWORDS.replies)
    const views = getStatValue(articleElement, ['viewCount', 'tweet-viewport-link'], STAT_KEYWORDS.views)
    const media = extractMediaAttachments(articleElement, tweetId, handle)

    // 检查是否为回复
    // 通常回复在文本上方有"Replying to @..."行，或者如果需要我们可以从上下文推断
    // 一个简单的启发式：检查是否有"Replying to"文本容器
    const replyContext = Array.from(articleElement.querySelectorAll('div')).find(d =>
      (d.textContent || '').includes('Replying to')
    )
    const isReply = !!replyContext

    // 提取完整推文文本（包括截断部分）
    const content = await extractFullTweetText(articleElement)

    const avatarUrl = avatarElement ? avatarElement.src : ''

    // DOM 解析结果的调试日志
    if (!getCachedTweet(tweetId)) {
      console.log(
        `X-Track DOM Parse: Tweet ${tweetId} - handle: @${handle}, author: ${author}, avatar: ${avatarUrl ? 'found' : 'MISSING'}`
      )
    }

    const domData: ScrapedTweetData = {
      id: tweetId,
      author,
      handle,
      content,
      timestamp: timeElement ? timeElement.getAttribute('datetime') || new Date().toISOString() : new Date().toISOString(),
      avatarUrl: avatarElement ? avatarElement.src : '',
      likes,
      retweets,
      replies,
      views,
      isReply,
      media
    }

    // 如果我们有部分 API 数据，合并它（API 优先用于内容/统计/媒体，如果 API 失败则 DOM 用于用户信息）
    if (apiData) {
      return {
        ...domData,
        author: domData.author !== 'Unknown' ? domData.author : apiData.author?.name || 'Unknown',
        handle: domData.handle !== 'unknown' ? domData.handle : apiData.author?.screenName || 'unknown',
        avatarUrl: domData.avatarUrl || apiData.author?.avatarUrl || ''
      }
    }

    return domData
  } catch (e) {
    console.error('X-Track: Error scraping tweet', e)
    return null
  }
}

/**
 * 从页面抓取所有可见推文
 */
export async function scrapeVisibleTweets(): Promise<ScrapedTweetData[]> {
  const articles = document.querySelectorAll('article[data-testid="tweet"]')
  const tweets: ScrapedTweetData[] = []

  for (const article of articles) {
    const tweetData = await scrapeTweetData(article)
    if (tweetData) {
      tweets.push(tweetData)
    }
  }

  return tweets
}

/**
 * 重新导出从 utils 模块导入的函数和类型
 */
export { extractTweetId, isPromotedTweet, extractMediaAttachments, type ProfileUserInfo }
