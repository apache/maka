// src/content/index.ts
// ========================================
// WebInk Content Script 主入口
// ========================================

import { MarkdownExtractor } from './extractor';
import { TOCGenerator } from './toc';
import { ContentHighlighter } from './highlight';
import { MessageHandler } from './messages';
import type { WebInkConfig } from '../types';

console.log('WebInk: Content script loaded');

/**
 * WebInk Content Script 主类
 */
export class WebInkContent {
  private extractor: MarkdownExtractor;
  private tocGenerator: TOCGenerator;
  private highlighter: ContentHighlighter;
  private messageHandler: MessageHandler;
  private config: WebInkConfig;

  constructor() {
    this.config = {
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
      },
    };

    this.extractor = new MarkdownExtractor(this.config);
    this.tocGenerator = new TOCGenerator();
    this.highlighter = new ContentHighlighter();
    this.messageHandler = new MessageHandler(this);

    this.initialize();
  }

  /**
   * 初始化
   */
  private initialize(): void {
    // 设置消息监听
    this.setupMessageListeners();

    // 如果启用自动提取
    if (this.config.autoExtract) {
      this.autoExtract();
    }
  }

  /**
   * 设置消息监听器
   */
  private setupMessageListeners(): void {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.messageHandler
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
   * 自动提取内容
   */
  private async autoExtract(): Promise<void> {
    // 等待页面加载完成
    if (document.readyState !== 'complete') {
      await new Promise((resolve) => {
        window.addEventListener('load', resolve, { once: true });
      });
    }

    // 检查是否是可读文章页面
    if (this.isArticlePage()) {
      console.log('WebInk: Auto-extracting article content');
      await this.extractor.extract();
    }
  }

  /**
   * 判断是否是文章页面
   */
  private isArticlePage(): boolean {
    // 检查是否有文章相关的元素
    const articleElement = document.querySelector('article');
    const hasContent = document.body.innerText.length > 500;

    return !!(articleElement || hasContent);
  }

  /**
   * 获取 Markdown 内容
   */
  async getMarkdown(options?: {
    includeTOC?: boolean;
    tocPosition?: 'top' | 'bottom' | 'custom';
  }): Promise<string> {
    const markdown = await this.extractor.convert();

    if (options?.includeTOC) {
      const toc = await this.tocGenerator.generate();
      const tocMarkdown = this.tocGenerator.toMarkdown(toc);

      return this.insertTOC(markdown, tocMarkdown, options.tocPosition);
    }

    return markdown;
  }

  /**
   * 插入目录到 Markdown
   */
  private insertTOC(
    markdown: string,
    toc: string,
    position: 'top' | 'bottom' | 'custom' = 'top'
  ): string {
    switch (position) {
      case 'top':
        return `${toc}\n\n${markdown}`;
      case 'bottom':
        return `${markdown}\n\n${toc}`;
      case 'custom':
        if (markdown.includes('{{toc}}')) {
          return markdown.replace('{{toc}}', toc.trim());
        }
        return `${toc}\n\n${markdown}`;
      default:
        return markdown;
    }
  }

  /**
   * 高亮元素
   */
  highlight(element: HTMLElement): void {
    if (this.config.enableHighlight) {
      this.highlighter.highlight(element);
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<WebInkConfig>): void {
    this.config = { ...this.config, ...config };
    this.extractor.updateConfig(this.config);
  }

  /**
   * 获取配置
   */
  getConfig(): WebInkConfig {
    return { ...this.config };
  }
}

// 初始化 WebInk
const webInk = new WebInkContent();

// 导出到全局作用域（用于调试）
(window as any).WebInk = webInk;
