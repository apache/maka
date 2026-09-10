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
import { z } from 'zod';
import { decodeHostedExecutionStartInput } from '../protocol/index.js';
import {
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

test('the headless coding profile freezes prompt, tools, memory, and foreground Bash', async () => {
  const profile = hostedExecutionRunProfile('headless-coding-v1');
  assert.ok(profile);
  assert.deepEqual(profile.toolNames, [
    'Bash',
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
  const bash = profileTools[0];
  assert.ok(bash);
  const schema = bash.parameters as z.ZodType;
  assert.equal((await schema.safeParseAsync({ command: 'true' })).success, true);
  assert.equal(
    (await schema.safeParseAsync({ command: 'true', run_in_background: true })).success,
    false,
  );
  assert.equal((await schema.safeParseAsync({ command: 'true', pty: true })).success, false);
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

test('WorkHub v2 can read its attachments without inheriting terminal, browser, or filesystem access', async () => {
  const makeTool = (name: string): MakaTool => ({
    name,
    description: name,
    parameters: z.object({}),
    impl: async () => name,
  });
  const control = makeTool('mcp__desktop_workhub__control');
  const tasks = makeTool('mcp__desktop_workhub__tasks');
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
    makeTool('mcp__desktop_browser__browser_navigate'),
    control,
    tasks,
  ];
  const projected = projectHostedExecutionTools(tools, 'workhub-coordination-v2');
  assert.deepEqual(
    projected.map(({ name }) => name),
    [control.name, tasks.name, 'Read'],
  );
  const read = projected[2]!;
  const context = {
    sessionId: 'workhub',
    runId: 'run',
    turnId: 'turn',
    cwd: '/workspace',
    toolCallId: 'read',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
  assert.deepEqual(await read.impl({ ref: 'maka://runtime/attachments/attachment-1' }, context), {
    kind: 'text',
    text: 'attachment contents',
  });
  assert.deepEqual(reads, [{ sessionId: 'workhub', artifactId: 'attachment-1' }]);
  for (const input of [
    { path: '/etc/passwd' },
    { ref: 'maka://runtime/background-tasks/task-1' },
    { ref: 'maka://runtime/attachments/a?session=other' },
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
});
