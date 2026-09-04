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
import {
  EXPLICIT_ALL_TOOL_AUTHORITY_IDS,
  EXPLICIT_NONE_TOOL_AUTHORITY_IDS,
  defaultToolAuthorityRegistrations,
} from '../preparation/default-tool-authorities.js';
import { ToolAuthorityRegistry } from '../preparation/tool-authority-registry.js';
import { ToolPreparationService } from '../preparation/tool-preparation-service.js';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';

const INTERNALLY_CORRECT_TOOL_IDS = [
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
] as const;

describe('domain tool authority fallbacks', () => {
  test('temporarily maps internally-correct implementations to none()', async () => {
    for (const name of INTERNALLY_CORRECT_TOOL_IDS) {
      assert.equal(EXPLICIT_NONE_TOOL_AUTHORITY_IDS.includes(name), true, name);
      assert.deepEqual(await claims(name), [], name);
    }
  });

  test('maps immutable SkillSearch to none()', async () => {
    assert.equal(EXPLICIT_NONE_TOOL_AUTHORITY_IDS.includes('SkillSearch'), true);
    assert.deepEqual(await claims('SkillSearch'), []);
  });

  test('maps the Code Mode exec container to none()', async () => {
    assert.equal(EXPLICIT_NONE_TOOL_AUTHORITY_IDS.includes('exec'), true);
    assert.deepEqual(await claims('exec'), []);
  });

  test('keeps Computer fail-closed at all() until host/window ownership exists', async () => {
    assert.equal(EXPLICIT_ALL_TOOL_AUTHORITY_IDS.includes('maka_computer'), true);
    assert.deepEqual(await claims('maka_computer'), [{ kind: 'all' }]);
  });

  test('none() and all() both execute the real implementation exactly once', async () => {
    for (const name of ['todo_write', 'SkillSearch', 'maka_computer']) {
      let calls = 0;
      const operation = await service().prepare({
        tool: tool(name, async () => {
          calls += 1;
          return name;
        }),
        input: {},
        ctx: context(),
      });
      assert.equal(await operation.execute(), name);
      await assert.rejects(operation.execute(), /already been executed/);
      assert.equal(calls, 1);
    }
  });
});

async function claims(name: string): Promise<readonly unknown[]> {
  const operation = await service().prepare({
    tool: tool(name, async () => undefined),
    input: {},
    ctx: context(),
  });
  return operation.claims;
}

function service(): ToolPreparationService {
  return new ToolPreparationService(new ToolAuthorityRegistry(defaultToolAuthorityRegistrations()));
}

function tool(name: string, impl: MakaTool['impl']): MakaTool {
  return { name, description: 'domain authority fallback test tool', parameters: undefined, impl };
}

function context(): MakaToolContext {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd: process.cwd(),
    permissionMode: 'ask',
    toolCallId: 'tool-call-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  };
}
