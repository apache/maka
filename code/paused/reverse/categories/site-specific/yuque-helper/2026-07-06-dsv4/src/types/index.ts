// ============================================================================
// yuque-helper v1.6.0 — TypeScript 类型定义 (dsv4 逆向工程)
// ============================================================================

// ---------------------------------------------------------------------------
// Chrome 扩展消息类型
// ---------------------------------------------------------------------------

/** content script 与 background/popup 之间的消息类型枚举 */
export enum MessageType {
  // 剪贴板操作
  COPY_CONTENT = 'copyContent',
  COPY_SUCCESS = 'copySuccess',
  COPY_FAILED = 'copyFailed',

  // 图片搜索
  SEARCH_IMAGE = 'searchImage',
  INSERT_IMAGE = 'insertImage',

  // 文档操作
  GET_TOC = 'getToc',
  EXPORT_PAGE = 'exportPage',
  SAVE_TO_KNOWLEDGE_BASE = 'saveToKnowledgeBase',

  // 编辑器
  OPEN_EDITOR = 'openEditor',
  SAVE_FILE = 'saveFile',
  IMPORT_FILE = 'importFile',

  // 日记
  GENERATE_DIARY = 'generateDiary',

  // 通知
  SHOW_NOTIFICATION = 'showNotification',
}

/** background script 与各页面之间的消息体 */
export interface ExtensionMessage {
  type: MessageType;
  payload?: unknown;
  tabId?: number;
}

/** runtime.sendMessage 的标准回调 */
export type MessageCallback = (response?: unknown) => void;

// ---------------------------------------------------------------------------
// Chrome Storage 存储 Schema
// ---------------------------------------------------------------------------

/** 存储键名常量 */
export enum StorageKey {
  // 用户信息
  USERNAME = 'username',
  KNOWLEDGE_BASE_PATH = 'knowledgeBasePath',

  // 字数统计配置
  WORD_COUNT_PREFIX = 'wordCountPrefix',
  WORD_COUNT_SUFFIX = 'wordCountSuffix',
  WORD_COUNT_COEFFICIENT = 'wordCountCoefficient',

  // 文本格式化
  FULL_WIDTH_FORMAT = 'fullWidthFormat',
  HALF_WIDTH_FORMAT = 'halfWidthFormat',
  FULL_WIDTH_QUOTE_REPLACE = 'fullWidthQuoteReplace',

  // 彩色标题头
  COLORED_HEADING = 'coloredHeading',

  // UI 配置
  FONT_NAME = 'fontName',
  CLOSE_NOTIFICATION_DOT = 'closeNotificationDot',
  ENABLED_FEATURES = 'enabledFeatures',

  // 编辑器配置
  CODE_BLOCK_THEME = 'codeBlockTheme',
  EDITOR_FULLSCREEN = 'editorFullscreen',
  SPLIT_SCREEN = 'splitScreen',
  SYNC_SCROLL = 'syncScroll',
}

/** chrome.storage.sync 中存储的用户设置 */
export interface StorageSchema {
  [StorageKey.USERNAME]?: string;
  [StorageKey.KNOWLEDGE_BASE_PATH]?: string;
  [StorageKey.WORD_COUNT_PREFIX]?: string;
  [StorageKey.WORD_COUNT_SUFFIX]?: string;
  [StorageKey.WORD_COUNT_COEFFICIENT]?: number;
  [StorageKey.FULL_WIDTH_FORMAT]?: boolean;
  [StorageKey.HALF_WIDTH_FORMAT]?: boolean;
  [StorageKey.FULL_WIDTH_QUOTE_REPLACE]?: boolean;
  [StorageKey.COLORED_HEADING]?: ColoredHeadingConfig[];
  [StorageKey.FONT_NAME]?: string;
  [StorageKey.CLOSE_NOTIFICATION_DOT]?: boolean;
  [StorageKey.ENABLED_FEATURES]?: FeatureToggle[];
  [StorageKey.CODE_BLOCK_THEME]?: string;
  [StorageKey.EDITOR_FULLSCREEN]?: boolean;
  [StorageKey.SPLIT_SCREEN]?: boolean;
  [StorageKey.SYNC_SCROLL]?: boolean;
}

// ---------------------------------------------------------------------------
// 业务领域类型
// ---------------------------------------------------------------------------

/** 彩色标题头配置项 */
export interface ColoredHeadingConfig {
  /** 颜色值 (hex) */
  color: string;
  /** 标题文本 */
  text: string;
  /** 标题级别 (1-6) */
  level: number;
}

/** 功能开关项 */
export interface FeatureToggle {
  /** 功能标识 */
  key: string;
  /** 功能名称 (中文) */
  label: string;
  /** 是否启用 */
  enabled: boolean;
}

/** 目录条目 */
export interface TocEntry {
  /** 标题文本 */
  title: string;
  /** 标题级别 (1-6) */
  level: number;
  /** 页面内锚点 id */
  anchor: string;
  /** 子目录 */
  children?: TocEntry[];
}

/** 图片搜索结果 (Pexels API) */
export interface ImageSearchResult {
  /** 图片唯一标识 */
  id: string;
  /** 缩略图 URL */
  img: string;
  /** 原图 URL */
  value: string;
  /** 图片来源描述 */
  description?: string;
  /** 摄影师 */
  photographer?: string;
}

/** Pexels API 响应 */
export interface PexelsResponse {
  photos: Array<{
    id: number;
    src: {
      original: string;
      medium: string;
      small: string;
    };
    photographer: string;
    alt: string;
  }>;
}

/** 语雀知识库信息 */
export interface YuqueKnowledgeBase {
  /** 知识库 slug */
  slug: string;
  /** 知识库名称 */
  name: string;
  /** 知识库描述 */
  description?: string;
}

/** 语雀文档元数据 */
export interface YuqueDocMeta {
  /** 文档标题 */
  title: string;
  /** 文档 slug */
  slug: string;
  /** 更新时间 */
  updatedAt: string;
  /** 字数统计 */
  wordCount: number;
}

// ---------------------------------------------------------------------------
// 编辑器相关类型
// ---------------------------------------------------------------------------

/** 编辑器状态 */
export interface EditorState {
  /** 当前文档标题 */
  title: string;
  /** Markdown 内容 */
  content: string;
  /** 是否已修改 */
  dirty: boolean;
  /** 当前光标位置 */
  cursor?: EditorCursor;
}

/** 编辑器光标位置 */
export interface EditorCursor {
  line: number;
  ch: number;
}

/** 编辑器配置 */
export interface EditorConfig {
  /** 主题 */
  theme: string;
  /** 代码块主题 */
  codeBlockTheme: string;
  /** 是否全屏 */
  fullscreen: boolean;
  /** 是否分屏 */
  splitScreen: boolean;
  /** 是否同步滚动 */
  syncScroll: boolean;
  /** 字体大小 */
  fontSize: number;
}

// ---------------------------------------------------------------------------
// 日记相关类型
// ---------------------------------------------------------------------------

/** 日记配置 */
export interface DiaryConfig {
  /** 日记知识库路径 */
  knowledgeBasePath: string;
  /** 字数目标 */
  wordCountTarget: number;
}

/** 日记条目 */
export interface DiaryEntry {
  /** 日期 (ISO 8601) */
  date: string;
  /** 标题 */
  title: string;
  /** 内容 */
  content: string;
  /** 字数 */
  wordCount: number;
}

// ---------------------------------------------------------------------------
// 页面转存类型
// ---------------------------------------------------------------------------

/** 网页转存结果 */
export interface PageExportResult {
  /** 转存后的标题 */
  title: string;
  /** 转存后的 Markdown 内容 */
  markdown: string;
  /** 转存后的 HTML 内容 */
  html: string;
  /** 提取的纯文本 (用于字数统计) */
  text: string;
  /** 原始 URL */
  sourceUrl: string;
}

// ---------------------------------------------------------------------------
// 思维导图 (Markmap) 类型
// ---------------------------------------------------------------------------

/** Markmap 节点数据 */
export interface MarkmapNode {
  content: string;
  children?: MarkmapNode[];
  payload?: Record<string, unknown>;
}

/** Markmap 配置选项 */
export interface MarkmapOptions {
  /** 颜色 */
  colorFreezeLevel?: number;
  /** 最大深度 */
  maxDepth?: number;
  /** 是否可缩放 */
  zoom?: boolean;
  /** 是否可平移 */
  pan?: boolean;
}
