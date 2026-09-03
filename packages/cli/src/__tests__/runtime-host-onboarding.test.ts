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
import type { RuntimeHostConnectionCatalogSnapshot as ConnectionCatalogSnapshot } from '@maka/runtime-host/client';
import type { RuntimeHostConnection } from '@maka/runtime-host/client';
import { resolveConnectionModelCatalog } from '@maka/core/model-catalog';
import {
  createRuntimeHostOnboardingSurface,
  projectProviders,
  projectRuntimeHostModelChoices,
} from '../runtime-host-onboarding.js';

type StoredConnection = Omit<ConnectionCatalogSnapshot['connections'][number], 'catalogEntries'>;

/**
 * Fixtures describe what the Host stores; the Host resolves the catalog before
 * projecting it, so these tests read the entries the same resolution produces.
 */
function catalog(connections: readonly StoredConnection[]): ConnectionCatalogSnapshot {
  return {
    revision: 1,
    defaultTarget: null,
    connections: connections.map((connection) => ({
      ...connection,
      catalogEntries: resolveConnectionModelCatalog({
        ...connection,
        defaultModel: '',
        enabledModelIds: [...connection.enabledModelIds],
        models: [...connection.models],
      }),
    })),
  };
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

describe('createRuntimeHostOnboardingSurface', () => {
  test('preserves Host failure codes without projecting backend text', async () => {
    const connection = {
      request: async (operation: string) => {
        if (operation === 'connection.onboarding.verify') {
          return { kind: 'rejected', reason: 'connection_not_found' };
        }
        if (operation === 'connection.onboarding.save') {
          return { kind: 'failed', errorClass: 'network' };
        }
        throw new Error(`Unexpected operation ${operation}`);
      },
    } as unknown as RuntimeHostConnection;
    const surface = createRuntimeHostOnboardingSurface(connection);

    assert.deepEqual(
      await surface.verify({
        target: { kind: 'existing', connectionId: 'gone-id' },
        apiKey: 'sk-test',
      }),
      { kind: 'rejected', reason: 'connection_not_found' },
    );
    assert.deepEqual(
      await surface.save({
        target: { kind: 'existing', connectionId: 'live-id' },
        apiKey: 'sk-test',
        enabledModelIds: ['gpt-5-mini'],
      }),
      { kind: 'failed', errorClass: 'network' },
    );
  });

  test('classifies transport exceptions without exposing their message', async () => {
    const connection = {
      request: async () => {
        throw new Error('Host transport leaked this English detail');
      },
    } as unknown as RuntimeHostConnection;

    assert.deepEqual(
      await createRuntimeHostOnboardingSurface(connection).verify({
        target: { kind: 'create', providerType: 'openai' },
        apiKey: 'sk-test',
      }),
      { kind: 'unavailable' },
    );
  });

  test('keeps the committed Connection when the follow-up catalog refresh fails', async () => {
    const committed = {
      connectionId: 'committed-openai-id',
      revision: 3,
      slug: 'openai-2',
      providerType: 'openai',
    } as const;
    const connection = {
      request: async (operation: string) => {
        if (operation === 'connection.onboarding.save') {
          return { kind: 'saved', connection: committed };
        }
        if (operation === 'connection.catalog.query') {
          throw new Error('transient catalog failure');
        }
        throw new Error(`Unexpected operation ${operation}`);
      },
    } as unknown as RuntimeHostConnection;

    const result = await createRuntimeHostOnboardingSurface(connection).save({
      target: { kind: 'create', providerType: 'openai' },
      apiKey: 'sk-test',
      enabledModelIds: ['gpt-5-mini'],
    });

    assert.deepEqual(result, {
      kind: 'ok',
      connection: committed,
      refresh: {
        kind: 'failed',
        reason: 'catalog_unavailable',
      },
    });
  });
});

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

  test('a model that exists only in the resolved catalog still carries its context window', () => {
    // A provider with no model-list endpoint stores no rows, so its models are
    // reachable only through the Host's resolved catalog. The TUI reads its
    // opening context window from these choices for exactly this reason: the
    // stored list it used to read is empty here, and the very first status
    // line would have had no denominator.
    const choices = projectRuntimeHostModelChoices(
      catalog([
        {
          connectionId: 'fallback-id',
          revision: 1,
          slug: 'codex',
          name: 'Codex',
          providerType: 'openai-codex',
          enabled: true,
          enabledModelIds: ['gpt-5.5'],
          models: [],
        },
      ]),
    );

    assert.ok(choices.length > 0, 'a fallback-only connection still offers models');
    for (const choice of choices) {
      assert.equal(
        typeof choice.contextWindow,
        'number',
        `${choice.model} reached the picker without a context window`,
      );
    }
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
    assert.equal(
      entries.find(({ target }) => target.kind === 'create')?.label,
      'Custom relay (OpenAI Chat-compatible)',
    );
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

  test('the create row carries the Host-derived slug suggestion for the identity step', () => {
    const taken = {
      ...relay,
      connectionId: 'openai-id',
      slug: 'openai',
      providerType: 'openai' as const,
    };
    const entries = projectProviders(catalog([taken])).filter(
      ({ providerType }) => providerType === 'openai',
    );
    const create = entries.find(({ target }) => target.kind === 'create');
    assert.equal(
      create && 'suggestedSlug' in create ? create.suggestedSlug : undefined,
      'openai-2',
    );
    // …and with no existing connection the suggestion is the canonical base.
    const bare = projectProviders(catalog([])).find(
      ({ providerType }) => providerType === 'openai',
    );
    assert.equal(bare && 'suggestedSlug' in bare ? bare.suggestedSlug : undefined, 'openai');
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
