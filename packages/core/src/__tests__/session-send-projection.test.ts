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

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  projectSessionSendOutcome,
  type SessionSendProjectionInput,
} from '../session-send-projection.js';
import type { LlmConnection } from '../llm-connections.js';

function connection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'openai-live',
    name: 'OpenAI Live',
    providerType: 'openai',
    defaultModel: 'gpt-4.1',
    enabled: true,
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
      llmConnectionSlug: 'openai-live',
      model: 'gpt-4.1',
      connectionLocked: false,
    },
    connections: [connection()],
    defaultSlug: 'openai-live',
    hasSecret: () => true,
    ...overrides,
  };
}

describe('projectSessionSendOutcome — session’s own connection', () => {
  it('ready when the bound connection passes the readiness gate with the session model', () => {
    assert.deepEqual(projectSessionSendOutcome(input()), { kind: 'ready' });
  });

  it('validates the sticky session model, not the provider default', () => {
    const outcome = projectSessionSendOutcome(
      input({
        session: {
          backend: 'ai-sdk',
          llmConnectionSlug: 'openai-live',
          model: 'gpt-4.1-mini',
          connectionLocked: true,
        },
      }),
    );
    // gpt-4.1-mini is not in the connection's enabled list.
    assert.deepEqual(outcome, {
      kind: 'blocked',
      reason: 'model_not_enabled',
      connectionLocked: true,
    });
  });

  // Locked sessions isolate the own-connection reason: no rebind walk
  // can rescue them, so the outcome surfaces the raw failure cause.
  function lockedInput(
    overrides: Partial<SessionSendProjectionInput> = {},
  ): SessionSendProjectionInput {
    const base = input(overrides);
    return { ...base, session: { ...base.session, connectionLocked: true } };
  }

  it('fake backend session → fake_backend', () => {
    const outcome = projectSessionSendOutcome(
      lockedInput({
        session: {
          backend: 'fake',
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          connectionLocked: true,
        },
      }),
    );
    assert.equal(outcome.kind, 'blocked');
    assert.equal(outcome.kind === 'blocked' && outcome.reason, 'fake_backend');
  });

  it('legacy/empty slug → missing_default_connection', () => {
    const outcome = projectSessionSendOutcome(
      lockedInput({
        session: {
          backend: 'ai-sdk',
          llmConnectionSlug: '',
          model: 'gpt-4.1',
          connectionLocked: true,
        },
      }),
    );
    assert.equal(outcome.kind === 'blocked' && outcome.reason, 'missing_default_connection');
  });

  it('deleted connection slug → connection_missing', () => {
    const outcome = projectSessionSendOutcome(
      lockedInput({
        session: {
          backend: 'ai-sdk',
          llmConnectionSlug: 'deleted-slug',
          model: 'gpt-4.1',
          connectionLocked: true,
        },
      }),
    );
    assert.equal(outcome.kind === 'blocked' && outcome.reason, 'connection_missing');
  });

  it('enabled connection without secret → missing_api_key', () => {
    const outcome = projectSessionSendOutcome(lockedInput({ hasSecret: () => false }));
    assert.equal(outcome.kind === 'blocked' && outcome.reason, 'missing_api_key');
  });

  it('disabled connection → connection_disabled', () => {
    const outcome = projectSessionSendOutcome(
      lockedInput({ connections: [connection({ enabled: false })] }),
    );
    assert.equal(outcome.kind === 'blocked' && outcome.reason, 'connection_disabled');
  });
});

describe('projectSessionSendOutcome — locked sessions never rebind', () => {
  it('locked session blocks even when another ready connection exists', () => {
    const outcome = projectSessionSendOutcome(
      input({
        session: {
          backend: 'ai-sdk',
          llmConnectionSlug: 'deleted-slug',
          model: 'gpt-4.1',
          connectionLocked: true,
        },
        // openai-live (the default) is ready — but a locked session
        // cannot move, so the send fails.
      }),
    );
    assert.deepEqual(outcome, {
      kind: 'blocked',
      reason: 'connection_missing',
      connectionLocked: true,
    });
  });

  it('unlocked session with the same facts rebinds instead', () => {
    const outcome = projectSessionSendOutcome(
      input({
        session: {
          backend: 'ai-sdk',
          llmConnectionSlug: 'deleted-slug',
          model: 'gpt-4.1',
          connectionLocked: false,
        },
      }),
    );
    assert.deepEqual(outcome, { kind: 'rebind', connectionSlug: 'openai-live', model: 'gpt-4.1' });
  });
});

describe('projectSessionSendOutcome — silent rebind walk', () => {
  it('rebindable failure walks to the ready default connection', () => {
    const outcome = projectSessionSendOutcome(
      input({
        session: {
          backend: 'ai-sdk',
          llmConnectionSlug: 'deleted-connection',
          model: 'fake-model',
          connectionLocked: false,
        },
      }),
    );
    assert.deepEqual(outcome, { kind: 'rebind', connectionSlug: 'openai-live', model: 'gpt-4.1' });
  });

  it('walks past an unready default to another ready connection', () => {
    const outcome = projectSessionSendOutcome(
      input({
        session: {
          backend: 'ai-sdk',
          llmConnectionSlug: 'deleted-connection',
          model: 'fake-model',
          connectionLocked: false,
        },
        connections: [
          connection({ slug: 'default-broken', enabled: false }),
          connection({
            slug: 'second-ready',
            defaultModel: 'gpt-4.1-mini',
            models: [{ id: 'gpt-4.1-mini' }],
          }),
        ],
        defaultSlug: 'default-broken',
      }),
    );
    assert.deepEqual(outcome, {
      kind: 'rebind',
      connectionSlug: 'second-ready',
      model: 'gpt-4.1-mini',
    });
  });

  it('a retired backend never rebinds, even unlocked with a ready connection available', () => {
    // #3211: activation dispatches off the session header's own `backend`, so
    // pointing this session at a healthy connection would still leave `'fake'`
    // in the header and still be refused. Promising a rebind nothing performs
    // is what pushed the rail and the composer to read `backend` directly.
    const outcome = projectSessionSendOutcome(
      input({
        session: {
          backend: 'fake',
          llmConnectionSlug: 'fake',
          model: 'fake-model',
          connectionLocked: false,
        },
      }),
    );
    assert.deepEqual(outcome, {
      kind: 'blocked',
      reason: 'fake_backend',
      connectionLocked: false,
    });
  });

  it('rebind requires a secret on the candidate connection', () => {
    const outcome = projectSessionSendOutcome(
      input({
        session: {
          backend: 'ai-sdk',
          llmConnectionSlug: 'deleted-connection',
          model: 'fake-model',
          connectionLocked: false,
        },
        hasSecret: () => false,
      }),
    );
    // Default exists and is enabled but has no key → send still fails.
    assert.deepEqual(outcome, {
      kind: 'blocked',
      reason: 'connection_missing',
      connectionLocked: false,
    });
  });

  it('non-rebindable failure blocks even when another ready connection exists', () => {
    const outcome = projectSessionSendOutcome(
      input({
        hasSecret: () => false, // own connection missing key
      }),
    );
    assert.deepEqual(outcome, {
      kind: 'blocked',
      reason: 'missing_api_key',
      connectionLocked: false,
    });
  });

  it('deleted default slug is skipped during the walk', () => {
    const outcome = projectSessionSendOutcome(
      input({
        session: {
          backend: 'ai-sdk',
          llmConnectionSlug: 'deleted-connection',
          model: 'fake-model',
          connectionLocked: false,
        },
        defaultSlug: 'ghost-slug',
      }),
    );
    assert.deepEqual(outcome, { kind: 'rebind', connectionSlug: 'openai-live', model: 'gpt-4.1' });
  });
});

describe('projectSessionSendOutcome — codex normalization', () => {
  it('a codex connection with only unsupported models rebinds onto the fallback list', () => {
    const outcome = projectSessionSendOutcome(
      input({
        session: {
          backend: 'ai-sdk',
          llmConnectionSlug: 'deleted-connection',
          model: 'fake-model',
          connectionLocked: false,
        },
        connections: [
          connection({
            slug: 'codex-sub',
            providerType: 'openai-codex',
            defaultModel: 'gpt-5-codex',
            models: [{ id: 'gpt-5-codex' }],
          }),
        ],
        defaultSlug: 'codex-sub',
      }),
    );
    // Normalization swaps the unservable list for the provider fallback
    // list, whose first entry becomes the rebind model.
    assert.deepEqual(outcome, {
      kind: 'rebind',
      connectionSlug: 'codex-sub',
      model: 'gpt-5.6-sol',
    });
  });
});
