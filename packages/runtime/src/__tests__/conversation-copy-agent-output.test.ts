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
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { AgentRunEvent, EmittedAgentRunEvent } from '@maka/core/agent-run';
import {
  buildModelProjectionTransition,
  MODEL_PROJECTION_TRANSITION_EVENT_TYPE,
} from '@maka/core/model-projection-transition';
import type { DurableToolResultProjection } from '@maka/core/durable-tool-result-projection';
import { buildInvocationOpenedEvent } from '@maka/core/runtime-invocation';
import type { StoredMessage } from '@maka/core/session';
import { parseAttachmentResourceRef } from '@maka/core/attachments';
import { openInteractiveArtifactStoreForWrite } from '@maka/storage/artifact-stores';
import { openInteractiveExecutionStoresForWrite } from '@maka/storage/execution-stores';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import {
  archivedToolResultContainsConversationOwnedReferences,
  archivedToolResultContainsLinkedChildReferences,
  collectConversationCopyLinkedChildReferences,
  collectConversationCopySessionFileRefs,
  cloneConversationRuntimeLedger,
  prepareConversationRuntimeLedgerCopy,
  rewriteConversationCopyMessage,
  type ConversationCopyMessageReferenceMap,
} from '../conversation-copy.js';
import { testInvocationRecord } from './invocation-fixture.js';
import { isConversationCopyAgentOutputSnapshot } from '../conversation-copy-agent-output.js';
import {
  buildArchivedToolResultPlaceholder,
  isArchivedToolResultPlaceholder,
} from '../tool-result-archive.js';
import { archivedToolResultProjection } from '../tool-result-archive-transition.js';
import { serializeToolResultProjectionV1 } from '../tool-result-archive-encoding.js';
import {
  loadModelProjectionTransitionsFromRunLedger,
  reduceEffectiveModelProjections,
} from '../model-projection-transition-ledger.js';
import { createLedgerArchiveResourceReader } from '../ledger-tool-result-archive-reader.js';
import { readToolResultArchiveResource } from '../tool-result-archive-resource.js';
import { readPageSchema, readToolResultPage, type ReadInput } from '../read-page.js';

function output() {
  const invocation = testInvocationRecord({
    sessionId: 'child',
    runId: 'child-run',
    turnId: 'child-turn',
    outcome: 'completed',
    opening: {
      lineage: {
        parentSessionId: 'parent',
        parentRunId: 'parent-run',
        parentTurnId: 'parent-turn',
      },
    },
  });
  return {
    execution: { kind: 'child_session', sessionId: 'child', currentRunId: 'child-run' },
    invocation,
    result: {
      schemaVersion: 1,
      status: 'completed',
      graph: { graphId: 'graph', workId: 'work', operatorId: 'operator' },
      resultRecordId: 'result-record',
      terminalRecordId: 'terminal-record',
      terminalRuntimeEventId: invocation.terminalEvent!.id,
      text: 'Reviewed all packages.',
      textTruncated: false,
      artifactIds: ['child-artifact'],
      omittedArtifactIds: 0,
    },
    events: [],
    runtimeEvents: [],
    artifacts: [],
    diagnostics: [],
    sourceHealth: { kind: 'healthy' },
    budget: { view: 'result', maxBytes: 32768, projectedBytes: 1000 },
    truncated: {
      events: true,
      runtimeEvents: true,
      artifacts: true,
      diagnostics: false,
      bytes: false,
    },
  };
}

function diagnosticOutput(view: 'events' | 'runtime_events' | 'all') {
  const { result: _result, ...raw } = output();
  const { invocation } = raw;
  const { status: _status, ...terminalEnvelope } = invocation.terminalEvent!;
  const runtimeEvents: RuntimeEvent[] = [
    {
      ...terminalEnvelope,
      id: 'child-text',
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'Diagnostic model text' },
    },
    {
      ...terminalEnvelope,
      id: 'child-read-call-event',
      role: 'model',
      author: 'agent',
      content: {
        kind: 'function_call',
        id: 'child-read-call',
        name: 'Read',
        args: { path: 'maka://runtime/attachments/child-artifact' },
      },
    },
    {
      ...terminalEnvelope,
      id: 'child-read-response-event',
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'child-read-call',
        name: 'Read',
        result: {
          kind: 'text',
          text: 'Expected 12, received 34.\nReport: maka://runtime/attachments/child-artifact\nEnd of report.',
        },
      },
    },
    {
      ...terminalEnvelope,
      id: 'child-bash-call-event',
      role: 'model',
      author: 'agent',
      content: {
        kind: 'function_call',
        id: 'child-bash-call',
        name: 'Bash',
        args: { command: 'npm test' },
      },
    },
    {
      ...terminalEnvelope,
      id: 'child-bash-response-event',
      role: 'tool',
      author: 'tool',
      content: {
        kind: 'function_response',
        id: 'child-bash-call',
        name: 'Bash',
        result: { stdout: '1 test failed', stderr: 'Assertion failed', exitCode: 1 },
        isError: true,
        providerOutput: { opaque: 'provider-only-output' },
      },
    },
    invocation.terminalEvent!,
  ];
  const events: AgentRunEvent[] = [
    {
      id: 'child-event',
      sessionId: invocation.sessionId,
      runId: invocation.runId,
      turnId: invocation.turnId,
      ts: 2,
      type: 'model_stream_completed',
      message:
        'Diagnostic operational message: [report](maka://runtime/attachments/child-artifact)',
    },
  ];
  return {
    ...raw,
    events: view === 'runtime_events' ? [] : events,
    runtimeEvents: view === 'events' ? [] : runtimeEvents,
    artifacts: ['child-artifact', 'diagnostic-artifact'].map((id) => ({
      id,
      sessionId: 'child',
      turnId: 'child-turn',
      createdAt: 1,
      name: `${id}.txt`,
      kind: 'file' as const,
      source: 'tool_result' as const,
      relativePath: `${id}.txt`,
      sizeBytes: 1,
    })),
    diagnostics: [
      {
        code: 'runtime_terminal_missing',
        runId: 'child-run',
        turnId: 'child-turn',
        message: 'Diagnostic warning',
      },
    ],
    budget: { ...raw.budget, view },
  };
}

for (const view of ['events', 'runtime_events', 'all'] as const) {
  test(`agent_output ${view} collects bounded diagnostic Artifacts and snapshots its text`, () => {
    const raw = diagnosticOutput(view);
    for (const input of [
      { messages: [message(output()), message(raw)], runtimeEvents: [], archivedResults: [] },
      { messages: [message(output())], runtimeEvents: [], archivedResults: [JSON.stringify(raw)] },
    ]) {
      const refs = collectConversationCopyLinkedChildReferences(input);
      assert.equal(refs.length, 2);
      assert.deepEqual(refs[1]?.artifactIds, ['child-artifact', 'diagnostic-artifact']);
      assert.equal(refs[1]?.terminalEventId, raw.invocation.terminalEvent!.id);
    }
    const external = {
      ...references(),
      linkedChildren: {
        mode: 'preserve_validated' as const,
        references: new Map([
          [
            'child',
            {
              runIds: new Set(['child-run']),
              artifactIds: new Set(['child-artifact', 'diagnostic-artifact']),
            },
          ],
        ]),
      },
    };
    assert.deepEqual(rewriteConversationCopyMessage(message(raw), external), message(raw));
    const copied = rewriteConversationCopyMessage(message(raw), {
      ...external,
      artifactIds: new Map([
        ['child-artifact', 'copied-result'],
        ['diagnostic-artifact', 'copied-diagnostic'],
      ]),
      linkedChildren: { mode: 'snapshot', archivedResults: new Map() },
    });
    assert.ok(copied.type === 'tool_result' && copied.content.kind === 'json');
    assert.ok(isConversationCopyAgentOutputSnapshot(copied.content.value));
    assert.deepEqual(copied.content.value.artifactIds, ['copied-result', 'copied-diagnostic']);
    assert.match(copied.content.value.text!, /Diagnostic warning/);
    assert.match(
      copied.content.value.text!,
      view === 'events' ? /operational message/ : /model text/,
    );
    assert.ok(!JSON.stringify(copied.content).includes('child'));
    for (const invalid of [
      { ...raw, artifacts: [{ ...raw.artifacts[0], sessionId: 'unrelated' }] },
      { ...raw, artifacts: [{ ...raw.artifacts[0], turnId: 'unrelated' }] },
      { ...raw, diagnostics: [{ ...raw.diagnostics[0], runId: 'unrelated' }] },
      {
        ...raw,
        invocation: {
          ...raw.invocation,
          terminalEvent: { ...raw.invocation.terminalEvent, runId: 'unrelated' },
        },
      },
    ]) {
      assert.deepEqual(
        collectConversationCopyLinkedChildReferences({
          messages: [message(invalid)],
          runtimeEvents: [],
          archivedResults: [],
        }),
        [],
      );
    }
  });
}

for (const view of ['runtime_events', 'all'] as const) {
  test(`Side Conversation retains ${view} tool evidence without execution identities`, () => {
    const raw = diagnosticOutput(view);
    // A bounded diagnostic read can contain only tool evidence, with no model
    // text or operational messages to stand in for the tool result.
    const toolEvents = raw.runtimeEvents.filter(
      (event) =>
        event.content?.kind === 'function_call' || event.content?.kind === 'function_response',
    );
    for (const runtimeEvents of [toolEvents, [toolEvents[1]!]]) {
      const source = message({ ...raw, runtimeEvents, events: [], diagnostics: [] });
      const copied = rewriteConversationCopyMessage(source, {
        ...references(),
        artifactIds: new Map([
          ['child-artifact', 'copied-result'],
          ['diagnostic-artifact', 'copied-diagnostic'],
        ]),
        linkedChildren: { mode: 'snapshot', archivedResults: new Map() },
      });
      assert.ok(copied.type === 'tool_result' && copied.content.kind === 'json');
      assert.ok(isConversationCopyAgentOutputSnapshot(copied.content.value));
      const text = copied.content.value.text!;
      assert.match(text, /Read/);
      assert.match(text, /Expected 12, received 34\./);
      if (runtimeEvents.length > 1) {
        assert.match(text, /maka:\/\/runtime\/attachments\/copied-result/);
        assert.match(text, /npm test/);
        assert.match(text, /Bash/);
        assert.match(text, /1 test failed/);
        assert.match(text, /Assertion failed/);
        assert.match(text, /"isError":true/);
        assert.ok(text.indexOf('npm test') < text.indexOf('Assertion failed'));
      }
      for (const excluded of ['child', 'provider-only-output', 'terminal', 'invocation']) {
        assert.ok(!JSON.stringify(copied.content).includes(excluded), excluded);
      }
    }
  });
}

function message(value: unknown = output()): Extract<StoredMessage, { type: 'tool_result' }> {
  return {
    type: 'tool_result',
    id: 'output',
    turnId: 'parent-turn',
    ts: 3,
    toolUseId: 'output-call',
    isError: false,
    content: { kind: 'json', value },
  };
}

function references(): Extract<ConversationCopyMessageReferenceMap, { mode: 'exact' }> {
  return {
    mode: 'exact',
    sourceSessionId: 'parent',
    targetSessionId: 'revision',
    artifactIds: new Map(),
    relativePaths: new Map(),
    runIds: new Map(),
    runtimeEventIds: new Map(),
    providerTraceIds: new Map(),
    linkedChildren: {
      mode: 'preserve_validated',
      references: new Map([
        ['child', { runIds: new Set(['child-run']), artifactIds: new Set(['child-artifact']) }],
      ]),
    },
  };
}

test('revision collects historical JSON agent_output references from messages, events and archives', () => {
  const msg = message();
  const event: RuntimeEvent = {
    id: 'output-event',
    sessionId: 'parent',
    runId: 'parent-run',
    invocationId: 'parent-run',
    turnId: 'parent-turn',
    ts: 3,
    partial: false,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'output-call',
      name: 'agent_output',
      result: msg.content,
    },
  };
  for (const input of [
    { messages: [msg], runtimeEvents: [], archivedResults: [] },
    { messages: [], runtimeEvents: [event], archivedResults: [] },
    { messages: [], runtimeEvents: [], archivedResults: [JSON.stringify(msg.content)] },
    { messages: [], runtimeEvents: [], archivedResults: [JSON.stringify(output())] },
  ]) {
    assert.deepEqual(collectConversationCopyLinkedChildReferences(input), [
      {
        childSessionId: 'child',
        runId: 'child-run',
        turnId: 'child-turn',
        status: 'completed',
        artifactIds: ['child-artifact'],
        terminalEventId: 'child-run-terminal',
        graph: { graphId: 'graph', workId: 'work', operatorId: 'operator' },
      },
    ]);
  }
  const archived = JSON.stringify(msg.content);
  assert.equal(archivedToolResultContainsLinkedChildReferences(archived), true);
  assert.equal(archivedToolResultContainsLinkedChildReferences(JSON.stringify(output())), true);
  assert.equal(
    archivedToolResultContainsConversationOwnedReferences(JSON.stringify(output()), 'parent'),
    true,
  );
  assert.equal(archivedToolResultContainsConversationOwnedReferences(archived, 'parent'), true);
  const refs = references();
  assert.ok(refs.mode === 'exact' && refs.linkedChildren.mode === 'preserve_validated');
  assert.equal(
    archivedToolResultContainsConversationOwnedReferences(
      archived,
      'parent',
      refs.linkedChildren.references,
    ),
    false,
  );
});

test('agent_output JSON recognition rejects malformed identities and unrelated JSON', () => {
  for (const mutate of [
    (v: ReturnType<typeof output>) => {
      v.execution.sessionId = 'other';
    },
    (v: ReturnType<typeof output>) => {
      v.execution.currentRunId = 'other';
    },
    (v: ReturnType<typeof output>) => {
      v.invocation.terminalEvent!.turnId = 'other';
    },
    (v: ReturnType<typeof output>) => {
      v.result.status = 'failed';
    },
    (v: ReturnType<typeof output>) => {
      v.result.terminalRuntimeEventId = 'other';
    },
    (v: ReturnType<typeof output>) => {
      delete v.invocation.terminalEvent;
    },
    (v: ReturnType<typeof output>) => {
      v.result.schemaVersion = 2;
    },
    (v: ReturnType<typeof output>) => {
      v.budget.view = 'all';
    },
    (v: ReturnType<typeof output>) => {
      v.result.graph.graphId = '';
    },
    (v: ReturnType<typeof output>) => {
      v.result.artifactIds = [''];
    },
  ]) {
    const value = output();
    mutate(value);
    assert.deepEqual(
      collectConversationCopyLinkedChildReferences({
        messages: [message(value)],
        runtimeEvents: [],
        archivedResults: [],
      }),
      [],
    );
  }
  const unrelated = message({ childSessionId: 'child', runId: 'child-run', result: output() });
  assert.deepEqual(
    collectConversationCopyLinkedChildReferences({
      messages: [unrelated],
      runtimeEvents: [],
      archivedResults: [],
    }),
    [],
  );
  assert.deepEqual(rewriteConversationCopyMessage(unrelated, references()), unrelated);
});

test('revision preserves the exact child output only with validated external references', () => {
  const source = message();
  assert.deepEqual(rewriteConversationCopyMessage(source, references()), source);
  for (const linkedChildren of [
    { mode: 'reject' as const },
    { mode: 'preserve_validated' as const, references: new Map() },
    {
      mode: 'preserve_validated' as const,
      references: new Map([
        ['child', { runIds: new Set(['other-run']), artifactIds: new Set(['child-artifact']) }],
      ]),
    },
    {
      mode: 'preserve_validated' as const,
      references: new Map([
        ['child', { runIds: new Set(['child-run']), artifactIds: new Set<string>() }],
      ]),
    },
  ]) {
    assert.throws(
      () =>
        rewriteConversationCopyMessage(source, {
          ...references(),
          mode: 'exact',
          artifactIds: new Map(),
          relativePaths: new Map(),
          linkedChildren,
        }),
      /linked child|external/,
    );
  }
});

test('Side Conversation keeps only the child result snapshot and copied artifacts', () => {
  const source = message();
  const result = rewriteConversationCopyMessage(source, {
    ...references(),
    mode: 'exact',
    artifactIds: new Map([['child-artifact', 'snapshot-artifact']]),
    relativePaths: new Map(),
    linkedChildren: { mode: 'snapshot', archivedResults: new Map() },
  });
  assert.equal(result.type, 'tool_result');
  if (result.type !== 'tool_result') assert.fail();
  assert.deepEqual(result.content, {
    kind: 'json',
    value: {
      kind: 'maka.agent_output_snapshot',
      schemaVersion: 1,
      status: 'completed',
      text: 'Reviewed all packages.',
      textTruncated: false,
      artifactIds: ['snapshot-artifact'],
      omittedArtifactIds: 0,
    },
  });
  assert.ok(!JSON.stringify(result.content).includes('child-run'));
  assert.deepEqual(
    collectConversationCopyLinkedChildReferences({
      messages: [result],
      runtimeEvents: [],
      archivedResults: [],
    }),
    [],
  );
});

test('agent_output snapshot attachment links follow each copy while revision references stay external', () => {
  const raw = output();
  raw.result.text =
    'Report: [download](maka://runtime/attachments/child-artifact). Unrelated: maka://runtime/attachments/unmapped-artifact';
  assert.deepEqual(rewriteConversationCopyMessage(message(raw), references()), message(raw));
  let source: StoredMessage = message(raw);
  let artifactId = 'child-artifact';
  for (const [targetId, mode] of [
    ['side-1-artifact', 'snapshot'],
    ['side-2-artifact', 'snapshot'],
    ['revision-artifact', 'reject'],
  ] as const) {
    source = rewriteConversationCopyMessage(source, {
      ...references(),
      artifactIds: new Map([[artifactId, targetId]]),
      linkedChildren: mode === 'snapshot' ? { mode, archivedResults: new Map() } : { mode },
    });
    assert.ok(source.type === 'tool_result' && source.content.kind === 'json');
    assert.ok(isConversationCopyAgentOutputSnapshot(source.content.value));
    assert.deepEqual(source.content.value.artifactIds, [targetId]);
    assert.equal(
      source.content.value.text,
      `Report: [download](maka://runtime/attachments/${targetId}). Unrelated: maka://runtime/attachments/unmapped-artifact`,
    );
    artifactId = targetId;
  }
});

test('agent_output snapshots remain copyable through messages, events and archives', () => {
  const first = rewriteConversationCopyMessage(message(), {
    ...references(),
    mode: 'exact',
    artifactIds: new Map([['child-artifact', 'side-1-artifact']]),
    linkedChildren: { mode: 'snapshot', archivedResults: new Map() },
  });
  assert.ok(first.type === 'tool_result' && first.content.kind === 'json');
  const value = first.content.value;
  assert.ok(isConversationCopyAgentOutputSnapshot(value));
  const event = {
    content: { kind: 'function_response', name: 'agent_output', result: first.content },
  } as RuntimeEvent;
  for (const input of [
    { messages: [first], runtimeEvents: [], archivedResults: [] },
    { messages: [], runtimeEvents: [event], archivedResults: [] },
    { messages: [], runtimeEvents: [], archivedResults: [JSON.stringify(first.content)] },
    { messages: [], runtimeEvents: [], archivedResults: [JSON.stringify(value)] },
  ]) {
    assert.deepEqual(
      [...collectConversationCopySessionFileRefs({ sourceSessionId: 'side-1', ...input })],
      ['side-1-artifact'],
    );
    assert.deepEqual(collectConversationCopyLinkedChildReferences(input), []);
  }
  for (const archived of [JSON.stringify(value), JSON.stringify(first.content)]) {
    assert.equal(archivedToolResultContainsConversationOwnedReferences(archived, 'side-1'), true);
    const restored = rewriteConversationCopyMessage(
      {
        ...first,
        content: {
          kind: 'archived_tool_result',
          status: 'not_loaded',
          artifactId: 'archive',
          runtimeEventId: 'event',
          toolCallId: 'call',
          toolName: 'agent_output',
          originalEstimatedTokens: 20,
          originalBytes: archived.length,
          rewriteVersion: 1,
          reason: 'stale_tool_result_pruned_before_compact',
        },
      },
      {
        ...references(),
        mode: 'exact',
        sourceSessionId: 'side-1',
        targetSessionId: 'side-2',
        artifactIds: new Map([['side-1-artifact', 'side-2-artifact']]),
        linkedChildren: { mode: 'snapshot', archivedResults: new Map([['archive', archived]]) },
      },
    );
    assert.ok(restored.type === 'tool_result');
    assert.deepEqual(restored.content, {
      kind: 'json',
      value: { ...value, artifactIds: ['side-2-artifact'] },
    });
  }
  // Untagged and malformed JSON must not acquire Session-owned reference semantics.
  const { kind: _kind, ...untagged } = value;
  for (const opaque of [
    untagged,
    { ...value, schemaVersion: 2 },
    { ...value, artifactIds: [''] },
    { ...value, execution: {} },
  ]) {
    assert.equal(isConversationCopyAgentOutputSnapshot(opaque), false);
    assert.deepEqual(
      rewriteConversationCopyMessage(message(opaque), references()),
      message(opaque),
    );
  }
  const reclaimed = rewriteConversationCopyMessage(first, {
    ...references(),
    mode: 'exact',
    linkedChildren: { mode: 'reject' },
  });
  assert.ok(reclaimed.type === 'tool_result');
  assert.deepEqual(reclaimed.content, { kind: 'json', value: { ...value, artifactIds: [] } });
});

for (const { view, archiveDepth } of [
  { view: 'result', archiveDepth: 0 },
  { view: 'result', archiveDepth: 1 },
  { view: 'result', archiveDepth: 2 },
  { view: 'result', archiveDepth: 3 },
  { view: 'events', archiveDepth: 0 },
  { view: 'runtime_events', archiveDepth: 0 },
  { view: 'all', archiveDepth: 0 },
  { view: 'all', archiveDepth: 1 },
] as const) {
  test(`successive copies retain ${view} snapshots with ${archiveDepth} legacy archives`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-output-snapshot-copy-'));
    const owner = await tryAcquireInteractiveRootOwner(
      await resolveStorageRoot({ path: root, kind: 'interactive' }),
    );
    assert.ok(owner);
    const artifacts = await openInteractiveArtifactStoreForWrite(owner.lease);
    try {
      const { agentRunStore: runStore, runtimeEventStore } =
        await openInteractiveExecutionStoresForWrite(owner.lease);
      for (const id of ['child-artifact', 'diagnostic-artifact'])
        await artifacts.create({
          id,
          sessionId: 'child',
          turnId: 'child-turn',
          name: 'result.txt',
          kind: 'file',
          content: `${id} bytes`,
          source: 'tool_result',
        });
      const parent = testInvocationRecord({
        sessionId: 'parent',
        runId: 'parent-run',
        turnId: 'parent-turn',
        outcome: 'completed',
        closedAt: 5,
      });
      const raw = view === 'result' ? output() : diagnosticOutput(view);
      if ('result' in raw) {
        // The migrated snapshot must be read through multiple public Read pages.
        raw.result.text =
          raw.result.text.repeat(1000) + ' [report](maka://runtime/attachments/child-artifact)';
      }
      const sourceEvents: RuntimeEvent[] = [
        buildInvocationOpenedEvent({
          id: 'parent-opening',
          run: parent,
          opening: parent.opening,
          openedAt: 1,
        }),
        {
          id: 'call-event',
          sessionId: 'parent',
          runId: parent.runId,
          invocationId: parent.invocationId,
          turnId: parent.turnId,
          ts: 2,
          partial: false,
          role: 'model',
          author: 'agent',
          content: { kind: 'function_call', id: 'output-call', name: 'agent_output', args: {} },
        },
        {
          id: 'output-event',
          sessionId: 'parent',
          runId: parent.runId,
          invocationId: parent.invocationId,
          turnId: parent.turnId,
          ts: 3,
          partial: false,
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'output-call',
            name: 'agent_output',
            result: message(raw).content,
            modelProjection: { version: 1, kind: 'json', value: JSON.parse(JSON.stringify(raw)) },
          },
        },
        parent.terminalEvent!,
      ];
      let sourceSessionId = 'parent';
      let messages: readonly StoredMessage[] = [message(raw)];
      const archives = new Map<string, string>();
      const archiveRecords: EmittedAgentRunEvent[] = [];
      let projection: DurableToolResultProjection = {
        version: 1,
        kind: 'json',
        value: JSON.parse(JSON.stringify(raw)),
      };
      let previousTransitionId: string | undefined;
      let legacyRef: string | undefined;
      for (let index = 0; index < archiveDepth; index++) {
        const serialized = serializeToolResultProjectionV1(projection);
        const artifactId = `legacy-archive-${index}`;
        archives.set(artifactId, serialized);
        await artifacts.create({
          id: artifactId,
          sessionId: 'parent',
          turnId: parent.turnId,
          name: `${artifactId}.json`,
          kind: 'file',
          content: serialized,
          source: 'tool_result_archive',
        });
        const placeholder = buildArchivedToolResultPlaceholder({
          artifactId,
          runtimeEventId: 'output-event',
          toolCallId: 'output-call',
          toolName: 'agent_output',
          bodySha256: createHash('sha256').update(serialized).digest('hex'),
          originalEstimatedTokens: 1000,
          originalBytes: Buffer.byteLength(serialized),
          reason: 'stale_tool_result_pruned_before_compact',
        });
        placeholder.page = readToolResultPage(serialized, { path: placeholder.resourceRef! }, 800);
        assert.ok(placeholder.page.next, 'Exercise legacy archive pagination');
        const transition = buildModelProjectionTransition({
          sessionId: 'parent',
          target: {
            runtimeEventId: 'output-event',
            part: 'tool_result',
            toolCallId: 'output-call',
            toolName: 'agent_output',
          },
          sourceProjection: projection,
          replacement: archivedToolResultProjection(placeholder),
          ...(previousTransitionId ? { previousTransitionId } : {}),
          now: 4 + index,
        });
        archiveRecords.push({
          id: transition.transitionId,
          sessionId: 'parent',
          runId: parent.runId,
          turnId: parent.turnId,
          ts: 4 + index,
          type: MODEL_PROJECTION_TRANSITION_EVENT_TYPE,
          data: { runtimeEventId: 'output-event', part: 'tool_result', transition },
        });
        previousTransitionId = transition.transitionId;
        projection = transition.replacement;
        messages = [message(placeholder)];
        legacyRef = placeholder.page.next.path;
      }
      if (legacyRef) {
        const envelope = {
          sessionId: 'parent',
          runId: parent.runId,
          invocationId: parent.invocationId,
          turnId: parent.turnId,
          partial: false,
        };
        sourceEvents.splice(
          -1,
          0,
          {
            ...envelope,
            id: 'archive-read-call',
            ts: 3.1,
            role: 'model',
            author: 'agent',
            content: {
              kind: 'function_call',
              id: 'read-archive',
              name: 'Read',
              args: { path: legacyRef },
            },
          },
          {
            ...envelope,
            id: 'archive-read-result',
            ts: 3.2,
            role: 'tool',
            author: 'tool',
            content: {
              kind: 'function_response',
              id: 'read-archive',
              name: 'Read',
              result: { kind: 'text', text: 'Archived output' },
            },
          },
        );
      }
      for (const event of sourceEvents)
        await runtimeEventStore.appendRuntimeEvent('parent', parent.runId, event);
      for (const event of archiveRecords) await runStore.appendEvent('parent', parent.runId, event);
      let previousArtifactIds = ['child-artifact', 'diagnostic-artifact'];
      for (const targetSessionId of ['side-1', 'side-2', 'revision-3']) {
        const events = (
          await Promise.all(
            (
              await runtimeEventStore.listSessionInvocations(sourceSessionId)
            ).map((run) => runtimeEventStore.readRuntimeEvents(sourceSessionId, run.runId)),
          )
        ).flat();
        const plan = await prepareConversationRuntimeLedgerCopy({
          sourceSessionId,
          sourceEvents: events,
          copiedMessages: messages,
          runStore,
          runtimeEventStore,
        });
        const artifactCopy = await artifacts.copyConversationArtifacts({
          sourceSessionId,
          targetSessionId,
          turnIds: plan.copyTurnIds,
          includeArtifactIds: [
            ...collectConversationCopySessionFileRefs({
              sourceSessionId,
              messages,
              runtimeEvents: events,
              archivedResults: sourceSessionId === 'parent' ? [...archives.values()] : [],
            }),
          ],
          ...(sourceSessionId === 'parent'
            ? {
                excludeArtifactIds: [...archives.keys()],
                linkedArtifacts: collectConversationCopyLinkedChildReferences({
                  messages: [message(raw)],
                  runtimeEvents: [],
                  archivedResults: [],
                }).map((reference) => ({
                  sessionId: reference.childSessionId,
                  artifactIds: reference.artifactIds,
                })),
              }
            : {}),
        });
        const copied = await cloneConversationRuntimeLedger({
          plan,
          copiedMessages: messages,
          runStore,
          runtimeEventStore,
          newId: randomUUID,
          referenceMap: {
            mode: 'exact',
            sourceSessionId,
            targetSessionId,
            ...artifactCopy,
            linkedChildren:
              targetSessionId === 'revision-3'
                ? { mode: 'reject' }
                : {
                    mode: 'snapshot',
                    archivedResults: sourceSessionId === 'parent' ? archives : new Map(),
                  },
          },
        });
        const copiedEvents = (
          await Promise.all(
            copied.runIdMap.map(({ targetRunId }) =>
              runtimeEventStore.readRuntimeEvents(targetSessionId, targetRunId),
            ),
          )
        ).flat();
        const responseEvent = copiedEvents.find(
          (event) =>
            event.content?.kind === 'function_response' && event.content.name === 'agent_output',
        )!;
        const response = responseEvent.content;
        assert.ok(response?.kind === 'function_response');
        const snapshot = response.result;
        assert.ok(
          snapshot &&
            typeof snapshot === 'object' &&
            'kind' in snapshot &&
            snapshot.kind === 'json' &&
            'value' in snapshot &&
            isConversationCopyAgentOutputSnapshot(snapshot.value),
        );
        const expectedArtifacts =
          view === 'result' ? ['child-artifact'] : ['child-artifact', 'diagnostic-artifact'];
        assert.equal(snapshot.value.artifactIds.length, expectedArtifacts.length);
        for (const [index, artifactId] of snapshot.value.artifactIds.entries()) {
          assert.ok(!previousArtifactIds.includes(artifactId));
          const read = await artifacts.readTextInSession(targetSessionId, artifactId);
          assert.ok(read.ok);
          assert.equal(read.text, `${expectedArtifacts[index]} bytes`);
        }
        const attachmentLinks = snapshot.value.text?.match(
          /maka:\/\/runtime\/attachments\/[A-Za-z0-9_-]+/g,
        );
        assert.ok(attachmentLinks?.length, 'Retain the attachment links in the snapshot text');
        for (const link of attachmentLinks) {
          const ref = parseAttachmentResourceRef(link);
          assert.ok(ref);
          const read = await artifacts.readTextInSession(targetSessionId, ref.artifactId);
          assert.ok(read.ok, `Copied link must resolve in ${targetSessionId}: ${link}`);
          assert.equal(read.text, 'child-artifact bytes');
        }
        if (view === 'runtime_events' || view === 'all') {
          assert.match(snapshot.value.text!, /Expected 12, received 34\./);
          assert.match(snapshot.value.text!, /npm test/);
          assert.match(snapshot.value.text!, /Assertion failed/);
          assert.ok(!snapshot.value.text!.includes('child-read-call'));
          assert.ok(!snapshot.value.text!.includes('provider-only-output'));
        }
        assert.deepEqual(response.modelProjection, {
          version: 1,
          kind: 'json',
          value: snapshot.value,
        });
        const runIds = copied.runIdMap.map(({ targetRunId }) => targetRunId);
        const records = (
          await Promise.all(runIds.map((runId) => runStore.readEvents(targetSessionId, runId)))
        ).flat();
        const transitions = await loadModelProjectionTransitionsFromRunLedger(
          runStore,
          targetSessionId,
          runIds,
        );
        const reduction = reduceEffectiveModelProjections(copiedEvents, transitions.transitions);
        assert.equal(reduction.applied.length, Math.min(archiveDepth, 1));
        assert.equal(reduction.rejected.length, 0);
        let expectedProjection: DurableToolResultProjection = response.modelProjection!;
        for (const transition of reduction.applied) {
          assert.ok(transition.replacement.kind === 'json');
          const placeholder: unknown = transition.replacement.value;
          assert.ok(
            isArchivedToolResultPlaceholder(placeholder) && placeholder.rewriteVersion === 2,
          );
          const reader = createLedgerArchiveResourceReader({
            read: async () => ({
              ok: true,
              event: responseEvent,
              transitions: records.filter(
                (record) =>
                  record.type === MODEL_PROJECTION_TRANSITION_EVENT_TYPE &&
                  record.data?.runtimeEventId === responseEvent.id,
              ),
            }),
          });
          const archived = await reader({
            ...placeholder,
            sessionId: targetSessionId,
            maxBytes: 1024 * 1024,
          });
          assert.ok(archived.ok, JSON.stringify({ archived, targetSessionId }));
          assert.equal(
            archived.serializedResult,
            serializeToolResultProjectionV1(expectedProjection),
          );
          assert.ok(!archived.serializedResult.includes('child-run'));
          assert.ok(!JSON.stringify(placeholder.page).includes('child-run'));
          const read = async (input: ReadInput) =>
            readPageSchema.parse(
              await readToolResultArchiveResource(
                { readArchivedToolResultResource: reader },
                targetSessionId,
                input,
              ),
            );
          const expectedBody = serializeToolResultProjectionV1(response.modelProjection!);
          assert.ok(placeholder.resourceRef);
          assert.ok(placeholder.page);
          if (view === 'result') assert.ok(placeholder.page.next, 'Exercise snapshot pagination');
          // Follow both the public address and the embedded page's continuation;
          // an exact internal ledger identity would hide an address self-loop.
          for (const firstPage of [
            await read({ path: placeholder.resourceRef }),
            placeholder.page,
          ]) {
            let page = firstPage;
            let body = page.content;
            const seen = new Set<string>();
            while (page.next) {
              assert.ok(!seen.has(page.next.path), 'Read continuation must make progress');
              seen.add(page.next.path);
              page = await read(page.next);
              body += page.content;
            }
            assert.equal(body, expectedBody);
          }
          expectedProjection = transition.replacement;
        }
        if (archiveDepth > 0) {
          assert.deepEqual(
            copied.copiedMessages[0]?.type === 'tool_result'
              ? copied.copiedMessages[0].content
              : undefined,
            {
              kind: 'json',
              value: expectedProjection.kind === 'json' ? expectedProjection.value : undefined,
            },
          );
          const readCall = copiedEvents.find(
            (event) => event.content?.kind === 'function_call' && event.content.name === 'Read',
          );
          assert.ok(readCall?.content?.kind === 'function_call');
          assert.deepEqual(readCall.content.args, {
            path: `maka://runtime/tool-results/${responseEvent.id}`,
          });
          assert.equal(
            (await artifacts.getInSession(targetSessionId, 'legacy-archive-0'))?.record ?? null,
            null,
          );
        } else {
          assert.deepEqual(
            copied.copiedMessages[0]?.type === 'tool_result'
              ? copied.copiedMessages[0].content
              : undefined,
            snapshot,
          );
        }
        previousArtifactIds = [...snapshot.value.artifactIds];
        messages = copied.copiedMessages;
        sourceSessionId = targetSessionId;
      }
    } finally {
      artifacts.close();
      await owner.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
