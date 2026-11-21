// ========================================
// Chat Memo — ChatGPT 平台适配器（示例）
// 来源：js/adapters/chatgpt.js (5,972 字节)
//
// 实际项目中包含 8 个适配器：
// - chatgpt.js    ChatGPT
// - claude.js     Claude
// - deepseek.js   DeepSeek
// - gemini.js     Gemini
// - yuanbao.js    腾讯元宝
// - doubao.js     豆包
// - kimi.js       Kimi
// - qianwen.js    千问
//
// 所有适配器继承 BasePlatformAdapter，仅需实现 3 个抽象方法。
// ========================================

import { BasePlatformAdapter } from '../core/base';
import type { PlatformId, Message } from '../types';

export class ChatGPTAdapter extends BasePlatformAdapter {
  constructor() {
    super('chatgpt' as PlatformId);
  }

  isValidConversationUrl(url: string): boolean {
    try {
      const u = new URL(url);
      if (!u.hostname.includes('chatgpt.com') && !u.hostname.includes('chat.openai.com')) return false;
      const validPatterns = [/^\/c\/[^/]+$/, /^\/g\/[^/]+\/c\/[^/]+$/];
      return validPatterns.some((p) => p.test(u.pathname));
    } catch { return false; }
  }

  extractConversationInfo(url: string): { conversationId: string | null; isNewConversation: boolean } {
    try {
      const pathname = new URL(url).pathname;
      const clean = pathname.startsWith('/') ? pathname.substring(1) : pathname;
      if (clean && clean !== 'c' && clean !== 'chat') {
        return { conversationId: clean.replace(/\//g, '_'), isNewConversation: false };
      }
    } catch { /* ignore */ }
    return { conversationId: null, isNewConversation: false };
  }

  isMessageElement(node: Node): boolean {
    return (
      node.nodeType === Node.ELEMENT_NODE &&
      (node as Element).hasAttribute?.('data-testid') &&
      (node as Element).getAttribute('data-testid')!.startsWith('conversation-turn-')
    );
  }

  extractMessages(): Message[] {
    const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
    const messages: Message[] = [];
    turns.forEach((turn, idx) => {
      const roleAttr = turn.getAttribute('data-message-author-role');
      const sender = roleAttr === 'user' ? 'user' : 'AI';
      const content = this.extractFormattedContent(turn);
      if (content) {
        messages.push(this.buildMessage(sender, content, { position: idx }));
      }
    });
    return messages;
  }

  extractTitle(): string | null {
    const titleEl = document.querySelector('title');
    if (titleEl) {
      const t = titleEl.textContent?.replace(' - ChatGPT', '').replace('ChatGPT', '').trim();
      return t || null;
    }
    return null;
  }
}
