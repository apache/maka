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
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import {
  createProviderWithDiscovery,
  apiKeyOnboardingRoute,
  initialOnboardingModelIds,
  shouldShowManagedOnboardingOutcomeUnknown,
  stableOnboardingModels,
  validateAddProviderDraft,
  type AddProviderDraft,
  type AddProviderField,
} from '../../renderer/settings/provider-add-submission.js';
import { createDesktopConnectionSettingsServices } from '../../renderer/platform/desktop/create-connection-settings-services.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';
import {
  ConnectionSaveUncertaintyObserver,
  type ApiKeyOnboardingBridge,
} from '../../renderer/features/connection-settings/index.js';
import {
  PROVIDER_REGISTRY,
  providerSupportsModelDiscovery,
  type CreateConnectionInput,
  type IdentifiedLlmConnection,
  type ProviderType,
} from '@maka/core/llm-connections';

// A compile-time half of the same promise: the gate's field union has no
// model rule to report, so one cannot be added without this line failing.
type NoModelRule = 'defaultModel' extends AddProviderField ? never : true;
const _fieldGateHasNoModelRule: NoModelRule = true;
void _fieldGateHasNoModelRule;

afterEach(cleanupFakeDom);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

const onboardingSaveInput: Parameters<ApiKeyOnboardingBridge['save']>[0] = {
  target: { kind: 'create', providerType: 'openai' },
  apiKey: 'test-key',
  baseUrl: null,
  enabledModelIds: ['gpt-5'],
};

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

function connection(slug: string): IdentifiedLlmConnection {
  return {
    connectionId: `connection-${slug}`,
    slug,
    name: slug,
    providerType: 'openai-compatible',
    defaultModel: '',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  } as IdentifiedLlmConnection;
}

function bridge(over: {
  create?: (input: CreateConnectionInput) => Promise<IdentifiedLlmConnection>;
  fetchModels?: (connection: { readonly connectionId: string; readonly slug: string }) => Promise<unknown>;
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
  for (const providerType of Object.keys(PROVIDER_REGISTRY) as ProviderType[]) {
    const defaults = PROVIDER_REGISTRY[providerType];
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
  const withoutDiscovery = (Object.keys(PROVIDER_REGISTRY) as ProviderType[]).find(
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

test('routes only fixed-endpoint API-key drafts without request customization to Host onboarding', () => {
  assert.deepEqual(apiKeyOnboardingRoute({
    providerType: 'openai',
    requestHeaderCount: 0,
    hasRequestBodyOverlay: false,
  }), { kind: 'host' });
  assert.deepEqual(apiKeyOnboardingRoute({
    providerType: 'openai',
    requestHeaderCount: 1,
    hasRequestBodyOverlay: false,
  }), { kind: 'legacy', reason: 'request_headers' });
  assert.deepEqual(apiKeyOnboardingRoute({
    providerType: 'openai',
    requestHeaderCount: 0,
    hasRequestBodyOverlay: true,
  }), { kind: 'legacy', reason: 'request_body' });
  assert.deepEqual(apiKeyOnboardingRoute({
    providerType: 'openai-compatible',
    requestHeaderCount: 0,
    hasRequestBodyOverlay: false,
  }), { kind: 'legacy', reason: 'custom_endpoint' });
  assert.deepEqual(apiKeyOnboardingRoute({
    providerType: 'cloudflare-workers-ai',
    requestHeaderCount: 0,
    hasRequestBodyOverlay: false,
  }), { kind: 'legacy', reason: 'cloudflare' });
});

test('uses a stable discovered-model order and prefers the registered recommendation', () => {
  const models = [
    { id: 'z-model', displayName: 'Zulu' },
    { id: 'a-model', displayName: 'Alpha' },
  ];
  assert.deepEqual(stableOnboardingModels(models).map(({ id }) => id), [
    'a-model',
    'z-model',
  ]);
  assert.deepEqual(initialOnboardingModelIds(models, 'z-model'), ['z-model']);
  assert.deepEqual(initialOnboardingModelIds(models, 'missing'), ['a-model']);
  assert.deepEqual(initialOnboardingModelIds([], 'missing'), []);
});

test('only an idle form projects a dispatched save as outcome unknown', () => {
  assert.equal(shouldShowManagedOnboardingOutcomeUnknown(false, false), false);
  assert.equal(shouldShowManagedOnboardingOutcomeUnknown(true, true), false);
  assert.equal(shouldShowManagedOnboardingOutcomeUnknown(true, false), true);
});

test('a late old save cannot clear the uncertainty lease for a newer attempt', async () => {
  const saves = [
    deferred<{ kind: 'not_saved' }>(),
    deferred<{ kind: 'not_saved' }>(),
  ];
  let saveIndex = 0;
  const services = createDesktopConnectionSettingsServices(() => ({
    connections: {
      saveOnboarding: () => saves[saveIndex++]!.promise,
    },
  } as unknown as ReturnType<NonNullable<Parameters<typeof createDesktopConnectionSettingsServices>[0]>>));
  const firstView = services.forHost({
    profileId: 'local',
    hostId: 'same-host',
  }).apiKeyOnboarding;
  const oldSave = firstView.save(onboardingSaveInput);
  firstView.saveUncertainty.restart();

  const replacementView = services.forHost({
    profileId: 'local',
    hostId: 'same-host',
  }).apiKeyOnboarding;
  const newSave = replacementView.save(onboardingSaveInput);
  saves[0]!.resolve({ kind: 'not_saved' });
  await oldSave;
  assert.equal(replacementView.saveUncertainty.getSnapshot(), true);

  saves[1]!.resolve({ kind: 'not_saved' });
  await newSave;
  assert.equal(firstView.saveUncertainty.getSnapshot(), false);
});

test('save uncertainty is isolated between Runtime Host targets', async () => {
  const pending = deferred<{ kind: 'outcome_unknown' }>();
  const services = createDesktopConnectionSettingsServices(() => ({
    connections: { saveOnboarding: () => pending.promise },
  } as unknown as ReturnType<NonNullable<Parameters<typeof createDesktopConnectionSettingsServices>[0]>>));
  const firstHost = services.forHost({ profileId: 'local', hostId: 'host-a' }).apiKeyOnboarding;
  const secondHost = services.forHost({ profileId: 'local', hostId: 'host-b' }).apiKeyOnboarding;

  const save = firstHost.save(onboardingSaveInput);

  assert.equal(firstHost.saveUncertainty.getSnapshot(), true);
  assert.equal(secondHost.saveUncertainty.getSnapshot(), false);
  pending.resolve({ kind: 'outcome_unknown' });
  await save;
});

test('a definitive save settlement reaches a generation-remounted React consumer', async () => {
  const pending = deferred<{ kind: 'not_saved' }>();
  const services = createDesktopConnectionSettingsServices(() => ({
    connections: { saveOnboarding: () => pending.promise },
  } as unknown as ReturnType<NonNullable<Parameters<typeof createDesktopConnectionSettingsServices>[0]>>));
  const onboarding = services.forHost({
    profileId: 'local',
    hostId: 'same-host',
  }).apiKeyOnboarding;
  const { root } = installReactRenderer();
  let showsUnknown = false;

  function Probe(props: {
    uncertainty: ApiKeyOnboardingBridge['saveUncertainty'];
    busy: boolean;
  }) {
    return createElement(
      ConnectionSaveUncertaintyObserver,
      {
        store: props.uncertainty,
        children: (uncertain: boolean) => {
          showsUnknown = shouldShowManagedOnboardingOutcomeUnknown(uncertain, props.busy);
          return null;
        },
      },
    );
  }

  let save!: ReturnType<ApiKeyOnboardingBridge['save']>;
  await act(async () => {
    root.render(createElement(Probe, {
      key: 'generation-a',
      uncertainty: onboarding.saveUncertainty,
      busy: true,
    }));
    save = onboarding.save(onboardingSaveInput);
  });
  assert.equal(onboarding.saveUncertainty.getSnapshot(), true);
  assert.equal(showsUnknown, false, 'the form that owns the pending save keeps showing progress');

  await act(async () => {
    root.render(createElement(Probe, {
      key: 'generation-b',
      uncertainty: onboarding.saveUncertainty,
      busy: false,
    }));
  });
  assert.equal(showsUnknown, true, 'a generation-remounted form fails closed');

  await act(async () => {
    pending.resolve({ kind: 'not_saved' });
    await save;
  });
  assert.equal(onboarding.saveUncertainty.getSnapshot(), false);
  assert.equal(showsUnknown, false, 'definitive settlement actively restores the remounted form');
});

test('onboarding transport forwards the selected Runtime Host target', async () => {
  const calls: unknown[] = [];
  const services = createDesktopConnectionSettingsServices(() => ({
    connections: {
      verifyOnboarding: async (_input: unknown, host: unknown) => {
        calls.push(['verify', host]);
        return { kind: 'rejected', reason: 'provider_unsupported' } as const;
      },
      saveOnboarding: async (_input: unknown, host: unknown) => {
        calls.push(['save', host]);
        return { kind: 'rejected', reason: 'provider_unsupported' } as const;
      },
    },
  } as unknown as ReturnType<NonNullable<Parameters<typeof createDesktopConnectionSettingsServices>[0]>>));
  const host = { profileId: 'remote', hostId: 'host-remote' };
  const onboarding = services.forHost(host).apiKeyOnboarding;

  await onboarding.verify({
    target: { kind: 'create', providerType: 'openai' },
    apiKey: 'test-key',
    baseUrl: null,
  });
  await onboarding.save({
    target: { kind: 'create', providerType: 'openai' },
    apiKey: 'test-key',
    baseUrl: null,
    enabledModelIds: ['gpt-5'],
  });

  assert.deepEqual(calls, [
    ['verify', host],
    ['save', host],
  ]);
});
