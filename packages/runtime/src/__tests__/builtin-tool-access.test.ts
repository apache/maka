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
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { buildBuiltinTools } from '../builtin-tools.js';
import {
  normalizeToolFilePath,
  ToolAccesses,
  type ToolAccesses as AccessSet,
} from '../tool-access.js';
import type { MakaTool, MakaToolAccessContext } from '../tool-runtime.js';

describe('builtin tool access declarations', () => {
  const cwd = resolve('workspace');
  const tools = new Map(buildBuiltinTools().map((tool) => [tool.name, tool]));
  const expectedPath = (path: string) => normalizeToolFilePath(path, { cwd });

  test('maps file reads and writes to their concrete targets', async () => {
    assert.deepEqual(await accesses(tools, 'Read', { path: 'a.ts' }, cwd), [
      { kind: 'file', operation: 'read', path: expectedPath('a.ts') },
    ]);
    assert.deepEqual(await accesses(tools, 'Write', { path: 'a.ts', content: 'x' }, cwd), [
      { kind: 'file', operation: 'write', path: expectedPath('a.ts') },
    ]);
    for (const [name, input] of [
      ['Edit', { path: 'a.ts', old_string: 'a', new_string: 'b' }],
      ['FormatJson', { path: 'a.json' }],
    ] as const) {
      assert.deepEqual(await accesses(tools, name, input, cwd), [
        {
          kind: 'file',
          operation: 'readwrite',
          path: expectedPath(input.path),
        },
      ]);
    }
  });

  test('keeps runtime-resource reads fail-closed', async () => {
    assert.deepEqual(
      await accesses(tools, 'Read', { ref: 'runtime://resource' }, cwd),
      ToolAccesses.all(),
    );
  });

  test('maps Glob and Grep to recursive search roots', async () => {
    assert.deepEqual(await accesses(tools, 'Glob', { pattern: '**/*.ts', cwd: 'src' }, cwd), [
      {
        kind: 'file',
        operation: 'search',
        path: expectedPath('src'),
        recursive: true,
      },
    ]);
    assert.deepEqual(await accesses(tools, 'Grep', { pattern: 'TODO' }, cwd), [
      {
        kind: 'file',
        operation: 'search',
        path: expectedPath('.'),
        recursive: true,
      },
    ]);
  });

  test('declares every valid apply_patch target as one atomic access set', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: added.txt',
      '+added',
      '*** Update File: changed.txt',
      '@@',
      '-before',
      '+after',
      '*** End Patch',
    ].join('\n');
    assert.deepEqual(await accesses(tools, 'apply_patch', patch, cwd), [
      { kind: 'file', operation: 'write', path: expectedPath('added.txt') },
      { kind: 'file', operation: 'write', path: expectedPath('changed.txt') },
    ]);
  });
});

async function accesses(
  tools: ReadonlyMap<string, MakaTool>,
  name: string,
  input: unknown,
  cwd: string,
): Promise<AccessSet> {
  const tool = tools.get(name);
  if (!tool?.resolveAccesses) throw new Error(`${name} has no access declaration`);
  const context: MakaToolAccessContext = {
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    cwd,
    permissionMode: 'ask',
    toolCallId: `${name}-call`,
    abortSignal: new AbortController().signal,
  };
  return (await tool.resolveAccesses(input, context)) ?? ToolAccesses.all();
}
