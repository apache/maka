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
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { buildBuiltinToolComposition } from '../builtin-tools.js';
import { ToolPreparationService } from '../preparation/tool-preparation-service.js';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';

describe('builtin tool resource claims', () => {
  let cwd: string;
  const tools = new Map<string, MakaTool>();
  let preparationService: ToolPreparationService;
  // claim.key must equal the executor's lock key. On Windows realpath returns
  // backslash paths, and normalising here would break the claim==lock key
  // invariant, so the key is compared verbatim.
  const expectedKey = (path: string) => resolve(cwd, path);

  before(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'maka-claims-')));
    const composition = buildBuiltinToolComposition();
    preparationService = new ToolPreparationService(composition.authorityRegistry);
    for (const tool of composition.tools) tools.set(tool.name, tool);
  });

  after(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test('maps file reads and writes to canonical keyed claims', async () => {
    assert.deepEqual(await claims(preparationService, tools, 'Read', { path: 'a.ts' }, cwd), [
      { kind: 'keyed', authority: 'filesystem:workspace', key: expectedKey('a.ts'), mode: 'read' },
    ]);
    assert.deepEqual(
      await claims(preparationService, tools, 'Write', { path: 'a.ts', content: 'x' }, cwd),
      [
        {
          kind: 'keyed',
          authority: 'filesystem:workspace',
          key: expectedKey('a.ts'),
          mode: 'write',
        },
      ],
    );
    for (const [name, input] of [
      ['Edit', { path: 'a.ts', old_string: 'a', new_string: 'b' }],
      ['FormatJson', { path: 'a.json' }],
    ] as const) {
      assert.deepEqual(await claims(preparationService, tools, name, input, cwd), [
        {
          kind: 'keyed',
          authority: 'filesystem:workspace',
          key: expectedKey(input.path),
          mode: 'write',
        },
      ]);
    }
  });

  test('keeps authority bindings exclusively in the registry', () => {
    const authorityToolNames = [
      'Read',
      'Write',
      'Edit',
      'FormatJson',
      'Glob',
      'Grep',
      'apply_patch',
    ];
    const authorityTools = [...tools.values()].filter((tool) =>
      authorityToolNames.includes(tool.name),
    );
    assert.deepEqual(authorityTools.map((tool) => tool.name).sort(), authorityToolNames.sort());
    assert.equal(
      authorityTools.every((tool) => !('prepare' in tool) && !('resourceAuthority' in tool)),
      true,
    );
  });

  test('runtime-resource reads declare no claims (do not enter the Scheduler)', async () => {
    assert.deepEqual(
      await claims(preparationService, tools, 'Read', { ref: 'runtime://resource' }, cwd),
      [],
    );
  });

  test('maps Glob and Grep to recursive tree-read claims', async () => {
    assert.deepEqual(
      await claims(preparationService, tools, 'Glob', { pattern: '**/*.ts', cwd: 'src' }, cwd),
      [
        {
          kind: 'keyed',
          authority: 'filesystem:workspace',
          key: expectedKey('src'),
          mode: 'read',
          scope: 'tree',
        },
      ],
    );
    assert.deepEqual(await claims(preparationService, tools, 'Grep', { pattern: 'TODO' }, cwd), [
      {
        kind: 'keyed',
        authority: 'filesystem:workspace',
        key: expectedKey('.'),
        mode: 'read',
        scope: 'tree',
      },
    ]);
  });

  test('declares a single-operation apply_patch target as one write claim', async () => {
    assert.deepEqual(
      await claims(
        preparationService,
        tools,
        'apply_patch',
        {
          callId: 'patch-claim',
          operation: { type: 'update_file', path: 'changed.txt', diff: '@@\n-a\n+b\n' },
        },
        cwd,
      ),
      [
        {
          kind: 'keyed',
          authority: 'filesystem:workspace',
          key: expectedKey('changed.txt'),
          mode: 'write',
        },
      ],
    );
    // A string (multi-operation) patch falls back to the plain impl. Until the
    // parser is shared safely with prepare, it must conservatively claim all.
    assert.deepEqual(
      await claims(
        preparationService,
        tools,
        'apply_patch',
        '*** Begin Patch\n+x\n*** End Patch',
        cwd,
      ),
      [{ kind: 'all' }],
    );
  });

  test('composes the stable Kimi policy into the production registry', async () => {
    const composition = buildBuiltinToolComposition();
    const service = new ToolPreparationService(composition.authorityRegistry);
    const expectedNone = [
      'WebSearch',
      'WebFetch',
      'agent_spawn',
      'agent_list',
      'agent_output',
      'view_agent_graph',
      'agent_swarm_status',
      'SkillSearch',
      'StopBackgroundTask',
      'WriteStdin',
      'todo_read',
      'todo_write',
      'SearchHistory',
      'ReadHistory',
      'ScheduledTask',
      'GoalSet',
      'GoalClear',
      'GoalStatus',
      'GoalPause',
      'GoalResume',
      'SubmitPlan',
      'update_plan',
      'cancel_plan',
    ];
    const expectedAll = [
      'Bash',
      'update_agent_graph',
      'yield_agent_graph',
      'AskUserQuestion',
      'request_sandbox_boundary',
      'Skill',
      'tool_search',
      'maka_tool_search',
      'maka_computer',
      'UnknownMcpTool',
    ];
    for (const name of expectedNone) {
      assert.deepEqual(await policyClaims(service, name, cwd), [], name);
    }
    for (const name of expectedAll) {
      assert.deepEqual(await policyClaims(service, name, cwd), [{ kind: 'all' }], name);
    }
  });
});

async function policyClaims(
  service: ToolPreparationService,
  name: string,
  cwd: string,
): Promise<readonly unknown[]> {
  const tool: MakaTool = {
    name,
    description: 'authority policy probe',
    parameters: undefined,
    impl: async () => undefined,
  };
  return (
    await service.prepare({
      tool,
      input: {},
      ctx: {
        sessionId: 'session-1',
        turnId: 'turn-1',
        cwd,
        permissionMode: 'ask',
        toolCallId: `${name}-call`,
        abortSignal: new AbortController().signal,
        emitOutput: () => {},
      },
    })
  ).claims;
}

async function claims(
  preparationService: ToolPreparationService,
  tools: ReadonlyMap<string, MakaTool>,
  name: string,
  input: unknown,
  cwd: string,
): Promise<readonly unknown[]> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`${name} is not registered`);
  const context: MakaToolContext = {
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd,
    permissionMode: 'ask',
    toolCallId: `${name}-call`,
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
  const operation = await preparationService.prepare({ tool, input, ctx: context });
  return operation.claims;
}
