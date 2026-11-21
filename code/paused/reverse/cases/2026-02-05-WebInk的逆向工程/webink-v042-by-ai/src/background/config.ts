// src/background/config.ts
// ========================================
// 配置管理器
// ========================================

import type { WebInkConfig } from '../types';
import { StorageManager, StorageKey } from './storage';

/**
 * 默认配置
 */
const DEFAULT_CONFIG: WebInkConfig = {
  enableHighlight: true,
  tocPosition: 'top',
  autoExtract: false,
  markdownOptions: {
    gfm: true,
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    taskListItems: true,
    strikethrough: true,
    tables: true,
  },
  translationOptions: {
    enabled: false,
    targetLanguage: 'zh-CN',
    provider: 'openai',
  },
};

/**
 * 配置管理器
 */
export class ConfigManager {
  private storage: StorageManager;
  private config: WebInkConfig;

  constructor(storage: StorageManager) {
    this.storage = storage;
    this.config = { ...DEFAULT_CONFIG };
  }

  /**
   * 加载配置
   */
  async load(): Promise<WebInkConfig> {
    const saved = await this.storage.getConfig();
    if (saved) {
      this.config = { ...DEFAULT_CONFIG, ...saved };
    }
    return this.config;
  }

  /**
   * 获取配置
   */
  get(): WebInkConfig {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  async update(updates: Partial<WebInkConfig>): Promise<WebInkConfig> {
    this.config = { ...this.config, ...updates };
    await this.storage.saveConfig(this.config);
    return this.config;
  }

  /**
   * 重置为默认配置
   */
  async reset(): Promise<WebInkConfig> {
    this.config = { ...DEFAULT_CONFIG };
    await this.storage.saveConfig(this.config);
    return this.config;
  }

  /**
   * 获取默认配置
   */
  static getDefault(): WebInkConfig {
    return { ...DEFAULT_CONFIG };
  }
}
