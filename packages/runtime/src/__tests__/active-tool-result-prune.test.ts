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
import { z } from 'zod';
import type { ModelMessage } from '../model-protocol.js';

import {
  activeToolResultLineageIdentity,
  rewriteActiveToolResultsInMessages,
} from '../active-tool-result-prune.js';
import { planActiveToolResultSupersession } from '../active-tool-result-working-set.js';
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

  test('archives an exact duplicate below the ordinary size threshold', async () => {
    const body = 'DUPLICATE_OBSERVATION'.repeat(80);
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages: [
        largeToolMessage('CustomQuery', 'tool-old', body),
        largeToolMessage('CustomQuery', 'tool-new', body),
      ],
      policy: {
        enabled: true,
        maxCurrentResultEstimatedTokens: 10_000,
        minSupersededResultEstimatedTokens: 1,
      },
      stepNumber: 2,
      turnId: 'turn-1',
      charsPerToken: 1,
      completedToolCalls: [
        completedCall('CustomQuery', 'tool-old', { query: 'status' }, 0),
        completedCall('CustomQuery', 'tool-new', { query: 'status' }, 1),
      ],
      eligibleToolCallIds: new Set(['tool-old']),
      archiveToolResult: () => ({ artifactId: 'artifact-tool-old' }),
    });

    assert.equal(rewritten.rewritten, 1);
    assert.equal(rewritten.diagnosticPatch.activeSupersededToolResults, 1);
    assert.equal(rewritten.diagnosticPatch.activeDuplicateToolResults, 1);
    const prompt = JSON.stringify(rewritten.messages);
    assert.match(prompt, /exact_duplicate/);
    assert.match(prompt, /tool-new/);
    assert.equal(prompt.split(body).length - 1, 1, 'only the newest full body remains');

    const secondPass = await rewriteActiveToolResultsInMessages({
      messages: rewritten.messages,
      policy: {
        enabled: true,
        maxCurrentResultEstimatedTokens: 10_000,
        minSupersededResultEstimatedTokens: 1,
      },
      stepNumber: 3,
      turnId: 'turn-1',
      charsPerToken: 1,
      completedToolCalls: [
        completedCall('CustomQuery', 'tool-old', { query: 'status' }, 0),
        completedCall('CustomQuery', 'tool-new', { query: 'status' }, 1),
      ],
      eligibleToolCallIds: new Set(['tool-old']),
      archiveToolResult: () => {
        throw new Error('supersession placeholder must be idempotent');
      },
    });
    assert.equal(secondPass.rewritten, 0);
    assert.deepEqual(secondPass.messages, rewritten.messages);
  });

  test('a newer Read covering the old range supersedes different old content', async () => {
    const oldBody = 'OLD_FILE_CONTENT'.repeat(100);
    const newBody = 'NEW_FILE_CONTENT'.repeat(100);
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages: [
        largeToolMessage('Read', 'read-old', oldBody),
        largeToolMessage('Read', 'read-new', newBody),
      ],
      policy: {
        enabled: true,
        maxCurrentResultEstimatedTokens: 10_000,
        minSupersededResultEstimatedTokens: 1,
      },
      stepNumber: 2,
      turnId: 'turn-1',
      charsPerToken: 1,
      completedToolCalls: [
        completedCall('Read', 'read-old', { path: './src/a.ts', offset: 20, limit: 10 }, 0),
        completedCall('Read', 'read-new', { path: 'src/a.ts', offset: 0, limit: 100 }, 1),
      ],
      eligibleToolCallIds: new Set(['read-old']),
      archiveToolResult: () => ({ artifactId: 'artifact-read-old' }),
    });

    assert.equal(rewritten.rewritten, 1);
    assert.match(JSON.stringify(rewritten.messages), /newer_read_covers_range/);
    assert.doesNotMatch(JSON.stringify(rewritten.messages), /OLD_FILE_CONTENT/);
    assert.match(JSON.stringify(rewritten.messages), /NEW_FILE_CONTENT/);
  });

  test('keeps platform-dependent filesystem path spellings as distinct subjects', () => {
    const cases = [
      {
        toolName: 'Read',
        first: { path: ' target.ts' },
        second: { path: 'target.ts' },
      },
      {
        toolName: 'Read',
        first: { path: 'dir\\target.ts' },
        second: { path: 'dir/target.ts' },
      },
      {
        toolName: 'Glob',
        first: { pattern: '**/*.ts', cwd: '//server/share' },
        second: { pattern: '**/*.ts', cwd: '/server/share' },
      },
      {
        toolName: 'Grep',
        first: { pattern: 'TODO', path: '\\\\server\\share' },
        second: { pattern: 'TODO', path: '//server/share' },
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      const decisions = planActiveToolResultSupersession([
        {
          toolCallId: `old-${index}`,
          toolName: testCase.toolName,
          input: testCase.first,
          stepNumber: 0,
          bodySha256: `old-body-${index}`,
          isError: false,
          eligible: true,
        },
        {
          toolCallId: `new-${index}`,
          toolName: testCase.toolName,
          input: testCase.second,
          stepNumber: 1,
          bodySha256: `new-body-${index}`,
          isError: false,
          eligible: true,
        },
      ]);

      assert.equal(decisions.size, 0, `${testCase.toolName} case ${index} must fail open`);
    }
  });

  test('does not merge parallel or non-covering Read observations', async () => {
    const messages = [
      largeToolMessage('Read', 'read-left', 'LEFT'.repeat(300)),
      largeToolMessage('Read', 'read-right', 'RIGHT'.repeat(300)),
      largeToolMessage('Read', 'read-parallel', 'PARALLEL'.repeat(300)),
    ];
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages,
      policy: {
        enabled: true,
        maxCurrentResultEstimatedTokens: 10_000,
        minSupersededResultEstimatedTokens: 1,
      },
      stepNumber: 2,
      turnId: 'turn-1',
      charsPerToken: 1,
      completedToolCalls: [
        completedCall('Read', 'read-left', { path: 'a.ts', offset: 0, limit: 10 }, 0),
        completedCall('Read', 'read-right', { path: 'a.ts', offset: 20, limit: 10 }, 1),
        completedCall('Read', 'read-parallel', { path: 'a.ts', offset: 0, limit: 100 }, 0),
      ],
      eligibleToolCallIds: new Set(['read-left', 'read-parallel']),
      archiveToolResult: () => ({ artifactId: 'unused' }),
    });

    assert.equal(rewritten.rewritten, 0);
    assert.deepEqual(rewritten.messages, messages);
  });

  test('supersedes matching search snapshots and resolved failures', async () => {
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages: [
        errorToolMessage('Grep', 'grep-old', 'FAILED_SEARCH'.repeat(100)),
        largeToolMessage('Grep', 'grep-new', 'MATCHES'.repeat(200)),
      ],
      policy: {
        enabled: true,
        maxCurrentResultEstimatedTokens: 10_000,
        minSupersededResultEstimatedTokens: 1,
      },
      stepNumber: 2,
      turnId: 'turn-1',
      charsPerToken: 1,
      completedToolCalls: [
        completedCall('Grep', 'grep-old', { pattern: 'TODO', path: './src' }, 0),
        completedCall('Grep', 'grep-new', { path: 'src', pattern: 'TODO' }, 1),
      ],
      eligibleToolCallIds: new Set(['grep-old']),
      archiveToolResult: () => ({ artifactId: 'artifact-grep-old' }),
    });

    assert.equal(rewritten.rewritten, 1);
    const prompt = JSON.stringify(rewritten.messages);
    assert.match(prompt, /failure_resolved/);
    assert.match(prompt, /failureBodySha256/);
    assert.match(prompt, /grep-new/);
  });

  test('a newer failed snapshot does not replace the last successful evidence', async () => {
    const messages = [
      largeToolMessage('Glob', 'glob-old', 'FILES'.repeat(300)),
      errorToolMessage('Glob', 'glob-new', 'SEARCH_FAILED'.repeat(100)),
    ];
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages,
      policy: {
        enabled: true,
        maxCurrentResultEstimatedTokens: 10_000,
        minSupersededResultEstimatedTokens: 1,
      },
      stepNumber: 2,
      turnId: 'turn-1',
      charsPerToken: 1,
      completedToolCalls: [
        completedCall('Glob', 'glob-old', { pattern: '**/*.ts' }, 0),
        completedCall('Glob', 'glob-new', { pattern: '**/*.ts' }, 1),
      ],
      eligibleToolCallIds: new Set(['glob-old']),
      archiveToolResult: () => ({ artifactId: 'unused' }),
    });

    assert.equal(rewritten.rewritten, 0);
    assert.deepEqual(rewritten.messages, messages);
  });

  test('a same-value failure is not an exact duplicate of the last success', async () => {
    const body = 'SAME_OBSERVATION'.repeat(100);
    const messages = [
      largeToolMessage('CustomQuery', 'query-success', body),
      errorToolMessage('CustomQuery', 'query-failure', body),
    ];
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages,
      policy: {
        enabled: true,
        maxCurrentResultEstimatedTokens: 10_000,
        minSupersededResultEstimatedTokens: 1,
      },
      stepNumber: 2,
      turnId: 'turn-1',
      charsPerToken: 1,
      completedToolCalls: [
        completedCall('CustomQuery', 'query-success', { query: 'status' }, 0),
        completedCall('CustomQuery', 'query-failure', { query: 'status' }, 1),
      ],
      eligibleToolCallIds: new Set(['query-success']),
      archiveToolResult: () => ({ artifactId: 'unused' }),
    });

    assert.equal(rewritten.rewritten, 0);
    assert.deepEqual(rewritten.messages, messages);
  });

  test('only allowlisted Bash snapshots participate in semantic supersession', async () => {
    const messages = [
      largeToolMessage('Bash', 'status-old', 'OLD_STATUS'.repeat(200)),
      largeToolMessage('Bash', 'status-new', 'NEW_STATUS'.repeat(200)),
      largeToolMessage('Bash', 'write-old', 'OLD_WRITE'.repeat(200)),
      largeToolMessage('Bash', 'write-new', 'NEW_WRITE'.repeat(200)),
    ];
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages,
      policy: {
        enabled: true,
        maxCurrentResultEstimatedTokens: 10_000,
        minSupersededResultEstimatedTokens: 1,
      },
      stepNumber: 4,
      turnId: 'turn-1',
      charsPerToken: 1,
      completedToolCalls: [
        completedCall('Bash', 'status-old', { command: 'git status --short' }, 0),
        completedCall('Bash', 'status-new', { command: 'git status --short' }, 1),
        completedCall('Bash', 'write-old', { command: 'printf data > out.txt' }, 2),
        completedCall('Bash', 'write-new', { command: 'printf data > out.txt' }, 3),
      ],
      eligibleToolCallIds: new Set(['status-old', 'write-old']),
      archiveToolResult: ({ toolCallId }) => ({ artifactId: `artifact-${toolCallId}` }),
    });

    assert.equal(rewritten.rewritten, 1);
    const prompt = JSON.stringify(rewritten.messages);
    assert.match(prompt, /newer_snapshot/);
    assert.doesNotMatch(prompt, /OLD_STATUS/);
    assert.match(prompt, /OLD_WRITE/);
  });

  test('test and build runs keep distinct warnings and failures visible', async () => {
    const messages = [
      largeToolMessage('Bash', 'build-warning', 'BUILD_DEPRECATION_WARNING'.repeat(100)),
      largeToolMessage('Bash', 'build-clean', 'BUILD_FROM_INCREMENTAL_CACHE'.repeat(100)),
      errorToolMessage('Bash', 'test-failure', 'FLAKY_TEST_FAILURE'.repeat(100)),
      largeToolMessage('Bash', 'test-success', 'TESTS_PASSED'.repeat(100)),
    ];
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages,
      policy: {
        enabled: true,
        maxCurrentResultEstimatedTokens: 10_000,
        minSupersededResultEstimatedTokens: 1,
      },
      stepNumber: 4,
      turnId: 'turn-1',
      charsPerToken: 1,
      completedToolCalls: [
        completedCall('Bash', 'build-warning', { command: 'npm run build' }, 0),
        completedCall('Bash', 'build-clean', { command: 'npm run build' }, 1),
        completedCall('Bash', 'test-failure', { command: 'cargo test' }, 2),
        completedCall('Bash', 'test-success', { command: 'cargo test' }, 3),
      ],
      eligibleToolCallIds: new Set(['build-warning', 'test-failure']),
      archiveToolResult: () => ({ artifactId: 'unused' }),
    });

    assert.equal(rewritten.rewritten, 0);
    assert.deepEqual(rewritten.messages, messages);
  });

  test('foreground Bash output is not superseded by background or PTY handles', async () => {
    const messages = [
      largeToolMessage('Bash', 'test-foreground', 'FOREGROUND_TEST_OUTPUT'),
      largeToolMessage('Bash', 'test-background', 'BACKGROUND_JOB_REF'),
      largeToolMessage('Bash', 'test-pty', 'PTY_JOB_REF'),
    ];
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages,
      policy: {
        enabled: true,
        maxCurrentResultEstimatedTokens: 10_000,
        minSupersededResultEstimatedTokens: 1,
      },
      stepNumber: 3,
      turnId: 'turn-1',
      charsPerToken: 1,
      completedToolCalls: [
        completedCall('Bash', 'test-foreground', { command: 'npm test' }, 0),
        completedCall(
          'Bash',
          'test-background',
          { command: 'npm test', run_in_background: true },
          1,
        ),
        completedCall(
          'Bash',
          'test-pty',
          { command: 'npm test', run_in_background: true, pty: true },
          2,
        ),
      ],
      eligibleToolCallIds: new Set(['test-foreground', 'test-background']),
      archiveToolResult: () => ({ artifactId: 'unused' }),
    });

    assert.equal(rewritten.rewritten, 0);
    assert.deepEqual(rewritten.messages, messages);
  });

  test('distinct background Bash job refs remain independently visible', async () => {
    const messages = [
      largeToolMessage('Bash', 'job-a', 'BACKGROUND_JOB_REF_A'),
      largeToolMessage('Bash', 'job-b', 'BACKGROUND_JOB_REF_B'),
    ];
    const rewritten = await rewriteActiveToolResultsInMessages({
      messages,
      policy: {
        enabled: true,
        maxCurrentResultEstimatedTokens: 10_000,
        minSupersededResultEstimatedTokens: 1,
      },
      stepNumber: 2,
      turnId: 'turn-1',
      charsPerToken: 1,
      completedToolCalls: [
        completedCall('Bash', 'job-a', { command: 'npm test', run_in_background: true }, 0),
        completedCall('Bash', 'job-b', { command: 'npm test', run_in_background: true }, 1),
      ],
      eligibleToolCallIds: new Set(['job-a']),
      archiveToolResult: () => ({ artifactId: 'unused' }),
    });

    assert.equal(rewritten.rewritten, 0);
    assert.deepEqual(rewritten.messages, messages);
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

function errorToolMessage(toolName: string, toolCallId: string, body: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId,
        toolName,
        output: { type: 'error-json', value: { body } },
      },
    ],
  };
}

function completedCall(toolName: string, toolCallId: string, input: unknown, stepNumber: number) {
  return { toolName, toolCallId, input, stepNumber };
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
