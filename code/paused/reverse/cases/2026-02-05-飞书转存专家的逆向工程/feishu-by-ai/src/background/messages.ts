// src/background/messages.ts
// ========================================
// 消息路由器
// ========================================

import { ConfigManager } from './config';
import { StorageManager } from './storage';

/**
 * 消息路由器
 */
export class MessageRouter {
  private config: ConfigManager;
  private storage: StorageManager;

  constructor(config: ConfigManager, storage: StorageManager) {
    this.config = config;
    this.storage = storage;
  }

  /**
   * 处理消息
   */
  async handleMessage(message: any, sender: chrome.runtime.MessageSender): Promise<any> {
    try {
      switch (message.action) {
        case 'GET_CONFIG':
          return await this.getConfig();

        case 'SAVE_CONFIG':
          return await this.saveConfig(message.data);

        case 'GET_HISTORY':
          return await this.getHistory();

        case 'CLEAR_HISTORY':
          return await this.clearHistory();

        default:
          return {
            success: false,
            error: `未知操作: ${message.action}`
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 获取配置
   */
  private async getConfig(): Promise<any> {
    const config = this.config.get();
    return {
      success: true,
      data: config
    };
  }

  /**
   * 保存配置
   */
  private async saveConfig(data: any): Promise<any> {
    await this.config.update(data);
    return {
      success: true
    };
  }

  /**
   * 获取历史记录
   */
  private async getHistory(): Promise<any> {
    const history = await this.storage.getHistory();
    return {
      success: true,
      data: history
    };
  }

  /**
   * 清除历史记录
   */
  private async clearHistory(): Promise<any> {
    await this.storage.clearHistory();
    return {
      success: true
    };
  }
}
