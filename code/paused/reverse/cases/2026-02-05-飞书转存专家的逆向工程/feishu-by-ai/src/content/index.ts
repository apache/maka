// src/content/index.ts
// ========================================
// 飞书转存专家 - Content Script
// ========================================

import type { ExportFormat, ExportOptions, ExportResult, FeishuDocument } from '../types';

console.log('飞书转存专家: Content script loaded');

/**
 * 飞书文档内容脚本
 */
export class FeishuContent {
  private documentInfo: FeishuDocument | null = null;

  constructor() {
    this.initialize();
  }

  /**
   * 初始化
   */
  private initialize(): void {
    // 提取文档信息
    this.documentInfo = this.extractDocumentInfo();

    // 设置消息监听器
    this.setupMessageListeners();

    // 注入导出脚本
    this.injectExportScript();
  }

  /**
   * 提取文档信息
   */
  private extractDocumentInfo(): FeishuDocument | null {
    try {
      const url = window.location.href;
      const title = document.title || '飞书文档';

      // 从 URL 提取文档 ID
      const docIdMatch = url.match(/\/docs\/([a-zA-Z0-9_-]+)/);
      const id = docIdMatch ? docIdMatch[1] : this.generateId();

      // 检测文档类型
      const type = this.detectDocumentType();

      return {
        id,
        title,
        type,
        url,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      console.error('飞书转存专家: 提取文档信息失败', error);
      return null;
    }
  }

  /**
   * 检测文档类型
   */
  private detectDocumentType(): FeishuDocument['type'] {
    const url = window.location.href;

    if (url.includes('/docs/')) return 'doc';
    if (url.includes('/sheets/')) return 'sheet';
    if (url.includes('/bitable/')) return 'bitable';
    if (url.includes('/mindmap/')) return 'mindmap';

    return 'doc';
  }

  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    return `feishu_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 设置消息监听器
   */
  private setupMessageListeners(): void {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender)
        .then((response) => {
          sendResponse(response);
        })
        .catch((error) => {
          sendResponse({
            success: false,
            error: error.message
          });
        });

      return true; // 保持消息通道开启
    });
  }

  /**
   * 处理消息
   */
  private async handleMessage(message: any, sender: chrome.runtime.MessageSender): Promise<any> {
    switch (message.action) {
      case 'GET_DOCUMENT_INFO':
        return { success: true, data: this.documentInfo };

      case 'EXPORT_DOCUMENT':
        return await this.exportDocument(message.data);

      case 'COPY_CONTENT':
        return await this.copyContent();

      default:
        return { success: false, error: '未知操作' };
    }
  }

  /**
   * 导出文档
   */
  private async exportDocument(options: { format: ExportFormat; exportOptions?: ExportOptions }): Promise<ExportResult> {
    try {
      // 调用注入的导出器
      const exporter = (window as any).FeishuExporter;
      if (!exporter) {
        throw new Error('导出器未加载');
      }

      let result: ExportResult;

      switch (options.format) {
        case 'pdf':
          result = await exporter.exportToPDF(options.exportOptions);
          break;
        case 'word':
          result = await exporter.exportToWord(options.exportOptions);
          break;
        case 'markdown':
          result = await exporter.exportToMarkdown(options.exportOptions);
          break;
        case 'html':
          result = await exporter.exportToHTML(options.exportOptions);
          break;
        case 'image':
          result = await exporter.exportToImage(options.exportOptions);
          break;
        default:
          throw new Error('不支持的导出格式');
      }

      // 下载文件
      if (result.success && result.data) {
        await this.downloadFile(result.data as Blob, result.filename!, result.mimeType!);
      }

      return result;
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 复制内容
   */
  private async copyContent(): Promise<{ success: boolean; error?: string }> {
    try {
      const exporter = (window as any).FeishuExporter;
      if (!exporter) {
        throw new Error('导出器未加载');
      }

      // 获取 Markdown 格式
      const result = await exporter.exportToMarkdown();
      if (!result.success || !result.data) {
        throw new Error('获取内容失败');
      }

      const text = await (result.data as Blob).text();

      // 复制到剪贴板
      await navigator.clipboard.writeText(text);

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * 下载文件
   */
  private async downloadFile(blob: Blob, filename: string, mimeType: string): Promise<void> {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.type = mimeType;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * 注入导出脚本
   */
  private injectExportScript(): void {
    // 检查是否已注入
    if ((window as any).FeishuExporter) {
      return;
    }

    // 动态加载 injected.js
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('injected.js');
    script.onload = () => {
      script.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  /**
   * 显示消息
   */
  showMessage(message: string, type: 'success' | 'error' | 'info' = 'info'): void {
    // 创建消息元素
    const messageEl = document.createElement('div');
    messageEl.className = `feishu-export-message feishu-export-${type}`;
    messageEl.textContent = message;

    // 添加样式
    Object.assign(messageEl.style, {
      position: 'fixed',
      top: '20px',
      right: '20px',
      padding: '12px 20px',
      borderRadius: '8px',
      fontSize: '14px',
      fontWeight: '500',
      zIndex: '999999',
      boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
      transition: 'all 0.3s ease'
    });

    if (type === 'success') {
      messageEl.style.backgroundColor = '#52c41a';
      messageEl.style.color = '#ffffff';
    } else if (type === 'error') {
      messageEl.style.backgroundColor = '#ff4d4f';
      messageEl.style.color = '#ffffff';
    } else {
      messageEl.style.backgroundColor = '#1890ff';
      messageEl.style.color = '#ffffff';
    }

    document.body.appendChild(messageEl);

    // 3秒后移除
    setTimeout(() => {
      messageEl.style.opacity = '0';
      messageEl.style.transform = 'translateX(100px)';
      setTimeout(() => {
        messageEl.remove();
      }, 300);
    }, 3000);
  }
}

// 初始化
const feishuContent = new FeishuContent();

// 导出到全局作用域供调试
(window as any).FeishuContent = feishuContent;
