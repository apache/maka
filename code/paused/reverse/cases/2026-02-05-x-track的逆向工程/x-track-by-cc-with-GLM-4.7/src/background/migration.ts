/**
 * X-Track Background Script - 数据迁移模块
 *
 * 负责从 chrome.storage 迁移数据到 IndexedDB
 */

import { db } from '../storage/database'

/**
 * 迁移数据结构
 */
interface LegacyHistoryEntry {
  tweetId: string
  timestamp: number
  durationSeconds: number
  type?: string
  tweetData?: {
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
    isReply: boolean
    media: unknown[]
  }
}

interface LegacyBookmark {
  id: string
}

interface LegacyLike {
  id: string
}

/**
 * 检查是否需要迁移
 */
export async function needsMigration(): Promise<boolean> {
  const storage = chrome?.storage?.local
  if (!storage) {
    return false
  }

  return new Promise(resolve => {
    storage.get(['xtrack_migration_complete'], result => {
      resolve(!result.xtrack_migration_complete)
    })
  })
}

/**
 * 从 chrome.storage 迁移数据到 IndexedDB
 */
export async function migrateFromChromeStorage(): Promise<void> {
  console.log('X-Track: Starting migration from chrome.storage to IndexedDB...')

  const storage = chrome?.storage?.local
  if (!storage) {
    console.warn('X-Track: chrome.storage not available, skipping migration')
    return
  }

  try {
    // 获取旧数据
    const data = await new Promise<{
      xtrack_history?: LegacyHistoryEntry[]
      xtrack_bookmarks?: LegacyBookmark[]
      xtrack_likes?: LegacyLike[]
    }>(resolve => {
      storage.get(['xtrack_history', 'xtrack_bookmarks', 'xtrack_likes'], resolve)
    })

    const historyEntries = data.xtrack_history || []
    const bookmarks = data.xtrack_bookmarks || []
    const likes = data.xtrack_likes || []

    console.log(
      `X-Track: Found ${historyEntries.length} history entries, ${bookmarks.length} bookmarks, ${likes.length} likes`
    )

    // 迁移历史记录
    if (historyEntries.length > 0) {
      await migrateHistory(historyEntries)
    }

    // 迁移书签
    if (bookmarks.length > 0) {
      await migrateBookmarks(bookmarks)
    }

    // 迁移点赞
    if (likes.length > 0) {
      await migrateLikes(likes)
    }

    // 标记迁移完成
    await new Promise<void>(resolve => {
      storage.set({ xtrack_migration_complete: true }, () => {
        resolve()
      })
    })

    console.log('✅ X-Track: Migration completed successfully!')
  } catch (error) {
    console.error('X-Track: Migration error:', error)
    throw error
  }
}

/**
 * 迁移历史记录
 */
async function migrateHistory(historyEntries: LegacyHistoryEntry[]): Promise<void> {
  const { history, tweets, users } = db

  // 迁移历史条目
  const historyData = historyEntries.map(entry => ({
    tweetId: entry.tweetId,
    viewedAt: entry.timestamp,
    durationSeconds: entry.durationSeconds,
    type: entry.type || 'CLICK'
  }))

  await history.bulkAdd(historyData)

  // 提取唯一的推文和用户
  const tweetSet = new Set<string>()
  const userSet = new Set<string>()
  const tweetsToAdd: unknown[] = []
  const usersToAdd: unknown[] = []

  for (const entry of historyEntries) {
    if (entry.tweetData && !tweetSet.has(entry.tweetData.id)) {
      tweetSet.add(entry.tweetData.id)
      tweetsToAdd.push({
        id: entry.tweetData.id,
        authorId: entry.tweetData.handle,
        content: entry.tweetData.content,
        createdAt: entry.tweetData.timestamp,
        likes: entry.tweetData.likes,
        retweets: entry.tweetData.retweets,
        replies: entry.tweetData.replies,
        views: entry.tweetData.views,
        tweetType: 'ORIGINAL',
        media: entry.tweetData.media
      })

      if (entry.tweetData.handle && !userSet.has(entry.tweetData.handle)) {
        userSet.add(entry.tweetData.handle)
        usersToAdd.push({
          id: entry.tweetData.handle,
          screenName: entry.tweetData.handle,
          name: entry.tweetData.author,
          avatarUrl: entry.tweetData.avatarUrl
        })
      }
    }
  }

  if (tweetsToAdd.length > 0) {
    await tweets.bulkAdd(tweetsToAdd)
  }

  if (usersToAdd.length > 0) {
    await users.bulkAdd(usersToAdd)
  }

  console.log(
    `X-Track: Migrated ${historyData.length} history entries, ${tweetsToAdd.length} tweets, ${usersToAdd.length} users`
  )
}

/**
 * 迁移书签
 */
async function migrateBookmarks(bookmarks: LegacyBookmark[]): Promise<void> {
  const { bookmarks: bookmarkTable } = db

  const bookmarkData = bookmarks.map(b => ({
    tweetId: b.id,
    addedAt: Date.now(),
    tags: [],
    synced: false
  }))

  await bookmarkTable.bulkAdd(bookmarkData)
  console.log(`X-Track: Migrated ${bookmarkData.length} bookmarks`)
}

/**
 * 迁移点赞
 */
async function migrateLikes(likes: LegacyLike[]): Promise<void> {
  const { likes: likesTable } = db

  const likeData = likes.map(l => ({
    tweetId: l.id,
    addedAt: Date.now()
  }))

  await likesTable.bulkAdd(likeData)
  console.log(`X-Track: Migrated ${likeData.length} likes`)
}
