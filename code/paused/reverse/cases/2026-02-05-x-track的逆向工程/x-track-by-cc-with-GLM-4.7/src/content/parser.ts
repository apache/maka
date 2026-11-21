/**
 * X-Track Content Script - 推文解析器
 *
 * 负责从 Twitter API 响应中解析推文数据
 */

import type { Tweet, TweetType, MediaItem, RetweetSource, QuotedTweet, MediaType } from '../types'
import type { TwitterTweet } from '../types/twitter-api'

/**
 * 从 Twitter API 响应解析推文
 */
export function parseTweetFromApi(tweet: TwitterTweet): Omit<
  Tweet,
  'authorId' | 'stats'
> & {
  likes: number
  retweets: number
  replies: number
  views: number
} | null {
  try {
    // 处理 TweetWithVisibilityResults 包装器
    const actualTweet =
      tweet.__typename === 'TweetWithVisibilityResults' ? tweet.tweet : tweet
    if (!actualTweet) {
      console.warn('X-Track: Empty tweet object')
      return null
    }

    const legacy = actualTweet.legacy || {}

    // 尝试多个路径获取用户数据（不同端点返回不同结构）
    let userLegacy:
      | {
          screen_name?: string
          name?: string
          profile_image_url_https?: string
        }
      | undefined

    // 路径1: 标准路径 - 首先检查 legacy（较旧的 API 格式）
    let userResult = actualTweet.core?.user_results?.result
    if (userResult?.legacy?.screen_name) {
      userLegacy = userResult.legacy
    }
    // 路径1b: 新 API 格式 - screen_name 移至 core.user_results.result.core
    else if (userResult?.core?.screen_name) {
      userLegacy = userResult.core
      // 如果新位置有头像，则增强头像信息
      if (userResult.avatar?.image_url) {
        userLegacy = {
          ...userLegacy,
          profile_image_url_https: userResult.avatar.image_url
        }
      }
    }
    // 路径1c: 处理 UserUnavailable - 用户被暂停/删除
    else if (userResult?.__typename === 'UserUnavailable') {
      userLegacy = {
        screen_name: '[unavailable]',
        name: '[User Unavailable]'
      }
    }
    // 路径1d: result 级别的用户数据，无 .legacy 包装器
    else if (userResult?.screen_name) {
      userLegacy = userResult
    }
    // 路径2: UserTweets 端点结构
    else if (actualTweet.user_results?.result?.legacy?.screen_name) {
      userLegacy = actualTweet.user_results.result.legacy
    }
    // 路径2b: UserTweets 新格式
    else if (actualTweet.user_results?.result?.core?.screen_name) {
      userLegacy = actualTweet.user_results.result.core
      if (actualTweet.user_results.result.avatar?.image_url) {
        userLegacy = {
          ...userLegacy,
          profile_image_url_https: actualTweet.user_results.result.avatar.image_url
        }
      }
    }
    // 路径2c: 处理 user_results 中的 UserUnavailable
    else if (actualTweet.user_results?.result?.__typename === 'UserUnavailable') {
      userLegacy = {
        screen_name: '[unavailable]',
        name: '[User Unavailable]'
      }
    }
    // 路径2d: user_results.result 中的用户数据，无 .legacy
    else if (actualTweet.user_results?.result?.screen_name) {
      userLegacy = actualTweet.user_results.result
    }
    // 路径3: 备用用户路径
    else if (actualTweet.user?.legacy?.screen_name) {
      userLegacy = actualTweet.user.legacy
    }
    // 路径4: 直接用户对象
    else if (actualTweet.user?.screen_name) {
      userLegacy = actualTweet.user
    }
    // 路径5: 检查 core 内部无 user_results
    else if (actualTweet.core?.user?.legacy?.screen_name) {
      userLegacy = actualTweet.core.user.legacy
    }

    // 如果仍无用户数据，不要使用配置文件页信息 - 那会分配错误头像
    // 只使用空对象，让它为 "unknown" 而非不正确
    if (!userLegacy || !userLegacy.screen_name) {
      console.warn(
        'X-Track: Could not find user data in expected API paths for tweet:',
        actualTweet.rest_id
      )
      userLegacy = {}
    }

    const noteTweet = actualTweet.note_tweet?.note_tweet_results?.result

    const id = actualTweet.rest_id
    const handle = userLegacy.screen_name || 'unknown'
    const author = userLegacy.name || handle
    let avatarUrl = userLegacy.profile_image_url_https || ''

    // 如果在 userLegacy 中未找到头像，检查备用 API 路径（仅检查 API 路径）
    if (!avatarUrl) {
      avatarUrl =
        actualTweet.core?.user_results?.result?.legacy?.profile_image_url_https ||
        actualTweet.core?.user_results?.result?.profile_image_url_https ||
        actualTweet.user_results?.result?.legacy?.profile_image_url_https ||
        actualTweet.user_results?.result?.profile_image_url_https ||
        actualTweet.user?.profile_image_url_https ||
        ''
    }

    let content = legacy.full_text || ''
    if (noteTweet?.text) {
      content = noteTweet.text
    }

    const timestamp = legacy.created_at
      ? new Date(legacy.created_at).toISOString()
      : new Date().toISOString()

    const likes = legacy.favorite_count || 0
    const retweets = legacy.retweet_count || 0
    const replies = legacy.reply_count || 0
    const views = actualTweet.views?.count ? parseInt(actualTweet.views.count, 10) : 0

    // 确定推文类型并提取转推的原始推文
    let tweetType: TweetType = TweetType.ORIGINAL
    let retweetedFrom: RetweetSource | undefined

    if (legacy.in_reply_to_status_id_str) {
      tweetType = TweetType.REPLY
    } else if (legacy.is_quote_status && actualTweet.quoted_status_result) {
      tweetType = TweetType.QUOTE
    } else if (legacy.retweeted_status_result) {
      tweetType = TweetType.RETWEET
      // 提取转推的原始推文信息
      const rtResult = legacy.retweeted_status_result.result
      if (rtResult) {
        const rtTweet =
          rtResult.__typename === 'TweetWithVisibilityResults' ? rtResult.tweet : rtResult
        if (rtTweet) {
          const rtLegacy = rtTweet.legacy || {}
          const rtUserResult =
            rtTweet.core?.user_results?.result ||
            rtTweet.user_results?.result ||
            rtTweet.user ||
            null

          // 首先尝试新 API 路径，然后回退到 legacy
          const rtUserCore = rtUserResult?.core || {}
          const rtUserLegacy = rtUserResult?.legacy || rtUserCore || {}
          const rtAvatar = rtUserResult?.avatar || {}

          retweetedFrom = {
            id: rtTweet.rest_id,
            author: rtUserCore.name || rtUserLegacy.name || rtUserLegacy.screen_name || 'unknown',
            content: rtLegacy.full_text || '',
            createdAt: rtLegacy.created_at
              ? new Date(rtLegacy.created_at).toISOString()
              : undefined
          }

          // 使用原始推文的内容而非 "RT @..." 格式
          if (retweetedFrom.content) {
            content = retweetedFrom.content
          }
        }
      }
    }

    // 对于引用推文，也提取被引用推文的信息
    let quotedTweet: QuotedTweet | undefined
    if (tweetType === TweetType.QUOTE && actualTweet.quoted_status_result?.result) {
      const quoted = actualTweet.quoted_status_result.result
      // 处理不同的包装器类型
      let quotedTweetObj = quoted
      if (quoted.__typename === 'TweetWithVisibilityResults') {
        quotedTweetObj = quoted.tweet
      } else if (quoted.__typename === 'TweetUnavailable') {
        // 推文被删除或不可用
        quotedTweetObj = null
      }

      if (quotedTweetObj) {
        const quotedLegacy = quotedTweetObj.legacy || {}
        // 尝试多个路径获取用户数据
        const quotedUserResult =
          quotedTweetObj.core?.user_results?.result ||
          quotedTweetObj.user_results?.result ||
          quotedTweetObj.user ||
          null

        // 首先尝试新 API 路径，然后回退到 legacy
        const quotedUserCore = quotedUserResult?.core || {}
        const quotedUserLegacy = quotedUserResult?.legacy || quotedUserCore || {}
        const quotedAvatar = quotedUserResult?.avatar || {}

        // 获取头像 URL，带回退（新 API 优先）
        const quotedAvatarUrl =
          quotedAvatar.image_url ||
          quotedUserLegacy.profile_image_url_https ||
          quotedUserResult?.profile_image_url_https ||
          ''

        // 获取用户名，带回退（新 API 优先）
        const quotedHandle =
          quotedUserCore.screen_name ||
          quotedUserLegacy.screen_name ||
          quotedUserResult?.screen_name ||
          quotedLegacy.user_id_str ||
          'unknown'

        // 获取名称，带回退（新 API 优先）
        const quotedAuthor =
          quotedUserCore.name ||
          quotedUserLegacy.name ||
          quotedUserResult?.name ||
          quotedHandle

        quotedTweet = {
          id: quotedTweetObj.rest_id || quotedLegacy.id_str,
          author: quotedAuthor,
          content: quotedLegacy.full_text || '',
          createdAt: quotedLegacy.created_at
            ? new Date(quotedLegacy.created_at).toISOString()
            : undefined
        }
      }
    }

    // 提取媒体
    const media: MediaItem[] = []
    const mediaEntities = legacy.entities?.media || []
    const extendedMedia = legacy.extended_entities?.media || []

    // 合并媒体列表，优先使用 extended
    const allMedia = [...extendedMedia]
    mediaEntities.forEach(m => {
      if (!allMedia.find(am => m.id_str === am.id_str)) {
        allMedia.push(m)
      }
    })

    allMedia.forEach(m => {
      let url = m.media_url_https
      let mediaType: MediaType = MediaType.PHOTO
      if (m.type === 'video') {
        mediaType = MediaType.VIDEO
      } else if (m.type === 'animated_gif') {
        mediaType = MediaType.GIF
      }

      if (type === 'video' && m.video_info?.variants) {
        // 查找最佳码率视频
        const variants = m.video_info.variants.filter(v => v.content_type === 'video/mp4')
        if (variants.length > 0) {
          variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
          url = variants[0].url
        }
      }

      media.push({
        type: mediaType,
        url,
        thumbnailUrl: mediaType === MediaType.VIDEO ? undefined : url,
        altText: m.ext_alt_text || undefined
      })
    })

    // 用户数据问题在配置文件页很常见，不要刷屏控制台

    return {
      id,
      authorId: handle, // 使用 handle 作为 authorId
      author: {
        id: handle,
        screenName: handle,
        name: author,
        avatarUrl: avatarUrl || undefined
      },
      content,
      createdAt: timestamp,
      stats: {
        likes,
        retweets,
        replies,
        views
      },
      tweetType,
      retweetedFrom,
      quotedTweet,
      media: media.length > 0 ? media : undefined,
      inReplyToTweetId: legacy.in_reply_to_status_id_str || undefined,
      inReplyToUserId: legacy.in_reply_to_user_id_str || undefined
    }
  } catch (e) {
    console.error('X-Track: Error parsing API tweet', e)
    return null
  }
}
