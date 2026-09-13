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
import type { Tool } from '@modelcontextprotocol/client';
import {
  discoverMcpTools,
  type McpToolDiscoveryLimits,
  type McpToolPage,
  type McpToolPageSource,
} from '../tool-discovery.js';

describe('discoverMcpTools', () => {
  test('treats an empty nextCursor as an opaque continuation', async () => {
    const source = sourceFromPages([
      { tools: [tool('first')], nextCursor: '' },
      { tools: [tool('second')] },
    ]);

    const result = await discoverMcpTools(source, 'fixture', 25);

    assert.deepEqual(
      result.map(({ definition }) => definition.name),
      ['first', 'second'],
    );
    assert.deepEqual(source.cursors, [undefined, '']);
  });

  test('rejects a repeated cursor without fetching another page', async () => {
    const source = sourceFromPages([
      { tools: [tool('first')], nextCursor: 'again' },
      { tools: [tool('second')], nextCursor: 'again' },
    ]);

    await assert.rejects(discoverMcpTools(source, 'fixture', 25), /repeated a tools cursor/u);
    assert.deepEqual(source.cursors, [undefined, 'again']);
  });

  test('rejects duplicate tool names across pages', async () => {
    const source = sourceFromPages([
      { tools: [tool('same')], nextCursor: 'next' },
      { tools: [tool('same')] },
    ]);

    await assert.rejects(discoverMcpTools(source, 'fixture', 25), /duplicate tool "same"/u);
  });

  test('bounds and redacts duplicate Tool names in diagnostics', async () => {
    const name = `token=sk-live-\u2028${'secret'.repeat(50)}`;
    const source = sourceFromPages([{ tools: [tool(name), tool(name)] }]);

    await assert.rejects(
      discoverMcpTools(source, 'fixture', 25),
      (error: unknown) =>
        error instanceof Error &&
        error.message.length < 256 &&
        error.message.includes('[redacted]') &&
        !error.message.includes('sk-live') &&
        !/[\r\n\u2028\u2029]/u.test(error.message),
    );
  });

  test('stops within an oversized tool page', async () => {
    const source = sourceFromPages([{ tools: [tool('one'), tool('two')] }]);

    await assert.rejects(
      discoverMcpTools(source, 'fixture', 25, limits({ maxTools: 1 })),
      /exceeded 1 tools/u,
    );
    assert.equal(source.cursors.length, 1);
  });

  test('does not fetch beyond the page limit', async () => {
    const source = sourceFromPages([
      { tools: [tool('one')], nextCursor: 'two' },
      { tools: [tool('two')], nextCursor: 'three' },
      { tools: [tool('unreachable')] },
    ]);

    await assert.rejects(
      discoverMcpTools(source, 'fixture', 25, limits({ maxPages: 2 })),
      /exceeded 2 tool pages/u,
    );
    assert.deepEqual(source.cursors, [undefined, 'two']);
  });

  test('rejects cumulative definition bytes across pages without fetching another page', async () => {
    const source = sourceFromPages([
      {
        tools: [{ ...tool('first'), description: 'a'.repeat(400) }],
        nextCursor: 'second',
      },
      {
        tools: [{ ...tool('second'), description: 'b'.repeat(400) }],
        nextCursor: 'unreachable',
      },
      { tools: [tool('unreachable')] },
    ]);

    await assert.rejects(
      discoverMcpTools(source, 'fixture', 25, limits({ maxDefinitionBytes: 700 })),
      /exceeded 700 tool definition bytes/u,
    );
    assert.deepEqual(source.cursors, [undefined, 'second']);
  });

  test('preflights definition depth before cloning it into the snapshot candidate', async () => {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let depth = 0; depth < 101; depth += 1) {
      schema = { type: 'object', properties: { child: schema } };
    }
    const source = sourceFromPages([
      {
        tools: [{ name: 'deep', inputSchema: schema as Tool['inputSchema'] }],
      },
    ]);

    await assert.rejects(discoverMcpTools(source, 'fixture', 25), /tool definition exceeds depth/u);
  });
});

function tool(name: string): Tool {
  return {
    name,
    inputSchema: { type: 'object' },
  };
}

function limits(overrides: Partial<McpToolDiscoveryLimits>): McpToolDiscoveryLimits {
  return {
    maxPages: 10,
    maxTools: 10,
    maxDefinitionBytes: 10_000,
    ...overrides,
  };
}

function sourceFromPages(
  pages: readonly McpToolPage[],
): McpToolPageSource & { cursors: Array<string | undefined> } {
  const remaining = [...pages];
  const cursors: Array<string | undefined> = [];
  return {
    cursors,
    async requestToolsPage(cursor) {
      cursors.push(cursor);
      const page = remaining.shift();
      if (!page) throw new Error('unexpected tools/list request');
      return page;
    },
  };
}
