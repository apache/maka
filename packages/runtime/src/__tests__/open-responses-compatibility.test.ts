import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenResponsesCompatibilityFetch } from '../open-responses-compatibility.js';

test('forces store false after caller request customization', async () => {
  let observed: Record<string, unknown> | undefined;
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    observed = JSON.parse(String(init?.body));
    return Response.json({ ok: true });
  }) as unknown as typeof globalThis.fetch;
  const compatible = createOpenResponsesCompatibilityFetch(fetch, ['force-store-false']);

  await compatible('https://provider.invalid/responses', {
    method: 'POST',
    body: JSON.stringify({ model: 'qwen3.8-max', store: true }),
  });

  assert.deepEqual(observed, { model: 'qwen3.8-max', store: false });
});

test('rejects unsupported forced tool choice before network dispatch', async () => {
  let calls = 0;
  const fetch = (async () => {
    calls += 1;
    return Response.json({ ok: true });
  }) as unknown as typeof globalThis.fetch;
  const compatible = createOpenResponsesCompatibilityFetch(fetch, ['reject-forced-tool-choice']);

  for (const toolChoice of ['required', { type: 'function', name: 'lookup' }]) {
    await assert.rejects(
      () =>
        compatible('https://provider.invalid/responses', {
          method: 'POST',
          body: JSON.stringify({ tool_choice: toolChoice }),
        }),
      /does not support forced tool_choice/,
    );
  }
  assert.equal(calls, 0);
});

test('leaves auto and absent tool choice unchanged', async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true });
  }) as unknown as typeof globalThis.fetch;
  const compatible = createOpenResponsesCompatibilityFetch(fetch, ['reject-forced-tool-choice']);

  await compatible('https://provider.invalid/responses', {
    body: JSON.stringify({ tool_choice: 'auto' }),
  });
  await compatible('https://provider.invalid/responses', { body: JSON.stringify({ model: 'm' }) });
  assert.deepEqual(bodies, [{ tool_choice: 'auto' }, { model: 'm' }]);
});

test('rejects duplicate module ownership at composition time', () => {
  assert.throws(
    () =>
      createOpenResponsesCompatibilityFetch(globalThis.fetch, [
        'force-store-false',
        'force-store-false',
      ]),
    /Duplicate Open Responses compatibility module/,
  );
});
