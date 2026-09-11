/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  slug: 'openai-compatible-2',
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
  const persisted = JSON.parse(
    await readFile(join(directory, 'runtime-policy-onboarding.json'), 'utf8'),
  ) as { schemaVersion: number; slug: string };
  assert.deepEqual(persisted, { ...intent });
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.slug, 'openai-compatible-2');
});

test('a journal written before the baseUrl field replays as no override', async () => {
  const directory = await root();
  // The exact persisted shape an older build leaves behind on crash: no
  // `baseUrl` key at all. Recovery must replay it, not reject the document.
  const { slug: _slug, ...legacyBase } = BASE;
  await writeFile(
    join(directory, 'runtime-policy-onboarding.json'),
    JSON.stringify({ schemaVersion: 1, ...legacyBase }),
  );
  const replayed = await readConnectionOnboardingIntent(directory);
  assert.equal(replayed?.schemaVersion, 1);
  assert.equal(replayed?.slug, null);
  assert.equal(replayed?.baseUrl, null);
  assert.deepEqual(replayed?.enabledModelIds, ['relay/model']);
});

test('a caller-chosen display name round-trips through the journal', async () => {
  const directory = await root();
  const intent = prepareConnectionOnboardingIntent({
    ...BASE,
    name: 'Work Relay',
    baseUrl: 'https://relay.example.test/v1',
  });
  assert.equal(intent.name, 'Work Relay');
  await writeConnectionOnboardingIntent(directory, intent);
  assert.deepEqual(await readConnectionOnboardingIntent(directory), intent);
});

test('a journal written before the name field replays with the provider default', async () => {
  const directory = await root();
  // Schema v2 predates `name`: the key is simply absent on crash replay.
  const { slug: _slug, ...legacyBase } = BASE;
  await writeFile(
    join(directory, 'runtime-policy-onboarding.json'),
    JSON.stringify({
      schemaVersion: 2,
      slug: 'openai-compatible-2',
      baseUrl: null,
      ...legacyBase,
    }),
  );
  const replayed = await readConnectionOnboardingIntent(directory);
  assert.equal(replayed?.schemaVersion, 2);
  assert.equal(replayed?.name, null);
});

test('a malformed requested display name fails input decode, never the journal', async () => {
  assert.throws(
    () =>
      prepareConnectionOnboardingIntent({
        ...BASE,
        name: 42,
        baseUrl: null,
      }),
    /connection name/,
  );
});
