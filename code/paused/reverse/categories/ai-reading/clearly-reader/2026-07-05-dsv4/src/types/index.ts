// ============================================================
// Clearly Reader - TypeScript 类型定义
// 基于 Clearly Reader v4.7.0 Chrome 扩展逆向工程
// 源文件：rspack 打包产物 + source maps
// ============================================================

// ============================================================
// 核心内容类型
// ============================================================

/** 解析后的文章内容 */
export interface ArticleContent {
  /** 文章标题 */
  title: string;
  /** 文章作者 */
  author?: string;
  /** 站点名称 */
  siteName?: string;
  /** 发布时间 */
  publishedDate?: string;
  /** 文章正文 HTML */
  content: string;
  /** 纯文本摘要 (前 200 字符) */
  excerpt?: string;
  /** 文章语言代码 */
  language?: string;
  /** 文章长度 (字符数) */
  length?: number;
  /** 预估阅读时间 (分钟) */
  readTime?: number;
  /** 原始页面 URL */
  url?: string;
  /** 文章中的图片 URL 列表 */
  images?: string[];
}

// ============================================================
// 阅读器视图配置
// ============================================================

/** 阅读器视图配置 */
export interface ReaderConfig {
  /** 主题模式 */
  theme: ThemeMode;
  /** 字体族名称 */
  fontFamily: FontFamily;
  /** 正文字号 (px) */
  fontSize: number;
  /** 行高倍率 (如 1.5, 1.8, 2.0) */
  lineHeight: number;
  /** 内容区宽度 (px 或百分比) */
  contentWidth: number | string;
  /** 段落间距 (px) */
  paragraphSpacing: number;
  /** 文字对齐方式 */
  textAlign: TextAlign;
  /** 页面边距 (px) */
  pageMargin: number;
  /** 首行缩进 (em) */
  firstLineIndent: number;
  /** 是否显示图片 */
  showImages: boolean;
  /** 图片最大宽度比例 (相对于内容区) */
  imageMaxWidth: number;
}

/** 主题模式 */
export type ThemeMode =
  | "light"  // 白底黑字
  | "dark"   // 黑底白字
  | "sepia"  // 羊皮纸质感
  | "night"  // 深色护眼
  | "custom"; // 自定义

/** 字体族 */
export type FontFamily =
  | "system"      // 系统默认
  | "Roboto"      // Roboto
  | "Georgia"     // Georgia (衬线)
  | "CrimsonText" // Crimson Text (衬线)
  | "Lora"        // Lora (衬线)
  | "NotoSerif";  // Noto Serif (衬线)

/** 文字对齐 */
export type TextAlign = "left" | "justify" | "center";

/** 自定义主题配置 */
export interface CustomThemeConfig {
  /** 背景色 */
  backgroundColor: string;
  /** 文字颜色 */
  textColor: string;
  /** 链接颜色 */
  linkColor: string;
  /** 标题颜色 */
  headingColor: string;
  /** 引用块背景色 */
  blockquoteBackground: string;
  /** 引用块左边框颜色 */
  blockquoteBorderColor: string;
  /** 代码块背景色 */
  codeBackground: string;
}

// ============================================================
// Skim (速览) 面板配置
// ============================================================

/** Skim 面板设置 */
export interface SkimSettings {
  /** Skim 面板是否启用 */
  enabled: boolean;
  /** 快捷键: Alt+S 切换速览面板 */
  toggleShortcut: string;
  /** 面板位置 */
  position: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  /** 面板宽度 (px) */
  width: number;
  /** 是否自动展开 */
  autoExpand: boolean;
  /** 使用的 AI 模型 (用于摘要) */
  aiModel?: string;
}

/** Skim 面板状态 */
export interface SkimState {
  /** 是否打开 */
  isOpen: boolean;
  /** 当前页面 URL */
  pageUrl: string;
  /** AI 摘要内容 */
  summary?: string;
  /** 大纲条目 */
  outline?: OutlineItem[];
  /** 关键要点 */
  keyPoints?: string[];
  /** 加载状态 */
  isLoading: boolean;
}

/** 文章大纲条目 */
export interface OutlineItem {
  /** 标题文本 */
  text: string;
  /** 标题级别 (h1-h6) */
  level: number;
  /** 锚点 ID */
  anchorId?: string;
  /** 子条目 */
  children?: OutlineItem[];
}

// ============================================================
// 高亮与标注配置
// ============================================================

/** 高亮配置 */
export interface HighlightConfig {
  /** 是否启用高亮功能 */
  enabled: boolean;
  /** 高亮颜色列表 */
  colors: HighlightColor[];
  /** 默认高亮颜色 */
  defaultColor: string;
  /** 是否显示高亮侧边栏 */
  showSidebar: boolean;
  /** 高亮快捷键 */
  shortcut?: string;
}

/** 高亮颜色 */
export interface HighlightColor {
  /** 颜色名称 */
  name: string;
  /** 颜色值 (hex) */
  value: string;
}

/** 高亮条目 */
export interface HighlightEntry {
  /** 唯一 ID */
  id: string;
  /** 高亮文本 */
  text: string;
  /** 颜色 */
  color: string;
  /** 所在页面 URL */
  pageUrl: string;
  /** 创建时间戳 */
  createdAt: number;
  /** 备注 */
  note?: string;
}

// ============================================================
// 语音朗读配置
// ============================================================

/** TTS 语音配置 */
export interface SpeechConfig {
  /** 是否启用语音 */
  enabled: boolean;
  /** 语速 (0.5 - 2.0) */
  rate: number;
  /** 音高 (0.5 - 2.0) */
  pitch: number;
  /** 音量 (0.0 - 1.0) */
  volume: number;
  /** 语音引擎名称 */
  voiceName?: string;
  /** 语言代码 (如 en-US, zh-CN) */
  languageCode?: string;
  /** 是否自动朗读 */
  autoPlay: boolean;
  /** 是否高亮当前朗读文本 */
  highlightText: boolean;
}

/** 语音状态 */
export interface SpeechState {
  /** 是否正在朗读 */
  isSpeaking: boolean;
  /** 是否暂停 */
  isPaused: boolean;
  /** 当前朗读文本 */
  currentText?: string;
  /** 当前朗读位置 */
  currentCharIndex?: number;
}

// ============================================================
// 翻译配置
// ============================================================

/** 翻译配置 */
export interface TranslationConfig {
  /** 是否启用翻译 */
  enabled: boolean;
  /** 源语言 (auto = 自动检测) */
  sourceLanguage: string;
  /** 目标语言 */
  targetLanguage: string;
  /** 翻译引擎: google | deepl | microsoft */
  engine: TranslationEngine;
  /** 自定义 API 端点 (用于自建翻译服务) */
  customEndpoint?: string;
  /** API Key (用于第三方翻译) */
  apiKey?: string;
  /** 是否仅显示译文 */
  showTranslationOnly: boolean;
  /** 是否显示双语对照 */
  bilingualMode: boolean;
}

/** 翻译引擎 */
export type TranslationEngine = "google" | "deepl" | "microsoft" | "custom";

// ============================================================
// 导出配置
// ============================================================

/** 导出配置 */
export interface ExportConfig {
  /** 导出格式 */
  format: ExportFormat;
  /** 是否包含图片 */
  includeImages: boolean;
  /** 是否生成目录 */
  includeTOC: boolean;
  /** 页眉模板 */
  headerTemplate?: string;
  /** 页脚模板 */
  footerTemplate?: string;
  /** 自定义 CSS (用于 HTML/PDF) */
  customCSS?: string;
}

/** 导出格式 */
export type ExportFormat = "pdf" | "markdown" | "html" | "text";

// ============================================================
// 扩展全局设置
// ============================================================

/** 扩展全局设置 (存储在 chrome.storage.local) */
export interface ExtensionSettings {
  /** 阅读器视图配置 */
  readerConfig: ReaderConfig;
  /** Skim 设置 */
  skimSettings: SkimSettings;
  /** 语音配置 */
  speechConfig: SpeechConfig;
  /** 翻译配置 */
  translationConfig: TranslationConfig;
  /** 导出配置 */
  exportConfig: ExportConfig;
  /** 高亮配置 */
  highlightConfig: HighlightConfig;
  /** 自动打开模式配置 */
  autoOpen: AutoOpenConfig;
  /** 快捷键配置 */
  shortcuts: ShortcutConfig;
  /** 隐私设置 */
  privacy: PrivacySettings;
  /** 用户偏好语言 */
  locale: string;
}

/** 自动打开配置 */
export interface AutoOpenConfig {
  /** 是否启用自动打开 */
  enabled: boolean;
  /** 域名白名单 (自动进入阅读模式的网站) */
  domainWhitelist: string[];
  /** 域名黑名单 (永不自动进入阅读模式) */
  domainBlacklist: string[];
  /** 仅对包含文章的页面自动打开 */
  articleOnly: boolean;
}

/** 快捷键配置 */
export interface ShortcutConfig {
  /** 激活阅读模式 */
  activateReader: string;
  /** 切换 Skim 面板 */
  toggleSkim: string;
  /** 切换主题 */
  toggleTheme: string;
  /** 增大字号 */
  increaseFontSize: string;
  /** 减小字号 */
  decreaseFontSize: string;
  /** 切换语音朗读 */
  toggleSpeech: string;
}

/** 隐私设置 */
export interface PrivacySettings {
  /** 是否发送匿名使用统计 */
  analyticsEnabled: boolean;
  /** 是否存储阅读历史 */
  historyEnabled: boolean;
  /** 是否缓存文章内容 */
  cacheEnabled: boolean;
}

// ============================================================
// 用户与账户
// ============================================================

/** 用户账户信息 */
export interface UserProfile {
  /** 用户 ID */
  id: string;
  /** 邮箱 */
  email?: string;
  /** 用户名 */
  username?: string;
  /** 头像 URL */
  avatarUrl?: string;
  /** 订阅计划 */
  plan: SubscriptionPlan;
  /** 认证令牌 */
  token?: string;
  /** 令牌刷新令牌 */
  refreshToken?: string;
  /** 令牌过期时间 */
  tokenExpiry?: number;
}

/** 订阅计划 */
export type SubscriptionPlan = "free" | "pro" | "premium";

// ============================================================
// API 通信
// ============================================================

/** API 模式 */
export type ApiMode = "production" | "development" | "custom";

/** API 基础 URL */
export const API_ENDPOINTS = {
  production: "https://api.clearlyreader.com",
  localhost: "https://api.clearly.localhost",
} as const;

/** Google 翻译 API */
export const TRANSLATE_API = "https://translate.googleapis.com/translate_a/single" as const;

/** API 请求通用结构 */
export interface ApiRequest {
  /** 请求路径 */
  path: string;
  /** HTTP 方法 */
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** 请求体 */
  body?: unknown;
  /** 自定义请求头 */
  headers?: Record<string, string>;
  /** 是否需要认证 */
  auth?: boolean;
}

/** API 响应通用结构 */
export interface ApiResponse<T = unknown> {
  /** 是否成功 */
  success: boolean;
  /** 响应数据 */
  data?: T;
  /** 错误信息 */
  error?: string;
  /** 错误代码 */
  errorCode?: string;
}

// ============================================================
// 消息总线 (MBus) 类型
// ============================================================

/** 后台 Service Worker 消息类型 */
export const BackgroundMessageType = {
  UPDATE_ICON:           "clearly:background:update-icon",
  RELOAD_EXTENSION:      "clearly:background:reload-extension",
  GET_SETTINGS:          "clearly:background:get-settings",
  UPDATE_SETTINGS:       "clearly:background:update-settings",
  GET_CONFIG:            "clearly:background:get-config",
  SAVE_CONFIG:           "clearly:background:save-config",
  GET_AUTO_OPEN:         "clearly:background:get-auto-open",
  SET_AUTO_OPEN:         "clearly:background:set-auto-open",
  SUBMIT_FEEDBACK:       "clearly:background:submit-feedback",
  CALL_API:              "clearly:background:call-api",
  GET_USER:              "clearly:background:get-user",
  SAVE_USER:             "clearly:background:save-user",
  GET_SHORTCUTS:         "clearly:background:get-shortcuts",
  OPEN_SHORTCUTS_PAGE:   "clearly:background:open-shortcuts-page",
  TRANSLATE_TEXT:        "clearly:background:translate-text",
  LOGOUT:                "clearly:background:logout",
  GET_VERSION:           "clearly:background:get-version",
  LOGIN_FROM_TOKEN:      "clearly:background:login-from-token",
  REFRESH_TOKEN:         "clearly:background:refresh-token",
  TOKEN_EXPIRED:         "clearly:background:token-expired",
  SET_API_MODE:          "clearly:background:set-api-mode",
  GET_API_MODE:          "clearly:background:get-api-mode",
  SET_CUSTOM_ENDPOINT:   "clearly:background:set-custom-endpoint",
} as const;

/** Content Script 消息类型 */
export const ContentMessageType = {
  TOGGLE_FRAME:          "clearly:content:toggle-frame",
  OPEN_FRAME:            "clearly:content:open-frame",
  CLOSE_FRAME:           "clearly:content:close-frame",
  PARSE_CONTENT:         "clearly:content:parse-content",
  ENABLE_DEV_MODE:       "clearly:content:enable-dev-mode",
  UPDATE_CONTENT:        "clearly:content:update-content",
  GET_WEBSTORE_USER:    "clearly:content:get-webstore-user",
  OPEN_ARTICLE:          "clearly:content:open-article",
} as const;

/** App (阅读器 UI) 消息类型 */
export const AppMessageType = {
  SPEAK_TEXT:            "clearly:app:speak-text",
  UPDATE_CONTENT:        "clearly:app:update-content",
  CLOSE:                 "clearly:app:close",
  PRINT:                 "clearly:app:print",
} as const;

/** 内部中继消息类型 */
export const InternalMessageType = {
  RELAY_REQUEST:         "clearly:_relay:request",
  RELAY_RESPONSE:        "clearly:_relay:response",
} as const;

/** 消息总线消息 */
export interface MessageBusMessage {
  type: string;
  data?: unknown;
  responseId?: string;
  success?: boolean;
  error?: string;
  response?: unknown;
}

/** 消息处理器 */
export type MessageHandler = (
  data: unknown,
  tabId?: number
) => unknown | Promise<unknown>;

// ============================================================
// Logger 日志系统
// ============================================================

/** 日志级别 */
export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

/** 日志级别配置 */
export const LOG_LEVELS = {
  DEBUG: { level: 0, color: "#7F7F7F", label: "DEBUG" },
  INFO:  { level: 1, color: "#0066FF", label: "INFO" },
  WARN:  { level: 2, color: "#FF9900", label: "WARN" },
  ERROR: { level: 3, color: "#FF0000", label: "ERROR" },
} as const;

/** Logger 配置 */
export interface LoggerConfig {
  /** 最低日志级别 */
  minLevel: LogLevel;
  /** 日志前缀 */
  prefix: string;
  /** 是否启用 */
  enabled: boolean;
  /** 是否显示时间戳 */
  showTimestamp: boolean;
}

// ============================================================
// Chrome 扩展专用类型
// ============================================================

/** 扩展 Icon 状态 */
export type IconState = "default" | "active" | "disable" | "readable";

/** Content Script 注入状态 */
export interface ContentScriptState {
  /** 阅读模式是否激活 */
  isReaderActive: boolean;
  /** Skim 面板是否打开 */
  isSkimOpen: boolean;
  /** 是否正在解析内容 */
  isParsing: boolean;
  /** iframe 容器是否已创建 */
  isContainerCreated: boolean;
}

/** 右键菜单项 */
export interface ContextMenuItem {
  /** 菜单 ID */
  id: string;
  /** 菜单标题 (支持 i18n) */
  title: string;
  /** 适用的上下文 */
  contexts: chrome.contextMenus.ContextType[];
  /** 父菜单 ID (用于子菜单) */
  parentId?: string;
}

// ============================================================
// 事件类型
// ============================================================

/** 阅读器事件 */
export interface ReaderEvent {
  /** 事件类型 */
  type: ReaderEventType;
  /** 事件时间戳 */
  timestamp: number;
  /** 事件数据 */
  data?: unknown;
}

/** 阅读器事件类型 */
export type ReaderEventType =
  | "reader:opened"
  | "reader:closed"
  | "reader:content-loaded"
  | "reader:theme-changed"
  | "reader:font-changed"
  | "reader:speech-started"
  | "reader:speech-ended"
  | "reader:translated"
  | "reader:exported"
  | "reader:highlighted"
  | "reader:skim-opened"
  | "reader:skim-closed"
  | "reader:error";

// ============================================================
// 反馈
// ============================================================

/** 用户反馈 */
export interface Feedback {
  /** 反馈类型 */
  type: "bug" | "feature" | "general";
  /** 反馈内容 */
  message: string;
  /** 关联页面 URL */
  url?: string;
  /** 用户邮箱 (可选) */
  email?: string;
  /** 扩展版本 */
  version: string;
  /** 浏览器信息 */
  userAgent: string;
  /** 附加屏幕截图 (base64) */
  screenshot?: string;
}

// ============================================================
// 工具函数类型
// ============================================================

/** 内容解析器 */
export interface ContentParser {
  /** 从 DOM 解析文章 */
  parse(document: Document): ArticleContent | null;
  /** 从 HTML 字符串解析文章 */
  parseHTML(html: string): ArticleContent | null;
  /** 判断页面是否包含文章 */
  isArticle(document: Document): boolean;
}

/** 打印工具 */
export interface PrintHandler {
  /** 准备打印内容 */
  prepare(content: ArticleContent, config: ReaderConfig): string;
  /** 触发打印 */
  print(html: string): void;
}
