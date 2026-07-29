import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { RuntimeEvent } from '@maka/core';
import type { InvocationResult } from '@maka/runtime';
import {
  buildHarborCellOutput,
  validateHarborCellExecutionIdentity,
  validateHarborCellOutput,
  type HarborCellOutput,
} from '../cell-output.js';

describe('Harbor cell output contract', () => {
  test('rejects non-catalog names in a new product-tool surface identity', () => {
    assert.throws(
      () =>
        validateHarborCellExecutionIdentity({
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
          systemPromptHash: 'sha256:prompt-a',
          pricingProfile: 'public',
          agentTools: false,
          productToolSurface: {
            policy: { economy: true, disabledSurfaceIds: ['agent'] },
            productToolNames: ['Read', 'not_a_catalog_tool'],
          },
        }),
      /productToolNames.*not_a_catalog_tool.*catalog/,
    );
  });

  test('rejects a non-canonical disabled-surface policy in a new identity', () => {
    assert.throws(
      () =>
        validateHarborCellExecutionIdentity({
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
          systemPromptHash: 'sha256:prompt-a',
          pricingProfile: 'public',
          agentTools: false,
          productToolSurface: {
            policy: { economy: true, disabledSurfaceIds: ['office', 'agent'] },
            productToolNames: ['Read'],
          },
        }),
      /disabledSurfaceIds must be sorted and unique/,
    );
  });

  test('rejects unknown disabled surfaces in a new identity', () => {
    assert.throws(
      () =>
        validateHarborCellExecutionIdentity({
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
          systemPromptHash: 'sha256:prompt-a',
          pricingProfile: 'public',
          agentTools: true,
          productToolSurface: {
            policy: { economy: true, disabledSurfaceIds: ['agnet'] },
            productToolNames: ['Read'],
          },
        }),
      /disabledSurfaceIds.*agnet.*catalog/,
    );
  });

  test('rejects non-canonical effective product-tool names in a new identity', () => {
    assert.throws(
      () =>
        validateHarborCellExecutionIdentity({
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
          systemPromptHash: 'sha256:prompt-a',
          pricingProfile: 'public',
          agentTools: false,
          productToolSurface: {
            policy: { economy: true, disabledSurfaceIds: ['agent'] },
            productToolNames: ['Read', 'Read'],
          },
        }),
      /productToolNames must be sorted and unique/,
    );
  });

  test('rejects product tools that belong to a disabled surface', () => {
    assert.throws(
      () =>
        validateHarborCellExecutionIdentity({
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
          systemPromptHash: 'sha256:prompt-a',
          pricingProfile: 'public',
          agentTools: false,
          productToolSurface: {
            policy: { economy: true, disabledSurfaceIds: ['agent'] },
            productToolNames: ['Read', 'agent_spawn'],
          },
        }),
      /agent_spawn.*disabled surface "agent"/,
    );
  });

  test('requires legacy agentTools to match the effective product-tool names', () => {
    assert.throws(
      () =>
        validateHarborCellExecutionIdentity({
          llmConnectionSlug: 'deepseek',
          model: 'deepseek-v4-flash',
          systemPromptHash: 'sha256:prompt-a',
          pricingProfile: 'public',
          agentTools: true,
          productToolSurface: {
            policy: { economy: true, disabledSurfaceIds: [] },
            productToolNames: ['Read'],
          },
        }),
      /agentTools must match.*effective product-tool surface/,
    );
  });

  test('records a harness-owned prompt against its pinned build instead of a Maka hash', () => {
    assert.deepEqual(
      validateHarborCellExecutionIdentity({
        llmConnectionSlug: 'zai-coding-plan',
        model: 'glm-5.2',
        systemPromptAuthority: 'harness-native',
        systemPromptToolchain: 'sha256:opencode-toolchain',
        pricingProfile: 'zai-public',
        agentTools: false,
      }),
      {
        llmConnectionSlug: 'zai-coding-plan',
        model: 'glm-5.2',
        systemPromptAuthority: 'harness-native',
        systemPromptToolchain: 'sha256:opencode-toolchain',
        pricingProfile: 'zai-public',
        agentTools: false,
      },
    );
  });

  test('rejects a harness-owned prompt identity that also claims a Maka prompt hash', () => {
    assert.throws(
      () =>
        validateHarborCellExecutionIdentity({
          llmConnectionSlug: 'zai-coding-plan',
          model: 'glm-5.2',
          systemPromptAuthority: 'harness-native',
          systemPromptHash: 'sha256:prompt-a',
          systemPromptToolchain: 'sha256:opencode-toolchain',
          pricingProfile: 'zai-public',
          agentTools: false,
        }),
      /systemPromptHash must be absent when the harness owns the system prompt/,
    );
  });

  test('rejects a harness-owned prompt identity without a pinned build', () => {
    assert.throws(
      () =>
        validateHarborCellExecutionIdentity({
          llmConnectionSlug: 'zai-coding-plan',
          model: 'glm-5.2',
          systemPromptAuthority: 'harness-native',
          pricingProfile: 'zai-public',
          agentTools: false,
        }),
      /systemPromptToolchain must pin the harness build/,
    );
  });

  test('keeps decoding a legacy identity that omits the prompt authority', () => {
    const identity = validateHarborCellExecutionIdentity({
      llmConnectionSlug: 'deepseek',
      model: 'deepseek-v4-flash',
      systemPromptHash: 'sha256:prompt-a',
      pricingProfile: 'public',
      agentTools: false,
    });

    assert.equal(identity.systemPromptAuthority, undefined);
    assert.equal(identity.systemPromptHash, 'sha256:prompt-a');
  });

  test('summarizes runtime outcome, prompt hash, token cost, and event path', () => {
    const events: RuntimeEvent[] = [
      runtimeEvent({ id: 'user-event' }),
      runtimeEvent({
        id: 'usage-1',
        actions: {
          tokenUsage: {
            input: 10,
            output: 5,
            cacheHitInput: 4,
            cacheMissInput: 6,
            cacheWriteInput: 1,
            cacheMissInputSource: 'explicit',
            reasoning: 2,
            total: 17,
            runtimeSteps: 1,
            costUsd: 0.00123,
            systemPromptHash: 'sha256:prompt-a',
            promptSegments: [
              { kind: 'tool_schema', chars: 700, estimatedTokens: 175, toolCount: 6 },
            ],
          },
        },
      }),
      runtimeEvent({
        id: 'call-read',
        content: { kind: 'function_call', id: 'tool-1', name: 'Read', args: { path: 'vm.js' } },
      }),
      runtimeEvent({
        id: 'call-bash',
        content: {
          kind: 'function_call',
          id: 'tool-2',
          name: 'Bash',
          args: { command: 'node vm.js' },
        },
      }),
      runtimeEvent({
        id: 'usage-2',
        actions: {
          tokenUsage: {
            input: 3,
            output: 7,
            cacheRead: 2,
            cacheCreation: 1,
            total: 10,
            runtimeSteps: 1,
            costUsd: 0.004,
            systemPromptHash: 'sha256:prompt-a',
          },
        },
      }),
    ];
    const invocation: InvocationResult = {
      invocationId: 'inv-1',
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      status: 'completed',
      events,
      startedAt: 100,
      finishedAt: 250,
    };

    const output = buildHarborCellOutput({
      invocation,
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    });

    assert.deepEqual(validateHarborCellOutput(output), output);
    assert.deepEqual(output, {
      schemaVersion: 1,
      status: 'completed',
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
      promptHash: 'sha256:prompt-a',
      tokenSummary: {
        input: 13,
        output: 12,
        cachedInput: 6,
        cacheHitInput: 6,
        cacheMissInput: 6,
        cacheWriteInput: 2,
        cacheMissInputSource: 'explicit',
        reasoning: 2,
        total: 27,
        costUsd: 0.00523,
        pricingSource: 'runtime',
      },
      toolSummary: {
        providerVisibleToolCount: 6,
        actualToolCalls: 2,
        actualToolNames: ['Bash', 'Read'],
        actualToolCallCounts: { Bash: 1, Read: 1 },
      },
      steps: 2,
      durationMs: 150,
      startedAt: 100,
      finishedAt: 250,
      runtimeRefs: {
        invocationId: 'inv-1',
        sessionId: 'session-1',
        runId: 'run-1',
        turnId: 'turn-1',
      },
    });
  });

  test('preserves the actual execution identity reported by the cell', () => {
    const output = buildHarborCellOutput({
      invocation: invocationFixture(),
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    });
    const validated = validateHarborCellOutput({
      ...output,
      executionIdentity: {
        llmConnectionSlug: 'deepseek',
        model: 'deepseek-v4-flash',
        reasoningEffort: 'max',
        systemPromptMode: 'custom',
        systemPromptHash: 'sha256:prompt-a',
        pricingProfile: 'deepseek-v4-flash-tbench-v1',
        agentTools: true,
        productToolSurface: {
          policy: { economy: true, disabledSurfaceIds: [] },
          productToolNames: ['Bash', 'agent_spawn'],
        },
        supplementalToolSets: [
          { label: 'heavy_task_progress', toolNames: ['inventory_submit', 'todo_update'] },
        ],
      },
    }) as HarborCellOutput & { executionIdentity?: unknown };

    assert.deepEqual(validated.executionIdentity, {
      llmConnectionSlug: 'deepseek',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
      systemPromptMode: 'custom',
      systemPromptHash: 'sha256:prompt-a',
      pricingProfile: 'deepseek-v4-flash-tbench-v1',
      agentTools: true,
      productToolSurface: {
        policy: { economy: true, disabledSurfaceIds: [] },
        productToolNames: ['Bash', 'agent_spawn'],
      },
      supplementalToolSets: [
        { label: 'heavy_task_progress', toolNames: ['inventory_submit', 'todo_update'] },
      ],
    });
  });

  test('persists a real-provider failure when token usage is unavailable', () => {
    const output = buildHarborCellOutput({
      invocation: {
        invocationId: 'inv-missing-usage',
        runId: 'run-missing-usage',
        sessionId: 'session-1',
        turnId: 'turn-1',
        status: 'failed',
        failure: { class: 'network' },
        events: [runtimeEvent({ id: 'user-event', role: 'user', author: 'user' })],
        startedAt: 100,
        finishedAt: 250,
      },
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
      executionIdentity: {
        llmConnectionSlug: 'zai-coding-plan',
        model: 'glm-5.2',
        systemPromptHash: 'sha256:prompt-a',
        pricingProfile: 'zai-public',
      },
    });

    assert.equal(output.status, 'failed');
    assert.equal(output.errorClass, 'network');
    assert.equal('tokenSummary' in output, false);
    assert.deepEqual(validateHarborCellOutput(output), output);
  });

  test('keeps output when runtime emits more than one prompt hash', () => {
    const output = buildHarborCellOutput({
      invocation: {
        invocationId: 'inv-1',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        status: 'completed',
        events: [
          runtimeEvent({
            id: 'usage-1',
            actions: { tokenUsage: { input: 1, output: 0, systemPromptHash: 'sha256:prompt-a' } },
          }),
          runtimeEvent({
            id: 'usage-2',
            actions: { tokenUsage: { input: 0, output: 1, systemPromptHash: 'sha256:prompt-b' } },
          }),
        ],
        startedAt: 100,
        finishedAt: 250,
      },
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    });

    assert.equal(output.promptHash, 'sha256:prompt-a');
  });

  test('derives total tokens when runtime events omit an explicit total', () => {
    const output = buildHarborCellOutput({
      invocation: {
        invocationId: 'inv-1',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        status: 'completed',
        events: [
          runtimeEvent({
            id: 'usage-1',
            actions: { tokenUsage: { input: 10, output: 5, reasoning: 2 } },
          }),
          runtimeEvent({
            id: 'usage-2',
            actions: { tokenUsage: { input: 3, output: 7 } },
          }),
        ],
        startedAt: 100,
        finishedAt: 250,
      },
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    });

    assert.ok(output.tokenSummary);
    assert.equal(output.tokenSummary.input, 13);
    assert.equal(output.tokenSummary.output, 12);
    assert.equal(output.tokenSummary.reasoning, 2);
    assert.equal(output.tokenSummary.total, 27);
  });

  test('counts completed model steps instead of streaming event chunks', () => {
    const partialChunks = Array.from({ length: 100 }, (_, index) =>
      runtimeEvent({
        id: `partial-${index}`,
        partial: true,
        content: { kind: 'text', text: 'x' },
      }),
    );
    const output = buildHarborCellOutput({
      invocation: {
        invocationId: 'inv-stream-steps',
        runId: 'run-stream-steps',
        sessionId: 'session-1',
        turnId: 'turn-1',
        status: 'failed',
        failure: { class: 'network' },
        events: [
          ...partialChunks,
          runtimeEvent({ id: 'final-thinking', content: { kind: 'thinking', text: 'done' } }),
          runtimeEvent({ id: 'final-text', content: { kind: 'text', text: '' } }),
        ],
        startedAt: 100,
        finishedAt: 250,
      },
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    });

    assert.equal(output.steps, 1);
  });

  test('counts a pure-tool step when runtime usage does not report steps', () => {
    const output = buildHarborCellOutput({
      invocation: {
        invocationId: 'inv-tool-steps',
        runId: 'run-tool-steps',
        sessionId: 'session-1',
        turnId: 'turn-1',
        status: 'completed',
        events: [
          runtimeEvent({
            id: 'tool-step',
            content: { kind: 'function_call', id: 'call-1', name: 'Read', args: {} },
            refs: { toolCallId: 'call-1', stepId: 'step-1' },
          }),
          runtimeEvent({
            id: 'final-text',
            content: { kind: 'text', text: 'done' },
            refs: { providerEventId: 'step-2' },
          }),
        ],
        startedAt: 100,
        finishedAt: 250,
      },
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    });

    assert.equal(output.steps, 2);
  });

  test('uses step identity only for turns whose runtime step usage is unavailable', () => {
    const output = buildHarborCellOutput({
      invocation: {
        invocationId: 'inv-mixed-steps',
        runId: 'run-mixed-steps',
        sessionId: 'session-1',
        turnId: 'turn-2',
        status: 'failed',
        failure: { class: 'tool_step_cap_reached' },
        events: [
          runtimeEvent({
            id: 'reported-turn',
            turnId: 'turn-1',
            actions: { tokenUsage: { input: 1, output: 1, runtimeSteps: 1 } },
          }),
          runtimeEvent({
            id: 'unmetered-tool-step',
            turnId: 'turn-2',
            content: { kind: 'function_call', id: 'call-2', name: 'Read', args: {} },
            refs: { toolCallId: 'call-2', stepId: 'step-2' },
          }),
        ],
        startedAt: 100,
        finishedAt: 250,
      },
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    });

    assert.equal(output.steps, 2);
  });

  test('summarizes context budget diagnostics from token usage events', () => {
    const output = buildHarborCellOutput({
      invocation: {
        invocationId: 'inv-1',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        status: 'completed',
        events: [
          runtimeEvent({
            id: 'usage-1',
            actions: {
              tokenUsage: {
                input: 10,
                output: 2,
                contextBudget: {
                  enabled: true,
                  policyName: 'prune-on',
                  estimatedTokensBefore: 1000,
                  estimatedTokensAfter: 600,
                  keptTurns: 3,
                  droppedTurns: 2,
                  keptEvents: 8,
                  droppedEvents: 5,
                  prunedToolResults: 2,
                  activePrunedToolResults: 3,
                  activeEstimatedTokensSaved: 450,
                  activeArchiveFailures: 1,
                  archivePlaceholders: 2,
                  archivePlaceholderReasonCounts: { active_prune: 1, stale_prune: 1 },
                  archiveWriteFailures: 1,
                  retrievedArchiveToolResults: 1,
                  retrievedArchiveEstimatedTokens: 120,
                  archiveRetrievalSkipped: 3,
                  archiveRetrievalSkippedReasonCounts: { max_bytes: 2, max_results: 1 },
                  archiveRetrievalFailures: 1,
                  archiveRetrievalFailureReasonCounts: { corrupt: 1 },
                  compactionDecisions: [
                    {
                      stage: 'activeStep',
                      sourceKind: 'providerMessages',
                      decision: 'replaced',
                      boundaryKind: 'semanticCompact',
                      compactCallInputTokens: 31,
                      compactCallOutputTokens: 11,
                      compactCallCacheReadInputTokens: 7,
                      compactCallCacheWriteInputTokens: 2,
                      compactCallTotalTokens: 42,
                    },
                  ],
                },
              },
            },
          }),
          runtimeEvent({
            id: 'usage-2',
            actions: {
              tokenUsage: {
                input: 5,
                output: 1,
                contextBudget: {
                  enabled: false,
                  estimatedTokensBefore: 200,
                  estimatedTokensAfter: 200,
                  keptTurns: 1,
                  droppedTurns: 0,
                  keptEvents: 2,
                  droppedEvents: 0,
                },
              },
            },
          }),
        ],
        startedAt: 100,
        finishedAt: 250,
      },
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    });

    assert.deepEqual(output.contextBudgetSummary, {
      diagnosticEvents: 2,
      enabledEvents: 1,
      estimatedTokensBefore: 1200,
      estimatedTokensAfter: 800,
      keptTurns: 4,
      droppedTurns: 2,
      keptEvents: 10,
      droppedEvents: 5,
      prunedToolResults: 2,
      activePrunedToolResults: 3,
      activeEstimatedTokensSaved: 450,
      activeArchiveFailures: 1,
      archivePlaceholders: 2,
      archivePlaceholderReasonCounts: { active_prune: 1, stale_prune: 1 },
      archiveWriteFailures: 1,
      retrievedArchiveToolResults: 1,
      retrievedArchiveEstimatedTokens: 120,
      archiveRetrievalSkipped: 3,
      archiveRetrievalSkippedReasonCounts: { max_bytes: 2, max_results: 1 },
      archiveRetrievalFailures: 1,
      archiveRetrievalFailureReasonCounts: { corrupt: 1 },
      semanticCompactCallInputTokens: 31,
      semanticCompactCallOutputTokens: 11,
      semanticCompactCallCacheReadInputTokens: 7,
      semanticCompactCallCacheWriteInputTokens: 2,
      semanticCompactCallTotalTokens: 42,
    });
    assert.deepEqual(validateHarborCellOutput(output), output);
  });

  test('summarizes todo_write task experiment activation', () => {
    const output = buildHarborCellOutput({
      invocation: {
        invocationId: 'inv-1',
        runId: 'run-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        status: 'completed',
        events: [
          runtimeEvent({
            id: 'todo-write',
            content: {
              kind: 'function_call',
              id: 'tool-6',
              name: 'todo_write',
              args: {
                todos: [{ content: 'Run focused check', status: 'pending', priority: 'high' }],
              },
            },
          }),
        ],
        startedAt: 100,
        finishedAt: 250,
      },
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    });

    assert.deepEqual(output.taskToolSummary, {
      todoWriteCalls: 1,
    });
    assert.deepEqual(validateHarborCellOutput(output), output);
  });

  test('records zero task tool calls only when the task tool experiment is enabled', () => {
    const invocation: InvocationResult = {
      invocationId: 'inv-task-tools-zero',
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-1',
      status: 'completed',
      events: [
        runtimeEvent({
          id: 'regular-tool',
          content: {
            kind: 'function_call',
            id: 'tool-regular',
            name: 'Read',
            args: { path: 'README.md' },
          },
        }),
      ],
      startedAt: 100,
      finishedAt: 250,
    };

    const disabled = buildHarborCellOutput({
      invocation,
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
    });
    assert.equal(disabled.taskToolSummary, undefined);

    const enabled = buildHarborCellOutput({
      invocation,
      runtimeEventsPath: '/logs/agent/runtime-events.jsonl',
      taskToolSummaryEnabled: true,
    });
    assert.deepEqual(enabled.taskToolSummary, {
      todoWriteCalls: 0,
    });
    assert.deepEqual(validateHarborCellOutput(enabled), enabled);
  });
});

function runtimeEvent(extra: Partial<RuntimeEvent>): RuntimeEvent {
  return {
    id: extra.id ?? 'event',
    sessionId: 'session-1',
    invocationId: 'inv-1',
    runId: 'run-1',
    turnId: 'turn-1',
    ts: 100,
    partial: false,
    role: 'model',
    author: 'agent',
    ...extra,
  };
}

function invocationFixture(): InvocationResult {
  return {
    invocationId: 'inv-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    status: 'completed',
    events: [],
    startedAt: 100,
    finishedAt: 250,
  };
}
