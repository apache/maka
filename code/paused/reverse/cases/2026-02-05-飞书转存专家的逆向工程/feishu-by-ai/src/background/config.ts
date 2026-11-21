// src/background/config.ts
// ========================================
// 配置管理器
// ========================================

import { StorageManager } from './storage';

/**
 * 配置管理器
 */
export class ConfigManager {
  private storage: StorageManager;
  private config: any;

  constructor(storage: StorageManager) {
    this.storage = storage;
    this.config = {};
  }

  /**
   * 加载配置
   */
  async load(): Promise<void> {
    this.config = await this.storage.getConfig();
  }

  /**
   * 获取配置
   */
  get(): any {
    return { ...this.config };
  }

  /**
   * 更新配置
   */
  async update(updates: any): Promise<void> {
    this.config = { ...this.config, ...updates };
    await this.storage.saveConfig(this.config);
  }

  /**
   * 重置为默认配置
   */
  async reset(): Promise<void> {
    this.config = (this.storage as any).getDefaultConfig();
    await this.storage.saveConfig(this.config);
  }
}
