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
import type { ProjectedLlmConnection } from '@maka/core/llm-connections';
import { resolveConnectionModelCatalog } from '@maka/core/model-catalog';
import type { SessionSummary } from '@maka/core/session';
import type { OnboardingMilestone } from '@maka/core/onboarding';
import { createOnboardingService } from '../onboarding-service.js';

const storedConnection = {
  connectionId: 'connection-1', slug: 'primary', name: 'Primary',
  providerType: 'custom' as const, defaultApiProtocol: 'openai-chat' as const,
  baseUrl: 'https://relay.example/v1', defaultModel: 'gpt-5',
  enabled: true, createdAt: 1, updatedAt: 1,
};
const connection: ProjectedLlmConnection = {
  ...storedConnection,
  catalogEntries: resolveConnectionModelCatalog(storedConnection),
};

function session(id: string, backend: SessionSummary['backend'] = 'plugin-executor'): SessionSummary {
  return {
    id, name: id, isFlagged: false, isArchived: false, labels: [],
    hasUnread: false, status: 'active', backend,
    llmConnectionId: 'connection-1', llmConnectionSlug: 'primary',
    model: 'gpt-5', connectionLocked: false, permissionMode: 'ask',
  };
}

function harness(initial: SessionSummary[] = []) {
  const sessions = new Map(initial.map((row) => [row.id, row]));
  let milestones: OnboardingMilestone[] = [];
  let listReads = 0;
  let getReads = 0;
  let failGet = false;
  let credentialPresent = true;
  let nextGet: Promise<SessionSummary | null> | null = null;
  let nextList: Promise<SessionSummary[]> | null = null;
  const service = createOnboardingService({
    listConnections: async () => [connection],
    getDefaultSlug: async () => 'primary',
    listSessions: async () => {
      listReads += 1;
      if (nextList) {
        const held = nextList;
        nextList = null;
        return held;
      }
      return [...sessions.values()];
    },
    getSession: async (id) => {
      getReads += 1;
      if (failGet) throw new Error('Host read failed');
      if (nextGet) {
        const held = nextGet;
        nextGet = null;
        return held;
      }
      return sessions.get(id) ?? null;
    },
    getMilestones: async () => milestones,
    upsertMilestone: async (id, status) => {
      milestones = [{ id, ...(status === 'completed' ? { completedAt: 1 } : { skippedAt: 1 }) }];
      return milestones;
    },
    hasCredential: async () => credentialPresent,
  });
  return {
    service, sessions,
    listReads: () => listReads,
    getReads: () => getReads,
    failNextGet: () => { failGet = true; },
    setCredentialPresent: (present: boolean) => { credentialPresent = present; },
    holdNextGet: (held: Promise<SessionSummary | null>) => { nextGet = held; },
    holdNextList: (held: Promise<SessionSummary[]>) => { nextList = held; },
  };
}

test('first and last Session use targeted reads and preserve the settled milestone', async () => {
  const fixture = harness();
  assert.equal((await fixture.service.getSnapshot()).state.kind, 'ready_empty');
  fixture.sessions.set('first', session('first'));
  const created = await fixture.service.getSessionUpdate('first');
  assert.equal(created.kind, 'delta');
  if (created.kind !== 'delta') return;
  assert.equal(created.state.kind, 'ready_with_history');
  assert.deepEqual(created.outcome, { kind: 'ready' });
  assert.equal(created.milestones[0]?.id, 'initial_onboarding');
  fixture.sessions.set('first', { ...session('first'), isArchived: true, status: 'aborted' });
  const archived = await fixture.service.getSessionUpdate('first');
  assert.equal(archived.kind === 'delta' && archived.state.kind, 'ready_with_history');
  fixture.sessions.delete('first');
  const deleted = await fixture.service.getSessionUpdate('first');
  assert.equal(deleted.kind, 'delta');
  if (deleted.kind !== 'delta') return;
  assert.equal(deleted.state.kind, 'ready_empty');
  assert.equal(deleted.outcome, null);
  assert.deepEqual(deleted.milestones, created.milestones);
  assert.equal(fixture.listReads(), 1);
  assert.equal(fixture.getReads(), 3);
});

test('global credential changes rebuild active and rail readiness from Core rules', async () => {
  const fixture = harness([session('native', 'ai-sdk')]);
  const ready = await fixture.service.getSnapshot();
  assert.equal(ready.state.kind, 'ready_with_history');
  assert.deepEqual(ready.sessionSendOutcomes.native, { kind: 'ready' });
  fixture.setCredentialPresent(false);
  const blocked = await fixture.service.getSnapshot();
  assert.equal(blocked.state.kind, 'needs_connection_credentials');
  assert.deepEqual(blocked.sessionSendOutcomes.native, {
    kind: 'blocked', reason: 'missing_api_key', connectionLocked: false,
  });
  assert.equal(fixture.listReads(), 2, 'a global change is allowed a complete read');
});

test('a named change reads one row and never lists the catalog again', async () => {
  const fixture = harness(Array.from({ length: 1_000 }, (_, i) => session(`s-${i}`)));
  await fixture.service.getSnapshot();
  fixture.sessions.set('s-500', session('s-500', 'fake'));
  const update = await fixture.service.getSessionUpdate('s-500');
  assert.equal(update.kind, 'delta');
  if (update.kind !== 'delta') return;
  assert.deepEqual(update.outcome, {
    kind: 'blocked', reason: 'fake_backend', connectionLocked: false,
  });
  assert.equal(fixture.listReads(), 1);
  assert.equal(fixture.getReads(), 1);
  assert.equal(JSON.stringify(update).includes('s-999'), false);
});

test('failed targeted reads leave the accepted baseline intact', async () => {
  const fixture = harness([session('kept')]);
  await fixture.service.getSnapshot();
  fixture.sessions.delete('kept');
  fixture.failNextGet();
  await assert.rejects(fixture.service.getSessionUpdate('kept'), /Host read failed/);
  assert.equal(fixture.listReads(), 1);
});

test('an update before initial coverage requests a resync', async () => {
  const fixture = harness();
  assert.deepEqual(await fixture.service.getSessionUpdate('unknown'), { kind: 'resync' });
  assert.equal(fixture.getReads(), 0);
});

test('a complete read waits for an in-flight targeted read before replacing its basis', async () => {
  const fixture = harness([session('one', 'ai-sdk')]);
  await fixture.service.getSnapshot();
  let release!: (row: SessionSummary | null) => void;
  fixture.holdNextGet(new Promise((resolve) => { release = resolve; }));
  const pending = fixture.service.getSessionUpdate('one');
  await Promise.resolve();
  fixture.setCredentialPresent(false);
  const full = fixture.service.getSnapshot();
  await Promise.resolve();
  assert.equal(fixture.listReads(), 1, 'the complete read must wait for the targeted read');
  release(session('one', 'ai-sdk'));
  assert.equal((await pending).kind, 'delta');
  assert.deepEqual((await full).sessionSendOutcomes.one, {
    kind: 'blocked', reason: 'missing_api_key', connectionLocked: false,
  });
  assert.equal(fixture.listReads(), 2);
});

test('a targeted read arriving during a complete read uses the newly accepted basis', async () => {
  const fixture = harness([session('one', 'ai-sdk')]);
  await fixture.service.getSnapshot();
  let release!: (rows: SessionSummary[]) => void;
  fixture.holdNextList(new Promise((resolve) => { release = resolve; }));
  fixture.setCredentialPresent(false);
  const full = fixture.service.getSnapshot();
  await Promise.resolve();
  const pending = fixture.service.getSessionUpdate('one');
  await Promise.resolve();
  assert.equal(fixture.getReads(), 0, 'the targeted read must wait for the complete read');
  release([session('one', 'ai-sdk')]);
  await full;
  const update = await pending;
  assert.equal(update.kind, 'delta');
  if (update.kind !== 'delta') return;
  assert.deepEqual(update.outcome, {
    kind: 'blocked', reason: 'missing_api_key', connectionLocked: false,
  });
});

test('a milestone write waits for an in-flight targeted read', async () => {
  const fixture = harness();
  await fixture.service.getSnapshot();
  let release!: (row: SessionSummary | null) => void;
  fixture.holdNextGet(new Promise((resolve) => { release = resolve; }));
  const pending = fixture.service.getSessionUpdate('one');
  await Promise.resolve();
  const written = fixture.service.setMilestone('initial_onboarding', 'skipped');
  release(null);
  const update = await pending;
  assert.equal(update.kind, 'delta');
  if (update.kind !== 'delta') return;
  assert.deepEqual(update.milestones, [], 'the earlier read must not borrow the later milestone');
  assert.equal((await written).milestones[0]?.id, 'initial_onboarding');
});
