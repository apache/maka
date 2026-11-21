// src/types/messages.ts
// ========================================
// Chrome 消息通信类型定义
// ========================================

import type {
  ExtractedContent,
  WebInkConfig,
  TOCItem,
  MessageType
} from './index';

/**
 * 获取 Markdown 请求
 */
export interface GetMarkdownRequest {
  /** 是否包含目录 */
  includeTOC?: boolean;

  /** TOC 位置 */
  tocPosition?: 'top' | 'bottom' | 'custom';

  /** 是否使用 Readability */
  useReadability?: boolean;
}

/**
 * 提取内容请求
 */
export interface ExtractContentRequest {
  /** URL */
  url?: string;

  /** 是否使用 Readability */
  useReadability?: boolean;

  /** 是否移除广告 */
  removeAds?: boolean;
}

/**
 * 生成目录请求
 */
export interface GenerateTOCRequest {
  /** 选择器 */
  selector?: string;

  /** 最小级别 */
  minLevel?: number;

  /** 最大级别 */
  maxLevel?: number;
}

/**
 * 翻译请求
 */
export interface TranslateRequest {
  /** 要翻译的文本 */
  text: string;

  /** 目标语言 */
  targetLanguage: string;

  /** 翻译服务 */
  provider?: 'openai' | 'anthropic' | 'gemini';

  /** 是否保持 Markdown 格式 */
  keepMarkdown?: boolean;
}

/**
 * 保存配置请求
 */
export interface SaveConfigRequest {
  config: Partial<WebInkConfig>;
}

/**
 * 消息请求映射
 */
export type MessageRequestMap = {
  GET_MARKDOWN: GetMarkdownRequest;
  EXTRACT_CONTENT: ExtractContentRequest;
  GENERATE_TOC: GenerateTOCRequest;
  TRANSLATE: TranslateRequest;
  SAVE_CONFIG: SaveConfigRequest;
  GET_CONFIG: undefined;
  COPY_TO_CLIPBOARD: { text: string };
};

/**
 * 消息请求
 */
export type TypedMessage<T extends MessageType = MessageType> = {
  action: T;
  data?: T extends keyof MessageRequestMap ? MessageRequestMap[T] : unknown;
  tabId?: number;
};

/**
 * 消息响应映射
 */
export type MessageResponseMap = {
  GET_MARKDOWN: ExtractedContent;
  EXTRACT_CONTENT: ExtractedContent;
  GENERATE_TOC: TOCItem[];
  TRANSLATE: { translatedText: string };
  SAVE_CONFIG: { success: boolean };
  GET_CONFIG: WebInkConfig;
  COPY_TO_CLIPBOARD: { success: boolean };
};

/**
 * 消息响应
 */
export type TypedResponse<T extends MessageType = MessageType> = {
  success: boolean;
  data?: T extends keyof MessageResponseMap ? MessageResponseMap[T] : unknown;
  error?: string;
};

/**
 * Content Script 消息处理器
 */
export interface MessageHandler {
  (message: TypedMessage, sender: chrome.runtime.MessageSender):
    | Promise<TypedResponse>
    | TypedResponse;
}
