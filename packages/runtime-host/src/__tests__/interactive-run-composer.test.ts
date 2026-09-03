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
