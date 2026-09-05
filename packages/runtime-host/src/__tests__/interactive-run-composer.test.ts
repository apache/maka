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
import { test } from 'node:test';
import { z } from 'zod';
import type { PermissionMode } from '@maka/core/permission';
import type { PlanStore } from '@maka/core/plan';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import type { SessionTodoToolStore } from '@maka/runtime/session-todo-tools';
import type { MakaTool } from '@maka/runtime/tool-runtime';
import { createInteractiveRunComposer } from '../server/interactive-run-composer.js';
import type { HostMemoryCoordinator } from '../server/memory-coordinator.js';
import type { HostSkillCatalogCoordinator } from '../server/skill-catalog-coordinator.js';

test('the interactive tool surface does not expose the retired ExploreAgent tool', () => {
  const composer = createFixtureComposer();

  assert.equal(
    composer.tools.some(({ name }) => name === 'ExploreAgent'),
    false,
  );
});

test('the interactive tool surface follows the session permission mode', () => {
  const expected = {
    bypass: {
      bashKeys: ['command', 'timeout_ms', 'run_in_background', 'pty'],
      declaresBoundary: false,
    },
    ask: {
      bashKeys: [
        'command',
        'timeout_ms',
        'run_in_background',
        'pty',
        'boundary_intent',
        'required_boundary',
      ],
      declaresBoundary: true,
    },
    explore: {
      bashKeys: [
        'command',
        'timeout_ms',
        'run_in_background',
        'pty',
        'boundary_intent',
        'required_boundary',
      ],
      declaresBoundary: true,
    },
  } as const satisfies Record<PermissionMode, unknown>;

  for (const permissionMode of ['bypass', 'ask', 'explore'] as const) {
    const composer = createFixtureComposer({
      builtinTools: {
        shellRuns: {
          runForegroundBash: () => Promise.reject(new Error('not used')),
          runBackgroundBash: () => Promise.reject(new Error('not used')),
        },
      },
      plan: {
        store: {} as PlanStore,
        state: {
          schemaVersion: 1,
          sessionId: 'session-1',
          storeVersion: 0,
          proposals: [],
          executions: [],
        },
        mode: 'agent',
        permissionMode,
      },
    });
    const bash = composer.tools.find(({ name }) => name === 'Bash');
    if (!bash) throw new Error(`Bash tool missing under ${permissionMode}`);
    const schema = z.toJSONSchema(bash.parameters as z.ZodTypeAny);

    assert.deepEqual(
      Object.keys(schema.properties ?? {}),
      expected[permissionMode].bashKeys,
      permissionMode,
    );
    assert.equal(
      composer.tools.some(({ name }) => name === 'request_sandbox_boundary'),
      expected[permissionMode].declaresBoundary,
      permissionMode,
    );
    assert.equal(
      bash.description.includes('Enforced by the current session sandbox boundary.'),
      expected[permissionMode].declaresBoundary,
      permissionMode,
    );
  }
});

test('Deep Research keeps standard inspection tools and its durable workspace tools', () => {
  const tool = (name: string): MakaTool => ({
    name,
    description: name,
    parameters: {},
    impl: async () => name,
  });
  const composer = createFixtureComposer({
    hostTools: [tool('WebSearch')],
    deepResearch: { tools: [tool('deep_research_status')] },
  });
  const names = new Set(composer.tools.map(({ name }) => name));

  for (const name of ['Read', 'Glob', 'Grep', 'WebSearch', 'deep_research_status']) {
    assert.equal(names.has(name), true, `expected Deep Research tool ${name}`);
  }
  for (const name of ['Write', 'Edit', 'Bash', 'ExploreAgent']) {
    assert.equal(names.has(name), false, `unexpected Deep Research tool ${name}`);
  }
});

function createFixtureComposer(
  overrides: Partial<Parameters<typeof createInteractiveRunComposer>[0]> = {},
) {
  return createInteractiveRunComposer({
    runtimePolicy: { revision: 0, policy: createDefaultRuntimePolicy() },
    skills: {
      readCanonicalModelInventory: async () => ({ inventory: [] }),
    } as unknown as HostSkillCatalogCoordinator,
    memory: {} as HostMemoryCoordinator,
    sessionTodo: {} as SessionTodoToolStore,
    builtinTools: {},
    ...overrides,
  });
}
