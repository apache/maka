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
import { z } from 'zod';

import {
  buildNestableToolSnapshot,
  buildToolSchemaPlan,
  validateCodeModeToolInput,
} from '../tool-schema-builder.js';
import type { MakaTool } from '../tool-runtime.js';
import type { ToolAvailabilityPlan } from '../tool-availability.js';

function tool(name: string, overrides: Partial<MakaTool> = {}): MakaTool {
  return {
    name,
    description: `${name} description`,
    parameters: z.object({}),
    impl: () => ({ ok: true }),
    ...overrides,
  };
}

const invalidTool = tool('invalid');
const execTool = tool('exec', { parameters: z.object({ code: z.string() }) });

function availability(): ToolAvailabilityPlan {
  const providerTools = [
    tool('lookup', { parameters: z.object({ id: z.string() }) }),
    tool('native_search', { providerTool: { kind: 'openai-web-search' } }),
    invalidTool,
  ];
  return {
    providerTools,
    activeTools: ['lookup', 'native_search'],
    projectActiveTools: () => ({ activeTools: ['native_search'] }),
    currentRepairToolNames: () => ['lookup'],
    diagnostics: () => undefined,
  };
}

test('builds an exec-only Code Mode surface with the nestable catalog', () => {
  const base = availability();
  const nestedTools = buildNestableToolSnapshot(base.providerTools, base.activeTools);
  const result = buildToolSchemaPlan({
    availability: base,
    toolMode: 'code_mode',
    codeModeExecTool: execTool,
    nestedTools,
  });

  assert.deepEqual(
    result.providerTools.map((candidate) => candidate.name),
    ['exec', 'invalid'],
  );
  assert.deepEqual(result.availability.activeTools, ['exec']);
  assert.deepEqual(result.availability.projectActiveTools?.().activeTools, ['exec']);
  assert.deepEqual(result.availability.currentRepairToolNames(), ['exec']);
  assert.equal(result.availability.diagnostics(['exec'], 100), undefined);
  assert.deepEqual(Object.keys(result.modelTools), ['exec', 'invalid']);
  assert.equal(result.modelTools.exec?.kind, 'function');
  assert.strictEqual(result.providerTools[1], invalidTool);
  const catalog = JSON.parse(result.providerTools[0]!.description.split('\n').at(-1)!);
  assert.deepEqual(
    catalog.map((entry: { name: string }) => entry.name),
    ['lookup'],
  );
  assert.equal(catalog[0].description, 'lookup description');
  assert.equal(catalog[0].inputSchema.properties.id.type, 'string');
  assert.deepEqual(catalog[0].inputSchema.required, ['id']);
  assert.deepEqual(base.activeTools, ['lookup', 'native_search']);
  assert.equal(execTool.description, 'exec description');
  assert.deepEqual([...nestedTools.keys()], ['lookup']);
});

test('keeps the direct availability plan and provider-native bindings unchanged', () => {
  const direct = availability();
  const result = buildToolSchemaPlan({
    availability: direct,
    toolMode: 'direct',
    codeModeExecTool: execTool,
    nestedTools: buildNestableToolSnapshot(direct.providerTools, direct.activeTools),
  });

  assert.strictEqual(result.availability, direct);
  assert.strictEqual(result.providerTools, direct.providerTools);
  assert.deepEqual(
    result.providerTools.map((candidate) => candidate.name),
    ['lookup', 'native_search', 'invalid'],
  );
  assert.deepEqual(result.modelTools.native_search, {
    kind: 'provider',
    providerTool: { kind: 'openai-web-search' },
  });
  assert.equal(result.modelTools.lookup?.kind, 'function');
  assert.equal(result.modelTools.exec, undefined);
});

test('projects a filtered catalog without changing the executable snapshot', () => {
  const base = availability();
  const boundary = tool('request_sandbox_boundary');
  base.providerTools.push(boundary);
  base.activeTools.push(boundary.name);
  const nestedTools = buildNestableToolSnapshot(base.providerTools, base.activeTools);
  const visibleCatalog = new Map([...nestedTools].filter(([name]) => name !== boundary.name));
  const result = buildToolSchemaPlan({
    availability: base,
    toolMode: 'code_mode',
    codeModeExecTool: execTool,
    nestedTools: visibleCatalog,
  });

  assert.doesNotMatch(result.providerTools[0]!.description, /request_sandbox_boundary/);
  assert.strictEqual(nestedTools.get(boundary.name), boundary);
  assert.deepEqual([...visibleCatalog.keys()], ['lookup']);
});

test('selects only active function tools that may be nested', () => {
  const tools = [
    tool('lookup'),
    tool('inactive'),
    tool('direct_control', { nesting: 'direct_only' }),
    tool('native_search', { providerTool: { kind: 'openai-web-search' } }),
    execTool,
    invalidTool,
  ];

  assert.deepEqual(
    [
      ...buildNestableToolSnapshot(
        tools,
        tools.map((candidate) => candidate.name),
      ).keys(),
    ],
    ['lookup', 'inactive'],
  );
  assert.deepEqual([...buildNestableToolSnapshot(tools, ['lookup']).keys()], ['lookup']);
});

test('validates Code Mode inputs through Zod and JSON Schema contracts', async () => {
  const zodTool = tool('typed_lookup', { parameters: z.object({ id: z.string() }) });
  const parsed = await validateCodeModeToolInput(zodTool, { id: 'node-1' });
  assert.deepEqual(parsed, { id: 'node-1' });
  await assert.rejects(validateCodeModeToolInput(zodTool, { id: 42 }), /invalid arguments.*id/i);

  const jsonSchemaTool = tool('mcp_lookup', {
    parameters: {
      $schema: 'https://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  });
  assert.deepEqual(await validateCodeModeToolInput(jsonSchemaTool, { id: 'node-1' }), {
    id: 'node-1',
  });
  await assert.rejects(
    validateCodeModeToolInput(jsonSchemaTool, { id: 42 }),
    /invalid arguments.*id/i,
  );
});
