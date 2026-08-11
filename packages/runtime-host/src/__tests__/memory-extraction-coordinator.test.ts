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
        workspaceKey: '/workspace/maka',
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
          workspaceKey: '/workspace/maka',
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
        workspaceKey: '/workspace/maka',
      });
      assert.equal(stored.length, 2);
      assert.deepEqual(
        stored.map(({ item }) => [item.content, item.scopeType, item.scopeKey]),
        [
          ['The user prefers detailed English.', 'workspace', '/workspace/maka'],
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
      assert.match(observed[0]!.prompt, /Old uncompacted detail/);
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
    historyCompaction: { readLatestCheckpoint: async () => input.checkpoint },
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
    workspaceKey: '/workspace/maka',
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
    workspaceKey: '/workspace/maka',
    terminalEventId,
  };
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

function proposal(content: string, scope: 'global' | 'workspace', eventId: string): string {
  return JSON.stringify({
    status: 'complete',
    coverageStatus: 'processed',
    requestedStatus: 'resolved',
    requestedItems: [proposalItem(content, scope, eventId)],
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
    lastUsedAt: 1,
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
