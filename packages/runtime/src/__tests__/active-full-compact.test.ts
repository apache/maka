import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ModelMessage } from '../model-protocol.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';

import {
  activeFullCompactBlockToCompactionBoundary,
  activeFullCompactCoverageFromEntries,
  activeFullCompactDecisionDiagnosticPatch,
  buildDeterministicActiveFullCompactSummary,
  buildActiveCompactionHeadAnchor,
  buildActiveFullCompactBlockFromSummary,
  buildActiveFullCompactSourceIndex,
  renderActiveFullCompactBlock,
  rewriteActiveFullCompactInMessages,
  selectActiveFullCompactCoveredSpan,
  validateActiveFullCompactBlockForSourceIndex,
  validateActiveFullCompactBlockShape,
  type ActiveFullCompactFailOpenReason,
  type ActiveFullCompactSummary,
  type ActiveFullCompactValidationResult,
} from '../active-full-compact.js';
import {
  ACTIVE_ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
  ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
  type ActiveArchivedToolResultPlaceholder,
} from '../context-budget.js';

describe('active full compact PR1 foundation', () => {
  test('source index maps RuntimeEvents to provider entries', () => {
    const runtimeEvents = fixtureRuntimeEvents();
    const messages = fixtureMessages();
    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      invocationId: 'inv-1',
      messages,
      runtimeEvents,
      stepNumber: 2,
      charsPerToken: 2,
    });

    assert.equal(index.entries.length, 3);
    assert.deepEqual(
      index.entries.map((entry) => entry.runtimeEventId),
      ['event-user', 'event-call', 'event-response'],
    );
    assert.deepEqual(
      index.entries.map((entry) => entry.contentKind),
      ['text', 'function_call', 'function_response'],
    );
    const response = index.entries[2]!;
    assert.equal(response.toolCallId, 'call-1');
    assert.equal(response.toolName, 'Read');
    assert.match(response.bodySha256, /^[a-f0-9]{64}$/);
    assert.ok(response.estimatedTokens > 0);
  });

  test('source index recognizes active prune placeholders', () => {
    const placeholder = activePlaceholder();
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-archived',
            toolName: 'Bash',
            output: { type: 'text', value: JSON.stringify(placeholder) },
          },
        ],
      } as unknown as ModelMessage,
    ];

    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      charsPerToken: 1,
    });

    const entry = index.entries[0]!;
    assert.equal(entry.contentKind, 'active_archive_placeholder');
    assert.equal(entry.archiveRef?.kind, 'toolResult');
    assert.equal(entry.archiveRef?.artifactId, 'artifact-call-archived');
    assert.equal(entry.archiveRef?.bodySha256, placeholder.bodySha256);
    assert.equal(entry.originalEstimatedTokens, 123);
    assert.equal(entry.originalBytes, 456);
    assert.equal(entry.toolCallId, 'call-archived');
  });

  test('coverage derives stable ids and hashes', () => {
    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: fixtureMessages(),
      runtimeEvents: fixtureRuntimeEvents(),
    });

    const coverage = activeFullCompactCoverageFromEntries([...index.entries].reverse());

    assert.deepEqual(coverage.runtimeEventIds, ['event-call', 'event-response', 'event-user']);
    assert.deepEqual(coverage.providerMessageSourceIds, [
      'provider:0',
      'provider:1:0',
      'provider:2:0',
    ]);
    assert.deepEqual(coverage.toolCallIds, ['call-1']);
    assert.deepEqual(coverage.contentKinds, ['function_call', 'function_response', 'text']);
    assert.equal(coverage.bodySha256.length, 3);
  });

  test('block builder, renderer, and shape validator work', () => {
    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: fixtureMessages(),
      runtimeEvents: fixtureRuntimeEvents(),
    });
    const summary = fixtureSummary(index.entries.map((entry) => entry.sourceId));
    const block = buildActiveFullCompactBlockFromSummary({
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      invocationId: 'inv-1',
      entries: index.entries,
      summary,
      highWaterName: 'test-active-full-compact',
      highWaterSeq: 7,
      now: 100,
    });
    const sameBlock = buildActiveFullCompactBlockFromSummary({
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      invocationId: 'inv-1',
      entries: index.entries,
      summary,
      highWaterName: 'test-active-full-compact',
      highWaterSeq: 7,
      now: 200,
    });

    assert.equal(block.blockId, sameBlock.blockId);
    assert.equal(validateActiveFullCompactBlockShape(block, 'session-1'), true);
    const rendered = renderActiveFullCompactBlock(block);
    assert.match(rendered, /<maka_active_full_compact_block/);
    assert.match(rendered, /commands_tried:/);
    assert.doesNotMatch(rendered, /SECRET_RAW_OUTPUT/);
  });

  test('block-to-boundary mapping uses shared vocabulary', () => {
    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: fixtureMessages(),
      runtimeEvents: fixtureRuntimeEvents(),
    });
    const block = buildActiveFullCompactBlockFromSummary({
      sessionId: 'session-1',
      turnId: 'turn-1',
      entries: index.entries,
      summary: fixtureSummary(index.entries.map((entry) => entry.sourceId)),
      preservedAnchor: {
        tailRuntimeEventIds: ['event-response'],
        tailProviderMessageSourceIds: ['provider:2:0'],
        tailTurnIds: ['turn-1'],
      },
      now: 100,
    });

    const boundary = activeFullCompactBlockToCompactionBoundary(block, {
      validationStatus: 'valid',
      validationReason: 'ok',
    });

    assert.equal(boundary.kind, 'activeFullCompact');
    assert.equal(boundary.stage, 'activeStep');
    assert.equal(boundary.boundaryId, block.blockId);
    assert.deepEqual(boundary.coverage.runtimeEventIds, block.coverage.runtimeEventIds);
    assert.deepEqual(boundary.sourceHashes, block.coverage.bodySha256);
    assert.equal(boundary.validationStatus, 'valid');
    assert.doesNotMatch(boundary.renderedText ?? '', /providerSourceIds=/);
    assert.doesNotMatch(boundary.renderedText ?? '', /bodySha256=/);
    assert.deepEqual(boundary.preservedAnchor?.tailProviderMessageSourceIds, ['provider:2:0']);
  });

  test('validation fails open on source hash mismatch and maps diagnostics', () => {
    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: fixtureMessages(),
      runtimeEvents: fixtureRuntimeEvents(),
    });
    const block = buildActiveFullCompactBlockFromSummary({
      sessionId: 'session-1',
      turnId: 'turn-1',
      entries: index.entries,
      summary: fixtureSummary(index.entries.map((entry) => entry.sourceId)),
      now: 100,
    });
    block.coverage.bodySha256 = ['bad-hash'];

    const validation = validateActiveFullCompactBlockForSourceIndex(block, index);
    assert.equal(validation.valid, false);
    assert.deepEqual(validation.reasons, ['source_hash_mismatch']);

    const patch = activeFullCompactDecisionDiagnosticPatch({
      decision: 'failedOpen',
      boundaryIds: [block.blockId],
      coverage: block.coverage,
      failOpenReason: 'source_hash_mismatch',
      validationReasonCounts: validation.reasonCounts,
    });
    assert.equal(patch.compactionDecisions?.[0]?.decision, 'failedOpen');
    assert.equal(patch.compactionDecisions?.[0]?.stage, 'activeStep');
    assert.equal(patch.compactionDecisions?.[0]?.sourceKind, 'providerMessages');
    assert.equal(patch.compactionDecisions?.[0]?.boundaryKind, 'activeFullCompact');
  });

  test('validation fails open without throwing for malformed blocks', () => {
    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: fixtureMessages(),
      runtimeEvents: fixtureRuntimeEvents(),
    });
    const block = buildActiveFullCompactBlockFromSummary({
      sessionId: 'session-1',
      turnId: 'turn-1',
      entries: index.entries,
      summary: fixtureSummary(index.entries.map((entry) => entry.sourceId)),
      now: 100,
    });
    const malformedBlocks: Array<{
      name: string;
      value: unknown;
      extraReason?: ActiveFullCompactFailOpenReason;
    }> = [
      { name: 'missing coverage', value: { ...block, coverage: undefined } },
      {
        name: 'missing summary',
        value: { ...block, summary: undefined },
        extraReason: 'summary_missing',
      },
      {
        name: 'invalid coverage arrays',
        value: {
          ...block,
          coverage: { ...block.coverage, providerMessageSourceIds: 'provider:0' },
        },
      },
      {
        name: 'malformed archive refs',
        value: { ...block, archiveRefs: [{ kind: 'toolResult' }] },
      },
    ];

    for (const { name, value, extraReason } of malformedBlocks) {
      let validation: ActiveFullCompactValidationResult | undefined;
      assert.doesNotThrow(() => {
        validation = validateActiveFullCompactBlockForSourceIndex(value, index);
      }, name);
      assert.equal(validation?.valid, false, name);
      assert.ok(validation?.reasons.includes('invalid_schema_version'), name);
      if (extraReason) assert.ok(validation?.reasons.includes(extraReason), name);
    }
  });

  test('validation remeasures provider-visible block tokens instead of trusting stale estimates', () => {
    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: fixtureMessages(),
      runtimeEvents: fixtureRuntimeEvents(),
    });
    const block = buildActiveFullCompactBlockFromSummary({
      sessionId: 'session-1',
      turnId: 'turn-1',
      entries: index.entries,
      summary: fixtureSummary(index.entries.map((entry) => entry.sourceId)),
      now: 100,
      charsPerToken: 1,
    });
    block.summary.processState = ['visible provider replacement detail '.repeat(20)];
    block.estimatedTokens = 1;

    const validation = validateActiveFullCompactBlockForSourceIndex(block, index, {
      maxBlockEstimatedTokens: 20,
      charsPerToken: 1,
    });

    assert.equal(validation.valid, false);
    assert.ok(validation.reasons.includes('max_block_tokens'));
  });

  test('span selection fails open on tool pair split', () => {
    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: fixtureMessages(),
      runtimeEvents: fixtureRuntimeEvents(),
      stepNumber: 3,
      charsPerToken: 1,
    });

    const selection = selectActiveFullCompactCoveredSpan(index, {
      enabled: true,
      minStepNumber: 1,
      minRecentMessages: 1,
      maxActiveEstimatedTokens: 1,
      highWaterRatio: 0.1,
    });

    assert.equal(selection.decision, 'failedOpen');
    assert.equal(selection.reason, 'tool_pair_split');
  });

  test('helper calls leave provider request shape unchanged', () => {
    const messages = fixtureMessages();
    const before = JSON.stringify(messages);
    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      runtimeEvents: fixtureRuntimeEvents(),
    });
    const block = buildActiveFullCompactBlockFromSummary({
      sessionId: 'session-1',
      turnId: 'turn-1',
      entries: index.entries,
      summary: fixtureSummary(index.entries.map((entry) => entry.sourceId)),
      now: 100,
    });
    validateActiveFullCompactBlockForSourceIndex(block, index);
    activeFullCompactBlockToCompactionBoundary(block);

    assert.equal(JSON.stringify(messages), before);
  });

  test('active archive refs and diagnostics coexist with active prune fields', () => {
    const placeholder = activePlaceholder();
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-archived',
            toolName: 'Bash',
            result: placeholder,
          },
        ],
      } as unknown as ModelMessage,
    ];
    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
    });
    const block = buildActiveFullCompactBlockFromSummary({
      sessionId: 'session-1',
      turnId: 'turn-1',
      entries: index.entries,
      summary: fixtureSummary(index.entries.map((entry) => entry.sourceId)),
      now: 100,
    });

    assert.equal(block.archiveRefs?.[0]?.kind, 'toolResult');
    const patch = activeFullCompactDecisionDiagnosticPatch({
      decision: 'replaced',
      boundaryIds: [block.blockId],
      coverage: block.coverage,
      estimatedTokensBefore: 500,
      estimatedTokensAfter: 100,
    });
    assert.equal(patch.compactionDecisions?.[0]?.estimatedTokensSaved, 400);
  });

  test('provider-visible archive refs are capped while durable audit refs remain complete', () => {
    const messages: ModelMessage[] = Array.from(
      { length: 20 },
      (_, index) =>
        ({
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: `call-archived-${index}`,
              toolName: 'Bash',
              result: activePlaceholder({
                artifactId: `artifact-call-archived-${String(index).padStart(2, '0')}`,
                toolCallId: `call-archived-${index}`,
                bodySha256: String(index % 10).repeat(64),
              }),
            },
          ],
        }) as unknown as ModelMessage,
    );
    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
    });
    const block = buildActiveFullCompactBlockFromSummary({
      sessionId: 'session-1',
      turnId: 'turn-1',
      entries: index.entries,
      summary: fixtureSummary(index.entries.map((entry) => entry.sourceId)),
      now: 100,
    });

    const rendered = renderActiveFullCompactBlock(block);

    assert.equal(block.archiveRefs?.length, 20);
    assert.match(rendered, /artifact-call-archived-00/);
    assert.match(rendered, /artifact-call-archived-11/);
    assert.doesNotMatch(rendered, /artifact-call-archived-12/);
    assert.match(rendered, /8 additional archive refs retained off-prompt/);
    assert.doesNotMatch(rendered, /bodySha256/);
  });

  test('deterministic summary is bounded and metadata-first', () => {
    const messages = textMessages([
      'RAW_SELECTED_PAYLOAD_'.repeat(100),
      'assistant progress',
      'recent anchor',
    ]);
    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      stepNumber: 2,
      charsPerToken: 1,
    });
    const selection = selectActiveFullCompactCoveredSpan(index, {
      enabled: true,
      minStepNumber: 1,
      minRecentMessages: 1,
      maxActiveEstimatedTokens: 1,
      highWaterRatio: 0.1,
      maxSummaryEstimatedTokens: 60,
    });
    assert.equal(selection.decision, 'selected');
    if (selection.decision !== 'selected') assert.fail('expected selected');

    const summary = buildDeterministicActiveFullCompactSummary({
      selection,
      messages,
      maxSummaryEstimatedTokens: 60,
      charsPerToken: 1,
    });

    assert.equal(summary.schemaVersion, 1);
    assert.ok(summary.text.length <= 60);
    assert.equal(summary.text.includes('RAW_SELECTED_PAYLOAD'), false);
  });

  test('rewrite helper replaces a safe completed span with one compact block', () => {
    const messages = textMessages([
      'old raw payload alpha '.repeat(30),
      'old assistant payload beta '.repeat(30),
      'recent user anchor',
    ]);

    const rewritten = rewriteActiveFullCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      policy: {
        enabled: true,
        minStepNumber: 1,
        minRecentMessages: 1,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        maxSummaryEstimatedTokens: 512,
      },
      stepNumber: 2,
      now: 100,
      charsPerToken: 1,
    });

    assert.equal(rewritten.decision, 'replaced');
    assert.equal(rewritten.messages.length, 2);
    assert.equal(rewritten.messages[1], messages[2]);
    assert.equal((rewritten.messages[0] as { role?: unknown }).role, 'user');
    const rendered = (rewritten.messages[0] as { content?: unknown }).content;
    assert.equal(typeof rendered, 'string');
    assert.match(rendered as string, /maka_active_full_compact_block/);
    assert.equal((rendered as string).includes('old raw payload alpha'), false);
    assert.equal(rewritten.diagnosticPatch.compactionDecisions?.[0]?.decision, 'replaced');
  });

  test('rewrite helper dry run validates without mutating messages', () => {
    const messages = textMessages([
      'old raw payload alpha '.repeat(30),
      'old assistant payload beta '.repeat(30),
      'recent user anchor',
    ]);

    const rewritten = rewriteActiveFullCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      policy: {
        enabled: true,
        minStepNumber: 1,
        minRecentMessages: 1,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
      },
      stepNumber: 2,
      now: 100,
      charsPerToken: 1,
      requestShapeHashForMessages: (candidate) => `shape:${JSON.stringify(candidate).length}`,
      dryRun: true,
      dryRunReason: 'validate_only',
    });

    assert.equal(rewritten.decision, 'unchanged');
    assert.equal(rewritten.messages.length, messages.length);
    assert.equal(rewritten.messages[0], messages[0]);
    assert.ok(rewritten.block);
    assert.equal(rewritten.diagnosticPatch.compactionDecisions?.[0]?.decision, 'unchanged');
    assert.equal(rewritten.diagnosticPatch.compactionDecisions?.[0]?.reason, 'validate_only');
    assert.equal(
      rewritten.diagnosticPatch.highWaterRequestShapeHashBefore,
      rewritten.diagnosticPatch.highWaterRequestShapeHashAfter,
    );
  });

  test('rewrite helper records unchanged and failed-open diagnostics', () => {
    const messages = textMessages(['old payload', 'recent anchor']);
    const unchanged = rewriteActiveFullCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      policy: { enabled: false },
      stepNumber: 2,
    });
    assert.equal(unchanged.decision, 'unchanged');
    assert.equal(unchanged.messages.length, messages.length);
    assert.equal(unchanged.diagnosticPatch.compactionDecisions?.[0]?.decision, 'unchanged');

    const failed = rewriteActiveFullCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      policy: {
        enabled: true,
        minStepNumber: 1,
        minRecentMessages: 1,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        archiveRequired: true,
      },
      stepNumber: 2,
    });
    assert.equal(failed.decision, 'failedOpen');
    assert.equal(failed.messages.length, messages.length);
    assert.equal(failed.diagnosticPatch.compactionDecisions?.[0]?.decision, 'failedOpen');
    assert.equal(
      failed.diagnosticPatch.compactionDecisions?.[0]?.failOpenReason,
      'provider_message_only_when_runtime_required',
    );
  });

  test('rewrite helper preserves active prune archive refs in the compact block', () => {
    const placeholder = activePlaceholder();
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-archived',
            toolName: 'Bash',
            input: { command: 'npm test' },
          },
        ],
      } as unknown as ModelMessage,
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-archived',
            toolName: 'Bash',
            result: placeholder,
          },
        ],
      } as unknown as ModelMessage,
      { role: 'user', content: 'recent anchor' },
    ];

    const rewritten = rewriteActiveFullCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      policy: {
        enabled: true,
        minStepNumber: 1,
        minRecentMessages: 1,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
      },
      stepNumber: 2,
      charsPerToken: 1,
    });

    assert.equal(rewritten.decision, 'replaced');
    assert.equal(rewritten.block?.archiveRefs?.[0]?.artifactId, 'artifact-call-archived');
    assert.match(
      String((rewritten.messages[0] as { content?: unknown }).content),
      /artifact-call-archived/,
    );
  });

  test('QEMU-style long process compact preserves state and archive refs without raw output', () => {
    const messages = qemuStyleMessages();
    const runtimeEvents = qemuStyleRuntimeEvents();

    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      runtimeEvents,
      stepNumber: 4,
      charsPerToken: 4,
    });
    const selection = selectActiveFullCompactCoveredSpan(index, {
      enabled: true,
      minStepNumber: 1,
      minRecentMessages: 1,
      maxActiveEstimatedTokens: 1,
      highWaterRatio: 0.1,
      maxSummaryEstimatedTokens: 1200,
    });
    assert.equal(selection.decision, 'selected');
    if (selection.decision !== 'selected') assert.fail('expected selected');
    assert.equal(selection.endMessageIndex, messages.length - 2);

    const rewritten = rewriteActiveFullCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      invocationId: 'inv-1',
      messages,
      runtimeEvents,
      policy: {
        enabled: true,
        minStepNumber: 1,
        minRecentMessages: 1,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        maxSummaryEstimatedTokens: 1200,
      },
      stepNumber: 4,
      now: 100,
      charsPerToken: 4,
    });

    assert.equal(rewritten.decision, 'replaced');
    assert.equal(rewritten.validation?.valid, true);
    assert.ok(rewritten.block);
    const replacementJson = JSON.stringify(rewritten.messages);
    assert.match(replacementJson, /maka_active_full_compact_block/);
    assert.doesNotMatch(replacementJson, /QEMU_RAW_BOOT_SPAM_DO_NOT_LEAK/);
    assert.doesNotMatch(replacementJson, /QEMU_RAW_VERIFY_SPAM_DO_NOT_LEAK/);
    assert.match(replacementJson, /pid=4242/);
    assert.match(replacementJson, /127\.0\.0\.1:2222/);
    assert.match(replacementJson, /guest reached login prompt/);
    assert.match(replacementJson, /\/tmp\/qemu-run\.sh/);
    assert.match(replacementJson, /\/workspace\/solution\.sh/);
    assert.match(replacementJson, /VERIFIER FAILURE: expected ssh service reachable/);
    assert.match(
      replacementJson,
      /Failed hypothesis: networking is broken because hostfwd was missing/,
    );
    assert.match(replacementJson, /Current hypothesis: sshd is not started inside the guest/);
    assert.match(replacementJson, /Next action: retry SSH after boot and rerun verifier/);
    assert.match(replacementJson, /artifact-qemu-boot/);
    assert.match(replacementJson, /artifact-qemu-verify/);
    assert.doesNotMatch(replacementJson, /providerSourceIds=/);
    assert.doesNotMatch(replacementJson, /bodySha256=/);
    assert.doesNotMatch(replacementJson, /source\(kind=/);
    assert.equal(rewritten.messages[1], messages[messages.length - 1]);
    assert.deepEqual(rewritten.block.archiveRefs?.map((ref) => ref.artifactId).sort(), [
      'artifact-qemu-boot',
      'artifact-qemu-verify',
    ]);
    assert.ok(
      rewritten.block.summary.commandsTried?.some(
        (command) => command.command.includes('qemu-system-x86_64') && command.sourceIds?.length,
      ),
    );
  });

  test('QEMU summary drops task-run metadata while keeping operational facts', () => {
    const rewritten = rewriteActiveFullCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      invocationId: 'inv-1',
      messages: qemuStyleMessages(),
      runtimeEvents: qemuStyleRuntimeEventsWithTaskRunMetadata(),
      policy: {
        enabled: true,
        minStepNumber: 1,
        minRecentMessages: 1,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        maxSummaryEstimatedTokens: 1200,
      },
      stepNumber: 4,
      now: 100,
      charsPerToken: 4,
    });

    assert.equal(rewritten.decision, 'replaced');
    assert.ok(rewritten.block);
    const replacementJson = JSON.stringify(rewritten.messages);
    assert.match(replacementJson, /qemu-system-x86_64/);
    assert.match(replacementJson, /guest reached login prompt/);
    assert.match(replacementJson, /\/app\/alpine\.iso/);
    assert.match(replacementJson, /\/boot\/vmlinuz-lts/);
    assert.doesNotMatch(replacementJson, /task_run_created/);
    assert.doesNotMatch(replacementJson, /taskRunId/);
    assert.doesNotMatch(replacementJson, /sessionId/);
    assert.doesNotMatch(replacementJson, /runtime-events\.jsonl/);
    assert.doesNotMatch(replacementJson, /maka-task-run/);
  });

  test('QEMU/source-ref cliff validates visible replacement while retaining audit metadata', () => {
    const messages = [
      ...Array.from(
        { length: 96 },
        (_, index) =>
          ({
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `QEMU/source-ref covered message ${index} ` + 'raw output chunk '.repeat(6),
          }) as ModelMessage,
      ),
      { role: 'user', content: 'recent tail remains visible' } as ModelMessage,
    ];

    const rewritten = rewriteActiveFullCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      policy: {
        enabled: true,
        minStepNumber: 1,
        minRecentMessages: 1,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        maxSummaryEstimatedTokens: 256,
      },
      stepNumber: 7,
      now: 100,
      charsPerToken: 1,
    });

    assert.equal(rewritten.decision, 'replaced');
    assert.equal(rewritten.validation?.valid, true);
    assert.ok(rewritten.block);
    assert.equal(rewritten.block.sourceRefs.length, 96);
    assert.equal(rewritten.block.coverage.providerMessageSourceIds.length, 96);
    assert.ok(rewritten.block.coverage.bodySha256.length > 80);
    assert.ok((rewritten.block.estimatedTokens ?? Infinity) <= 2048);

    const visibleReplacement = String((rewritten.messages[0] as { content?: unknown }).content);
    assert.match(visibleReplacement, /maka_active_full_compact_block/);
    assert.doesNotMatch(visibleReplacement, /providerSourceIds=/);
    assert.doesNotMatch(visibleReplacement, /bodySha256=/);
    assert.doesNotMatch(visibleReplacement, /source\(kind=/);

    const decision = rewritten.diagnosticPatch.compactionDecisions?.[0];
    assert.equal(decision?.decision, 'replaced');
    assert.equal(decision?.coverageHashes?.length, rewritten.block.coverage.bodySha256.length);
  });

  test('selection treats an already-rendered active compact block as the next boundary', () => {
    const first = rewriteActiveFullCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: textMessages([
        'old raw payload alpha '.repeat(20),
        'old assistant payload beta '.repeat(20),
        'tail after first compact',
      ]),
      policy: {
        enabled: true,
        minStepNumber: 1,
        minRecentMessages: 1,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        maxSummaryEstimatedTokens: 512,
      },
      stepNumber: 2,
      now: 100,
      charsPerToken: 1,
    });
    assert.equal(first.decision, 'replaced');

    const messages = [
      ...first.messages,
      { role: 'assistant', content: 'post-compact work output '.repeat(20) } as ModelMessage,
      { role: 'user', content: 'recent tail after second compact' } as ModelMessage,
    ];
    const index = buildActiveFullCompactSourceIndex({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      stepNumber: 3,
      charsPerToken: 1,
    });
    const selection = selectActiveFullCompactCoveredSpan(index, {
      enabled: true,
      minStepNumber: 1,
      minRecentMessages: 1,
      maxActiveEstimatedTokens: 1,
      highWaterRatio: 0.1,
      maxSummaryEstimatedTokens: 512,
    });

    assert.equal(selection.decision, 'selected');
    if (selection.decision !== 'selected') assert.fail('expected selected');
    assert.equal(index.activeCompactMessageIndexes?.[0], 0);
    assert.equal(selection.startMessageIndex > 0, true);
    assert.equal(
      selection.entries.some((entry) => entry.messageIndex === 0),
      false,
    );
  });

  test('emergency compaction fails explicitly instead of rewriting an oversized user anchor', () => {
    const messages = [
      { role: 'user', content: 'exact oversized instruction '.repeat(100) },
    ] as ModelMessage[];
    const result = rewriteActiveFullCompactInMessages({
      sessionId: 'session-anchor-capacity',
      turnId: 'turn-anchor-capacity',
      messages,
      headAnchor: buildActiveCompactionHeadAnchor(messages, 0, 1),
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 100,
        highWaterRatio: 0.5,
      },
    });

    assert.equal(result.decision, 'failedOpen');
    assert.deepEqual(result.messages, messages);
    assert.equal(
      result.diagnosticPatch.compactionDecisions?.[0]?.reason,
      'head_anchor_exceeds_capacity',
    );
    assert.equal(
      result.diagnosticPatch.compactionDecisions?.[0]?.failOpenReason,
      'head_anchor_exceeds_capacity',
    );
  });
});

function textMessages(values: string[]): ModelMessage[] {
  return values.map(
    (value, index) =>
      ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: value,
      }) as ModelMessage,
  );
}

function fixtureMessages(): ModelMessage[] {
  return [
    { role: 'user', content: 'hello world' },
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
    } as ModelMessage,
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'Read',
          output: { type: 'json', value: { ok: true, body: 'short result' } },
        },
      ],
    } as ModelMessage,
  ];
}

function fixtureRuntimeEvents(): RuntimeEvent[] {
  return [
    runtimeEvent('event-user', 'user', 'user', { kind: 'text', text: 'hello world' }),
    runtimeEvent('event-call', 'model', 'agent', {
      kind: 'function_call',
      id: 'call-1',
      name: 'Read',
      args: { path: 'README.md' },
    }),
    runtimeEvent('event-response', 'tool', 'tool', {
      kind: 'function_response',
      id: 'call-1',
      name: 'Read',
      result: { ok: true, body: 'short result' },
    }),
  ];
}

function runtimeEvent(
  id: string,
  role: RuntimeEvent['role'],
  author: RuntimeEvent['author'],
  content: NonNullable<RuntimeEvent['content']>,
): RuntimeEvent {
  return {
    id,
    invocationId: 'inv-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 10,
    partial: false,
    role,
    author,
    content,
    refs:
      content.kind === 'function_call' || content.kind === 'function_response'
        ? { toolCallId: content.id }
        : undefined,
  };
}

function activePlaceholder(
  input: Partial<ActiveArchivedToolResultPlaceholder> = {},
): ActiveArchivedToolResultPlaceholder {
  return {
    kind: ACTIVE_ARCHIVED_TOOL_RESULT_PLACEHOLDER_KIND,
    rewriteVersion: ARCHIVED_TOOL_RESULT_REWRITE_VERSION,
    artifactId: input.artifactId ?? 'artifact-call-archived',
    turnId: 'turn-1',
    toolCallId: input.toolCallId ?? 'call-archived',
    toolName: input.toolName ?? 'Bash',
    bodySha256: input.bodySha256 ?? 'a'.repeat(64),
    originalEstimatedTokens: input.originalEstimatedTokens ?? 123,
    originalBytes: input.originalBytes ?? 456,
    reason: 'active_current_turn_tool_result_pruned_before_next_step',
  };
}

function qemuStyleMessages(): ModelMessage[] {
  return [
    {
      role: 'user',
      content:
        'Task constraints: boot a tiny VM-like process, expose SSH-like port 2222, modify only visible files, and run the public verifier without hidden benchmark shortcuts.',
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-qemu-boot',
          toolName: 'Bash',
          input: {
            command:
              'qemu-system-x86_64 -net user,hostfwd=tcp::2222-:22 -daemonize -pidfile /tmp/qemu.pid',
            cwd: '/workspace',
          },
        },
      ],
    } as unknown as ModelMessage,
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-qemu-boot',
          toolName: 'Bash',
          result: activePlaceholder({
            artifactId: 'artifact-qemu-boot',
            toolCallId: 'call-qemu-boot',
            bodySha256: 'b'.repeat(64),
            originalEstimatedTokens: 6000,
            originalBytes: 24000,
          }),
        },
      ],
    } as unknown as ModelMessage,
    {
      role: 'assistant',
      content:
        'Failed hypothesis: networking is broken because hostfwd was missing. Current hypothesis: sshd is not started inside the guest.',
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-write-artifacts',
          toolName: 'Write',
          input: { path: '/workspace/solution.sh', content: 'service ssh start\n' },
        },
      ],
    } as unknown as ModelMessage,
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-write-artifacts',
          toolName: 'Write',
          output: {
            type: 'text',
            value: 'wrote /workspace/solution.sh and updated /etc/network/interfaces',
          },
        },
      ],
    } as unknown as ModelMessage,
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call-qemu-verify',
          toolName: 'Bash',
          input: { command: '/workspace/solution.sh && ./public-verifier.sh', cwd: '/workspace' },
        },
      ],
    } as unknown as ModelMessage,
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call-qemu-verify',
          toolName: 'Bash',
          result: activePlaceholder({
            artifactId: 'artifact-qemu-verify',
            toolCallId: 'call-qemu-verify',
            bodySha256: 'c'.repeat(64),
            originalEstimatedTokens: 7000,
            originalBytes: 28000,
          }),
        },
      ],
    } as unknown as ModelMessage,
    {
      role: 'assistant',
      content: 'Next action: retry SSH after boot and rerun verifier from the preserved tail.',
    },
  ];
}

function qemuStyleRuntimeEvents(): RuntimeEvent[] {
  return [
    runtimeEvent('event-qemu-user', 'user', 'user', {
      kind: 'text',
      text: 'Task constraints: boot a tiny VM-like process, expose SSH-like port 2222, modify only visible files, and run the public verifier without hidden benchmark shortcuts.',
    }),
    runtimeEvent('event-qemu-boot-call', 'model', 'agent', {
      kind: 'function_call',
      id: 'call-qemu-boot',
      name: 'Bash',
      args: {
        command:
          'qemu-system-x86_64 -net user,hostfwd=tcp::2222-:22 -daemonize -pidfile /tmp/qemu.pid',
        cwd: '/workspace',
      },
    }),
    runtimeEvent('event-qemu-boot-result', 'tool', 'tool', {
      kind: 'function_response',
      id: 'call-qemu-boot',
      name: 'Bash',
      result: [
        'qemu raw boot noise QEMU_RAW_BOOT_SPAM_DO_NOT_LEAK\n'.repeat(200),
        'process pid=4242 background=true command=qemu-system-x86_64 cwd=/workspace',
        'listening on 127.0.0.1:2222 for ssh forwarding',
        'guest reached login prompt; ssh refused until service starts',
        'artifact script /tmp/qemu-run.sh created',
      ].join('\n'),
    }),
    runtimeEvent('event-qemu-write-call', 'model', 'agent', {
      kind: 'function_call',
      id: 'call-write-artifacts',
      name: 'Write',
      args: { path: '/workspace/solution.sh', content: 'service ssh start\n' },
    }),
    runtimeEvent('event-qemu-write-result', 'tool', 'tool', {
      kind: 'function_response',
      id: 'call-write-artifacts',
      name: 'Write',
      result: 'wrote /workspace/solution.sh and updated /etc/network/interfaces',
    }),
    runtimeEvent('event-qemu-verify-call', 'model', 'agent', {
      kind: 'function_call',
      id: 'call-qemu-verify',
      name: 'Bash',
      args: { command: '/workspace/solution.sh && ./public-verifier.sh', cwd: '/workspace' },
    }),
    runtimeEvent('event-qemu-verify-result', 'tool', 'tool', {
      kind: 'function_response',
      id: 'call-qemu-verify',
      name: 'Bash',
      result: [
        'qemu verifier noise QEMU_RAW_VERIFY_SPAM_DO_NOT_LEAK\n'.repeat(200),
        'public verifier exit code=1',
        'VERIFIER FAILURE: expected ssh service reachable on 127.0.0.1:2222',
      ].join('\n'),
    }),
  ];
}

function qemuStyleRuntimeEventsWithTaskRunMetadata(): RuntimeEvent[] {
  return qemuStyleRuntimeEvents().map((event) => {
    if (event.id !== 'event-qemu-boot-result' || event.content?.kind !== 'function_response')
      return event;
    return {
      ...event,
      content: {
        ...event.content,
        result: [
          '{"event":"task_run_created","taskRunId":"task-run-1","sessionId":"session-1","runId":"run-1","status":"queued"}',
          '{"event":"task_run_queued","taskRunId":"task-run-1","invocationId":"inv-1","status":"queued"}',
          '/Users/likun/work/agent/maka-task-run/runs/sessions/session-1/runs/run-1/runtime-events.jsonl',
          'qemu-system-x86_64 direct kernel boot used /app/alpine.iso and /boot/vmlinuz-lts',
          String(event.content.result),
        ].join('\n'),
      },
    };
  });
}

function fixtureSummary(sourceIds: string[]): ActiveFullCompactSummary {
  return {
    schemaVersion: 1,
    text: 'Terminal task progressed through file inspection and a short verifier run.',
    processState: ['no long-running process observed'],
    vmState: ['guest state unchanged'],
    artifactPaths: ['README.md'],
    commandsTried: [
      {
        command: 'npm test',
        outcome: 'failed before archived raw output was inspected',
        sourceIds,
      },
    ],
    latestVerifierFailure: 'unit verifier still red',
    constraints: ['do not alter provider request shape in PR1'],
    failedHypotheses: ['raw output alone is enough context'],
    currentHypothesis: 'source-bearing summary can cover the active span',
    nextActions: ['wire provider-visible replacement in PR2'],
    archiveRefs: ['artifact-call-archived'],
  };
}
