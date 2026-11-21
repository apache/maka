// ========================================
// WebInk v0.4.2 - 消息类型定义
// ========================================

import type { Config, HistoryItem, MarkdownContent, DiagramConfig } from "./index";

/** 消息类型枚举 */
export enum MessageType {
  // Markdown 相关
  GET_MARKDOWN = "GET_MARKDOWN",
  SET_MARKDOWN = "SET_MARKDOWN",

  // 配置相关
  GET_CONFIG = "GET_CONFIG",
  SET_CONFIG = "SET_CONFIG",

  // 历史记录
  GET_HISTORY = "GET_HISTORY",
  DELETE_HISTORY = "DELETE_HISTORY",
  CLEAR_HISTORY = "CLEAR_HISTORY",

  // 剪贴板
  COPY_TO_CLIPBOARD = "COPY_TO_CLIPBOARD",

  // 文件下载
  DOWNLOAD_FILE = "DOWNLOAD_FILE",

  // 翻译
  TRANSLATE_CONTENT = "TRANSLATE_CONTENT",

  // 图表
  RENDER_DIAGRAM = "RENDER_DIAGRAM",

  // 编辑器
  OPEN_EDITOR = "OPEN_EDITOR",
  CLOSE_EDITOR = "CLOSE_EDITOR",
  EDITOR_STATE_CHANGE = "EDITOR_STATE_CHANGE",
}

/** 基础消息结构 */
export interface BaseMessage<T = any> {
  type: MessageType;
  data?: T;
  id?: string;
}

/** 获取 Markdown 消息 */
export interface GetMarkdownMessage extends BaseMessage {
  type: MessageType.GET_MARKDOWN;
  data: {
    url: string;
    useCache?: boolean;
  };
}

/** 设置 Markdown 消息 */
export interface SetMarkdownMessage extends BaseMessage {
  type: MessageType.SET_MARKDOWN;
  data: MarkdownContent;
}

/** 获取配置消息 */
export interface GetConfigMessage extends BaseMessage {
  type: MessageType.GET_CONFIG;
}

/** 设置配置消息 */
export interface SetConfigMessage extends BaseMessage {
  type: MessageType.SET_CONFIG;
  data: Partial<Config>;
}

/** 获取历史记录消息 */
export interface GetHistoryMessage extends BaseMessage {
  type: MessageType.GET_HISTORY;
  data?: {
    limit?: number;
  };
}

/** 删除历史记录消息 */
export interface DeleteHistoryMessage extends BaseMessage {
  type: MessageType.DELETE_HISTORY;
  data: {
    id: string;
  };
}

/** 复制到剪贴板消息 */
export interface CopyToClipboardMessage extends BaseMessage {
  type: MessageType.COPY_TO_CLIPBOARD;
  data: {
    text: string;
  };
}

/** 下载文件消息 */
export interface DownloadFileMessage extends BaseMessage {
  type: MessageType.DOWNLOAD_FILE;
  data: {
    filename: string;
    content: string;
    format?: "md" | "html" | "txt";
  };
}

/** 翻译内容消息 */
export interface TranslateContentMessage extends BaseMessage {
  type: MessageType.TRANSLATE_CONTENT;
  data: {
    content: string;
    targetLanguage: string;
  };
}

/** 渲染图表消息 */
export interface RenderDiagramMessage extends BaseMessage {
  type: MessageType.RENDER_DIAGRAM;
  data: DiagramConfig;
}

/** 打开编辑器消息 */
export interface OpenEditorMessage extends BaseMessage {
  type: MessageType.OPEN_EDITOR;
  data: {
    content: string;
    language?: string;
    readOnly?: boolean;
  };
}

/** 消息响应 */
export interface MessageResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

/** 消息监听器类型 */
export type MessageListener = (
  message: BaseMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: MessageResponse) => void
) => boolean | void;

/** 消息发送工具 */
export class MessageHelper {
  /** 发送消息到 Background */
  static async sendToBackground<T = any>(
    message: BaseMessage
  ): Promise<MessageResponse<T>> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
  }

  /** 发送消息到 Content Script */
  static async sendToContent<T = any>(
    tabId: number,
    message: BaseMessage
  ): Promise<MessageResponse<T>> {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
  }

  /** 注册消息监听器 */
  static onMessage(listener: MessageListener): void {
    chrome.runtime.onMessage.addListener(listener);
  }
}

// ========================================
// v0.4.1 兼容类型 (Content Script 使用)
// ========================================

/** v0.4.1 消息类型 */
export type MessageType_v041 =
  | 'GET_MARKDOWN'
  | 'EXTRACT_CONTENT'
  | 'GENERATE_TOC'
  | 'SAVE_CONFIG'
  | 'GET_CONFIG'
  | 'COPY_TO_CLIPBOARD';

/** v0.4.1 类型化消息 */
export interface TypedMessage<T = any> {
  action: MessageType_v041 | string;
  data?: T;
}

/** v0.4.1 类型化响应 */
export interface TypedResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}
