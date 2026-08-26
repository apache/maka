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
import type { MakaTool } from '../tool-runtime.js';
import {
  buildToolDiscoveryPolicy,
  lowerToolsForProvider,
  mcpNamespace,
  resolveProviderToolSearchCapability,
  NATIVE_TOOL_SEARCH_NAME,
} from '../tool-discovery.js';

function tool(name: string): MakaTool {
  return {
    name,
    description: `${name} description`,
    parameters: z.object({ q: z.string() }),
    impl: () => ({ ok: true }),
  };
}

describe('resolveProviderToolSearchCapability', () => {
  test('first-party Anthropic Messages supports all declared model families', () => {
    for (const modelId of [
      'claude-opus-4-5-20251101',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'claude-fable-5',
    ]) {
      assert.equal(
        resolveProviderToolSearchCapability({
          providerType: 'anthropic',
          adapterKind: 'anthropic',
          wire: 'anthropic-messages',
          modelId,
        }),
        'anthropic',
      );
    }
  });

  test('older Anthropic models fall back', () => {
    for (const modelId of ['claude-sonnet-4-0', 'claude-opus-4-0', 'claude-3-5-sonnet']) {
      assert.equal(
        resolveProviderToolSearchCapability({
          providerType: 'anthropic',
          adapterKind: 'anthropic',
          wire: 'anthropic-messages',
          modelId,
        }),
        'none',
      );
    }
  });

  test('first-party OpenAI requires both GPT-5.4+ and the Responses wire', () => {
    assert.equal(
      resolveProviderToolSearchCapability({
        providerType: 'openai',
        adapterKind: 'openai',
        wire: 'openai-responses',
        modelId: 'gpt-5.4',
      }),
      'openai',
    );
    assert.equal(
      resolveProviderToolSearchCapability({
        providerType: 'openai',
        adapterKind: 'openai',
        wire: 'openai-chat',
        modelId: 'gpt-5.4',
      }),
      'none',
    );
  });

  test('compatible relays require an explicit feature declaration', () => {
    const relay = {
      providerType: 'openai-responses-compatible',
      adapterKind: 'openai',
      wire: 'openai-responses',
      modelId: 'gpt-5.4',
    } as const;
    assert.equal(resolveProviderToolSearchCapability(relay), 'none');
    assert.equal(
      resolveProviderToolSearchCapability({ ...relay, declaredCapability: 'openai' }),
      'openai',
    );
  });
});

describe('buildToolDiscoveryPolicy', () => {
  test('product tools are direct unless covered by a deferred surface', () => {
    const p = buildToolDiscoveryPolicy({
      productToolNames: ['Bash', 'Read', 'RiveWorkflow', 'OfficeDocument'],
      deferredSurfaces: [
        {
          id: 'rive',
          description: 'Rive workflows',
          toolNames: ['RiveWorkflow'],
        },
      ],
      mcpTools: [],
    });
    assert.deepEqual(p.get('Bash'), { mode: 'direct' });
    assert.deepEqual(p.get('Read'), { mode: 'direct' });
    assert.deepEqual(p.get('RiveWorkflow'), {
      mode: 'deferred',
      namespace: 'rive',
      namespaceDescription: 'Rive workflows',
    });
    assert.deepEqual(p.get('OfficeDocument'), { mode: 'direct' });
  });

  test('MCP tools are deferred under a per-server namespace', () => {
    const p = buildToolDiscoveryPolicy({
      productToolNames: ['Bash'],
      deferredSurfaces: [],
      mcpTools: [
        {
          serverId: 'github',
          serverDescription: 'GitHub server',
          toolNames: ['mcp__github__create_issue', 'mcp__github__search'],
        },
        {
          serverId: 'fs',
          toolNames: ['mcp__fs__read'],
        },
      ],
    });
    assert.deepEqual(p.get('Bash'), { mode: 'direct' });
    assert.deepEqual(p.get('mcp__github__create_issue'), {
      mode: 'deferred',
      namespace: mcpNamespace('github'),
      namespaceDescription: 'GitHub server',
    });
    assert.deepEqual(p.get('mcp__fs__read'), {
      mode: 'deferred',
      namespace: mcpNamespace('fs'),
      namespaceDescription: 'fs',
    });
  });

  test('a surface member claim wins over an MCP claim (first claim owns the tool)', () => {
    const p = buildToolDiscoveryPolicy({
      productToolNames: ['agent_swarm'],
      deferredSurfaces: [{ id: 'agent', description: 'Agent pack', toolNames: ['agent_swarm'] }],
      mcpTools: [{ serverId: 'rogue', toolNames: ['agent_swarm'] }],
    });
    assert.deepEqual(p.get('agent_swarm'), {
      mode: 'deferred',
      namespace: 'agent',
      namespaceDescription: 'Agent pack',
    });
  });

  test('the first deferred surface claim wins over later surfaces', () => {
    const p = buildToolDiscoveryPolicy({
      productToolNames: ['shared'],
      deferredSurfaces: [
        { id: 'first', description: 'First', toolNames: ['shared'] },
        { id: 'second', description: 'Second', toolNames: ['shared'] },
      ],
      mcpTools: [],
    });
    assert.deepEqual(p.get('shared'), {
      mode: 'deferred',
      namespace: 'first',
      namespaceDescription: 'First',
    });
  });

  test('unbound surface members do not enter the policy', () => {
    const p = buildToolDiscoveryPolicy({
      productToolNames: ['Bash'],
      deferredSurfaces: [{ id: 'office', description: 'Office', toolNames: ['OfficeDocument'] }],
      mcpTools: [],
    });
    assert.equal(p.has('OfficeDocument'), false);
  });
});

describe('lowerToolsForProvider — fallback (capability none)', () => {
  const tools: MakaTool[] = [tool('Bash'), tool('mcp__github__create_issue'), tool('RiveWorkflow')];
  const pol = buildToolDiscoveryPolicy({
    productToolNames: ['Bash', 'RiveWorkflow'],
    deferredSurfaces: [{ id: 'rive', description: 'Rive', toolNames: ['RiveWorkflow'] }],
    mcpTools: [
      { serverId: 'github', serverDescription: 'GitHub', toolNames: ['mcp__github__create_issue'] },
    ],
  });

  test('fallback preserves the baseline allowlist, no search tool, no deferral', () => {
    const out = lowerToolsForProvider({
      tools,
      policy: pol,
      capability: 'none',
      baselineActiveTools: ['Bash', 'mcp__github__create_issue', 'RiveWorkflow'],
    });
    assert.equal(out.mode, 'none');
    assert.equal(out.searchTool, undefined);
    assert.deepEqual(out.deferredToolNames, []);
    assert.deepEqual(
      new Set(out.activeTools),
      new Set(['Bash', 'mcp__github__create_issue', 'RiveWorkflow']),
    );
    assert.equal(out.tools.length, 3);
    for (const entry of out.tools) {
      assert.equal(entry.deferLoading, undefined);
      assert.equal(entry.namespace, undefined);
      assert.equal(entry.namespaceDescription, undefined);
    }
  });

  test('fallback never reactivates a tool hidden by ToolAvailabilityRuntime', () => {
    const out = lowerToolsForProvider({
      tools,
      policy: pol,
      capability: 'none',
      baselineActiveTools: ['Bash'],
    });
    assert.deepEqual(out.activeTools, ['Bash']);
  });
});

describe('lowerToolsForProvider — anthropic native', () => {
  const tools: MakaTool[] = [tool('Bash'), tool('mcp__github__create_issue'), tool('RiveWorkflow')];
  const pol = buildToolDiscoveryPolicy({
    productToolNames: ['Bash', 'RiveWorkflow'],
    deferredSurfaces: [{ id: 'rive', description: 'Rive', toolNames: ['RiveWorkflow'] }],
    mcpTools: [
      { serverId: 'github', serverDescription: 'GitHub', toolNames: ['mcp__github__create_issue'] },
    ],
  });

  test('deferred tools are kept in activeTools and marked deferLoading', () => {
    const out = lowerToolsForProvider({
      tools,
      policy: pol,
      capability: 'anthropic',
      baselineActiveTools: ['Bash'],
    });
    assert.equal(out.mode, 'anthropic');
    assert.deepEqual(out.deferredToolNames, ['mcp__github__create_issue', 'RiveWorkflow']);
    // P1 fix: deferred tools remain in activeTools so the AI SDK `tools` dict
    // keeps them — `deferLoading` controls visibility, not activeTools.
    assert.ok(
      out.activeTools.includes('mcp__github__create_issue'),
      'MCP tool must stay in activeTools',
    );
    assert.ok(
      out.activeTools.includes('RiveWorkflow'),
      'Rive surface member must stay in activeTools',
    );
    assert.ok(out.activeTools.includes('Bash'), 'core Bash stays direct/active');

    const mcpEntry = out.tools.find((t) => t.name === 'mcp__github__create_issue');
    assert.equal(mcpEntry?.deferLoading, true);
    assert.equal(mcpEntry?.namespace, mcpNamespace('github'));
    const bashEntry = out.tools.find((t) => t.name === 'Bash');
    assert.equal(bashEntry?.deferLoading, undefined);
    assert.equal(bashEntry?.namespace, undefined);
  });

  test('a native search tool is added and kept active (BM25 by default)', () => {
    const out = lowerToolsForProvider({
      tools,
      policy: pol,
      capability: 'anthropic',
      baselineActiveTools: ['Bash'],
    });
    assert.equal(out.searchTool?.name, NATIVE_TOOL_SEARCH_NAME);
    assert.equal(out.searchTool?.kind, 'anthropic-bm25');
    assert.ok(out.activeTools.includes(NATIVE_TOOL_SEARCH_NAME));
    const searchEntry = out.tools.find((t) => t.name === NATIVE_TOOL_SEARCH_NAME);
    assert.ok(searchEntry, 'search tool entry present in tools dict');
    assert.equal(searchEntry?.deferLoading, undefined);
  });

  test('regex variant is honored', () => {
    const out = lowerToolsForProvider({
      tools,
      policy: pol,
      capability: 'anthropic',
      baselineActiveTools: ['Bash'],
      searchVariant: 'regex',
    });
    assert.equal(out.searchTool?.kind, 'anthropic-regex');
  });
});

describe('lowerToolsForProvider — openai native', () => {
  const tools: MakaTool[] = [tool('Bash'), tool('mcp__fs__read')];
  const pol = buildToolDiscoveryPolicy({
    productToolNames: ['Bash'],
    deferredSurfaces: [],
    mcpTools: [{ serverId: 'fs', serverDescription: 'Filesystem', toolNames: ['mcp__fs__read'] }],
  });

  test('deferred tools carry namespace + namespaceDescription; search tool kind is openai', () => {
    const out = lowerToolsForProvider({
      tools,
      policy: pol,
      capability: 'openai',
      baselineActiveTools: ['Bash'],
    });
    assert.equal(out.mode, 'openai');
    assert.equal(out.searchTool?.kind, 'openai');
    const fsEntry = out.tools.find((t) => t.name === 'mcp__fs__read');
    assert.equal(fsEntry?.deferLoading, true);
    assert.equal(fsEntry?.namespace, mcpNamespace('fs'));
    // P2 fix: namespaceDescription must be preserved for the OpenAI adapter to
    // construct the full `providerOptions.openai.namespace` payload.
    assert.equal(fsEntry?.namespaceDescription, 'Filesystem');
    // P1 fix: deferred tools stay in activeTools.
    assert.ok(out.activeTools.includes('mcp__fs__read'), 'deferred tool stays in activeTools');
    assert.ok(out.activeTools.includes(NATIVE_TOOL_SEARCH_NAME));
    assert.ok(out.activeTools.includes('Bash'));
  });
});

describe('lowerToolsForProvider — catalog authority', () => {
  test('an unclassified tool defaults to direct (never silently hidden)', () => {
    const out = lowerToolsForProvider({
      tools: [tool('UnknownTool')],
      policy: new Map(),
      capability: 'anthropic',
      baselineActiveTools: ['UnknownTool'],
    });
    assert.ok(out.activeTools.includes('UnknownTool'));
    assert.equal(out.tools[0].deferLoading, undefined);
    assert.deepEqual(out.deferredToolNames, []);
  });

  test('neverAdvertise tools stay in the dict but out of activeTools', () => {
    const out = lowerToolsForProvider({
      tools: [tool('Bash'), tool('invalid')],
      policy: new Map([['Bash', { mode: 'direct' }]]),
      capability: 'anthropic',
      baselineActiveTools: ['Bash', 'invalid'],
      neverAdvertise: new Set(['invalid']),
    });
    assert.ok(
      out.tools.some((t) => t.name === 'invalid'),
      'invalid stays dispatchable',
    );
    assert.ok(!out.activeTools.includes('invalid'), 'invalid never advertised');
    assert.ok(out.activeTools.includes('Bash'));
    assert.ok(out.activeTools.includes(NATIVE_TOOL_SEARCH_NAME));
  });

  test('neverAdvertise deferred tool stays in dict but out of activeTools', () => {
    const out = lowerToolsForProvider({
      tools: [tool('Bash'), tool('mcp__broken__x')],
      policy: new Map([
        ['Bash', { mode: 'direct' }],
        [
          'mcp__broken__x',
          { mode: 'deferred', namespace: 'mcp__broken', namespaceDescription: 'Broken' },
        ],
      ]),
      capability: 'anthropic',
      baselineActiveTools: ['Bash', 'mcp__broken__x'],
      neverAdvertise: new Set(['mcp__broken__x']),
    });
    assert.ok(
      out.tools.some((t) => t.name === 'mcp__broken__x'),
      'broken tool stays dispatchable',
    );
    assert.ok(!out.activeTools.includes('mcp__broken__x'), 'broken tool never advertised');
    assert.ok(out.deferredToolNames.includes('mcp__broken__x'), 'broken tool is deferred');
  });

  test('native search replaces the local connector instead of duplicating its name', () => {
    const out = lowerToolsForProvider({
      tools: [tool('Bash'), tool(NATIVE_TOOL_SEARCH_NAME), tool('RiveWorkflow')],
      policy: new Map([
        ['Bash', { mode: 'direct' }],
        ['RiveWorkflow', { mode: 'deferred', namespace: 'rive', namespaceDescription: 'Rive' }],
      ]),
      capability: 'anthropic',
      baselineActiveTools: ['Bash', NATIVE_TOOL_SEARCH_NAME],
    });
    assert.equal(out.tools.filter((entry) => entry.name === NATIVE_TOOL_SEARCH_NAME).length, 1);
  });
});
