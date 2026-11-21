// src/types/index.ts
// ========================================
// WebInk - 智能网页转Markdown工具
// 核心类型定义
// ========================================

/**
 * 配置选项
 */
export interface WebInkConfig {
  /** 是否启用高亮显示 */
  enableHighlight?: boolean;

  /** TOC 生成位置 */
  tocPosition?: 'top' | 'bottom' | 'custom';

  /** 是否自动提取文章内容 */
  autoExtract?: boolean;

  /** Markdown 转换选项 */
  markdownOptions?: MarkdownOptions;

  /** 翻译选项 */
  translationOptions?: TranslationOptions;
}

/**
 * Markdown 转换选项
 */
export interface MarkdownOptions {
  /** 是否使用 GFM (GitHub Flavored Markdown) */
  gfm?: boolean;

  /** 转换级别 */
  headingStyle?: 'setext' | 'atx';

  /** 代码块样式 */
  codeBlockStyle?: 'fenced' | 'indented';

  /** 是否保留任务列表 */
  taskListItems?: boolean;

  /** 是否删除线 */
  strikethrough?: boolean;

  /** 表格支持 */
  tables?: boolean;
}

/**
 * 翻译选项
 */
export interface TranslationOptions {
  /** 是否启用翻译 */
  enabled?: boolean;

  /** 目标语言 */
  targetLanguage?: string;

  /** 翻译服务提供商 */
  provider?: 'openai' | 'anthropic' | 'gemini';

  /** API 密钥 */
  apiKey?: string;

  /** 模型名称 */
  model?: string;

  /** API 端点 */
  baseUrl?: string;
}

/**
 * TOC (目录) 项
 */
export interface TOCItem {
  /** 唯一标识符 */
  id: string;

  /** 标题文本 */
  text: string;

  /** 标题级别 (1-6) */
  level: number;

  /** DOM 元素引用 */
  element?: HTMLElement;
}

/**
 * 提取的网页内容
 */
export interface ExtractedContent {
  /** Markdown 内容 */
  markdown: string;

  /** 文章标题 */
  title?: string;

  /** 作者 */
  author?: string;

  /** 发布时间 */
  publishedTime?: string;

  /** 目录 */
  toc?: TOCItem[];

  /** 字数统计 */
  wordCount?: number;

  /** 提取时间 */
  extractedAt: string;

  /** 源 URL */
  sourceUrl: string;

  /** 域名 */
  domain: string;
}

/**
 * 消息类型
 */
export type MessageType =
  | 'GET_MARKDOWN'
  | 'EXTRACT_CONTENT'
  | 'GENERATE_TOC'
  | 'TRANSLATE'
  | 'SAVE_CONFIG'
  | 'GET_CONFIG'
  | 'COPY_TO_CLIPBOARD';

/**
 * Chrome 消息
 */
export interface ChromeMessage<T = unknown> {
  /** 消息类型 */
  action: MessageType;

  /** 消息数据 */
  data?: T;

  /** 标签 ID */
  tabId?: number;
}

/**
 * 消息响应
 */
export interface MessageResponse<T = unknown> {
  /** 是否成功 */
  success: boolean;

  /** 响应数据 */
  data?: T;

  /** 错误信息 */
  error?: string;
}

/**
 * 存储键
 */
export enum StorageKey {
  CONFIG = 'webink_config',
  CACHE = 'webink_cache',
  HISTORY = 'webink_history',
}

/**
 * URL 解析结果
 */
export interface ParsedURL {
  /** 完整 URL */
  href: string;

  /** 协议 */
  protocol: string;

  /** 主机名 */
  hostname: string;

  /** 域名 */
  domain: string;

  /** 子域名 */
  subdomain: string;

  /** 公共后缀 */
  publicSuffix: string;

  /** 路径 */
  pathname: string;

  /** 查询参数 */
  search: string;

  /** 哈希 */
  hash: string;
}

/**
 * 高亮选项
 */
export interface HighlightOptions {
  /** 高亮持续时间（毫秒） */
  duration?: number;

  /** 高亮样式类名 */
  className?: string;

  /** 颜色 */
  color?: string;
}

/**
 * Readability 结果
 */
export interface ReadabilityResult {
  /** 文章标题 */
  title: string;

  /** 文章内容 HTML */
  content: string;

  /** 文本内容 */
  textContent: string;

  /** 文章长度 */
  length: number;

  /** 摘要 */
  excerpt: string;

  /** 作者 */
  byline: string;

  /** 发布时间 */
  publishedTime?: string;

  /** 主图 URL */
  leadImageUrl?: string;

  /** 目录 */
  dir: string;
}
