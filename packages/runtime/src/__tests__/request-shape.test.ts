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

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  canonicalizeToolSet,
  prepareRequestObservation,
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

describe('prepared request observation', () => {
  test('derives the request digest and bytes from the private serialization', () => {
    const material = prepareRequestObservation({
      prompt: [{ role: 'user', content: 'hello' }],
      maxOutputTokens: 1_024,
    });

    assert.equal(
      material.observation.digest,
      `sha256:${createHash('sha256').update(material.serializedRequest).digest('hex')}`,
    );
    assert.equal(material.observation.bytes, Buffer.byteLength(material.serializedRequest, 'utf8'));
  });

  test('serializes non-JSON values without collapsing their semantic identity', () => {
    const observed = prepareRequestObservation({
      bigint: 42n,
      missing: undefined,
      createdAt: new Date('2026-08-31T00:00:00.000Z'),
      headers: new Map([['x-observation', 'present']]),
    });
    const plain = prepareRequestObservation({
      bigint: '42',
      missing: '[undefined]',
      createdAt: '2026-08-31T00:00:00.000Z',
      headers: { 'x-observation': 'present' },
    });

    assert.doesNotThrow(() => JSON.parse(observed.serializedRequest));
    assert.notEqual(observed.observation.digest, plain.observation.digest);
  });

  test('preserves the semantic identity of binary request content', () => {
    const observe = (byte: number) =>
      prepareRequestObservation({
        prompt: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                data: { type: 'data', data: new Uint8Array([byte]) },
                mediaType: 'application/octet-stream',
              },
            ],
          },
        ],
      });

    const first = observe(1);
    const second = observe(2);
    assert.notEqual(first.serializedRequest, second.serializedRequest);
    assert.notEqual(first.observation.digest, second.observation.digest);
    assert.notEqual(first.observation.segments[0]?.digest, second.observation.segments[0]?.digest);
    assert.equal(first.observation.segments[0]?.comparison, 'exact');
  });

  test('marks redacted compaction content comparison-opaque', () => {
    const material = prepareRequestObservation({
      prompt: [
        {
          role: 'assistant',
          content: [
            {
              type: 'custom',
              kind: 'openai.compaction',
              providerOptions: { openai: { redacted: true } },
            },
          ],
        },
      ],
    });

    assert.equal(material.observation.segments[0]?.kind, 'message');
    assert.equal(material.observation.segments[0]?.comparison, 'opaque');
  });

  test('bounds ordered segments without dropping their count or bytes', () => {
    const prompt = Array.from({ length: 1_000 }, (_, index) => ({
      role: 'user',
      content: `message-${index}`,
    }));
    const material = prepareRequestObservation({ prompt });
    const expectedBytes = prompt.reduce(
      (total, message) =>
        total + prepareRequestObservation({ prompt: [message] }).observation.segments[0]!.bytes,
      0,
    );

    assert.ok(material.observation.segments.length <= 256);
    assert.equal(
      material.observation.segments.reduce((total, segment) => total + segment.bytes, 0),
      expectedBytes,
    );
    assert.equal(
      material.observation.segments.reduce(
        (total, segment) => total + (segment.representedSegments ?? 1),
        0,
      ),
      prompt.length,
    );
    assert.equal(material.observation.segments.at(-1)?.comparison, 'opaque');
  });

  test('records semantic segments in provider-prefix order and labels only tools', () => {
    const material = prepareRequestObservation({
      prompt: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'hello' },
      ],
      tools: [{ name: 'Bash', inputSchema: { type: 'object' } }, { inputSchema: {} }],
      providerOptions: { anthropic: { thinking: { type: 'enabled' } } },
    });

    assert.deepEqual(
      material.observation.segments.map(({ kind, index, cacheable, role, label }) => ({
        kind,
        index,
        cacheable,
        ...(role ? { role } : {}),
        ...(label ? { label } : {}),
      })),
      [
        { kind: 'tool_schema', index: 0, cacheable: true, label: 'Bash' },
        { kind: 'tool_schema', index: 1, cacheable: true },
        { kind: 'system_prompt', index: 0, cacheable: true },
        { kind: 'message', index: 0, cacheable: true, role: 'user' },
        { kind: 'provider_options', index: 0, cacheable: false },
      ],
    );
  });
});
