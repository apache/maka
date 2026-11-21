// ============================================================
// BewlyBewly 逆向工程 — 类型定义
// 基于 dist/ 目录中的实际运行时代码反推
// ============================================================

// ---- 扩展 API 响应通用结构 ----

/** Bilibili API 标准响应包装 */
export interface BilibiliApiResponse<T = unknown> {
  code: number
  message: string
  ttl?: number
  data: T
}

// ---- 页面状态 ----

/** 当前 Bilibili 页面类型枚举 */
export type BilibiliPageType =
  | 'home'
  | 'video'
  | 'search'
  | 'channel'
  | 'space'
  | 'anime'
  | 'animePlayback'
  | 'movie'
  | 'moments'
  | 'live'
  | 'history'
  | 'watchLater'
  | 'favorite'
  | 'popular'
  | 'ranking'
  | 'premium'
  | 'topic'
  | 'articles'
  | 'note'
  | 'notifications'
  | 'creativeCenter'
  | 'accountSettings'
  | 'login'
  | 'error404'

/** BewlyBewly 运行时识别的页面状态 */
export interface BilibiliPageState {
  /** 当前页面类型 */
  pageType: BilibiliPageType
  /** 页面 URL */
  url: string
  /** 路径名 */
  pathname: string
  /** 路由参数 (提取自 URL) */
  params: Record<string, string>
  /** 是否为 SPA 导航 (historyChange 事件触发) */
  isSpaNavigation: boolean
}

// ---- 用户相关 ----

/** Bilibili 登录用户信息 (来自 nav API) */
export interface BilibiliUserInfo {
  isLogin: boolean
  mid: number
  uname: string
  face: string
  money: number
  wallet: { mid: number; bcoin_balance: number; coupon_balance: number }
  vipStatus: number
  vipType: number
  level: number
  official: {
    role: number
    title: string
    desc: string
    type: number
  }
}

/** 用户统计数据 */
export interface BilibiliUserStat {
  following: number
  follower: number
  dynamic_count: number
}

// ---- 首页配置 ----

/** BewlyBewly 首页配置项 */
export interface HomepageConfig {
  /** 推荐视频列数 */
  columns: number
  /** 是否启用 glassmorphism 效果 */
  glassEffect: boolean
  /** 主题模式 */
  theme: 'light' | 'dark' | 'auto'
  /** 主题色 (HSL) */
  themeColor: string
  /** 字体大小基准 */
  baseFontSize: number
  /** 页面最大宽度 */
  pageMaxWidth: number
  /** 顶栏高度 */
  topBarHeight: number
  /** 是否显示推荐分区 */
  showRecommendSections: boolean
  /** 隐藏的分区 ID 列表 */
  hiddenSections: number[]
}

// ---- 视频卡片 ----

/** 视频卡片数据 (首页推荐/搜索/排行榜) */
export interface VideoCard {
  id: number
  aid: number
  bvid: string
  title: string
  desc: string
  pic: string
  duration: number
  durationText: string
  owner: VideoCardOwner
  stat: VideoCardStat
  ctime: number
  pubdate: number
  rcmd_reason?: { content: string }
  uri: string
  goto: string
}

/** 视频卡片 UP 主信息 */
export interface VideoCardOwner {
  mid: number
  name: string
  face: string
}

/** 视频卡片统计信息 */
export interface VideoCardStat {
  view: number
  danmaku: number
  reply: number
  favorite: number
  coin: number
  share: number
  like: number
}

// ---- 视频详情 ----

/** 视频详细信息 (来自 view API) */
export interface BilibiliVideoInfo {
  aid: number
  bvid: string
  cid: number
  title: string
  desc: string
  pic: string
  duration: number
  owner: VideoCardOwner
  stat: VideoCardStat
  pages: VideoPage[]
  dynamic: string
  ctime: number
  pubdate: number
}

/** 视频分P */
export interface VideoPage {
  cid: number
  page: number
  part: string
  duration: number
}

// ---- 番剧相关 ----

/** 番剧条目 */
export interface AnimeItem {
  season_id: number
  title: string
  cover: string
  url: string
  rating: number
  styles: string
  favourites: number
  is_finish: number
  newest_ep_index: string
  total_ep: string
}

/** 番剧时间表条目 */
export interface AnimeTimetableItem {
  date: string
  weekday: number
  is_today: number
  seasons: AnimeItem[]
}

// ---- 动态相关 ----

/** 动态条目 (moments feed) */
export interface MomentItem {
  id_str: string
  type: string
  modules: Record<string, unknown>
}

// ---- 直播相关 ----

/** 关注的直播间信息 */
export interface LiveRoomInfo {
  roomid: number
  uid: number
  uname: string
  title: string
  cover: string
  online: number
  live_status: number
  area_name: string
}

// ---- 收藏相关 ----

/** 收藏夹分类 */
export interface FavoriteCategory {
  id: number
  fid: number
  mid: number
  name: string
  media_count: number
}

/** 收藏夹内资源 */
export interface FavoriteResource {
  id: number
  type: number
  title: string
  cover: string
  upper: { mid: number; name: string; face: string }
  cnt_info: { collect: number; danmaku: number; play: number }
  bvid?: string
}

// ---- 历史记录 ----

/** 历史记录条目 */
export interface HistoryItem {
  title: string
  author_name: string
  author_face: string
  cover: string
  view_at: number
  history: {
    oid: number
    epid: number
    bvid: string
    page: number
    cid: number
    part: string
    business: string
  }
  uri: string
  duration: number
  progress: number
}

// ---- 通知 ----

/** 未读消息统计 */
export interface UnreadCount {
  at: number
  chat: number
  like: number
  reply: number
  sys_msg: number
}

// ---- Content Script 消息通信 ----

/** contentScript → background 消息格式 */
export interface ContentScriptQuery {
  contentScriptQuery: string
  [key: string]: unknown
}

/** background → contentScript 响应处理器 */
export type AfterHandle = 'J_D' | 'J_S' | 'S'

/** API 定义项 (background 中的 API_MAP 表项) */
export interface ApiDefinition {
  url: string
  _fetch: {
    method: 'get' | 'post'
    headers?: Record<string, string>
    body?: Record<string, unknown>
  }
  params?: Record<string, unknown>
  afterHandle: AfterHandle
}

// ---- 注入脚本 ----

/** inject/index.js 在 MAIN world 暴露的全局标识 */
export interface InjectGlobalFlag {
  /** window.___inject = true 标记注入已完成 */
  ___inject: true
}

/** historyChange 自定义事件详情 */
export interface HistoryChangeEventDetail {
  detail: [data: unknown, title: string, url?: string | null]
}

// ---- Declarative Net Request ----

/** rules.json 中的单条规则 */
export interface DNRRule {
  id: number
  priority: number
  action: {
    type: 'modifyHeaders'
    requestHeaders: {
      header: string
      operation: 'set'
      value: string
    }[]
  }
  condition: {
    domainType: 'thirdParty'
    urlFilter: string
    resourceTypes: string[]
    requestMethods: string[]
  }
}

// ---- 扩展存储 ----

/** chrome.storage.local 中的配置 shape */
export interface BewlyStorageSchema {
  /** 主题偏好 */
  theme?: 'light' | 'dark' | 'auto'
  /** 自定义主题色 */
  themeColor?: string
  /** 首页配置 */
  homepageConfig?: Partial<HomepageConfig>
  /** 隐藏的分区 */
  hiddenSections?: number[]
  /** 字体设置 */
  fontSettings?: {
    baseFontSize: number
    /** 自定义字体名称 */
    customFont?: string
  }
}

// ---- Vue Composition API Context ----

/** content script 中 Vue app 的 provide/inject 上下文 */
export interface BewlyAppContext {
  /** 当前页面状态 (响应式) */
  pageState: BilibiliPageState
  /** 用户信息 (响应式) */
  userInfo: BilibiliUserInfo | null
  /** 首页配置 (响应式) */
  config: HomepageConfig
}
