# BewlyBewly 架构文档

> **版本**: 0.41.2 (2026-07 逆向工程分析)
> **仓库**: [hakadao/BewlyBewly](https://github.com/hakadao/BewlyBewly)
> **构建产物**: Vite + Vue 3 生产构建 (无 source map)

---

## 一、总体架构概览

BewlyBewly 是一个 Chrome 扩展 (MV3)，用于重新设计 Bilibili 首页及多个子页面的 UI。
它通过 **Content Script** 直接注入 Vue 3 应用覆盖原生页面，通过 **Background Service Worker** 充当 API 代理层转发请求，通过 **MAIN world inject 脚本**拦截浏览器 History API 以支持 SPA 路由检测。

```
┌─────────────────────────────────────────────────────┐
│                   Chrome Extension                   │
│                                                     │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │Background │  │ Content      │  │ Inject        │ │
│  │Worker     │  │ Script       │  │ Script        │ │
│  │(ISOLATED) │  │(ISOLATED)   │  │(MAIN world)   │ │
│  └────┬─────┘  └──────┬───────┘  └───────┬───────┘ │
│       │               │                   │         │
│  ┌────┴────┐    ┌─────┴─────┐      ┌─────┴─────┐   │
│  │ API     │    │ Vue 3 App │      │ window.   │   │
│  │ Proxy   │    │ (UI Layer)│      │ history   │   │
│  │ Layer   │    └───────────┘      │ hooks     │   │
│  └─────────┘                       └───────────┘   │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ declarativeNetRequest (rules.json)            │   │
│  │  - 修改 Origin/Referer 头 (第三方 POST)       │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

---

## 二、模块分解

### 2.1 Background Service Worker

**文件**: `dist/background/index.js` (约 2KB, 单行 minified)

**职责**:
1. **API 代理转发**: 作为 content script 与 Bilibili API 之间的中间层
2. **标签页管理**: 支持在后台静默打开链接 (`openLinkInBackground`)

**核心机制**:
- 使用 `webextension-polyfill` 包装 Chrome API
- 通过 `chrome.runtime.onMessage` 接收 content script 发送的 `contentScriptQuery` 消息
- 根据消息中的 `contentScriptQuery` 字段查表 (`FullAPI`) 找到对应的 API 配置
- 使用 `fetch()` 发起真实 HTTP 请求到 Bilibili API，将结果返回给 content script

**API 命名空间覆盖**:

| 命名空间 | 代表 API | 用途 |
|---------|---------|------|
| `ANIME` | getPopularAnimeList, getAnimeWatchList, getRecommendAnimeList, getAnimeTimeTable, getAnimeDetail | 番剧相关 |
| `AUTH` | logout, getLoginQRCode, qrCodeLogin | 登录/认证 |
| `FAVORITE` | getFavoriteCategories, getFavoriteResources, patchDelFavoriteResources | 收藏管理 |
| `HISTORY` | getHistoryList, searchHistoryList, deleteHistoryItem, clearAllHistory, getHistoryPauseStatus, setHistoryPauseStatus | 历史记录 |
| `LIVE` | getFollowingLiveList | 直播 |
| `MOMENT` | getTopBarNewMomentsCount, getTopBarMoments, getTopBarLiveMoments, getMoments | 动态 |
| `NOTIFICATION` | getUnreadMsg, getUnreadDm | 通知消息 |
| `RANKING` | getRankingVideos, getRankingPgc | 排行榜 |
| `SEARCH` | getSearchSuggestion | 搜索建议 |
| `USER` | getUserInfo, getUserStat, relationModify | 用户信息 |
| `VIDEO` | getRecommendVideos, getAppRecommendVideos, dislikeVideo, undoDislikeVideo, getVideoInfo, getVideoComments, getPopularVideos, getVideoPreview | 视频核心 |
| `WATCHLATER` | saveToWatchLater, removeFromWatchLater, getAllWatchLaterList, clearAllWatchLater | 稍后再看 |

**消息处理流程**:
1. `onInstalled` → 注册 `setupApiMsgLstnrs()` 和 `setupTabMsgLstnrs()`
2. 使用 `onConnect` 事件动态绑定 `onMessage` 处理器，实现懒加载监听
3. 每个 API 请求通过 `doRequest()` 统一构造 fetch 参数
4. 后处理器链 (`afterHandle`): `J_D` = 解析 JSON 后返回 data, `J_S` = 解析 JSON 后通过 sendResponse 返回, `S` = 直接通过 sendResponse 返回

### 2.2 Content Script (ISOLATED World)

**文件**: `dist/contentScripts/index.global.js` (约 7MB, 严重 minified)
**CSS**: `dist/contentScripts/style.css` (约 430KB)

**职责**:
1. 在匹配的 Bilibili 页面注入 Vue 3 应用
2. 渲染自定义 UI 覆盖原生页面布局
3. 通过 `chrome.runtime.sendMessage` 向 background 请求 API 数据
4. 监听来自 inject 脚本的 `historyChange` 自定义事件处理 SPA 导航

**技术栈**:
- **Vue 3.4.27**: 核心框架 (runtime + compiler)
- **vue-i18n 9.13.1**: 国际化 (支持中/英/日等)
- **qrcode.vue 3.4.1**: 二维码生成组件 (登录页)
- **CSS Custom Properties**: 全局设计 token (`--bew-*`)
- **CSS `color-mix()`**: 现代颜色混合 (OKLAB 色彩空间)
- **CSS `backdrop-filter`**: Glassmorphism 效果

**注入的页面 (从 CSS chunk 反推)**:
- `homePage` — 首页
- `videoPage` — 视频播放页
- `searchPage` — 搜索结果页
- `channelPage` — 频道页
- `userSpacePage` — 用户空间
- `animePage` / `animePlayback_MoviePage` — 番剧页
- `momentsPage` — 动态页
- `historyPage` — 历史记录页
- `watchLaterPage` — 稍后再看
- `notificationsPage` — 通知页
- `premiumPage` — 大会员页
- `topicPage` — 话题页
- `articlesPage` — 专栏页
- `notePage` — 笔记页
- `loginPage` — 登录页
- `accountSettingsPage` — 账号设置
- `creativeCenterPage` — 创作中心
- `error404Page` — 404 错误页
- `popup` — 扩展弹窗 (独立页面)
- `options` — 扩展设置页 (独立页面)

**注入时机**: `run_at: document_start` + `all_frames: true`
- 在 DOM 构建之前即注入，确保 UI 在原页面渲染前接管
- 所有 iframe 也注入（包括跨域 frame）

### 2.3 Inject Script (MAIN World)

**文件**: `dist/inject/index.js` (约 1.5KB, 单行 minified)

**职责**:
1. 拦截 `window.history.pushState`、`window.history.replaceState`、`window.history.forward`
2. 在每次调用时派发 `historyChange` 自定义事件到 `window`
3. 设置 `window.___inject = true` 标记注入完成

**关键设计**:
- 运行在 MAIN world，可以访问页面的原始 `window.history`
- Content script (ISOLATED world) 通过监听 `window.addEventListener('historyChange', ...)` 接收事件
- 保留原始函数的引用，保证原生行为不中断
- 重写 `fn.toString` 为原始函数的 `toString`，避免检测

### 2.4 Declarative Net Request

**文件**: `assets/rules.json`

**规则列表**:
| ID | 优先级 | 动作 | 条件 |
|----|--------|------|------|
| 1 | 1 | 设置 Origin/Referer 为 `https://www.bilibili.com` | 第三方 POST 请求到 `api.bilibili.com` |
| 2 | 1 | 设置 Origin/Referer 为 `https://www.bilibili.com` | 第三方 POST 请求到 `passport.bilibili.com` |

**目的**: 绕过 Bilibili API 的 CORS/Origin 校验，使扩展发出的请求被服务端视为来自 `www.bilibili.com` 的同源请求。

---

## 三、资源清单

### 3.1 字体资源 (`assets/fonts/`)
- `Geist[wght].woff2` — Vercel Geist Sans 可变字体
- `Onest[wght].woff2` — Onest 可变字体
- `ShangguSansSC-VF.ttf` — 上古黑体 SC 可变字体 (中文)
- `ZhudouSansVF-subset.woff2` — 筑紫黑体 SC (子集化)

### 3.2 图片资源 (`assets/`)
- `icon-512.png` / `icon-512-flat.png` — 扩展图标
- `bewly-vtuber-style-logo.png` — 品牌标识
- `anime-timetable-icons.png` — 番剧时间表精灵图
- `loading.gif` / `empty.png` / `broken-image.png` — UI 状态占位

### 3.3 赞助/贡献者 (`assets/sponsor/`, `assets/twitterUsers/`)
- `afdian.jpg`, `bmc.png` — 赞助平台图标
- `twitterUsers/*` — Twitter 贡献者头像

---

## 四、权限分析

| 权限 | 用途 |
|------|------|
| `storage` | 保存用户 UI 偏好配置 (主题、布局等) |
| `declarativeNetRequest` | 修改 Bilibili API 请求头 (Origin/Referer) |
| `*.bilibili.com/*` | Content script 注入 + API 代理请求 |
| `*.hdslb.com/*` | 同上 (Bilibili 备用域名) |

**Content Script 匹配的子域名**:
- `www.bilibili.com` — 主站首页
- `search.bilibili.com` — 搜索
- `t.bilibili.com` — 动态
- `space.bilibili.com` — 用户空间
- `message.bilibili.com` — 消息
- `member.bilibili.com` — 会员购
- `account.bilibili.com` — 账号
- `passport.bilibili.com` — 通行证 (登录)
- `music.bilibili.com` — 音频
- `www.hdslb.com` — Bilibili 旧域名

---

## 五、SPA 路由检测机制

Bilibili 是一个 SPA (Single Page Application)，使用 History API 进行页面间导航。
BewlyBewly 通过以下链路检测路由变化：

```
用户点击链接
  → Bilibili 前端调用 history.pushState()
    → inject/index.js 拦截并派发 historyChange CustomEvent
      → content script 的 window.addEventListener 接收
        → Vue Router (或手动路由逻辑) 切换页面组件
```

由于 `run_at: document_start`，inject 脚本早在页面 SPA 框架初始化之前即完成 hook，
确保不会遗漏任何导航事件。

---

## 六、安全边界

- **Content Script 隔离**: 使用 ISOLATED world，JavaScript 执行环境与页面隔离
- **MAIN world 注入**: inject 脚本仅 hook History API，不执行其他操作
- **CSP**: `script-src 'self'; object-src 'self'` (仅适用于 extension_pages)
- **API 代理**: Background worker 统一处理跨域请求，避免在 content script 中暴露 cookie
- **注意**: rules.json 修改 Origin/Referer 使请求伪装为同源，这在技术上绕过了服务端 CORS 策略
