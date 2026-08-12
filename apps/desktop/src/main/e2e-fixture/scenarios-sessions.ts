import type { SessionHeader, StoredMessage } from '@maka/core/session';
import {
  header,
  LONG_SIDEBAR_PROJECT_ID,
  LONG_SIDEBAR_PROJECT_SESSION_COUNT,
  LONG_SIDEBAR_SESSION_COUNT,
  LONG_SIDEBAR_SESSION_PREFIX,
} from './seed-helpers.js';

export function longSidebarSessions(
  now: number,
): Array<{ header: SessionHeader; messages: StoredMessage[] }> {
  return Array.from({ length: LONG_SIDEBAR_SESSION_COUNT }, (_, index) => {
    const suffix = String(index).padStart(2, '0');
    const sessionId = LONG_SIDEBAR_SESSION_PREFIX + suffix;
    const lastMessageAt = now - index * 5 * 60_000;
    return {
      header: header({
        id: sessionId,
        name: `会话 ${suffix}`,
        connection: 'zai-live',
        model: 'glm-5.1',
        now,
        lastMessageAt,
        ...(index < LONG_SIDEBAR_PROJECT_SESSION_COUNT
          ? { projectId: LONG_SIDEBAR_PROJECT_ID }
          : {}),
      }),
      messages: [
        {
          type: 'user',
          id: `msg-long-user-${suffix}`,
          turnId: `turn-long-${suffix}`,
          ts: lastMessageAt - 30_000,
          text: `示例对话 ${suffix}`,
        },
        {
          type: 'assistant',
          id: `msg-long-assistant-${suffix}`,
          turnId: `turn-long-${suffix}`,
          ts: lastMessageAt,
          text: `已归档第 ${suffix} 条研究记录。`,
          modelId: 'glm-5.1',
        },
      ],
    };
  });
}
