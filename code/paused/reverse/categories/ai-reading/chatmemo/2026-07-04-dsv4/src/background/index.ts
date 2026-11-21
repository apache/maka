// ========================================
// Chat Memo — Background Service Worker
// 来源：js/background.js (35,689 字节, ~1142 行)
// 职责：IndexedDB CRUD、消息路由、分析上报、导出
// ========================================

import type {
  Conversation, Settings, StorageUsage, ExportType,
  ExportMetadata, MessageResponse, PlatformId,
} from '../types';
import { DEFAULT_SETTINGS, PLATFORM_NAMES } from '../types';
import { DB_NAME, DB_VERSION, CONVERSATION_STORE, STORE_INDEXES, generateId } from '../types/storage';
import { getMessageTime, getConversationSortTime } from '../types/messages';

// ========================================
// 常量
// ========================================

const ANALYTICS_ENDPOINT = 'https://chatmemo-analytics.kylis.workers.dev';

// ========================================
// IndexedDB 操作
// ========================================

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(CONVERSATION_STORE)) {
        const store = db.createObjectStore(CONVERSATION_STORE, { keyPath: 'conversationId' });
        STORE_INDEXES.forEach(({ name, keyPath, options }) => {
          store.createIndex(name, keyPath, options);
        });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function findConversationByUrl(url: string): Promise<Conversation | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([CONVERSATION_STORE], 'readonly');
    const store = tx.objectStore(CONVERSATION_STORE);
    const index = store.index('link');
    const req = index.get(url);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function createConversation(conversation: Partial<Conversation>): Promise<string> {
  const db = await openDB();
  const now = new Date().toISOString();
  const record: Conversation = {
    conversationId: conversation.conversationId || generateId(),
    link: conversation.link || '',
    title: conversation.title || 'Untitled',
    platform: conversation.platform || 'chatgpt',
    messages: conversation.messages || [],
    externalId: conversation.externalId || null,
    createdAt: conversation.createdAt || now,
    updatedAt: now,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction([CONVERSATION_STORE], 'readwrite');
    const store = tx.objectStore(CONVERSATION_STORE);
    const req = store.add(record);
    req.onsuccess = () => resolve(record.conversationId);
    req.onerror = () => reject(req.error);
  });
}

async function updateConversation(conversation: Conversation): Promise<void> {
  const db = await openDB();
  conversation.updatedAt = new Date().toISOString();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([CONVERSATION_STORE], 'readwrite');
    const store = tx.objectStore(CONVERSATION_STORE);
    const req = store.put(conversation);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getConversationById(id: string): Promise<Conversation | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([CONVERSATION_STORE], 'readonly');
    const store = tx.objectStore(CONVERSATION_STORE);
    const req = store.get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function getAllConversations(): Promise<Conversation[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([CONVERSATION_STORE], 'readonly');
    const store = tx.objectStore(CONVERSATION_STORE);
    const req = store.getAll();
    req.onsuccess = () => {
      const raw = (req.result || []) as Conversation[];
      const conversations = raw.filter((c) => {
        if (!c?.conversationId) return false;
        if (c.messages && !Array.isArray(c.messages)) c.messages = [];
        return true;
      });
      conversations.sort((a, b) => {
        try {
          return new Date(getConversationSortTime(b)).getTime() -
                 new Date(getConversationSortTime(a)).getTime();
        } catch { return 0; }
      });
      resolve(conversations);
    };
    req.onerror = () => reject(req.error);
  });
}

async function deleteConversation(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([CONVERSATION_STORE], 'readwrite');
    const store = tx.objectStore(CONVERSATION_STORE);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function clearAllConversations(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([CONVERSATION_STORE], 'readwrite');
    const store = tx.objectStore(CONVERSATION_STORE);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function getStorageUsage(): Promise<StorageUsage> {
  let storageBytes = 0;
  try { storageBytes = (await navigator.storage.estimate()).usage || 0; } catch { /* 静默 */ }

  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction([CONVERSATION_STORE], 'readonly');
    const store = tx.objectStore(CONVERSATION_STORE);

    const countReq = store.count();
    countReq.onsuccess = () => {
      const totalConversations = countReq.result;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const todayIdx = store.index('createdAt');
      const range = IDBKeyRange.lowerBound(today.toISOString());
      const todayReq = todayIdx.count(range);

      todayReq.onsuccess = () => {
        const todayCount = todayReq.result;
        const platformCounts: Record<string, number> = {};
        const pIdx = store.index('platform');
        const cursorReq = pIdx.openKeyCursor();
        cursorReq.onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursor>).result;
          if (cursor) {
            platformCounts[cursor.key as string] = (platformCounts[cursor.key as string] || 0) + 1;
            cursor.continue();
          } else {
            resolve({ totalConversations, todayNewConversations: todayCount, storageBytes, platformCounts });
          }
        };
        cursorReq.onerror = () => resolve({ totalConversations, todayNewConversations: todayCount, storageBytes, platformCounts: {} });
      };
    };
  });
}
