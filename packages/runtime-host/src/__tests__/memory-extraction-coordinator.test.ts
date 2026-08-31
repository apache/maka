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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import type { SessionHeader } from '@maka/core/session';
import {
  openInteractiveLongTermMemoryStoreForWrite,
  type InteractiveLongTermMemoryWriter,
} from '@maka/storage/long-term-memory-store';
import {
  resolveStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
} from '@maka/storage/root-authority';
import type { RuntimePolicyReader } from '@maka/storage/runtime-policy-stores';
import {
  buildHistoryCompactCheckpoint,
  type HistoryCompactCheckpoint,
} from '@maka/runtime/history-compact-checkpoint';

import { type MemoryExtractionSourceSnapshot } from '@maka/runtime/memory-extraction';

import { HostMemoryExtractionCoordinator } from '../server/memory-extraction-coordinator.js';
import { MemoryExtractionSessionLane } from '../server/memory-extraction-session-lane.js';

const WORKSPACE_IDENTITY = 'workspace:v1:123e4567-e89b-42d3-a456-426614174000' as const;

describe('HostMemoryExtractionCoordinator', () => {
  test('extracts incidental memory through the post-terminal memory_extract path', async () => {
    await withMemoryWriter(async (writer) => {
      const item = proposalItem('The project uses Rust.', 'workspace', 'event-user-1', 'uses Rust');
      const entries = [
        {
          ordinal: 1,
          event: textEvent('event-user-1', 'run-1', 'turn-1', 'The project uses Rust.'),
        },
        {
          ordinal: 2,
          event: modelTextEvent('event-terminal-1', 'run-1', 'turn-1', 'Understood.'),
        },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const extractionCompleted = completionSignal();
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [extractProposal(item), canonicalization(item)],
        observed,
        onResidencyRelease: extractionCompleted.resolve,
      });

      coordinator
        .sourceCapabilities()
        .extract(
          extractSnapshot(
            'run-1',
            'turn-1',
            'event-terminal-1',
            'The project uses Rust.',
            'event-user-1',
          ),
        );

      await extractionCompleted.promise;
      const stored = await writer.searchByKeys({
        terms: ['response preference'],
        match: 'exact',
        workspaceKey: WORKSPACE_IDENTITY,
      });
      assert.deepEqual(
        stored.map(({ item: storedItem }) => storedItem.content),
        ['The project uses Rust.'],
      );
      assert.equal(observed.length, 2);
      assert.equal(observed[0]!.snapshot.trigger, 'extract');
      assert.equal(observed[0]!.snapshot.terminalEventId, 'event-terminal-1');
      await coordinator.close();
    });
  });

  test('rejects requestedItems from memory_extract without advancing its terminal boundary', async () => {
    await withMemoryWriter(async (writer) => {
      const invalid = proposalItem(
        'The project uses Rust.',
        'workspace',
        'event-user-1',
        'uses Rust',
      );
      const entries = [
        {
          ordinal: 1,
          event: textEvent('event-user-1', 'run-1', 'turn-1', 'The project uses Rust.'),
        },
        {
          ordinal: 2,
          event: modelTextEvent('event-terminal-1', 'run-1', 'turn-1', 'Understood.'),
        },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const extractionCompleted = completionSignal();
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: Array.from({ length: 3 }, () =>
          JSON.stringify({
            status: 'complete',
            coverageStatus: 'processed',
            requestedStatus: 'resolved',
            requestedItems: [invalid],
            incidentalItems: [],
          }),
        ),
        observed,
        onResidencyRelease: extractionCompleted.resolve,
      });

      coordinator
        .sourceCapabilities()
        .extract(
          extractSnapshot(
            'run-1',
            'turn-1',
            'event-terminal-1',
            'The project uses Rust.',
            'event-user-1',
          ),
        );

      await extractionCompleted.promise;
      assert.equal(
        (await writer.readPendingExtractionFailure('session-1'))?.firstFailureClass,
        'schema',
      );
      assert.equal(await writer.readExtractionCursor('session-1'), undefined);
      assert.deepEqual(
        await writer.searchByKeys({
          terms: ['response preference'],
          match: 'exact',
          workspaceKey: WORKSPACE_IDENTITY,
        }),
        [],
      );
      assert.equal(observed.length, 3);
      await coordinator.close();
    });
  });

  test('crosses Runs with a Session Cursor, preserves provider configuration, appends changes, and replays exactly', async () => {
    await withMemoryWriter(async (writer) => {
      const entries: Array<{ ordinal: number; event: RuntimeEvent }> = [];
      const outputs = [
        proposal('The user prefers concise Chinese.', 'global', 'event-user-1'),
        canonicalization(
          proposalItem('The user prefers concise Chinese.', 'global', 'event-user-1'),
        ),
        proposal('The user prefers detailed English.', 'workspace', 'event-user-2'),
        canonicalization(
          proposalItem('The user prefers detailed English.', 'workspace', 'event-user-2'),
        ),
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({ writer, entries, outputs, observed });

      entries.push(
        {
          ordinal: 1,
          event: textEvent('event-user-1', 'run-1', 'turn-1', 'Prefer concise Chinese.'),
        },
        { ordinal: 2, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      );
      const firstSnapshot = snapshot(
        'run-1',
        'turn-1',
        'call-1',
        'Prefer concise Chinese.',
        'event-user-1',
      );
      const first = await coordinator.sourceCapabilities().remember(firstSnapshot);
      assert.equal(first.status, 'remembered');
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 1);

      entries.push(
        {
          ordinal: 3,
          event: textEvent('event-user-2', 'run-2', 'turn-2', 'Prefer detailed English.'),
        },
        { ordinal: 4, event: toolCallEvent('event-call-2', 'run-2', 'turn-2', 'call-2') },
      );
      const second = await coordinator
        .sourceCapabilities()
        .remember(snapshot('run-2', 'turn-2', 'call-2', 'Prefer detailed English.'));
      assert.equal(second.status, 'remembered');
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 3);

      const stored = await writer.searchByKeys({
        terms: ['response preference'],
        match: 'exact',
        workspaceKey: WORKSPACE_IDENTITY,
      });
      assert.equal(stored.length, 2);
      assert.deepEqual(
        stored.map(({ item }) => [item.content, item.scopeType, item.scopeKey]),
        [
          ['The user prefers detailed English.', 'workspace', WORKSPACE_IDENTITY],
          ['The user prefers concise Chinese.', 'global', null],
        ],
      );

      const replay = await coordinator.sourceCapabilities().remember(firstSnapshot);
      assert.deepEqual(replay, first);
      assert.equal(observed.length, 4, 'receipt replay must not call the provider');
      assert.deepEqual(Object.keys(observed[0]!.snapshot.sourceTools), ['memory_remember']);
      assert.deepEqual(observed[0]!.snapshot.sourceActiveTools, ['memory_remember']);
      assert.doesNotMatch(observed[0]!.prompt, /Prefer concise Chinese\./);
      assert.match(observed[0]!.prompt, /"messagePositions":\[0\]/);
      await coordinator.close();
    });
  });

  test('rechecks Incognito after the provider call and commits nothing', async () => {
    await withMemoryWriter(async (writer) => {
      const policyState = { incognito: false };
      const entries = [
        { ordinal: 1, event: textEvent('event-user-1', 'run-1', 'turn-1', 'Prefer Rust.') },
        { ordinal: 2, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [proposal('The user prefers Rust.', 'global', 'event-user-1')],
        policyState,
        afterModelCall: () => {
          policyState.incognito = true;
        },
      });

      const result = await coordinator
        .sourceCapabilities()
        .remember(snapshot('run-1', 'turn-1', 'call-1', 'Prefer Rust.'));
      assert.equal(result.status, 'unavailable');
      assert.equal(await writer.readExtractionCursor('session-1'), undefined);
      assert.deepEqual(
        await writer.searchByKeys({ terms: ['response preference'], match: 'exact' }),
        [],
      );
      await coordinator.close();
    });
  });

  test('drops invalid incidental Items while committing valid requested Items and the Cursor', async () => {
    await withMemoryWriter(async (writer) => {
      const entries = [
        { ordinal: 1, event: textEvent('event-user-1', 'run-1', 'turn-1', 'Prefer Rust.') },
        {
          ordinal: 2,
          event: modelTextEvent(
            'event-assistant-1',
            'run-1',
            'turn-1',
            'The volatile Tool result says the account balance is 42.',
          ),
        },
        { ordinal: 3, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      ];
      const valid = proposalItem('The user prefers Rust.', 'global', 'event-user-1');
      const invalid = {
        ...proposalItem('Invalid incidental memory.', 'global', 'missing-event', 'missing'),
        kind: 'note',
      };
      const unconfirmedAssistant = {
        ...proposalItem('The account balance is 42.', 'workspace', 'event-user-1', 'Prefer Rust.'),
        kind: 'knowledge',
      };
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          JSON.stringify({
            status: 'complete',
            coverageStatus: 'processed',
            requestedStatus: 'resolved',
            requestedItems: [valid],
            incidentalItems: [invalid, unconfirmedAssistant],
          }),
          JSON.stringify({
            results: [
              canonicalizationResult('candidate_0', valid),
              { candidateId: 'candidate_1', status: 'rejected' },
            ],
          }),
        ],
        observed,
      });

      const result = await coordinator.sourceCapabilities().remember({
        ...snapshot('run-1', 'turn-1', 'call-1', 'Prefer Rust.', 'event-user-1'),
        sourceMessages: [
          { role: 'user', content: 'Prefer Rust.' },
          { role: 'assistant', content: 'The account balance is 42.' },
        ],
      });

      assert.equal(result.status, 'remembered');
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 2);
      const stored = await writer.searchByKeys({ terms: ['response preference'], match: 'exact' });
      assert.deepEqual(
        stored.map(({ item }) => item.content),
        ['The user prefers Rust.'],
      );
      assert.match(JSON.stringify(observed[0]!.snapshot.sourceMessages), /account balance is 42/);
      assert.doesNotMatch(observed[1]!.prompt, /account balance is 42|The account balance is 42/);
      await coordinator.close();
    });
  });

  test('does not receipt or advance an explicit request when requested admission fails', async () => {
    await withMemoryWriter(async (writer) => {
      const entries = [
        { ordinal: 1, event: textEvent('event-user-1', 'run-1', 'turn-1', 'Prefer Rust.') },
        { ordinal: 2, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      ];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: Array.from({ length: 3 }, () =>
          JSON.stringify({
            status: 'complete',
            coverageStatus: 'processed',
            requestedStatus: 'resolved',
            requestedItems: [
              proposalItem('The user prefers Rust.', 'global', 'missing-event', 'Prefer Rust.'),
            ],
            incidentalItems: [],
          }),
        ),
      });

      const result = await coordinator
        .sourceCapabilities()
        .remember(snapshot('run-1', 'turn-1', 'call-1', 'Prefer Rust.'));

      assert.deepEqual(result, { status: 'unavailable', requestedItems: [] });
      assert.equal(await writer.readExtractionCursor('session-1'), undefined);
      assert.equal(
        (await writer.readPendingExtractionFailure('session-1'))?.firstFailureClass,
        'evidence',
      );
      assert.deepEqual(
        await writer.searchByKeys({ terms: ['response preference'], match: 'exact' }),
        [],
      );
      await coordinator.close();
    });
  });

  test('uses the third model call to retry canonicalization without rerunning Proposal', async () => {
    await withMemoryWriter(async (writer) => {
      const entries = [
        { ordinal: 1, event: textEvent('event-user-1', 'run-1', 'turn-1', 'Prefer Rust.') },
        { ordinal: 2, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          proposal('The user prefers Rust.', 'global', 'event-user-1'),
          '{"results":',
          canonicalization(proposalItem('The user prefers Rust.', 'global', 'event-user-1')),
        ],
        observed,
      });

      const result = await coordinator
        .sourceCapabilities()
        .remember(snapshot('run-1', 'turn-1', 'call-1', 'Prefer Rust.', 'event-user-1'));

      assert.equal(result.status, 'remembered');
      assert.equal(observed.length, 3);
      assert.notEqual(observed[0]!.prompt, observed[1]!.prompt);
      assert.equal(observed[1]!.prompt, observed[2]!.prompt);
      await coordinator.close();
    });
  });

  test('rejects a sensitive requested batch before a Proposal can omit the secret', async () => {
    await withMemoryWriter(async (writer) => {
      const secret = 'sk-live-secret-token-value';
      const entries = [
        {
          ordinal: 1,
          event: textEvent(
            'event-user-1',
            'run-1',
            'turn-1',
            `Prefer Rust and remember ${secret}.`,
          ),
        },
        { ordinal: 2, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [],
        observed,
      });

      const source = snapshot('run-1', 'turn-1', 'call-1', `Prefer Rust and remember ${secret}.`);
      const result = await coordinator.sourceCapabilities().remember(source);

      assert.deepEqual(result, {
        status: 'not_applicable',
        requestedItems: [],
        reason: 'sensitive_information',
      });
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 1);
      assert.deepEqual(
        await writer.searchByKeys({ terms: ['response preference'], match: 'exact' }),
        [],
      );
      assert.deepEqual(await coordinator.sourceCapabilities().remember(source), result);
      assert.equal(observed.length, 0, 'sensitive evidence must be rejected before model dispatch');
      await coordinator.close();
    });
  });

  test('rejects sensitive localized evidence before the localized Proposal can omit it', async () => {
    await withMemoryWriter(async (writer) => {
      const secret = 'sk-live-historical-secret';
      await writer.initializeExtractionCursor('session-1', 1);
      const entries = [
        {
          ordinal: 1,
          event: textEvent(
            'event-old',
            'run-old',
            'turn-old',
            `My API key is ${secret}, and I prefer Rust.`,
          ),
        },
        {
          ordinal: 2,
          event: textEvent(
            'event-current',
            'run-current',
            'turn-current',
            'Remember my earlier API key and Rust preference.',
          ),
        },
        {
          ordinal: 3,
          event: toolCallEvent('event-current-call', 'run-current', 'turn-current', 'current-call'),
        },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          JSON.stringify({
            status: 'search_required',
            coverageStatus: 'processed',
            requestedStatus: 'unresolved',
            requestedItems: [],
            incidentalItems: [],
            search: { terms: ['API key', 'Rust'], roles: ['user'] },
          }),
        ],
        observed,
      });

      const result = await coordinator
        .sourceCapabilities()
        .remember(
          snapshot(
            'run-current',
            'turn-current',
            'current-call',
            'Remember my earlier API key and Rust preference.',
            'event-current',
          ),
        );

      assert.deepEqual(result, {
        status: 'not_applicable',
        requestedItems: [],
        reason: 'sensitive_information',
      });
      assert.equal(observed.length, 1, 'sensitive localized evidence must stop model dispatch');
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 2);
      assert.deepEqual(
        await writer.searchByKeys({ terms: ['response preference'], match: 'exact' }),
        [],
      );
      await coordinator.close();
    });
  });

  test('treats a second memory_remember at an already processed boundary as a no-op', async () => {
    await withMemoryWriter(async (writer) => {
      const entries = [
        { ordinal: 1, event: textEvent('event-user-1', 'run-1', 'turn-1', 'Prefer Rust.') },
        { ordinal: 2, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          proposal('The user prefers Rust.', 'global', 'event-user-1'),
          canonicalization(proposalItem('The user prefers Rust.', 'global', 'event-user-1')),
        ],
        observed,
      });

      await coordinator
        .sourceCapabilities()
        .remember(snapshot('run-1', 'turn-1', 'call-1', 'Prefer Rust.'));
      entries.push({
        ordinal: 3,
        event: toolCallEvent('event-call-2', 'run-1', 'turn-1', 'call-2'),
      });

      assert.deepEqual(
        await coordinator
          .sourceCapabilities()
          .remember(snapshot('run-1', 'turn-1', 'call-2', 'Prefer Rust.')),
        { status: 'not_applicable', requestedItems: [] },
      );
      assert.equal(observed.length, 2);
      await coordinator.close();
    });
  });

  test('processes more than 120 Events as one complete coverage operation', async () => {
    await withMemoryWriter(async (writer) => {
      const entries: Array<{ ordinal: number; event: RuntimeEvent }> = Array.from(
        { length: 120 },
        (_, index) => ({
          ordinal: index + 1,
          event: textEvent(`e${index + 1}`, 'run-old', `turn-old-${index + 1}`, `old${index + 1}`),
        }),
      );
      entries.push(
        {
          ordinal: 121,
          event: textEvent(
            'event-trigger',
            'run-current',
            'turn-current',
            'Remember that I prefer concise Chinese.',
          ),
        },
        {
          ordinal: 122,
          event: toolCallEvent('event-memory-call', 'run-current', 'turn-current', 'memory-call'),
        },
      );
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          JSON.stringify({
            status: 'complete',
            coverageStatus: 'processed',
            requestedStatus: 'resolved',
            requestedItems: [
              proposalItem('The user prefers concise Chinese.', 'global', 'event-trigger'),
            ],
            incidentalItems: [
              {
                ...proposalItem('Historical detail one.', 'global', 'e1', 'old1'),
                kind: 'note',
              },
            ],
          }),
          canonicalization(
            proposalItem('The user prefers concise Chinese.', 'global', 'event-trigger'),
            {
              ...proposalItem('Historical detail one.', 'global', 'e1', 'old1'),
              kind: 'note',
            },
          ),
        ],
        observed,
      });
      const visibleUserEntries = entries.filter(
        ({ event }) => event.role === 'user' && event.content?.kind === 'text',
      );
      const source = {
        ...snapshot(
          'run-current',
          'turn-current',
          'memory-call',
          'Remember that I prefer concise Chinese.',
        ),
        sourceMessages: visibleUserEntries.map(({ event }) => ({
          role: 'user' as const,
          content: event.content?.kind === 'text' ? event.content.text : '',
        })),
        sourceEventMessagePositions: Object.fromEntries(
          visibleUserEntries.map(({ event }, index) => [event.id, [index]]),
        ),
      } satisfies MemoryExtractionSourceSnapshot;
      const result = await coordinator.sourceCapabilities().remember(source);

      assert.equal(result.status, 'remembered');
      assert.equal(observed.length, 2);
      assert.match(observed[0]!.prompt, /event:e1/);
      assert.match(observed[0]!.prompt, /event:event-trigger/);
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 121);
      const stored = await writer.searchByKeys({
        terms: ['response preference'],
        match: 'exact',
      });
      assert.deepEqual(stored.map(({ item }) => item.content).sort(), [
        'Historical detail one.',
        'The user prefers concise Chinese.',
      ]);

      assert.deepEqual(await coordinator.sourceCapabilities().remember(source), result);
      assert.equal(observed.length, 2, 'the trigger receipt must replay exactly');
      await coordinator.close();
    });
  });

  test('bootstraps the first Cursor at the latest valid compaction boundary', async () => {
    await withMemoryWriter(async (writer) => {
      const old = textEvent(
        'event-old',
        'run-old',
        'turn-old',
        'Old detail that was already compacted.',
      );
      const current = textEvent(
        'event-current',
        'run-current',
        'turn-current',
        'Remember that I prefer concise Chinese.',
      );
      const entries = [
        { ordinal: 1, event: old },
        { ordinal: 2, event: toolCallEvent('event-old-call', 'run-old', 'turn-old', 'old-call') },
        { ordinal: 3, event: current },
        {
          ordinal: 4,
          event: toolCallEvent('event-current-call', 'run-current', 'turn-current', 'current-call'),
        },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          proposal('The user prefers concise Chinese.', 'global', 'event-current'),
          canonicalization(
            proposalItem('The user prefers concise Chinese.', 'global', 'event-current'),
          ),
        ],
        observed,
        checkpoint: buildHistoryCompactCheckpoint({
          sessionId: 'session-1',
          coveredRuntimeEvents: [old],
          summary: 'The older context was compacted.',
          summaryFormat: 'legacy_freeform',
          now: 1_500,
        }),
      });

      const result = await coordinator
        .sourceCapabilities()
        .remember(
          snapshot(
            'run-current',
            'turn-current',
            'current-call',
            'Remember that I prefer concise Chinese.',
            'event-current',
          ),
        );

      assert.equal(result.status, 'remembered');
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 3);
      assert.doesNotMatch(observed[0]!.prompt, /Old detail that was already compacted/);
      await coordinator.close();
    });
  });

  test('uses the latest Compaction summary for an explicit post-Cursor slice', async () => {
    await withMemoryWriter(async (writer) => {
      const first = textEvent('summary-first', 'run-1', 'turn-1', 'First raw history.');
      const firstBoundary = modelTextEvent(
        'summary-first-boundary',
        'run-1',
        'turn-1',
        'First response.',
      );
      const second = textEvent('summary-second', 'run-2', 'turn-2', 'Second raw history.');
      const secondBoundary = modelTextEvent(
        'summary-second-boundary',
        'run-2',
        'turn-2',
        'Second response.',
      );
      const current = textEvent('summary-current', 'run-3', 'turn-3', 'Current durable detail.');
      const terminal = modelTextEvent('summary-terminal', 'run-3', 'turn-3', 'Current response.');
      const firstCheckpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [first, firstBoundary],
        summary: 'FIRST SUMMARY MUST BE REPLACED',
        summaryFormat: 'legacy_freeform',
      });
      const secondCheckpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [first, firstBoundary, second, secondBoundary],
        previousCheckpointId: firstCheckpoint.checkpointId,
        summary: 'LATEST SECOND SUMMARY',
        summaryFormat: 'legacy_freeform',
      });
      await writer.initializeExtractionCursor('session-1', 4);
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const completed = completionSignal();
      const coordinator = createCoordinator({
        writer,
        entries: [
          { ordinal: 1, event: first },
          { ordinal: 2, event: firstBoundary },
          { ordinal: 3, event: second },
          { ordinal: 4, event: secondBoundary },
          { ordinal: 5, event: current },
          { ordinal: 6, event: terminal },
        ],
        checkpoints: [firstCheckpoint, secondCheckpoint],
        outputs: [emptyIncidentalProposal()],
        observed,
        onResidencyRelease: completed.resolve,
      });

      coordinator
        .sourceCapabilities()
        .extract(
          extractSnapshot('run-3', 'turn-3', terminal.id, 'Current durable detail.', current.id),
        );
      await completed.promise;

      const context = JSON.stringify(observed[0]!.snapshot.sourceMessages);
      assert.match(context, /LATEST SECOND SUMMARY/);
      assert.match(context, /Current durable detail/);
      assert.doesNotMatch(
        context,
        /FIRST SUMMARY MUST BE REPLACED|First raw history|Second raw history/,
      );
      await coordinator.close();
    });
  });

  test('keeps a mid-turn compaction head anchor eligible for first extraction', async () => {
    await withMemoryWriter(async (writer) => {
      const old = textEvent('event-old', 'run-old', 'turn-old', 'Old compacted detail.');
      const anchor = textEvent(
        'event-anchor',
        'run-current',
        'turn-current',
        'Remember that I prefer concise Chinese.',
      );
      const coordinator = createCoordinator({
        writer,
        entries: [
          { ordinal: 1, event: old },
          { ordinal: 2, event: anchor },
          {
            ordinal: 3,
            event: toolCallEvent(
              'event-current-call',
              'run-current',
              'turn-current',
              'current-call',
            ),
          },
        ],
        outputs: [
          proposal('The user prefers concise Chinese.', 'global', 'event-anchor'),
          canonicalization(
            proposalItem('The user prefers concise Chinese.', 'global', 'event-anchor'),
          ),
        ],
        checkpoint: buildHistoryCompactCheckpoint({
          sessionId: 'session-1',
          coveredRuntimeEvents: [old, anchor],
          summary: 'The older context and current-turn prefix were compacted.',
          summaryFormat: 'legacy_freeform',
          phase: 'mid_turn',
          headAnchor: { runtimeEventId: anchor.id, turnId: anchor.turnId },
          now: 1_500,
        }),
      });

      const result = await coordinator
        .sourceCapabilities()
        .remember(
          snapshot(
            'run-current',
            'turn-current',
            'current-call',
            'Remember that I prefer concise Chinese.',
            'event-anchor',
          ),
        );

      assert.equal(result.status, 'remembered');
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 2);
      await coordinator.close();
    });
  });

  test('does not bootstrap across a compaction checkpoint whose evidence digest is invalid', async () => {
    await withMemoryWriter(async (writer) => {
      const old = textEvent('event-old', 'run-old', 'turn-old', 'Old uncompacted detail.');
      const current = textEvent(
        'event-current',
        'run-current',
        'turn-current',
        'Remember that I prefer concise Chinese.',
      );
      const checkpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [old],
        summary: 'Purported compacted context.',
        summaryFormat: 'legacy_freeform',
        now: 1_500,
      });
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries: [
          { ordinal: 1, event: old },
          { ordinal: 2, event: current },
          {
            ordinal: 3,
            event: toolCallEvent(
              'event-current-call',
              'run-current',
              'turn-current',
              'current-call',
            ),
          },
        ],
        outputs: [
          proposal('The user prefers concise Chinese.', 'global', 'event-current'),
          canonicalization(
            proposalItem('The user prefers concise Chinese.', 'global', 'event-current'),
          ),
        ],
        observed,
        checkpoint: {
          ...checkpoint,
          coverage: { ...checkpoint.coverage, sourceDigest: '0'.repeat(64) },
        },
      });

      const result = await coordinator
        .sourceCapabilities()
        .remember(
          snapshot(
            'run-current',
            'turn-current',
            'current-call',
            'Remember that I prefer concise Chinese.',
            'event-current',
          ),
        );

      assert.equal(result.status, 'remembered');
      assert.match(JSON.stringify(observed[0]!.snapshot.sourceMessages), /Old uncompacted detail/);
      assert.match(observed[0]!.prompt, /event:event-old/);
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 2);
      await coordinator.close();
    });
  });

  test('localizes an explicit reference with one bounded same-Session search call', async () => {
    await withMemoryWriter(async (writer) => {
      const entries = [
        {
          ordinal: 1,
          event: textEvent('event-old', 'run-1', 'turn-1', 'My preferred accent color is violet.'),
        },
        { ordinal: 2, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          proposal('The user prefers violet as an accent color.', 'global', 'event-old'),
          canonicalization(
            proposalItem('The user prefers violet as an accent color.', 'global', 'event-old'),
          ),
          JSON.stringify({
            status: 'search_required',
            coverageStatus: 'processed',
            requestedStatus: 'unresolved',
            requestedItems: [],
            incidentalItems: [],
            search: { terms: ['violet', 'accent color'], roles: ['user'] },
          }),
          JSON.stringify({
            status: 'resolved',
            requestedItems: [
              proposalItem(
                'The user prefers violet as an accent color.',
                'global',
                'event-old',
                'violet',
              ),
            ],
          }),
          canonicalization(
            proposalItem(
              'The user prefers violet as an accent color.',
              'global',
              'event-old',
              'violet',
            ),
          ),
        ],
        observed,
      });

      await coordinator
        .sourceCapabilities()
        .remember(snapshot('run-1', 'turn-1', 'call-1', 'My preferred accent color is violet.'));
      entries.push(
        {
          ordinal: 3,
          event: textEvent(
            'event-current',
            'run-2',
            'turn-2',
            'Remember the color preference I mentioned earlier.',
          ),
        },
        { ordinal: 4, event: toolCallEvent('event-call-2', 'run-2', 'turn-2', 'call-2') },
      );

      const remembered = await coordinator
        .sourceCapabilities()
        .remember(
          snapshot(
            'run-2',
            'turn-2',
            'call-2',
            'Remember the color preference I mentioned earlier.',
          ),
        );

      assert.equal(remembered.status, 'remembered');
      assert.equal(observed.length, 5);
      assert.doesNotMatch(observed[2]!.prompt, /violet/);
      assert.match(observed[3]!.prompt, /violet/);
      assert.match(observed[4]!.prompt, /violet/);
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 3);
      await coordinator.close();
    });
  });

  test('rechecks Incognito before a requested localized model call', async () => {
    await withMemoryWriter(async (writer) => {
      const policyState = { incognito: false };
      const entries = [
        { ordinal: 1, event: textEvent('event-old', 'run-1', 'turn-1', 'Prefer violet.') },
        { ordinal: 2, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          JSON.stringify({
            status: 'search_required',
            coverageStatus: 'processed',
            requestedStatus: 'unresolved',
            requestedItems: [],
            incidentalItems: [],
            search: { terms: ['violet'], roles: ['user'] },
          }),
        ],
        observed,
        policyState,
        afterModelCall: () => {
          policyState.incognito = true;
        },
      });

      const result = await coordinator
        .sourceCapabilities()
        .remember(snapshot('run-1', 'turn-1', 'call-1', 'Remember the earlier preference.'));
      assert.equal(result.status, 'unavailable');
      assert.equal(
        observed.length,
        1,
        'the localized model call must not start after policy closes',
      );
      assert.equal(await writer.readExtractionCursor('session-1'), undefined);
      assert.deepEqual(await writer.searchByKeys({ terms: ['violet'], match: 'exact' }), []);
      await coordinator.close();
    });
  });

  test('uses one bounded localization pass to interpret incidental user evidence', async () => {
    await withMemoryWriter(async (writer) => {
      await writer.initializeExtractionCursor('session-1', 1);
      const accepted = proposalItem(
        'The user approved SQLite for the project database.',
        'workspace',
        'event-current',
        '就按这个方案',
      );
      const entries = [
        {
          ordinal: 1,
          event: modelTextEvent(
            'event-assistant-context',
            'run-old',
            'turn-old',
            'I recommend SQLite for the project database.',
          ),
        },
        {
          ordinal: 2,
          event: textEvent('event-current', 'run-current', 'turn-current', '对，就按这个方案。'),
        },
        {
          ordinal: 3,
          event: modelTextEvent('event-terminal', 'run-current', 'turn-current', 'Understood.'),
        },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const completed = completionSignal();
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          JSON.stringify({
            status: 'search_required',
            coverageStatus: 'processed',
            requestedStatus: 'unresolved',
            requestedItems: [],
            incidentalItems: [],
            search: { terms: ['SQLite'], roles: ['assistant'] },
          }),
          JSON.stringify({
            status: 'complete',
            coverageStatus: 'processed',
            requestedStatus: 'not_applicable',
            requestedItems: [],
            incidentalItems: [accepted],
          }),
          canonicalization(accepted),
        ],
        observed,
        onResidencyRelease: completed.resolve,
      });

      coordinator
        .sourceCapabilities()
        .extract(
          extractSnapshot(
            'run-current',
            'turn-current',
            'event-terminal',
            '对，就按这个方案。',
            'event-current',
          ),
        );
      await completed.promise;

      assert.equal(observed.length, 3);
      assert.doesNotMatch(JSON.stringify(observed[0]!.snapshot.sourceMessages), /SQLite/);
      assert.match(observed[1]!.prompt, /SQLite/);
      assert.match(observed[2]!.prompt, /interpretationContext.*SQLite/s);
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 3);
      assert.deepEqual(
        (
          await writer.searchByKeys({
            terms: ['response preference'],
            match: 'exact',
            workspaceKey: WORKSPACE_IDENTITY,
          })
        ).map(({ item }) => item.content),
        ['The user approved SQLite for the project database.'],
      );
      await coordinator.close();
    });
  });

  test('splits an oversized complete request into at most two Event segments', async () => {
    await withMemoryWriter(async (writer) => {
      const firstText = `First durable preference ${'A'.repeat(3_200)}`;
      const secondText = `Second durable preference ${'B'.repeat(3_200)}`;
      const entries = [
        { ordinal: 1, event: textEvent('split-first', 'run-1', 'turn-1', firstText) },
        { ordinal: 2, event: textEvent('split-second', 'run-2', 'turn-2', secondText) },
        {
          ordinal: 3,
          event: modelTextEvent('split-terminal', 'run-2', 'turn-2', 'Understood.'),
        },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const completed = completionSignal();
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [emptyIncidentalProposal(), emptyIncidentalProposal()],
        observed,
        onResidencyRelease: completed.resolve,
      });
      coordinator.sourceCapabilities().extract({
        ...extractSnapshot('run-2', 'turn-2', 'split-terminal', secondText, 'split-second'),
        sourceContextWindowTokens: 2_000,
        sourceMaxOutputTokens: 256,
      });
      await completed.promise;

      assert.equal(observed.length, 2);
      assert.match(
        JSON.stringify(observed[0]!.snapshot.sourceMessages),
        /First durable preference/,
      );
      assert.doesNotMatch(
        JSON.stringify(observed[0]!.snapshot.sourceMessages),
        /Second durable preference/,
      );
      assert.match(
        JSON.stringify(observed[1]!.snapshot.sourceMessages),
        /Second durable preference/,
      );
      assert.doesNotMatch(
        JSON.stringify(observed[1]!.snapshot.sourceMessages),
        /First durable preference/,
      );
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 3);
      await coordinator.close();
    });
  });

  test('commits the first split segment before leaving only the second segment pending', async () => {
    await withMemoryWriter(async (writer) => {
      const firstText = `First durable preference ${'A'.repeat(3_200)}`;
      const secondText = `Second durable preference ${'B'.repeat(3_200)}`;
      const entries = [
        { ordinal: 1, event: textEvent('split-fail-first', 'run-1', 'turn-1', firstText) },
        { ordinal: 2, event: textEvent('split-fail-second', 'run-2', 'turn-2', secondText) },
        {
          ordinal: 3,
          event: modelTextEvent('split-fail-terminal', 'run-2', 'turn-2', 'Understood.'),
        },
      ];
      const completed = completionSignal();
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          emptyIncidentalProposal(),
          new Error('provider unavailable'),
          new Error('provider unavailable'),
          new Error('provider unavailable'),
        ],
        onResidencyRelease: completed.resolve,
      });
      coordinator.sourceCapabilities().extract({
        ...extractSnapshot(
          'run-2',
          'turn-2',
          'split-fail-terminal',
          secondText,
          'split-fail-second',
        ),
        sourceContextWindowTokens: 2_000,
        sourceMaxOutputTokens: 256,
      });
      await completed.promise;

      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 1);
      const pending = await writer.readPendingExtractionFailure('session-1');
      assert.ok(pending);
      assert.equal(pending.fromOrdinal, 2);
      assert.equal(pending.throughOrdinal, 3);
      assert.equal(pending.firstTrigger, 'extract');
      assert.equal(pending.firstFailureClass, 'provider');
      await coordinator.close();
    });
  });

  test('recovers a failed first Compaction split segment without binding it to the full checkpoint', async () => {
    await withMemoryWriter(async (writer) => {
      const firstUser = textEvent(
        'compaction-split-first',
        'run-1',
        'turn-1',
        `First durable preference ${'A'.repeat(3_200)}`,
      );
      const secondUser = textEvent(
        'compaction-split-second',
        'run-2',
        'turn-2',
        `Second durable preference ${'B'.repeat(3_200)}`,
      );
      const compactionBoundary = modelTextEvent(
        'compaction-split-boundary',
        'run-2',
        'turn-2',
        'Understood.',
      );
      const checkpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [firstUser, secondUser],
        summary: 'The conversation contains two durable preferences.',
        summaryFormat: 'legacy_freeform',
        memoryExtractionBoundary: {
          runId: compactionBoundary.runId,
          turnId: compactionBoundary.turnId,
          runtimeEventId: compactionBoundary.id,
        },
        now: 1_500,
      });
      const laterUser = textEvent(
        'compaction-split-later-user',
        'run-3',
        'turn-3',
        'Later durable preference.',
      );
      const laterTerminal = modelTextEvent(
        'compaction-split-later-terminal',
        'run-3',
        'turn-3',
        'Understood.',
      );
      const entries = [
        { ordinal: 1, event: firstUser },
        { ordinal: 2, event: secondUser },
        { ordinal: 3, event: compactionBoundary },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const firstRelease = completionSignal();
      const secondRelease = completionSignal();
      let releases = 0;
      const coordinator = createCoordinator({
        writer,
        entries,
        checkpoints: [checkpoint],
        outputs: [
          new Error('provider unavailable'),
          new Error('provider unavailable'),
          new Error('provider unavailable'),
          emptyIncidentalProposal(),
          emptyIncidentalProposal(),
          emptyIncidentalProposal(),
        ],
        observed,
        onResidencyRelease: () => {
          releases += 1;
          (releases === 1 ? firstRelease : secondRelease).resolve();
        },
      });

      coordinator.sourceCapabilities().extract({
        ...compactionSnapshot(checkpoint, {
          sourceSystemPrompt: 'Current system',
          sourceText: secondUser.content?.kind === 'text' ? secondUser.content.text : '',
          sourceEventId: secondUser.id,
        }),
        sourceContextWindowTokens: 2_000,
        sourceMaxOutputTokens: 256,
      });
      await firstRelease.promise;

      const pending = await writer.readPendingExtractionFailure('session-1');
      assert.ok(pending);
      assert.equal(pending.fromOrdinal, 1);
      assert.equal(pending.throughOrdinal, 1);
      assert.equal(pending.firstTrigger, 'extract');
      assert.equal(pending.compactionCheckpointId, undefined);
      assert.match(pending.firstOperationId, /^memory_compaction_segment_/);

      entries.push({ ordinal: 4, event: laterUser }, { ordinal: 5, event: laterTerminal });
      coordinator
        .sourceCapabilities()
        .extract(
          extractSnapshot(
            'run-3',
            'turn-3',
            laterTerminal.id,
            'Later durable preference.',
            laterUser.id,
          ),
        );
      await secondRelease.promise;

      assert.equal(await writer.readPendingExtractionFailure('session-1'), undefined);
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 5);
      assert.equal(observed[3]?.snapshot.sourceSystemPrompt, undefined);
      assert.deepEqual(observed[3]?.snapshot.sourceTools, {});
      assert.deepEqual(observed[3]?.snapshot.sourceActiveTools, []);
      await coordinator.close();
    });
  });

  test('keeps memory_remember requested semantics on the final split segment', async () => {
    await withMemoryWriter(async (writer) => {
      const oldText = `Old incidental detail ${'ordinary context '.repeat(500)}`;
      const requestedText = `Remember that my preferred database is SQLite. ${'supporting context '.repeat(500)}`;
      const requested = proposalItem(
        'The user prefers SQLite as the database.',
        'workspace',
        'remember-split-current',
        'preferred database is SQLite',
      );
      const entries = [
        { ordinal: 1, event: textEvent('remember-split-old', 'run-1', 'turn-1', oldText) },
        {
          ordinal: 2,
          event: textEvent('remember-split-current', 'run-2', 'turn-2', requestedText),
        },
        {
          ordinal: 3,
          event: toolCallEvent('remember-split-call', 'run-2', 'turn-2', 'remember-call'),
        },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          emptyIncidentalProposal(),
          proposal(
            requested.content,
            'workspace',
            'remember-split-current',
            'preferred database is SQLite',
          ),
          canonicalization(requested),
        ],
        observed,
      });

      const result = await coordinator.sourceCapabilities().remember({
        ...snapshot('run-2', 'turn-2', 'remember-call', requestedText, 'remember-split-current'),
        sourceContextWindowTokens: 4_500,
        sourceMaxOutputTokens: 256,
      });

      assert.equal(observed.length, 3);
      assert.match(observed[0]!.prompt, /This is incidental extraction/);
      assert.match(observed[1]!.prompt, /The user explicitly requested memory/);
      assert.equal(result.status, 'remembered');
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 2);
      await coordinator.close();
    });
  });

  test('restores the original requested Turn when retrying a pending memory_remember range', async () => {
    await withMemoryWriter(async (writer) => {
      const unrelated = textEvent(
        'remember-retry-unrelated',
        'run-unrelated',
        'turn-unrelated',
        'Unrelated older detail.',
      );
      const requestedUser = textEvent(
        'remember-retry-requested',
        'run-requested',
        'turn-requested',
        'Remember that the project database is SQLite.',
      );
      const requestedCall = toolCallEvent(
        'remember-retry-call',
        'run-requested',
        'turn-requested',
        'remember-retry-tool-call',
      );
      const tailUser = textEvent(
        'remember-retry-tail-user',
        'run-tail',
        'turn-tail',
        'A later unrelated message.',
      );
      const tailBoundary = modelTextEvent(
        'remember-retry-tail-boundary',
        'run-tail',
        'turn-tail',
        'Later response.',
      );
      const requested = proposalItem(
        'The project database is SQLite.',
        'workspace',
        requestedUser.id,
        'project database is SQLite',
      );
      const entries = [
        { ordinal: 1, event: unrelated },
        { ordinal: 2, event: requestedUser },
        { ordinal: 3, event: requestedCall },
        { ordinal: 4, event: tailUser },
        { ordinal: 5, event: tailBoundary },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const completed = completionSignal();
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          ...Array.from({ length: 3 }, () => new Error('provider unavailable')),
          proposal(requested.content, 'workspace', requestedUser.id, 'project database is SQLite'),
          canonicalization(requested),
          emptyIncidentalProposal(),
        ],
        observed,
        onResidencyRelease: completed.resolve,
      });

      const first = await coordinator
        .sourceCapabilities()
        .remember(
          snapshot(
            requestedCall.runId,
            requestedCall.turnId,
            'remember-retry-tool-call',
            requestedUser.content?.kind === 'text' ? requestedUser.content.text : '',
            requestedUser.id,
          ),
        );
      assert.equal(first.status, 'unavailable');

      coordinator
        .sourceCapabilities()
        .extract(
          extractSnapshot(
            tailBoundary.runId,
            tailBoundary.turnId,
            tailBoundary.id,
            tailUser.content?.kind === 'text' ? tailUser.content.text : '',
            tailUser.id,
          ),
        );
      await completed.promise;

      const retry = observed[3];
      assert.ok(retry);
      assert.equal(retry.snapshot.trigger, 'remember');
      assert.equal(retry.snapshot.runId, requestedCall.runId);
      assert.equal(retry.snapshot.turnId, requestedCall.turnId);
      assert.ok(retry.prompt.indexOf(requestedUser.id) < retry.prompt.indexOf(unrelated.id));
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 5);
      assert.equal(await writer.readPendingExtractionFailure('session-1'), undefined);
      await coordinator.close();
    });
  });

  test('retries at most three calls per range, discards on the next trigger, then processes its tail', async () => {
    await withMemoryWriter(async (writer) => {
      const entries = [
        { ordinal: 1, event: textEvent('event-user-1', 'run-1', 'turn-1', 'Remember this.') },
        { ordinal: 2, event: toolCallEvent('event-call-1', 'run-1', 'turn-1', 'call-1') },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries,
        outputs: [
          new Error('provider unavailable'),
          '{"status":"complete"}',
          '{"status":"complete"}',
          '{"status":"complete"}',
          '{"status":"complete"}',
          '{"status":"complete"}',
          proposal('The user prefers detailed English.', 'global', 'event-user-2'),
          canonicalization(
            proposalItem('The user prefers detailed English.', 'global', 'event-user-2'),
          ),
        ],
        observed,
      });
      const first = snapshot('run-1', 'turn-1', 'call-1', 'Remember this.');
      assert.equal((await coordinator.sourceCapabilities().remember(first)).status, 'unavailable');
      assert.equal(observed.length, 3);
      assert.equal(await writer.readExtractionCursor('session-1'), undefined);
      assert.equal(
        (await writer.readPendingExtractionFailure('session-1'))?.firstFailureClass,
        'schema',
      );

      assert.equal((await coordinator.sourceCapabilities().remember(first)).status, 'unavailable');
      assert.equal(observed.length, 3, 'the same trigger must replay without another model call');
      assert.equal(await writer.readExtractionCursor('session-1'), undefined);

      entries.push(
        {
          ordinal: 3,
          event: textEvent('event-user-2', 'run-2', 'turn-2', 'Prefer detailed English.'),
        },
        { ordinal: 4, event: toolCallEvent('event-call-2', 'run-2', 'turn-2', 'call-2') },
      );
      const second = snapshot('run-2', 'turn-2', 'call-2', 'Prefer detailed English.');
      assert.equal((await coordinator.sourceCapabilities().remember(second)).status, 'remembered');
      assert.equal(observed.length, 8);
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 3);
      assert.equal(await writer.readPendingExtractionFailure('session-1'), undefined);
      await coordinator.close();
    });
  });

  test('retries failed Compaction coverage from its checkpoint with the portable envelope', async () => {
    await withMemoryWriter(async (writer) => {
      const oldUser = textEvent(
        'event-old-user',
        'run-old',
        'turn-old',
        'The old conversation prefers concise Chinese.',
      );
      const oldBoundary = modelTextEvent(
        'event-old-boundary',
        'run-old',
        'turn-old',
        'Old response.',
      );
      const firstCheckpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [oldUser],
        summary: 'Old context.',
        summaryFormat: 'legacy_freeform',
        memoryExtractionBoundary: {
          runId: oldBoundary.runId,
          turnId: oldBoundary.turnId,
          runtimeEventId: oldBoundary.id,
        },
        now: 1_500,
      });
      const entries = [
        { ordinal: 1, event: oldUser },
        { ordinal: 2, event: oldBoundary },
      ];
      const checkpoints = [firstCheckpoint];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const firstRelease = completionSignal();
      const secondRelease = completionSignal();
      let releases = 0;
      const coordinator = createCoordinator({
        writer,
        entries,
        checkpoints,
        outputs: [
          new Error('provider unavailable'),
          new Error('provider unavailable'),
          new Error('provider unavailable'),
          emptyIncidentalProposal(),
          emptyIncidentalProposal(),
        ],
        observed,
        onResidencyRelease: () => {
          releases += 1;
          (releases === 1 ? firstRelease : secondRelease).resolve();
        },
      });

      coordinator.sourceCapabilities().extract(
        compactionSnapshot(firstCheckpoint, {
          sourceSystemPrompt: 'old system',
          sourceText: 'The old conversation prefers concise Chinese.',
          sourceEventId: oldUser.id,
        }),
      );
      await firstRelease.promise;
      assert.equal(
        (await writer.readPendingExtractionFailure('session-1'))?.compactionCheckpointId,
        firstCheckpoint.checkpointId,
      );

      const newUser = textEvent(
        'event-new-user',
        'run-new',
        'turn-new',
        'The new conversation prefers detailed English.',
      );
      const newBoundary = modelTextEvent(
        'event-new-boundary',
        'run-new',
        'turn-new',
        'New response.',
      );
      entries.push({ ordinal: 3, event: newUser }, { ordinal: 4, event: newBoundary });
      const secondCheckpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [oldUser, oldBoundary, newUser],
        summary: 'Old and new context.',
        summaryFormat: 'legacy_freeform',
        previousCheckpointId: firstCheckpoint.checkpointId,
        memoryExtractionBoundary: {
          runId: newBoundary.runId,
          turnId: newBoundary.turnId,
          runtimeEventId: newBoundary.id,
        },
        now: 2_500,
      });
      checkpoints.push(secondCheckpoint);
      coordinator.sourceCapabilities().extract(
        compactionSnapshot(secondCheckpoint, {
          sourceSystemPrompt: 'current system',
          sourceText: 'The new conversation prefers detailed English.',
          sourceEventId: newUser.id,
        }),
      );
      await secondRelease.promise;

      assert.equal(observed.length, 5);
      assert.equal(observed[3]!.snapshot.compactionCheckpointId, firstCheckpoint.checkpointId);
      assert.equal(observed[3]!.snapshot.sourceSystemPrompt, undefined);
      assert.deepEqual(observed[3]!.snapshot.sourceTools, {});
      assert.deepEqual(observed[3]!.snapshot.sourceActiveTools, []);
      assert.equal(observed[3]!.snapshot.sourceProviderOptions, undefined);
      assert.match(JSON.stringify(observed[3]!.snapshot.sourceMessages), /old conversation/);
      assert.doesNotMatch(JSON.stringify(observed[3]!.snapshot.sourceMessages), /new conversation/);
      assert.equal(observed[4]!.snapshot.compactionCheckpointId, secondCheckpoint.checkpointId);
      assert.match(JSON.stringify(observed[4]!.snapshot.sourceMessages), /new conversation/);
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 4);
      assert.equal(await writer.readPendingExtractionFailure('session-1'), undefined);
      await coordinator.close();
    });
  });

  test('recovers an unstarted Compaction checkpoint before processing the new trigger tail', async () => {
    await withMemoryWriter(async (writer) => {
      const oldUser = textEvent('crash-old-user', 'run-old', 'turn-old', 'Old durable context.');
      const oldBoundary = modelTextEvent(
        'crash-old-boundary',
        'run-old',
        'turn-old',
        'Old response.',
      );
      const newUser = textEvent('crash-new-user', 'run-new', 'turn-new', 'New durable context.');
      const newBoundary = modelTextEvent(
        'crash-new-boundary',
        'run-new',
        'turn-new',
        'New response.',
      );
      const firstCheckpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [oldUser],
        summary: 'Old context.',
        summaryFormat: 'legacy_freeform',
        memoryExtractionBoundary: {
          runId: oldBoundary.runId,
          turnId: oldBoundary.turnId,
          runtimeEventId: oldBoundary.id,
        },
      });
      const secondCheckpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [oldUser, oldBoundary, newUser],
        summary: 'Old and new context.',
        summaryFormat: 'legacy_freeform',
        previousCheckpointId: firstCheckpoint.checkpointId,
        memoryExtractionBoundary: {
          runId: newBoundary.runId,
          turnId: newBoundary.turnId,
          runtimeEventId: newBoundary.id,
        },
      });
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const completed = completionSignal();
      const coordinator = createCoordinator({
        writer,
        entries: [
          { ordinal: 1, event: oldUser },
          { ordinal: 2, event: oldBoundary },
          { ordinal: 3, event: newUser },
          { ordinal: 4, event: newBoundary },
        ],
        checkpoints: [firstCheckpoint, secondCheckpoint],
        outputs: [emptyIncidentalProposal(), emptyIncidentalProposal()],
        observed,
        onResidencyRelease: completed.resolve,
      });

      coordinator.sourceCapabilities().extract(
        compactionSnapshot(secondCheckpoint, {
          sourceSystemPrompt: 'current system',
          sourceText: 'New durable context.',
          sourceEventId: newUser.id,
        }),
      );
      await completed.promise;

      assert.deepEqual(
        observed.map(({ snapshot: source }) => source.compactionCheckpointId),
        [firstCheckpoint.checkpointId, secondCheckpoint.checkpointId],
      );
      assert.match(JSON.stringify(observed[0]!.snapshot.sourceMessages), /Old durable context/);
      assert.doesNotMatch(
        JSON.stringify(observed[0]!.snapshot.sourceMessages),
        /New durable context/,
      );
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 4);
      await coordinator.close();
    });
  });

  test('settles a denied checkpoint after discarding an older pending failure', async () => {
    await withMemoryWriter(async (writer) => {
      const pendingUser = textEvent(
        'pending-user',
        'run-pending',
        'turn-pending',
        'Pending durable detail.',
      );
      const pendingBoundary = modelTextEvent(
        'pending-boundary',
        'run-pending',
        'turn-pending',
        'Pending response.',
      );
      const deniedUser = textEvent(
        'pending-denied-user',
        'run-denied',
        'turn-denied',
        'This disabled-period detail must never be extracted.',
      );
      const deniedBoundary = modelTextEvent(
        'pending-denied-boundary',
        'run-denied',
        'turn-denied',
        'Denied response.',
      );
      const eligibleUser = textEvent(
        'pending-eligible-user',
        'run-eligible',
        'turn-eligible',
        'New eligible durable detail.',
      );
      const eligibleBoundary = modelTextEvent(
        'pending-eligible-boundary',
        'run-eligible',
        'turn-eligible',
        'Eligible response.',
      );
      const deniedCheckpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [pendingUser, pendingBoundary, deniedUser],
        summary: 'Denied period.',
        summaryFormat: 'legacy_freeform',
        memoryExtractionBoundary: {
          runId: deniedBoundary.runId,
          turnId: deniedBoundary.turnId,
          runtimeEventId: deniedBoundary.id,
          disposition: 'policy_denied',
        },
      });
      const eligibleCheckpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [
          pendingUser,
          pendingBoundary,
          deniedUser,
          deniedBoundary,
          eligibleUser,
        ],
        summary: 'Eligible tail.',
        summaryFormat: 'legacy_freeform',
        previousCheckpointId: deniedCheckpoint.checkpointId,
        memoryExtractionBoundary: {
          runId: eligibleBoundary.runId,
          turnId: eligibleBoundary.turnId,
          runtimeEventId: eligibleBoundary.id,
        },
      });
      const entries = [
        { ordinal: 1, event: pendingUser },
        { ordinal: 2, event: pendingBoundary },
        { ordinal: 3, event: deniedUser },
        { ordinal: 4, event: deniedBoundary },
        { ordinal: 5, event: eligibleUser },
        { ordinal: 6, event: eligibleBoundary },
      ];
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const firstCompleted = completionSignal();
      const secondCompleted = completionSignal();
      let completions = 0;
      const coordinator = createCoordinator({
        writer,
        entries,
        checkpoints: [deniedCheckpoint, eligibleCheckpoint],
        outputs: [
          ...Array.from({ length: 6 }, () => new Error('provider unavailable')),
          emptyIncidentalProposal(),
        ],
        observed,
        onResidencyRelease: () => {
          completions += 1;
          (completions === 1 ? firstCompleted : secondCompleted).resolve();
        },
      });

      coordinator
        .sourceCapabilities()
        .extract(
          extractSnapshot(
            pendingBoundary.runId,
            pendingBoundary.turnId,
            pendingBoundary.id,
            'Pending durable detail.',
            pendingUser.id,
          ),
        );
      await firstCompleted.promise;
      assert.ok(await writer.readPendingExtractionFailure('session-1'));

      coordinator.sourceCapabilities().extract(
        compactionSnapshot(eligibleCheckpoint, {
          sourceSystemPrompt: 'current system',
          sourceText: 'New eligible durable detail.',
          sourceEventId: eligibleUser.id,
        }),
      );
      await secondCompleted.promise;

      assert.equal(observed.length, 7);
      assert.doesNotMatch(
        JSON.stringify(observed.at(-1)!.snapshot.sourceMessages),
        /disabled-period detail/,
      );
      assert.match(
        JSON.stringify(observed.at(-1)!.snapshot.sourceMessages),
        /New eligible durable detail/,
      );
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 6);
      assert.equal(await writer.readPendingExtractionFailure('session-1'), undefined);
      await coordinator.close();
    });
  });

  test('persists an execution-time denial behind an explicit pending failure and enforces its Summary barrier', async () => {
    await withMemoryWriter(async (writer) => {
      const requestedUser = textEvent(
        'race-request-user',
        'run-request',
        'turn-request',
        'Remember my durable preference.',
      );
      const requestedCall = toolCallEvent(
        'race-request-call',
        'run-request',
        'turn-request',
        'race-call',
      );
      const deniedUser = textEvent(
        'race-denied-user',
        'run-denied',
        'turn-denied',
        'DENIED_RUNTIME_SECRET',
      );
      const deniedBoundary = modelTextEvent(
        'race-denied-boundary',
        'run-denied',
        'turn-denied',
        'Denied response.',
      );
      const laterUser = textEvent(
        'race-later-user',
        'run-later',
        'turn-later',
        'Later eligible detail.',
      );
      const laterBoundary = modelTextEvent(
        'race-later-boundary',
        'run-later',
        'turn-later',
        'Later response.',
      );
      const deniedCheckpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [requestedUser, requestedCall, deniedUser],
        summary: 'DENIED_SUMMARY_SECRET',
        summaryFormat: 'legacy_freeform',
        memoryExtractionBoundary: {
          runId: deniedBoundary.runId,
          turnId: deniedBoundary.turnId,
          runtimeEventId: deniedBoundary.id,
        },
        now: 3_000,
      });
      const laterCheckpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [requestedUser, requestedCall, deniedUser, deniedBoundary, laterUser],
        summary: 'Cumulative summary after denial.',
        summaryFormat: 'legacy_freeform',
        previousCheckpointId: deniedCheckpoint.checkpointId,
        memoryExtractionBoundary: {
          runId: laterBoundary.runId,
          turnId: laterBoundary.turnId,
          runtimeEventId: laterBoundary.id,
        },
        now: 4_000,
      });
      const entries = [
        { ordinal: 1, event: requestedUser },
        { ordinal: 2, event: requestedCall },
        { ordinal: 3, event: deniedUser },
        { ordinal: 4, event: deniedBoundary },
        { ordinal: 5, event: laterUser },
        { ordinal: 6, event: laterBoundary },
      ];
      const policyState = { incognito: false };
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const deniedDone = completionSignal();
      const laterDone = completionSignal();
      let releases = 0;
      const coordinator = createCoordinator({
        writer,
        entries,
        checkpoints: [deniedCheckpoint, laterCheckpoint],
        outputs: [
          ...Array.from({ length: 6 }, () => new Error('provider unavailable')),
          emptyIncidentalProposal(),
        ],
        observed,
        policyState,
        onResidencyRelease: () => {
          releases += 1;
          (releases === 1 ? deniedDone : laterDone).resolve();
        },
      });

      const first = await coordinator
        .sourceCapabilities()
        .remember(
          snapshot(
            requestedCall.runId,
            requestedCall.turnId,
            'race-call',
            requestedUser.content?.kind === 'text' ? requestedUser.content.text : '',
            requestedUser.id,
          ),
        );
      assert.equal(first.status, 'unavailable');
      assert.equal(
        (await writer.readPendingExtractionFailure('session-1'))?.firstTrigger,
        'remember',
      );

      policyState.incognito = true;
      coordinator.sourceCapabilities().extract(
        compactionSnapshot(deniedCheckpoint, {
          sourceSystemPrompt: 'current system',
          sourceText: 'DENIED_RUNTIME_SECRET',
          sourceEventId: deniedUser.id,
        }),
      );
      await deniedDone.promise;

      assert.deepEqual(
        (await writer.readCompactionPolicyDenials('session-1')).map(
          ({ compactionCheckpointId }) => compactionCheckpointId,
        ),
        [deniedCheckpoint.checkpointId],
      );
      assert.equal(await writer.readExtractionCursor('session-1'), undefined);
      assert.equal(
        (await writer.readPendingExtractionFailure('session-1'))?.firstTrigger,
        'remember',
      );

      policyState.incognito = false;
      coordinator.sourceCapabilities().extract(
        compactionSnapshot(laterCheckpoint, {
          sourceSystemPrompt: 'current system',
          sourceText: 'Later eligible detail.',
          sourceEventId: laterUser.id,
        }),
      );
      await laterDone.promise;

      const tailRequest = observed.at(-1);
      assert.ok(tailRequest);
      assert.match(JSON.stringify(tailRequest.snapshot.sourceMessages), /Later eligible detail/);
      assert.doesNotMatch(
        JSON.stringify(tailRequest.snapshot.sourceMessages),
        /DENIED_RUNTIME_SECRET|DENIED_SUMMARY_SECRET|Cumulative summary after denial/,
      );
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 6);
      assert.equal(await writer.readPendingExtractionFailure('session-1'), undefined);
      await coordinator.close();
    });
  });

  test('durably skips a policy-denied checkpoint before extracting a later eligible tail', async () => {
    await withMemoryWriter(async (writer) => {
      const deniedUser = textEvent(
        'denied-user',
        'run-denied',
        'turn-denied',
        'Private detail from the disabled period.',
      );
      const deniedBoundary = modelTextEvent(
        'denied-boundary',
        'run-denied',
        'turn-denied',
        'Denied response.',
      );
      const eligibleUser = textEvent(
        'eligible-user',
        'run-eligible',
        'turn-eligible',
        'New eligible durable context.',
      );
      const eligibleBoundary = modelTextEvent(
        'eligible-boundary',
        'run-eligible',
        'turn-eligible',
        'Eligible response.',
      );
      const deniedCheckpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [deniedUser],
        summary: 'Denied period.',
        summaryFormat: 'legacy_freeform',
        memoryExtractionBoundary: {
          runId: deniedBoundary.runId,
          turnId: deniedBoundary.turnId,
          runtimeEventId: deniedBoundary.id,
          disposition: 'policy_denied',
        },
      });
      const eligibleCheckpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [deniedUser, deniedBoundary, eligibleUser],
        summary: 'Eligible tail.',
        summaryFormat: 'legacy_freeform',
        previousCheckpointId: deniedCheckpoint.checkpointId,
        memoryExtractionBoundary: {
          runId: eligibleBoundary.runId,
          turnId: eligibleBoundary.turnId,
          runtimeEventId: eligibleBoundary.id,
          disposition: 'eligible',
        },
      });
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const completed = completionSignal();
      const coordinator = createCoordinator({
        writer,
        entries: [
          { ordinal: 1, event: deniedUser },
          { ordinal: 2, event: deniedBoundary },
          { ordinal: 3, event: eligibleUser },
          { ordinal: 4, event: eligibleBoundary },
        ],
        checkpoints: [deniedCheckpoint, eligibleCheckpoint],
        outputs: [emptyIncidentalProposal()],
        observed,
        onResidencyRelease: completed.resolve,
      });

      coordinator.sourceCapabilities().extract(
        compactionSnapshot(eligibleCheckpoint, {
          sourceSystemPrompt: 'current system',
          sourceText: 'New eligible durable context.',
          sourceEventId: eligibleUser.id,
        }),
      );
      await completed.promise;

      assert.equal(observed.length, 1, 'the denied checkpoint must never call the model');
      assert.equal(observed[0]!.snapshot.compactionCheckpointId, eligibleCheckpoint.checkpointId);
      assert.doesNotMatch(observed[0]!.prompt, /Private detail from the disabled period/);
      assert.match(
        JSON.stringify(observed[0]!.snapshot.sourceMessages),
        /New eligible durable context/,
      );
      assert.match(observed[0]!.prompt, /event:eligible-user/);
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 4);
      assert.deepEqual(
        await writer.searchByKeys({ terms: ['response preference'], match: 'exact' }),
        [],
      );
      await coordinator.close();
    });
  });

  test('fails closed when a Compaction checkpoint boundary tuple does not match the ledger', async () => {
    await withMemoryWriter(async (writer) => {
      const user = textEvent('tuple-user', 'run-1', 'turn-1', 'Durable context.');
      const boundary = modelTextEvent('tuple-boundary', 'run-1', 'turn-1', 'Response.');
      const checkpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [user],
        summary: 'Context.',
        summaryFormat: 'legacy_freeform',
        memoryExtractionBoundary: {
          runId: 'wrong-run',
          turnId: boundary.turnId,
          runtimeEventId: boundary.id,
        },
      });
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const completed = completionSignal();
      const coordinator = createCoordinator({
        writer,
        entries: [
          { ordinal: 1, event: user },
          { ordinal: 2, event: boundary },
        ],
        checkpoints: [checkpoint],
        outputs: [],
        observed,
        onResidencyRelease: completed.resolve,
      });

      coordinator.sourceCapabilities().extract(
        compactionSnapshot(checkpoint, {
          sourceSystemPrompt: 'system',
          sourceText: 'Durable context.',
          sourceEventId: user.id,
        }),
      );
      await completed.promise;

      assert.equal(observed.length, 0);
      assert.equal(await writer.readExtractionCursor('session-1'), undefined);
      await coordinator.close();
    });
  });

  test('fails closed over malformed Compaction and non-Compaction source-context recipes', async () => {
    await withMemoryWriter(async (writer) => {
      const user = textEvent('recipe-user', 'run-1', 'turn-1', 'Durable context.');
      const boundary = modelTextEvent('recipe-boundary', 'run-1', 'turn-1', 'Response.');
      const checkpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [user],
        summary: 'Context.',
        summaryFormat: 'legacy_freeform',
        memoryExtractionBoundary: {
          runId: boundary.runId,
          turnId: boundary.turnId,
          runtimeEventId: boundary.id,
        },
      });
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const firstCompleted = completionSignal();
      const secondCompleted = completionSignal();
      let completions = 0;
      const coordinator = createCoordinator({
        writer,
        entries: [
          { ordinal: 1, event: user },
          { ordinal: 2, event: boundary },
        ],
        checkpoints: [checkpoint],
        outputs: [],
        observed,
        onResidencyRelease: () => {
          completions += 1;
          (completions === 1 ? firstCompleted : secondCompleted).resolve();
        },
      });

      coordinator.sourceCapabilities().extract({
        ...compactionSnapshot(checkpoint, {
          sourceSystemPrompt: 'system',
          sourceText: 'Durable context.',
          sourceEventId: user.id,
        }),
        sourceMessages: [{ role: 'user', content: 'must not be accepted beside a recipe' }],
      });
      await firstCompleted.promise;

      coordinator.sourceCapabilities().extract({
        ...extractSnapshot('run-1', 'turn-extract', boundary.id, 'Durable context.', user.id),
        rebuildSourceContextFromCompactionCheckpoint: true,
      });
      await secondCompleted.promise;

      assert.equal(observed.length, 0);
      assert.equal(await writer.readExtractionCursor('session-1'), undefined);
      await coordinator.close();
    });
  });

  test('keeps a late Compaction recoverable when drain is the only unavailable gate', async () => {
    await withMemoryWriter(async (writer) => {
      const user = textEvent('drain-user', 'run-1', 'turn-1', 'Durable context.');
      const boundary = modelTextEvent('drain-boundary', 'run-1', 'turn-1', 'Response.');
      const checkpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [user],
        summary: 'Context.',
        summaryFormat: 'legacy_freeform',
        memoryExtractionBoundary: {
          runId: boundary.runId,
          turnId: boundary.turnId,
          runtimeEventId: boundary.id,
        },
      });
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries: [
          { ordinal: 1, event: user },
          { ordinal: 2, event: boundary },
        ],
        checkpoints: [checkpoint],
        outputs: [],
        observed,
      });

      coordinator.beginDrain();
      coordinator.sourceCapabilities().extract(
        compactionSnapshot(checkpoint, {
          sourceSystemPrompt: 'system',
          sourceText: 'Durable context.',
          sourceEventId: user.id,
        }),
      );
      await coordinator.close();

      assert.equal(observed.length, 0);
      assert.equal(await writer.readExtractionCursor('session-1'), undefined);
    });
  });

  test('settles an explicit Incognito denial for a late Compaction during drain', async () => {
    await withMemoryWriter(async (writer) => {
      const user = textEvent('drain-denied-user', 'run-1', 'turn-1', 'Private context.');
      const boundary = modelTextEvent('drain-denied-boundary', 'run-1', 'turn-1', 'Response.');
      const checkpoint = buildHistoryCompactCheckpoint({
        sessionId: 'session-1',
        coveredRuntimeEvents: [user],
        summary: 'Context.',
        summaryFormat: 'legacy_freeform',
        memoryExtractionBoundary: {
          runId: boundary.runId,
          turnId: boundary.turnId,
          runtimeEventId: boundary.id,
        },
      });
      const observed: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }> = [];
      const coordinator = createCoordinator({
        writer,
        entries: [
          { ordinal: 1, event: user },
          { ordinal: 2, event: boundary },
        ],
        checkpoints: [checkpoint],
        outputs: [],
        observed,
        policyState: { incognito: true },
      });

      coordinator.beginDrain();
      coordinator.sourceCapabilities().extract(
        compactionSnapshot(checkpoint, {
          sourceSystemPrompt: 'system',
          sourceText: 'Private context.',
          sourceEventId: user.id,
        }),
      );
      await coordinator.close();

      assert.equal(observed.length, 0);
      assert.equal((await writer.readExtractionCursor('session-1'))?.processedOrdinal, 2);
    });
  });
});

function createCoordinator(input: {
  writer: InteractiveLongTermMemoryWriter;
  entries: Array<{ ordinal: number; event: RuntimeEvent }>;
  outputs: Array<string | Error>;
  observed?: Array<{ snapshot: MemoryExtractionSourceSnapshot; prompt: string }>;
  policyState?: { incognito: boolean };
  afterModelCall?: () => void;
  onResidencyRelease?: () => void;
  checkpoint?: HistoryCompactCheckpoint;
  checkpoints?: HistoryCompactCheckpoint[];
}): HostMemoryExtractionCoordinator {
  const policyState = input.policyState ?? { incognito: false };
  let call = 0;
  return new HostMemoryExtractionCoordinator({
    store: input.writer,
    policy: {
      getSnapshot: async () =>
        ({
          revision: 1,
          policy: {
            ...createDefaultRuntimePolicy(),
            privacy: { incognitoActive: policyState.incognito },
          },
        }) satisfies Awaited<ReturnType<RuntimePolicyReader['getSnapshot']>>,
    },
    sessions: { readHeader: async () => header() },
    runtimeEvents: { readSessionRuntimeEventEntries: async () => [...input.entries] },
    historyCompaction: {
      readLatestCheckpoint: async () => input.checkpoints?.at(-1) ?? input.checkpoint,
      readCheckpoints: async () =>
        input.checkpoints ?? (input.checkpoint ? [input.checkpoint] : []),
    },
    model: {
      generate: async ({ snapshot: source, prompt }) => {
        input.observed?.push({ snapshot: source, prompt });
        const output = input.outputs[call++];
        if (output === undefined) throw new Error('Unexpected model call');
        if (output instanceof Error) return { ok: false, errorClass: 'provider' };
        input.afterModelCall?.();
        return { ok: true, text: output };
      },
    },
    lane: new MemoryExtractionSessionLane(),
    acquireResidency: () => ({ release: () => input.onResidencyRelease?.() }),
    now: () => 2_000,
  });
}

function snapshot(
  runId: string,
  turnId: string,
  toolCallId: string,
  text: string,
  indexedEventId?: string,
): MemoryExtractionSourceSnapshot {
  return {
    trigger: 'remember',
    sourceHeader: header(),
    sourceSystemPrompt: 'original system',
    sourceMessages: [{ role: 'user', content: text }],
    ...(indexedEventId ? { sourceEventMessagePositions: { [indexedEventId]: [0] } } : {}),
    sourceTools: {
      memory_remember: { description: 'Remember', inputSchema: {} },
    },
    sourceActiveTools: ['memory_remember'],
    sourceProviderOptions: { openai: { reasoningEffort: 'medium' } },
    sessionId: 'session-1',
    runId,
    turnId,
    workspaceIdentity: WORKSPACE_IDENTITY,
    toolCallId,
  };
}

function extractSnapshot(
  runId: string,
  turnId: string,
  terminalEventId: string,
  text: string,
  indexedEventId?: string,
): MemoryExtractionSourceSnapshot {
  return {
    trigger: 'extract',
    sourceHeader: header(),
    sourceSystemPrompt: 'original system',
    sourceMessages: [
      { role: 'user', content: text },
      { role: 'assistant', content: 'Understood.' },
    ],
    ...(indexedEventId ? { sourceEventMessagePositions: { [indexedEventId]: [0] } } : {}),
    sourceTools: {
      memory_extract: { description: 'Extract', inputSchema: {} },
    },
    sourceActiveTools: ['memory_extract'],
    sourceProviderOptions: { openai: { reasoningEffort: 'medium' } },
    sessionId: 'session-1',
    runId,
    turnId,
    workspaceIdentity: WORKSPACE_IDENTITY,
    terminalEventId,
  };
}

function compactionSnapshot(
  checkpoint: HistoryCompactCheckpoint,
  input: {
    sourceSystemPrompt: string;
    sourceText: string;
    sourceEventId: string;
  },
): MemoryExtractionSourceSnapshot {
  const boundary = checkpoint.memoryExtractionBoundary;
  assert.ok(boundary);
  return {
    trigger: 'compaction',
    sourceHeader: header(),
    sourceSystemPrompt: input.sourceSystemPrompt,
    sourceMessages: [],
    rebuildSourceContextFromCompactionCheckpoint: true,
    sourceTools: { Read: { description: 'Current tool schema', inputSchema: {} } },
    sourceActiveTools: ['Read'],
    sourceProviderOptions: { openai: { reasoningEffort: 'high' } },
    sourceMaxOutputTokens: 2_048,
    sessionId: 'session-1',
    runId: 'run-current-trigger',
    turnId: 'turn-current-trigger',
    workspaceIdentity: WORKSPACE_IDENTITY,
    compactionCheckpointId: checkpoint.checkpointId,
    compactionBoundaryEventId: boundary.runtimeEventId,
  };
}

function emptyIncidentalProposal(): string {
  return JSON.stringify({
    status: 'complete',
    coverageStatus: 'processed',
    requestedStatus: 'not_applicable',
    requestedItems: [],
    incidentalItems: [],
  });
}

function extractProposal(item: ReturnType<typeof proposalItem>): string {
  return JSON.stringify({
    status: 'complete',
    coverageStatus: 'processed',
    requestedStatus: 'not_applicable',
    requestedItems: [],
    incidentalItems: [item],
  });
}

function proposal(
  content: string,
  scope: 'global' | 'workspace',
  eventId: string,
  quote?: string,
): string {
  return JSON.stringify({
    status: 'complete',
    coverageStatus: 'processed',
    requestedStatus: 'resolved',
    requestedItems: [proposalItem(content, scope, eventId, quote)],
    incidentalItems: [],
  });
}

function proposalItem(
  content: string,
  scope: 'global' | 'workspace',
  eventId: string,
  quote = content.includes('concise')
    ? 'concise Chinese'
    : content.includes('English')
      ? 'detailed English'
      : content.includes('violet')
        ? 'violet'
        : 'Prefer Rust',
) {
  return {
    content,
    kind: 'preference',
    statementType: 'fact',
    temporalType: 'undated',
    eventStartedAt: null,
    eventEndedAt: null,
    scope,
    keys: [{ key: 'response preference', type: 'concept' }],
    evidence: [{ sourceRef: `event:${eventId}`, quote }],
  };
}

function canonicalization(...items: Array<ReturnType<typeof proposalItem>>): string {
  return JSON.stringify({
    results: items.map((item, index) => canonicalizationResult(`candidate_${index}`, item)),
  });
}

function canonicalizationResult(
  candidateId: string,
  { evidence: _evidence, ...item }: ReturnType<typeof proposalItem>,
) {
  return { candidateId, status: 'accepted', item } as const;
}

function header(): SessionHeader {
  return {
    id: 'session-1',
    workspaceRoot: '/workspace/maka',
    cwd: '/workspace/maka',
    createdAt: 1,
    name: 'Memory test',
    titleIsManual: false,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'test',
    connectionLocked: true,
    model: 'test-model',
    permissionMode: 'bypass',
    schemaVersion: 1,
  };
}

function textEvent(id: string, runId: string, turnId: string, text: string): RuntimeEvent {
  return {
    id,
    invocationId: `invocation-${runId}`,
    runId,
    sessionId: 'session-1',
    turnId,
    ts: 1_000,
    partial: false,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text },
  };
}

function modelTextEvent(id: string, runId: string, turnId: string, text: string): RuntimeEvent {
  return {
    ...textEvent(id, runId, turnId, text),
    role: 'model',
    author: 'agent',
  };
}

function toolCallEvent(
  id: string,
  runId: string,
  turnId: string,
  toolCallId: string,
): RuntimeEvent {
  return {
    id,
    invocationId: `invocation-${runId}`,
    runId,
    sessionId: 'session-1',
    turnId,
    ts: 1_001,
    partial: false,
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: toolCallId, name: 'memory_remember', args: {} },
  };
}

async function withMemoryWriter(
  operation: (writer: InteractiveLongTermMemoryWriter) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-memory-extraction-'));
  let owner: InteractiveRootOwner | undefined;
  let writer: InteractiveLongTermMemoryWriter | undefined;
  try {
    const capability = await resolveStorageRoot({ path: root, kind: 'interactive' });
    owner = (await tryAcquireInteractiveRootOwner(capability)) ?? undefined;
    assert.ok(owner);
    writer = await openInteractiveLongTermMemoryStoreForWrite(owner.lease);
    await operation(writer);
  } finally {
    writer?.close();
    await owner?.close();
    await rm(root, { recursive: true, force: true });
  }
}

function completionSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
