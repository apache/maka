// ========================================
// Chat Memo — 平台适配器基类
// 来源：js/core/base.js (27,944 字节, ~913 行)
// 职责：所有平台适配器的抽象基类，提供消息提取、
//       DOM 监听、增量保存、对话管理、URL 检测等公共逻辑
// ========================================

import type { Conversation, Message, MessageSender, PlatformId } from '../types';

// ========================================
// 适配器基类
// ========================================

export abstract class BasePlatformAdapter {
  platform: PlatformId;
  pageUrl: string;
  currentConversationId: string | null = null;
  savedMessageIds: Set<string> = new Set();
  lastCheckTime = 0;
  isChecking = false;

  protected contentObserver: MutationObserver | null = null;
  protected currentMessagesMap: Map<string, string> = new Map();
  protected debounceTimer: ReturnType<typeof setTimeout> | null = null;
  protected lastMessagesJson: string | null = null;
  protected lastKnownUrl = '';
  protected lastKnownConversationId: string | null = null;
  protected urlCheckInterval: ReturnType<typeof setInterval> | null = null;
  protected isCreatingConversation = false;
  protected creationPromise: Promise<string | null> | null = null;
  protected currentUrlKey: string | null = null;
  protected _saveTrigger: string | null = null;

  readonly CHECK_INTERVAL = 2000;
  readonly DEBOUNCE_DELAY = 1000;

  // 全局对象引用（由 content script 注入到 window）
  protected compatibility: unknown = null;
  protected storageManager: unknown = null;

  constructor(platform: PlatformId) {
    this.platform = platform;
    this.pageUrl = window.location.href;
    this.initializeComponents();
  }

  // ========================================
  // 抽象方法 — 子类必须实现
  // ========================================

  /** 验证是否为有效的对话 URL */
  abstract isValidConversationUrl(url: string): boolean;

  /** 从 URL 提取对话信息 */
  abstract extractConversationInfo(url: string): { conversationId: string | null; isNewConversation: boolean };

  /** 提取页面上的所有消息 */
  abstract extractMessages(): Message[];

  /** 检查 DOM 节点是否为消息元素 */
  abstract isMessageElement(node: Node): boolean;

  // ========================================
  // 可选重写方法
  // ========================================

  /** 从页面提取标题（默认返回 null） */
  extractTitle(): string | null { return null; }

  // 初始化组件引用
  private initializeComponents(): void {
    // 这些由 content script 在适配器加载前注入到 window
    this.compatibility = (window as any).Compatibility ? new (window as any).Compatibility() : null;
    this.storageManager = (window as any).StorageManager ? new (window as any).StorageManager() : null;
  }

  // ========================================
  // 公共方法 — 消息构造
  // ========================================

  /**
   * 统一构造消息对象 —— adapter → core 消息形状的**唯一构造入口**
   */
  buildMessage(sender: MessageSender, content: string, opts: { thinking?: string; position: number }): Message {
    const now = new Date().toISOString();
    return {
      messageId: this.generateMessageId(sender, content, opts.position),
      sender,
      content,
      thinking: opts.thinking || '',
      position: opts.position,
      createdAt: now,
      updatedAt: now,
    };
  }

  generateMessageId(sender: string, _content: string, index: number): string {
    return `msg_${sender}_position_${index}`;
  }

  // ========================================
  // 对话管理
  // ========================================

  async connectToDatabase(): Promise<void> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'connectDB' }, (response: any) => {
        if (response?.status === 'ok') resolve();
        else reject('数据库连接失败');
      });
    });
  }

  async findConversation(): Promise<string | null> {
    return new Promise((resolve) => {
      const id = this.lastKnownConversationId;
      if (id && !id.startsWith('new_conversation_')) {
        chrome.runtime.sendMessage({ type: 'findConversationById', conversationId: id }, (resp: any) => {
          if (resp?.conversation) { resolve(resp.conversation.conversationId); return; }
          this.fallbackToUrlSearch(resolve);
        });
      } else {
        this.fallbackToUrlSearch(resolve);
      }
    });
  }

  private fallbackToUrlSearch(resolve: (v: string | null) => void): void {
    const cleanUrl = this.pageUrl.split('?')[0];
    chrome.runtime.sendMessage({ type: 'findConversationByUrl', url: cleanUrl }, (resp: any) => {
      resolve(resp?.conversation?.conversationId || null);
    });
  }

  generateTitleFromMessages(messages: Message[]): string {
    const first = messages.find((m) => m.sender === 'user');
    if (first) {
      return first.content.length > 50 ? first.content.substring(0, 50) + '...' : first.content;
    }
    return '新对话';
  }

  extractFormattedContent(element: Element): string {
    if (!element) return '';
    const text = (element as HTMLElement).innerText || element.textContent || '';
    return text.trim().replace(/\n\s*\n\s*\n/g, '\n\n');
  }

  // ========================================
  // DOM 监听
  // ========================================

  setupMutationObserver(): MutationObserver {
    this.updateCurrentMessagesMap();
    const observer = new MutationObserver((mutations) => {
      if (!(window as any).keepAIMemorySettings?.autoSave) return;
      let hasChange = false;
      for (const m of mutations) {
        if (m.type === 'childList') {
          for (const node of m.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && this.isMessageElement(node as Element)) { hasChange = true; break; }
          }
          if (!hasChange) {
            for (const node of m.removedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE && this.isMessageElement(node as Element)) { hasChange = true; break; }
            }
          }
        }
        if (hasChange) break;
      }
      if (hasChange) {
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => this.checkForActualMessageChanges(), this.DEBOUNCE_DELAY);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    return observer;
  }

  updateCurrentMessagesMap(): Message[] {
    const messages = this.extractMessages();
    this.currentMessagesMap = new Map(messages.map((m) => [m.messageId, m.content]));
    return messages;
  }

  private async checkForActualMessageChanges(): Promise<void> {
    if (!(window as any).keepAIMemorySettings?.autoSave) return;
    // 简化实现：每次变更都触发保存
    await this.checkForNewMessages();
  }

  async checkForNewMessages(): Promise<void> {
    if (this.isChecking) return;
    this.isChecking = true;
    try { await this.saveAllMessages(); }
    finally { this.isChecking = false; }
  }

  // ========================================
  // 保存逻辑
  // ========================================

  async saveAllMessages(): Promise<void> {
    if (!this.currentConversationId) return;
    const messages = this.extractMessages();
    if (messages.length === 0) return;

    if (this.storageManager) {
      const result = await (this.storageManager as any).smartIncrementalUpdate(this.currentConversationId, messages);
      if (result?.success && !result.skipped) {
        (window as any).keepAIMemoryCommon?.showSuccessStatus();
      }
    }
  }

  // ========================================
  // 启动
  // ========================================

  start(): void {
    this.init();
    this.setupEventListeners();
    this.setupPageUnloadDetection();
    this.initialBoot();
  }

  private init(): void {
    if (this.isValidConversationUrl(this.pageUrl)) {
      setTimeout(() => this.initAdapter(), 100);
    }
  }

  private initAdapter(options: { url?: string; conversationId?: string; isNewConversation?: boolean } = {}): void {
    if (this.contentObserver) { this.contentObserver.disconnect(); this.contentObserver = null; }

    this.pageUrl = options.url || window.location.href;
    const cleanUrl = this.pageUrl.split('?')[0];
    const urlKey = `${this.platform}_${cleanUrl}`;
    if (this.currentUrlKey !== urlKey) { this.isCreatingConversation = false; this.creationPromise = null; this.currentUrlKey = urlKey; }

    this.connectToDatabase()
      .then(() => (window as any).keepAIMemorySettings?.autoSave
        ? this.findOrCreateConversation()
        : this.findConversation())
      .then((id) => {
        if (!id) return Promise.reject('No conversation ID');
        this.currentConversationId = id;
        if ((window as any).keepAIMemorySettings?.autoSave) {
          return this.saveAllMessages();
        }
      })
      .then(() => {
        if (!this.currentConversationId) return;
        if ((window as any).keepAIMemorySettings?.autoSave) {
          this.contentObserver = this.setupMutationObserver();
        }
      })
      .catch((err) => { if (err !== 'No conversation ID') console.error('Init failed:', err); });
  }

  async findOrCreateConversation(): Promise<string | null> {
    const cleanUrl = this.pageUrl.split('?')[0];
    const urlKey = `${this.platform}_${cleanUrl}`;
    if (this.isCreatingConversation && this.currentUrlKey === urlKey && this.creationPromise) {
      return this.creationPromise;
    }
    this.isCreatingConversation = true;
    this.currentUrlKey = urlKey;

    this.creationPromise = new Promise((resolve) => {
      const tryExtract = (retry = 0) => {
        const msgs = this.extractMessages();
        if (msgs.length === 0 && retry < 3) { setTimeout(() => tryExtract(retry + 1), 1000 * (retry + 1)); return; }
        if (msgs.length === 0) { resolve(null); return; }

        // 先查 URL 再创建
        chrome.runtime.sendMessage({ type: 'findConversationByUrl', url: cleanUrl }, async (resp: any) => {
          if (resp?.conversation) { resolve(resp.conversation.conversationId); return; }

          const title = this.extractTitle() || this.generateTitleFromMessages(msgs);
          chrome.runtime.sendMessage({
            type: 'createConversation',
            conversation: { link: cleanUrl, title, platform: this.platform, messages: msgs },
          }, (createResp: any) => {
            if (createResp?.conversationId) {
              (window as any).keepAIMemoryCommon?.showSuccessStatus();
              resolve(createResp.conversationId);
            } else {
              resolve(null);
            }
          });
        });
      };
      tryExtract();
    });

    this.creationPromise.finally(() => { this.isCreatingConversation = false; this.creationPromise = null; });
    return this.creationPromise;
  }

  private setupEventListeners(): void {
    window.addEventListener('keep-ai-memory-manual-save', () => this.handleManualSave());
    window.addEventListener('keep-ai-memory-url-changed', ((e: CustomEvent) => {
      const { url, conversationId, isNewConversation } = e.detail;
      if (url && this.isValidConversationUrl(url) && conversationId) {
        setTimeout(() => this.initAdapter({ url, conversationId, isNewConversation }), 100);
      }
    }) as EventListener);
  }

  private async handleManualSave(): Promise<void> {
    if (!this.isValidConversationUrl(window.location.href)) return;
    const { conversationId } = this.extractConversationInfo(window.location.href);
    if (conversationId) this.lastKnownConversationId = conversationId;
    await this.connectToDatabase();
    const found = await this.findOrCreateConversation();
    if (found) { this.currentConversationId = found; this._saveTrigger = 'manual'; await this.saveAllMessages(); }
  }

  startUrlWatcher(): void {
    if (this.urlCheckInterval) clearInterval(this.urlCheckInterval);
    this.handleUrlCheck();
    this.urlCheckInterval = setInterval(() => this.handleUrlCheck(), 1000);
  }

  private handleUrlCheck(): void {
    const url = window.location.href;
    const baseUrl = url.split('?')[0];
    if (!this.isValidConversationUrl(url)) return;
    const { conversationId, isNewConversation } = this.extractConversationInfo(url);
    if (!conversationId) return;
    if (baseUrl !== this.lastKnownUrl || conversationId !== this.lastKnownConversationId) {
      this.lastKnownUrl = baseUrl;
      this.lastKnownConversationId = conversationId;
      window.dispatchEvent(new CustomEvent('keep-ai-memory-url-changed', { detail: { url, conversationId, isNewConversation } }));
    }
  }

  private setupPageUnloadDetection(): void {
    let unloading = false;
    window.addEventListener('beforeunload', () => { unloading = true; });
    (window as any).keepAIMemory = Object.assign((window as any).keepAIMemory || {}, { isPageUnloading: () => unloading });
  }

  private initialBoot(): void {
    if ((window as any).keepAIMemorySettings) { this.startUrlWatcher(); }
    else { setTimeout(() => this.initialBoot(), 100); }
  }
}
