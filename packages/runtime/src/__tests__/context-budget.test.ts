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
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  applyRuntimeEventContextBudget,
  buildHistoryCompactBlockFromSummary,
  collectStaleToolResultArchiveCandidates,
  buildSynthesisCacheBlocksFromHydratedArchives,
  deserializeToolResultArchive,
  renderHistoryCompactBlock,
  retrieveArchivedToolResultsForReplay,
  retrieveRuntimeEventHistoryAround,
  serializeToolResultForArchive,
  validateHistoryCompactBlockShape,
  validateSynthesisCacheBlockShape,
  type SynthesisCacheBlock,
} from '../context-budget.js';
import { applyRuntimeEventHistoryCompact } from '../history-compact.js';
import { renderSynthesisCacheBlock, selectSynthesisCacheForReplay } from '../synthesis-cache.js';
import { historyCompactBlockToCompactionBoundary } from '../compaction-boundary.js';
import {
  estimateRuntimeEventChars,
  estimateRuntimeEventsTokens,
} from '../context-budget-helpers.js';

test('estimates only model-visible provider context', () => {
  const visible = textEvent('visible-user', 'turn-1', 'visible context');
  const hiddenCall = {
    ...toolCall('hidden-call', 'turn-1', 'nested-call'),
    origin: 'code_mode' as const,
    modelVisibility: 'hidden' as const,
  };
  const hiddenResult = {
    ...toolResult('hidden-result', 'turn-1', 'nested-call', {
      text: 'nested result must not consume provider context',
    }),
    origin: 'code_mode' as const,
    modelVisibility: 'hidden' as const,
  };

  assert.equal(
    estimateRuntimeEventsTokens([visible, hiddenCall, hiddenResult], 1),
    estimateRuntimeEventsTokens([visible], 1),
  );
});

describe('context-budget archive retrieval', () => {
  test('does not archive hidden nested tool results', () => {
    const hiddenResult = toolResult('hidden-result', 'turn-old', 'hidden-tool', {
      text: 'DO_NOT_ARCHIVE_NESTED_RESULT'.repeat(20),
    });
    hiddenResult.modelVisibility = 'hidden';
    const visibleResult = toolResult('visible-result', 'turn-old', 'visible-tool', {
      text: 'archive this result'.repeat(20),
    });

    const candidates = collectStaleToolResultArchiveCandidates([hiddenResult, visibleResult], {
      staleToolResultPrune: {
        enabled: true,
        maxResultEstimatedTokens: 1,
        minRecentTurnsFull: 0,
      },
      charsPerToken: 1,
      minRecentTurns: 0,
    });

    assert.deepEqual(
      candidates.map((candidate) => candidate.runtimeEventId),
      ['visible-result'],
    );
  });

  test('counts provider-native replay payloads and never archives only their display projection', () => {
    const rawProviderOutput = [{ encryptedContent: 'x'.repeat(10_000) }];
    const event = {
      ...toolResult('result-native', 'turn-native', 'search-native', {
        kind: 'web_search',
        provider: 'model',
        query: 'latest',
        rows: [],
      }),
      content: {
        kind: 'function_response' as const,
        id: 'search-native',
        name: 'WebSearch',
        result: { kind: 'web_search', provider: 'model', query: 'latest', rows: [] },
        providerExecuted: true,
        providerOutput: rawProviderOutput,
      },
    };

    assert.ok(estimateRuntimeEventChars(event) >= 10_000);
    const budgeted = applyRuntimeEventContextBudget([event], {
      staleToolResultPrune: {
        enabled: true,
        maxResultEstimatedTokens: 1,
        minRecentTurnsFull: 0,
        archiveRefs: [],
      },
      charsPerToken: 1,
    });
    assert.ok(budgeted);
    assert.equal(budgeted.diagnostic.prunedToolResults ?? 0, 0);
    assert.deepEqual(budgeted.events[0], event);
  });

  test('prunes the newest turn when the full-result protection window is zero', () => {
    const sentinel = 'newest-turn-full-result-must-not-be-reinjected';
    const originalResult = { kind: 'text', text: sentinel.repeat(4) };
    const serialized = serializeToolResultForArchive(originalResult);
    const events = [
      toolCall('call-newest', 'turn-newest', 'tool-newest'),
      toolResult('result-newest', 'turn-newest', 'tool-newest', originalResult),
    ];

    const budgeted = applyRuntimeEventContextBudget(events, {
      staleToolResultPrune: {
        enabled: true,
        maxResultEstimatedTokens: 1,
        minRecentTurnsFull: 0,
        archiveRefs: [
          {
            runtimeEventId: 'result-newest',
            toolCallId: 'tool-newest',
            toolName: 'Read',
            artifactId: 'artifact-newest',
            bodySha256: sha256(serialized),
            originalEstimatedTokens: serialized.length,
            originalBytes: utf8Bytes(serialized),
            rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
            reason: 'stale_tool_result_pruned_before_compact',
          },
        ],
      },
      charsPerToken: 1,
    });

    assert.ok(budgeted);
    assert.equal(budgeted.diagnostic.prunedToolResults, 1);
    const result = budgeted.events.find((event) => event.id === 'result-newest');
    assert.equal(
      result?.content?.kind === 'function_response'
        ? (result.content.result as { kind?: string }).kind
        : undefined,
      ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
    );
    assert.equal(JSON.stringify(budgeted.events).includes(sentinel), false);
  });

  test('deserializes JSON, undefined, and fallback strings', () => {
    assert.deepEqual(deserializeToolResultArchive('{"kind":"text","text":"ok"}'), {
      kind: 'text',
      text: 'ok',
    });
    assert.equal(deserializeToolResultArchive('undefined'), undefined);
    assert.equal(deserializeToolResultArchive('plain fallback'), 'plain fallback');
  });

  test('hydrates archived placeholders for replay only after hash validation', async () => {
    const originalResult = { kind: 'text', text: 'old archived payload' };
    const serialized = serializeToolResultForArchive(originalResult);
    const events = [
      toolCall('call-old', 'turn-old', 'tool-old'),
      toolResult('result-old', 'turn-old', 'tool-old', originalResult),
      toolCall('call-new', 'turn-new', 'tool-new'),
      toolResult('result-new', 'turn-new', 'tool-new', { kind: 'text', text: 'new full payload' }),
    ];
    const budgeted = applyRuntimeEventContextBudget(events, {
      staleToolResultPrune: {
        enabled: true,
        maxResultEstimatedTokens: 1,
        minRecentTurnsFull: 1,
        archiveRefs: [
          {
            runtimeEventId: 'result-old',
            toolCallId: 'tool-old',
            toolName: 'Read',
            artifactId: 'artifact-old',
            bodySha256: sha256(serialized),
            originalEstimatedTokens: serialized.length,
            originalBytes: utf8Bytes(serialized),
            rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
            reason: 'stale_tool_result_pruned_before_compact',
          },
        ],
      },
      archiveRetrieval: { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      minRecentTurns: 2,
      charsPerToken: 1,
    });

    assert.ok(budgeted);
    const retrieval = await retrieveArchivedToolResultsForReplay(
      budgeted.events,
      { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      async () => ({ ok: true, serializedResult: serialized }),
      { sessionId: 'session-1', charsPerToken: 1 },
    );

    const originalBudgeted = budgeted.events.find((event) => event.id === 'result-old');
    assert.equal(
      originalBudgeted?.content?.kind === 'function_response'
        ? (originalBudgeted.content.result as { kind?: string }).kind
        : undefined,
      ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
    );
    const hydrated = retrieval.events.find((event) => event.id === 'result-old');
    assert.deepEqual(
      hydrated?.content?.kind === 'function_response' ? hydrated.content.result : undefined,
      originalResult,
    );
    assert.equal(retrieval.diagnosticPatch.retrievedArchiveToolResults, 1);
    assert.equal(retrieval.diagnosticPatch.retrievedArchiveEstimatedTokens, serialized.length);
    assert.deepEqual(retrieval.retrievedSourceRefs, [
      {
        kind: 'archived_tool_result',
        sessionId: 'session-1',
        turnId: 'turn-old',
        runtimeEventId: 'result-old',
        toolCallId: 'tool-old',
        toolName: 'Read',
        artifactId: 'artifact-old',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
        placeholderReason: 'stale_tool_result_pruned_before_compact',
      },
    ]);
  });

  test('uses UTF-8 byte length for non-ASCII archive size validation', async () => {
    const originalResult = { kind: 'text', text: '旧归档 payload 🙂'.repeat(3) };
    const serialized = serializeToolResultForArchive(originalResult);
    assert.ok(utf8Bytes(serialized) > serialized.length);
    const events = [
      toolCall('call-old', 'turn-old', 'tool-old'),
      toolResult('result-old', 'turn-old', 'tool-old', originalResult),
      toolCall('call-new', 'turn-new', 'tool-new'),
      toolResult('result-new', 'turn-new', 'tool-new', { kind: 'text', text: 'new full payload' }),
    ];
    const budgeted = applyRuntimeEventContextBudget(events, {
      staleToolResultPrune: {
        enabled: true,
        maxResultEstimatedTokens: 1,
        minRecentTurnsFull: 1,
        archiveRefs: [
          {
            runtimeEventId: 'result-old',
            toolCallId: 'tool-old',
            toolName: 'Read',
            artifactId: 'artifact-old',
            bodySha256: sha256(serialized),
            originalEstimatedTokens: serialized.length,
            originalBytes: utf8Bytes(serialized),
            rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
            reason: 'stale_tool_result_pruned_before_compact',
          },
        ],
      },
      archiveRetrieval: { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      minRecentTurns: 1,
      charsPerToken: 1,
    });

    assert.ok(budgeted);
    assert.equal(budgeted.diagnostic.prunedToolResults, 1);
    const retrieval = await retrieveArchivedToolResultsForReplay(
      budgeted.events,
      { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      async (input) =>
        input.originalBytes === utf8Bytes(serialized)
          ? { ok: true, serializedResult: serialized }
          : { ok: false, reason: 'size_mismatch' },
      { sessionId: 'session-1', charsPerToken: 1 },
    );

    const hydrated = retrieval.events.find((event) => event.id === 'result-old');
    assert.deepEqual(
      hydrated?.content?.kind === 'function_response' ? hydrated.content.result : undefined,
      originalResult,
    );
    assert.equal(retrieval.diagnosticPatch.retrievedArchiveToolResults, 1);
    assert.equal(retrieval.diagnosticPatch.archiveRetrievalFailures, 0);
  });

  test('rejects archive refs whose body hash does not match the current result', () => {
    const currentResult = { kind: 'text', text: 'alpha payload sentinel' };
    const staleResult = { kind: 'text', text: 'bravo payload sentinel' };
    const currentSerialized = serializeToolResultForArchive(currentResult);
    const staleSerialized = serializeToolResultForArchive(staleResult);
    assert.equal(currentSerialized.length, staleSerialized.length);
    assert.equal(utf8Bytes(currentSerialized), utf8Bytes(staleSerialized));
    const events = [
      toolCall('call-old', 'turn-old', 'tool-old'),
      toolResult('result-old', 'turn-old', 'tool-old', currentResult),
      toolCall('call-new', 'turn-new', 'tool-new'),
      toolResult('result-new', 'turn-new', 'tool-new', { kind: 'text', text: 'new full payload' }),
    ];

    const budgeted = applyRuntimeEventContextBudget(events, {
      staleToolResultPrune: {
        enabled: true,
        maxResultEstimatedTokens: 1,
        minRecentTurnsFull: 1,
        archiveRefs: [
          {
            runtimeEventId: 'result-old',
            toolCallId: 'tool-old',
            toolName: 'Read',
            artifactId: 'artifact-stale',
            bodySha256: sha256(staleSerialized),
            originalEstimatedTokens: currentSerialized.length,
            originalBytes: utf8Bytes(currentSerialized),
            rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
            reason: 'stale_tool_result_pruned_before_compact',
          },
        ],
      },
      minRecentTurns: 1,
      charsPerToken: 1,
    });

    assert.ok(budgeted);
    assert.equal(budgeted.diagnostic.prunedToolResults ?? 0, 0);
    assert.equal(budgeted.diagnostic.archiveWriteFailures, 1);
    const result = budgeted.events.find((event) => event.id === 'result-old');
    assert.deepEqual(
      result?.content?.kind === 'function_response' ? result.content.result : undefined,
      currentResult,
    );
  });

  test('keeps placeholders and records corrupt/missing archive diagnostics', async () => {
    const serialized = serializeToolResultForArchive({ kind: 'text', text: 'body' });
    const events = [
      toolCall('call-1', 'turn-1', 'tool-1'),
      archivedResult('result-1', 'turn-1', 'tool-1', {
        artifactId: 'artifact-1',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
    ];

    const corrupt = await retrieveArchivedToolResultsForReplay(
      events,
      { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      async () => ({ ok: true, serializedResult: 'tampered' }),
      { sessionId: 'session-1' },
    );
    assert.equal(corrupt.diagnosticPatch.archiveRetrievalFailures, 1);
    assert.deepEqual(corrupt.diagnosticPatch.archiveRetrievalFailureReasonCounts, { corrupt: 1 });
    assert.equal(
      corrupt.events[1]?.content?.kind === 'function_response'
        ? (corrupt.events[1].content.result as { kind?: string }).kind
        : undefined,
      ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
    );

    const missing = await retrieveArchivedToolResultsForReplay(
      events,
      { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      async () => ({ ok: false, reason: 'not_found' }),
      { sessionId: 'session-1' },
    );
    assert.deepEqual(missing.diagnosticPatch.archiveRetrievalFailureReasonCounts, { not_found: 1 });
  });

  test('fails open when retrieval is disabled or no reader is available', async () => {
    const serialized = serializeToolResultForArchive({ kind: 'text', text: 'body' });
    const events = [
      archivedResult('result-1', 'turn-1', 'tool-1', {
        artifactId: 'artifact-1',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
    ];

    const disabled = await retrieveArchivedToolResultsForReplay(
      events,
      { enabled: false, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      async () => ({ ok: true, serializedResult: serialized }),
      { sessionId: 'session-1' },
    );
    assert.notEqual(disabled.events, events);
    assert.deepEqual(disabled.events, events);
    assert.deepEqual(disabled.diagnosticPatch, {});

    const noReader = await retrieveArchivedToolResultsForReplay(
      events,
      { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      undefined,
      { sessionId: 'session-1' },
    );
    assert.deepEqual(noReader.events, events);
    assert.deepEqual(noReader.diagnosticPatch, {});
  });

  test('skips oversized candidates before reading archives', async () => {
    const small = serializeToolResultForArchive({ kind: 'text', text: 'small' });
    const big = serializeToolResultForArchive({ kind: 'text', text: 'big' });
    const events = [
      archivedResult('result-big', 'turn-1', 'tool-big', {
        artifactId: 'artifact-big',
        bodySha256: sha256(big),
        originalEstimatedTokens: 500,
        originalBytes: 5000,
      }),
      archivedResult('result-small', 'turn-2', 'tool-small', {
        artifactId: 'artifact-small',
        bodySha256: sha256(small),
        originalEstimatedTokens: small.length,
        originalBytes: utf8Bytes(small),
      }),
    ];
    const readIds: string[] = [];

    const result = await retrieveArchivedToolResultsForReplay(
      events,
      { enabled: true, maxResults: 2, maxEstimatedTokens: 100, maxBytes: 100 },
      async (input) => {
        readIds.push(input.runtimeEventId);
        return { ok: true, serializedResult: small };
      },
      { sessionId: 'session-1' },
    );

    assert.deepEqual(readIds, ['result-small']);
    assert.equal(result.diagnosticPatch.retrievedArchiveToolResults, 1);
    assert.equal(result.diagnosticPatch.archiveRetrievalSkipped, 1);
    assert.deepEqual(result.diagnosticPatch.archiveRetrievalSkippedReasonCounts, { max_bytes: 1 });
  });

  test('selects newest placeholders first and obeys max result bounds', async () => {
    const first = serializeToolResultForArchive({ kind: 'text', text: 'first' });
    const second = serializeToolResultForArchive({ kind: 'text', text: 'second' });
    const events = [
      toolCall('call-1', 'turn-1', 'tool-1'),
      archivedResult('result-1', 'turn-1', 'tool-1', {
        artifactId: 'artifact-1',
        bodySha256: sha256(first),
        originalEstimatedTokens: first.length,
        originalBytes: utf8Bytes(first),
      }),
      toolCall('call-2', 'turn-2', 'tool-2'),
      archivedResult('result-2', 'turn-2', 'tool-2', {
        artifactId: 'artifact-2',
        bodySha256: sha256(second),
        originalEstimatedTokens: second.length,
        originalBytes: utf8Bytes(second),
      }),
    ];
    const seen: string[] = [];

    const retrieved = await retrieveArchivedToolResultsForReplay(
      events,
      { enabled: true, maxResults: 1, maxEstimatedTokens: 1024, maxBytes: 1024 },
      async (input) => {
        seen.push(input.runtimeEventId);
        return { ok: true, serializedResult: input.runtimeEventId === 'result-2' ? second : first };
      },
      { sessionId: 'session-1' },
    );

    assert.deepEqual(seen, ['result-2']);
    assert.equal(retrieved.diagnosticPatch.retrievedArchiveToolResults, 1);
    assert.deepEqual(
      retrieved.events[3]?.content?.kind === 'function_response'
        ? retrieved.events[3].content.result
        : undefined,
      { kind: 'text', text: 'second' },
    );
  });

  test('gates archive reads to history-selected turns when requested', async () => {
    const selected = serializeToolResultForArchive({ kind: 'text', text: 'selected' });
    const unselected = serializeToolResultForArchive({ kind: 'text', text: 'unselected' });
    const events = [
      archivedResult('result-selected', 'turn-selected', 'tool-selected', {
        artifactId: 'artifact-selected',
        bodySha256: sha256(selected),
        originalEstimatedTokens: selected.length,
        originalBytes: utf8Bytes(selected),
      }),
      archivedResult('result-unselected', 'turn-unselected', 'tool-unselected', {
        artifactId: 'artifact-unselected',
        bodySha256: sha256(unselected),
        originalEstimatedTokens: unselected.length,
        originalBytes: utf8Bytes(unselected),
      }),
    ];
    const reads: string[] = [];

    const retrieved = await retrieveArchivedToolResultsForReplay(
      events,
      {
        enabled: true,
        mode: 'history_search_gated',
        maxResults: 2,
        maxEstimatedTokens: 1024,
        maxBytes: 1024,
      },
      async (input) => {
        reads.push(input.runtimeEventId);
        return {
          ok: true,
          serializedResult: input.runtimeEventId === 'result-selected' ? selected : unselected,
        };
      },
      { sessionId: 'session-1', allowedTurnIds: new Set(['turn-selected']) },
    );

    assert.deepEqual(reads, ['result-selected']);
    assert.equal(retrieved.diagnosticPatch.archiveRetrievalMode, 'history_search_gated');
    assert.equal(retrieved.diagnosticPatch.archiveRetrievalEligibleTurns, 1);
    assert.equal(retrieved.diagnosticPatch.retrievedArchiveToolResults, 1);
    assert.equal(retrieved.diagnosticPatch.archiveRetrievalSkipped, 1);
    assert.deepEqual(retrieved.diagnosticPatch.archiveRetrievalSkippedReasonCounts, {
      history_search_gate: 1,
    });
    assert.deepEqual(
      retrieved.events[0]?.content?.kind === 'function_response'
        ? retrieved.events[0].content.result
        : undefined,
      { kind: 'text', text: 'selected' },
    );
    assert.equal(
      retrieved.events[1]?.content?.kind === 'function_response'
        ? (retrieved.events[1].content.result as { kind?: string }).kind
        : undefined,
      ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
    );
  });
});

describe('context-budget synthesis cache', () => {
  test('selects a source-bearing synthesis block and injects it for replay only', () => {
    const serialized = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const events = [
      toolCall('call-alpha', 'turn-alpha', 'tool-alpha'),
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
      textEvent('recent', 'turn-recent', 'newer retained context'),
    ];
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });

    const result = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha',
      { enabled: true, blocks: [block] },
      { sessionId: 'session-1', charsPerToken: 1 },
    );

    assert.equal(result.selectedBlocks.length, 1);
    assert.equal(result.diagnosticPatch.synthesisCacheMode, 'lookup');
    assert.deepEqual(result.diagnosticPatch.synthesisCacheBlockIds, ['synth-key-alpha']);
    assert.equal(result.diagnosticPatch.highWaterName, 'after-gated-key-alpha');
    assert.equal(
      events.some((event) => event.id === 'result-alpha'),
      true,
    );
    assert.equal(
      result.events.some((event) => event.id === 'result-alpha'),
      false,
    );
    assert.equal(
      result.events.some((event) => event.id === 'recent'),
      true,
    );
    const synthetic = result.events.find((event) => event.id === 'synthesis-cache:synth-key-alpha');
    assert.equal(synthetic?.role, 'model');
    assert.match(
      synthetic?.content?.kind === 'text' ? synthetic.content.text : '',
      /<maka_synthesis_cache_block/,
    );
    assert.match(renderSynthesisCacheBlock(block), /artifact-alpha/);
  });

  test('retains same-turn events not covered by a selected synthesis block', () => {
    const serialized = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const events = [
      textEvent('prompt-alpha', 'turn-alpha', 'please inspect key-alpha'),
      toolCall('call-alpha', 'turn-alpha', 'tool-alpha'),
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
      toolCall('call-beta', 'turn-alpha', 'tool-beta'),
      toolResult('result-beta', 'turn-alpha', 'tool-beta', { text: 'unrelated same-turn payload' }),
      textEvent('recent', 'turn-recent', 'newer retained context'),
    ];
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });

    const result = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha',
      { enabled: true, blocks: [block] },
      { sessionId: 'session-1', charsPerToken: 1 },
    );

    assert.deepEqual(
      result.events.map((event) => event.id),
      ['prompt-alpha', 'synthesis-cache:synth-key-alpha', 'call-beta', 'result-beta', 'recent'],
    );
  });

  test('inserts a selected synthesis block at the covered event position', () => {
    const serialized = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const events = [
      textEvent('before', 'turn-before', 'older retained context'),
      toolCall('call-alpha', 'turn-alpha', 'tool-alpha'),
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
      textEvent('after', 'turn-after', 'newer retained context'),
    ];
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });

    const result = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha',
      { enabled: true, blocks: [block] },
      { sessionId: 'session-1', charsPerToken: 1 },
    );

    assert.deepEqual(
      result.events.map((event) => event.id),
      ['before', 'synthesis-cache:synth-key-alpha', 'after'],
    );
  });

  test('inserts multiple selected synthesis blocks at their covered event positions', () => {
    const alpha = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const beta = serializeToolResultForArchive({ text: 'raw archived key-beta payload' });
    const events = [
      textEvent('before', 'turn-before', 'older retained context'),
      toolCall('call-alpha', 'turn-alpha', 'tool-alpha'),
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(alpha),
        originalEstimatedTokens: alpha.length,
        originalBytes: utf8Bytes(alpha),
      }),
      textEvent('middle', 'turn-middle', 'retained middle context'),
      toolCall('call-beta', 'turn-beta', 'tool-beta'),
      archivedResult('result-beta', 'turn-beta', 'tool-beta', {
        artifactId: 'artifact-beta',
        bodySha256: sha256(beta),
        originalEstimatedTokens: beta.length,
        originalBytes: utf8Bytes(beta),
      }),
      textEvent('after', 'turn-after', 'newer retained context'),
    ];
    const alphaBlock = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: sha256(alpha),
      originalEstimatedTokens: alpha.length,
      originalBytes: utf8Bytes(alpha),
    });
    const betaBlock = synthesisBlock({
      queryKey: 'key-beta',
      turnId: 'turn-beta',
      runtimeEventId: 'result-beta',
      toolCallId: 'tool-beta',
      artifactId: 'artifact-beta',
      bodySha256: sha256(beta),
      originalEstimatedTokens: beta.length,
      originalBytes: utf8Bytes(beta),
    });

    const result = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha and key-beta',
      { enabled: true, blocks: [alphaBlock, betaBlock], maxBlocks: 2 },
      { sessionId: 'session-1', charsPerToken: 1 },
    );

    assert.deepEqual(
      result.events.map((event) => event.id),
      [
        'before',
        'synthesis-cache:synth-key-alpha',
        'middle',
        'synthesis-cache:synth-key-beta',
        'after',
      ],
    );
  });

  test('does not select synthesis when raw evidence is requested', () => {
    const serialized = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const events = [
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
    ];
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });

    const result = selectSynthesisCacheForReplay(
      events,
      'Show raw archive evidence for key-alpha',
      { enabled: true, blocks: [block] },
      { sessionId: 'session-1' },
    );

    assert.equal(result.selectedBlocks.length, 0);
    assert.equal(result.diagnosticPatch.synthesisCacheMode, 'fallback_archive_retrieval');
    assert.deepEqual(result.diagnosticPatch.synthesisCacheSkippedReasonCounts, {
      raw_evidence_requested: 1,
    });
    assert.deepEqual(result.events, events);
  });

  test('does not select synthesis for a longer uncovered key that shares a prefix', () => {
    const serialized = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const events = [
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
    ];
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });

    const result = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha-noise-01',
      { enabled: true, blocks: [block] },
      { sessionId: 'session-1' },
    );

    assert.equal(result.selectedBlocks.length, 0);
    assert.deepEqual(result.diagnosticPatch.synthesisCacheSkippedReasonCounts, {
      coverage_miss: 1,
    });
  });

  test('does not append synthesis when a source event is missing', () => {
    const serialized = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const events = [textEvent('recent', 'turn-recent', 'newer retained context')];
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });

    const result = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha',
      { enabled: true, blocks: [block] },
      { sessionId: 'session-1' },
    );

    assert.equal(result.selectedBlocks.length, 0);
    assert.deepEqual(
      result.events.map((event) => event.id),
      ['recent'],
    );
    assert.deepEqual(result.diagnosticPatch.synthesisCacheInvalidationReasonCounts, {
      source_missing: 1,
    });
  });

  test('invalidates synthesis when source placeholder hashes do not match', () => {
    const serialized = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const events = [
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
    ];
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: 'sha256:mismatch',
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });

    const result = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha',
      { enabled: true, blocks: [block] },
      { sessionId: 'session-1' },
    );

    assert.equal(result.selectedBlocks.length, 0);
    assert.deepEqual(result.diagnosticPatch.synthesisCacheInvalidationReasonCounts, {
      source_hash_mismatch: 1,
    });
  });

  test('invalidates synthesis when a newer matching tool result exists', () => {
    const serialized = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const events = [
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
      {
        ...archivedResult('result-newer', 'turn-newer', 'tool-newer', {
          artifactId: 'artifact-newer',
          bodySha256: sha256(serialized),
          originalEstimatedTokens: serialized.length,
          originalBytes: utf8Bytes(serialized),
        }),
        ts: 1_800_000_000_010,
        content: {
          kind: 'function_response' as const,
          id: 'tool-newer',
          name: 'Read',
          result: { text: 'new key-alpha payload' },
          isError: false,
        },
      },
    ];
    const block = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });

    const result = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha',
      { enabled: true, blocks: [block] },
      { sessionId: 'session-1' },
    );

    assert.equal(result.selectedBlocks.length, 0);
    assert.deepEqual(result.diagnosticPatch.synthesisCacheInvalidationReasonCounts, {
      new_relevant_tool_result: 1,
    });
  });

  test('enforces synthesis block count and token budgets', () => {
    const serialized = serializeToolResultForArchive({ text: 'raw archived key-alpha payload' });
    const events = [
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
      archivedResult('result-beta', 'turn-beta', 'tool-beta', {
        artifactId: 'artifact-beta',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
    ];
    const first = synthesisBlock({
      queryKey: 'key-alpha',
      turnId: 'turn-alpha',
      runtimeEventId: 'result-alpha',
      toolCallId: 'tool-alpha',
      artifactId: 'artifact-alpha',
      bodySha256: sha256(serialized),
      originalEstimatedTokens: serialized.length,
      originalBytes: utf8Bytes(serialized),
    });
    const second = {
      ...synthesisBlock({
        queryKey: 'key-alpha',
        turnId: 'turn-beta',
        runtimeEventId: 'result-beta',
        toolCallId: 'tool-beta',
        artifactId: 'artifact-beta',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
      blockId: 'synth-key-alpha-second',
    };

    const maxBlocks = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha',
      { enabled: true, blocks: [first, second], maxBlocks: 1, maxEstimatedTokens: 10_000 },
      { sessionId: 'session-1' },
    );
    assert.equal(maxBlocks.selectedBlocks.length, 1);
    assert.deepEqual(maxBlocks.diagnosticPatch.synthesisCacheSkippedReasonCounts, {
      max_blocks: 1,
    });

    const maxBlockTokens = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha',
      { enabled: true, blocks: [{ ...first, estimatedTokens: 99 }], maxBlockEstimatedTokens: 10 },
      { sessionId: 'session-1' },
    );
    assert.equal(maxBlockTokens.selectedBlocks.length, 0);
    assert.deepEqual(maxBlockTokens.diagnosticPatch.synthesisCacheSkippedReasonCounts, {
      max_block_tokens: 1,
    });

    const maxTotalTokens = selectSynthesisCacheForReplay(
      events,
      'Recover key-alpha',
      {
        enabled: true,
        blocks: [
          { ...first, estimatedTokens: 7 },
          { ...second, estimatedTokens: 7 },
        ],
        maxBlocks: 2,
        maxEstimatedTokens: 10,
      },
      { sessionId: 'session-1' },
    );
    assert.equal(maxTotalTokens.selectedBlocks.length, 1);
    assert.deepEqual(maxTotalTokens.diagnosticPatch.synthesisCacheSkippedReasonCounts, {
      max_total_tokens: 1,
    });
  });

  test('builds stable bounded synthesis blocks from hydrated archive refs', () => {
    const resultBody = { text: 'key-alpha stable sentinel SYNTHESIS_BUILDER_SENTINEL' };
    const serialized = serializeToolResultForArchive(resultBody);
    const placeholderEvents = [
      archivedResult('result-alpha', 'turn-alpha', 'tool-alpha', {
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
      }),
    ];
    const hydratedEvents = [
      {
        ...placeholderEvents[0]!,
        content: {
          kind: 'function_response' as const,
          id: 'tool-alpha',
          name: 'Read',
          result: resultBody,
        },
      },
    ];
    const sourceRefs = [
      {
        kind: 'archived_tool_result' as const,
        sessionId: 'session-1',
        turnId: 'turn-alpha',
        runtimeEventId: 'result-alpha',
        toolCallId: 'tool-alpha',
        toolName: 'Read',
        artifactId: 'artifact-alpha',
        bodySha256: sha256(serialized),
        originalEstimatedTokens: serialized.length,
        originalBytes: utf8Bytes(serialized),
        placeholderReason: 'stale_tool_result_pruned_before_compact' as const,
      },
    ];

    const first = buildSynthesisCacheBlocksFromHydratedArchives({
      sessionId: 'session-1',
      query: 'Recover key-alpha',
      hydratedRuntimeEvents: hydratedEvents,
      retrievedArchiveRefs: sourceRefs,
      archiveRetrievalMode: 'history_search_gated',
      limits: {
        maxBlocks: 1,
        maxBlockEstimatedTokens: 1024,
        maxEstimatedTokens: 1024,
        charsPerToken: 4,
      },
      now: 1_800_000_000_100,
    });
    const second = buildSynthesisCacheBlocksFromHydratedArchives({
      sessionId: 'session-1',
      query: 'Recover key-alpha',
      hydratedRuntimeEvents: hydratedEvents,
      retrievedArchiveRefs: sourceRefs,
      archiveRetrievalMode: 'history_search_gated',
      limits: {
        maxBlocks: 1,
        maxBlockEstimatedTokens: 1024,
        maxEstimatedTokens: 1024,
        charsPerToken: 4,
      },
      now: 1_800_000_000_100,
    });

    assert.equal(first.blocks.length, 1);
    assert.equal(first.blocks[0]?.blockId, second.blocks[0]?.blockId);
    assert.equal(first.blocks[0]?.createdFrom, 'gated_archive_retrieval');
    assert.deepEqual(first.blocks[0]?.coverage.artifactIds, ['artifact-alpha']);
    assert.equal(first.blocks[0]?.coverage.queryKeys.includes('key-alpha'), true);
    for (const genericKey of ['context', 'for', 'json', 'kind', 'lookup', 'the', 'tools']) {
      assert.equal(first.blocks[0]?.coverage.queryKeys.includes(genericKey), false, genericKey);
    }
    assert.match(first.blocks[0]?.summary ?? '', /SYNTHESIS_BUILDER_SENTINEL/);
    assert.equal(validateSynthesisCacheBlockShape(first.blocks[0], 'session-1'), true);

    const genericMiss = selectSynthesisCacheForReplay(
      placeholderEvents,
      'Recover an unrelated lookup key',
      { enabled: true, blocks: first.blocks },
      { sessionId: 'session-1' },
    );
    assert.equal(genericMiss.selectedBlocks.length, 0);
    assert.deepEqual(genericMiss.diagnosticPatch.synthesisCacheSkippedReasonCounts, {
      coverage_miss: 1,
    });

    const tooSmall = buildSynthesisCacheBlocksFromHydratedArchives({
      sessionId: 'session-1',
      query: 'Recover key-alpha',
      hydratedRuntimeEvents: hydratedEvents,
      retrievedArchiveRefs: sourceRefs,
      archiveRetrievalMode: 'history_search_gated',
      limits: { maxBlocks: 1, maxBlockEstimatedTokens: 1, maxEstimatedTokens: 1, charsPerToken: 1 },
    });
    assert.equal(tooSmall.blocks.length, 0);
    assert.deepEqual(tooSmall.skippedReasonCounts, { max_block_tokens: 1 });
  });

  test('does not synthesize hidden archived nested results', () => {
    const hiddenBody = { text: 'DO_NOT_REPLAY_HIDDEN_ARCHIVE' };
    const hiddenSerialized = serializeToolResultForArchive(hiddenBody);
    const hiddenEvent = {
      ...toolResult('hidden-synthesis-result', 'turn-hidden', 'hidden-synthesis-tool', hiddenBody),
      modelVisibility: 'hidden' as const,
    };
    const result = buildSynthesisCacheBlocksFromHydratedArchives({
      sessionId: 'session-1',
      query: 'hidden archive',
      hydratedRuntimeEvents: [hiddenEvent],
      retrievedArchiveRefs: [
        {
          kind: 'archived_tool_result' as const,
          sessionId: 'session-1',
          turnId: 'turn-hidden',
          runtimeEventId: hiddenEvent.id,
          toolCallId: 'hidden-synthesis-tool',
          toolName: 'Read',
          artifactId: 'hidden-artifact',
          bodySha256: sha256(hiddenSerialized),
          originalEstimatedTokens: hiddenSerialized.length,
          originalBytes: utf8Bytes(hiddenSerialized),
          placeholderReason: 'stale_tool_result_pruned_before_compact' as const,
        },
      ],
      archiveRetrievalMode: 'history_search_gated',
      limits: {
        maxBlocks: 1,
        maxBlockEstimatedTokens: 1024,
        maxEstimatedTokens: 1024,
        charsPerToken: 4,
      },
    });

    assert.deepEqual(result.blocks, []);
    assert.equal(result.skippedReasonCounts?.source_missing, 1);
  });
});

describe('context-budget history compact', () => {
  test('folds older turns into a source-bearing compact block at high water', () => {
    const events = [
      textEvent('old-1', 'turn-1', 'alpha context '.repeat(12)),
      textEvent('old-2', 'turn-2', 'beta context '.repeat(12)),
      toolCall('old-call', 'turn-3', 'tool-old'),
      toolResult('old-result', 'turn-3', 'tool-old', { text: 'gamma tool payload '.repeat(8) }),
      textEvent('recent-1', 'turn-4', 'recent user context'),
      textEvent('recent-2', 'turn-5', 'latest user context'),
    ];

    const result = applyRuntimeEventContextBudget(events, {
      maxHistoryEstimatedTokens: 1600,
      minRecentTurns: 2,
      charsPerToken: 1,
      historyCompact: {
        enabled: true,
        highWaterName: 'reasonix-lowfreq-v1',
        highWaterRatio: 0.01,
        tailEstimatedTokens: 48,
        minRecentTurns: 2,
        maxSummaryEstimatedTokens: 90,
      },
    });

    assert.ok(result);
    assert.equal(result.diagnostic.highWaterReason, 'history_compact');
    assert.equal(result.diagnostic.highWaterName, 'reasonix-lowfreq-v1');
    assert.equal(result.diagnostic.historyCompactMode, 'deterministic');
    assert.equal(result.diagnostic.historyCompactedTurns, 3);
    assert.equal(result.diagnostic.historyCompactedEvents, 4);
    assert.equal(result.diagnostic.droppedTurns, 3);
    assert.equal(result.diagnostic.droppedEvents, 3);
    assert.equal(result.diagnostic.historyCompactBlockIds?.length, 1);
    assert.deepEqual(result.diagnostic.compactionDecisions, [
      {
        stage: 'priorReplay',
        sourceKind: 'runtimeEvents',
        decision: 'replaced',
        boundaryKind: 'historyCompact',
        boundaryIds: result.diagnostic.historyCompactBlockIds,
        coveredTurns: 3,
        coveredRuntimeEvents: 4,
        coverageHashes: result.diagnostic.historyCompactCoverageHashes,
        estimatedTokensBefore: result.diagnostic.historyCompactedEstimatedTokensBefore,
        estimatedTokensAfter: result.diagnostic.historyCompactedEstimatedTokensAfter,
        estimatedTokensSaved: Math.max(
          0,
          (result.diagnostic.historyCompactedEstimatedTokensBefore ?? 0) -
            (result.diagnostic.historyCompactedEstimatedTokensAfter ?? 0),
        ),
      },
    ]);
    assert.equal(
      result.events.some((event) => event.id === 'old-1'),
      false,
    );
    assert.equal(
      result.events.some((event) => event.id === 'old-result'),
      false,
    );
    assert.equal(
      result.events.some((event) => event.id === 'recent-1'),
      true,
    );
    assert.equal(
      result.events.some((event) => event.id === 'recent-2'),
      true,
    );

    const synthetic = result.events.find((event) => event.id.startsWith('history-compact:'));
    assert.equal(synthetic?.role, 'user');
    assert.equal(synthetic?.author, 'system');
    const compactText = synthetic?.content?.kind === 'text' ? synthetic.content.text : '';
    assert.match(compactText, /<maka_history_compact_block/);
    assert.match(compactText, /coverage: 4 runtime events across 3 turns/);
    assert.doesNotMatch(compactText, /runtimeEventIds=\[/);
    assert.equal(
      events.some((event) => event.id === 'old-1'),
      true,
      'input events remain unchanged',
    );
  });

  test('lookup mode uses loaded blocks but does not synthesize a fallback block', () => {
    const events = [
      textEvent('old-1', 'turn-1', 'alpha context '.repeat(12)),
      textEvent('old-2', 'turn-2', 'beta context '.repeat(12)),
      textEvent('recent-1', 'turn-3', 'recent tail'),
    ];

    const result = applyRuntimeEventContextBudget(events, {
      maxHistoryEstimatedTokens: 1000,
      minRecentTurns: 1,
      charsPerToken: 1,
      historyCompact: {
        enabled: true,
        mode: 'lookup',
        highWaterRatio: 0.01,
        targetRatio: 0.2,
      },
    });

    assert.ok(result);
    assert.deepEqual(
      result.events.map((event) => event.id),
      events.map((event) => event.id),
    );
    assert.equal(result.historyCompactBlocks?.length ?? 0, 0);
    assert.deepEqual(result.diagnostic.historyCompactSkippedReasonCounts, { lookup_miss: 1 });
    assert.deepEqual(result.diagnostic.compactionDecisions, [
      {
        stage: 'priorReplay',
        sourceKind: 'runtimeEvents',
        decision: 'unchanged',
        boundaryKind: 'historyCompact',
        reason: 'lookup_miss',
        skippedReasonCounts: { lookup_miss: 1 },
      },
    ]);
  });

  test('keeps prior history unchanged below high water', () => {
    const events = [
      textEvent('short-1', 'turn-1', 'short context'),
      textEvent('short-2', 'turn-2', 'still short'),
    ];

    const result = applyRuntimeEventContextBudget(events, {
      maxHistoryEstimatedTokens: 1000,
      charsPerToken: 1,
      historyCompact: {
        enabled: true,
        highWaterRatio: 0.8,
      },
    });

    assert.ok(result);
    assert.deepEqual(
      result.events.map((event) => event.id),
      ['short-1', 'short-2'],
    );
    assert.equal(result.diagnostic.historyCompactEnabled, true);
    assert.deepEqual(result.diagnostic.historyCompactSkippedReasonCounts, { below_high_water: 1 });
    assert.deepEqual(result.diagnostic.compactionDecisions, [
      {
        stage: 'priorReplay',
        sourceKind: 'runtimeEvents',
        decision: 'unchanged',
        boundaryKind: 'historyCompact',
        reason: 'below_high_water',
        skippedReasonCounts: { below_high_water: 1 },
      },
    ]);
    assert.equal(result.diagnostic.highWaterReason, undefined);
  });

  test('honors the history compact tail cap before the requested recent-turn count', () => {
    const events = [
      textEvent('old-1', 'turn-1', 'old context '.repeat(30)),
      textEvent('old-2', 'turn-2', 'older context '.repeat(30)),
      textEvent('recent-1', 'turn-3', 'recent one '.repeat(40)),
      textEvent('recent-2', 'turn-4', 'recent two '.repeat(40)),
      textEvent('latest', 'turn-5', 'latest tail'),
    ];

    const result = applyRuntimeEventContextBudget(events, {
      maxHistoryEstimatedTokens: 2000,
      minRecentTurns: 3,
      charsPerToken: 1,
      historyCompact: {
        enabled: true,
        highWaterRatio: 0.1,
        minRecentTurns: 3,
        tailEstimatedTokens: 25,
        maxSummaryEstimatedTokens: 120,
      },
    });

    assert.ok(result);
    assert.equal(
      result.events.some((event) => event.id === 'recent-1'),
      false,
    );
    assert.equal(
      result.events.some((event) => event.id === 'recent-2'),
      false,
    );
    assert.equal(
      result.events.some((event) => event.id === 'latest'),
      true,
    );
    assert.equal(result.diagnostic.historyCompactedTurns, 4);
  });

  test('V2 checkpoint compaction retains only the latest complete turn', () => {
    const events = [
      textEvent('old-1', 'turn-1', 'old context '.repeat(40)),
      textEvent('tail-2', 'turn-2', 'tail two'),
      textEvent('tail-3', 'turn-3', 'tail three'),
      textEvent('tail-4', 'turn-4', 'tail four'),
      textEvent('tail-5', 'turn-5', 'tail five'),
    ];

    const result = applyRuntimeEventContextBudget(
      events,
      {
        maxHistoryEstimatedTokens: 2000,
        minRecentTurns: 2,
        charsPerToken: 1,
        historyCompact: {
          enabled: true,
          highWaterRatio: 0.1,
          minRecentTurns: 2,
          tailEstimatedTokens: 100,
          maxSummaryEstimatedTokens: 120,
        },
      },
      { historyCompactProtocol: 'checkpoint_v2' },
    );

    assert.ok(result);
    assert.deepEqual(
      result.events
        .filter((event) => !event.id.startsWith('history-compact:'))
        .map((event) => event.id),
      ['tail-5'],
    );
    assert.equal(result.diagnostic.historyCompactedTurns, 4);
  });

  test('overflow recovery may fold the latest complete turn with no raw tail', () => {
    const events = [
      toolCall('latest-call', 'turn-latest', 'tool-1'),
      toolResult('latest-result', 'turn-latest', 'tool-1', {
        text: 'oversized latest result '.repeat(40),
      }),
    ];

    const result = applyRuntimeEventContextBudget(
      events,
      {
        maxHistoryEstimatedTokens: 2000,
        minRecentTurns: 0,
        charsPerToken: 1,
        historyCompact: {
          enabled: true,
          highWaterRatio: 0.1,
          minRecentTurns: 0,
          maxSummaryEstimatedTokens: 120,
        },
      },
      { historyCompactProtocol: 'checkpoint_v2' },
    );

    assert.ok(result);
    assert.deepEqual(
      result.events
        .filter((event) => !event.id.startsWith('history-compact:'))
        .map((event) => event.id),
      [],
    );
    assert.equal(result.diagnostic.historyCompactedTurns, 1);
  });

  test('keeps the complete latest turn as the continuation seam', () => {
    const events = [
      textEvent('old-1', 'turn-1', 'old context '.repeat(30)),
      toolCall('latest-call-1', 'turn-2', 'tool-1'),
      toolResult('latest-result-1', 'turn-2', 'tool-1', { text: 'first huge result '.repeat(20) }),
      toolCall('latest-call-2', 'turn-2', 'tool-2'),
      toolResult('latest-result-2', 'turn-2', 'tool-2', { text: 'second huge result '.repeat(20) }),
    ];

    const result = applyRuntimeEventContextBudget(
      events,
      {
        maxHistoryEstimatedTokens: 2500,
        minRecentTurns: 3,
        charsPerToken: 1,
        historyCompact: {
          enabled: true,
          highWaterRatio: 0.1,
          minRecentTurns: 3,
          tailEstimatedTokens: 10,
          maxSummaryEstimatedTokens: 120,
        },
      },
      { historyCompactProtocol: 'checkpoint_v2' },
    );

    assert.ok(result);
    assert.equal(
      result.events.some((event) => event.id === 'old-1'),
      false,
    );
    assert.equal(
      result.events.some((event) => event.id === 'latest-call-1'),
      true,
    );
    assert.equal(
      result.events.some((event) => event.id === 'latest-result-1'),
      true,
    );
    assert.equal(
      result.events.some((event) => event.id === 'latest-call-2'),
      true,
    );
    assert.equal(
      result.events.some((event) => event.id === 'latest-result-2'),
      true,
    );
    assert.equal(result.diagnostic.historyCompactedTurns, 1);
  });

  test('falls back to normal pruning when a generated compact replay exceeds budget', () => {
    const maxHistoryEstimatedTokens = 700;
    const events = [
      textEvent('old-1', 'turn-1', 'old compact source alpha '.repeat(40)),
      textEvent('old-2', 'turn-2', 'old compact source beta '.repeat(40)),
      toolCall('latest-call', 'turn-3', 'tool-latest'),
      toolResult('latest-result', 'turn-3', 'tool-latest', {
        text: 'latest retained tool result '.repeat(12),
      }),
    ];

    const result = applyRuntimeEventContextBudget(events, {
      maxHistoryEstimatedTokens,
      minRecentTurns: 1,
      charsPerToken: 1,
      historyCompact: {
        enabled: true,
        highWaterRatio: 0.5,
        tailEstimatedTokens: 10,
        minRecentTurns: 1,
        maxSummaryEstimatedTokens: 120,
      },
    });

    assert.ok(result);
    assert.equal(result.historyCompactBlocks, undefined);
    assert.equal(result.diagnostic.estimatedTokensAfter <= maxHistoryEstimatedTokens, true);
    assert.deepEqual(result.diagnostic.historyCompactSkippedReasonCounts, {
      replay_over_budget: 1,
    });
    assert.equal(
      result.events.some((event) => event.id.startsWith('history-compact:')),
      false,
    );
    assert.deepEqual(
      result.events.map((event) => event.id),
      ['latest-call', 'latest-result'],
    );
  });

  test('skips compaction when archive-before-project is required but missing', () => {
    const events = [
      textEvent('old-1', 'turn-1', 'missing archive source '.repeat(20)),
      textEvent('old-2', 'turn-2', 'also missing archive '.repeat(20)),
      textEvent('recent-1', 'turn-3', 'recent tail'),
    ];

    const result = applyRuntimeEventContextBudget(events, {
      maxHistoryEstimatedTokens: 500,
      minRecentTurns: 1,
      charsPerToken: 1,
      historyCompact: {
        enabled: true,
        archiveRequired: true,
        highWaterRatio: 0.5,
        targetRatio: 0.2,
      },
    });

    assert.ok(result);
    assert.equal(
      result.events.some((event) => event.id.startsWith('history-compact:')),
      false,
    );
    assert.equal(result.diagnostic.historyCompactSkipped, 1);
    assert.deepEqual(result.diagnostic.historyCompactSkippedReasonCounts, { archive_missing: 1 });
    assert.deepEqual(result.diagnostic.compactionDecisions, [
      {
        stage: 'priorReplay',
        sourceKind: 'runtimeEvents',
        decision: 'failedOpen',
        boundaryKind: 'historyCompact',
        reason: 'archive_missing',
        failOpenReason: 'archive_missing',
        skippedReasonCounts: { archive_missing: 1 },
      },
    ]);
    assert.equal(result.diagnostic.highWaterReason, undefined);
  });

  test('builds stable compact blocks with explicit render and shape validation', () => {
    const events = [
      textEvent('old-1', 'turn-1', 'stable alpha '.repeat(15)),
      textEvent('old-2', 'turn-2', 'stable beta '.repeat(15)),
      textEvent('recent-1', 'turn-3', 'recent tail'),
    ];
    const policy = {
      maxHistoryEstimatedTokens: 1500,
      charsPerToken: 1,
      historyCompact: {
        enabled: true,
        highWaterRatio: 0.01,
        tailEstimatedTokens: 36,
        minRecentTurns: 1,
        maxSummaryEstimatedTokens: 120,
      },
    } as const;

    const first = applyRuntimeEventHistoryCompact(
      events,
      policy.historyCompact,
      policy.charsPerToken,
      policy.maxHistoryEstimatedTokens,
      { charsPerToken: 1, maxHistoryEstimatedTokens: 1500 },
    );
    const second = applyRuntimeEventHistoryCompact(
      events,
      policy.historyCompact,
      policy.charsPerToken,
      policy.maxHistoryEstimatedTokens,
      { charsPerToken: 1, maxHistoryEstimatedTokens: 1500 },
    );

    assert.equal(first.blocks.length, 1);
    assert.equal(first.blocks[0]?.blockId, second.blocks[0]?.blockId);
    assert.equal(validateHistoryCompactBlockShape(first.blocks[0], 'session-1'), true);
    const rendered = renderHistoryCompactBlock(first.blocks[0]!);
    assert.match(rendered, /coverage: 2 runtime events across 2 turns/);
    assert.doesNotMatch(rendered, /bodySha256=/);
    assert.ok(
      (first.blocks[0]?.coverage.bodySha256.length ?? 0) > 0,
      'hashes stay in the block JSON',
    );
    assert.equal(first.events[0]?.id, `history-compact:${first.blocks[0]?.blockId}`);
    const boundary = historyCompactBlockToCompactionBoundary(first.blocks[0]!, {
      renderedText: renderHistoryCompactBlock(first.blocks[0]!),
      preservedAnchor: { tailTurnIds: ['turn-3'] },
      validationStatus: 'valid',
    });
    assert.equal(boundary.kind, 'historyCompact');
    assert.equal(boundary.stage, 'priorReplay');
    assert.equal(boundary.boundaryId, first.blocks[0]?.blockId);
    assert.deepEqual(boundary.coverage.runtimeEventIds, ['old-1', 'old-2']);
    assert.deepEqual(boundary.preservedAnchor?.tailTurnIds, ['turn-3']);
    assert.equal(boundary.validationStatus, 'valid');
  });

  test('excludes hidden events from compact summaries and coverage', () => {
    const hidden = {
      ...textEvent('hidden-nested', 'turn-1', 'DO_NOT_REPLAY_NESTED_ARGUMENT'),
      modelVisibility: 'hidden' as const,
    };
    const result = applyRuntimeEventHistoryCompact(
      [
        textEvent('visible-old', 'turn-1', 'visible prior context'),
        hidden,
        textEvent('visible-recent', 'turn-2', 'visible recent context'),
      ],
      {
        enabled: true,
        highWaterRatio: 0.001,
        minRecentTurns: 0,
        maxSummaryEstimatedTokens: 1_000,
      },
      1,
      5_000,
      { charsPerToken: 1, maxHistoryEstimatedTokens: 5_000 },
    );

    assert.equal(result.blocks.length, 1);
    assert.doesNotMatch(result.blocks[0]?.summary ?? '', /DO_NOT_REPLAY_NESTED_ARGUMENT/);
    assert.equal(result.blocks[0]?.coverage.runtimeEventIds.includes(hidden.id), false);
  });

  test('selects a loaded compact block instead of rebuilding the folded region', () => {
    const folded = [
      textEvent('old-1', 'turn-1', 'loaded alpha '.repeat(15)),
      textEvent('old-2', 'turn-2', 'loaded beta '.repeat(15)),
    ];
    const loadedBlock = buildHistoryCompactBlockFromSummary({
      sessionId: 'session-1',
      foldedRuntimeEvents: folded,
      summary: 'LOADED_CONTEXT_COMPACT_SENTINEL',
      highWaterName: 'loaded-compact',
      highWaterSeq: 9,
      charsPerToken: 1,
    });

    const result = applyRuntimeEventContextBudget(
      [...folded, textEvent('recent-1', 'turn-3', 'recent tail')],
      {
        maxHistoryEstimatedTokens: 10_000,
        charsPerToken: 1,
        historyCompact: {
          enabled: true,
          mode: 'lookup',
          highWaterRatio: 0.000001,
          targetRatio: 0.2,
          tailEstimatedTokens: 1,
          minRecentTurns: 1,
          blocks: [loadedBlock],
        },
      },
    );

    assert.ok(result);
    assert.equal(result.historyCompactBlocks?.[0]?.blockId, loadedBlock.blockId);
    assert.equal(result.diagnostic.historyCompactBlocksAvailable, 1);
    assert.equal(result.diagnostic.historyCompactBlocksSelected, 1);
    assert.deepEqual(result.diagnostic.historyCompactBlockIds, [loadedBlock.blockId]);
    assert.equal(result.diagnostic.compactionDecisions?.[0]?.decision, 'replaced');
    assert.deepEqual(result.diagnostic.compactionDecisions?.[0]?.boundaryIds, [
      loadedBlock.blockId,
    ]);
    assert.match(
      result.events[0]?.content?.kind === 'text' ? result.events[0].content.text : '',
      /LOADED_CONTEXT_COMPACT_SENTINEL/,
    );
  });

  test('lookup history compact keeps matching a loaded prefix after newer turns extend the fold', () => {
    const covered = [
      textEvent('old-1', 'turn-1', 'loaded alpha '.repeat(15)),
      textEvent('old-2', 'turn-2', 'loaded beta '.repeat(15)),
    ];
    const loadedBlock = buildHistoryCompactBlockFromSummary({
      sessionId: 'session-1',
      foldedRuntimeEvents: covered,
      summary: 'LOADED_CONTEXT_COMPACT_SENTINEL',
      highWaterName: 'loaded-compact',
      highWaterSeq: 9,
      charsPerToken: 1,
    });
    const uncoveredFolded = textEvent('former-tail', 'turn-3', 'former retained tail now foldable');
    const retainedOne = textEvent('recent-1', 'turn-4', 'recent retained one');
    const retainedTwo = textEvent('recent-2', 'turn-5', 'recent retained two');

    const result = applyRuntimeEventContextBudget(
      [...covered, uncoveredFolded, retainedOne, retainedTwo],
      {
        maxHistoryEstimatedTokens: 10_000,
        charsPerToken: 1,
        historyCompact: {
          enabled: true,
          mode: 'lookup',
          highWaterRatio: 0.000001,
          tailEstimatedTokens: 1,
          minRecentTurns: 2,
          blocks: [loadedBlock],
        },
      },
    );

    assert.ok(result);
    assert.equal(result.historyCompactBlocks?.[0]?.blockId, loadedBlock.blockId);
    assert.deepEqual(
      result.events.map((event) => event.id),
      [`history-compact:${loadedBlock.blockId}`, 'former-tail', 'recent-1', 'recent-2'],
    );
    assert.equal(result.diagnostic.compactionDecisions?.[0]?.decision, 'replaced');
  });

  test('lookup prefix compact falls back to normal pruning when uncovered suffix exceeds budget', () => {
    const covered = [
      textEvent('old-1', 'turn-1', 'loaded alpha '.repeat(15)),
      textEvent('old-2', 'turn-2', 'loaded beta '.repeat(15)),
    ];
    const loadedBlock = buildHistoryCompactBlockFromSummary({
      sessionId: 'session-1',
      foldedRuntimeEvents: covered,
      summary: 'LOADED_CONTEXT_COMPACT_SENTINEL',
      highWaterName: 'loaded-compact',
      highWaterSeq: 9,
      charsPerToken: 1,
    });

    const result = applyRuntimeEventContextBudget(
      [
        ...covered,
        textEvent('huge-former-tail', 'turn-3', 'huge uncovered suffix '.repeat(50)),
        textEvent('recent', 'turn-4', 'recent retained'),
      ],
      {
        maxHistoryEstimatedTokens: 80,
        minRecentTurns: 1,
        charsPerToken: 1,
        historyCompact: {
          enabled: true,
          mode: 'lookup',
          highWaterRatio: 0.000001,
          tailEstimatedTokens: 1,
          minRecentTurns: 1,
          blocks: [loadedBlock],
        },
      },
    );

    assert.ok(result);
    assert.equal(result.historyCompactBlocks, undefined);
    assert.deepEqual(
      result.events.map((event) => event.id),
      ['recent'],
    );
    assert.deepEqual(result.diagnostic.historyCompactSkippedReasonCounts, {
      prefix_over_budget: 1,
    });
  });

  test('ignores diagnostic-only runtime turns when retaining recent turns', () => {
    const result = applyRuntimeEventContextBudget(
      [
        textEvent('old-1', 'turn-1', 'old context that should be dropped'),
        textEvent('recent-1', 'turn-2', 'recent real context'),
        diagnosticRuntimeEvent('manual-compact-terminal', 'turn-compact'),
      ],
      {
        maxHistoryTurns: 1,
        minRecentTurns: 1,
        charsPerToken: 1,
      },
    );

    assert.ok(result);
    assert.deepEqual(
      result.events.map((event) => event.id),
      ['recent-1'],
    );
    assert.equal(result.diagnostic.keptTurns, 1);
  });

  test('ignores diagnostic-only runtime turns when matching loaded compact blocks', () => {
    const folded = [
      textEvent('old-1', 'turn-1', 'loaded alpha '.repeat(15)),
      textEvent('old-2', 'turn-2', 'loaded beta '.repeat(15)),
    ];
    const loadedBlock = buildHistoryCompactBlockFromSummary({
      sessionId: 'session-1',
      foldedRuntimeEvents: folded,
      summary: 'LOADED_CONTEXT_COMPACT_SENTINEL',
      highWaterName: 'loaded-compact',
      highWaterSeq: 9,
      charsPerToken: 1,
    });

    const result = applyRuntimeEventContextBudget(
      [
        ...folded,
        textEvent('recent-1', 'turn-3', 'recent retained one'),
        textEvent('recent-2', 'turn-4', 'recent retained two'),
        diagnosticRuntimeEvent('manual-compact-terminal', 'turn-compact'),
      ],
      {
        maxHistoryEstimatedTokens: 10_000,
        charsPerToken: 1,
        historyCompact: {
          enabled: true,
          mode: 'lookup',
          highWaterRatio: 0.000001,
          targetRatio: 0.2,
          tailEstimatedTokens: 1,
          minRecentTurns: 2,
          blocks: [loadedBlock],
        },
      },
    );

    assert.ok(result);
    assert.equal(result.historyCompactBlocks?.[0]?.blockId, loadedBlock.blockId);
    assert.deepEqual(result.diagnostic.historyCompactSkippedReasonCounts, undefined);
    assert.equal(
      result.events.some((event) => event.id === 'manual-compact-terminal'),
      false,
    );
    assert.equal(
      result.events.some((event) => event.id === 'recent-1'),
      true,
    );
    assert.equal(
      result.events.some((event) => event.id === 'recent-2'),
      true,
    );
  });
});

describe('context-budget search and rewrite diagnostics', () => {
  test('retrieves bounded around-context for deterministic RuntimeEvent search hits', () => {
    const events = [
      textEvent('before', 'turn-1', 'setup context'),
      textEvent('target', 'turn-2', 'needle project archive detail'),
      textEvent('after', 'turn-3', 'follow-up context'),
      textEvent('far', 'turn-4', 'unrelated'),
    ];

    const result = retrieveRuntimeEventHistoryAround(
      events,
      'please find needle',
      { enabled: true, maxResults: 1, around: 1, maxEstimatedTokens: 1000 },
      { charsPerToken: 1 },
    );

    assert.deepEqual(
      result.events.map((event) => event.id),
      ['before', 'target', 'after'],
    );
    assert.equal(result.diagnosticPatch.historySearchMatches, 1);
    assert.equal(result.diagnosticPatch.historyAroundRetrievedEvents, 3);
  });

  test('records named history rewrite gate version and reset reason', () => {
    const budgeted = applyRuntimeEventContextBudget([textEvent('event-1', 'turn-1', 'hello')], {
      historyRewrite: {
        enabled: true,
        name: 'phase6-high-water',
        historyRewriteVersion: 'phase6-v1',
        resetReason: 'explicit_test_reset',
      },
    });

    assert.ok(budgeted);
    assert.equal(budgeted.diagnostic.historyRewriteGate, 'phase6-high-water');
    assert.equal(budgeted.diagnostic.historyRewriteVersion, 'phase6-v1');
    assert.equal(budgeted.diagnostic.historyRewriteResetReason, 'explicit_test_reset');
  });
});

function textEvent(id: string, turnId: string, text: string): RuntimeEvent {
  return baseEvent({
    id,
    turnId,
    role: 'user',
    author: 'user',
    content: { kind: 'text', text },
  });
}

function diagnosticRuntimeEvent(id: string, turnId: string): RuntimeEvent {
  return baseEvent({
    id,
    turnId,
    role: 'system',
    author: 'system',
    status: 'completed',
    actions: { endInvocation: true },
  });
}

function toolCall(id: string, turnId: string, toolCallId: string): RuntimeEvent {
  return baseEvent({
    id,
    turnId,
    role: 'model',
    author: 'agent',
    content: {
      kind: 'function_call',
      id: toolCallId,
      name: 'Read',
      args: { path: `${toolCallId}.txt` },
    },
  });
}

function toolResult(id: string, turnId: string, toolCallId: string, result: unknown): RuntimeEvent {
  return baseEvent({
    id,
    turnId,
    role: 'tool',
    author: 'tool',
    content: { kind: 'function_response', id: toolCallId, name: 'Read', result },
  });
}

function archivedResult(
  id: string,
  turnId: string,
  toolCallId: string,
  archive: {
    artifactId: string;
    bodySha256: string;
    originalEstimatedTokens: number;
    originalBytes: number;
  },
): RuntimeEvent {
  return toolResult(id, turnId, toolCallId, {
    kind: ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
    rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
    runtimeEventId: id,
    toolCallId,
    toolName: 'Read',
    reason: 'stale_tool_result_pruned_before_compact',
    ...archive,
  });
}

function synthesisBlock(input: {
  queryKey: string;
  turnId: string;
  runtimeEventId: string;
  toolCallId: string;
  artifactId: string;
  bodySha256: string;
  originalEstimatedTokens: number;
  originalBytes: number;
}): SynthesisCacheBlock {
  return {
    kind: 'maka.synthesis_cache_block',
    version: 1,
    blockId: `synth-${input.queryKey}`,
    sessionId: 'session-1',
    createdAt: 1_800_000_000_001,
    highWaterName: `after-gated-${input.queryKey}`,
    highWaterSeq: 1,
    coverage: {
      queryKeys: [input.queryKey],
      turnIds: [input.turnId],
      runtimeEventIds: [input.runtimeEventId],
      toolNames: ['Read'],
      toolCallIds: [input.toolCallId],
      artifactIds: [input.artifactId],
      bodySha256: [input.bodySha256],
    },
    summary: `The stable answer for ${input.queryKey} is SYNTH_SENTINEL.`,
    limitations: ['Does not include raw tool output.'],
    sourceRefs: [
      {
        kind: 'archived_tool_result',
        sessionId: 'session-1',
        turnId: input.turnId,
        runtimeEventId: input.runtimeEventId,
        toolCallId: input.toolCallId,
        toolName: 'Read',
        artifactId: input.artifactId,
        bodySha256: input.bodySha256,
        originalEstimatedTokens: input.originalEstimatedTokens,
        originalBytes: input.originalBytes,
        placeholderReason: 'stale_tool_result_pruned_before_compact',
      },
    ],
    createdFrom: 'gated_archive_retrieval',
  };
}

function baseEvent(overrides: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: 'event',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    invocationId: 'invocation-1',
    ts: 1_800_000_000_000,
    partial: false,
    role: 'system',
    author: 'system',
    ...overrides,
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
