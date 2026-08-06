import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebFetchExecutor } from '@maka/runtime';
import { buildWebFetchAgentTool } from '../web-fetch/agent-tool.js';

test('embedded Desktop WebFetch delegates to the shared local executor', async () => {
  const requested: string[] = [];
  const tool = buildWebFetchAgentTool({
    getPrivacyContext: async () => ({ incognitoActive: false }),
    executor: executor(async ({ url }) => {
      requested.push(url);
      return 'page body';
    }),
  });

  const result = await tool.impl(
    { url: 'https://example.com/a/../page' },
    context(),
  );

  assert.equal(result, 'page body');
  assert.deepEqual(requested, ['https://example.com/page']);
});

test('embedded Desktop WebFetch fails closed when privacy mode is active', async () => {
  let called = false;
  const tool = buildWebFetchAgentTool({
    getPrivacyContext: async () => ({ incognitoActive: true }),
    executor: executor(async () => {
      called = true;
      return 'must not fetch';
    }),
  });

  await assert.rejects(
    async () => tool.impl({ url: 'https://example.com/page' }, context()),
    /disabled while privacy mode is active/i,
  );
  assert.equal(called, false);
});

function executor(fetch: WebFetchExecutor['fetch']): WebFetchExecutor {
  return { fetch };
}

function context() {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd: '/tmp',
    toolCallId: 'tool-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}
