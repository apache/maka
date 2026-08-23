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
import type { RuntimeEvent } from '@maka/core/runtime-event';

import { buildHistoryCompactCheckpoint } from '../history-compact-checkpoint.js';
import {
  bindProviderVisibleEvidence,
  projectMemoryExtractionEvidence,
} from '../memory-extraction-evidence.js';
import {
  buildMemoryCompactionSourceContext,
  buildMemoryExtractionTriggerTools,
  MEMORY_EXTRACT_TOOL_NAME,
  MEMORY_REMEMBER_TOOL_NAME,
} from '../memory-extraction.js';
import {
  admitMemoryProposalItem,
  buildFirstMemoryProposalPrompt,
  parseMemoryProposal,
} from '../memory-extraction-proposal.js';

describe('bounded Memory Extraction', () => {
  test('freezes an attachment-free Compaction context at the exact RuntimeEvent boundary', () => {
    const source = buildMemoryCompactionSourceContext(
      [
        event('user-before', 'user', { kind: 'text', text: 'Durable user preference.' }),
        event('thinking-before', 'model', { kind: 'thinking', text: 'private reasoning' }),
        event('call-before', 'model', {
          kind: 'function_call',
          id: 'call-1',
          name: 'Read',
          args: { path: 'README.md' },
        }),
        event('result-boundary', 'tool', {
          kind: 'function_response',
          id: 'call-1',
          name: 'Read',
          result: { text: 'tool context' },
        }),
        event('user-after', 'user', { kind: 'text', text: 'Must stay outside.' }),
      ],
      'result-boundary',
    );

    assert.ok(source);
    const serialized = JSON.stringify(source.messages);
    assert.match(serialized, /Durable user preference/);
    assert.doesNotMatch(serialized, /README\.md|tool context/);
    assert.doesNotMatch(serialized, /private reasoning|Must stay outside/);
    assert.deepEqual(source.eventMessagePositions?.['user-before'], [0]);
    assert.equal(source.eventMessagePositions?.['user-after'], undefined);
  });

  test('excludes attachments, quotes, and Tool context from Compaction interpretation text', () => {
    const source = buildMemoryCompactionSourceContext(
      [
        event('user-attachment', 'user', {
          kind: 'text',
          text: 'Remember the visible sentence.',
          attachments: [
            {
              kind: 'image',
              name: 'private-chart.png',
              mimeType: 'image/png',
              bytes: 123,
              ref: {
                kind: 'session_file',
                sessionId: 'session-1',
                relativePath: 'attachments/private-chart.png',
              },
            },
          ],
          quotes: [{ text: 'quoted durable detail' }],
        }),
        event('image-call', 'model', {
          kind: 'function_call',
          id: 'image-call',
          name: 'Read',
          args: { ref: 'session-resource' },
        }),
        event('image-result', 'tool', {
          kind: 'function_response',
          id: 'image-call',
          name: 'Read',
          result: {
            kind: 'image',
            mimeType: 'image/png',
            bytes: 456,
            ref: { kind: 'session_file', relativePath: 'secret-result.png' },
          },
        }),
      ],
      'image-result',
    );

    assert.ok(source);
    const serialized = JSON.stringify(source.messages);
    assert.match(serialized, /Remember the visible sentence/);
    assert.doesNotMatch(
      serialized,
      /quoted durable detail|<attachment>|private-chart|secret-result|image\/png|session_file|session-resource/,
    );
  });

  test('keeps Assistant text while excluding parallel Tool and provider-native semantics', () => {
    const stepText = {
      ...event('assistant-step', 'model', { kind: 'text', text: 'Checking both sources.' }),
      refs: { storedMessageId: 'step-1' },
    };
    const firstCall = {
      ...event('call-a', 'model', {
        kind: 'function_call',
        id: 'call-a',
        name: 'Read',
        args: { path: 'a.md' },
        providerOptions: { anthropic: { opaque: 'secret-provider-metadata' } },
      }),
      refs: { stepId: 'step-1' },
    };
    const secondCall = {
      ...event('call-b', 'model', {
        kind: 'function_call',
        id: 'call-b',
        name: 'Read',
        args: { path: 'b.md' },
      }),
      refs: { stepId: 'step-1' },
    };
    const source = buildMemoryCompactionSourceContext(
      [
        stepText,
        {
          ...event('thinking-step', 'model', {
            kind: 'thinking',
            text: 'private step reasoning',
            signature: 'signed-thinking',
          }),
          refs: { stepId: 'step-1' },
        },
        firstCall,
        secondCall,
        event('result-a', 'tool', {
          kind: 'function_response',
          id: 'call-a',
          name: 'Read',
          result: { text: 'A' },
        }),
        event('result-b', 'tool', {
          kind: 'function_response',
          id: 'call-b',
          name: 'Read',
          result: { text: 'B' },
        }),
      ],
      'result-b',
    );

    assert.ok(source);
    assert.equal(source.messages.length, 1);
    assert.equal(source.messages[0]?.role, 'assistant');
    const assistant = source.messages[0] as Extract<
      (typeof source.messages)[number],
      { role: 'assistant' }
    >;
    assert.ok(Array.isArray(assistant.content));
    assert.deepEqual(
      assistant.content.map((part) => part.type),
      ['text'],
    );
    assert.equal(source.eventMessagePositions?.['call-a'], undefined);
    assert.equal(source.eventMessagePositions?.['result-a'], undefined);
    const serialized = JSON.stringify(source.messages);
    assert.match(serialized, /Checking both sources/);
    assert.doesNotMatch(
      serialized,
      /tool_call|tool_result|a\.md|b\.md|secret-provider-metadata|signed-thinking|private step reasoning/,
    );
  });

  test('rebuilds only the post-Cursor Event slice behind the previous Compaction summary', () => {
    const compacted = event('compacted-user', 'user', {
      kind: 'text',
      text: 'Raw text already represented by the old summary.',
    });
    const previousCheckpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: [compacted],
      summary: 'The old summary remains interpretation context.',
      summaryFormat: 'legacy_freeform',
    });
    const source = buildMemoryCompactionSourceContext(
      [
        compacted,
        event('cursor-event', 'model', { kind: 'text', text: 'Already processed response.' }),
        event('new-user', 'user', { kind: 'text', text: 'Only this new user text is pending.' }),
      ],
      'new-user',
      { afterEventId: 'cursor-event', previousCheckpoint },
    );

    assert.ok(source);
    const serialized = JSON.stringify(source.messages);
    assert.match(serialized, /old summary remains interpretation context/);
    assert.match(serialized, /Only this new user text is pending/);
    assert.doesNotMatch(serialized, /Raw text already represented|Already processed response/);
    assert.deepEqual(source.eventMessagePositions?.['new-user'], [1]);
    assert.equal(source.eventMessagePositions?.['cursor-event'], undefined);
  });

  test('projects only user text, excluding Assistant, Thinking, and every Tool event', () => {
    const evidence = projectMemoryExtractionEvidence([
      event('user-1', 'user', { kind: 'text', text: 'Use concise Chinese answers.' }),
      {
        ...event('host-user-1', 'user', { kind: 'text', text: 'Host-authored instruction.' }),
        author: 'host',
      },
      event('thinking-1', 'model', { kind: 'thinking', text: 'private reasoning' }),
      event('assistant-1', 'model', { kind: 'text', text: 'Understood.' }),
      event('tool-call-1', 'model', {
        kind: 'function_call',
        id: 'call-1',
        name: 'Read',
        args: { path: 'README.md' },
      }),
      event('tool-result-1', 'tool', {
        kind: 'function_response',
        id: 'call-1',
        name: 'Read',
        result: { text: 'Maka' },
      }),
      event('tool-call-2', 'model', {
        kind: 'function_call',
        id: 'call-2',
        name: 'Bash',
        args: { cmd: 'false' },
      }),
      event('tool-result-2', 'tool', {
        kind: 'function_response',
        id: 'call-2',
        name: 'Bash',
        result: 'failed',
        isError: true,
      }),
    ]);

    assert.deepEqual(
      evidence.map(({ sourceRef, type }) => ({ sourceRef, type })),
      [{ sourceRef: 'event:user-1', type: 'user_message' }],
    );
    assert.equal(
      evidence.some(({ text }) => text.includes('private reasoning')),
      false,
    );
    const prompt = buildFirstMemoryProposalPrompt({
      trigger: 'extract',
      now: 61_234,
      evidence,
    });
    assert.match(prompt, /Current time: 60000/);
    assert.match(prompt, /"observedAt":0/);
    assert.match(prompt, /Do not call or request any tool/);
  });

  test('returns an explicit unsupported result without starting extraction', async () => {
    let snapshotCalled = false;
    let extractMarked = false;
    const tools = buildMemoryExtractionTriggerTools({
      capabilities: {
        gate: async () => ({ allowed: true }),
        remember: async () => {
          throw new Error('must not run');
        },
        extract: () => {
          throw new Error('must not run');
        },
      },
      snapshot: () => {
        snapshotCalled = true;
        return undefined;
      },
      markExtractRequested: () => {
        extractMarked = true;
      },
      unsupportedReason: 'provider_unsupported',
    });
    const remember = tools.find(({ name }) => name === MEMORY_REMEMBER_TOOL_NAME);
    const extract = tools.find(({ name }) => name === MEMORY_EXTRACT_TOOL_NAME);
    assert.ok(remember);
    assert.ok(extract);

    assert.deepEqual(await remember.impl({}, {} as never), {
      status: 'unavailable',
      reason: 'provider_unsupported',
      requestedItems: [],
    });
    assert.deepEqual(await extract.impl({}, {} as never), {
      status: 'unavailable',
      reason: 'provider_unsupported',
    });
    assert.equal(snapshotCalled, false);
    assert.equal(extractMarked, false);
  });

  test('parses only the strict top-level Proposal schema', () => {
    const valid = JSON.stringify({
      status: 'complete',
      coverageStatus: 'processed',
      requestedStatus: 'not_applicable',
      requestedItems: [],
      incidentalItems: [],
    });
    assert.equal(parseMemoryProposal(valid)?.status, 'complete');
    assert.equal(parseMemoryProposal(`\`\`\`json\n${valid}\n\`\`\``), undefined);
    assert.equal(
      parseMemoryProposal(JSON.stringify({ ...JSON.parse(valid), extra: true })),
      undefined,
    );
    assert.equal(
      parseMemoryProposal(
        JSON.stringify({
          status: 'search_required',
          coverageStatus: 'unprocessed',
          requestedStatus: 'unresolved',
          requestedItems: [],
          incidentalItems: [],
          search: { terms: ['earlier'] },
        }),
      ),
      undefined,
    );
    assert.equal(
      parseMemoryProposal(
        JSON.stringify({
          ...JSON.parse(valid),
          requestedStatus: 'resolved',
          requestedItems: [],
        }),
      ),
      undefined,
    );
  });

  test('requires exact evidence quotes while allowing model-selected global scope', () => {
    const sourceEvent = event('user-1', 'user', {
      kind: 'text',
      text: 'Please answer in concise Chinese.',
    });
    const evidence = projectMemoryExtractionEvidence([sourceEvent]);
    const byRef = new Map(evidence.map((entry) => [entry.sourceRef, entry]));
    const base = {
      content: 'The user prefers concise Chinese answers.',
      kind: 'preference' as const,
      statementType: 'fact' as const,
      temporalType: 'undated' as const,
      eventStartedAt: null,
      eventEndedAt: null,
      scope: 'global' as const,
      keys: [{ key: 'concise Chinese', type: 'concept' as const }],
      evidence: [{ sourceRef: 'event:user-1', quote: 'concise Chinese' }],
    };
    assert.equal(admitMemoryProposalItem(base, byRef)?.citedEvents[0]?.id, 'user-1');
    assert.equal(
      admitMemoryProposalItem(
        {
          ...base,
          temporalType: 'point',
          eventStartedAt: 61_234,
        },
        byRef,
      )?.eventStartedAt,
      60_000,
    );
    assert.equal(
      admitMemoryProposalItem(
        { ...base, evidence: [{ sourceRef: 'event:user-1', quote: 'not present' }] },
        byRef,
      ),
      undefined,
    );
    assert.equal(
      admitMemoryProposalItem({ ...base, kind: 'knowledge', content: 'Maka uses SQLite.' }, byRef)
        ?.scopeType,
      'global',
    );
  });

  test('admits quotes only from text actually visible to the Provider', () => {
    const hiddenSuffix = 'visible only through the full provider message';
    const fullText = `${'x'.repeat(4_100)} ${hiddenSuffix}`;
    const sourceEvent = event('long-user', 'user', { kind: 'text', text: fullText });
    const projected = projectMemoryExtractionEvidence([sourceEvent]);
    assert.doesNotMatch(projected[0]!.text, new RegExp(hiddenSuffix));
    const base = {
      content: 'The user supplied a durable detail.',
      kind: 'note' as const,
      statementType: 'fact' as const,
      temporalType: 'undated' as const,
      eventStartedAt: null,
      eventEndedAt: null,
      scope: 'workspace' as const,
      keys: [{ key: 'durable detail', type: 'concept' as const }],
      evidence: [{ sourceRef: 'event:long-user', quote: hiddenSuffix }],
    };

    const bounded = new Map(projected.map((entry) => [entry.sourceRef, entry]));
    assert.equal(admitMemoryProposalItem(base, bounded), undefined);

    const bound = bindProviderVisibleEvidence(projected, [{ role: 'user', content: fullText }], {
      'long-user': [0],
    });
    const providerVisible = new Map(bound.map((entry) => [entry.sourceRef, entry]));
    assert.equal(admitMemoryProposalItem(base, providerVisible)?.citedEvents[0]?.id, 'long-user');

    const assistantMapped = bindProviderVisibleEvidence(
      projected,
      [{ role: 'assistant', content: fullText }],
      { 'long-user': [0] },
    );
    assert.equal(
      admitMemoryProposalItem(
        base,
        new Map(assistantMapped.map((entry) => [entry.sourceRef, entry])),
      ),
      undefined,
    );
  });
});

function event(
  id: string,
  role: RuntimeEvent['role'],
  content: NonNullable<RuntimeEvent['content']>,
): RuntimeEvent {
  return {
    id,
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1_000,
    partial: false,
    role,
    author: role === 'user' ? 'user' : role === 'tool' ? 'tool' : 'agent',
    content,
  };
}
