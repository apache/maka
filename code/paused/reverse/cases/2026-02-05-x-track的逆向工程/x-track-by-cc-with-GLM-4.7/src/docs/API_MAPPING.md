# X-Track Chrome 扩展 - API 端点映射表

## Twitter API 端点

### 已拦截的 API 端点

| 端点路径 | 用途 | 数据内容 | 自动同步 |
|---------|------|---------|---------|
| `/TweetDetail` | 推文详情页 | 单条推文完整数据 | 否 |
| `/TweetDetailByRestId` | 通过 ID 获取推文 | 单条推文完整数据 | 否 |
| `/UserTweets` | 用户推文列表 | 用户发布的推文 | MYTWEET（仅当浏览自己的主页时） |
| `/Bookmarks` | 书签列表 | 用户书签的推文 | BOOKMARK |
| `/Likes` | 点赞列表 | 用户点赞的推文 | LIKE |
| `/HomeTimeline` | 主页时间线 | 首页推文流 | 否 |
| `/UserMedia` | 用户媒体推文 | 用户带媒体的推文 | 否 |
| `/ArticleDetail` | 文章详情 | 长文章完整内容 | 否 |
| `/SearchTimeline` | 搜索结果 | 搜索结果推文 | 否 |
| `/ListLatestTweetsTimeline` | 列表推文 | 列表中的推文 | 否 |

### API 端点 URL 格式

```typescript
// TweetDetail
https://x.com/i/api/graphql/<hash>/TweetDetail?variables={"focalTweetId":"<tweetId>",...}

// UserTweets
https://x.com/i/api/graphql/<hash>/UserTweets?variables={"userId":"<userId>","count":20,...}

// Bookmarks
https://x.com/i/api/graphql/<hash>/Bookmarks?variables={"count":20,...}

// Likes
https://x.com/i/api/graphql/<hash>/Likes?variables={"userId":"<userId>","count":20,...}
```

## Twitter API 响应结构

### TweetDetail 响应

```json
{
  "data": {
    "tweet_result": {
      "result": {
        "__typename": "Tweet",
        "rest_id": "1234567890",
        "legacy": {
          "id_str": "1234567890",
          "created_at": "Wed Oct 01 00:00:00 +0000 2024",
          "full_text": "推文内容",
          "favorite_count": 100,
          "retweet_count": 50,
          "reply_count": 10,
          "quote_count": 5
        },
        "core": {
          "user_results": {
            "result": {
              "legacy": {
                "screen_name": "username",
                "name": "Display Name",
                "profile_image_url_https": "https://..."
              }
            }
          }
        }
      }
    }
  }
}
```

### UserTweets 响应

```json
{
  "data": {
    "user": {
      "result": {
        "timeline_response": {
          "timeline": {
            "instructions": [
              {
                "entries": [
                  {
                    "entryId": "tweet-1234567890",
                    "content": {
                      "itemContent": {
                        "tweet_results": {
                          "result": {
                            "__typename": "Tweet",
                            "rest_id": "1234567890",
                            ...
                          }
                        }
                      }
                    }
                  }
                ]
              }
            ]
          }
        }
      }
    }
  }
}
```

### Bookmarks 响应

```json
{
  "data": {
    "bookmark_timeline_v2": {
      "timeline": {
        "instructions": [
          {
            "entries": [
              {
                "entryId": "bookmark-1234567890",
                "content": {
                  "itemContent": {
                    "tweet_results": {
                      "result": { ... }
                    }
                  }
                }
              }
            ]
          }
        ]
      }
    }
  }
}
```

## 内部数据映射

### API 字段 → 内部字段

| API 字段 | 内部字段 | 类型 | 说明 |
|---------|---------|------|------|
| `rest_id` / `id_str` | `id` | string | 推文 ID |
| `legacy.full_text` | `content` | string | 推文内容 |
| `legacy.created_at` | `createdAt` | string | 创建时间（ISO 8601） |
| `legacy.favorite_count` | `stats.likes` | number | 点赞数 |
| `legacy.retweet_count` | `stats.retweets` | number | 转推数 |
| `legacy.reply_count` | `stats.replies` | number | 回复数 |
| `views.count` | `stats.views` | number | 浏览数 |
| `core.user_results.result.legacy.screen_name` | `author.screenName` | string | 用户名 |
| `core.user_results.result.legacy.name` | `author.name` | string | 显示名称 |
| `core.user_results.result.legacy.profile_image_url_https` | `author.avatarUrl` | string | 头像 URL |
| `legacy.entities.media` | `media` | MediaItem[] | 媒体附件 |
| `legacy.retweeted_status_result` | `retweetedFrom` | RetweetSource | 转推来源 |
| `legacy.quoted_status_result` | `quotedTweet` | QuotedTweet | 引用推文 |

### 推文类型判断

| 条件 | tweetType | 说明 |
|-----|-----------|------|
| `legacy.in_reply_to_status_id_str` 存在 | `REPLY` | 回复推文 |
| `legacy.is_quote_status` 为 true | `QUOTE` | 引用推文 |
| `legacy.retweeted_status_result` 存在 | `RETWEET` | 转推 |
| 上述都不是 | `ORIGINAL` | 原创推文 |
| API 响应包含文章内容 | `ARTICLE` | 长文章 |

## DOM 选择器映射

### 推文元素选择器

| 元素 | 选择器 | 获取方法 |
|-----|-------|---------|
| 推文容器 | `article[data-testid="tweet"]` | `querySelectorAll` |
| 推文 ID | `a[href*="/status/"]` | 提取 URL 中的 ID |
| 用户信息 | `div[data-testid="User-Name"]` | `querySelector` |
| 推文内容 | `div[data-testid="tweetText"]` | `innerText` |
| 头像 | `div[data-testid="Tweet-User-Avatar"] img` | `src` 属性 |
| 时间戳 | `time` | `datetime` 属性 |
| 点赞数 | `[data-testid="like"]` | `aria-label` 解析 |
| 转推数 | `[data-testid="retweet"]` | `aria-label` 解析 |
| 回复数 | `[data-testid="reply"]` | `aria-label` 解析 |
| 浏览数 | `[data-testid="viewCount"]` | `aria-label` 解析 |
| 媒体图片 | `div[data-testid="tweetPhoto"] img` | `src` 属性 |
| 媒体视频 | `div[data-testid="videoPlayer"] video` | `src` 属性 |

### 用户界面选择器

| 元素 | 选择器 | 用途 |
|-----|-------|------|
| 侧边栏账户切换器 | `[data-testid="SideNav_AccountSwitcher_Button"]` | 获取当前用户信息 |
| 配置文件链接 | `a[data-testid="AppTabBar_Profile_Link"]` | 获取用户名 |
| 书签按钮 | `[data-testid="bookmark"]` | 检测书签操作 |
| 取消书签按钮 | `[data-testid="removeBookmark"]` | 检测取消书签 |

## 消息类型映射

### Content → Background

| Action | 数据结构 | 处理函数 |
|--------|---------|---------|
| `SAVE_FOOTPRINT` | `{tweetData, durationMs}` | `handleSaveFootprint` |
| `SAVE_BOOKMARK` | `{tweetData}` | `handleSaveBookmark` |
| `SAVE_LIKE` | `{tweetData}` | `handleSaveLike` |
| `SAVE_MYTWEET` | `{tweetData}` | `handleSaveMyTweet` |
| `SAVE_HISTORY` | `{tweetData}` | `handleSaveHistory` |
| `SAVE_BATCH` | `{type, tweets[]}` | `handleSaveBatch` |
| `UPDATE_TWEET_CONTENT` | `{tweetId, content, tweetType}` | `handleUpdateTweetContent` |
| `GET_USER_INFO` | - | `extractUserInfo` |
| `START_MANUAL_SCRAPE` | `{pageType}` | `startManualCollection` |
| `START_AUTO_SCRAPE` | `{pageType, config}` | `startAutoScraping` |
| `STOP_SCRAPE` | - | `stopScraping` |
| `GET_SCRAPE_STATUS` | - | `getScrapingStatus` |
| `GET_SCRAPE_CONFIG` | - | `getScrapingConfig` |
| `UPDATE_SCRAPE_CONFIG` | `{config}` | `updateScrapingConfig` |

### Background → Content

| Action | 数据结构 | 触发条件 |
|--------|---------|---------|
| `SCRAPE_STARTED` | `{mode, pageType}` | 抓取开始 |
| `SCRAPE_STOPPED` | `{mode, totalScraped, reason}` | 抓取停止 |

## 数据库表映射

### tweets 表

```typescript
// 主键
id: string  // 推文 ID

// 索引
authorId: string      // 作者 ID（用于查询用户的所有推文）
createdAt: string     // 创建时间（用于时间范围查询）
storedAt: string      // 存储时间（用于清理）
tweetType: string     // 推文类型（用于类型筛选）

// 全文搜索
textTokens: string[]  // 分词后的文本标记
```

### users 表

```typescript
// 主键
id: string  // 用户 ID（通常是 screen_name）

// 索引
screenName: string  // 用户名（用于搜索）
storedAt: string    // 存储时间
```

### history 表

```typescript
// 主键（自增）
++id: number  // 自增主键

// 索引
tweetId: string   // 推文 ID（用于查询某条推文的浏览历史）
viewedAt: number  // 浏览时间（用于时间范围查询）
type: string      // 浏览类型（CLICK/DWELL/SCRAPE）

// 复合查询
// tweetId + viewedAt（用于去重）
```

## 统计查询映射

### 热门推文

```typescript
// 按浏览次数排序
db.history
  .where('tweetId')
  .equals(tweetId)
  .and(entry => ...)
```

### 活跃作者

```typescript
// 按推文数量分组
db.tweets
  .toArray()
  .then(tweets => {
    const byAuthor = groupBy(tweets, 'authorId')
    return sortByCount(byAuthor)
  })
```

### 浏览时长

```typescript
// 累计浏览时长
db.history
  .where('tweetId')
  .equals(tweetId)
  .toArray()
  .then(entries => {
    return sum(entries, 'durationSeconds')
  })
```
