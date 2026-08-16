import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntimeHostDefaultRecovery } from '../runtime-host-default-recovery.js';

test('recovers an unavailable default Host without blocking other Hosts', async () => {
  let defaultProfileId = 'office';
  const prompts: string[] = [];
  let retries = 0;
  let resolveRecovered!: () => void;
  const recovered = new Promise<void>((resolve) => {
    resolveRecovered = resolve;
  });
  const recovery = createRuntimeHostDefaultRecovery({
    defaultProfileId: () => defaultProfileId,
    prompt: async (failure) => {
      prompts.push(failure.error.message);
      return prompts.length === 1 ? 'retry' : 'use_local';
    },
    retry: async () => {
      retries += 1;
      return new Error('still offline');
    },
    useLocal: async () => {
      defaultProfileId = 'local';
      resolveRecovered();
    },
    onError: (error) => assert.fail(error instanceof Error ? error : String(error)),
  });

  recovery.offer({
    profileId: 'background',
    profileName: 'Background',
    error: new Error('not the default'),
  });
  recovery.offer({
    profileId: 'office',
    profileName: 'Office',
    error: new Error('offline'),
  });
  await recovered;

  assert.equal(defaultProfileId, 'local');
  assert.equal(retries, 1);
  assert.deepEqual(prompts, ['offline', 'still offline']);
});
