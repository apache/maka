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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import type {
  IdentifiedLlmConnection,
  ProjectedLlmConnection,
} from '@maka/core/llm-connections';
import {
  resolveConnectionModelCatalog,
  resolveDraftConnectionModelCatalog,
  type ModelCatalogEntry,
} from '@maka/core/model-catalog';
import { buildChatModelChoices } from '@maka/core/chat-model-choice';
import { pickNewChatModel } from '../../renderer/shell-chat-model-selection.js';
import { buildCatalogDailyReviewModelOptions } from '../../renderer/model-catalog-choices.js';

function connection(
  overrides: Partial<IdentifiedLlmConnection> &
    Pick<IdentifiedLlmConnection, 'slug' | 'providerType'>,
): ProjectedLlmConnection {
  const stored: IdentifiedLlmConnection = {
    connectionId: `connection-${overrides.slug}`,
    name: overrides.slug,
    defaultModel: '',
    enabled: true,
    enabledModelIds: overrides.enabledModelIds ?? overrides.models?.map((model) => model.id),
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
  // The Host resolves the catalog and projects it; tests build connections the
  // same way so they exercise what a client actually receives.
  return { ...stored, catalogEntries: resolveConnectionModelCatalog(stored) };
}

describe('model catalog picker helpers', () => {
  it('uses the readiness-checked activation candidate before an unverified first choice', () => {
    assert.deepEqual(
      pickNewChatModel({
        pending: null,
        activationCandidate: {
          llmConnectionSlug: 'ready-second',
          model: 'ready-model',
        },
        catalogDefault: undefined,
        choices: [
          {
            connectionId: 'connection-missing',
            connectionSlug: 'missing-key-first',
            providerType: 'anthropic',
            providerLabel: 'Anthropic',
            model: 'unusable-model',
            label: 'Unusable',
            isDefault: true,
            thinkingLevels: [],
          },
          {
            connectionId: 'connection-ready',
            connectionSlug: 'ready-second',
            providerType: 'opencode-free',
            providerLabel: 'OpenCode Zen',
            model: 'ready-model',
            label: 'Ready',
            isDefault: true,
            thinkingLevels: [],
          },
        ],
      }),
      {
        llmConnectionId: 'connection-ready',
        llmConnectionSlug: 'ready-second',
        model: 'ready-model',
      },
    );
  });
  it('keeps API connection labels while redacting OAuth account identities', () => {
    const choices = buildChatModelChoices([
      connection({
        slug: 'openrouter',
        name: 'Openrouter',
        providerType: 'openai-compatible',
        models: [{ id: 'anthropic/claude-sonnet-5' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'claude-sub',
        name: 'person@example.com',
        providerType: 'claude-subscription',
        models: [{ id: 'claude-sonnet-4-5-20250929' }],
        modelSource: 'fetched',
      }),
      connection({
        slug: 'codex-account',
        name: 'private@example.com',
        providerType: 'openai-codex',
        models: [{ id: 'gpt-5.5' }],
        modelSource: 'fetched',
      }),
    ]);
    const bySlug = new Map(choices.map((choice) => [choice.connectionSlug, choice]));
    assert.equal(bySlug.get('openrouter')?.connectionName, 'Openrouter');
    assert.equal(bySlug.get('claude-sub')?.connectionName, undefined);
    assert.equal(bySlug.get('codex-account')?.connectionName, undefined);
    assert.ok(choices.every((choice) => !(choice.connectionName ?? '').includes('@')));
  });

  it('renders the Host entry, not a local rebuild, while the editor is unedited', () => {
    // A Host that knows this model and a Desktop that does not: the entry says
    // the model cannot serve as a chat default and carries a name this build
    // has never heard. An unedited editor must show what the Host decided —
    // rebuilding locally is exactly the version disagreement the projection
    // ends, and here it would also offer a model the Host ruled out.
    const stored = {
      connectionId: 'connection-relay',
      slug: 'relay',
      name: 'Relay',
      providerType: 'openai-compatible' as const,
      defaultModel: 'host-only-model',
      enabled: true,
      enabledModelIds: ['host-only-model'],
      models: [{ id: 'host-only-model' }],
      modelSource: 'fetched' as const,
      createdAt: 1,
      updatedAt: 1,
    };
    const hostEntry: ModelCatalogEntry = {
      ...resolveConnectionModelCatalog(stored)[0],
      displayName: 'Host-only image model',
      canUseAsChatDefault: false,
    };
    const connection: ProjectedLlmConnection = { ...stored, catalogEntries: [hostEntry] };
    const draft = {
      models: stored.models,
      modelSource: stored.modelSource,
      enabledModelIds: stored.enabledModelIds,
    };

    const unedited = resolveDraftConnectionModelCatalog(connection, draft);
    assert.deepEqual(unedited, [hostEntry]);

    // And the exception still applies: a draft the Host has not seen is the
    // one thing the client resolves for itself.
    const edited = resolveDraftConnectionModelCatalog(connection, {
      ...draft,
      models: [...stored.models, { id: 'just-fetched' }],
    });
    assert.deepEqual(
      edited.map((entry) => entry.id).sort(),
      ['host-only-model', 'just-fetched'],
    );
    assert.notEqual(edited[0]?.displayName, 'Host-only image model');
  });

  it('does not offer Daily Review a Codex model the subscription cannot serve', () => {
    // A connection saved while `gpt-5-codex` was still picker-visible keeps it
    // in `enabledModelIds`. The inventory filter alone left it there, and the
    // catalog listed it back as a model no inventory describes — selectable,
    // and failing at the provider once a scheduled run sent to it.
    const options = buildCatalogDailyReviewModelOptions(
      [
        connection({
          slug: 'codex',
          providerType: 'openai-codex',
          defaultModel: 'gpt-5.5',
          enabledModelIds: ['gpt-5.5', 'gpt-5-codex'],
          models: [{ id: 'gpt-5.5' }],
          modelSource: 'fetched',
        }),
      ],
      '',
    );
    const keys = options.map(([key]) => key);
    assert.ok(
      keys.includes('codex::gpt-5.5'),
      `expected the servable model to be offered, got ${JSON.stringify(keys)}`,
    );
    assert.equal(
      keys.includes('codex::gpt-5-codex'),
      false,
      `unsupported Codex model was offered: ${JSON.stringify(keys)}`,
    );
  });
});
