// src/background/index.ts
// ========================================
// 飞书转存专家 - Background Service Worker
// ========================================

import { StorageManager } from './storage';
import { ConfigManager } from './config';
import { MessageRouter } from './messages';
import type { FeishuExportConfig } from '../types';

console.log('飞书转存专家: Background service worker loaded');

/**
 * 飞书转存专家 Background 主类
 */
export class FeishuBackground {
  private storage: StorageManager;
  private config: ConfigManager;
  private router: MessageRouter;

  constructor() {
    this.storage = new StorageManager();
    this.config = new ConfigManager(this.storage);
    this.router = new MessageRouter(this.config, this.storage);

    this.initialize();
  }

  /**
   * 初始化
   */
  private async initialize(): Promise<void> {
    // 加载配置
    await this.config.load();

    // 设置右键菜单
    this.setupContextMenu();

    // 设置消息路由
    this.setupMessageListeners();

    console.log('飞书转存专家: Background initialized');
  }

  /**
   * 设置右键菜单
   */
  private setupContextMenu(): void {
    // 创建导出子菜单
    chrome.contextMenus.create({
      id: 'feishu-export-root',
      title: '飞书转存专家',
      contexts: ['page', 'selection']
    });

    // PDF 导出
    chrome.contextMenus.create({
      id: 'feishu-export-pdf',
      parentId: 'feishu-export-root',
      title: '导出为 PDF',
      contexts: ['page']
    });

    // Word 导出
    chrome.contextMenus.create({
      id: 'feishu-export-word',
      parentId: 'feishu-export-root',
      title: '导出为 Word',
      contexts: ['page']
    });

    // Markdown 导出
    chrome.contextMenus.create({
      id: 'feishu-export-markdown',
      parentId: 'feishu-export-root',
      title: '导出为 Markdown',
      contexts: ['page']
    });

    // HTML 导出
    chrome.contextMenus.create({
      id: 'feishu-export-html',
      parentId: 'feishu-export-root',
      title: '导出为 HTML',
      contexts: ['page']
    });

    // 图片导出
    chrome.contextMenus.create({
      id: 'feishu-export-image',
      parentId: 'feishu-export-root',
      title: '导出为图片',
      contexts: ['page']
    });

    // 复制内容
    chrome.contextMenus.create({
      id: 'feishu-copy-content',
      parentId: 'feishu-export-root',
      title: '复制 Markdown',
      contexts: ['page']
    });

    // 监听菜单点击
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      if (tab.id) {
        this.handleContextMenuClick(info, tab.id);
      }
    });
  }

  /**
   * 处理右键菜单点击
   */
  private async handleContextMenuClick(info: chrome.contextMenus.OnClickData, tabId: number): Promise<void> {
    const formatMap: Record<string, any> = {
      'feishu-export-pdf': 'pdf',
      'feishu-export-word': 'word',
      'feishu-export-markdown': 'markdown',
      'feishu-export-html': 'html',
      'feishu-export-image': 'image'
    };

    if (info.menuItemId === 'feishu-copy-content') {
      // 复制内容
      await chrome.tabs.sendMessage(tabId, {
        action: 'COPY_CONTENT'
      });
    } else if (formatMap[info.menuItemId as string]) {
      // 导出文档
      await chrome.tabs.sendMessage(tabId, {
        action: 'EXPORT_DOCUMENT',
        data: {
          format: formatMap[info.menuItemId as string]
        }
      });
    }
  }

  /**
   * 设置消息监听器
   */
  private setupMessageListeners(): void {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.router
        .handleMessage(message, sender)
        .then((response) => {
          sendResponse(response);
        })
        .catch((error) => {
          sendResponse({
            success: false,
            error: error.message
          });
        });

      return true; // 保持消息通道开启
    });
  }
}

// 初始化 Background
const feishuBackground = new FeishuBackground();

// 导出用于调试
(self as any).FeishuBackground = feishuBackground;
