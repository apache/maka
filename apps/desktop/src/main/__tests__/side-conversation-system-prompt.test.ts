import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  SIDE_CONVERSATION_SESSION_LABEL,
  type AppSettings,
} from '@maka/core';
import { createSystemPromptMainService } from '../system-prompt-main.js';

function makeService() {
  return createSystemPromptMainService({
    settingsStore: {
      get: async () =>
        ({
          personalization: {},
          workspaceInstructions: { enabled: false },
        }) as AppSettings,
    },
    workspaceRoot: '/tmp/maka-side-conversation-prompt',
    localMemory: {
      getState: async () => ({ status: 'ok', agentReadEnabled: false, content: '' }) as never,
      consumePendingPromptUpdates: () => [],
    },
    taskLedger: { list: async () => [] },
  });
}

describe('side conversation system prompt', () => {
  it('injects the reference-only boundary only for side sessions', async () => {
    const service = makeService();
    const ordinary = await service.buildBackendSystemPrompt(
      { labels: [] },
      undefined,
      { memoryFragment: null },
    );
    const side = await service.buildBackendSystemPrompt(
      { labels: [SIDE_CONVERSATION_SESSION_LABEL] },
      undefined,
      { memoryFragment: null },
    );

    assert.doesNotMatch(ordinary ?? '', /Side conversation boundary/);
    assert.match(side ?? '', /Side conversation boundary/);
    assert.match(side ?? '', /inherited parent history is reference context only/i);
    assert.match(side ?? '', /only when the user explicitly asks/i);
    assert.match(side ?? '', /inherited permission profile allows it/i);
  });
});
