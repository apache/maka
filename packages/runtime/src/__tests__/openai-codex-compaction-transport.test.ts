import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createOpenAiCodexCompactionTransport,
  OPENAI_CODEX_COMPACTION_V2_HEADER,
} from '../openai-codex-compaction-transport.js';

describe('OpenAI Codex compaction transport', () => {
  test('appends exactly one V2 trigger and strips the private control header', async () => {
    let captured: Request | undefined;
    const transport = createOpenAiCodexCompactionTransport(async (input, init) => {
      captured = new Request(input, init);
      return new Response('{}');
    });

    await transport('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [OPENAI_CODEX_COMPACTION_V2_HEADER]: '1',
      },
      body: JSON.stringify({ model: 'gpt-5.3-codex', input: [{ role: 'user' }] }),
    });

    assert.ok(captured);
    assert.equal(captured.headers.has(OPENAI_CODEX_COMPACTION_V2_HEADER), false);
    assert.deepEqual(await captured.json(), {
      model: 'gpt-5.3-codex',
      input: [{ role: 'user' }, { type: 'compaction_trigger' }],
    });
  });

  test('leaves ordinary requests untouched', async () => {
    const originalInit = { method: 'POST', body: 'opaque' } satisfies RequestInit;
    let capturedInput: RequestInfo | URL | undefined;
    let capturedInit: RequestInit | undefined;
    const transport = createOpenAiCodexCompactionTransport(async (input, init) => {
      capturedInput = input;
      capturedInit = init;
      return new Response('{}');
    });

    await transport('https://chatgpt.com/backend-api/codex/responses', originalInit);

    assert.equal(capturedInput, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(capturedInit, originalInit);
  });

  test('rejects signalled requests outside the expected Responses shape', async () => {
    const transport = createOpenAiCodexCompactionTransport(async () => new Response('{}'));
    await assert.rejects(
      transport('https://chatgpt.com/backend-api/codex/not-responses', {
        method: 'POST',
        headers: { [OPENAI_CODEX_COMPACTION_V2_HEADER]: '1' },
        body: '{}',
      }),
      /Responses endpoint/,
    );
    await assert.rejects(
      transport('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [OPENAI_CODEX_COMPACTION_V2_HEADER]: '1',
        },
        body: JSON.stringify({ input: 'not-an-array' }),
      }),
      /input array/,
    );
    await assert.rejects(
      transport('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [OPENAI_CODEX_COMPACTION_V2_HEADER]: '1',
        },
        body: JSON.stringify({ input: [{ type: 'compaction_trigger' }] }),
      }),
      /already contains/,
    );
  });
});
