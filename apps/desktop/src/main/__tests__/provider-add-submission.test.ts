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
import { test } from 'node:test';
import {
  createProviderWithDiscovery,
  validateAddProviderDraft,
  type AddProviderDraft,
  type AddProviderField,
} from '../../renderer/settings/provider-add-submission.js';
import {
  PROVIDER_DEFAULTS,
  providerSupportsModelDiscovery,
  type CreateConnectionInput,
  type LlmConnection,
  type ProviderType,
} from '@maka/core/llm-connections';

// A compile-time half of the same promise: the gate's field union has no
// model rule to report, so one cannot be added without this line failing.
type NoModelRule = 'defaultModel' extends AddProviderField ? never : true;
const _fieldGateHasNoModelRule: NoModelRule = true;
void _fieldGateHasNoModelRule;

const RELAY_TYPES: readonly ProviderType[] = ['openai-compatible', 'openai-responses-compatible'];

function draft(over: Partial<AddProviderDraft> = {}): AddProviderDraft {
  return {
    providerType: 'openai-compatible',
    slug: 'house-relay',
    existingSlugs: [],
    apiKey: 'sk-test',
    cloudflareAccountId: '',
    baseUrl: 'https://relay.example.com/v1',
    ...over,
  };
}

function connection(slug: string): LlmConnection {
  return {
    slug,
    name: slug,
    providerType: 'openai-compatible',
    defaultModel: '',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  } as LlmConnection;
}

function bridge(over: {
  create?: (input: CreateConnectionInput) => Promise<LlmConnection>;
  fetchModels?: (slug: string) => Promise<unknown>;
}) {
  return {
    create: over.create ?? (async (input) => connection(input.slug)),
    fetchModels: over.fetchModels ?? (async () => ({ models: [], source: 'fetched' })),
  };
}

// The first of the two behaviours this module exists to protect. A custom
// relay used to be the only provider class that refused to be created without
// a hand-typed model id — before the app had asked the relay what it serves.
test('a custom relay is created without a hand-typed model id', () => {
  for (const providerType of RELAY_TYPES) {
    assert.equal(validateAddProviderDraft(draft({ providerType })), null, providerType);
  }
});

test('no provider type demands a model id at creation', () => {
  // Stated across the catalog rather than for the two relays alone: the rule
  // that came back would be a per-provider `if`, and asserting only where it
  // used to live would let it reappear next door.
  for (const providerType of Object.keys(PROVIDER_DEFAULTS) as ProviderType[]) {
    const defaults = PROVIDER_DEFAULTS[providerType];
    if (defaults.status === 'phase3-experimental') continue;
    const issue = validateAddProviderDraft(
      draft({
        providerType,
        slug: 'probe-connection',
        apiKey: 'sk-test',
        baseUrl: 'https://example.com/v1',
        cloudflareAccountId: 'account-id',
      }),
    );
    assert.equal(issue, null, `${providerType} refused a draft with no model id`);
  }
});

// The second. Discovery failures were reported for every provider except the
// custom relays, which are the endpoints most likely to be misconfigured.
test('a discovery failure reaches the caller for a custom relay', async () => {
  for (const providerType of RELAY_TYPES) {
    const failure = new Error('relay refused /v1/models');
    const created = await createProviderWithDiscovery(
      bridge({
        fetchModels: async () => {
          throw failure;
        },
      }),
      { slug: 'house-relay', name: 'House', providerType } as CreateConnectionInput,
    );
    assert.equal(created.connection.slug, 'house-relay');
    assert.equal(created.modelDiscoveryError, failure, providerType);
  }
});

test('a discovery failure reaches the caller for a built-in provider too', async () => {
  const failure = new Error('401');
  const created = await createProviderWithDiscovery(
    bridge({
      fetchModels: async () => {
        throw failure;
      },
    }),
    { slug: 'openai-main', name: 'OpenAI', providerType: 'openai' } as CreateConnectionInput,
  );
  assert.equal(created.modelDiscoveryError, failure);
});

test('a failed catalog fetch still yields the created connection', async () => {
  // Discovery is a convenience on top of a successful create, never a
  // condition of it: reporting the failure must not read as "nothing was
  // created", or the user is sent to make a duplicate.
  const created = await createProviderWithDiscovery(
    bridge({
      fetchModels: async () => {
        throw new Error('ECONNREFUSED');
      },
    }),
    { slug: 'house-relay', name: 'House', providerType: 'openai-compatible' } as CreateConnectionInput,
  );
  assert.equal(created.connection.slug, 'house-relay');
});

test('a successful catalog fetch reports no error', async () => {
  const created = await createProviderWithDiscovery(
    bridge({}),
    { slug: 'house-relay', name: 'House', providerType: 'openai-compatible' } as CreateConnectionInput,
  );
  assert.equal(created.modelDiscoveryError, undefined);
});

test('a provider without discovery is not asked, and reports no error', async () => {
  const withoutDiscovery = (Object.keys(PROVIDER_DEFAULTS) as ProviderType[]).find(
    (providerType) => !providerSupportsModelDiscovery(providerType),
  );
  assert.ok(withoutDiscovery, 'expected at least one provider with no discovery endpoint');
  let asked = false;
  const created = await createProviderWithDiscovery(
    bridge({
      fetchModels: async () => {
        asked = true;
        return {};
      },
    }),
    { slug: 'static-catalog', name: 'Static', providerType: withoutDiscovery } as CreateConnectionInput,
  );
  assert.equal(asked, false);
  assert.equal(created.modelDiscoveryError, undefined);
});

test('a create failure propagates instead of being reported as a discovery problem', async () => {
  const failure = new Error('slug already exists');
  await assert.rejects(
    createProviderWithDiscovery(
      bridge({
        create: async () => {
          throw failure;
        },
      }),
      { slug: 'house-relay', name: 'House', providerType: 'openai-compatible' } as CreateConnectionInput,
    ),
    failure,
  );
});

test('the field gate still reports the rules that survived', () => {
  assert.deepEqual(validateAddProviderDraft(draft({ slug: 'Not A Slug' }))?.field, 'slug');
  assert.deepEqual(validateAddProviderDraft(draft({ existingSlugs: ['house-relay'] })), {
    field: 'slug',
    reason: 'duplicate',
  });
  assert.deepEqual(validateAddProviderDraft(draft({ providerType: 'openai', apiKey: '  ' })), {
    field: 'apiKey',
    reason: 'required',
  });
  assert.deepEqual(
    validateAddProviderDraft(
      draft({ providerType: 'cloudflare-workers-ai', cloudflareAccountId: ' ' }),
    ),
    { field: 'accountId', reason: 'required' },
  );
  assert.deepEqual(validateAddProviderDraft(draft({ baseUrl: '   ' })), {
    field: 'baseUrl',
    reason: 'required',
  });
});

test('a duplicate slug outranks a missing key, so one fix is asked for at a time', () => {
  assert.deepEqual(
    validateAddProviderDraft(
      draft({ providerType: 'openai', slug: 'taken', existingSlugs: ['taken'], apiKey: '' }),
    ),
    { field: 'slug', reason: 'duplicate' },
  );
});
