// ========================================
// WebInk v0.4.2 - 核心类型定义
// 逆向工程还原 - 2026-02-28
// ========================================

/** 基础配置 (v0.4.2 风格) */
export interface Config {
  /** 默认标题 */
  defaultTitle: string;
  /** 最大标题深度 */
  maxHeadingDepth: number;
  /** 是否启用 GFM */
  enableGFM: boolean;
  /** 是否启用代码高亮 */
  enableCodeHighlight: boolean;
  /** 是否启用图表支持 */
  enableDiagram: boolean;
  /** 是否启用编辑器 */
  enableEditor: boolean;
  /** 翻译语言 */
  translateLanguage?: string;
}

/** Markdown 内容 */
export interface MarkdownContent {
  /** 原始标题 */
  title: string;
  /** Markdown 内容 */
  content: string;
  /** URL */
  url: string;
  /** 生成时间 */
  createdAt: number;
  /** 目录项 */
  toc?: TOCItem[];
  /** 元数据 */
  metadata?: PageMetadata;
}

/** 目录项 */
export interface TOCItem {
  /** 标题文本 */
  text: string;
  /** 锚点 ID */
  id: string;
  /** 层级 (1-6) */
  level: number;
  /** 子项 */
  children?: TOCItem[];
  /** DOM 元素引用 (v0.4.1 兼容) */
  element?: HTMLElement;
}

/** 页面元数据 */
export interface PageMetadata {
  /** 作者 */
  author?: string;
  /** 发布时间 */
  publishedTime?: string;
  /** 修改时间 */
  modifiedTime?: string;
  /** 描述 */
  description?: string;
  /** 关键词 */
  keywords?: string[];
  /** 站点名称 */
  siteName?: string;
  /** 图标 */
  favicon?: string;
}

/** 消息类型 */
export type MessageType =
  | "GET_MARKDOWN"
  | "SET_MARKDOWN"
  | "GET_CONFIG"
  | "SET_CONFIG"
  | "GET_HISTORY"
  | "DELETE_HISTORY"
  | "COPY_TO_CLIPBOARD"
  | "DOWNLOAD_FILE"
  | "TRANSLATE_CONTENT"
  | "RENDER_DIAGRAM"
  | "OPEN_EDITOR";

/** Chrome 消息 */
export interface ChromeMessage<T = any> {
  type: MessageType;
  data?: T;
  tabId?: number;
  frameId?: number;
}

/** 历史记录项 */
export interface HistoryItem {
  /** ID */
  id: string;
  /** URL */
  url: string;
  /** 标题 */
  title: string;
  /** 内容 */
  content: string;
  /** 创建时间 */
  createdAt: number;
  /** 标签 */
  tags?: string[];
}

/** 图表类型 */
export type DiagramType =
  | "flowchart"
  | "sequence"
  | "class"
  | "state"
  | "er"
  | "gantt"
  | "pie"
  | "mindmap"
  | "gitgraph"
  | "sankey";

/** 图表配置 */
export interface DiagramConfig {
  /** 图表类型 */
  type: DiagramType;
  /** Mermaid 源码 */
  source: string;
  /** 主题 */
  theme?: "default" | "dark" | "forest" | "neutral";
}

/** 编辑器配置 */
export interface EditorConfig {
  /** 语言 */
  language: string;
  /** 主题 */
  theme: string;
  /** 字体大小 */
  fontSize: number;
  /** 是否只读 */
  readOnly: boolean;
  /** 自动换行 */
  wordWrap: boolean;
}

/** 存储键 */
export enum StorageKey {
  CONFIG = "webink_config",
  HISTORY = "webink_history",
  CACHE = "webink_cache",
  EDITOR_STATE = "webink_editor_state",
}

/** API 响应 */
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

// ========================================
// v0.4.1 兼容类型 (Content Script 使用)
// ========================================

/** WebInk 配置 (v0.4.1 风格) */
export interface WebInkConfig {
  /** 是否启用高亮 */
  enableHighlight?: boolean;
  /** 目录位置 */
  tocPosition?: 'top' | 'bottom' | 'custom';
  /** 是否自动提取 */
  autoExtract?: boolean;
  /** Markdown 选项 */
  markdownOptions?: MarkdownOptions;
  /** 翻译选项 */
  translationOptions?: TranslationOptions;
}

/** Markdown 转换选项 */
export interface MarkdownOptions {
  /** GFM 支持 */
  gfm?: boolean;
  /** 标题样式 */
  headingStyle?: 'setext' | 'atx';
  /** 代码块样式 */
  codeBlockStyle?: 'fenced' | 'indented';
  /** 任务列表 */
  taskListItems?: boolean;
  /** 删除线 */
  strikethrough?: boolean;
  /** 表格支持 */
  tables?: boolean;
}

/** 翻译选项 */
export interface TranslationOptions {
  /** 是否启用 */
  enabled?: boolean;
  /** 目标语言 */
  targetLanguage?: string;
  /** 翻译提供商 */
  provider?: string;
}

/** 提取的内容 */
export interface ExtractedContent {
  /** Markdown 内容 */
  markdown: string;
  /** 标题 */
  title: string;
  /** 作者 */
  author?: string;
  /** 发布时间 */
  publishedTime?: string;
  /** 目录 */
  toc?: TOCItem[];
  /** 字数 */
  wordCount?: number;
  /** 提取时间 */
  extractedAt: string;
  /** 来源 URL */
  sourceUrl: string;
  /** 域名 */
  domain: string;
}

/** 高亮选项 */
export interface HighlightOptions {
  /** 持续时间 (ms) */
  duration?: number;
  /** 类名 */
  className?: string;
  /** 颜色 */
  color?: string;
}

/** 目录项 (扩展 v0.4.1 版本) */
export interface TOCItemExtended extends TOCItem {
  /** DOM 元素引用 */
  element?: HTMLElement;
}
