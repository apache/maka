// ========================================
// Chat Memo — 消息类型工具函数
// 来源：js/background.js getMessageTime()
// ========================================

import type { Message } from './index';

/**
 * 从消息对象中提取可用时间戳
 * 优先级: createdAt > timestamp > 当前时间
 */
export function getMessageTime(message: Message | null | undefined): string {
  if (!message) return '';

  if (message.createdAt) return message.createdAt;
  if (message.timestamp) return message.timestamp;

  return new Date().toISOString();
}

/**
 * 获取对话的排序时间
 * 优先级: 最后一条消息时间 > lastMessageAt > createdAt > timestamp > 当前时间
 */
export function getConversationSortTime(
  conversation: { messages?: Message[]; lastMessageAt?: string; createdAt?: string; timestamp?: string } | null
): string {
  if (!conversation) return new Date().toISOString();

  // 优先使用最后一条消息的时间
  if (conversation.messages && conversation.messages.length > 0) {
    const lastMessage = conversation.messages[conversation.messages.length - 1];
    if (lastMessage.updatedAt) return lastMessage.updatedAt;
    if (lastMessage.createdAt) return lastMessage.createdAt;
    if (lastMessage.timestamp) return lastMessage.timestamp;
  }

  if (conversation.lastMessageAt) return conversation.lastMessageAt;
  if (conversation.createdAt) return conversation.createdAt;
  if (conversation.timestamp) return conversation.timestamp;

  return new Date().toISOString();
}
