// ========================================
// i微信读书 (WeRead Helper) v0.9.22 — 核心类型定义
// 来源：plugin.js (webpack bundle), background.js, contentScript.js, i.js, m.js
// ========================================

// ========================================
// 存储相关
// ========================================

/** 本地存储命名空间: store2.namespace('iwr') */
export namespace IWRStorage {
  /** 设置存储 key: 'setting' */
  export interface Setting {
    /** 阅读背景主题 (CSS class) */
    theme?: ThemeConfig;
    /** 纸张纹理 */
    paper?: PaperConfig;
    /** 阅读字体 */
    font?: FontConfig;
    /** Readwise 同步 Token */
    readwiseToken?: string;
    /** Notion 集成 Token */
    notionToken?: string;
    /** Notion 数据库 Page ID */
    notionPageID?: string;
  }

  /** 书签卡配置 key: 'bookcard' */
  export interface BookCardConfig {
    /** 卡片字体 */
    font?: string;
    /** 卡片主题 */
    theme?: string;
  }
}

/** localStorage key: 'flomoApi' — Flomo API URL */
export type FlomoApiUrl = string;

// ========================================
// 主题 / 纸张 / 字体
// ========================================

/** 阅读背景主题 */
export interface ThemeConfig {
  /** CSS class 名 (iwr_theme_*) */
  name: string;
  /** 背景色值 */
  color: string;
}

/** 纸张纹理配置 */
export interface PaperConfig {
  /** 纹理名称标识 */
  name: string;
  /** 纹理图片 URL (transparenttextures.com) */
  url: string;
}

/** 字体配置 */
export interface FontConfig {
  /** 字体标识: 'inherit' | 'kaiti' | 'xingkai' | 'zuiyou' | 'xingshu' | 'songti' */
  name: string;
}

/** 可用字体列表项 */
export interface FontOption {
  /** 字体 key, 对应 CSS font-family */
  key: string;
  /** 中文显示名 */
  name: string;
}

// ========================================
// 微信读书 Store 数据结构
// ========================================

/** 书籍信息 */
export interface BookInfo {
  /** 书名 */
  title?: string;
  /** 作者 */
  author?: string;
  /** 封面图 URL */
  cover?: string;
  /** 简介 */
  intro?: string;
  /** 书籍 ID (可能是数字或自定义 ID) */
  bookId?: string | number;
  /** 出版时间 */
  publishTime?: string;
  /** 总字数 */
  totalWords?: number;
  /** 新评分 (除以10得到实际评分) */
  newRating?: number;
  /** 是否读完全书 */
  finishReading?: boolean;
}

/** 用户信息 */
export interface User {
  /** 用户名 */
  name: string;
  /** 头像 URL */
  avatar?: string;
  /** 用户 VID */
  userVid?: number;
  /** 昵称 */
  nick?: string;
}

/** 笔记 (划线+评论) */
export interface Note {
  /** 笔记类型: 0=划线, 1=评论, 4=全书点评 */
  noteType: number;
  /** 章节 UID */
  chapterUid?: number;
  /** 章节索引 */
  chapterIdx?: number;
  /** 文本区间 */
  range?: TextRange;
  /** 展示文本 (划线内容) */
  showText?: string;
  /** 摘要/划线原文 */
  abstract?: string;
  /** 创建时间 (Unix timestamp, 秒) */
  createTime?: number;
  /** 笔记唯一标识 */
  key?: string;
  /** 评论 ID */
  reviewId?: string;
  /** 是否私密 */
  isPrivate?: boolean;
  /** 作者信息 */
  author?: User;
  /** 点赞数 */
  star?: number;
  /** 附加的章节标题 (运行时计算) */
  chapterTitle?: string;
  /** 章节层级 (1-based) */
  chapterLevel?: number;
}

/** 划线书签 */
export interface Bookmark {
  /** 书籍 ID */
  bookId?: string;
  /** 书籍版本 */
  bookVersion?: number;
  /** 书签 ID */
  bookmarkId?: string;
  /** 章节索引 */
  chapterIdx?: number;
  /** 章节 UID */
  chapterUid?: number;
  /** 创建时间 */
  createTime?: number;
  /** 划线文本 */
  markText?: string;
  /** 文本区间 */
  range?: string;
  /** 样式 */
  style?: number;
  /** 类型 */
  type?: number;
}

/** 文本区间 */
export interface TextRange {
  /** 起始偏移 */
  start: number;
  /** 结束偏移 */
  end: number;
}

/** 章节信息 */
export interface ChapterInfo {
  /** 章节标题 */
  title: string;
  /** 章节层级 (1/2/3 对应 H1/H2/H3) */
  level: number;
  /** 章节 UID */
  chapterUid?: number;
}

/** 阅读进度 */
export interface Progress {
  bookId?: string;
  book?: {
    appId?: string;
    bookVersion?: number;
    reviewId?: string;
    chapterUid?: number;
    chapterOffset?: number;
    chapterIdx?: number;
    updateTime?: number;
    synckey?: number;
    summary?: string;
    readingTime?: number;
    progress?: number;
    isStartReading?: number;
    startReadingTime?: number;
  };
  canFreeRead?: number;
}

/** 阅读统计 */
export interface ReadingStat {
  isReading?: number;
  readingCount?: number;
  finishReadingCount?: number;
  todayReadingCount?: number;
  friendReadingCount?: number;
  friendFinishReadingCount?: number;
}

// ========================================
// 微信读书全局 Store (window.r)
// ========================================

/** 微信读书 Vuex/Pinia Store 形状 (通过 Proxy 反向引用 window.r) */
export interface WereadStore {
  /** 当前书籍信息 */
  bookInfo: BookInfo;
  /** 是否已登录 */
  hasLogin: boolean;
  /** 当前用户 */
  user: User;
  /** 笔记列表 */
  notes: { noteList: Note[] };
  /** 书签列表 */
  bookmarks: { bookmarkList: Bookmark[] };
  /** 章节信息列表 */
  chapterInfos: ChapterInfo[];
  /** 选中文本对象 (扩展注入) */
  selectObj?: SelectObj;
  /** 当前书本章节渲染对象 key */
  bookId?: string | number;
  /** 阅读时间字符串 */
  readingTimeString?: string;
  /** 阅读进度 */
  progress?: Progress;
  /** 阅读统计 */
  readingStat?: ReadingStat;
  /** 是否白底主题 */
  isWhiteTheme?: boolean;
  /** 获取当前章节 HTML */
  getCurrentSection?: string;
  /** 清除绘制文本 */
  clearDrawTexts?: () => void;
  /** 重新绘制文本 */
  drawSomeTexts?: () => void;
  /** 复制文本方法 */
  copyText?: () => void;
  /** 搜索书籍内关键字 */
  doSearch?: (params: { keyword: string }) => Promise<unknown>;
}

// ========================================
// 选中对象
// ========================================

/** 选中对象的 objs 数组项 */
export interface SelectObjItem {
  /** 唯一标识 */
  id: string;
  /** 类型: 1=文本, 3=插图 */
  type: number;
  /** 文本内容 */
  text: string;
  /** 偏移量 */
  _offset: string;
  /** HTML 表示 */
  html?: string;
  /** CSS class */
  className?: string;
  /** 矩形区域 */
  rect?: { x: number; y: number; w: number; h: number };
  /** 字体 */
  font?: string;
}

/** 划线选中的对象集合 */
export interface SelectObj {
  /** 选中文本的元素列表 */
  objs: SelectObjItem[];
}

// ========================================
// 自定义事件
// ========================================

/** textselect 自定义事件 detail */
export interface TextSelectEvent extends CustomEvent {
  detail: {
    /** 选中文本的元素列表 */
    objs: SelectObjItem[];
  };
}

// ========================================
// 第三方平台 API 数据类型
// ========================================

/** Flomo API 请求 body */
export interface FlomoRequest {
  /** Flomo 笔记内容 (Markdown) */
  content: string;
}

/** Readwise highlight 格式 */
export interface ReadwiseHighlight {
  /** 划线文本 */
  text: string;
  /** 书名 */
  title: string;
  /** 作者 */
  author: string;
  /** 封面图 URL */
  image_url: string;
  /** 来源 URL (微信读书) */
  source_url: string;
  /** 来源类型 */
  source_type: string;
  /** 分类 */
  category: string;
  /** 笔记/评论内容 */
  note?: string;
  /** 排序位置 */
  location: number;
  /** 排序类型 */
  location_type: string;
  /** 划线时间 (ISO 8601) */
  highlighted_at: string;
}

/** Readwise 批量上传请求 */
export interface ReadwiseRequest {
  /** 高亮列表 */
  highlights: ReadwiseHighlight[];
}

/** Notion 同步请求 (通过中转代理) */
export interface NotionUpsertRequest {
  /** Notion Integration Token */
  token: string;
  /** Notion 数据库 ID */
  databaseId: string;
  /** 书籍数据 */
  data: {
    id: number;
    bookname: string;
    author: string;
    url: string;
    introduce: string;
    cover: string;
    status: string;
    publishTime: string;
    totalWords: string;
    score: number;
    noteList: Note[];
  };
}

/** 飞书文档请求 (已废弃/未启用) */
export interface FeishuDocRequest {
  /** 文档标题 */
  title: string;
  /** 文档文本 */
  text: string;
}

// ========================================
// 书签卡片 (BookCard) 相关
// ========================================

/** Unsplash 随机图片服务 URL */
export type UnsplashRandomUrl = `https://source.unsplash.com/random/750x400?sig=${number}`;

/** 书签卡片主题 */
export interface BookCardTheme {
  /** 主题标识 */
  key: string;
  /** 主题名称 */
  name: string;
}

// ========================================
// Chrome Extension 消息通信
// ========================================

/** 扩展消息类型 */
export interface ExtensionMessage {
  /** 消息类型 */
  type: 'textselect';
  /** 消息负载 */
  payload?: unknown;
}

// ========================================
// webRequest CSP 修改
// ========================================

/** webRequest 拦截域名列表 */
export const WEBREQUEST_FILTER_URLS = [
  '*://weread.qq.com/*',
  '*://flomoapp.com/*',
  '*://open.feishu.cn/*',
  '*://api.notion.com/*',
];

// ========================================
// 硬编码 API 凭据 (安全审计关键发现)
// ========================================

/** 飞书 APP ID (硬编码在 background.js + src/utils/doc.js) */
export const FEISHU_APP_ID = 'cli_a16bec5c4fb8500d';

/** 飞书 APP SECRET (硬编码) */
export const FEISHU_APP_SECRET = 'wUZ4m4ePbgfZS2WuOH6SCcMk83cIkShP';

/** 腾讯云 CPS Key (硬编码在 m.js) */
export const TENCENT_CPS_KEY = '1d358d18a7a17b4a6df8d67a62fd3d3d';

/** 阿里云推广 Key (硬编码在 m.js) */
export const ALIYUN_CPS_KEY = 'okjhlpr5';

/** Sentry DSN (硬编码在 src/utils/sentry.js) */
export const SENTRY_DSN = 'https://76da9b65bb4540a0aee77342f5400fc9@o1228425.ingest.sentry.io/6374181';

/** 百度统计 ID (硬编码在 i.js) */
export const BAIDU_TONGJI_ID = 'cda23766027f4145f8a9d2087788759e';

/** Notion 同步中转代理 URL */
export const NOTION_PROXY_URL = 'https://wx.redream.cn/weixin/ireader/notion/upsert/';

/** Markdown 在线预览工具 */
export const MARKDOWN_PREVIEW_URL = 'https://md.redream.cn/';
