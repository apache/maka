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
import { describe, it } from 'node:test';
import type { IdentifiedLlmConnection } from '../llm-connections.js';
import {
  projectSessionSendOutcome,
  type SessionSendProjectionInput,
} from '../session-send-projection.js';

function connection(overrides: Partial<IdentifiedLlmConnection> = {}): IdentifiedLlmConnection {
  return {
    connectionId: 'connection-1',
    slug: 'openai-live',
    name: 'OpenAI Live',
    providerType: 'openai',
    defaultModel: 'gpt-4.1',
    enabled: true,
    enabledModelIds: ['gpt-4.1'],
    models: [{ id: 'gpt-4.1', capabilities: { chat: true, functionCalling: true } }],
    modelSource: 'fetched',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function input(overrides: Partial<SessionSendProjectionInput> = {}): SessionSendProjectionInput {
  return {
    session: {
      backend: 'ai-sdk',
      llmConnectionId: 'connection-1',
      llmConnectionSlug: 'openai-live',
      model: 'gpt-4.1',
      connectionLocked: false,
    },
    connections: [connection()],
    hasSecret: () => true,
    ...overrides,
  };
}

describe('projectSessionSendOutcome — exact Connection identity', () => {
  it('is ready only when id, slug, model, and credentials match', () => {
    assert.deepEqual(projectSessionSendOutcome(input()), { kind: 'ready' });
  });

  it('blocks a legacy Session until the user explicitly selects an account', () => {
    const current = input();
    assert.deepEqual(
      projectSessionSendOutcome({
        ...current,
        session: { ...current.session, llmConnectionId: undefined },
      }),
      { kind: 'blocked', reason: 'legacy_connection_identity', connectionLocked: false },
    );
  });

  it('does not adopt a replacement Connection that reuses a deleted slug', () => {
    const current = input();
    assert.deepEqual(
      projectSessionSendOutcome({
        ...current,
        session: { ...current.session, llmConnectionId: 'deleted-connection' },
      }),
      { kind: 'blocked', reason: 'connection_missing', connectionLocked: false },
    );
  });

  it('blocks an identity mismatch even when the id exists under another slug', () => {
    const current = input();
    assert.deepEqual(
      projectSessionSendOutcome({
        ...current,
        session: { ...current.session, llmConnectionSlug: 'stale-slug' },
      }),
      { kind: 'blocked', reason: 'connection_identity_mismatch', connectionLocked: false },
    );
  });

  it('never silently rebinds an unlocked Session to another ready account', () => {
    const current = input();
    assert.deepEqual(
      projectSessionSendOutcome({
        ...current,
        session: {
          ...current.session,
          llmConnectionId: 'deleted-connection',
          llmConnectionSlug: 'deleted-slug',
        },
        connections: [connection(), connection({ connectionId: 'connection-2', slug: 'backup' })],
      }),
      { kind: 'blocked', reason: 'connection_missing', connectionLocked: false },
    );
  });

  it('preserves the exact connection readiness reason', () => {
    assert.deepEqual(projectSessionSendOutcome(input({ hasSecret: () => false })), {
      kind: 'blocked',
      reason: 'missing_api_key',
      connectionLocked: false,
    });
    assert.deepEqual(
      projectSessionSendOutcome(input({ connections: [connection({ enabled: false })] })),
      { kind: 'blocked', reason: 'connection_disabled', connectionLocked: false },
    );
  });

  it('validates the sticky Session model rather than the provider default', () => {
    const current = input();
    assert.deepEqual(
      projectSessionSendOutcome({
        ...current,
        session: { ...current.session, model: 'gpt-4.1-mini', connectionLocked: true },
      }),
      { kind: 'blocked', reason: 'model_not_enabled', connectionLocked: true },
    );
  });

  it('continues to refuse a retired fake backend', () => {
    const current = input();
    assert.deepEqual(
      projectSessionSendOutcome({
        ...current,
        session: {
          ...current.session,
          backend: 'fake',
          llmConnectionId: undefined,
          llmConnectionSlug: 'fake',
          model: 'fake-model',
        },
      }),
      { kind: 'blocked', reason: 'fake_backend', connectionLocked: false },
    );
  });
});
