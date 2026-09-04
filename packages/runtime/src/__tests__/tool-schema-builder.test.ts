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
import { toolSchemaCharsForDiagnostics } from '../request-shape.js';
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

test('builds the Code Mode provider surface and schema bindings independently', () => {
  const base = availability();
  const baseVisibleChars = toolSchemaCharsForDiagnostics(base.providerTools, base.activeTools);
  base.diagnostics = (activeTools, visibleToolSchemaChars) => ({
    mode: 'search',
    enabledSourceIds: [],
    visibleToolCount: activeTools.length,
    fullToolCount: 3,
    hiddenToolCount: 1,
    visibleToolSchemaChars,
    fullToolSchemaChars: baseVisibleChars + 100,
    toolSchemaCharReduction: 100,
  });
  const result = buildToolSchemaPlan({
    boundTools: base.providerTools.filter((candidate) => candidate !== invalidTool),
    availability: base,
    requestedToolMode: 'code_mode',
    codeModeExecTool: execTool,
  });

  assert.equal(result.toolMode, 'code_mode');
  assert.deepEqual(
    result.providerTools.map((candidate) => candidate.name),
    ['exec', 'lookup', 'native_search', 'invalid'],
  );
  assert.deepEqual(result.availability.activeTools, ['exec', 'lookup', 'native_search']);
  assert.deepEqual(result.availability.projectActiveTools?.().activeTools, [
    'exec',
    'native_search',
  ]);
  assert.deepEqual(result.availability.currentRepairToolNames(), ['exec', 'lookup']);
  assert.deepEqual(result.modelTools.native_search, {
    kind: 'provider',
    providerTool: { kind: 'openai-web-search' },
  });
  assert.equal(result.modelTools.lookup?.kind, 'function');
  assert.equal(result.modelTools.exec?.kind, 'function');

  const visibleToolSchemaChars = toolSchemaCharsForDiagnostics(
    result.providerTools,
    result.availability.activeTools,
  );
  const diagnostic = result.availability.diagnostics(
    result.availability.activeTools,
    visibleToolSchemaChars,
  );
  assert.equal(diagnostic?.visibleToolCount, 3);
  assert.equal(diagnostic?.fullToolCount, 4);
  assert.equal(diagnostic?.visibleToolSchemaChars, visibleToolSchemaChars);
  assert.equal(
    diagnostic?.fullToolSchemaChars,
    baseVisibleChars + 100 + (visibleToolSchemaChars - baseVisibleChars),
  );
});

test('keeps the direct availability plan unchanged', () => {
  const direct = availability();
  const result = buildToolSchemaPlan({
    boundTools: direct.providerTools,
    availability: direct,
    requestedToolMode: undefined,
    codeModeExecTool: execTool,
  });

  assert.equal(result.toolMode, 'direct');
  assert.strictEqual(result.availability, direct);
  assert.deepEqual(
    result.providerTools.map((candidate) => candidate.name),
    ['lookup', 'native_search', 'invalid'],
  );
});

test('rejects invalid modes and a caller-owned Code Mode exec name', () => {
  const direct = availability();
  for (const requestedToolMode of ['legacy_mode', null]) {
    assert.throws(
      () =>
        buildToolSchemaPlan({
          boundTools: direct.providerTools,
          availability: direct,
          requestedToolMode,
          codeModeExecTool: execTool,
        }),
      /invalid tool mode/i,
    );
  }
  assert.throws(
    () =>
      buildToolSchemaPlan({
        boundTools: [tool('exec')],
        availability: direct,
        requestedToolMode: 'code_mode',
        codeModeExecTool: execTool,
      }),
    /reserved for Code Mode/i,
  );
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
