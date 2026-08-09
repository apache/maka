import type { BotSessionAdapter } from '../bot-session-adapter.js';

export function createTestBotSessionAdapter(
  overrides: Partial<BotSessionAdapter> = {},
): BotSessionAdapter {
  return {
    async resolveSession() {
      return { kind: 'ready', sessionId: 'bot-session-1' };
    },
    async releaseConversation() {
      return false;
    },
    async runTurn() {
      return { kind: 'completed', text: 'ok' };
    },
    ...overrides,
  };
}
