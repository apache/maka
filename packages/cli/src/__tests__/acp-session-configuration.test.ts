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
import test from 'node:test';
import type { SessionConfigOption, SetSessionConfigOptionRequest } from '@agentclientprotocol/sdk';
import type { SessionCatalogProjection } from '@maka/runtime-host/protocol';
import {
  AcpSessionConfigInputError,
  createAcpSessionConfigPatch,
  offerableModelChoices,
  projectAcpSessionConfigOptions,
  validateAcpSessionConfigOptionRequest,
} from '../acp/session-configuration.js';

function selectOption(
  id: string,
  name: string,
  category: string,
  currentValue: string,
  options: readonly [string, string][],
): SessionConfigOption {
  return {
    type: 'select',
    id,
    name,
    category,
    currentValue,
    options: options.map(([value, optionName]) => ({ value, name: optionName })),
  };
}

function sessionProjection(
  overrides: Partial<SessionCatalogProjection> = {},
): SessionCatalogProjection {
  return {
    id: 'session-1',
    revision: 1,
    workspace: { target: { kind: 'host_path', path: '/tmp' }, hostCwd: '/tmp' },
    createdAt: 1,
    activityAt: 2,
    name: 'Session',
    isFlagged: false,
    isArchived: false,
    labels: [],
    labelsTruncated: false,
    hasUnread: false,
    status: 'active',
    backend: 'ai-sdk',
    llmConnectionId: 'connection-1',
    llmConnectionSlug: 'openai-main',
    connectionLocked: true,
    model: 'gpt-5',
    permissionMode: 'ask',
    collaborationMode: 'agent',
    orchestrationMode: 'default',
    ...overrides,
  } as SessionCatalogProjection;
}

test('projects the ordered ACP configuration options', () => {
  assert.deepEqual(projectAcpSessionConfigOptions(sessionProjection(), ['off', 'low', 'high']), [
    selectOption('permission_mode', 'Permission mode', '_maka/permission_mode', 'ask', [
      ['ask', 'Ask'],
      ['bypass', 'Bypass'],
    ]),
    selectOption('model', 'Model', 'model', 'gpt-5', [['gpt-5', 'gpt-5']]),
    selectOption('thinking_level', 'Thinking level', 'thought_level', 'default', [
      ['default', 'Default'],
      ['off', 'Off'],
      ['low', 'Low'],
      ['high', 'High'],
    ]),
    selectOption('collaboration_mode', 'Collaboration mode', 'mode', 'agent', [
      ['agent', 'Agent'],
      ['plan', 'Plan'],
    ]),
    selectOption(
      'orchestration_mode',
      'Orchestration mode',
      '_maka/orchestration_mode',
      'default',
      [
        ['default', 'Default'],
        ['swarm', 'Swarm'],
        ['graph', 'Graph'],
      ],
    ),
  ]);
});

test('projects canonical values and keeps reserved explore as a current value only', () => {
  for (const [configId, values, field] of [
    ['permission_mode', ['explore', 'ask', 'bypass'], 'permissionMode'],
    ['collaboration_mode', ['agent', 'plan'], 'collaborationMode'],
    ['orchestration_mode', ['default', 'swarm', 'graph'], 'orchestrationMode'],
  ] as const) {
    for (const value of values) {
      const overrides: Partial<SessionCatalogProjection> =
        field === 'permissionMode'
          ? { permissionMode: value as SessionCatalogProjection['permissionMode'] }
          : field === 'collaborationMode'
            ? { collaborationMode: value as SessionCatalogProjection['collaborationMode'] }
            : { orchestrationMode: value as SessionCatalogProjection['orchestrationMode'] };
      const option = projectAcpSessionConfigOptions(sessionProjection(overrides), ['low'])[
        configId === 'permission_mode' ? 0 : configId === 'collaboration_mode' ? 3 : 4
      ];
      assert.equal(option.currentValue, value);
    }
  }
  const permission = projectAcpSessionConfigOptions(
    sessionProjection({ permissionMode: 'explore' }),
    ['low'],
  )[0];
  assert.equal(permission.currentValue, 'explore');
  assert.deepEqual(permission.options, [
    { value: 'ask', name: 'Ask' },
    { value: 'bypass', name: 'Bypass' },
  ]);
});

test('projects only the current model thinking levels and omits the switch when empty', () => {
  const levels = ['minimal', 'high', 'max'] as const;
  const option = projectAcpSessionConfigOptions(
    sessionProjection({ thinkingLevel: 'high' }),
    levels,
  )[2];
  assert.deepEqual(
    option,
    selectOption('thinking_level', 'Thinking level', 'thought_level', 'high', [
      ['default', 'Default'],
      ['minimal', 'Minimal'],
      ['high', 'High'],
      ['max', 'Max'],
    ]),
  );
  assert.deepEqual(
    projectAcpSessionConfigOptions(sessionProjection(), []).map(({ id }) => id),
    ['permission_mode', 'model', 'collaboration_mode', 'orchestration_mode'],
  );
});

test('validates requests and creates exact one-field patches', () => {
  const cases = [
    ['permission_mode', 'ask', { permissionMode: 'ask' }],
    ['permission_mode', 'bypass', { permissionMode: 'bypass' }],
    ['thinking_level', 'default', { thinkingLevel: null }],
    ['thinking_level', 'off', { thinkingLevel: 'off' }],
    ['thinking_level', 'minimal', { thinkingLevel: 'minimal' }],
    ['thinking_level', 'low', { thinkingLevel: 'low' }],
    ['thinking_level', 'medium', { thinkingLevel: 'medium' }],
    ['thinking_level', 'high', { thinkingLevel: 'high' }],
    ['thinking_level', 'xhigh', { thinkingLevel: 'xhigh' }],
    ['thinking_level', 'max', { thinkingLevel: 'max' }],
    ['collaboration_mode', 'agent', { collaborationMode: 'agent' }],
    ['collaboration_mode', 'plan', { collaborationMode: 'plan' }],
    ['orchestration_mode', 'default', { orchestrationMode: 'default' }],
    ['orchestration_mode', 'swarm', { orchestrationMode: 'swarm' }],
    ['orchestration_mode', 'graph', { orchestrationMode: 'graph' }],
  ] as const;
  for (const [configId, value, patch] of cases) {
    const request = { sessionId: 'session-1', configId, value } as SetSessionConfigOptionRequest;
    validateAcpSessionConfigOptionRequest(request);
    assert.deepEqual(createAcpSessionConfigPatch(request), patch);
  }
});

test('rejects unsupported config ids, boolean values, and unsupported strings', () => {
  for (const [request, field, reason] of [
    [{ sessionId: 'session-1', configId: 'unknown', value: 'ask' }, 'configId', 'unsupported'],
    [
      { sessionId: 'session-1', configId: 'permission_mode', type: 'boolean', value: true },
      'value',
      'invalid_type',
    ],
    [
      { sessionId: 'session-1', configId: 'permission_mode', value: 'invalid' },
      'value',
      'unsupported',
    ],
    [
      { sessionId: 'session-1', configId: 'permission_mode', value: 'explore' },
      'value',
      'unsupported',
    ],
  ] as const) {
    assert.throws(
      () => validateAcpSessionConfigOptionRequest(request as SetSessionConfigOptionRequest),
      (error: unknown) => {
        assert.ok(error instanceof AcpSessionConfigInputError);
        if (!(error instanceof AcpSessionConfigInputError)) return false;
        assert.equal(error.field, field);
        assert.equal(error.reason, reason);
        return true;
      },
    );
  }
});

test('projects the session connection catalogue as model values', () => {
  const options = projectAcpSessionConfigOptions(
    sessionProjection(),
    [],
    [
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'o3', name: 'o3' },
    ],
  );
  assert.deepEqual(
    options[1],
    selectOption('model', 'Model', 'model', 'gpt-5', [
      ['gpt-5', 'GPT-5'],
      ['o3', 'o3'],
    ]),
  );
});

test('a locked connection still offers its models: the lock binds the connection, not the model', () => {
  const options = projectAcpSessionConfigOptions(
    sessionProjection({ connectionLocked: true }),
    [],
    [
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'o3', name: 'o3' },
    ],
  );
  const modelOption = options[1];
  if (modelOption.type !== 'select') assert.fail('model option must be a select');
  assert.deepEqual(modelOption.options, [
    { value: 'gpt-5', name: 'GPT-5' },
    { value: 'o3', name: 'o3' },
  ]);
});

test('maps a model selection to an explicit model target and clears the thinking level', () => {
  const context = {
    connectionId: 'connection-1',
    connectionSlug: 'openai-main',
    currentModel: 'gpt-5',
    models: [{ id: 'gpt-5' }, { id: 'o3' }],
  } as const;
  assert.deepEqual(
    createAcpSessionConfigPatch(
      { sessionId: 'session-1', configId: 'model', value: 'o3' },
      context,
    ),
    {
      modelTarget: {
        kind: 'explicit',
        connectionId: 'connection-1',
        connectionSlug: 'openai-main',
        model: 'o3',
      },
      // Carrying the old level over makes the Host refuse the new model.
      thinkingLevel: null,
    },
  );
});

test('rejects a model the session cannot offer', () => {
  const context = {
    connectionId: 'connection-1',
    connectionSlug: 'openai-main',
    currentModel: 'gpt-5',
    models: [{ id: 'gpt-5' }],
  } as const;
  assert.throws(
    () =>
      createAcpSessionConfigPatch(
        { sessionId: 'session-1', configId: 'model', value: 'o3' },
        context,
      ),
    AcpSessionConfigInputError,
  );
});

test('re-selecting the current model keeps its thinking level', () => {
  const context = {
    connectionId: 'connection-1',
    connectionSlug: 'openai-main',
    currentModel: 'gpt-5',
    models: [{ id: 'gpt-5' }],
  } as const;
  // A client re-sending `currentValue` must not drop `high` to the default.
  assert.deepEqual(
    createAcpSessionConfigPatch(
      { sessionId: 'session-1', configId: 'model', value: 'gpt-5' },
      context,
    ),
    {
      modelTarget: {
        kind: 'explicit',
        connectionId: 'connection-1',
        connectionSlug: 'openai-main',
        model: 'gpt-5',
      },
    },
  );
});

test('offers and accepts only enabled models, plus the current one', () => {
  assert.deepEqual(
    offerableModelChoices(
      {
        catalogEntries: [
          { id: 'gpt-5', displayName: 'GPT-5' },
          { id: 'o3', displayName: 'o3' },
          { id: 'o4', displayName: 'o4' },
        ],
        enabledModelIds: ['gpt-5', 'o3'],
      },
      'gpt-5',
    ),
    [
      { id: 'gpt-5', name: 'GPT-5' },
      { id: 'o3', name: 'o3' },
    ],
  );
  // A session already running on a model the connection no longer enables keeps
  // that model: hiding it would leave the picker without its own current value.
  assert.deepEqual(
    offerableModelChoices({ catalogEntries: [{ id: 'legacy' }], enabledModelIds: [] }, 'legacy'),
    [{ id: 'legacy', name: 'legacy' }],
  );
});

test('a Session without an LLM connection advertises no model option', () => {
  const options = projectAcpSessionConfigOptions(sessionProjection({ llmConnectionId: null }), []);
  // Validation refuses a model request without a catalogue, so projecting the
  // option would offer a choice that can never be committed.
  assert.deepEqual(
    options.map(({ id }) => id),
    ['permission_mode', 'collaboration_mode', 'orchestration_mode'],
  );
});

test('a model request without a catalogue context is refused, not guessed', () => {
  assert.throws(
    () =>
      createAcpSessionConfigPatch({
        sessionId: 'session-1',
        configId: 'model',
        value: 'gpt-5',
      }),
    AcpSessionConfigInputError,
  );
});
