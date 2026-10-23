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
import type { CheckinCard } from '@maka/core/session-checkin';
import type { MakaBridge } from '../../preload/bridge-contract.js';
import {
  CHECKIN_ATTEMPT_COOLDOWN_MS,
  checkinCardKey,
  decodeCheckinMemory,
  editCheckinCard,
  EMPTY_CHECKIN_MEMORY,
  recordCheckinResult,
  runCheckinAction,
  settleCheckinCard,
  shouldRunCheckin,
  visibleCheckinCards,
} from '../../renderer/features/conversation/testing.js';
import { createDesktopConversationServices } from '../../renderer/platform/desktop/create-conversation-services.js';

const NOW = 1_800_000_000_000;

function card(overrides: Partial<CheckinCard> = {}): CheckinCard {
  return {
    sessionId: 'session-a',
    sessionRevision: 4,
    sessionName: 'Upload retries',
    title: 'Write the retry tests',
    evidence: { source: 'assistant_message', quote: 'I did not get to the tests yet.' },
    action: 'continue',
    instruction: 'Write tests for the upload retries.',
    ...overrides,
  };
}

test('check-in runs when enabled and outside the cooldown, or when forced', () => {
  const memory = { ...EMPTY_CHECKIN_MEMORY, lastAttemptAt: NOW - 1000 };
  assert.equal(shouldRunCheckin({ now: NOW, enabled: true, running: false, memory }), false);
  assert.equal(shouldRunCheckin({ now: NOW, enabled: true, running: false, memory, force: true }), true);
  assert.equal(
    shouldRunCheckin({
      now: NOW + CHECKIN_ATTEMPT_COOLDOWN_MS,
      enabled: true,
      running: false,
      memory,
    }),
    true,
  );
  assert.equal(shouldRunCheckin({ now: NOW, enabled: false, running: false, memory, force: true }), false);
  assert.equal(shouldRunCheckin({ now: NOW, enabled: true, running: true, memory, force: true }), false);
});

test('an answer replaces the cards, a failure keeps them, and settled cards stay hidden', () => {
  const first = recordCheckinResult(EMPTY_CHECKIN_MEMORY, NOW, {
    kind: 'generated',
    effectId: 'e1',
    cards: [card(), card({ sessionId: 'session-b' })],
    dropped: 1,
  });
  assert.equal(first.lastCheckinAt, NOW);
  assert.equal(first.cards.length, 2);

  assert.equal(recordCheckinResult(first, NOW + 1, { kind: 'failed', effectId: 'e2', errorClass: 'provider' }), first);
  // No default model: nothing ran, so the cooldown does not start.
  assert.deepEqual(
    recordCheckinResult({ ...first, lastAttemptAt: NOW + 1 }, NOW + 1, {
      kind: 'failed',
      effectId: 'e2',
      errorClass: 'configuration',
    }),
    { ...first, lastAttemptAt: 0 },
  );
  assert.deepEqual(recordCheckinResult(first, NOW + 2, { kind: 'empty', effectId: 'e3' }).cards, []);

  const settled = settleCheckinCard(first, card());
  assert.deepEqual(settled.settled, [checkinCardKey(card())]);
  assert.deepEqual(
    visibleCheckinCards(settled).map((entry) => entry.sessionId),
    ['session-b'],
  );
  assert.equal(settleCheckinCard(settled, card()), settled);
  // A newer revision of the same Session is a new card.
  assert.equal(visibleCheckinCards({ ...settled, cards: [card({ sessionRevision: 5 })] }).length, 1);
});

test('stored check-in memory is decoded defensively', () => {
  assert.deepEqual(decodeCheckinMemory(null), EMPTY_CHECKIN_MEMORY);
  assert.deepEqual(decodeCheckinMemory('not memory'), EMPTY_CHECKIN_MEMORY);
  assert.deepEqual(
    decodeCheckinMemory({
      lastAttemptAt: -5,
      lastCheckinAt: 'yesterday',
      cards: [card(), { ...card(), action: 'delete' }, 42],
      settled: ['k', 7],
    }),
    { lastAttemptAt: 0, lastCheckinAt: null, cards: [card()], settled: ['k'] },
  );
});

function actionDeps(overrides: { revision?: number | undefined; resumed?: boolean; sent?: boolean; started?: string } = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      port: {
        readRevision: async () => ('revision' in overrides ? overrides.revision : 4),
        resume: async (id: string) => { calls.push(`resume:${id}`); return overrides.resumed ?? true; },
        send: async (id: string, text: string) => { calls.push(`send:${id}:${text}`); return overrides.sent ?? true; },
        startSession: async (id: string, text: string) => {
          calls.push(`start:${id}:${text}`);
          return overrides.started;
        },
      },
      openSession: (id: string) => { calls.push(`open:${id}`); },
    },
  };
}

test('a card click runs its action', async () => {
  let run = actionDeps();
  assert.equal(await runCheckinAction(card(), run.deps), 'done');
  assert.deepEqual(run.calls, ['send:session-a:Write tests for the upload retries.', 'open:session-a']);

  run = actionDeps();
  assert.equal(await runCheckinAction(card({ action: 'answer', instruction: undefined }), run.deps), 'done');
  assert.deepEqual(run.calls, ['open:session-a']);

  run = actionDeps({ resumed: false });
  assert.equal(await runCheckinAction(card({ action: 'resume' }), run.deps), 'done');
  assert.deepEqual(run.calls, [
    'resume:session-a',
    'send:session-a:Write tests for the upload retries.',
    'open:session-a',
  ]);

  run = actionDeps({ started: 'session-new' });
  assert.equal(await runCheckinAction(card({ action: 'new_session' }), run.deps), 'done');
  assert.deepEqual(run.calls, ['start:session-a:Write tests for the upload retries.', 'open:session-new']);
});

test('changing a card opens its Session with the card in that Session\'s Composer, focused', () => {
  const calls: string[] = [];
  let landed: (() => void) | undefined;
  editCheckinCard(card(), 'Write tests for the upload retries.', {
    openSession: (id) => calls.push(`open:${id}`),
    seedDraft: (key, text) => calls.push(`draft:${key}:${text}`),
    focus: () => calls.push('focus'),
    afterNavigation: (run) => { landed = run; },
  });
  // Nothing is written until navigation lands, when that Composer is the one shown.
  assert.deepEqual(calls, ['open:session-a']);
  landed?.();
  assert.deepEqual(calls, ['open:session-a', 'draft:session-a:Write tests for the upload retries.', 'focus']);
});

test('a card made against an older revision only opens its Session', async () => {
  let run = actionDeps({ revision: 9 });
  assert.equal(await runCheckinAction(card(), run.deps), 'stale');
  assert.deepEqual(run.calls, ['open:session-a']);

  run = actionDeps({ revision: undefined });
  assert.equal(await runCheckinAction(card({ action: 'resume' }), run.deps), 'stale');
  assert.deepEqual(run.calls, []);

  // A new task beside a source that moved on would start superseded work.
  run = actionDeps({ revision: 9, started: 'session-new' });
  assert.equal(await runCheckinAction(card({ action: 'new_session' }), run.deps), 'stale');
  assert.deepEqual(run.calls, ['open:session-a']);

  run = actionDeps({ sent: false });
  assert.equal(await runCheckinAction(card(), run.deps), 'failed');
  assert.deepEqual(run.calls, ['send:session-a:Write tests for the upload retries.', 'open:session-a']);
});

test('the desktop check-in port opens a new task beside its source and quotes it', async () => {
  const calls: unknown[] = [];
  const bridge = {
    sessionLocal: {
      listMessages: async () => [],
      releaseRecoveryAttachments: async () => undefined,
      cancelMessage: async () => undefined,
      reconcileMessage: async () => undefined,
      subscribeChanges: () => () => undefined,
    },
    sessions: {
      get: async (id: string) => ({
        id,
        revision: 4,
        cwd: '/work/app',
        projectId: 'project-1',
        llmConnectionId: 'connection-1',
        llmConnectionSlug: 'openai',
        model: 'gpt-x',
      }),
      create: async (input: unknown, options: unknown) => {
        calls.push(['create', input, options]);
        return { id: 'session-new' };
      },
      readSnapshot: async () => ({
        reference: { sessionId: 'session-a', sessionName: 'Upload retries' },
        text: 'Tail of the source Session',
      }),
      send: async (id: string, command: { text: string; quotes?: unknown[] }) => {
        calls.push(['send', id, command.text, command.quotes?.length ?? 0]);
        return { ok: true };
      },
      generateCheckin: async (input: unknown) => { calls.push(['generate', input]); return { kind: 'empty', effectId: 'e1' }; },
    },
  } as unknown as MakaBridge;
  const port = createDesktopConversationServices(bridge).checkin!;

  assert.equal(await port.startSession('session-a', 'Write the tests.'), 'session-new');
  assert.deepEqual(await port.generate({ effectId: 'e1', since: null }), { kind: 'empty', effectId: 'e1' });
  assert.equal(await port.readRevision('session-a'), 4);
  assert.deepEqual(calls, [
    [
      'create',
      {
        cwd: '/work/app',
        projectId: 'project-1',
        llmConnectionId: 'connection-1',
        llmConnectionSlug: 'openai',
        model: 'gpt-x',
      },
      // Created on the source's Host, not whichever Host is active now.
      { besideSessionId: 'session-a' },
    ],
    ['send', 'session-new', 'Write the tests.', 1],
    ['generate', { effectId: 'e1', since: null }],
  ]);
});
