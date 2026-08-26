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

  test('a Desktop-created relay under a custom slug reads as the existing connection', () => {
    // Identity must survive the projection: a sole connection of the provider
    // type is "the" one to edit even off the canonical slug, or saving would
    // duplicate it there (#3467 review).
    const entry = projectProviders(catalog([relay])).find(
      ({ providerType }) => providerType === 'openai-compatible',
    );
    assert.equal(entry?.hasConnection, true);
    assert.equal(entry?.connectionId, 'relay-custom-id');
    assert.deepEqual(entry?.enabledModelIds, ['relay/model']);
  });

  test('several non-canonical connections resolve to none — the wizard offers a fresh setup', () => {
    const entry = projectProviders(
      catalog([relay, { ...relay, connectionId: 'relay-2-id', slug: 'my-relay-2' }]),
    ).find(({ providerType }) => providerType === 'openai-compatible');
    assert.equal(entry?.hasConnection, false);
    assert.equal(entry?.connectionId, undefined);
  });

  test('the canonical-slug connection wins over other connections of the type', () => {
    const canonical = { ...relay, connectionId: 'canonical-id', slug: 'openai-compatible' };
    const entry = projectProviders(catalog([relay, canonical])).find(
      ({ providerType }) => providerType === 'openai-compatible',
    );
    assert.equal(entry?.connectionId, 'canonical-id');
  });
});
