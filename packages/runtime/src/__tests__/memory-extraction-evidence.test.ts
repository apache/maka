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
import {
  bindProviderVisibleEvidence,
  MAX_MEMORY_EVIDENCE_JSON_CHARS,
  memoryExtractionEvidenceJsonSize,
  planMemoryCoverage,
  projectMemoryExtractionEvidence,
  renderMemoryExtractionEvidence,
  searchSameSessionMemoryHistory,
  type MemoryExtractionEventEntry,
} from '../memory-extraction-evidence.js';

describe('Memory Extraction evidence planning', () => {
  test('excludes Tool events from evidence while allowing the Cursor to cross them', () => {
    const entries = withOrdinals([
      textEvent('user', 'user', 'Remember the durable result.'),
      callEvent('call-event-1', 'call-1', 'Read'),
      callEvent('call-event-2', 'call-2', 'Bash'),
      resultEvent('result-event-1', 'call-1', 'Read', { text: 'durable result' }),
      resultEvent('result-event-2', 'call-2', 'Bash', 'failed', true),
      callEvent('call-event-3', 'call-3', 'List'),
      resultEvent('result-event-3', 'call-3', 'List', {}),
      textEvent('next', 'model', 'Done.'),
    ]);
    const userEvidence = projectMemoryExtractionEvidence([entries[0]!.event]);
    const narrow = planMemoryCoverage({
      pendingEntries: entries,
      maxEvidenceJsonChars: memoryExtractionEvidenceJsonSize(userEvidence) + 10,
    });
    assert.deepEqual(
      narrow?.entries.map(({ ordinal }) => ordinal),
      [1, 2, 3, 4, 5, 6, 7, 8],
      'Tool events consume Cursor range without entering the Memory evidence domain',
    );
    assert.deepEqual(
      narrow?.evidence.map(({ sourceRef }) => sourceRef),
      ['event:user'],
    );

    const complete = planMemoryCoverage({
      pendingEntries: entries,
    });
    assert.equal(complete?.entries.at(-1)?.ordinal, 8);
    assert.deepEqual(
      complete?.evidence.map(({ sourceRef }) => sourceRef),
      ['event:user'],
    );
  });

  test('prioritizes requested evidence and enforces one final JSON budget', () => {
    const requestedText = `Remember this exact requested detail: ${'r'.repeat(1_000)}`;
    const requested = textEvent('requested', 'user', requestedText);
    const priority = projectMemoryExtractionEvidence([requested]);
    const pending = withOrdinals([
      textEvent('coverage', 'user', `Reusable detail ${'x'.repeat(8_000)}.`),
    ]);
    const plan = planMemoryCoverage({
      pendingEntries: pending,
      priorityEvidence: priority,
      maxEvidenceJsonChars: 1_800,
    });
    assert.ok(plan);
    assert.equal(plan.evidence[0]?.sourceRef, 'event:requested');
    assert.equal(plan.evidence[0]?.text, requestedText);
    assert.equal(plan.evidence[1]?.sourceRef, 'event:coverage');
    assert.ok(memoryExtractionEvidenceJsonSize(plan.evidence) <= 1_800);
    assert.match(JSON.stringify(renderMemoryExtractionEvidence(plan.evidence)[0]), /Remember this/);
  });

  test('does not guess text positions and returns a bounded hit-centered history snippet', () => {
    const repeated = textEvent('repeated', 'user', 'same preference');
    const ambiguous = projectMemoryExtractionEvidence([repeated]);
    assert.equal(ambiguous[0]?.text, 'same preference');

    const old = textEvent(
      'old',
      'user',
      `${'prefix '.repeat(900)}My preferred accent color is violet.`,
    );
    const entries = withOrdinals([old]);
    const localized = searchSameSessionMemoryHistory(entries, 1, {
      terms: ['violet', 'accent color'],
      roles: ['user'],
    });
    const evidence = projectMemoryExtractionEvidence(
      localized.map(({ event }) => event),
      { snippetTerms: ['violet', 'accent color'] },
    );
    assert.match(evidence[0]!.text, /violet/);
    assert.ok(Array.from(evidence[0]!.text).length <= 4_000);
    assert.ok(memoryExtractionEvidenceJsonSize(evidence) <= MAX_MEMORY_EVIDENCE_JSON_CHARS);

    const toolEntries = withOrdinals([
      callEvent('tail-call', 'tail-id', 'Read'),
      resultEvent('tail-result', 'tail-id', 'Read', {
        text: `${'discard '.repeat(900)}TAIL_TOOL_MEMORY_KEYWORD`,
      }),
    ]);
    const toolHits = searchSameSessionMemoryHistory(toolEntries, 2, {
      terms: ['TAIL_TOOL_MEMORY_KEYWORD'],
      roles: ['user'],
    });
    assert.deepEqual(toolHits, []);
  });

  test('does not localize across a policy-denied history barrier', () => {
    const entries = withOrdinals([
      textEvent('denied-user', 'user', 'PRIVATE_DENIED_HISTORY'),
      textEvent('denied-agent', 'model', 'PRIVATE_DENIED_HISTORY interpretation'),
      textEvent('allowed-user', 'user', 'PUBLIC_ALLOWED_HISTORY'),
    ]);

    assert.deepEqual(
      searchSameSessionMemoryHistory(entries, 3, { terms: ['PRIVATE_DENIED_HISTORY'] }, 2),
      [],
    );
    assert.deepEqual(
      searchSameSessionMemoryHistory(entries, 3, { terms: ['PUBLIC_ALLOWED_HISTORY'] }, 2).map(
        ({ ordinal }) => ordinal,
      ),
      [3],
    );
  });

  test('renders indexed Provider-prefix evidence without duplicating its text', () => {
    const event = textEvent('indexed-user', 'user', 'This text already exists in the prefix.');
    const evidence = projectMemoryExtractionEvidence([event]);
    const messagePositions = { 'indexed-user': [3] };
    const bound = bindProviderVisibleEvidence(
      evidence,
      [
        { role: 'user', content: 'Earlier message 0.' },
        { role: 'assistant', content: 'Earlier response.' },
        { role: 'user', content: 'Earlier message 2.' },
        { role: 'user', content: 'This text already exists in the prefix.' },
      ],
      messagePositions,
    );
    const rendered = renderMemoryExtractionEvidence(bound, messagePositions);

    assert.deepEqual(rendered, [
      {
        sourceRef: 'event:indexed-user',
        type: 'user_message',
        observedAt: 0,
        messagePositions: [3],
      },
    ]);
    assert.equal(JSON.stringify(rendered).includes('already exists'), false);
  });
});

function withOrdinals(events: readonly RuntimeEvent[]): MemoryExtractionEventEntry[] {
  return events.map((event, index) => ({ ordinal: index + 1, event }));
}

function textEvent(id: string, role: 'user' | 'model', text: string): RuntimeEvent {
  return event(id, role, { kind: 'text', text });
}

function callEvent(id: string, callId: string, name: string): RuntimeEvent {
  return event(id, 'model', { kind: 'function_call', id: callId, name, args: {} });
}

function resultEvent(
  id: string,
  callId: string,
  name: string,
  result: unknown,
  isError = false,
): RuntimeEvent {
  return event(id, 'tool', {
    kind: 'function_response',
    id: callId,
    name,
    result,
    ...(isError ? { isError: true } : {}),
  });
}

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
