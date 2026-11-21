// src/content/extractor.ts
// ========================================
// Markdown 提取器 - 使用 Turndown 和 Readability
// ========================================

import type {
  WebInkConfig,
  ExtractedContent,
  MarkdownOptions,
} from '../types';

/**
 * Markdown 提取器
 *
 * 使用 Turndown 库将 HTML 转换为 Markdown
 * 使用 Readability 库提取文章主要内容
 */
export class MarkdownExtractor {
  private turndownService: any; // TurndownService
  private readability: any; // Readability
  private config: WebInkConfig;

  constructor(config: WebInkConfig) {
    this.config = config;
    this.turndownService = this.createTurndownService();
    this.readability = this.createReadability();
  }

  /**
   * 创建 Turndown 服务实例
   */
  private createTurndownService(): any {
    // 注意：这是从 dist.js 加载的 Turndow nService
    const TurndownService = (window as any).turndown?.TurndownService;
    if (!TurndownService) {
      console.warn('WebInk: TurndownService not found');
      return null;
    }

    const service = new TurndownService(this.config.markdownOptions);

    // 添加 GFM 支持
    if (this.config.markdownOptions?.gfm) {
      const gfm = (window as any).turndownPluginGfm?.gfm;
      if (gfm) {
        service.use(gfm);
      }
    }

    return service;
  }

  /**
   * 创建 Readability 实例
   */
  private createReadability(): any {
    const Readability = (window as any).Readability;
    if (!Readability) {
      console.warn('WebInk: Readability not found');
      return null;
    }
    return Readability;
  }

  /**
   * 转换当前页面为 Markdown
   */
  async convert(): Promise<string> {
    const extracted = await this.extract();
    return extracted.markdown;
  }

  /**
   * 提取文章内容
   */
  async extract(): Promise<ExtractedContent> {
    // 使用 Readability 提取主要内容
    const article = this.extractArticle();

    // 转换为 Markdown
    const markdown = this.htmlToMarkdown(article.content);

    // 生成目录
    const toc = this.extractTOC(article.content);

    return {
      markdown,
      title: article.title,
      author: article.byline,
      publishedTime: article.publishedTime,
      toc,
      wordCount: this.countWords(markdown),
      extractedAt: new Date().toISOString(),
      sourceUrl: window.location.href,
      domain: window.location.hostname,
    };
  }

  /**
   * 使用 Readability 提取文章
   */
  private extractArticle(): any {
    if (!this.readability) {
      // 降级：使用整个 document.body
      return {
        title: document.title,
        content: document.body.innerHTML,
        textContent: document.body.innerText,
        byline: '',
        publishedTime: undefined,
      };
    }

    const documentClone = document.cloneNode(true) as Document;
    const reader = new this.readability(documentClone);
    const article = reader.parse();

    return article || {
      title: document.title,
      content: document.body.innerHTML,
      textContent: document.body.innerText,
    };
  }

  /**
   * HTML 转 Markdown
   */
  private htmlToMarkdown(html: string): string {
    if (!this.turndownService) {
      // 降级：返回纯文本
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return doc.body.innerText || '';
    }

    return this.turndownService.turndown(html);
  }

  /**
   * 从 HTML 中提取目录
   */
  private extractTOC(html: string): any[] {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const headings = doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
    const toc: any[] = [];

    headings.forEach((heading, index) => {
      const level = parseInt(heading.tagName[1]);
      const text = heading.textContent?.trim() || '';

      if (text) {
        toc.push({
          id: `heading-${index}`,
          text,
          level,
        });
      }
    });

    return toc;
  }

  /**
   * 统计字数
   */
  private countWords(markdown: string): number {
    // 移除 Markdown 语法
    const text = markdown
      .replace(/```[\s\S]*?```/g, '') // 代码块
      .replace(/`[^`]+`/g, '') // 行内代码
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // 链接
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // 图片
      .replace(/[#*_~`-]/g, '') // Markdown 符号
      .trim();

    return text.split(/\s+/).filter(Boolean).length;
  }

  /**
   * 更新配置
   */
  updateConfig(config: WebInkConfig): void {
    this.config = config;
    // 重新创建服务实例以应用新配置
    this.turndownService = this.createTurndownService();
  }
}
