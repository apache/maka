/**
 * X-Track Chrome 扩展 - Twitter API 类型定义
 *
 * 此文件定义了 Twitter/X API 响应的数据结构
 */

/**
 * Twitter API 响应基础结构
 */
export interface TwitterApiResponse {
  data?: unknown
  errors?: TwitterApiError[]
}

/**
 * Twitter API 错误
 */
export interface TwitterApiError {
  message: string
  code: number
}

/**
 * Twitter 用户信息
 */
export interface TwitterUser {
  rest_id: string
  id: string
  legacy: {
    id_str: string
    name: string
    screen_name: string
    description?: string
    location?: string
    url?: string
    followers_count: number
    friends_count: number
    listed_count: number
    favourites_count: number
    statuses_count: number
    created_at: string
    profile_image_url_https?: string
    profile_banner_url?: string
    verified: boolean
    protected: boolean
    can_dm?: boolean
    following?: boolean
    followed_by?: boolean
  }
  is_blue_verified?: boolean
  professional?: {
    rest_id: string
    category: string[]
  }
}

/**
 * Twitter 媒体实体
 */
export interface TwitterMediaEntity {
  id_str: string
  media_url_https: string
  type: 'photo' | 'video' | 'animated_gif'
  url?: string
  expanded_url?: string
  display_url: string
  ext_alt_text?: string
  media_stats?: {
    view_count?: number
  }
  video_info?: {
      duration_millis: number
      variants: Array<{
        content_type: string
        url: string
        bitrate?: number
      }>
  }
  sizes?: {
    large: TwitterMediaSize
    medium: TwitterMediaSize
    small: TwitterMediaSize
    thumb: TwitterMediaSize
  }
}

/**
 * 媒体尺寸信息
 */
export interface TwitterMediaSize {
  w: number
  h: number
  resize: 'crop' | 'fit'
}

/**
 * Twitter URL 实体
 */
export interface TwitterUrlEntity {
  url: string
  expanded_url: string
  display_url: string
  indices: [number, number]
}

/**
 * Twitter 话题标签实体
 */
export interface TwitterHashtagEntity {
  text: string
  indices: [number, number]
}

/**
 * Twitter 用户提及实体
 */
export interface TwitterMentionEntity {
  screen_name: string
  name: string
  id_str: string
  indices: [number, number]
}

/**
 * Twitter 实体
 */
export interface TwitterEntities {
  urls?: TwitterUrlEntity[]
  hashtags?: TwitterHashtagEntity[]
  user_mentions?: TwitterMentionEntity[]
  media?: TwitterMediaEntity[]
}

/**
 * Twitter 推文绑定信息
 */
export interface TwitterTweetBindingValues {
  id_str?: string
  screen_name?: string
  name?: string
  user_id_str?: string
  tweet_results?: {
    result?: TwitterTweetResult
  }
}

/**
 * Twitter 推文结果（包装类型）
 */
export type TwitterTweetResult =
  | TwitterTweet
  | { __typename: 'TweetUnavailable'; reason: string }
  | { __typename: 'TweetTombstone'; tombstone: unknown }
  | null

/**
 * Twitter 推文核心结构
 */
export interface TwitterTweet {
  rest_id: string
  id: string
  legacy: {
    id_str: string
    created_at: string
    full_text: string
    display_text_range?: [number, number]
    source: string
    truncated: boolean
    in_reply_to_status_id_str?: string
    in_reply_to_user_id_str?: string
    in_reply_to_screen_name?: string
    user_id_str: string
    entities?: TwitterEntities
    extended_entities?: {
      media?: TwitterMediaEntity[]
    }
    favorite_count: number
    retweet_count: number
    reply_count: number
    quote_count: number
    view_count?: number
    bookmark_count?: number
    quoted_status_id_str?: string
    quoted_status?: TwitterTweet
    retweeted_status_id_str?: string
    retweeted_status?: TwitterTweet
    possibly_sensitive?: boolean
    filter_level: string
    lang: string
    self_thread_ref?: {
      id_str: string
    }
    conversation_id_str: string
  }
  core: {
    user_results: {
      result: TwitterUser
    }
  }
  quote_count?: number
  reply_count?: number
  retweet_count?: number
  favorite_count?: number
  views?: {
    count: string
  }
  bookmark_count?: number
  quoted_status_result?: {
    result?: TwitterTweetResult
  }
  quoted_status?: TwitterTweet
  retweeted_status_result?: {
    result?: TwitterTweetResult
  }
  retweeted_status?: TwitterTweet
  legacy_retweet_count?: number
  legacy_favorite_count?: number
  self_thread?: {
    id_str: string
  }
  __typename?: string
}

/**
 * TweetDetail API 响应
 * 端点: /TweetDetail
 */
export interface TweetDetailResponse {
  data?: {
    tweet_result?: {
      result?: TwitterTweetResult
    }
  }
}

/**
 * UserTweets API 响应
 * 端点: /UserTweets
 */
export interface UserTweetsResponse {
  data?: {
    user?: {
      result?: {
        timeline_response?: {
          timeline?: {
            instructions: Array<{
              entries?: Array<{
                entryId: string
                content?: {
                  itemContent?: {
                    tweet_results?: {
                      result?: TwitterTweetResult
                    }
                  }
                }
              }>
            }>
          }
        }
      }
    }
  }
}

/**
 * Bookmarks API 响应
 * 端点: /Bookmarks
 */
export interface BookmarksResponse {
  data?: {
    bookmark_timeline_v2?: {
      timeline?: {
        instructions: Array<{
          entries?: Array<{
            entryId: string
            content?: {
              itemContent?: {
                tweet_results?: {
                  result?: TwitterTweetResult
                }
              }
            }
          }>
        }>
      }
    }
  }
}

/**
 * Likes API 响应
 * 端点: /Likes
 */
export interface LikesResponse {
  data?: {
    user?: {
      result?: {
        timeline_v2?: {
          timeline?: {
            instructions: Array<{
              entries?: Array<{
                entryId: string
                content?: {
                  itemContent?: {
                    tweet_results?: {
                      result?: TwitterTweetResult
                    }
                  }
                }
              }>
            }>
          }
        }
      }
    }
  }
}

/**
 * TweetDetailByRestId API 响应
 * 端点: /graphql/.../TweetDetailByRestId
 */
export interface TweetDetailByRestIdResponse {
  data?: {
    tweet_result?: {
      result?: TwitterTweetResult
    }
  }
}

/**
 * SearchTimeline API 响应
 * 端点: /SearchTimeline
 */
export interface SearchTimelineResponse {
  data?: {
    search_by_raw_query?: {
      search_timeline?: {
        timeline?: {
          instructions: Array<{
            entries?: Array<{
              entryId: string
              content?: {
                itemContent?: {
                  tweet_results?: {
                    result?: TwitterTweetResult
                  }
                }
              }
            }
          }>
        }
      }
    }
  }
}

/**
 * HomeTimeline API 响应
 * 端点: /HomeTimeline
 */
export interface HomeTimelineResponse {
  data?: {
    home_timeline?: {
      timeline?: {
        instructions: Array<{
          entries?: Array<{
            entryId: string
            content?: {
              itemContent?: {
                tweet_results?: {
                  result?: TwitterTweetResult
                }
              }
            }
          }>
        }>
      }
    }
  }
}

/**
 * ListLatestTweetsTimeline API 响应
 * 端点: /ListLatestTweetsTimeline
 */
export interface ListLatestTweetsTimelineResponse {
  data?: {
    list?: {
      timeline_response?: {
        timeline?: {
          instructions: Array<{
            entries?: Array<{
              entryId: string
              content?: {
                itemContent?: {
                  tweet_results?: {
                    result?: TwitterTweetResult
                  }
                }
              }
            }
          }>
        }
      }
    }
  }
}

/**
 * Tweet 字典类型（用于快速查找）
 */
export type TweetDictionary = Record<string, TwitterTweet>

/**
 * 用户字典类型
 */
export type UserDictionary = Record<string, TwitterUser>

/**
 * 指令类型
 */
export interface TimelineInstruction {
  type?: string
  entries?: Array<{
    entryId: string
    content?: {
      itemContent?: {
        tweet_results?: {
          result?: TwitterTweetResult
        }
      }
      cursorType?: string
    }
  }>
  moduleItems?: Array<unknown>
}

/**
 * Timeline 响应包装
 */
export interface TimelineResponse {
  instructions: TimelineInstruction[]
}
