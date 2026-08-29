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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import { projectProviders, projectRuntimeHostModelChoices } from '../runtime-host-onboarding.js';

function catalog(connections: ConnectionCatalogSnapshot['connections']): ConnectionCatalogSnapshot {
  return { revision: 1, defaultTarget: null, connections };
}

const live = {
  connectionId: 'live-id',
  revision: 1,
  slug: 'openai',
  name: 'OpenAI',
  providerType: 'openai',
  enabled: true,
  enabledModelIds: ['gpt-5-mini'],
  models: [{ id: 'gpt-5-mini', displayName: 'GPT-5 Mini' }],
} as const;

describe('projectRuntimeHostModelChoices', () => {
  test('a retained retired connection contributes no /model choices', () => {
    // Retirement keeps the connection enabled so its credential stays visible
    // and deletable. Filtering on `enabled` alone listed its models here and
    // only refused them after the user picked one.
    const choices = projectRuntimeHostModelChoices(
      catalog([
        live,
        {
          ...live,
          connectionId: 'retired-id',
          slug: 'claude-subscription',
          name: 'Claude Subscription',
          providerType: 'claude-subscription',
          enabledModelIds: ['claude-opus-5'],
          models: [{ id: 'claude-opus-5' }],
        },
      ]),
    );
    assert.deepEqual(
      choices.map(({ connectionSlug, model }) => ({ connectionSlug, model })),
      [{ connectionSlug: 'openai', model: 'gpt-5-mini' }],
    );
  });

  test('a disabled connection is also excluded, so the filter is not over-broad', () => {
    const choices = projectRuntimeHostModelChoices(
      catalog([live, { ...live, connectionId: 'off-id', slug: 'openai-off', enabled: false }]),
    );
    assert.deepEqual(
      choices.map(({ connectionSlug }) => connectionSlug),
      ['openai'],
    );
  });

  test('projects the catalog display name onto each model choice', () => {
    const choices = projectRuntimeHostModelChoices(catalog([live]));

    assert.equal(choices[0]?.displayName, 'GPT-5 Mini');
  });
});

describe('projectProviders', () => {
  const relay = {
    connectionId: 'relay-custom-id',
    revision: 1,
    slug: 'my-relay',
    name: 'My Relay',
    providerType: 'openai-compatible',
    baseUrl: 'https://relay.example.test/v1',
    enabled: true,
    enabledModelIds: ['relay/model'],
    models: [{ id: 'relay/model' }],
  } as const;

  test('a Desktop-created relay and add-account action are both explicit', () => {
    const entries = projectProviders(catalog([relay])).filter(
      ({ providerType }) => providerType === 'openai-compatible',
    );
    const entry = entries.find(({ target }) => target.kind === 'existing');
    assert.deepEqual(entry?.target, { kind: 'existing', connectionId: 'relay-custom-id' });
    assert.equal(entry && 'connectionSlug' in entry ? entry.connectionSlug : undefined, 'my-relay');
    assert.deepEqual(entry?.enabledModelIds, ['relay/model']);
    assert.deepEqual(entries.find(({ target }) => target.kind === 'create')?.target, {
      kind: 'create',
      providerType: 'openai-compatible',
    });
  });

  test('several non-canonical connections remain independently editable', () => {
    const entries = projectProviders(
      catalog([relay, { ...relay, connectionId: 'relay-2-id', slug: 'my-relay-2' }]),
    ).filter(({ providerType }) => providerType === 'openai-compatible');
    assert.deepEqual(
      entries.flatMap(({ target }) => (target.kind === 'existing' ? [target.connectionId] : [])),
      ['relay-custom-id', 'relay-2-id'],
    );
  });

  test('a canonical connection does not hide another account', () => {
    const canonical = { ...relay, connectionId: 'canonical-id', slug: 'openai-compatible' };
    const entries = projectProviders(catalog([relay, canonical])).filter(
      ({ providerType, target }) =>
        providerType === 'openai-compatible' && target.kind === 'existing',
    );
    assert.deepEqual(
      entries.flatMap(({ target }) => (target.kind === 'existing' ? [target.connectionId] : [])),
      ['relay-custom-id', 'canonical-id'],
    );
  });
});
