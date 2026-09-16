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
import test from 'node:test';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { buildBuiltinTools } from '@maka/runtime/builtin-tools';
import { AiSdkBackend } from '@maka/runtime/ai-sdk-backend';
import { createBypassExecutionBoundary } from '@maka/core/sandbox-boundary';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import type { SessionEvent } from '@maka/core/events';
import { z } from 'zod';
import { decodeHostedExecutionStartInput } from '../protocol/index.js';
import {
  bindWorkHubRoutingDecisionPrompt,
  hostedExecutionRunProfile,
  projectHostedExecutionTools,
} from '../server/hosted-execution-tool-profile.js';

test('hosted execution tool profiles are durable Session creation inputs', () => {
  const decoded = decodeHostedExecutionStartInput({
    executionId: '00000000-0000-4000-8000-000000000001',
    session: {
      workspace: { kind: 'host_path', path: '/workspace' },
      modelTarget: {
        kind: 'explicit',
        connectionId: 'connection-1',
        connectionSlug: 'provider',
        model: 'model',
      },
      toolProfile: 'headless-coding-v1',
    },
    content: { text: 'solve' },
  });
  assert.equal(decoded.session.toolProfile, 'headless-coding-v1');
  assert.throws(
    () =>
      decodeHostedExecutionStartInput({
        ...decoded,
        session: { ...decoded.session, toolProfile: 'unknown-profile' },
      }),
    /Invalid Session tool profile/u,
  );
});

test('the headless coding profile freezes prompt, tools, and memory and passes product Bash through', () => {
  const profile = hostedExecutionRunProfile('headless-coding-v1');
  assert.ok(profile);
  assert.deepEqual(profile.toolNames, [
    'Bash',
    'StopBackgroundTask',
    'WriteStdin',
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'apply_patch',
  ]);
  assert.equal(profile.memoryExtraction, false);
  assert.equal(
    profile.systemPrompt,
    [
      'Complete the task by acting with the available tools, not by narrating.',
      'Prefer Read, Glob, and Grep for inspection, Edit and Write for file changes, and Bash for shell commands and tests.',
      'Verify the result when practical.',
      'Stop when the task is complete.',
    ].join('\n'),
  );

  const original: MakaTool = {
    name: 'Bash',
    description: 'Product Bash',
    parameters: z.object({
      command: z.string(),
      run_in_background: z.boolean().optional(),
      pty: z.boolean().optional(),
    }),
    impl: async () => 'ok',
  };
  const profileTools = projectHostedExecutionTools(
    [
      original,
      ...profile.toolNames
        .filter((name) => name !== 'Bash')
        .map(
          (name): MakaTool => ({
            name,
            description: name,
            parameters: z.object({}),
            impl: async () => 'ok',
          }),
        ),
      {
        name: 'ScheduledTask',
        description: 'Must stay outside the profile ceiling',
        parameters: z.object({}),
        impl: async () => 'scheduled',
      },
    ],
    'headless-coding-v1',
  );
  assert.deepEqual(
    profileTools.map(({ name }) => name),
    profile.toolNames,
  );
  assert.equal(profileTools[0], original);
});

test('the WorkHub coordination profile has conversational authority but zero tools', () => {
  const profile = hostedExecutionRunProfile('workhub-coordination-v1');
  assert.ok(profile);
  assert.deepEqual(profile.toolNames, []);
  assert.equal(profile.memoryExtraction, false);
  assert.match(profile.systemPrompt, /conversational coordinator for WorkHub/u);
  assert.match(profile.systemPrompt, /no tools, filesystem authority/u);

  const productTool: MakaTool = {
    name: 'Read',
    description: 'Read files',
    parameters: z.object({}),
    impl: async () => 'not reachable',
  };
  assert.deepEqual(projectHostedExecutionTools([productTool], 'workhub-coordination-v1'), []);
});

test('WorkHub v2 keeps its attachment and browser tool ceiling visible in direct and Code Mode', async () => {
  const makeTool = (name: string): MakaTool => ({
    name,
    description: name,
    parameters: z.object({}),
    impl: async () => name,
  });
  const control = makeTool('mcp__desktop_workhub__control');
  const tasks = makeTool('mcp__desktop_workhub__tasks');
  const browserCalls: unknown[] = [];
  const browserNavigate: MakaTool = {
    name: 'mcp__desktop_browser__browser_navigate',
    description: 'Navigate the WorkHub browser',
    parameters: z.object({ url: z.string().url() }),
    impl: async (input) => {
      browserCalls.push(input);
      return `navigated:${input.url}`;
    },
  };
  const browserTools = [
    browserNavigate,
    makeTool('mcp__desktop_browser__browser_snapshot'),
    makeTool('mcp__desktop_browser__browser_click'),
    makeTool('mcp__desktop_browser__browser_type'),
    makeTool('mcp__desktop_browser__browser_wait'),
    makeTool('mcp__desktop_browser__browser_extract'),
  ];
  const reads: unknown[] = [];
  const builtinRead = buildBuiltinTools({
    attachmentResources: {
      async readAttachmentResource(sessionId, artifactId) {
        reads.push({ sessionId, artifactId });
        return { kind: 'text', text: 'attachment contents' };
      },
    },
  }).find(({ name }) => name === 'Read')!;
  const tools = [
    makeTool('Bash'),
    builtinRead,
    ...browserTools,
    control,
    tasks,
    makeTool('AskUserQuestion'),
  ];
  const projected = projectHostedExecutionTools(tools, 'workhub-coordination-v2');
  assert.deepEqual(
    projected.map(({ name }) => name),
    [control.name, tasks.name, ...browserTools.map(({ name }) => name), 'Read', 'AskUserQuestion'],
  );
  const read = projected.find(({ name }) => name === 'Read')!;
  const context = {
    sessionId: 'workhub',
    runId: 'run',
    turnId: 'turn',
    cwd: '/workspace',
    toolCallId: 'read',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
  assert.deepEqual(await read.impl({ path: 'maka://runtime/attachments/attachment-1' }, context), {
    kind: 'text',
    text: 'attachment contents',
  });
  assert.deepEqual(reads, [{ sessionId: 'workhub', artifactId: 'attachment-1' }]);
  for (const input of [
    { path: '/etc/passwd' },
    { path: 'maka://runtime/background-tasks/task-1' },
    { path: 'maka://runtime/attachments/a?session=other' },
  ]) {
    assert.throws(() => read.impl(input, context));
  }
  assert.equal(reads.length, 1);
  assert.throws(
    () => projectHostedExecutionTools(tools.slice(0, 4), 'workhub-coordination-v2'),
    /Hosted tool profile is unavailable/,
  );
  assert.equal(hostedExecutionRunProfile('workhub-coordination-v2')?.memoryExtraction, false);
  const prompt = hostedExecutionRunProfile('workhub-coordination-v2')?.systemPrompt ?? '';
  assert.match(prompt, /Intent never selects a target/u);
  assert.match(prompt, /call the tasks candidates operation before choosing/u);
  assert.match(prompt, /only when the user explicitly asks to create new work/u);
  assert.match(prompt, /never implies create_new/u);
  assert.match(prompt, /ordinary request to continue work is routing, not a linked resume/u);

  let providerCatalog = '';
  let providerPrompt = '';
  const backend = new AiSdkBackend({
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    header: {
      id: WORKHUB_COORDINATION_SESSION_ID,
      workspaceRoot: '/workspace',
      cwd: '/workspace',
      createdAt: 1,
      name: 'WorkHub',
      titleIsManual: true,
      isFlagged: false,
      labels: [],
      isArchived: false,
      status: 'active',
      statusUpdatedAt: 1,
      hasUnread: false,
      backend: 'ai-sdk',
      llmConnectionSlug: 'test',
      connectionLocked: true,
      model: 'test',
      permissionMode: 'bypass',
      toolProfile: 'workhub-coordination-v2',
      toolMode: 'code_mode',
      schemaVersion: 1,
    },
    connection: {
      slug: 'test',
      providerType: 'openai',
      defaultModel: 'test',
    },
    apiKey: 'test',
    modelId: 'test',
    tools: [...projected],
    maxSteps: 1,
    readExecutionBoundary: async () => createBypassExecutionBoundary(0),
    readPermissionMode: async () => 'bypass',
    modelFactory: () => ({
      specificationVersion: 'v4',
      provider: 'test',
      modelId: 'test',
      supportedUrls: {},
      doStream: async ({
        tools: modelTools,
        prompt: modelPrompt,
      }: {
        tools?: unknown;
        prompt?: unknown;
      }) => {
        providerCatalog = JSON.stringify(modelTools);
        providerPrompt = JSON.stringify(modelPrompt);
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'exec-1',
                toolName: 'exec',
                input: JSON.stringify({
                  code: `return {
              names: Object.keys(tools).sort(),
              allowed: [
                'Read',
                'mcp__desktop_workhub__control',
                'mcp__desktop_browser__browser_navigate',
                'mcp__desktop_browser__browser_snapshot',
                'mcp__desktop_browser__browser_click',
                'mcp__desktop_browser__browser_type',
                'mcp__desktop_browser__browser_wait',
                'mcp__desktop_browser__browser_extract'
              ].map(name =>
                [name in tools, typeof tools[name]]),
              forbidden: ['Bash', 'Write'].map(name =>
                [name in tools, typeof tools[name]]),
              result: await tools.mcp__desktop_browser__browser_navigate({ url: 'https://example.com/' })
            };`,
                }),
              });
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
              });
              controller.close();
            },
          }),
        };
      },
    }),
  });
  const events: SessionEvent[] = [];
  try {
    for await (const event of backend.send({
      turnId: 'code-mode-ceiling',
      text: 'Inspect tools',
      context: [],
    })) {
      events.push(event);
    }
  } finally {
    await backend.dispose();
  }
  for (const name of projected.map((tool) => tool.name)) assert.ok(providerPrompt.includes(name));
  assert.doesNotMatch(providerCatalog, /mcp__desktop_browser__browser_navigate/u);
  assert.doesNotMatch(providerCatalog, /Bash|Write/u);
  assert.deepEqual(browserCalls, [{ url: 'https://example.com/' }]);
  const result = events.find(
    (event) => event.type === 'tool_result' && event.toolUseId === 'exec-1',
  );
  assert.ok(result?.type === 'tool_result', JSON.stringify(events));
  assert.deepEqual(result.content, {
    kind: 'json',
    value: {
      ok: true,
      value: {
        names: projected.map((tool) => tool.name).sort(),
        allowed: [
          [true, 'function'],
          [true, 'function'],
          [true, 'function'],
          [true, 'function'],
          [true, 'function'],
          [true, 'function'],
          [true, 'function'],
          [true, 'function'],
        ],
        forbidden: [
          [false, 'undefined'],
          [false, 'undefined'],
        ],
        result: 'navigated:https://example.com/',
      },
      toolCalls: [{ index: 1, name: browserNavigate.name }],
    },
  });
});

test('WorkHub routing prompt binds the exact recalled candidate without granting authority', () => {
  const prompt = bindWorkHubRoutingDecisionPrompt('base', {
    kind: 'routing',
    disposition: 'delegate_existing',
    candidateSetId: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    candidateRef: 'whc_candidate_a',
  });
  assert.match(prompt, /candidateSetId sha256:0123456789abcdef/u);
  assert.match(prompt, /candidateRef whc_candidate_a/u);
  assert.match(prompt, /grants no authority/u);
});
