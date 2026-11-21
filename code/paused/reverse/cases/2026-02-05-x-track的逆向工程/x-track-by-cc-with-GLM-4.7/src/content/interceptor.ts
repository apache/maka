/**
 * X-Track Content Script - 网络拦截处理模块
 *
 * 负责处理从 inject.js 拦截的网络数据
 */

import type { TwitterTweet } from '../types/twitter-api'
import { cacheTweet } from './cache'
import { parseTweetFromApi } from './parser'
import { getCurrentUserScreenName, getProfilePageUserInfo, getUserFromTweetsUrl } from './utils'

/**
 * 保存类型
 */
export type SaveType = 'BOOKMARK' | 'LIKE' | 'MYTWEET' | null

/**
 * 根据 URL 确定保存类型
 */
export function getSaveTypeFromUrl(url: string): SaveType {
  if (!url) return null

  console.log('X-Track: Checking URL for save type:', url)

  if (url.includes('/Bookmarks')) {
    console.log('X-Track: Matched BOOKMARK pattern')
    return 'BOOKMARK'
  }
  if (url.includes('/Likes')) {
    console.log('X-Track: Matched LIKE pattern')
    return 'LIKE'
  }
  if (url.includes('/UserTweets')) {
    // 仅当我们在当前用户的配置文件上时才保存为 MYTWEET
    const currentUser = getCurrentUserScreenName()
    const profileUser = getUserFromTweetsUrl(url)
    console.log(
      `X-Track: UserTweets detected - currentUser: ${currentUser}, profileUser: ${profileUser}`
    )
    if (currentUser && profileUser && currentUser === profileUser) {
      console.log('X-Track: Matched MYTWEET pattern')
      return 'MYTWEET'
    }
    console.log(
      `X-Track: Skipping UserTweets - profile (${profileUser}) != current user (${currentUser})`
    )
    return null
  }
  console.log('X-Track: No save type matched for URL')
  return null // HomeTimeline, TweetDetail 等 - 仅缓存，不自动保存
}

/**
 * 跟踪已同步的推文 ID 以避免重复
 */
const syncedTweetIds = new Set<string>()

/**
 * 处理拦截的数据
 */
export function processInterceptedData(data: unknown, url: string): void {
  // 尝试从 TweetDetail 响应中提取文章内容
  if (url && url.includes('/TweetDetail')) {
    processArticleContentFromTweetDetail(data, url)
  }

  // 也处理单独的 ArticleDetail 端点（如果存在）
  if (url && url.includes('/ArticleDetail')) {
    processArticleContent(data, url)
    return // 不作为常规推文处理
  }

  const tweets: TwitterTweet[] = []

  // 遍历查找 'Tweet' 对象的辅助函数
  function findTweets(obj: unknown): void {
    if (!obj || typeof obj !== 'object') return

    // 处理 TweetWithVisibilityResults 包装器
    if (
      obj &&
      typeof obj === 'object' &&
      '__typename' in obj &&
      obj.__typename === 'TweetWithVisibilityResults' &&
      'tweet' in obj &&
      obj.tweet
    ) {
      const innerTweet = obj.tweet as TwitterTweet
      if (innerTweet.rest_id) {
        cacheTweet(innerTweet)
        tweets.push(innerTweet)
      }
      // 继续遍历以防有嵌套推文
      findTweets(innerTweet)
      return // 不再遍历 obj 本身，因为我们已处理了推文
    }

    // 处理常规 Tweet
    if (
      obj &&
      typeof obj === 'object' &&
      '__typename' in obj &&
      obj.__typename === 'Tweet' &&
      'rest_id' in obj &&
      obj.rest_id
    ) {
      cacheTweet(obj as TwitterTweet)
      tweets.push(obj as TwitterTweet)
    }

    // 处理数组或对象
    if (Array.isArray(obj)) {
      obj.forEach(item => findTweets(item))
    } else if (obj && typeof obj === 'object') {
      for (const key in obj) {
        // 跳过已处理的推文属性
        if (
          key === 'tweet' &&
          '__typename' in obj &&
          obj.__typename === 'TweetWithVisibilityResults'
        )
          continue
        // 跳过嵌套的引用/转推推文 - 它们是嵌入数据，不是单独条目
        if (key === 'quoted_status_result') continue
        if (key === 'retweeted_status_result') continue
        findTweets((obj as Record<string, unknown>)[key])
      }
    }
  }

  findTweets(data)

  if (tweets.length > 0) {
    console.log(`X-Track: Cached ${tweets.length} tweets from interception`)

    // 基于 URL 类型自动同步
    const saveType = getSaveTypeFromUrl(url)
    if (saveType) {
      autoSyncTweets(tweets, saveType)
    }
  }
}

/**
 * 从 TweetDetail API 响应处理文章内容
 */
function processArticleContentFromTweetDetail(data: unknown, url: string): void {
  try {
    // 从 URL 提取推文 ID
    let focalTweetId: string | null = null
    try {
      const urlParams = new URL(url).searchParams
      const variables = urlParams.get('variables')
      if (variables) {
        const parsed = JSON.parse(variables) as { focalTweetId?: string }
        focalTweetId = parsed.focalTweetId || null
      }
    } catch (e) {
      // 忽略解析错误
    }

    if (!focalTweetId) return

    // 在推文对象中查找文章数据的辅助函数
    function extractArticleFromTweet(tweet: unknown): {
      tweetId: string
      articleData: unknown
    } | null {
      if (!tweet || typeof tweet !== 'object') return null

      // 获取实际推文对象
      const actualTweet =
        tweet &&
        typeof tweet === 'object' &&
        '__typename' in tweet &&
        tweet.__typename === 'TweetWithVisibilityResults' &&
        'tweet' in tweet
          ? (tweet.tweet as TwitterTweet)
          : (tweet as TwitterTweet)
      if (!actualTweet) return null

      // 检查 article_results
      if (actualTweet.article_results?.result) {
        return {
          tweetId: actualTweet.rest_id,
          articleData: actualTweet.article_results.result
        }
      }

      // 检查直接 article 属性
      if (actualTweet.article) {
        return {
          tweetId: actualTweet.rest_id,
          articleData: actualTweet.article
        }
      }

      // 检查带 article 绑定的 card
      if (actualTweet.card?.legacy?.binding_values) {
        const bindings = actualTweet.card.legacy.binding_values
        const cardName = actualTweet.card.legacy.name || ''

        // 检查是否为文章 card
        if (
          cardName.includes('article') ||
          bindings.find((b: { key: string }) => b.key === 'article_id') ||
          bindings.find((b: { key: string }) => b.key === 'content')
        ) {
          // 从绑定中提取值
          const getValue = (key: string): string => {
            const binding = bindings.find((b: { key: string }) => b.key === key)
            return (
              (binding?.value as { string_value?: string })?.string_value ||
              (binding?.value as { scribe_value?: string })?.scribe_value ||
              ''
            )
          }

          const title = getValue('title')
          const description = getValue('description')
          const content = getValue('content')

          if (title || content) {
            return {
              tweetId: actualTweet.rest_id,
              articleData: { title, description, content }
            }
          }
        }
      }

      return null
    }

    // 查找焦点推文并提取文章内容
    function findFocalTweetArticle(obj: unknown): {
      tweetId: string
      articleData: unknown
    } | null {
      if (!obj || typeof obj !== 'object') return null

      // 检查是否为我们的目标推文
      if (
        obj &&
        typeof obj === 'object' &&
        '__typename' in obj &&
        (obj.__typename === 'Tweet' || obj.__typename === 'TweetWithVisibilityResults') &&
        (('rest_id' in obj && obj.rest_id === focalTweetId) ||
          ('tweet' in obj &&
            obj.tweet &&
            typeof obj.tweet === 'object' &&
            'rest_id' in obj.tweet &&
            obj.tweet.rest_id === focalTweetId))
      ) {
        const result = extractArticleFromTweet(obj)
        if (result) return result
      }

      // 递归遍历对象
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = findFocalTweetArticle(item)
          if (found) return found
        }
      } else if (obj && typeof obj === 'object') {
        for (const key in obj) {
          const found = findFocalTweetArticle((obj as Record<string, unknown>)[key])
          if (found) return found
        }
      }
      return null
    }

    const result = findFocalTweetArticle(data)

    if (result) {
      console.log('X-Track: Found article data in TweetDetail for tweet', result.tweetId)
      console.debug(
        'X-Track Debug: Article data:',
        JSON.stringify(result.articleData).substring(0, 500)
      )

      // 从文章数据中提取内容
      let title = ''
      let content = ''
      const articleData = result.articleData as Record<string, unknown>

      // 处理嵌套结构：articleData 可能是 { article_results: { result: {...} } }
      const actualArticle =
        (articleData.article_results as Record<string, unknown>)?.result || articleData

      title =
        (actualArticle.title as string) || (actualArticle.headline as string) || ''

      if (actualArticle.content_blocks) {
        content = (actualArticle.content_blocks as Array<{ type: string; text?: string }>)
          .filter(b => b.type === 'paragraph' || b.type === 'text' || b.text)
          .map(b => b.text || '')
          .join('\n\n')
      } else if (actualArticle.content) {
        content = actualArticle.content as string
      } else if (actualArticle.body) {
        content = actualArticle.body as string
      } else if (actualArticle.preview_text) {
        content = actualArticle.preview_text as string
      } else if (actualArticle.description) {
        content = actualArticle.description as string
      }

      if (title || content) {
        // 格式：标题 + 换行 + 内容（根据用户请求无 [Article] 前缀）
        const articleContent = title ? `${title}\n\n${content}` : content

        console.log(
          `X-Track: Updating tweet ${result.tweetId} with article content (${articleContent.length} chars)`
        )

        chrome.runtime.sendMessage(
          {
            action: 'UPDATE_TWEET_CONTENT',
            data: {
              tweetId: result.tweetId,
              content: articleContent,
              tweetType: 'ARTICLE'
            }
          },
          response => {
            if (chrome.runtime.lastError) {
              console.error('X-Track: Error updating article:', chrome.runtime.lastError.message)
            } else if (response?.success) {
              console.log('✅ X-Track: Article content saved')
            }
          }
        )
      } else {
        // API 仅返回预览，延迟后尝试 DOM 抓取
        console.log('X-Track: No full article content in API, will try DOM scraping')
        setTimeout(() => scrapeArticleFromDOM(result.tweetId), 2000)
      }
    }
  } catch (e) {
    console.error('X-Track: Error extracting article from TweetDetail:', e)
  }
}

/**
 * 从 ArticleDetail API 处理文章内容
 */
function processArticleContent(data: unknown, url: string): void {
  console.log('X-Track: Processing article content from', url)

  try {
    let articleData: Record<string, unknown> | null = null
    let tweetId: string | null = null

    // 如果可能，从 URL 提取推文 ID
    const urlParams = new URL(url).searchParams
    const variables = urlParams.get('variables')
    if (variables) {
      try {
        const parsed = JSON.parse(variables) as {
          tweetId?: string
          articleTweetId?: string
        }
        tweetId = parsed.tweetId || parsed.articleTweetId || null
      } catch (e) {
        // 忽略解析错误
      }
    }

    // 递归查找文章数据的辅助函数
    function findArticle(obj: unknown): Record<string, unknown> | null {
      if (!obj || typeof obj !== 'object') return null

      // 在各种可能路径中查找文章内容
      if (
        obj &&
        typeof obj === 'object' &&
        'article_tweet_results' in obj &&
        obj.article_tweet_results
      ) {
        const atr = obj.article_tweet_results as Record<string, unknown>
        if (atr.result && typeof atr.result === 'object') {
          const result = atr.result as Record<string, unknown>
          if (result.article_results?.result) {
            return result.article_results.result as Record<string, unknown>
          }
        }
      }
      if (
        obj &&
        typeof obj === 'object' &&
        'article_results' in obj &&
        obj.article_results &&
        typeof obj.article_results === 'object' &&
        'result' in obj.article_results
      ) {
        return obj.article_results.result as Record<string, unknown>
      }
      if (
        obj &&
        typeof obj === 'object' &&
        'article' in obj &&
        obj.article &&
        typeof obj.article === 'object' &&
        'content' in obj.article
      ) {
        return obj.article as Record<string, unknown>
      }
      if (
        obj &&
        typeof obj === 'object' &&
        '__typename' in obj &&
        obj.__typename === 'Article' &&
        'content' in obj
      ) {
        return obj as Record<string, unknown>
      }

      // 递归遍历对象
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = findArticle(item)
          if (found) return found
        }
      } else if (obj && typeof obj === 'object') {
        for (const key in obj) {
          const found = findArticle((obj as Record<string, unknown>)[key])
          if (found) return found
        }
      }
      return null
    }

    articleData = findArticle(data)

    if (articleData) {
      console.log('X-Track: Found article data', articleData)

      // 提取文章内容
      let title = (articleData.title as string) || ''
      let content = ''

      // 如果有 content_blocks，从中提取文本
      if (articleData.content_blocks) {
        const paragraphs: string[] = []
        const blocks = articleData.content_blocks as Array<{ type?: string; text?: string }>
        for (const block of blocks) {
          if (block.type === 'paragraph' || block.type === 'text') {
            paragraphs.push(block.text || '')
          } else if (block.text) {
            paragraphs.push(block.text)
          }
        }
        content = paragraphs.join('\n\n')
      } else if (articleData.content) {
        content = articleData.content as string
      } else if (articleData.text) {
        content = articleData.text as string
      }

      // 如果未找到，从文章数据中获取推文 ID
      if (!tweetId && articleData.tweet_id) {
        tweetId = articleData.tweet_id as string
      }

      // 尝试从父推文数据中查找推文 ID
      if (!tweetId) {
        function findTweetId(obj: unknown): string | null {
          if (!obj || typeof obj !== 'object') return null
          if (
            obj &&
            typeof obj === 'object' &&
            '__typename' in obj &&
            obj.__typename === 'Tweet' &&
            'rest_id' in obj
          ) {
            return obj.rest_id as string
          }
          if (Array.isArray(obj)) {
            for (const item of obj) {
              const found = findTweetId(item)
              if (found) return found
            }
          } else if (obj && typeof obj === 'object') {
            for (const key in obj) {
              const found = findTweetId((obj as Record<string, unknown>)[key])
              if (found) return found
            }
          }
          return null
        }
        tweetId = findTweetId(data)
      }

      if (tweetId && (title || content)) {
        const articleContent = title ? `[Article] ${title}\n\n${content}` : content

        console.log(
          `X-Track: Updating tweet ${tweetId} with article content (${articleContent.length} chars)`
        )

        // 发送到后台脚本以更新推文
        chrome.runtime.sendMessage(
          {
            action: 'UPDATE_TWEET_CONTENT',
            data: {
              tweetId: tweetId,
              content: articleContent,
              tweetType: 'ARTICLE'
            }
          },
          response => {
            if (chrome.runtime.lastError) {
              console.error('X-Track: Error updating article content:', chrome.runtime.lastError.message)
            } else if (response?.success) {
              console.log('✅ X-Track: Article content saved for tweet', tweetId)
            }
          }
        )
      } else {
        console.warn('X-Track: Could not find tweet ID or content for article')
      }
    } else {
      console.warn('X-Track: Could not find article data in response')
    }
  } catch (e) {
    console.error('X-Track: Error processing article content:', e)
  }
}

/**
 * 从 DOM 抓取完整文章内容
 */
function scrapeArticleFromDOM(tweetId: string): void {
  console.log('X-Track: Attempting to scrape article content from DOM for tweet', tweetId)

  try {
    // Twitter Articles 显示在具有特定选择器的 article 容器中
    // 查找文章内容元素
    const articleSelectors = [
      '[data-testid="article-viewer-body"]',
      '[data-testid="article-viewer"]',
      'article[data-testid="article"]',
      '[data-testid="richTextBlock"]',
      '.r-pwxb5k [dir="auto"]', // 文章文本块
      '[data-testid="card.layoutLarge.detail"]',
      '[role="article"]'
    ]

    let articleContent = ''
    let articleTitle = ''

    // 尝试查找文章标题
    const titleSelectors = [
      '[data-testid="article-header"] h1',
      '[data-testid="article-viewer"] h1',
      'article h1'
    ]

    for (const selector of titleSelectors) {
      const title = document.querySelector(selector)
      if (title && title.textContent) {
        articleTitle = title.textContent.trim()
        break
      }
    }

    // 尝试查找文章内容
    for (const selector of articleSelectors) {
      const elements = document.querySelectorAll(selector)
      if (elements.length > 0) {
        const texts: string[] = []
        elements.forEach(el => {
          // 跳过如果是导航或其他非内容
          if (el.closest('[role="navigation"]')) return
          if (el.closest('[data-testid="primaryColumn"]') === null) return

          const text = el.innerText || el.textContent || ''
          if (text.length > 50) {
            // 仅包含实质文本块
            texts.push(text.trim())
          }
        })

        if (texts.length > 0) {
          articleContent = texts.join('\n\n')
          break
        }
      }
    }

    // 如果找到实质内容，更新推文
    if (articleContent && articleContent.length > 100) {
      const fullContent = articleTitle ? `${articleTitle}\n\n${articleContent}` : articleContent

      console.log(`X-Track: Scraped article from DOM (${fullContent.length} chars)`)

      chrome.runtime.sendMessage(
        {
          action: 'UPDATE_TWEET_CONTENT',
          data: {
            tweetId: tweetId,
            content: fullContent,
            tweetType: 'ARTICLE'
          }
        },
        response => {
          if (chrome.runtime.lastError) {
            console.error('X-Track: Error updating article from DOM:', chrome.runtime.lastError.message)
          } else if (response?.success) {
            console.log('✅ X-Track: Full article content saved from DOM')
          }
        }
      )
    } else {
      console.log('X-Track: Could not find article content in DOM')
    }
  } catch (e) {
    console.error('X-Track: Error scraping article from DOM:', e)
  }
}

/**
 * 自动同步拦截的推文到数据库
 */
function autoSyncTweets(tweets: TwitterTweet[], type: SaveType): void {
  if (!type) return

  const newTweets: ReturnType<typeof parseTweetFromApi>[] = []
  const currentUser = getCurrentUserScreenName()

  // 对于 MYTWEET 保存，用户在他们自己的配置文件上，所以我们可以使用配置文件页信息
  // 在 API 未提供时填充用户数据（Twitter 的 UserTweets API 不包含用户数据）
  const profileInfo = type === 'MYTWEET' ? getProfilePageUserInfo() : null

  for (const tweet of tweets) {
    if (!tweet.rest_id) continue

    const syncKey = `${type}:${tweet.rest_id}`
    if (syncedTweetIds.has(syncKey)) continue

    let parsed = parseTweetFromApi(tweet)
    if (parsed) {
      // 对于 MYTWEET：如果 API 未提供用户数据，使用配置文件页信息
      // 这是正确的，因为 MYTWEET 保存仅发生在用户自己的配置文件上
      if (
        type === 'MYTWEET' &&
        parsed.author?.screenName === 'unknown' &&
        profileInfo &&
        profileInfo.handle
      ) {
        console.log('X-Track Auto-Sync: Enriching MYTWEET with profile page info')
        parsed = {
          ...parsed,
          author: {
            ...parsed.author,
            screenName: profileInfo.handle,
            name: profileInfo.name || profileInfo.handle
          },
          authorId: profileInfo.handle
        }
      }

      // 对于书签，过滤掉当前用户自己的推文（它们不应该在书签中）
      if (
        type === 'BOOKMARK' &&
        currentUser &&
        parsed.author?.screenName &&
        parsed.author.screenName.toLowerCase() === currentUser
      ) {
        console.log(`X-Track Auto-Sync: Skipping own tweet ${parsed.id} from bookmarks`)
        syncedTweetIds.add(syncKey)
        continue
      }

      newTweets.push(parsed)
      syncedTweetIds.add(syncKey)
    }
  }

  if (newTweets.length === 0) {
    console.log(`X-Track Auto-Sync: No new tweets to sync for ${type}`)
    return
  }

  console.log(`X-Track Auto-Sync: Saving ${newTweets.length} ${type}s to database`)

  chrome.runtime.sendMessage(
    {
      action: 'SAVE_BATCH',
      data: {
        type: type,
        tweets: newTweets
      }
    },
    response => {
      if (chrome.runtime.lastError) {
        console.error('X-Track Auto-Sync: Runtime error:', chrome.runtime.lastError.message)
        // 从同步集合中移除以便重试
        newTweets.forEach(t => {
          if (t.id) syncedTweetIds.delete(`${type}:${t.id}`)
        })
        return
      }

      if (response?.success) {
        console.log(`✅ X-Track Auto-Sync: Successfully saved ${response.count} ${type}s`)
      } else {
        console.error('X-Track Auto-Sync: Failed to save:', response?.error)
        // 从同步集合中移除以便重试
        newTweets.forEach(t => {
          if (t.id) syncedTweetIds.delete(`${type}:${t.id}`)
        })
      }
    }
  )
}

/**
 * 清空同步的推文 ID 缓存
 */
export function clearSyncedTweetIds(): void {
  syncedTweetIds.clear()
}

/**
 * 获取已同步的推文 ID 集合
 */
export function getSyncedTweetIds(): Set<string> {
  return new Set(syncedTweetIds)
}
