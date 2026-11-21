// ========================================
// WebInk v0.4.9 - Background Service Worker
// 逆向工程还原
// ========================================

import { MessageHelper, MessageType } from "../types/messages";
import { StorageHelper, StorageKey, DEFAULT_CONFIG } from "../types/storage";
import type { BaseMessage, MessageResponse, Config, HistoryItem, MarkdownContent } from "../types";

/** 初始化 */
async function initialize() {
  // 确保配置存在
  const config = await StorageHelper.getConfig();
  if (!config) {
    await StorageHelper.setConfig(DEFAULT_CONFIG);
  }

  // 注册消息监听器
  MessageHelper.onMessage(handleMessage);
}

/** 消息处理 */
async function handleMessage(
  message: BaseMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: MessageResponse) => void
): Promise<void> {
  try {
    let response: MessageResponse;

    switch (message.type) {
      case MessageType.GET_CONFIG:
        response = await handleGetConfig();
        break;

      case MessageType.SET_CONFIG:
        response = await handleSetConfig(message.data);
        break;

      case MessageType.GET_HISTORY:
        response = await handleGetHistory(message.data);
        break;

      case MessageType.DELETE_HISTORY:
        response = await handleDeleteHistory(message.data);
        break;

      case MessageType.CLEAR_HISTORY:
        response = await handleClearHistory();
        break;

      case MessageType.COPY_TO_CLIPBOARD:
        response = await handleCopyToClipboard(message.data);
        break;

      case MessageType.DOWNLOAD_FILE:
        response = await handleDownloadFile(message.data);
        break;

      case MessageType.SET_MARKDOWN:
        response = await handleSetMarkdown(message.data);
        break;

      default:
        response = { success: false, error: "Unknown message type" };
    }

    sendResponse(response);
  } catch (error) {
    sendResponse({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 获取配置 */
async function handleGetConfig(): Promise<MessageResponse<Config>> {
  const config = await StorageHelper.getConfig();
  return { success: true, data: config };
}

/** 设置配置 */
async function handleSetConfig(data: Partial<Config>): Promise<MessageResponse<Config>> {
  await StorageHelper.setConfig(data);
  const config = await StorageHelper.getConfig();
  return { success: true, data: config };
}

/** 获取历史记录 */
async function handleGetHistory(data?: { limit?: number }): Promise<MessageResponse<HistoryItem[]>> {
  let history = await StorageHelper.getHistory();
  if (data?.limit) {
    history = history.slice(0, data.limit);
  }
  return { success: true, data: history };
}

/** 删除历史记录 */
async function handleDeleteHistory(data: { id: string }): Promise<MessageResponse<void>> {
  await StorageHelper.deleteHistory(data.id);
  return { success: true };
}

/** 清空历史记录 */
async function handleClearHistory(): Promise<MessageResponse<void>> {
  await StorageHelper.clearHistory();
  return { success: true };
}

/** 复制到剪贴板 */
async function handleCopyToClipboard(data: { text: string }): Promise<MessageResponse<void>> {
  // 在 background 中无法直接复制，需要发送到 content script
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab.id) {
    await MessageHelper.sendToContent(tab.id, {
      type: MessageType.COPY_TO_CLIPBOARD,
      data,
    });
  }
  return { success: true };
}

/** 下载文件 */
async function handleDownloadFile(data: {
  filename: string;
  content: string;
  format?: string;
}): Promise<MessageResponse<void>> {
  const blob = new Blob([data.content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);

  await chrome.downloads.download({
    url,
    filename: data.filename,
    saveAs: true,
  });

  URL.revokeObjectURL(url);
  return { success: true };
}

/** 保存 Markdown (添加到历史记录) */
async function handleSetMarkdown(data: MarkdownContent): Promise<MessageResponse<void>> {
  const historyItem: HistoryItem = {
    id: `history-${Date.now()}`,
    url: data.url,
    title: data.title,
    content: data.content,
    createdAt: data.createdAt,
  };

  await StorageHelper.addHistory(historyItem);
  await StorageHelper.setCache(data.url, data);

  return { success: true };
}

/** 启动 */
initialize();
