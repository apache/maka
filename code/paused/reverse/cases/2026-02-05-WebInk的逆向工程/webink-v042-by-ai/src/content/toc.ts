// src/content/toc.ts
// ========================================
// TOC (Table of Contents) 生成器
// ========================================

import type { TOCItem } from '../types';

/**
 * TOC 生成器
 */
export class TOCGenerator {
  private headings: Map<string, TOCItem> = new Map();
  private observer: IntersectionObserver | null = null;
  private activeHeadingId: string | null = null;

  /**
   * 从 DOM 生成目录
   */
  generate(options?: {
    selector?: string;
    minLevel?: number;
    maxLevel?: number;
  }): TOCItem[] {
    const selector = options?.selector || 'h1, h2, h3, h4, h5, h6';
    const minLevel = options?.minLevel || 1;
    const maxLevel = options?.maxLevel || 6;

    const elements = document.querySelectorAll(selector);
    const toc: TOCItem[] = [];

    elements.forEach((element, index) => {
      if (!(element instanceof HTMLElement)) return;

      const level = parseInt(element.tagName[1]);
      if (level < minLevel || level > maxLevel) return;

      const text = element.textContent?.trim();
      if (!text) return;

      const id = element.id || `heading-${index}`;
      if (!element.id) {
        element.id = id;
      }

      const item: TOCItem = {
        id,
        text,
        level,
        element,
      };

      toc.push(item);
      this.headings.set(id, item);
    });

    return toc;
  }

  /**
   * 从 DOM 中提取目录（别名）
   */
  extractFromDOM(options?: {
    selector?: string;
    minLevel?: number;
    maxLevel?: number;
  }): TOCItem[] {
    return this.generate(options);
  }

  /**
   * 将目录转换为 Markdown 格式
   */
  toMarkdown(toc: TOCItem[]): string {
    if (toc.length === 0) {
      return '';
    }

    const lines: string[] = [];
    lines.push('## 目录\n');

    toc.forEach((item) => {
      const indent = '  '.repeat(item.level - 1);
      const link = `[#${item.text}](#${item.id})`;
      lines.push(`${indent}- ${link}`);
    });

    return lines.join('\n');
  }

  /**
   * 开始追踪活动标题
   */
  startTracking(): void {
    if (this.observer) {
      return; // 已经在追踪
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const element = entry.target as HTMLElement;
            this.activeHeadingId = element.id;
            this.highlightActiveItem(element.id);
          }
        });
      },
      {
        rootMargin: '-100px 0px -66%',
        threshold: 0,
      }
    );

    // 追踪所有标题
    this.headings.forEach((item) => {
      if (item.element) {
        this.observer?.observe(item.element);
      }
    });
  }

  /**
   * 停止追踪活动标题
   */
  stopTracking(): void {
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  /**
   * 高亮活动目录项
   */
  private highlightActiveItem(id: string): void {
    // 移除所有高亮
    document.querySelectorAll('.webink-toc-item.active').forEach((el) => {
      el.classList.remove('active');
    });

    // 添加高亮到当前项
    const activeItem = document.querySelector(`.webink-toc-item[data-id="${id}"]`);
    if (activeItem) {
      activeItem.classList.add('active');
    }
  }

  /**
   * 滚动到指定标题
   */
  scrollToHeading(id: string): void {
    const item = this.headings.get(id);
    if (item?.element) {
      item.element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /**
   * 获取当前活动标题
   */
  getActiveHeading(): string | null {
    return this.activeHeadingId;
  }

  /**
   * 清除目录
   */
  clear(): void {
    this.stopTracking();
    this.headings.clear();
    this.activeHeadingId = null;
  }
}
