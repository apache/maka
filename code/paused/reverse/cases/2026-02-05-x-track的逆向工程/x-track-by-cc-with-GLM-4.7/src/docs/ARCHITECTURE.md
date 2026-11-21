# X-Track Chrome 扩展 - 架构文档

## 概述

X-Track 是一个 Chrome 扩展，用于追踪和分析用户在 Twitter/X.com 上的浏览行为，并提供数据抓取和存储功能。

## 技术栈

- **前端框架**: React (通过 vendor chunk)
- **状态管理**: Chrome Extension Message Passing
- **数据库**: IndexedDB (通过 Dexie.js)
- **构建工具**: Webpack 5
- **语言**: TypeScript (还原后)

## 目录结构

```
src/
├── types/              # 类型定义
│   ├── index.ts        # 核心类型
│   ├── twitter-api.ts  # Twitter API 类型
│   ├── storage.ts      # 存储类型
│   ├── messages.ts     # 消息通信类型
│   ├── config.ts       # 配置类型
│   └── utils.ts        # 工具类型
├── content/            # Content Scripts
│   ├── index.ts        # 主入口
│   ├── interceptor.ts  # 网络拦截处理
│   ├── cache.ts        # 推文缓存
│   ├── parser.ts       # API 数据解析
│   ├── scraper.ts      # DOM 抓取
│   ├── observer.ts     # 浏览追踪
│   ├── scraping.ts     # 智能抓取
│   ├── floating-ui.ts  # 浮动 UI
│   └── utils.ts        # DOM 工具函数
├── background/         # Background Service Worker
│   ├── index.ts        # 主入口
│   ├── migration.ts    # 数据迁移
│   └── messages.ts     # 消息处理
├── inject/             # Injected Script
│   └── interceptor.ts  # 网络拦截器
├── storage/            # 数据库层
│   ├── database.ts     # Dexie.js 数据库
│   ├── adapter.ts      # 存储适配器
│   └── utils.ts        # 存储工具函数
└── docs/               # 文档
    ├── ARCHITECTURE.md
    ├── DATA_FLOW.md
    ├── API_MAPPING.md
    └── SECURITY_AUDIT.md
```

## 核心组件

### 1. Inject Script (inject/interceptor.ts)

**作用**: 在页面主上下文中运行，拦截网络请求

**关键功能**:
- 拦截 XMLHttpRequest
- 拦截 Fetch API
- 识别 Twitter API 端点
- 将拦截的数据发送到 content script

**目标 API 端点**:
- `/TweetDetail` - 推文详情
- `/UserTweets` - 用户推文列表
- `/Bookmarks` - 书签列表
- `/Likes` - 点赞列表
- `/HomeTimeline` - 主页时间线
- `/ArticleDetail` - 文章内容

### 2. Content Script (content/)

**作用**: 在 Twitter 页面上下文中运行，负责数据收集和用户交互

**模块划分**:

#### index.ts - 主入口
- 初始化所有子系统
- 设置消息监听器
- 管理生命周期

#### interceptor.ts - 网络拦截处理
- 处理来自 inject script 的数据
- 自动同步推文（书签/点赞/用户推文）
- 处理文章内容提取

#### cache.ts - 推文缓存
- 缓存网络拦截的推文
- TTL 管理（默认 5 分钟）
- 最大缓存大小（默认 1000 条）

#### parser.ts - API 数据解析
- 解析 Twitter API 响应
- 处理多种 API 格式（新旧格式）
- 提取用户、推文、媒体数据

#### scraper.ts - DOM 抓取
- 作为网络拦截的备用方案
- 从 DOM 提取推文数据
- 处理动态加载的内容

#### observer.ts - 浏览追踪
- 使用 IntersectionObserver 追踪可见推文
- 计算浏览时长
- 记录浏览历史

#### scraping.ts - 智能抓取
- **手动模式**: 被动收集，用户自然滚动时收集
- **自动模式**: 自动滚动抓取，模拟人类行为
- 支持批量抓取
- 配置化抓取参数

#### floating-ui.ts - 浮动 UI
- 在特定页面显示抓取按钮
- 显示抓取状态
- 提供开始/停止控制

### 3. Background Service Worker (background/)

**作用**: 作为扩展的中心协调器，处理数据持久化和消息路由

**模块划分**:

#### index.ts - 主入口
- 处理扩展安装/更新
- 触发数据迁移

#### migration.ts - 数据迁移
- 从 chrome.storage 迁移到 IndexedDB
- 处理旧版本数据
- 迁移验证

#### messages.ts - 消息处理
- 处理来自 content script 的消息
- 数据验证
- 数据库操作

### 4. Storage Layer (storage/)

**作用**: 提供 IndexedDB 数据访问接口

**数据库结构**:

```typescript
// 推文表
tweets: {
  id: string              // 推文 ID
  authorId: string        // 作者 ID
  content: string         // 推文内容
  createdAt: string       // 创建时间
  textTokens: string[]    // 用于搜索的标记
  likes: number           // 点赞数
  retweets: number        // 转推数
  replies: number         // 回复数
  views: number           // 浏览数
  tweetType: string       // 推文类型
  media: MediaItem[]      // 媒体附件
}

// 用户表
users: {
  id: string              // 用户 ID
  screenName: string      // 用户名
  name: string            // 显示名称
  avatarUrl: string       // 头像 URL
}

// 浏览历史表
history: {
  ++id: number            // 自增键
  tweetId: string         // 推文 ID
  viewedAt: number        // 浏览时间
  durationSeconds: number // 浏览时长
  type: string            // 浏览类型 (CLICK/DWELL/SCRAPE)
}

// 书签表
bookmarks: {
  tweetId: string         // 推文 ID
  addedAt: number         // 添加时间
  tags: string[]          // 标签
  synced: boolean         // 同步状态
}

// 点赞表
likes: {
  tweetId: string
  addedAt: number
  synced: boolean
}

// 用户推文表
myTweets: {
  id: string              // 推文 ID
  createdAt: number       // 创建时间
  synced: boolean         // 同步状态
}
```

## 数据流

### 网络拦截流程

```
1. Twitter API 请求
   ↓
2. Inject Script (inject/interceptor.ts)
   - 拦截 XHR/Fetch
   - 识别目标端点
   ↓
3. Post Message → Content Script
   ↓
4. Content Script (content/interceptor.ts)
   - 接收拦截数据
   - 解析推文
   - 缓存推文
   - 自动同步（如果适用）
   ↓
5. Chrome Runtime Message → Background
   ↓
6. Background (background/messages.ts)
   - 验证数据
   - 保存到 IndexedDB
```

### 浏览追踪流程

```
1. 用户滚动页面
   ↓
2. IntersectionObserver 检测可见推文
   ↓
3. 计算浏览时长
   ↓
4. 超过阈值（1000ms）触发保存
   ↓
5. 发送到 Background
   ↓
6. 保存到 history 表
```

### 抓取流程

#### 手动模式
```
1. 用户点击"Start Scraping"
   ↓
2. 每 2 秒扫描新推文
   ↓
3. 从缓存/DOM 提取数据
   ↓
4. 批量保存到数据库
```

#### 自动模式
```
1. 用户点击"Start Auto Scraping"
   ↓
2. 自动滚动页面
   ↓
3. 等待内容加载（随机延迟）
   ↓
4. 提取新推文
   ↓
5. 随机暂停（模拟人类行为）
   ↓
6. 重复直到达到限制
```

## 消息通信协议

### Content → Background

```typescript
// 保存浏览记录
{
  action: 'SAVE_FOOTPRINT',
  data: {
    tweetData: TweetData,
    durationMs: number
  }
}

// 批量保存
{
  action: 'SAVE_BATCH',
  data: {
    type: 'BOOKMARK' | 'LIKE' | 'MYTWEET',
    tweets: TweetData[]
  }
}

// 更新推文内容（文章）
{
  action: 'UPDATE_TWEET_CONTENT',
  data: {
    tweetId: string,
    content: string,
    tweetType: 'ARTICLE'
  }
}
```

### Background → Content

```typescript
// 抓取开始通知
{
  action: 'SCRAPE_STARTED',
  data: {
    mode: 'MANUAL' | 'AUTO',
    pageType: 'PROFILE' | 'BOOKMARKS' | 'LIKES'
  }
}

// 抓取停止通知
{
  action: 'SCRAPE_STOPPED',
  data: {
    totalScraped: number,
    reason: string
  }
}
```

## 性能优化

1. **推文缓存**: 使用 LRU 缓存，减少重复解析
2. **批量操作**: 数据库批量插入，减少事务开销
3. **并行处理**: DOM 抓取使用 Promise.all 并行处理
4. **防抖/节流**: 滚动事件使用节流，减少回调频率
5. **去重**: 使用 Set 跟踪已处理的推文，避免重复

## 安全考虑

1. **CSP 兼容**: 使用动态 script 注入绕过 CSP
2. **XSS 防护**: 使用安全的 DOM 方法（createElement）
3. **数据验证**: 验证所有输入数据
4. **最小权限**: 仅请求必要的权限

## 扩展性

- **模块化设计**: 每个功能独立模块
- **插件化抓取**: 可扩展的抓取模式
- **配置化**: 大量可配置参数
- **类型安全**: 完整的 TypeScript 类型
