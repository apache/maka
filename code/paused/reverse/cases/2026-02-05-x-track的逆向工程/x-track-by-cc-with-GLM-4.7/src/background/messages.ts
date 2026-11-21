/**
 * X-Track Background Script - 消息处理模块
 *
 * 处理来自 content script 和 popup 的消息
 */

import { db } from '../storage/database'
import { tokenizeText } from '../storage/utils'

/**
 * 消息类型
 */
type MessageType =
  | 'SAVE_FOOTPRINT'
  | 'SAVE_BOOKMARK'
  | 'SAVE_LIKE'
  | 'SAVE_MYTWEET'
  | 'SAVE_HISTORY'
  | 'SAVE_BATCH'
  | 'UPDATE_TWEET_CONTENT'
  | 'GET_USER_INFO'
  | 'GET_STATS'

/**
 * 消息数据接口
 */
interface MessageData {
  SAVE_FOOTPRINT: {
    tweetData: ScrapedTweetData
    durationMs: number
  }
  SAVE_BOOKMARK: {
    tweetData: ScrapedTweetData
  }
  SAVE_LIKE: {
    tweetData: ScrapedTweetData
  }
  SAVE_MYTWEET: {
    tweetData: ScrapedTweetData
  }
  SAVE_HISTORY: {
    tweetData: ScrapedTweetData
  }
  SAVE_BATCH: {
    type: 'BOOKMARK' | 'LIKE' | 'MYTWEET' | 'HISTORY'
    tweets: ScrapedTweetData[]
  }
  UPDATE_TWEET_CONTENT: {
    tweetId: string
    content: string
    tweetType?: string
  }
  GET_USER_INFO: Record<string, never>
  GET_STATS: Record<string, never>
}

/**
 * 抓取的推文数据（简化版）
 */
interface ScrapedTweetData {
  id: string
  handle: string
  author: string
  avatarUrl: string
  content: string
  timestamp: string
  likes: number
  retweets: number
  replies: number
  views: number
  isReply?: boolean
  tweetType?: string
  retweetedFrom?: RetweetSource | null
  quotedTweet?: QuotedTweet | null
  media?: unknown[]
}

interface RetweetSource {
  handle: string
  author: string
  avatarUrl: string
}

interface QuotedTweet {
  handle: string
  author: string
  avatarUrl: string
}

/**
 * 消息响应
 */
interface MessageResponse {
  success: boolean
  error?: string
  count?: number
}

/**
 * 保存推文和用户到数据库
 */
async function saveTweetAndUser(tweetData: ScrapedTweetData): Promise<void> {
  if (!tweetData || !tweetData.id) {
    throw new Error('Invalid tweet data')
  }

  const { tweets, users } = db

  // 保存推文
  await tweets.put({
    id: tweetData.id,
    authorId: tweetData.handle,
    content: tweetData.content,
    createdAt: tweetData.timestamp,
    textTokens: tokenizeText(tweetData.content),
    likes: tweetData.likes,
    retweets: tweetData.retweets,
    replies: tweetData.replies,
    views: tweetData.views,
    tweetType: tweetData.tweetType || 'ORIGINAL',
    retweetedFrom: tweetData.retweetedFrom || null,
    quotedTweet: tweetData.quotedTweet || null,
    media: tweetData.media
  })

  // 保存用户
  if (tweetData.handle && tweetData.handle !== 'unknown') {
    await users.put({
      id: tweetData.handle,
      screenName: tweetData.handle,
      name: tweetData.author || tweetData.handle,
      avatarUrl: tweetData.avatarUrl || ''
    })
  }

  // 保存转推来源用户
  if (tweetData.retweetedFrom?.handle && tweetData.retweetedFrom.handle !== 'unknown') {
    await users.put({
      id: tweetData.retweetedFrom.handle,
      screenName: tweetData.retweetedFrom.handle,
      name: tweetData.retweetedFrom.author || tweetData.retweetedFrom.handle,
      avatarUrl: tweetData.retweetedFrom.avatarUrl || ''
    })
  }

  // 保存引用推文用户
  if (tweetData.quotedTweet?.handle && tweetData.quotedTweet.handle !== 'unknown') {
    await users.put({
      id: tweetData.quotedTweet.handle,
      screenName: tweetData.quotedTweet.handle,
      name: tweetData.quotedTweet.author || tweetData.quotedTweet.handle,
      avatarUrl: tweetData.quotedTweet.avatarUrl || ''
    })
  }
}

/**
 * 处理 SAVE_FOOTPRINT 消息
 */
async function handleSaveFootprint(data: MessageData['SAVE_FOOTPRINT']): Promise<void> {
  console.log('X-Track Background: Saving footprint for tweet', data.tweetData?.id)

  if (!data.tweetData || !data.tweetData.id) {
    throw new Error('Invalid tweet data for footprint')
  }

  if (!data.tweetData.handle || data.tweetData.handle === 'unknown') {
    console.log('X-Track: Skipping footprint save - unknown user handle')
    return
  }

  const { tweets, users, history } = db

  // 保存推文
  await tweets.put({
    id: data.tweetData.id,
    authorId: data.tweetData.handle,
    content: data.tweetData.content,
    createdAt: data.tweetData.timestamp,
    textTokens: tokenizeText(data.tweetData.content),
    likes: data.tweetData.likes,
    retweets: data.tweetData.retweets,
    replies: data.tweetData.replies,
    views: data.tweetData.views,
    tweetType: data.tweetData.tweetType || 'ORIGINAL',
    retweetedFrom: data.tweetData.retweetedFrom || null,
    quotedTweet: data.tweetData.quotedTweet || null,
    media: data.tweetData.media
  })

  // 保存用户
  await users.put({
    id: data.tweetData.handle,
    screenName: data.tweetData.handle,
    name: data.tweetData.author,
    avatarUrl: data.tweetData.avatarUrl
  })

  // 检查是否有重复的历史记录（60秒内）
  const duplicate = await history
    .where('tweetId')
    .equals(data.tweetData.id)
    .and(entry => Date.now() - entry.viewedAt < 60000)
    .first()

  if (duplicate) {
    console.log('X-Track: Duplicate footprint skipped')
    return
  }

  // 保存历史记录
  await history.add({
    tweetId: data.tweetData.id,
    viewedAt: Date.now(),
    durationSeconds: Math.round(data.durationMs / 1000),
    type: data.durationMs > 10000 ? 'DWELL' : 'CLICK'
  })

  console.log('✅ X-Track: Footprint saved to IndexedDB')
}

/**
 * 处理 SAVE_BOOKMARK 消息
 */
async function handleSaveBookmark(data: MessageData['SAVE_BOOKMARK']): Promise<void> {
  console.log('X-Track Background: Saving bookmark for tweet', data.tweetData?.id)

  if (!data.tweetData?.handle || data.tweetData.handle === 'unknown') {
    console.log('X-Track: Skipping bookmark save - unknown user handle')
    return
  }

  await saveTweetAndUser(data.tweetData)

  const { bookmarks } = db
  await bookmarks.put({
    tweetId: data.tweetData.id,
    addedAt: Date.now(),
    tags: [],
    synced: false
  })

  console.log('✅ X-Track: Bookmark saved to IndexedDB')
}

/**
 * 处理 SAVE_LIKE 消息
 */
async function handleSaveLike(data: MessageData['SAVE_LIKE']): Promise<void> {
  console.log('X-Track Background: Saving like for tweet', data.tweetData?.id)

  if (!data.tweetData?.handle || data.tweetData.handle === 'unknown') {
    console.log('X-Track: Skipping like save - unknown user handle')
    return
  }

  await saveTweetAndUser(data.tweetData)

  const { likes } = db
  await likes.put({
    tweetId: data.tweetData.id,
    addedAt: Date.now(),
    synced: false
  })

  console.log('✅ X-Track: Like saved to IndexedDB')
}

/**
 * 处理 SAVE_MYTWEET 消息
 */
async function handleSaveMyTweet(data: MessageData['SAVE_MYTWEET']): Promise<void> {
  console.log('X-Track Background: Saving myTweet for tweet', data.tweetData?.id)

  if (!data.tweetData?.handle || data.tweetData.handle === 'unknown') {
    console.log('X-Track: Skipping myTweet save - unknown user handle')
    return
  }

  await saveTweetAndUser(data.tweetData)

  const { myTweets } = db
  await myTweets.put({
    id: data.tweetData.id,
    createdAt: Date.now(),
    synced: false
  })

  console.log('✅ X-Track: MyTweet saved to IndexedDB')
}

/**
 * 处理 SAVE_HISTORY 消息
 */
async function handleSaveHistory(data: MessageData['SAVE_HISTORY']): Promise<void> {
  console.log('X-Track Background: Saving history for tweet', data.tweetData?.id)

  if (!data.tweetData?.handle || data.tweetData.handle === 'unknown') {
    console.log('X-Track: Skipping history save - unknown user handle')
    return
  }

  await saveTweetAndUser(data.tweetData)

  const { history } = db

  // 检查重复
  const existing = await history.where('tweetId').equals(data.tweetData.id).first()
  if (existing) {
    console.log('X-Track: Duplicate history entry skipped')
    return
  }

  await history.add({
    tweetId: data.tweetData.id,
    viewedAt: Date.now(),
    durationSeconds: 0,
    type: 'SCRAPE'
  })

  console.log('✅ X-Track: History entry saved to IndexedDB')
}

/**
 * 处理 UPDATE_TWEET_CONTENT 消息
 */
async function handleUpdateTweetContent(data: MessageData['UPDATE_TWEET_CONTENT']): Promise<void> {
  console.log('X-Track Background: Updating tweet content for', data.tweetId)

  const { tweets } = db
  const existing = await tweets.get(data.tweetId)

  if (existing) {
    await tweets.update(data.tweetId, {
      content: data.content,
      tweetType: (data.tweetType as any) || existing.tweetType,
      textTokens: tokenizeText(data.content)
    })
    console.log('✅ X-Track: Updated tweet content with article')
  } else {
    console.log('X-Track: Tweet not found to update, saving as new')
    await tweets.put({
      id: data.tweetId,
      authorId: 'unknown',
      content: data.content,
      createdAt: new Date().toISOString(),
      textTokens: tokenizeText(data.content),
      likes: 0,
      retweets: 0,
      replies: 0,
      views: 0,
      tweetType: (data.tweetType as any) || 'ARTICLE',
      media: []
    })
  }
}

/**
 * 获取保存处理器
 */
function getSaveHandler(type: MessageData['SAVE_BATCH']['type']): ((data: MessageData['SAVE_BOOKMARK']) => Promise<void>) | null {
  switch (type) {
    case 'BOOKMARK':
      return handleSaveBookmark
    case 'LIKE':
      return handleSaveLike
    case 'MYTWEET':
      return handleSaveMyTweet
    case 'HISTORY':
      return handleSaveHistory
    default:
      return null
  }
}

/**
 * 处理 SAVE_BATCH 消息
 */
async function handleSaveBatch(data: MessageData['SAVE_BATCH']): Promise<void> {
  console.log(`X-Track Background: Handling SAVE_BATCH (${data.type})`, data.tweets.length)

  const handler = getSaveHandler(data.type)
  if (!handler) {
    throw new Error('Unknown type')
  }

  await Promise.all(data.tweets.map(tweet => handler({ tweetData: tweet })))
}

/**
 * 设置消息监听器
 */
export function setupMessageListener(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const action = message.action as MessageType
    const data = message.data as any

    console.log('X-Track Background: Received message:', action)

    switch (action) {
      case 'SAVE_FOOTPRINT':
        handleSaveFootprint(data)
          .then(() => sendResponse({ success: true }))
          .catch(error => sendResponse({ success: false, error: error.message }))
        return true

      case 'SAVE_BOOKMARK':
        handleSaveBookmark(data)
          .then(() => sendResponse({ success: true }))
          .catch(error => sendResponse({ success: false, error: error.message }))
        return true

      case 'SAVE_BATCH':
        handleSaveBatch(data)
          .then(() => sendResponse({ success: true, count: data.tweets.length }))
          .catch(error => sendResponse({ success: false, error: error.message }))
        return true

      case 'UPDATE_TWEET_CONTENT':
        handleUpdateTweetContent(data)
          .then(() => sendResponse({ success: true }))
          .catch(error => sendResponse({ success: false, error: error.message }))
        return true

      default:
        console.log('X-Track Background: Unknown action:', action)
        sendResponse({ success: false, error: 'Unknown action' })
        return false
    }
  })
}
