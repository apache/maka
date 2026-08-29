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
import { z } from 'zod';

import {
  TOOL_SEARCH_MAX_SCHEMA_CHARS,
  TOOL_SEARCH_NAME,
  ToolAvailabilityRuntime,
  toolAvailabilityHash,
  type ToolSearchResult,
} from '../tool-availability.js';
import type { MakaTool, MakaToolContext } from '../tool-runtime.js';

function tool(name: string, description = name): MakaTool {
  return { name, description, parameters: z.object({}), impl: () => ({ ok: true }) };
}

const invalid: MakaTool = {
  name: 'invalid',
  description: 'invalid',
  parameters: z.object({}),
  impl: () => ({}),
};

const ctx: MakaToolContext = {
  sessionId: 's',
  turnId: 't',
  cwd: '/tmp',
  toolCallId: 'tc',
  abortSignal: new AbortController().signal,
  emitOutput: () => {},
};

test('tool availability hash canonicalizes group members', () => {
  const grouped = toolAvailabilityHash({
    groups: [{ id: 'docs', toolNames: ['docs_read', 'docs_edit', 'docs_read'] }],
  });
  const reordered = toolAvailabilityHash({
    groups: [{ id: 'docs', toolNames: ['docs_edit', 'docs_read'] }],
  });
  assert.equal(grouped, reordered);
});

test('tool availability hash distinguishes full and search-enabled bindings', () => {
  assert.notEqual(toolAvailabilityHash(undefined), toolAvailabilityHash({}));
});

function runtime() {
  return new ToolAvailabilityRuntime(
    [
      tool('Read'),
      tool('Write'),
      tool('browser_click', 'Click an element in the browser'),
      tool('docs_edit', 'Edit a document'),
      tool('docs_read', 'Read a document'),
    ],
    {
      groups: [
        { id: 'browser', toolNames: ['browser_click'], description: 'Browser automation' },
        { id: 'docs', toolNames: ['docs_edit', 'docs_read'], description: 'Document tools' },
      ],
    },
    invalid,
  );
}

function searchTool(plan: ReturnType<ToolAvailabilityRuntime['prepare']>): MakaTool {
  const connector = plan.providerTools.find((candidate) => candidate.name === TOOL_SEARCH_NAME);
  assert.ok(connector);
  return connector;
}

describe('ToolAvailabilityRuntime — search activation', () => {
  test('step 0 exposes direct tools and tool_search, but not searchable schemas', () => {
    const plan = runtime().prepare(new Map());
    assert.ok(plan.activeTools.includes('Read'));
    assert.ok(plan.activeTools.includes('Write'));
    assert.ok(plan.activeTools.includes(TOOL_SEARCH_NAME));
    assert.ok(!plan.activeTools.includes('browser_click'));
    assert.ok(!plan.activeTools.includes('docs_edit'));
  });

  test('a group cannot defer the fixed direct baseline', () => {
    const plan = new ToolAvailabilityRuntime(
      [tool('Read'), tool('browser_click')],
      { groups: [{ id: 'bad-source', toolNames: ['Read', 'browser_click'] }] },
      invalid,
    ).prepare(new Map());
    assert.ok(plan.activeTools.includes('Read'));
    assert.ok(!plan.activeTools.includes('browser_click'));
    assert.doesNotMatch(searchTool(plan).description, /- Read/);
  });

  test('skill discovery tools stay direct while search is enabled', () => {
    const plan = new ToolAvailabilityRuntime(
      [tool('Skill'), tool('SkillSearch'), tool('custom')],
      {},
      invalid,
    ).prepare(new Map());
    assert.deepEqual(plan.activeTools, ['Skill', 'SkillSearch', TOOL_SEARCH_NAME]);
  });

  test('provider-routed apply_patch inherits direct editing visibility', () => {
    const plan = new ToolAvailabilityRuntime(
      [tool('apply_patch'), tool('custom')],
      {},
      invalid,
    ).prepare(new Map());
    assert.deepEqual(plan.activeTools, ['apply_patch', TOOL_SEARCH_NAME]);
  });

  test('inventory contains group and canonical names without tool descriptions', () => {
    const connector = searchTool(runtime().prepare(new Map()));
    assert.match(connector.description, /browser:\n- browser_click/);
    assert.match(connector.description, /docs:\n- docs_edit\n- docs_read/);
    assert.doesNotMatch(connector.description, /Click an element/);
    assert.doesNotMatch(connector.description, /Edit a document/);
  });

  test('search indexes group meaning without exposing it in the initial inventory', async () => {
    const plan = new ToolAvailabilityRuntime(
      [tool('remote_invoke', 'Invoke a provider-defined operation')],
      {
        groups: [
          {
            id: 'calendar_provider',
            label: 'Team calendar',
            description: 'Schedule a calendar meeting and manage events.',
            toolNames: ['remote_invoke'],
          },
        ],
      },
      invalid,
    ).prepare(new Map());
    const connector = searchTool(plan);

    assert.doesNotMatch(connector.description, /Team calendar|Schedule a calendar meeting/);
    assert.deepEqual(await connector.impl({ query: 'schedule calendar meeting' }, ctx), {
      activated: ['remote_invoke'],
    });
  });

  test('a successful search activates bounded matches for the next projection', async () => {
    const active = new Map<string, MakaTool>();
    const traces: Record<string, unknown>[] = [];
    const plan = runtime().prepare(active);
    const connector = searchTool(plan);
    const tracedContext: MakaToolContext = {
      ...ctx,
      emitRunTrace: (type, _message, data) => {
        if (type === 'tool_searched') traces.push(data ?? {});
      },
    };

    assert.deepEqual(await connector.impl({ query: 'edit document', limit: 1 }, tracedContext), {
      activated: ['docs_edit'],
    });
    assert.ok(active.has('docs_edit'), 'turn-owned activation map changed');
    assert.ok(
      !plan.currentRepairToolNames().includes('docs_edit'),
      'step snapshot stayed immutable',
    );

    const next = plan.projectActiveTools!();
    assert.ok(next.activeTools.includes('docs_edit'));
    assert.ok(!next.activeTools.includes('docs_read'));
    assert.equal(traces[0]?.query, 'edit document');
    assert.deepEqual(traces[0]?.activated, ['docs_edit']);
  });

  test('ordinary result is thin and contains no complete schemas', async () => {
    const connector = searchTool(runtime().prepare(new Map()));
    const output = await connector.impl({ query: 'browser click' }, ctx);
    assert.deepEqual(output, { activated: ['browser_click'] });
    assert.deepEqual(await connector.toModelOutput?.({ toolCallId: 'tc', input: {}, output }), {
      type: 'json',
      value: { activated: ['browser_click'] },
    });
  });

  test('repeated and parallel searches union and deduplicate turn activation', async () => {
    const active = new Map<string, MakaTool>();
    const plan = runtime().prepare(active);
    const connector = searchTool(plan);
    await Promise.all([
      connector.impl({ query: 'document read', limit: 1 }, ctx),
      connector.impl({ query: 'browser click', limit: 1 }, ctx),
      connector.impl({ query: 'browser click', limit: 1 }, ctx),
    ]);
    assert.deepEqual([...active.keys()].sort(), ['browser_click', 'docs_read']);
  });

  test('already-active matches do not consume a later search limit or schema budget', async () => {
    const active = new Map<string, MakaTool>();
    const largeDescription = `Perform a calendar action ${'x'.repeat(40 * 1024)}`;
    const plan = new ToolAvailabilityRuntime(
      [tool('calendar_primary', largeDescription), tool('calendar_secondary', largeDescription)],
      {
        groups: [
          {
            id: 'calendar',
            toolNames: ['calendar_primary', 'calendar_secondary'],
          },
        ],
      },
      invalid,
    ).prepare(active);
    const connector = searchTool(plan);

    const first = (await connector.impl(
      { query: 'calendar action', limit: 1 },
      ctx,
    )) as ToolSearchResult;
    const second = (await connector.impl(
      { query: 'calendar action', limit: 2 },
      ctx,
    )) as ToolSearchResult;

    assert.equal(first.activated.length, 1);
    assert.equal(second.activated.length, 1);
    assert.notEqual(second.activated[0], first.activated[0]);
    assert.equal(active.size, 2);
  });

  test('reports and skips an oversized tool without hiding a smaller later match', async () => {
    const active = new Map<string, MakaTool>();
    const plan = new ToolAvailabilityRuntime(
      [
        tool('oversized_target', `Oversized target ${'x'.repeat(TOOL_SEARCH_MAX_SCHEMA_CHARS)}`),
        tool('smaller_fallback', 'An oversized target fallback'),
      ],
      {
        groups: [
          {
            id: 'oversized',
            toolNames: ['oversized_target', 'smaller_fallback'],
          },
        ],
      },
      invalid,
    ).prepare(active);

    const connector = searchTool(plan);
    const result = (await connector.impl({ query: 'oversized target' }, ctx)) as ToolSearchResult;

    assert.deepEqual(result.activated, ['smaller_fallback']);
    assert.equal(result.blocked?.name, 'oversized_target');
    assert.equal(result.blocked?.reason, 'schema_too_large');
    assert.ok((result.blocked?.schemaChars ?? 0) > TOOL_SEARCH_MAX_SCHEMA_CHARS);
    assert.equal(active.has('smaller_fallback'), true);
    assert.deepEqual(
      await connector.toModelOutput?.({ toolCallId: 'tc', input: {}, output: result }),
      {
        type: 'json',
        value: { activated: ['smaller_fallback'], blocked: result.blocked },
      },
    );
  });

  test('stops at the schema ceiling instead of silently changing relevance order', async () => {
    const largeDescription = `Budget branch ${'x'.repeat(40 * 1024)}`;
    const active = new Map<string, MakaTool>();
    const plan = new ToolAvailabilityRuntime(
      [
        tool('budget_branch_primary', largeDescription),
        tool('budget_branch_secondary', largeDescription),
        tool('lower_ranked_tool', 'A lower ranked budget branch tool'),
      ],
      {
        groups: [
          {
            id: 'budget',
            toolNames: ['budget_branch_primary', 'budget_branch_secondary', 'lower_ranked_tool'],
          },
        ],
      },
      invalid,
    ).prepare(active);

    const result = (await searchTool(plan).impl(
      { query: 'budget branch', limit: 3 },
      ctx,
    )) as ToolSearchResult;

    assert.equal(result.activated.length, 1);
    assert.equal(result.blocked?.reason, 'schema_budget_exhausted');
    assert.equal(active.size, 1);
    assert.equal(active.has('lower_ranked_tool'), false);
  });

  test('required orchestration tools are visible without changing activation state', () => {
    const active = new Map<string, MakaTool>();
    const plan = runtime().prepare(active, new Set(['docs_read']));
    assert.ok(plan.activeTools.includes('docs_read'));
    assert.equal(active.size, 0);
    assert.ok(plan.projectActiveTools!().activeTools.includes('docs_read'));
  });

  test('activation maps isolate overlapping and subsequent turns', async () => {
    const first = new Map<string, MakaTool>();
    const firstPlan = runtime().prepare(first);
    await searchTool(firstPlan).impl({ query: 'browser click' }, ctx);
    assert.ok(firstPlan.projectActiveTools!().activeTools.includes('browser_click'));

    const secondPlan = runtime().prepare(new Map());
    assert.ok(!secondPlan.activeTools.includes('browser_click'));
  });

  test('an ungrouped bound tool is deferred by default', () => {
    const plan = new ToolAvailabilityRuntime(
      [tool('Read'), tool('future_tool')],
      {},
      invalid,
    ).prepare(new Map());
    assert.deepEqual(plan.activeTools, ['Read', TOOL_SEARCH_NAME]);
    assert.match(searchTool(plan).description, /- future_tool/);
    assert.ok(plan.gating?.gatedNames.has('future_tool'));
  });

  test('omitting availability keeps an explicit binding fully visible', () => {
    const plan = new ToolAvailabilityRuntime(
      [tool('Read'), tool('custom')],
      undefined,
      invalid,
    ).prepare(new Map());
    assert.deepEqual(plan.activeTools, ['custom', 'Read']);
    assert.ok(!plan.providerTools.some((candidate) => candidate.name === TOOL_SEARCH_NAME));
    assert.equal(plan.gating, undefined);
  });
});
