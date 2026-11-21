# X-Track Chrome 扩展 - 数据流文档

## 数据流概览图

```mermaid
graph TB
    A[Twitter API 请求] --> B[Inject Script]
    B --> C[Post Message]
    C --> D[Content Script]
    D --> E[推文缓存]
    D --> F[数据解析]
    F --> G[消息通信]
    G --> H[Background Service Worker]
    H --> I[IndexedDB]

    J[用户浏览] --> K[IntersectionObserver]
    K --> L[浏览计时]
    L --> M[时长判断]
    M -->|超过阈值| G

    N[用户抓取] --> O[手动/自动模式]
    O --> P[DOM 抓取]
    P --> F
```

## 详细数据流

### 1. 推文数据收集流程

#### 1.1 网络拦截（主要方式）

```mermaid
sequenceDiagram
    participant TW as Twitter API
    participant INJ as Inject Script
    participant CS as Content Script
    participant BG as Background
    participant DB as IndexedDB

    TW->>INJ: API 响应
    INJ->>INJ: 拦截 XHR/Fetch
    INJ->>CS: Post Message (拦截数据)
    CS->>CS: 解析推文数据
    CS->>CS: 缓存推文 (Map)
    CS->>CS: 判断保存类型
    CS->>BG: Chrome Message (SAVE_BATCH)
    BG->>DB: 保存推文
    BG->>DB: 保存用户
    BG->>CS: 响应成功
```

**关键代码路径**:
1. `inject/interceptor.ts`: 拦截网络请求
2. `content/interceptor.ts`: 处理拦截数据
3. `content/parser.ts`: 解析 API 响应
4. `content/cache.ts`: 缓存推文
5. `background/messages.ts`: 保存到数据库

#### 1.2 DOM 抓取（备用方式）

```mermaid
sequenceDiagram
    participant DOM as Twitter DOM
    participant CS as Content Script
    participant BG as Background
    participant DB as IndexedDB

    DOM->>CS: 滚动/定时触发
    CS->>DOM: 查询推文元素
    DOM->>CS: 返回 article 元素
    CS->>CS: 提取推文数据
    CS->>CS: 尝试从缓存获取
    alt 缓存存在
        CS->>CS: 使用缓存数据
    else 缓存不存在
        CS->>CS: DOM 解析
    end
    CS->>BG: Chrome Message (SAVE_BATCH)
    BG->>DB: 保存数据
```

**关键代码路径**:
1. `content/scraper.ts`: DOM 数据提取
2. `content/cache.ts`: 检查缓存
3. `content/parser.ts`: 回退到 DOM 解析

### 2. 浏览追踪流程

```mermaid
sequenceDiagram
    participant User as 用户
    participant DOM as Twitter DOM
    participant Obs as IntersectionObserver
    participant Timer as 浏览计时器
    participant BG as Background
    participant DB as IndexedDB

    User->>DOM: 滚动页面
    DOM->>Obs: 推文进入视口
    Obs->>Timer: 开始计时
    User->>DOM: 继续滚动
    DOM->>Obs: 推文离开视口
    Obs->>Timer: 停止计时

    alt 时长 > 1000ms
        Timer->>BG: SAVE_FOOTPRINT
        BG->>DB: 保存历史记录
    else 时长 < 1000ms
        Timer->>Timer: 忽略
    end
```

**配置参数**:
- `DWELL_THRESHOLD`: 1000ms（浏览阈值）
- `THRESHOLD`: 0.1（10% 可见性）
- `ROOT_MARGIN`: '100px 0px'（提前检测）

### 3. 智能抓取流程

#### 3.1 手动模式（被动收集）

```mermaid
graph LR
    A[用户点击开始] --> B[每2秒扫描]
    B --> C[查找新推文]
    C --> D[提取数据]
    D --> E[批量保存]
    E --> B
    A --> F[用户点击停止]
    F --> G[结束收集]
```

**特点**:
- 零自动化
- 依赖用户自然滚动
- 2秒扫描间隔
- 适合正常浏览时使用

#### 3.2 自动模式（主动抓取）

```mermaid
graph TB
    A[用户点击开始] --> B[初始化配置]
    B --> C{检查限制}
    C -->|未达上限| D[随机延迟 1-2.5s]
    D --> E[平滑滚动]
    E --> F[等待加载]
    F --> G[提取新推文]
    G --> H[批量保存]
    H --> I{随机暂停?}
    I -->|20% 概率| J[暂停 1.5-4s]
    J --> C
    I -->|80% 概率| C
    C -->|达到上限| K[结束抓取]
```

**人类化行为模拟**:
- 随机滚动延迟
- 随机滚动距离
- 5% 反向滚动
- 20% 暂停概率
- 随机暂停时长

### 4. 数据存储流程

```mermaid
graph TB
    A[接收数据] --> B{验证数据}
    B -->|无效| C[拒绝并记录]
    B -->|有效| D[保存推文]
    D --> E[保存用户]
    E --> F{有转推来源?}
    F -->|是| G[保存转推用户]
    F -->|否| H{有引用推文?}
    G --> H
    H -->|是| I[保存引用用户]
    H -->|否| J{保存类型?}
    I --> J
    J -->|历史记录| K[检查60秒内重复]
    J -->|书签/点赞| L[添加记录]
    K -->|无重复| M[保存历史]
    K -->|有重复| N[跳过]
    L --> O[返回成功]
    M --> O
```

### 5. 消息通信流程

```mermaid
graph LR
    A[Content Script] -->|chrome.runtime.sendMessage| B[Background]
    B -->|处理| C[IndexedDB]
    C -->|结果| B
    B -->|sendResponse| A

    D[Popup] -->|chrome.runtime.sendMessage| B
    B -->|处理| C
    C -->|结果| B
    B -->|sendResponse| D

    F[Content Script] -->|window.postMessage| G[Inject Script]
```

## 数据转换

### API 响应 → 内部格式

```typescript
// Twitter API 响应
{
  rest_id: "1234567890",
  legacy: {
    full_text: "Hello world",
    created_at: "Wed Oct 01 00:00:00 +0000 2024",
    favorite_count: 100,
    retweet_count: 50,
    ...
  },
  core: {
    user_results: {
      result: {
        legacy: {
          screen_name: "user",
          name: "User Name",
          ...
        }
      }
    }
  }
}

// 转换为内部 Tweet 类型
{
  id: "1234567890",
  authorId: "user",
  author: {
    id: "user",
    screenName: "user",
    name: "User Name"
  },
  content: "Hello world",
  createdAt: "2024-10-01T00:00:00.000Z",
  stats: {
    likes: 100,
    retweets: 50,
    replies: 0,
    views: 0
  },
  tweetType: "ORIGINAL"
}
```

### DOM 数据 → 内部格式

```typescript
// DOM 提取
const tweetData = {
  id: extractTweetId(article),
  handle: extractHandle(userElement),
  author: extractAuthor(userElement),
  content: await extractFullTweetText(article),
  likes: extractStat(article, 'like'),
  ...
}
```

## 数据同步策略

### 自动同步触发条件

| 页面类型 | 保存类型 | 触发条件 |
|---------|---------|---------|
| Bookmarks | BOOKMARK | URL 包含 /Bookmarks |
| Likes | LIKE | URL 包含 /Likes |
| 用户主页 | MYTWEET | 当前用户 = 主页用户 |

### 去重策略

1. **同步 ID 集合**: 跟踪已同步的推文
2. **历史记录去重**: 60秒内相同推文只记录一次
3. **书签去重**: 过滤当前用户自己的推文

## 缓存策略

### 推文缓存

```typescript
// 缓存结构
Map<tweetId, {
  raw: TwitterTweet,
  timestamp: number
}>

// 缓存策略
- 最大容量: 1000 条
- TTL: 5 分钟
- LRU 淘汰
- 自动清理过期
```

### 用户信息缓存

```typescript
// 配置文件页缓存
let cachedProfileUserInfo: {
  handle: string,
  name: string,
  avatarUrl: string
} | null = null
let cachedProfilePath: string | null = null

// 缓存失效条件
- URL 路径变化
- 手动清空
```

## 性能指标

### 关键操作性能

| 操作 | 平均耗时 | 优化措施 |
|-----|---------|---------|
| 网络拦截 | < 10ms | 零拷贝传递 |
| 推文解析 | < 5ms | 预编译正则 |
| 缓存查询 | < 1ms | HashMap O(1) |
| DOM 抓取 | < 50ms/条 | 批量处理 |
| 数据库写入 | < 100ms/批 | 事务批量 |
| 浏览追踪 | < 1ms | 观察器优化 |

### 内存使用

| 组件 | 内存占用 | 限制 |
|-----|---------|-----|
| 推文缓存 | ~10MB | 1000 条 |
| 同步 ID 集 | ~1MB | 无限制 |
| 观察器 | ~100KB | 视口内元素 |
| 总计 | ~15-20MB | - |
