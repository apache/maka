// src/background/index.ts
// ========================================
// WebInk Background Service Worker
// ========================================

import { StorageManager } from './storage';
import { ConfigManager } from './config';
import { MessageRouter } from './messages';
import type { WebInkConfig } from '../types';

console.log('WebInk: Background service worker loaded');

/**
 * WebInk Background 主类
 */
export class WebInkBackground {
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

    // 设置消息路由
    this.setupMessageListeners();

    // 设置侧边栏
    this.setupSidePanel();

    console.log('WebInk: Background initialized');
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
            error: error.message,
          });
        });

      return true; // 保持消息通道开启
    });
  }

  /**
   * 设置侧边栏
   */
  private setupSidePanel(): void {
    // 侧边栏会在用户点击图标时打开
    chrome.action.onClicked.addListener((tab) => {
      if (tab.id) {
        chrome.sidePanel.open({ tabId: tab.id });
      }
    });
  }
}

// 初始化 Background
const webInkBackground = new WebInkBackground();

// 导出用于调试
(self as any).WebInkBackground = webInkBackground;
