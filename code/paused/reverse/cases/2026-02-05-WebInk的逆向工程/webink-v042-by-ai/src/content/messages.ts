// src/content/messages.ts
// ========================================
// Chrome 消息处理器
// ========================================

import type { TypedMessage, TypedResponse, MessageType } from '../types/messages';
import type { WebInkContent } from './index';
import type { TOCItem } from '../types';

/**
 * 消息处理器
 */
export class MessageHandler {
  private webInk: WebInkContent;

  constructor(webInk: WebInkContent) {
    this.webInk = webInk;
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
        case 'GET_MARKDOWN':
          return await this.getMarkdown(message.data);

        case 'EXTRACT_CONTENT':
          return await this.extractContent(message.data);

        case 'GENERATE_TOC':
          return await this.generateTOC(message.data);

        case 'SAVE_CONFIG':
          return await this.saveConfig(message.data);

        case 'GET_CONFIG':
          return await this.getConfig();

        case 'COPY_TO_CLIPBOARD':
          return await this.copyToClipboard(message.data);

        default:
          return {
            success: false,
            error: `Unknown action: ${message.action}`,
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
   * 获取 Markdown
   */
  private async getMarkdown(data?: any): Promise<TypedResponse<'GET_MARKDOWN'>> {
    const markdown = await this.webInk.getMarkdown({
      includeTOC: data?.includeTOC,
      tocPosition: data?.tocPosition,
    });

    return {
      success: true,
      data: {
        markdown,
        title: document.title,
        sourceUrl: window.location.href,
        domain: window.location.hostname,
        extractedAt: new Date().toISOString(),
      } as any,
    };
  }

  /**
   * 提取内容
   */
  private async extractContent(data?: any): Promise<TypedResponse<'EXTRACT_CONTENT'>> {
    const markdown = await this.webInk.getMarkdown({
      includeTOC: true,
    });

    return {
      success: true,
      data: {
        markdown,
        title: document.title,
        sourceUrl: window.location.href,
        domain: window.location.hostname,
        extractedAt: new Date().toISOString(),
      } as any,
    };
  }

  /**
   * 生成目录
   */
  private async generateTOC(data?: any): Promise<TypedResponse<'GENERATE_TOC'>> {
    const { TOCGenerator } = await import('./toc');
    const tocGen = new TOCGenerator();
    const toc = tocGen.generate(data);

    return {
      success: true,
      data: toc as any,
    };
  }

  /**
   * 保存配置
   */
  private async saveConfig(data?: any): Promise<TypedResponse<'SAVE_CONFIG'>> {
    if (data?.config) {
      this.webInk.updateConfig(data.config);

      // 保存到 chrome.storage
      await chrome.storage.local.set({ webink_config: data.config });
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
    const config = this.webInk.getConfig();

    return {
      success: true,
      data: config as any,
    };
  }

  /**
   * 复制到剪贴板
   */
  private async copyToClipboard(data?: any): Promise<TypedResponse<'COPY_TO_CLIPBOARD'>> {
    try {
      await navigator.clipboard.writeText(data?.text || '');

      return {
        success: true,
        data: { success: true } as any,
      };
    } catch (error) {
      return {
        success: false,
        error: 'Failed to copy to clipboard',
      };
    }
  }
}
