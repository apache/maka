import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { HostExtensionRuntime } from '../server/extension-runtime.js';

test('Host Extension authority owns trusted Tool lifecycle and close cleanup', async () => {
  const extensions = new HostExtensionRuntime({
    protectedToolNames: () => ['Read'],
  });
  const weatherV1 = tool('Weather', 1);
  const weatherV2 = tool('Weather', 2);

  await extensions.installTrustedToolRevision({
    extensionId: 'weather',
    revision: '1',
    tools: [weatherV1],
  });
  await extensions.installTrustedToolRevision({
    extensionId: 'weather',
    revision: '2',
    tools: [weatherV2],
  });
  await extensions.activate({
    bindingId: 'weather-binding',
    scopeId: 'session-a',
    extensionId: 'weather',
    revision: '1',
  });

  assert.deepEqual(
    extensions.resolveTools('session-a', [tool('Read', 0)]).map(({ name }) => name),
    ['Read', 'Weather'],
  );
  assert.equal(extensions.resolveTools('session-a', [tool('Read', 0)])[1]?.impl, weatherV1.impl);

  await extensions.update('weather-binding', '2');
  assert.equal(extensions.resolveTools('session-a', [tool('Read', 0)])[1]?.impl, weatherV2.impl);
  assert.equal(extensions.composition('session-a').entries[0]?.revision, '2');

  extensions.beginDrain();
  assert.throws(
    () =>
      extensions.installTrustedToolRevision({
        extensionId: 'late',
        revision: '1',
        tools: [tool('Late', 1)],
      }),
    /draining/,
  );
  // Read-only resolution remains available while already-admitted work drains.
  assert.equal(extensions.resolveTools('session-a', []).length, 1);

  await extensions.close();
  assert.deepEqual(extensions.inspectTools('session-a'), []);
  assert.deepEqual(extensions.installedRevisions(), []);
  assert.throws(() => extensions.resolveTools('session-a', []), /closed/);
  await extensions.close();
});

test('Host Extension close retries lifecycle cleanup before uninstalling revisions', async () => {
  const extensions = new HostExtensionRuntime();
  let cleanupAttempts = 0;
  await extensions.install({
    extensionId: 'retryable',
    revision: '1',
    prepare: () => ({
      activate: (context) => {
        context.ownEffect('retryable-cleanup', () => {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1) throw new Error('cleanup unavailable');
        });
      },
    }),
  });
  await extensions.activate({
    bindingId: 'retryable-binding',
    scopeId: 'session-retry',
    extensionId: 'retryable',
    revision: '1',
  });

  await assert.rejects(extensions.close(), /Unable to close Runtime Host Extension authority/);
  assert.deepEqual(extensions.installedRevisions(), [{ extensionId: 'retryable', revision: '1' }]);

  await extensions.close();
  assert.equal(cleanupAttempts, 2);
  assert.deepEqual(extensions.installedRevisions(), []);
});

function tool(name: string, revision: number): MakaTool {
  return {
    name,
    description: `${name} revision ${revision}`,
    parameters: z.object({}),
    impl: async () => ({ revision }),
  };
}
