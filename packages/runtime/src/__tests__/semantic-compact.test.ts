import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ModelMessage } from '../model-protocol.js';
import { buildActiveCompactionHeadAnchor } from '../active-full-compact.js';

import {
  renderSemanticCompactBlock,
  rewriteSemanticCompactInMessages,
  semanticCompactBlockToCompactionBoundary,
  type SemanticCompactSummaryRequest,
} from '../semantic-compact.js';

describe('semantic compact', () => {
  test('replaces older completed episodes while preserving the newest completed episode', async () => {
    let requestSeen: SemanticCompactSummaryRequest | undefined;
    const messages = semanticFixtureMessages();

    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minSafePrefixEstimatedTokens: 1,
        maxAcceptedProjectionEstimatedTokens: 2048,
        minSavingsTokens: 1,
        minSavingsRatio: 0,
      },
      requestShapeHashForMessages: (stepMessages) =>
        `shape:${stepMessages.length}:${JSON.stringify(stepMessages).length}`,
      summarizer: (request) => {
        requestSeen = request;
        assert.equal('tools' in request, false);
        assert.equal('toolChoice' in request, false);
        assert.match(JSON.stringify(request.messages), /OLD_BUILD_LOG/);
        assert.doesNotMatch(JSON.stringify(request.messages), /recent-result/);
        assert.match(JSON.stringify(request.messages), /Return ONLY a valid JSON object/);
        assert.doesNotMatch(JSON.stringify(request.messages), /source_manifest/);
        assert.doesNotMatch(JSON.stringify(request.messages), /restoration_cards/);
        return {
          text: semanticSummary({
            finding: 'Solve the task while keeping the service running.',
            actionInProgress: 'Continue from the preserved recent tool result.',
            partialWorkProduct: ['Earlier output showed a large build log.'],
          }),
          usage: {
            inputTokens: 10,
            outputTokens: 12,
            cacheHitInputTokens: 0,
            cacheMissInputTokens: 10,
            cacheMissInputSource: 'explicit',
            cacheWriteInputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 22,
            cachedInputTokens: 0,
          },
          finishReason: 'stop',
        };
      },
    });

    assert.equal(result.decision, 'replaced');
    assert.ok(requestSeen, 'expected injected summarizer to be called');
    assert.equal(requestSeen.maxOutputTokens, 4096);
    assert.equal(result.block?.kind, 'maka.semantic_compact_block');
    assert.equal(result.block?.blockId, 'semcompact-311e98c7e686a4ac360adc140a644165');
    assert.equal(
      result.block?.cumulativeCoverageDigest,
      'edc54105a90e20f39f8f7c184c7162f4f187da295076393399a73d2b78ae2d2a',
    );
    assert.equal(result.block?.stateCards, undefined);
    assert.equal(result.block?.acceptance.decision, 'accepted');
    assert.ok((result.block?.estimatedTokensSavedSigned ?? 0) > 0);
    assert.deepEqual(result.block?.preservedTail.toolCallIds, ['tool-recent']);
    assert.equal(
      result.messages.some(
        (message) =>
          message.role === 'assistant' &&
          JSON.stringify(message.content).includes('maka_semantic_compact_block'),
      ),
      true,
    );
    assert.deepEqual(
      result.messages[0],
      messages[0],
      'the exact current-user head anchor must stay first',
    );
    assert.equal(result.messages.filter((message) => message.role === 'user').length, 1);
    assert.equal(
      result.messages.some(
        (message) =>
          message.role === 'tool' && JSON.stringify(message.content).includes('recent-result'),
      ),
      true,
    );

    const decisions = result.diagnosticPatch.compactionDecisions ?? [];
    assert.equal(decisions[0]?.boundaryKind, 'semanticCompact');
    assert.equal(decisions[0]?.decision, 'replaced');
    assert.equal(decisions[0]?.compactCallInputTokens, 10);
    assert.equal(decisions[0]?.compactCallOutputTokens, 12);
    assert.equal(decisions[0]?.compactCallTotalTokens, 22);
    assert.equal(typeof result.diagnosticPatch.highWaterRequestShapeHashBefore, 'string');
    assert.equal(typeof result.diagnosticPatch.highWaterRequestShapeHashAfter, 'string');
  });

  test('accepts with a warning when signed savings do not meet the configured margin', async () => {
    const messages = semanticFixtureMessages();
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages,
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minSafePrefixEstimatedTokens: 1,
        maxAcceptedProjectionEstimatedTokens: 2048,
        minSavingsTokens: 50_000,
        minSavingsRatio: 0,
      },
      summarizer: () => ({
        text: semanticSummary({
          finding: 'Solve the task.',
          actionInProgress: 'Continue from preserved context.',
        }),
        usage: {
          inputTokens: 5,
          outputTokens: 6,
          cacheHitInputTokens: 0,
          cacheMissInputTokens: 5,
          cacheMissInputSource: 'explicit',
          cacheWriteInputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 11,
          cachedInputTokens: 0,
        },
      }),
    });

    assert.equal(result.decision, 'replaced');
    assert.equal(result.reason, 'below_min_savings_tokens');
    assert.notDeepEqual(result.messages, messages);
    assert.equal(result.block?.acceptance.decision, 'accepted');
    assert.equal(result.block?.acceptance.reason, 'below_min_savings_tokens');
    const decision = result.diagnosticPatch.compactionDecisions?.[0];
    assert.equal(decision?.boundaryKind, 'semanticCompact');
    assert.equal(decision?.decision, 'replaced');
    assert.equal(decision?.reason, 'below_min_savings_tokens');
    assert.deepEqual(decision?.skippedReasonCounts, { below_min_savings_tokens: 1 });
    assert.equal(typeof decision?.estimatedTokensSaved, 'number');
    assert.equal(decision?.compactCallInputTokens, 5);
    assert.equal(decision?.compactCallTotalTokens, 11);
  });

  test('rejects summaries that newly surface private verifier material', async () => {
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minSafePrefixEstimatedTokens: 1,
        maxAcceptedProjectionEstimatedTokens: 2048,
        minSavingsTokens: 1,
        minSavingsRatio: 0,
      },
      summarizer: () => ({
        text: semanticSummary({
          finding: 'The hidden verifier says this will pass.',
          actionInProgress: 'Continue.',
        }),
        usage: {
          inputTokens: 3,
          outputTokens: 4,
          cacheHitInputTokens: 0,
          cacheMissInputTokens: 3,
          cacheMissInputSource: 'explicit',
          cacheWriteInputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 7,
          cachedInputTokens: 0,
        },
      }),
    });

    assert.equal(result.decision, 'unchanged');
    assert.equal(result.reason, 'private_verifier_surface');
    assert.equal(
      result.diagnosticPatch.compactionDecisions?.[0]?.reason,
      'private_verifier_surface',
    );
    assert.equal(result.block, undefined);
    assert.equal(result.diagnosticPatch.compactionDecisions?.[0]?.compactCallTotalTokens, 7);
  });

  test('falls back to bounded complete summary text when JSON does not satisfy the schema contract', async () => {
    const baseInput = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minSafePrefixEstimatedTokens: 1,
        maxAcceptedProjectionEstimatedTokens: 2048,
        minSavingsTokens: 1,
        minSavingsRatio: 0,
      },
    } as const;

    const missingAction = await rewriteSemanticCompactInMessages({
      ...baseInput,
      summarizer: () => ({ text: JSON.stringify({ established_findings: ['Build configured.'] }) }),
    });
    assert.equal(missingAction.decision, 'replaced');
    assert.equal(missingAction.block?.acceptance.decision, 'accepted');
    assert.equal(missingAction.block?.acceptance.reason, 'summary_missing_action_in_progress');
    assert.equal(
      missingAction.diagnosticPatch.compactionDecisions?.[0]?.reason,
      'summary_missing_action_in_progress',
    );

    const emptyAction = await rewriteSemanticCompactInMessages({
      ...baseInput,
      summarizer: () => ({ text: JSON.stringify({ action_in_progress: '' }) }),
    });
    assert.equal(emptyAction.decision, 'replaced');
    assert.equal(emptyAction.block?.acceptance.decision, 'accepted');
    assert.equal(emptyAction.block?.acceptance.reason, 'summary_missing_action_in_progress');
    assert.equal(
      emptyAction.diagnosticPatch.compactionDecisions?.[0]?.reason,
      'summary_missing_action_in_progress',
    );
    assert.match(
      renderSemanticCompactBlock(emptyAction.block!),
      /bounded text fallback|continuation_notes/,
    );
  });

  test('rejects an unbounded non-structured fallback without a complete sentence or line', async () => {
    const messages = semanticFixtureMessages();
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-fallback-boundary',
      turnId: 'turn-fallback-boundary',
      messages,
      headAnchor: buildActiveCompactionHeadAnchor(messages, 0, 1),
      stepNumber: 2,
      charsPerToken: 1,
      policy: { ...attentionTestPolicy(), maxAcceptedProjectionEstimatedTokens: 128 },
      summarizer: () => ({ text: 'unbounded '.repeat(2_000) }),
    });

    assert.equal(result.decision, 'unchanged');
    assert.equal(result.reason, 'fallback_projection_empty');
    assert.deepEqual(result.messages, messages);
  });

  test('does not reject valid summaries just because they exceed the soft summary target', async () => {
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minSafePrefixEstimatedTokens: 1,
        maxSummaryEstimatedTokens: 1,
        maxAcceptedProjectionEstimatedTokens: 2048,
        minSavingsTokens: 1,
        minSavingsRatio: 0,
      },
      summarizer: () => ({
        text: semanticSummary({
          finding: 'Continue after compact with complete continuity state.',
          actionInProgress: 'Resume with the preserved recent tool result.',
          partialWorkProduct: [
            'Earlier output showed a large build log that does not need to remain verbatim.',
          ],
        }),
      }),
    });

    assert.equal(result.decision, 'replaced');
    assert.equal(result.block?.acceptance.decision, 'accepted');
    assert.notEqual(result.reason, 'summary_too_large');
  });

  test('accepts compact with a warning when provider savings do not beat compact-call token cost', async () => {
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minSafePrefixEstimatedTokens: 1,
        maxAcceptedProjectionEstimatedTokens: 2048,
        minSavingsTokens: 1,
        minNetSavingsTokens: 1,
        compactCallTokenCostWeight: 1,
        minSavingsRatio: 0,
      },
      summarizer: () => ({
        text: semanticSummary({
          finding: 'Continue after compact.',
          actionInProgress: 'Resume with preserved tail.',
        }),
        usage: {
          inputTokens: 999_999,
          outputTokens: 1,
          cacheHitInputTokens: 0,
          cacheMissInputTokens: 999_999,
          cacheMissInputSource: 'explicit',
          cacheWriteInputTokens: 0,
          reasoningTokens: 0,
          totalTokens: 1_000_000,
          cachedInputTokens: 0,
        },
      }),
    });

    assert.equal(result.decision, 'replaced');
    assert.equal(result.block?.acceptance.decision, 'accepted');
    assert.equal(result.block?.acceptance.reason, 'below_min_net_savings_tokens');
    assert.equal(
      result.diagnosticPatch.compactionDecisions?.[0]?.reason,
      'below_min_net_savings_tokens',
    );
    assert.ok((result.block?.estimatedNetTokensSavedSigned ?? 0) < 0);
  });

  test('does not brake semantic compact calls after malformed summary fallbacks', async () => {
    const controllerState = {
      consecutiveInvalidSummaries: 0,
      totalInvalidSummaries: 0,
      compactCallCount: 0,
      compactCallTotalTokens: 0,
      acceptedEstimatedTokensSaved: 0,
    };
    let calls = 0;
    const policy = {
      enabled: true,
      maxActiveEstimatedTokens: 1,
      highWaterRatio: 0.1,
      minSafePrefixEstimatedTokens: 1,
      maxAcceptedProjectionEstimatedTokens: 2048,
      minSavingsTokens: 1,
      minSavingsRatio: 0,
      maxConsecutiveInvalidSummaries: 1,
      invalidSummaryCooldownSteps: 3,
    } as const;

    const invalid = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 2,
      charsPerToken: 1,
      policy,
      controllerState,
      summarizer: () => {
        calls += 1;
        return { text: JSON.stringify({ established_findings: ['Build configured.'] }) };
      },
    });
    assert.equal(invalid.decision, 'replaced');
    assert.equal(invalid.block?.acceptance.reason, 'summary_missing_action_in_progress');
    assert.equal(calls, 1);
    assert.equal(controllerState.consecutiveInvalidSummaries, 0);

    const cooled = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 3,
      charsPerToken: 1,
      policy,
      controllerState,
      summarizer: () => {
        calls += 1;
        return {
          text: semanticSummary({
            finding: 'Should not run.',
            actionInProgress: 'Should not run.',
          }),
        };
      },
    });
    assert.equal(cooled.decision, 'replaced');
    assert.notEqual(cooled.reason, 'semantic_compact_cooldown');
    assert.equal(calls, 2);

    const resumed = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 6,
      charsPerToken: 1,
      policy,
      controllerState,
      summarizer: () => {
        calls += 1;
        return {
          text: semanticSummary({ finding: 'Runs after cooldown.', actionInProgress: 'Continue.' }),
        };
      },
    });
    assert.notEqual(resumed.reason, 'semantic_compact_cooldown');
    assert.equal(calls, 3);
  });

  test('brakes semantic compact calls after repeated summarizer failures', async () => {
    const controllerState = {
      consecutiveInvalidSummaries: 0,
      totalInvalidSummaries: 0,
      compactCallCount: 0,
      compactCallTotalTokens: 0,
      acceptedEstimatedTokensSaved: 0,
    };
    let calls = 0;
    const policy = {
      enabled: true,
      maxActiveEstimatedTokens: 1,
      highWaterRatio: 0.1,
      minSafePrefixEstimatedTokens: 1,
      maxAcceptedProjectionEstimatedTokens: 2048,
      minSavingsTokens: 1,
      minSavingsRatio: 0,
      maxConsecutiveInvalidSummaries: 1,
      invalidSummaryCooldownSteps: 3,
    } as const;

    const failed = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 2,
      charsPerToken: 1,
      policy,
      controllerState,
      summarizer: () => {
        calls += 1;
        throw new Error('boom');
      },
    });
    assert.equal(failed.reason, 'summarizer_failed');
    assert.equal(controllerState.consecutiveInvalidSummaries, 1);

    const cooled = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 3,
      charsPerToken: 1,
      policy,
      controllerState,
      summarizer: () => {
        calls += 1;
        return {
          text: semanticSummary({
            finding: 'Should not run.',
            actionInProgress: 'Should not run.',
          }),
        };
      },
    });
    assert.equal(cooled.decision, 'unchanged');
    assert.equal(cooled.reason, 'semantic_compact_cooldown');
    assert.equal(calls, 1);
  });

  test('keeps runtime evidence in the diagnostic block without injecting it into the LLM projection', async () => {
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-1',
      turnId: 'turn-1',
      messages: semanticFixtureMessages(),
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        enabled: true,
        maxActiveEstimatedTokens: 1,
        highWaterRatio: 0.1,
        minSafePrefixEstimatedTokens: 1,
        maxAcceptedProjectionEstimatedTokens: 2048,
        minSavingsTokens: 1,
        minSavingsRatio: 0,
      },
      summarizer: () => ({
        text: semanticSummary({
          finding: 'Continue after compact.',
          actionInProgress: 'Resume with preserved tail.',
        }),
      }),
    });

    assert.equal(result.decision, 'replaced');
    assert.ok((result.block?.sourceRefs.length ?? 0) > 0);
    assert.ok((result.block?.coverage.providerMessageSourceIds.length ?? 0) > 0);
    assert.equal(result.block?.stateCards, undefined);
    const rendered = renderSemanticCompactBlock(result.block!);
    assert.match(rendered, /maka_semantic_compact_block/);
    assert.match(rendered, /resume action_in_progress instead of restarting task discovery/);
    assert.match(rendered, /action_in_progress: Resume with preserved tail\./);
    assert.doesNotMatch(rendered, /restoration_state_cards/);
    assert.doesNotMatch(rendered, /durable_archives_available/);
    assert.doesNotMatch(rendered, /durable_coverage/);
    assert.doesNotMatch(rendered, /preserved_tail:/);
    assert.doesNotMatch(rendered, /providerSourceIds=/);
  });

  test('never renders legacy state cards or runtime-inferred assistant intentions', async () => {
    const messages = [
      { role: 'user', content: 'Implement the MIPS interpreter exactly. '.repeat(80) },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me re-read the files before writing the VM. '.repeat(80) },
          {
            type: 'tool-call',
            toolCallId: 'earlier-read',
            toolName: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'earlier-read', toolName: 'Bash', result: 'files' },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'recent-write',
            toolName: 'Bash',
            input: { command: 'pwd' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'recent-write',
            toolName: 'Bash',
            result: 'workspace ready',
          },
        ],
      },
    ] as ModelMessage[];
    let requestSeen: SemanticCompactSummaryRequest | undefined;
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-no-state-cards',
      turnId: 'turn-no-state-cards',
      messages,
      stepNumber: 2,
      charsPerToken: 1,
      policy: attentionTestPolicy(),
      summarizer: (request) => {
        requestSeen = request;
        return {
          text: semanticSummary({
            finding: 'Implement the MIPS interpreter exactly.',
            actionInProgress: 'Write /app/vm.js now.',
          }),
        };
      },
    });

    assert.equal(result.decision, 'replaced');
    assert.ok(requestSeen);
    assert.doesNotMatch(JSON.stringify(requestSeen.messages.at(-1)), /restoration_cards/);
    assert.equal(result.block?.stateCards, undefined);

    result.block!.stateCards = [
      {
        kind: 'vm',
        text: 'Let me re-read the files before writing the VM.',
        sourceIds: ['legacy-provider-source'],
      },
    ];
    const rendered = renderSemanticCompactBlock(result.block!);
    assert.doesNotMatch(rendered, /Let me re-read/);
    assert.doesNotMatch(rendered, /restoration_state_cards/);
    assert.match(rendered, /action_in_progress: Write \/app\/vm\.js now\./);
    assert.doesNotMatch(
      rendered,
      /current_objective|user_constraints|operational_state|next_action/,
    );
  });

  test('preserves prior replay and the exact multimodal current-user head anchor', async () => {
    const messages = [
      { role: 'user', content: 'prior user' },
      { role: 'assistant', content: 'prior answer' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Fix the current task exactly.' },
          { type: 'image', image: 'data:image/png;base64,AAAA' },
        ],
        providerOptions: { test: { stable: true } },
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'completed reasoning '.repeat(600) },
          {
            type: 'tool-call',
            toolCallId: 'anchor-earlier',
            toolName: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'anchor-earlier', toolName: 'Bash', result: 'files' },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'anchor-recent',
            toolName: 'Bash',
            input: { command: 'pwd' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'anchor-recent',
            toolName: 'Bash',
            result: 'workspace ready',
          },
        ],
      },
    ] as unknown as ModelMessage[];
    const headAnchor = buildActiveCompactionHeadAnchor(messages, 2, 1);
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-anchor',
      turnId: 'turn-anchor',
      messages,
      headAnchor,
      stepNumber: 2,
      charsPerToken: 1,
      policy: attentionTestPolicy(),
      summarizer: () => ({
        text: semanticSummary({
          finding: 'Fix the current task exactly.',
          actionInProgress: 'Continue.',
        }),
      }),
    });

    assert.equal(result.decision, 'replaced');
    assert.deepEqual(result.messages.slice(0, 3), messages.slice(0, 3));
    assert.equal(result.block?.headAnchor?.messageSignature, headAnchor.messageSignature);
    assert.equal(result.block?.headAnchor?.bodySha256, headAnchor.bodySha256);
    assert.equal(result.block?.version, 2);
    const boundary = semanticCompactBlockToCompactionBoundary(result.block!);
    assert.equal(boundary.predecessorBoundaryId, undefined);
    assert.deepEqual(
      boundary.preservedAnchor?.headProviderMessageSourceIds,
      result.block?.headAnchor?.sourceIds,
    );
    assert.equal(
      result.block?.coverage.providerMessageSourceIds.some((id) => id.startsWith('provider:2:')),
      false,
    );
  });

  test('keeps an incomplete multi-tool episode in the exact tail', async () => {
    const messages = [
      { role: 'user', content: 'Current task' },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'earlier completed reasoning '.repeat(500) },
          {
            type: 'tool-call',
            toolCallId: 'call-earlier',
            toolName: 'Bash',
            input: { command: 'earlier' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-earlier',
            toolName: 'Bash',
            result: 'earlier-done',
          },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'completed reasoning '.repeat(500) },
          {
            type: 'tool-call',
            toolCallId: 'call-complete',
            toolName: 'Bash',
            input: { command: 'done' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call-complete', toolName: 'Bash', result: 'done' },
        ],
      },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'open episode reasoning' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'call-a', toolName: 'Bash', input: { command: 'a' } },
          { type: 'tool-call', toolCallId: 'call-b', toolName: 'Bash', input: { command: 'b' } },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'call-a', toolName: 'Bash', result: 'done-a' },
        ],
      },
    ] as unknown as ModelMessage[];
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-tail',
      turnId: 'turn-tail',
      messages,
      headAnchor: buildActiveCompactionHeadAnchor(messages, 0, 1),
      stepNumber: 2,
      charsPerToken: 1,
      policy: attentionTestPolicy(),
      summarizer: () => ({
        text: semanticSummary({ finding: 'Current task', actionInProgress: 'Finish tools.' }),
      }),
    });

    assert.equal(result.decision, 'replaced');
    assert.deepEqual(result.messages.slice(-5), messages.slice(-5));
    assert.deepEqual(result.block?.preservedTail.toolCallIds, [
      'call-a',
      'call-b',
      'call-complete',
    ]);
    assert.doesNotMatch(renderSemanticCompactBlock(result.block!), /open episode reasoning/);
  });

  test('requires both total high water and a 4K completed safe span', async () => {
    let calls = 0;
    const messages = [
      { role: 'user', content: 'large exact instruction '.repeat(500) },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'small completed step' },
          {
            type: 'tool-call',
            toolCallId: 'threshold-earlier',
            toolName: 'Bash',
            input: { command: 'true' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'threshold-earlier', toolName: 'Bash', result: 'ok' },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'threshold-recent',
            toolName: 'Bash',
            input: { command: 'pwd' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'threshold-recent', toolName: 'Bash', result: 'ok' },
        ],
      },
    ] as ModelMessage[];
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-threshold',
      turnId: 'turn-threshold',
      messages,
      headAnchor: buildActiveCompactionHeadAnchor(messages, 0, 1),
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        ...attentionTestPolicy(),
        maxActiveEstimatedTokens: 16_000,
        highWaterRatio: 0.5,
        minSafePrefixEstimatedTokens: 4_096,
      },
      summarizer: () => {
        calls += 1;
        return { text: semanticSummary({ finding: 'unused', actionInProgress: 'unused' }) };
      },
    });

    assert.equal(result.decision, 'unchanged');
    assert.equal(result.reason, 'below_min_safe_prefix');
    assert.equal(calls, 0);
    assert.deepEqual(result.messages[0], messages[0]);
  });

  test('does not call the summarizer before the configured 128K attention high water', async () => {
    let calls = 0;
    const messages = [
      { role: 'user', content: 'Exact task instruction' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'older completed work '.repeat(2_000) },
          {
            type: 'tool-call',
            toolCallId: 'water-earlier',
            toolName: 'Bash',
            input: { command: 'true' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'water-earlier', toolName: 'Bash', result: 'ok' },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'water-recent',
            toolName: 'Bash',
            input: { command: 'pwd' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'water-recent',
            toolName: 'Bash',
            result: 'workspace',
          },
        ],
      },
    ] as unknown as ModelMessage[];
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-128k-water',
      turnId: 'turn-128k-water',
      messages,
      headAnchor: buildActiveCompactionHeadAnchor(messages, 0, 1),
      stepNumber: 2,
      charsPerToken: 1,
      policy: {
        ...attentionTestPolicy(),
        maxActiveEstimatedTokens: 131_072,
        highWaterRatio: 1,
      },
      summarizer: () => {
        calls += 1;
        return { text: semanticSummary({ finding: 'unused', actionInProgress: 'unused' }) };
      },
    });

    assert.equal(result.decision, 'unchanged');
    assert.equal(result.reason, 'below_high_water');
    assert.equal(calls, 0);
  });

  test('rolls predecessor plus newly completed raw history into one V2 successor', async () => {
    const original = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Exact task instruction' },
          { type: 'file', data: 'data:text/plain;base64,QQ==', mediaType: 'text/plain' },
        ],
        providerOptions: { test: { anchor: 'stable' } },
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'first completed history '.repeat(500) },
          {
            type: 'tool-call',
            toolCallId: 'roll-earlier-1',
            toolName: 'Bash',
            input: { command: 'ls' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'roll-earlier-1', toolName: 'Bash', result: 'files' },
        ],
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'roll-recent-1',
            toolName: 'Bash',
            input: { command: 'pwd' },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'roll-recent-1',
            toolName: 'Bash',
            result: 'workspace ready',
          },
        ],
      },
    ] as unknown as ModelMessage[];
    const headAnchor = buildActiveCompactionHeadAnchor(original, 0, 1);
    const first = await rewriteSemanticCompactInMessages({
      sessionId: 'session-roll',
      turnId: 'turn-roll',
      messages: original,
      headAnchor,
      stepNumber: 2,
      charsPerToken: 1,
      policy: attentionTestPolicy(),
      summarizer: () => ({
        text: semanticSummary({
          finding: 'Exact task instruction',
          actionInProgress: 'Second step.',
        }),
      }),
    });
    assert.equal(first.decision, 'replaced');

    first.block!.stateCards = [
      {
        kind: 'process',
        text: 'Let me re-read every source file before writing the VM.',
        sourceIds: ['legacy-source'],
      },
    ];
    const legacyProjection = first.messages.find((message) =>
      JSON.stringify(message.content).includes('<maka_semantic_compact_block'),
    );
    assert.ok(legacyProjection);
    legacyProjection.content = `${String(legacyProjection.content)}\nrestoration_state_cards:\n- Let me re-read every source file before writing the VM.`;

    const withNewHistory = [
      ...first.messages,
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'second completed history '.repeat(500) },
          {
            type: 'tool-call',
            toolCallId: 'roll-earlier-2',
            toolName: 'Bash',
            input: { command: 'git diff' },
          },
        ],
      } as ModelMessage,
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'roll-earlier-2', toolName: 'Bash', result: 'diff' },
        ],
      } as unknown as ModelMessage,
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'roll-recent-2',
            toolName: 'Bash',
            input: { command: 'git status' },
          },
        ],
      } as ModelMessage,
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'roll-recent-2', toolName: 'Bash', result: 'clean' },
        ],
      } as unknown as ModelMessage,
    ];
    const second = await rewriteSemanticCompactInMessages({
      sessionId: 'session-roll',
      turnId: 'turn-roll',
      messages: withNewHistory,
      headAnchor,
      predecessorBlock: first.block,
      stepNumber: 3,
      charsPerToken: 1,
      policy: { ...attentionTestPolicy(), minNewPrefixEstimatedTokens: 1 },
      summarizer: (request) => {
        const renderedRequest = JSON.stringify(request.messages);
        assert.match(renderedRequest, new RegExp(first.block!.blockId));
        assert.doesNotMatch(renderedRequest, /restoration_state_cards/);
        assert.doesNotMatch(renderedRequest, /Let me re-read every source file/);
        return {
          text: semanticSummary({ finding: 'Exact task instruction', actionInProgress: 'Finish.' }),
        };
      },
    });

    assert.equal(second.decision, 'replaced');
    assert.equal(second.block?.predecessorBlockId, first.block?.blockId);
    assert.notEqual(second.block?.cumulativeCoverageDigest, first.block?.cumulativeCoverageDigest);
    assert.equal(
      second.messages.filter((message) =>
        JSON.stringify(message.content).includes('<maka_semantic_compact_block'),
      ).length,
      1,
    );
    assert.deepEqual(second.messages[0], original[0]);
  });

  test('rejects empty and token-limit-truncated summarizer output', async () => {
    const messages = semanticFixtureMessages();
    const input = {
      sessionId: 'session-reject',
      turnId: 'turn-reject',
      messages,
      headAnchor: buildActiveCompactionHeadAnchor(messages, 0, 1),
      stepNumber: 2,
      charsPerToken: 1,
      policy: attentionTestPolicy(),
    } as const;
    const empty = await rewriteSemanticCompactInMessages({
      ...input,
      summarizer: () => ({ text: '' }),
    });
    const truncated = await rewriteSemanticCompactInMessages({
      ...input,
      summarizer: () => ({ text: '{"action_in_progress":"partial', finishReason: 'max_tokens' }),
    });
    assert.equal(empty.decision, 'unchanged');
    assert.equal(empty.reason, 'summary_missing');
    assert.equal(truncated.decision, 'unchanged');
    assert.equal(truncated.reason, 'summary_truncated');
  });

  test('bounds the complete provider-visible projection block', async () => {
    const messages = semanticFixtureMessages();
    const result = await rewriteSemanticCompactInMessages({
      sessionId: 'session-budget',
      turnId: 'turn-budget',
      messages,
      headAnchor: buildActiveCompactionHeadAnchor(messages, 0, 4),
      stepNumber: 2,
      charsPerToken: 4,
      policy: {
        ...attentionTestPolicy(),
        maxAcceptedProjectionEstimatedTokens: 768,
      },
      summarizer: () => ({
        text: semanticSummary({
          finding: 'Keep the objective focused. '.repeat(40),
          actionInProgress: 'Continue with the next exact action. '.repeat(40),
          partialWorkProduct: Array.from(
            { length: 8 },
            (_, index) => `command-${index} ${'output '.repeat(80)}`,
          ),
        }),
      }),
    });
    assert.equal(result.decision, 'replaced');
    assert.ok(Math.ceil(renderSemanticCompactBlock(result.block!).length / 4) <= 768);
    assert.ok((result.block?.projection?.estimatedTokens ?? 769) <= 768);

    const fallback = await rewriteSemanticCompactInMessages({
      sessionId: 'session-budget-fallback',
      turnId: 'turn-budget-fallback',
      messages,
      headAnchor: buildActiveCompactionHeadAnchor(messages, 0, 4),
      stepNumber: 2,
      charsPerToken: 4,
      policy: { ...attentionTestPolicy(), maxAcceptedProjectionEstimatedTokens: 768 },
      summarizer: () => ({
        text: 'The build is configured and the service is running. '.repeat(400),
      }),
    });
    assert.equal(fallback.decision, 'replaced');
    assert.equal(fallback.block?.projection?.format, 'bounded_text_fallback');
    assert.ok(Math.ceil(renderSemanticCompactBlock(fallback.block!).length / 4) <= 768);
    assert.ok((fallback.block?.projection?.estimatedTokens ?? 769) <= 768);
  });
});

function attentionTestPolicy() {
  return {
    enabled: true,
    maxActiveEstimatedTokens: 1,
    highWaterRatio: 0.1,
    minSafePrefixEstimatedTokens: 1,
    minNewPrefixEstimatedTokens: 1,
    maxAcceptedProjectionEstimatedTokens: 2048,
    minSavingsTokens: 1,
    minSavingsRatio: 0,
  } as const;
}

function semanticFixtureMessages(): ModelMessage[] {
  return [
    {
      role: 'user',
      content: 'Please fix the build and keep the service running. '.repeat(80),
    } as ModelMessage,
    {
      role: 'assistant',
      content: 'I ran configure and saw a linker failure. '.repeat(80),
    } as ModelMessage,
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'tool-old',
          toolName: 'Bash',
          input: { command: 'make test' },
        },
      ],
    } as ModelMessage,
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tool-old',
          toolName: 'Bash',
          result: { body: 'OLD_BUILD_LOG '.repeat(800) },
        },
      ],
    } as unknown as ModelMessage,
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'tool-recent',
          toolName: 'Bash',
          input: { command: 'ps aux' },
        },
      ],
    } as ModelMessage,
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'tool-recent',
          toolName: 'Bash',
          result: { body: 'recent-result service still running' },
        },
      ],
    } as unknown as ModelMessage,
  ];
}

function semanticSummary(input: {
  finding: string;
  actionInProgress: string;
  partialWorkProduct?: string[];
}): string {
  return JSON.stringify({
    established_findings: [input.finding],
    decisions: [],
    failed_paths: [],
    partial_work_product: input.partialWorkProduct ?? [],
    action_in_progress: input.actionInProgress,
  });
}
