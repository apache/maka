// src/background/messages.ts
// ========================================
// Background 消息路由器
// ========================================

import type { TypedMessage, TypedResponse } from '../types/messages';
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
  async handleMessage(
    message: TypedMessage,
    sender: chrome.runtime.MessageSender
  ): Promise<TypedResponse> {
    try {
      switch (message.action) {
        case 'SAVE_CONFIG':
          return await this.saveConfig(message.data);

        case 'GET_CONFIG':
          return await this.getConfig();

        default:
          // 其他消息由 content script 处理
          return {
            success: false,
            error: `Action not handled by background: ${message.action}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 保存配置
   */
  private async saveConfig(data?: any): Promise<TypedResponse<'SAVE_CONFIG'>> {
    if (data?.config) {
      await this.config.update(data.config);
    }

    return {
      success: true,
      data: { success: true } as any,
    };
  }

  /**
   * 获取配置
   */
  private async getConfig(): Promise<TypedResponse<'GET_CONFIG'>> {
    const config = this.config.get();

    return {
      success: true,
      data: config as any,
    };
  }
}
