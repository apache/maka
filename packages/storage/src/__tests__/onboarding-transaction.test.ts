import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  readConnectionOnboardingIntent,
  writeConnectionOnboardingIntent,
  prepareConnectionOnboardingIntent,
} from '../runtime-policy/onboarding-transaction.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'maka-onboarding-intent-'));
  roots.push(directory);
  return directory;
}

after(async () => {
  await Promise.all(roots.map((directory) => rm(directory, { recursive: true, force: true })));
});

const BASE = {
  connectionId: '00000000-0000-4000-8000-000000000001',
  providerType: 'openai-compatible',
  suppliedSecret: 'relay-secret',
  enabledModelIds: ['relay/model'],
  discovery: { models: [{ id: 'relay/model' }], source: 'fetched', fetchedAt: 123 },
  invalidateLastTest: false,
};

test('an onboarding intent round-trips its endpoint override through the journal', async () => {
  const directory = await root();
  const intent = prepareConnectionOnboardingIntent({
    ...BASE,
    baseUrl: 'https://relay.example.test/v1',
  });
  await writeConnectionOnboardingIntent(directory, intent);
  assert.deepEqual(await readConnectionOnboardingIntent(directory), intent);
});

test('a journal written before the baseUrl field replays as no override', async () => {
  const directory = await root();
  // The exact persisted shape an older build leaves behind on crash: no
  // `baseUrl` key at all. Recovery must replay it, not reject the document.
  await writeFile(
    join(directory, 'runtime-policy-onboarding.json'),
    JSON.stringify({ schemaVersion: 1, ...BASE }),
  );
  const replayed = await readConnectionOnboardingIntent(directory);
  assert.equal(replayed?.baseUrl, null);
  assert.deepEqual(replayed?.enabledModelIds, ['relay/model']);
});
