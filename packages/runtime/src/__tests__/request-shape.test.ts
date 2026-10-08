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

import { PROMPT_COMPOSITION_MAX_TOOLS } from '@maka/core/model-call-attempt';
import {
  canonicalizeToolSet,
  preparedPromptComposition,
  toolSchemaCharsForDiagnostics,
} from '../request-shape.js';
import type { MakaTool } from '../tool-runtime.js';

function tool(name: string): MakaTool {
  return { name, description: name, parameters: {}, impl: () => ({}) };
}

const invalid = tool('invalid');

describe('canonicalizeToolSet active allow-list', () => {
  test('withholds inactive tools without removing them from the dispatch registry', () => {
    const { providerTools, activeTools } = canonicalizeToolSet(
      [tool('Read'), tool('Rive'), tool('tool_search')],
      invalid,
      new Set(['Read', 'tool_search']),
    );

    assert.deepEqual(activeTools, ['Read', 'tool_search']);
    assert.deepEqual(
      providerTools.map((candidate) => candidate.name),
      ['Read', 'Rive', 'tool_search', 'invalid'],
    );
  });

  test('measures only the provider-visible tool schemas', () => {
    const tools: MakaTool[] = [
      { ...tool('Read'), parameters: { a: 1 } },
      { ...tool('Rive'), parameters: { big: 'x'.repeat(500) } },
    ];

    assert.ok(
      toolSchemaCharsForDiagnostics(tools, ['Read', 'Rive']) >
        toolSchemaCharsForDiagnostics(tools, ['Read']) + 400,
    );
  });
});

describe('prepared prompt composition', () => {
  test('folds every semantic part into its bucket and names the tools', () => {
    const composition = preparedPromptComposition({
      prompt: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
      ],
      tools: [{ name: 'Bash', inputSchema: { type: 'object' } }, { inputSchema: {} }],
      providerOptions: { anthropic: { thinking: { type: 'enabled' } } },
    });

    assert.deepEqual(
      composition?.segments.map((segment) => segment.kind),
      ['system_instructions', 'tool_definitions', 'messages', 'other'],
    );
    assert.deepEqual(
      composition?.tools?.map((tool) => tool.name),
      ['Bash'],
    );
    // The unnamed tool's schema is still counted; it just cannot be listed.
    assert.ok((composition?.unlabelledToolBytes ?? 0) > 0);
  });

  test('sizes non-JSON values rather than dropping them', () => {
    const composition = preparedPromptComposition({
      prompt: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              data: { type: 'data', data: new Uint8Array([1, 2, 3]) },
              mediaType: 'application/octet-stream',
            },
          ],
        },
      ],
    });

    assert.ok((composition?.segments[0]?.bytes ?? 0) > 0);
  });

  test('folds a long conversation into one row without losing its bytes', () => {
    const prompt = Array.from({ length: 1_000 }, (_, index) => ({
      role: 'user',
      content: `message-${index}`,
    }));
    const expectedBytes = prompt.reduce(
      (total, message) =>
        total + (preparedPromptComposition({ prompt: [message] })?.segments[0]?.bytes ?? 0),
      0,
    );

    const composition = preparedPromptComposition({ prompt });
    assert.deepEqual(
      composition?.segments.map((segment) => segment.kind),
      ['messages'],
    );
    assert.equal(composition?.segments[0]?.bytes, expectedBytes);
  });

  test('names the largest tools and carries the rest as a counted remainder', () => {
    const composition = preparedPromptComposition({
      tools: Array.from({ length: PROMPT_COMPOSITION_MAX_TOOLS + 5 }, (_, index) => ({
        name: `tool-${String(index).padStart(3, '0')}`,
        inputSchema: { type: 'object', padding: 'x'.repeat(index) },
      })),
    });

    assert.equal(composition?.tools?.length, PROMPT_COMPOSITION_MAX_TOOLS);
    assert.equal(composition?.remainingTools?.count, 5);
    assert.ok((composition?.remainingTools?.bytes ?? 0) > 0);
    // Largest first, so what a reader could remove is at the top.
    const bytes = composition?.tools?.map((tool) => tool.bytes) ?? [];
    assert.deepEqual(
      bytes,
      [...bytes].sort((left, right) => right - left),
    );
    // Every tool byte is still accounted for, named or not.
    assert.equal(
      bytes.reduce((total, size) => total + size, 0) + (composition?.remainingTools?.bytes ?? 0),
      composition?.segments.find((segment) => segment.kind === 'tool_definitions')?.bytes,
    );
  });

  test('has nothing to say about an empty request', () => {
    assert.equal(preparedPromptComposition({}), undefined);
  });
});
