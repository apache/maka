import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import type { ModelMessage } from '../model-protocol.js';

import {
  activeToolResultLineageIdentity,
  rewriteActiveToolResultsInMessages,
} from '../active-tool-result-prune.js';
import { composeRequestProjection } from '../request-projection.js';
import { ToolAvailabilityRuntime, LOAD_TOOLS_NAME } from '../tool-availability.js';
import type { MakaTool } from '../tool-runtime.js';

describe('active current-turn tool-result pruning', () => {
  test('defaults to pruning current-turn tool results above 2048 estimated tokens', async () => {
    const belowDefault = await rewriteActiveToolResultsInMessages({
      messages: [largeTextToolMessage('Read', 'tool-small', 'a'.repeat(1000 * 4))],
      policy: { enabled: true },
      stepNumber: 1,
      turnId: 'turn-1',
      archiveToolResult: () => ({ artifactId: 'unused' }),
    });
    const aboveDefault = await rewriteActiveToolResultsInMessages({
      messages: [largeTextToolMessage('Read', 'tool-large', 'a'.repeat(2048 * 4 + 4))],
      policy: { enabled: true },
      stepNumber: 1,
      turnId: 'turn-1',
      archiveToolResult: () => ({ artifactId: 'artifact-tool-large' }),
    });

    assert.equal(belowDefault.rewritten, 0);
    assert.equal(aboveDefault.rewritten, 1);
    assert.equal(aboveDefault.diagnosticPatch.activePrunedToolResults, 1);
  });

  test('request projection composes active tools with rewritten messages', async () => {
    const originalMessages = [largeToolMessage('Read', 'tool-1', 'SECRET'.repeat(20))];
    const activePrune = async () => {
      const rewritten = await rewriteActiveToolResultsInMessages({
        messages: originalMessages,
        policy: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
        stepNumber: 1,
        turnId: 'turn-1',
        charsPerToken: 1,
        archiveToolResult: () => ({ artifactId: 'artifact-tool-1' }),
      });
      return rewritten.rewritten > 0 ? { messages: rewritten.messages } : undefined;
    };
    const composed = composeRequestProjection(
      () => ({ activeTools: ['Read', LOAD_TOOLS_NAME] }),
      undefined,
      activePrune,
    );

    assert.ok(composed);
    const result = await composed({
      completedSteps: [],
      stepNumber: 1,
      model: {},
      messages: originalMessages,
    });

    assert.deepEqual(result?.activeTools, ['Read', LOAD_TOOLS_NAME]);
    assert.ok(result?.messages);
    assert.match(JSON.stringify(result.messages), /maka\.active_archived_tool_result/);
  });

  test('oversized eligible current-turn tool result is archived and replaced', async () => {
    const largeBody = 'SECRET_PAYLOAD_SHOULD_BE_ARCHIVED'.repeat(20);
    const archiveRequests: Array<{
      serializedResult: string;
      bodySha256: string;
      toolCallId: string;
    }> = [];
    const archivedPlaceholders = new Map();
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages: [largeToolMessage('Read', 'tool-1', largeBody)],
      policy: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
      stepNumber: 1,
      turnId: 'turn-1',
      charsPerToken: 1,
      archivedPlaceholders,
      archiveToolResult: (candidate) => {
        archiveRequests.push({
          serializedResult: candidate.serializedResult,
          bodySha256: candidate.bodySha256,
          toolCallId: candidate.toolCallId,
        });
        return { artifactId: 'artifact-tool-1' };
      },
    });

    assert.equal(archiveRequests.length, 1);
    assert.match(archiveRequests[0]?.bodySha256 ?? '', /^[a-f0-9]{64}$/);
    assert.equal(archiveRequests[0]?.toolCallId, 'tool-1');
    const secondPrompt = JSON.stringify(rewritten.messages);
    assert.match(secondPrompt, /maka\.active_archived_tool_result/);
    assert.match(secondPrompt, /artifact-tool-1/);
    assert.equal(secondPrompt.includes('maka://archive/'), true);
    assert.match(secondPrompt, /ArchiveRead/);
    assert.match(secondPrompt, /Do not use Glob/);
    assert.equal(secondPrompt.includes(largeBody), false);
  });

  test('archive failure keeps the original tool result', async () => {
    const messages = [largeToolMessage('Read', 'tool-1', 'KEEP_ME'.repeat(20))];
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages,
      policy: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
      stepNumber: 1,
      turnId: 'turn-1',
      charsPerToken: 1,
      archiveToolResult: () => {
        throw new Error('archive unavailable');
      },
    });

    assert.equal(rewritten.rewritten, 0);
    assert.equal(rewritten.archiveFailures, 1);
    assert.deepEqual(rewritten.messages, messages);
    assert.match(JSON.stringify(rewritten.messages), /KEEP_ME/);
    assert.doesNotMatch(JSON.stringify(rewritten.messages), /maka\.active_archived_tool_result/);
  });

  test('archiveRequired false still keeps original when no archive artifact is written', async () => {
    const messages = [largeToolMessage('Read', 'tool-1', 'KEEP_ME'.repeat(20))];
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages,
      policy: {
        enabled: true,
        maxCurrentResultEstimatedTokens: 1,
        archiveRequired: false,
      } as never,
      stepNumber: 1,
      turnId: 'turn-1',
      charsPerToken: 1,
      archiveToolResult: () => undefined,
    });

    assert.equal(rewritten.rewritten, 0);
    assert.equal(rewritten.archiveFailures, 1);
    assert.deepEqual(rewritten.messages, messages);
    assert.match(JSON.stringify(rewritten.messages), /KEEP_ME/);
    assert.doesNotMatch(JSON.stringify(rewritten.messages), /maka\.active_archived_tool_result/);
  });

  test('empty archive artifact id keeps the original tool result', async () => {
    const messages = [largeToolMessage('Read', 'tool-1', 'KEEP_ME'.repeat(20))];
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages,
      policy: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
      stepNumber: 1,
      turnId: 'turn-1',
      charsPerToken: 1,
      archiveToolResult: () => ({ artifactId: '' }),
    });

    assert.equal(rewritten.rewritten, 0);
    assert.equal(rewritten.archiveFailures, 1);
    assert.deepEqual(rewritten.messages, messages);
    assert.match(JSON.stringify(rewritten.messages), /KEEP_ME/);
    assert.doesNotMatch(JSON.stringify(rewritten.messages), /maka\.active_archived_tool_result/);
  });

  test('blank archive artifact id keeps the original tool result', async () => {
    const messages = [largeToolMessage('Read', 'tool-1', 'KEEP_ME'.repeat(20))];
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages,
      policy: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
      stepNumber: 1,
      turnId: 'turn-1',
      charsPerToken: 1,
      archiveToolResult: () => ({ artifactId: '   ' }),
    });

    assert.equal(rewritten.rewritten, 0);
    assert.equal(rewritten.archiveFailures, 1);
    assert.deepEqual(rewritten.messages, messages);
    assert.match(JSON.stringify(rewritten.messages), /KEEP_ME/);
    assert.doesNotMatch(JSON.stringify(rewritten.messages), /maka\.active_archived_tool_result/);
  });

  test('empty-artifact placeholders are not treated as idempotent', async () => {
    const placeholder = invalidActivePlaceholder();
    const messages: ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-json',
            toolName: 'Read',
            output: { type: 'json', value: placeholder as never },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tool-text',
            toolName: 'Read',
            output: { type: 'text', value: JSON.stringify(placeholder) },
          },
        ],
      },
    ];
    const archivedToolCallIds: string[] = [];

    const rewritten = await rewriteActiveToolResultsInMessages({
      messages,
      policy: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
      stepNumber: 1,
      turnId: 'turn-1',
      charsPerToken: 1,
      archiveToolResult: (candidate) => {
        archivedToolCallIds.push(candidate.toolCallId);
        return { artifactId: `artifact-${candidate.toolCallId}` };
      },
    });

    assert.equal(rewritten.rewritten, 2);
    assert.deepEqual(archivedToolCallIds, ['tool-json', 'tool-text']);
    assert.match(JSON.stringify(rewritten.messages), /artifact-tool-json/);
    assert.match(JSON.stringify(rewritten.messages), /artifact-tool-text/);
  });

  test('text placeholder output is idempotent across active prune passes', async () => {
    const messages = [largeTextToolMessage('Read', 'tool-1', 'SECRET'.repeat(20))];
    const first = await rewriteActiveToolResultsInMessages({
      messages,
      policy: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
      stepNumber: 1,
      turnId: 'turn-1',
      charsPerToken: 1,
      archiveToolResult: () => ({ artifactId: 'artifact-tool-1' }),
    });
    const second = await rewriteActiveToolResultsInMessages({
      messages: first.messages,
      policy: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
      stepNumber: 2,
      turnId: 'turn-1',
      charsPerToken: 1,
      archiveToolResult: () => {
        throw new Error('should not re-archive placeholder text');
      },
    });

    assert.equal(first.rewritten, 1);
    assert.equal(second.rewritten, 0);
    assert.equal(second.archiveFailures, 0);
    assert.deepEqual(second.messages, first.messages);
  });

  test('raw result and archive placeholder share a stable lineage identity', async () => {
    const messages = [largeTextToolMessage('Read', 'tool-1', 'SECRET'.repeat(20))];
    const rawPart = (messages[0] as Extract<ModelMessage, { role: 'tool' }>).content[0];
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages,
      policy: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
      stepNumber: 1,
      turnId: 'turn-1',
      charsPerToken: 1,
      archiveToolResult: () => ({ artifactId: 'artifact-tool-1' }),
    });
    const placeholderPart = (rewritten.messages[0] as Extract<ModelMessage, { role: 'tool' }>)
      .content[0];
    const differentPart = (
      largeTextToolMessage('Read', 'tool-1', 'DIFFERENT'.repeat(20)) as Extract<
        ModelMessage,
        { role: 'tool' }
      >
    ).content[0];

    assert.deepEqual(
      activeToolResultLineageIdentity(placeholderPart),
      activeToolResultLineageIdentity(rawPart),
    );
    assert.notDeepEqual(
      activeToolResultLineageIdentity(differentPart),
      activeToolResultLineageIdentity(rawPart),
    );
  });

  test('returns active prune diagnostics for rewritten and failed archives', async () => {
    const success = await rewriteActiveToolResultsInMessages({
      messages: [largeToolMessage('Read', 'tool-1', 'SECRET'.repeat(200))],
      policy: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
      stepNumber: 1,
      turnId: 'turn-1',
      charsPerToken: 1,
      archiveToolResult: () => ({ artifactId: 'artifact-tool-1' }),
    });
    const failure = await rewriteActiveToolResultsInMessages({
      messages: [largeToolMessage('Read', 'tool-2', 'KEEP_ME'.repeat(20))],
      policy: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
      stepNumber: 1,
      turnId: 'turn-1',
      charsPerToken: 1,
      archiveToolResult: () => undefined,
    });

    assert.equal(success.diagnosticPatch.activePrunedToolResults, 1);
    assert.equal(success.diagnosticPatch.activeArchiveFailures, undefined);
    assert.ok((success.diagnosticPatch.activeEstimatedTokensSaved ?? 0) > 0);
    assert.equal(failure.diagnosticPatch.activePrunedToolResults, undefined);
    assert.equal(failure.diagnosticPatch.activeArchiveFailures, 1);
  });

  test('eligible tool-call ids keep prior replay tool results untouched', async () => {
    const priorBody = 'PRIOR_REPLAY_RESULT_SHOULD_STAY_FULL'.repeat(20);
    const currentBody = 'CURRENT_STEP_RESULT_SHOULD_BE_ARCHIVED'.repeat(20);
    const archiveRequests: string[] = [];
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages: [
        largeToolMessage('Read', 'prior-tool-call', priorBody),
        largeToolMessage('Read', 'current-tool-call', currentBody),
      ],
      policy: { enabled: true, maxCurrentResultEstimatedTokens: 1 },
      stepNumber: 1,
      turnId: 'turn-1',
      charsPerToken: 1,
      eligibleToolCallIds: new Set(['current-tool-call']),
      archiveToolResult: (candidate) => {
        archiveRequests.push(candidate.toolCallId);
        return { artifactId: `artifact-${candidate.toolCallId}` };
      },
    });

    assert.equal(rewritten.rewritten, 1);
    assert.deepEqual(archiveRequests, ['current-tool-call']);
    const nextPrompt = JSON.stringify(rewritten.messages);
    assert.match(nextPrompt, /PRIOR_REPLAY_RESULT_SHOULD_STAY_FULL/);
    assert.doesNotMatch(nextPrompt, /CURRENT_STEP_RESULT_SHOULD_BE_ARCHIVED/);
    assert.match(nextPrompt, /artifact-current-tool-call/);
  });

  test('tool activation still works when active pruning shares the projection pipeline', async () => {
    const runtime = new ToolAvailabilityRuntime(
      [makaTool('Read'), makaTool('RiveWorkflow')],
      { economy: true, groups: [{ id: 'rive', toolNames: ['RiveWorkflow'] }] },
      makaTool('invalid'),
    );
    const plan = runtime.prepare([]);
    const activePrune = async (options: { messages: ModelMessage[]; stepNumber: number }) => {
      const rewritten = await rewriteActiveToolResultsInMessages({
        messages: options.messages,
        policy: { enabled: true, maxCurrentResultEstimatedTokens: 1024 },
        stepNumber: options.stepNumber,
        turnId: 'turn-1',
        archiveToolResult: () => ({ artifactId: 'unused' }),
      });
      return rewritten.rewritten > 0 ? { messages: rewritten.messages } : undefined;
    };

    const projection = composeRequestProjection(
      ({ completedSteps }) => plan.projectActiveTools!({ completedSteps }),
      undefined,
      activePrune,
    );
    const result = await projection!({
      completedSteps: [
        {
          toolCalls: [
            {
              type: 'tool-call',
              toolCallId: 'load-1',
              toolName: LOAD_TOOLS_NAME,
              input: { group: 'rive' },
            },
          ],
        },
      ],
      stepNumber: 1,
      model: {},
      messages: [{ role: 'user', content: 'load rive' }],
      activeTools: plan.activeTools,
    });

    assert.ok(!plan.activeTools.includes('RiveWorkflow'), 'step 0 hides the group tool');
    assert.ok(
      result?.activeTools?.includes('RiveWorkflow'),
      'step 1 advertises the loaded group tool',
    );
  });
});

function largeToolMessage(toolName: string, toolCallId: string, body: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'json', value: { body } },
      },
    ],
  };
}

function largeTextToolMessage(toolName: string, toolCallId: string, body: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'text', value: body },
      },
    ],
  };
}

function invalidActivePlaceholder(): Record<string, unknown> {
  return {
    kind: 'maka.active_archived_tool_result',
    rewriteVersion: 1,
    artifactId: '',
    turnId: 'turn-1',
    toolCallId: 'tool-old',
    toolName: 'Read',
    bodySha256: 'a'.repeat(64),
    originalEstimatedTokens: 100,
    originalBytes: 400,
    reason: 'active_current_turn_tool_result_pruned_before_next_step',
  };
}

function makaTool(name: string): MakaTool {
  return {
    name,
    description: `${name} tool`,
    parameters: z.object({}),
    impl: () => ({ ok: true }),
  };
}
