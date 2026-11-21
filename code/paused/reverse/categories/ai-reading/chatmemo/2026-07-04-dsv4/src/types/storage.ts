// ========================================
// Chat Memo — 存储类型与工具
// 来源：js/background.js IndexedDB schema
// ========================================

/** IndexedDB 数据库名称 */
export const DB_NAME = 'KeepAIMemoryDB';
/** 数据库版本 */
export const DB_VERSION = 1;
/** Object Store 名称 */
export const CONVERSATION_STORE = 'conversations';

/** IndexedDB 索引定义 */
export const STORE_INDEXES = [
  { name: 'link', keyPath: 'link', options: { unique: false } },
  { name: 'platform', keyPath: 'platform', options: { unique: false } },
  { name: 'updatedAt', keyPath: 'updatedAt', options: { unique: false } },
  { name: 'createdAt', keyPath: 'createdAt', options: { unique: false } },
] as const;

/**
 * 生成唯一对话 ID
 * 格式: conv_{timestamp}_{random9}
 */
export function generateId(): string {
  return 'conv_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
}
