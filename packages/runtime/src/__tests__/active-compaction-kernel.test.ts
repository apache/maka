import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeEvent } from '@maka/core/runtime-event';

import {
  activeCompactionCoverageFromEntries,
  buildActiveCompactionHeadAnchor,
  buildActiveCompactionSourceIndex,
  selectActiveCompactionSafeSpan,
  validateActiveCompactionCoverageForSourceIndex,
} from '../active-compaction-kernel.js';
import type { ModelMessage } from '../model-protocol.js';

test('active compaction kernel selects only complete provider episodes after the head anchor', () => {
  const messages = fixtureMessages();
  const index = buildActiveCompactionSourceIndex({
    sessionId: 'session-1',
    turnId: 'turn-1',
    messages,
    stepNumber: 2,
    charsPerToken: 1,
  });

  const selection = selectActiveCompactionSafeSpan({
    index,
    messages,
    headAnchor: buildActiveCompactionHeadAnchor(messages, 0, 1),
    policy: {
      enabled: true,
      minStepNumber: 1,
      highWaterRatio: 0.1,
      maxActiveEstimatedTokens: 1,
      minSafePrefixEstimatedTokens: 0,
      preserveRecentCompletedEpisodes: 1,
    },
  });

  assert.equal(selection.decision, 'selected');
  if (selection.decision !== 'selected') return;
  assert.equal(selection.startMessageIndex, 1);
  assert.equal(selection.endMessageIndex, 2);
  assert.deepEqual(selection.coverage.toolCallIds, ['call-1']);
  assert.equal(
    validateActiveCompactionCoverageForSourceIndex(selection.coverage, index).valid,
    true,
  );
});

test('active compaction kernel fails closed on hash drift and split tool pairs', () => {
  const messages = fixtureMessages();
  const index = buildActiveCompactionSourceIndex({
    sessionId: 'session-1',
    turnId: 'turn-1',
    messages,
  });
  const callEntry = index.entries.find((entry) => entry.contentKind === 'function_call');
  assert.ok(callEntry);

  const splitCoverage = activeCompactionCoverageFromEntries([callEntry]);
  const splitValidation = validateActiveCompactionCoverageForSourceIndex(splitCoverage, index);
  assert.equal(splitValidation.valid, false);
  assert.ok(splitValidation.reasons.includes('tool_pair_split'));

  const hashValidation = validateActiveCompactionCoverageForSourceIndex(
    { ...splitCoverage, bodySha256: ['not-the-source-hash'] },
    index,
  );
  assert.equal(hashValidation.valid, false);
  assert.ok(hashValidation.reasons.includes('source_hash_mismatch'));
});

test('active compaction kernel does not relabel a tool result from a call-only runtime match', () => {
  const index = buildActiveCompactionSourceIndex({
    sessionId: 'session-1',
    turnId: 'turn-1',
    messages: fixtureMessages(),
    runtimeEvents: [
      {
        id: 'event-call-1',
        invocationId: 'invocation-1',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        ts: 1,
        partial: false,
        role: 'model',
        author: 'agent',
        content: {
          kind: 'function_call',
          id: 'call-1',
          name: 'Read',
          args: { path: 'README.md' },
        },
      } satisfies RuntimeEvent,
    ],
  });

  const resultEntry = index.entries.find((entry) => entry.messageIndex === 2);
  assert.ok(resultEntry);
  assert.equal(resultEntry.contentKind, 'tool_result');
  assert.equal(resultEntry.runtimeEventId, undefined);
});

test('active compaction kernel binds safe-span selection to the exact user head', () => {
  const messages = fixtureMessages();
  const headAnchor = buildActiveCompactionHeadAnchor(messages, 0);
  const changedMessages: ModelMessage[] = [
    { role: 'user', content: 'changed request' } as ModelMessage,
    ...messages.slice(1),
  ];
  const index = buildActiveCompactionSourceIndex({
    sessionId: 'session-1',
    turnId: 'turn-1',
    messages: changedMessages,
  });

  const selection = selectActiveCompactionSafeSpan({
    index,
    messages: changedMessages,
    headAnchor,
    policy: { enabled: true, minStepNumber: 0 },
  });

  assert.equal(selection.decision, 'failedOpen');
  assert.equal(selection.reason, 'head_anchor_mismatch');
});

function fixtureMessages(): ModelMessage[] {
  return [
    { role: 'user', content: 'inspect the repository' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'Read',
          input: { path: 'README.md' },
        },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'Read',
          output: { type: 'text', value: 'contents' },
        },
      ],
    },
    { role: 'assistant', content: 'The repository is ready.' },
  ] as ModelMessage[];
}
