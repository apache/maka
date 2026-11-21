// src/content/highlight.ts
// ========================================
// 内容高亮器
// ========================================

import type { HighlightOptions } from '../types';

/**
 * 默认高亮选项
 */
const DEFAULT_OPTIONS: HighlightOptions = {
  duration: 2300,
  className: 'webink-highlight',
  color: '#ffeb3b',
};

/**
 * 内容高亮器
 */
export class ContentHighlighter {
  private options: HighlightOptions;
  private styleElement: HTMLStyleElement | null = null;

  constructor(options?: HighlightOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.injectStyles();
  }

  /**
   * 注入高亮样式
   */
  private injectStyles(): void {
    if (this.styleElement) {
      return;
    }

    this.styleElement = document.createElement('style');
    this.styleElement.textContent = `
      .${this.options.className!} {
        background-color: ${this.options.color || '#ffeb3b'} !important;
        transition: background-color 0.3s ease;
      }
    `;
    document.head.appendChild(this.styleElement);
  }

  /**
   * 高亮元素
   */
  highlight(element: HTMLElement): void {
    element.classList.add(this.options.className!);

    // 自动移除高亮
    setTimeout(() => {
      element.classList.remove(this.options.className!);
    }, this.options.duration);
  }

  /**
   * 高亮多个元素
   */
  highlightMultiple(elements: HTMLElement[]): void {
    elements.forEach((el, index) => {
      setTimeout(() => {
        this.highlight(el);
      }, index * 100); // 间隔 100ms
    });
  }

  /**
   * 清除所有高亮
   */
  clear(): void {
    document.querySelectorAll(`.${this.options.className!}`).forEach((el) => {
      el.classList.remove(this.options.className!);
    });
  }

  /**
   * 更新选项
   */
  updateOptions(options: Partial<HighlightOptions>): void {
    this.options = { ...this.options, ...options };

    // 重新注入样式
    if (this.styleElement) {
      this.styleElement.remove();
      this.styleElement = null;
      this.injectStyles();
    }
  }

  /**
   * 销毁
   */
  destroy(): void {
    this.clear();
    if (this.styleElement) {
      this.styleElement.remove();
      this.styleElement = null;
    }
  }
}
