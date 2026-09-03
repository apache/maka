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
import { describe, test } from 'node:test';
import type { AgentRunEvent, AgentRunHeader, AgentRunStore } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  buildHistoryCompactCheckpoint,
  canContinueHistoryCompactCheckpointForModel,
  canReplayHistoryCompactCheckpointForModel,
  canReplaceHistoryCompactCheckpoint,
  historyCompactCheckpointToModelMessage,
  historyCompactCheckpointToRuntimeEvent,
  isProviderHistoryCompactCheckpoint,
  matchHistoryCompactCheckpointPrefix,
  validateHistoryCompactCheckpointShape,
} from '../history-compact-checkpoint.js';
import {
  loadHistoryCompactCheckpointsFromRunLedger,
  loadLatestHistoryCompactCheckpointFromRunLedger,
} from '../history-compact-ledger.js';
import { estimateRuntimeEventsTokens } from '../context-budget.js';
import { applyRuntimeEventHistoryCompact } from '../history-compaction.js';

// Satisfies the sectioned summary contract for marked-checkpoint fixtures.
const STRUCTURED_SUMMARY = [
  '## Goal',
  'X',
  '',
  '## Progress',
  '- done',
  '',
  '## Next Steps',
  '1. continue',
  '',
  '## Critical Context',
  '- (none)',
].join('\n');

describe('history compact checkpoint', () => {
  test('rejects provider-native state from a recreated same-slug connection', () => {
    const providerState = {
      kind: 'openai_codex_remote_v2' as const,
      connectionId: 'connection-a',
      modelId: 'gpt-5.3-codex',
      itemId: 'cmp_123',
      encryptedContent: 'encrypted-state',
    };
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      providerState,
    });
    const recreatedConnection = {
      providerType: 'openai-codex',
      slug: 'codex-subscription',
      connectionId: 'connection-b',
    };

    assert.equal(
      canReplayHistoryCompactCheckpointForModel(
        checkpoint,
        recreatedConnection,
        recreatedConnection.connectionId,
        'gpt-5.3-codex',
      ),
      false,
    );
    assert.equal(
      canContinueHistoryCompactCheckpointForModel(
        checkpoint,
        recreatedConnection,
        recreatedConnection.connectionId,
        'gpt-5.3-codex',
      ),
      false,
    );
  });

  test('persists provider-native state as a V3 checkpoint bound to one Codex model', () => {
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      providerState: {
        kind: 'openai_codex_remote_v2',
        connectionId: 'connection-a',
        modelId: 'gpt-5.3-codex',
        itemId: 'cmp_123',
        encryptedContent: 'encrypted-state',
      },
    });

    assert.equal(checkpoint.version, 3);
    assert.equal('summary' in checkpoint, false);
    assert.equal(validateHistoryCompactCheckpointShape(checkpoint, 'session-1'), true);
    assert.equal(isProviderHistoryCompactCheckpoint(checkpoint), true);
    assert.equal(
      canReplayHistoryCompactCheckpointForModel(
        checkpoint,
        { providerType: 'openai-codex' },
        'connection-a',
        'gpt-5.3-codex',
      ),
      true,
    );
    assert.equal(
      canReplayHistoryCompactCheckpointForModel(
        checkpoint,
        { providerType: 'openai-codex' },
        'connection-b',
        'gpt-5.3-codex',
      ),
      false,
    );
    assert.equal(
      canContinueHistoryCompactCheckpointForModel(
        checkpoint,
        { providerType: 'openai-codex' },
        'connection-a',
        'gpt-5.3-codex',
      ),
      true,
    );
    assert.equal(
      canContinueHistoryCompactCheckpointForModel(
        checkpoint,
        { providerType: 'openai' },
        'connection-a',
        'gpt-5.3-codex',
      ),
      false,
    );
    assert.equal(
      canReplayHistoryCompactCheckpointForModel(
        checkpoint,
        { providerType: 'openai' },
        'connection-a',
        'gpt-5.3-codex',
      ),
      false,
    );
    if (!isProviderHistoryCompactCheckpoint(checkpoint)) assert.fail('expected V3 checkpoint');
    assert.deepEqual(historyCompactCheckpointToModelMessage(checkpoint), {
      role: 'assistant',
      content: [
        {
          type: 'custom',
          kind: 'openai.compaction',
          providerOptions: {
            openai: { itemId: 'cmp_123', encryptedContent: 'encrypted-state' },
          },
        },
      ],
    });
  });

  test('rejects malformed provider-native checkpoint state and keeps V2 strict', () => {
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0)],
      providerState: {
        kind: 'openai_codex_remote_v2',
        connectionId: 'connection-a',
        modelId: 'gpt-5.3-codex',
        itemId: 'cmp_123',
        encryptedContent: 'encrypted-state',
      },
    });
    if (!isProviderHistoryCompactCheckpoint(checkpoint)) assert.fail('expected V3 checkpoint');
    assert.equal(
      validateHistoryCompactCheckpointShape({
        ...checkpoint,
        providerState: { ...checkpoint.providerState, encryptedContent: '' },
      }),
      false,
    );
    assert.equal(
      validateHistoryCompactCheckpointShape({ ...checkpoint, summary: 'opaque state leaked here' }),
      false,
    );
    const { connectionId: _connectionId, ...legacyProviderState } = checkpoint.providerState;
    assert.equal(
      validateHistoryCompactCheckpointShape({
        ...checkpoint,
        providerState: { ...legacyProviderState, connectionSlug: 'codex-subscription' },
      }),
      false,
    );
    const v2 = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0)],
      summary: 'text summary',
      summaryFormat: 'legacy_freeform',
    });
    assert.equal(validateHistoryCompactCheckpointShape({ ...v2, providerState: {} }), false);
    assert.equal(
      canContinueHistoryCompactCheckpointForModel(
        v2,
        { providerType: 'openai' },
        'connection-a',
        'gpt-5.3-codex',
      ),
      true,
    );
    assert.equal(
      canContinueHistoryCompactCheckpointForModel(
        v2,
        { providerType: 'openai-codex' },
        'connection-a',
        'gpt-5.3-codex',
      ),
      false,
    );
  });

  test('validates the exact ordered source prefix', () => {
    const events = Array.from({ length: 4 }, (_, index) => textEvent(index));
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events,
      summary: 'Continuation summary.',
      summaryFormat: 'legacy_freeform',
      now: 1_800_000_010_000,
    });

    assert.equal(validateHistoryCompactCheckpointShape(checkpoint, 'session-1'), true);
    const prefixMatch = matchHistoryCompactCheckpointPrefix(checkpoint, [...events, textEvent(4)]);
    assert.equal(prefixMatch.coveredEventCount, 4);
    assert.deepEqual(
      prefixMatch.successorRuntimeEvents.map((event) => event.id),
      ['event-4'],
    );

    const changed = [...events];
    changed[1] = {
      ...changed[1]!,
      content: { kind: 'text', text: 'changed source fact' },
    };
    assert.equal(
      matchHistoryCompactCheckpointPrefix(checkpoint, changed).reason,
      'source_hash_mismatch',
    );
    assert.equal(
      matchHistoryCompactCheckpointPrefix(checkpoint, [events[1]!, events[0]!, ...events.slice(2)])
        .reason,
      'coverage_miss',
    );
  });

  test('rejects blank summaries instead of persisting an unusable checkpoint', () => {
    assert.throws(
      () =>
        buildHistoryCompactCheckpoint({
          sessionId: 'session-1',
          coveredRuntimeEvents: [textEvent(0)],
          summary: '   ',
          summaryFormat: 'legacy_freeform',
        }),
      /non-empty summary/,
    );
  });

  test('preserves the complete model-produced summary instead of truncating it after generation', () => {
    const summary = [
      '## Goal',
      'Keep every section intact.',
      '## Critical Context',
      'LAST_REQUIRED_FACT',
    ]
      .join('\n')
      .repeat(80);

    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0)],
      summary,
      summaryFormat: 'legacy_freeform',
    });

    assert.equal(checkpoint.summary, summary);
    assert.ok(checkpoint.summary.endsWith('LAST_REQUIRED_FACT'));
  });

  test('rejects a source projection assembled from more than one session', () => {
    assert.throws(
      () =>
        buildHistoryCompactCheckpoint({
          sessionId: 'session-1',
          coveredRuntimeEvents: [textEvent(0), { ...textEvent(1), sessionId: 'session-2' }],
          summary: 'mixed source',
          summaryFormat: 'legacy_freeform',
        }),
      /one session/,
    );
  });

  test('rejects inconsistent projection cursors', () => {
    const events = [textEvent(0), textEvent(1)];
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events,
      summary: 'source-bound',
      summaryFormat: 'legacy_freeform',
    });
    const invalid = {
      ...checkpoint,
      source: {
        ...checkpoint.source!,
        coverage: {
          ...checkpoint.source!.coverage,
          highWater: { ...checkpoint.source!.coverage.highWater, sequence: 99 },
        },
      },
    };
    assert.equal(validateHistoryCompactCheckpointShape(invalid, 'session-1'), false);
    assert.equal(matchHistoryCompactCheckpointPrefix(invalid, events).reason, 'invalid_checkpoint');
  });

  test('only accepts an equal-coverage checkpoint as an explicit successor of the same source', () => {
    const source = [textEvent(0), textEvent(1)];
    const current = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'current',
      summaryFormat: 'legacy_freeform',
    });
    const successor = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'smaller replacement',
      summaryFormat: 'legacy_freeform',
      previousCheckpointId: current.checkpointId,
    });
    const stale = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'stale replacement',
      summaryFormat: 'legacy_freeform',
      previousCheckpointId: 'another-checkpoint',
    });
    const differentSource = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(2), textEvent(3)],
      summary: 'different source',
      summaryFormat: 'legacy_freeform',
      previousCheckpointId: current.checkpointId,
    });

    assert.equal(canReplaceHistoryCompactCheckpoint(current, successor), true);
    assert.equal(canReplaceHistoryCompactCheckpoint(current, stale), false);
    assert.equal(canReplaceHistoryCompactCheckpoint(current, differentSource), false);
    const { source: _source, ...legacySuccessor } = successor;
    assert.equal(
      canReplaceHistoryCompactCheckpoint(current, legacySuccessor as typeof successor),
      false,
    );
  });

  test('loads the latest valid checkpoint from the run ledger', async () => {
    const first = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0)],
      summary: 'first',
      summaryFormat: 'legacy_freeform',
      now: 10,
    });
    const latest = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      summary: 'latest',
      summaryFormat: 'legacy_freeform',
      previousCheckpointId: first.checkpointId,
      now: 20,
    });
    const store = new StubAgentRunStore(
      [run('run-1', 10), run('run-2', 20), run('run-3', 30)],
      new Map([
        ['run-1', [checkpointEvent('ledger-1', 'run-1', first, 10)]],
        ['run-2', [checkpointEvent('ledger-2', 'run-2', latest, 20)]],
        [
          'run-3',
          [
            {
              ...checkpointEvent('ledger-3', 'run-3', latest, 30),
              data: { checkpoint: { ...latest, summary: ' ' } },
            },
          ],
        ],
      ]),
    );

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, latest.checkpointId);
    assert.deepEqual(
      (await loadHistoryCompactCheckpointsFromRunLedger(store, 'session-1')).map(
        (checkpoint) => checkpoint.checkpointId,
      ),
      [first.checkpointId, latest.checkpointId],
    );
  });

  test('binds an automatic Memory boundary into checkpoint identity while legacy remains valid', () => {
    const source = [textEvent(0)];
    const legacy = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'same summary',
      summaryFormat: 'legacy_freeform',
    });
    const automatic = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'same summary',
      summaryFormat: 'legacy_freeform',
      memoryExtractionBoundary: {
        runId: 'run-1',
        turnId: 'turn-1',
        runtimeEventId: 'event-boundary',
      },
    });
    const denied = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'same summary',
      summaryFormat: 'legacy_freeform',
      memoryExtractionBoundary: {
        runId: 'run-1',
        turnId: 'turn-1',
        runtimeEventId: 'event-boundary',
        disposition: 'policy_denied',
      },
    });

    assert.notEqual(automatic.checkpointId, legacy.checkpointId);
    assert.notEqual(denied.checkpointId, automatic.checkpointId);
    assert.equal(validateHistoryCompactCheckpointShape(legacy, 'session-1'), true);
    assert.equal(validateHistoryCompactCheckpointShape(automatic, 'session-1'), true);
    assert.equal(
      validateHistoryCompactCheckpointShape(
        {
          ...automatic,
          memoryExtractionBoundary: {
            ...automatic.memoryExtractionBoundary!,
            runtimeEventId: '',
          },
        },
        'session-1',
      ),
      false,
    );
    assert.equal(
      validateHistoryCompactCheckpointShape(
        {
          ...denied,
          memoryExtractionBoundary: {
            ...denied.memoryExtractionBoundary!,
            disposition: 'invalid' as never,
          },
        },
        'session-1',
      ),
      false,
    );
  });

  test('reloads a valid provider-native V3 checkpoint from the run ledger', async () => {
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      providerState: {
        kind: 'openai_codex_remote_v2',
        connectionId: 'connection-a',
        modelId: 'gpt-5.3-codex',
        itemId: 'cmp_durable',
        encryptedContent: 'durable-encrypted-state',
      },
      now: 20,
    });
    const store = new StubAgentRunStore(
      [run('run-1', 20)],
      new Map([['run-1', [checkpointEvent('ledger-v3', 'run-1', checkpoint, 20)]]]),
    );

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.deepEqual(loaded, checkpoint);
    assert.equal(
      matchHistoryCompactCheckpointPrefix(loaded!, [textEvent(0), textEvent(1), textEvent(2)])
        .coveredEventCount,
      2,
    );
  });

  test('rejects a truncated checkpoint at load and recovers the prior valid one', async () => {
    const valid = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      summary: 'legacy summary without sections but complete.',
      summaryFormat: 'legacy_freeform',
      now: 10,
    });
    // A truncated fragment that would otherwise win by coverage: the load gate
    // must drop it and fall back to the previous complete checkpoint (#3041).
    const poisoned = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1), textEvent(2)],
      summary: 'stops mid-thought...',
      summaryFormat: 'legacy_freeform',
      previousCheckpointId: valid.checkpointId,
      now: 20,
    });
    const store = new StubAgentRunStore(
      [run('run-valid', 10), run('run-poisoned', 20)],
      new Map([
        ['run-valid', [checkpointEvent('ledger-valid', 'run-valid', valid, 10)]],
        ['run-poisoned', [checkpointEvent('ledger-poisoned', 'run-poisoned', poisoned, 20)]],
      ]),
    );

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, valid.checkpointId);
  });

  test('uses the shared fence scan to quarantine only an unclosed legacy summary', async () => {
    const valid = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      summary: 'Legacy context:\n\n```ts\nconst ready = true;\n```',
      summaryFormat: 'legacy_freeform',
      now: 10,
    });
    const poisoned = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1), textEvent(2)],
      summary: 'Legacy context:\n\n```ts\nconst ready =',
      summaryFormat: 'legacy_freeform',
      previousCheckpointId: valid.checkpointId,
      now: 20,
    });
    const store = new StubAgentRunStore(
      [run('run-valid', 10), run('run-poisoned', 20)],
      new Map([
        ['run-valid', [checkpointEvent('ledger-valid', 'run-valid', valid, 10)]],
        ['run-poisoned', [checkpointEvent('ledger-poisoned', 'run-poisoned', poisoned, 20)]],
      ]),
    );

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, valid.checkpointId);
  });

  test('stamps new text checkpoints with the sectioned format; legacy_freeform stays unmarked', () => {
    const stamped = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0)],
      summary: STRUCTURED_SUMMARY,
    });
    assert.equal(stamped.version === 2 ? stamped.summaryFormat : undefined, 'sections_v1');
    const legacy = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0)],
      summary: 'legacy free-form summary',
      summaryFormat: 'legacy_freeform',
    });
    assert.equal(legacy.version === 2 ? legacy.summaryFormat : undefined, undefined);
  });

  test('the builder refuses to mint the sectioned marker for unvalidated text', () => {
    // sections_v1 is proof the complete predicate held; a direct caller with
    // free-form text cannot receive it.
    assert.throws(
      () =>
        buildHistoryCompactCheckpoint({
          sessionId: 'session-1',
          coveredRuntimeEvents: [textEvent(0)],
          summary: 'free-form prose without the mandated sections.',
        }),
      /summary failed validation: malformed_summary_missing_section/,
    );
  });

  test('shape validation fails closed on an unknown summary format marker', () => {
    const stamped = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0)],
      summary: STRUCTURED_SUMMARY,
    });
    assert.equal(validateHistoryCompactCheckpointShape(stamped, 'session-1'), true);
    assert.equal(
      validateHistoryCompactCheckpointShape(
        { ...stamped, summaryFormat: 'sections_v99' },
        'session-1',
      ),
      false,
    );
  });

  test('a marked checkpoint is held to the complete predicate at load', async () => {
    // A section-less summary written through a seam that bypassed the write
    // gates (direct recorder, older copy) but carrying the sectioned marker
    // must never become authoritative again after restart; the unmarked
    // legacy policy stays truncation-only.
    const valid = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      summary: STRUCTURED_SUMMARY,
      now: 10,
    });
    // The builder refuses to mint the marker for unvalidated text, so a
    // malformed marked checkpoint can only exist as pre-existing durable data
    // (or via a hand-rolled object) — modeled here by restamping a legacy
    // build.
    const markedMalformed = {
      ...buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [textEvent(0), textEvent(1), textEvent(2)],
        summary: 'complete-sounding free-form prose without the mandated sections.',
        summaryFormat: 'legacy_freeform',
        previousCheckpointId: valid.checkpointId,
        now: 20,
      }),
      summaryFormat: 'sections_v1' as const,
    };
    const store = new StubAgentRunStore(
      [run('run-valid', 10), run('run-marked', 20)],
      new Map([
        ['run-valid', [checkpointEvent('ledger-valid', 'run-valid', valid, 10)]],
        ['run-marked', [checkpointEvent('ledger-marked', 'run-marked', markedMalformed, 20)]],
      ]),
    );

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, valid.checkpointId);
  });

  test('treats a truncated projection as invalid and repairs from the canonical ledger', async () => {
    const valid = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0)],
      summary: 'canonical complete summary',
      summaryFormat: 'legacy_freeform',
    });
    const canonicalEvent = checkpointEvent('canonical-event', 'run-canonical', valid, 20);
    const poisoned = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      summary: 'projection fragment cut off：',
      summaryFormat: 'legacy_freeform',
    });
    const poisonedProjection = checkpointEvent('projection-event', 'run-projection', poisoned, 30);
    const replacedEventIds: Array<string | undefined> = [];
    const store = {
      readEventProjection: async () => poisonedProjection,
      readEventLedgerRevision: async () => 'ledger-revision',
      repairEventProjection: async (
        _sessionId: string,
        _type: AgentRunEvent['type'],
        _event: AgentRunEvent | null,
        options: { ifLedgerRevision: string; replaceEventId?: string },
      ) => {
        assert.equal(options.ifLedgerRevision, 'ledger-revision');
        replacedEventIds.push(options?.replaceEventId);
      },
      listSessionRuns: async () => [run('run-canonical', 10)],
      readEvents: async () => [canonicalEvent],
    };

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, valid.checkpointId);
    assert.deepEqual(replacedEventIds, [poisonedProjection.id]);
  });

  test('loads the furthest checkpoint when a later run records stale coverage', async () => {
    const furthest = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1), textEvent(2)],
      summary: 'furthest coverage',
      summaryFormat: 'legacy_freeform',
    });
    const stale = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      summary: 'stale coverage',
      summaryFormat: 'legacy_freeform',
    });
    const store = new StubAgentRunStore(
      [run('run-furthest', 10), run('run-stale', 20)],
      new Map([
        ['run-furthest', [checkpointEvent('ledger-furthest', 'run-furthest', furthest, 30)]],
        ['run-stale', [checkpointEvent('ledger-stale', 'run-stale', stale, 40)]],
      ]),
    );

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, furthest.checkpointId);
  });

  test('recovers the tip of an out-of-order same-coverage successor chain across runs', async () => {
    const source = [textEvent(0), textEvent(1)];
    const first = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'first',
      summaryFormat: 'legacy_freeform',
      now: 10,
    });
    const second = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'second',
      summaryFormat: 'legacy_freeform',
      previousCheckpointId: first.checkpointId,
      now: 20,
    });
    const tip = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: source,
      summary: 'tip',
      summaryFormat: 'legacy_freeform',
      previousCheckpointId: second.checkpointId,
      now: 30,
    });
    const store = new StubAgentRunStore(
      [run('parent-created-first', 10), run('child-created-later', 20)],
      new Map([
        [
          'parent-created-first',
          [
            checkpointEvent('ledger-second', 'parent-created-first', second, 20),
            checkpointEvent('ledger-tip', 'parent-created-first', tip, 30),
          ],
        ],
        [
          'child-created-later',
          [checkpointEvent('ledger-first', 'child-created-later', first, 10)],
        ],
      ]),
    );
    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, tip.checkpointId);
  });

  test('loads a bounded checkpoint projection without enumerating run ledgers', async () => {
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      summary: 'bounded projection',
      summaryFormat: 'legacy_freeform',
    });
    const projectedEvent = checkpointEvent('projection-event', 'run-projection', checkpoint, 20);
    const store = {
      readEventProjection: async () => projectedEvent,
      listSessionRuns: async () => {
        throw new Error('run enumeration must stay cold');
      },
      readEvents: async () => {
        throw new Error('run ledger reads must stay cold');
      },
    };

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, checkpoint.checkpointId);
  });

  test('uses an empty bounded projection without enumerating run ledgers', async () => {
    const store = {
      readEventProjection: async () => null,
      listSessionRuns: async () => {
        throw new Error('run enumeration must stay cold');
      },
      readEvents: async () => {
        throw new Error('run ledger reads must stay cold');
      },
    };

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded, undefined);
  });

  test('recovers and repairs an uninitialized bounded projection from the canonical ledger', async () => {
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0), textEvent(1)],
      summary: 'recovered checkpoint',
      summaryFormat: 'legacy_freeform',
    });
    const event = checkpointEvent('recovered-event', 'run-recovered', checkpoint, 20);
    const repaired: Array<AgentRunEvent | null> = [];
    const store = {
      readEventProjection: async () => undefined,
      readEventLedgerRevision: async () => 'ledger-revision',
      repairEventProjection: async (
        _sessionId: string,
        _type: AgentRunEvent['type'],
        repairedEvent: AgentRunEvent | null,
        options: { ifLedgerRevision: string },
      ) => {
        assert.equal(options.ifLedgerRevision, 'ledger-revision');
        repaired.push(repairedEvent);
      },
      listSessionRuns: async () => [run('run-recovered', 10)],
      readEvents: async () => [event],
    };

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, checkpoint.checkpointId);
    assert.deepEqual(repaired, [event]);
  });

  test('recovers without repairing when the store lacks a ledger revision capability', async () => {
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0)],
      summary: 'recovered checkpoint',
      summaryFormat: 'legacy_freeform',
    });
    const event = checkpointEvent('recovered-event', 'run-recovered', checkpoint, 20);
    let repaired = false;
    const store = {
      readEventProjection: async () => undefined,
      repairEventProjection: async () => {
        repaired = true;
      },
      listSessionRuns: async () => [run('run-recovered', 10)],
      readEvents: async () => [event],
    };

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, checkpoint.checkpointId);
    assert.equal(repaired, false);
  });

  test('identifies a parseable but invalid projection when repairing from the canonical ledger', async () => {
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [textEvent(0)],
      summary: 'canonical checkpoint',
      summaryFormat: 'legacy_freeform',
    });
    const canonicalEvent = checkpointEvent('canonical-event', 'run-canonical', checkpoint, 20);
    const invalidProjection = {
      ...canonicalEvent,
      id: 'invalid-projection-event',
      data: { checkpoint: { coverage: { eventCount: 999 } } },
    } as AgentRunEvent;
    const replacedEventIds: Array<string | undefined> = [];
    const store = {
      readEventProjection: async () => invalidProjection,
      readEventLedgerRevision: async () => 'ledger-revision',
      repairEventProjection: async (
        _sessionId: string,
        _type: AgentRunEvent['type'],
        _event: AgentRunEvent | null,
        options: { ifLedgerRevision: string; replaceEventId?: string },
      ) => {
        assert.equal(options.ifLedgerRevision, 'ledger-revision');
        replacedEventIds.push(options?.replaceEventId);
      },
      listSessionRuns: async () => [run('run-canonical', 10)],
      readEvents: async () => [canonicalEvent],
    };

    const loaded = await loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1');

    assert.equal(loaded?.checkpointId, checkpoint.checkpointId);
    assert.deepEqual(replacedEventIds, [invalidProjection.id]);
  });

  test('propagates recovery failure from a damaged bounded projection', async () => {
    const store = {
      readEventProjection: async () => {
        throw new Error('damaged projection');
      },
      listSessionRuns: async () => {
        throw new Error('ledger recovery failed');
      },
      readEvents: async () => [],
    };

    await assert.rejects(
      loadLatestHistoryCompactCheckpointFromRunLedger(store, 'session-1'),
      /ledger recovery failed/,
    );
  });

  test('replays a matching checkpoint with only the uncovered raw tail', () => {
    const events = Array.from({ length: 8 }, (_, index) => ({
      ...textEvent(index),
      content: {
        kind: 'text' as const,
        text: `source-payload-${index} `.repeat(index < 4 ? 40 : 1),
      },
    }));
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events.slice(0, 4),
      summary: 'checkpoint summary',
      summaryFormat: 'legacy_freeform',
    });

    const replay = applyRuntimeEventHistoryCompact(events, {
      enabled: true,
      checkpoint,
    });

    assert.equal(replay.events[0]?.id, `history-compact:${checkpoint.checkpointId}`);
    assert.match(
      replay.events[0]?.content?.kind === 'text' ? replay.events[0].content.text : '',
      /checkpoint summary/,
    );
    assert.deepEqual(
      replay.events.slice(1).map((event) => event.id),
      events.slice(4).map((event) => event.id),
    );
    assert.equal(replay.checkpoint?.checkpointId, checkpoint.checkpointId);
  });

  test('replays a durable pre_turn checkpoint without a local size gate', () => {
    const events = Array.from({ length: 6 }, (_, index) => ({
      ...textEvent(index),
      content: {
        kind: 'text' as const,
        text: `small-payload-${index} `.repeat(index < 4 ? 200 : 1),
      },
    }));
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events.slice(0, 4),
      summary: 'recovery checkpoint summary',
      summaryFormat: 'legacy_freeform',
    });

    // The raw history is deliberately small. Once a durable
    // checkpoint exists, replaying it is nevertheless mandatory: otherwise a
    // recovery/manual compaction only affects its own turn and the next turn
    // resurrects the covered raw prefix.
    const replay = applyRuntimeEventHistoryCompact(events, { enabled: true, checkpoint });

    assert.equal(replay.checkpoint?.checkpointId, checkpoint.checkpointId);
    assert.deepEqual(
      replay.events.map((event) => event.id),
      [`history-compact:${checkpoint.checkpointId}`, 'event-4', 'event-5'],
    );
    assert.equal(replay.diagnosticPatch.compactionDecisions?.[0]?.decision, 'replaced');
  });
});

function textEvent(index: number): RuntimeEvent {
  return {
    id: `event-${index}`,
    sessionId: 'session-1',
    runId: `run-${Math.floor(index / 2)}`,
    turnId: `turn-${Math.floor(index / 2)}`,
    invocationId: `invocation-${Math.floor(index / 2)}`,
    ts: 1_800_000_000_000 + index,
    partial: false,
    role: index % 2 === 0 ? 'user' : 'model',
    author: index % 2 === 0 ? 'user' : 'agent',
    content: { kind: 'text', text: `payload-${index}` },
  };
}

function run(runId: string, createdAt: number): AgentRunHeader {
  return {
    runId,
    sessionId: 'session-1',
    turnId: `turn-${runId}`,
    status: 'completed',
    backendKind: 'ai-sdk',
    llmConnectionSlug: 'test',
    modelId: 'test',
    cwd: '/tmp',
    permissionMode: 'ask',
    createdAt,
    updatedAt: createdAt,
  };
}

function checkpointEvent(
  id: string,
  runId: string,
  checkpoint: ReturnType<typeof buildHistoryCompactCheckpoint>,
  ts: number,
): AgentRunEvent {
  return {
    type: 'history_compact_checkpoint_recorded',
    id,
    runId,
    sessionId: 'session-1',
    turnId: `turn-${runId}`,
    ts,
    data: { checkpoint },
  };
}

class StubAgentRunStore implements AgentRunStore {
  constructor(
    private readonly runs: AgentRunHeader[],
    private readonly events: Map<string, AgentRunEvent[]>,
  ) {}

  async listSessionRuns(): Promise<AgentRunHeader[]> {
    return this.runs;
  }

  async readEvents(_sessionId: string, runId: string): Promise<AgentRunEvent[]> {
    return this.events.get(runId) ?? [];
  }

  async createRun(): Promise<AgentRunHeader> {
    throw new Error('not implemented');
  }
  async updateRun(): Promise<AgentRunHeader> {
    throw new Error('not implemented');
  }
  async readRun(): Promise<AgentRunHeader> {
    throw new Error('not implemented');
  }
  async appendEvent(): Promise<void> {
    throw new Error('not implemented');
  }
}
