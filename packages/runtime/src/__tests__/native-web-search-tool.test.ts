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
import {
  buildNativeWebSearchTool,
  NATIVE_WEB_SEARCH_TOOL_NAME,
  routeWebSearchTools,
} from '../native-web-search-tool.js';
import type { MakaTool } from '../tool-runtime.js';

test('native WebSearch is a provider-executed descriptor, not a local implementation', () => {
  const tool = buildNativeWebSearchTool();
  assert.equal(tool.name, NATIVE_WEB_SEARCH_TOOL_NAME);
  assert.equal(tool.categoryHint, 'web_read');
  assert.equal(tool.activityKind, 'websearch');
  assert.deepEqual(tool.providerTool, {
    kind: 'openai-web-search',
    searchContextSize: 'medium',
  });
  assert.throws(() => tool.impl({}, {} as never), /must not execute through ToolRuntime/);
});

test('turn-start routing falls back explicitly when native search is unavailable', () => {
  const clientSearch = {
    name: NATIVE_WEB_SEARCH_TOOL_NAME,
    description: 'Tavily',
    parameters: {},
    impl: async () => undefined,
  } satisfies MakaTool;
  const read = {
    name: 'Read',
    description: 'Read',
    parameters: {},
    impl: async () => undefined,
  } satisfies MakaTool;
  const connection = {
    slug: 'deepseek',
    providerType: 'deepseek' as const,
    defaultModel: 'deepseek-v4-flash',
    models: [{ id: 'deepseek-v4-flash', capabilities: { webSearch: true } }],
  };

  const native = routeWebSearchTools({
    tools: [read, clientSearch],
    settings: { enabled: true, defaultProvider: 'model' },
    connection,
    model: 'deepseek-v4-flash',
    tavilyReady: false,
  });
  assert.deepEqual(
    native.map((tool) => tool.name),
    ['Read'],
  );

  const external = routeWebSearchTools({
    tools: [read, clientSearch],
    settings: { enabled: true, defaultProvider: 'tavily' },
    connection,
    model: 'deepseek-v4-flash',
    tavilyReady: true,
  });
  assert.equal(
    external.find((tool) => tool.name === NATIVE_WEB_SEARCH_TOOL_NAME),
    clientSearch,
  );

  const unavailableExternal = routeWebSearchTools({
    tools: [read, clientSearch],
    settings: { enabled: true, defaultProvider: 'tavily' },
    connection,
    model: 'deepseek-v4-flash',
    tavilyReady: false,
  });
  assert.deepEqual(
    unavailableExternal.map((tool) => tool.name),
    ['Read'],
  );

  const disabled = routeWebSearchTools({
    tools: [read, clientSearch],
    settings: { enabled: false, defaultProvider: 'model' },
    connection,
    model: 'deepseek-v4-flash',
    tavilyReady: false,
  });
  assert.deepEqual(
    disabled.map((tool) => tool.name),
    ['Read'],
  );

  const incognito = routeWebSearchTools({
    tools: [read, clientSearch],
    settings: { enabled: true, defaultProvider: 'model' },
    privacy: { incognitoActive: true },
    connection,
    model: 'deepseek-v4-flash',
    tavilyReady: false,
  });
  assert.deepEqual(
    incognito.map((tool) => tool.name),
    ['Read'],
  );
});

test('turn-start routing compiles Claude models to the CC-compatible Anthropic tool', () => {
  const clientSearch = {
    name: NATIVE_WEB_SEARCH_TOOL_NAME,
    description: 'Tavily',
    parameters: {},
    impl: async () => undefined,
  } satisfies MakaTool;
  const routed = routeWebSearchTools({
    tools: [clientSearch],
    settings: { enabled: true, defaultProvider: 'model' },
    connection: {
      slug: 'anthropic',
      providerType: 'anthropic',
      defaultModel: 'claude-sonnet-4-6',
    },
    model: 'claude-sonnet-4-6',
    tavilyReady: false,
  });

  assert.deepEqual(routed[0]?.providerTool, {
    kind: 'anthropic-web-search-20250305',
    maxUses: 8,
  });
});

test('turn-start routing compiles Qwen3.8 Max Token Plan to Responses web search', () => {
  const routed = routeWebSearchTools({
    tools: [],
    settings: { enabled: true, defaultProvider: 'model' },
    connection: {
      slug: 'alibaba-token-plan-cn',
      providerType: 'alibaba-token-plan-cn',
      defaultModel: 'qwen3.8-max',
    },
    model: 'qwen3.8-max',
    tavilyReady: false,
    allowAddNative: true,
  });

  assert.equal(routed.length, 1);
  assert.equal(routed[0]?.name, NATIVE_WEB_SEARCH_TOOL_NAME);
  assert.deepEqual(routed[0]?.providerTool, {
    kind: 'openai-web-search',
    searchContextSize: 'medium',
  });
});

test('root surfaces do not advertise unsupported DeepSeek native search', () => {
  const connection = {
    slug: 'deepseek',
    providerType: 'deepseek' as const,
    defaultModel: 'deepseek-v4-flash',
  };
  const root = routeWebSearchTools({
    tools: [],
    settings: { enabled: true, defaultProvider: 'model' },
    connection,
    model: 'deepseek-v4-flash',
    tavilyReady: false,
    allowAddNative: true,
  });
  assert.deepEqual(root, []);

  const child = routeWebSearchTools({
    tools: [],
    settings: { enabled: true, defaultProvider: 'model' },
    connection,
    model: 'deepseek-v4-flash',
    tavilyReady: false,
  });
  assert.deepEqual(child, []);
});

test('the WebSearch feature gate leaves WebFetch available', () => {
  const webFetch = {
    name: 'WebFetch',
    description: 'Read a URL',
    parameters: {},
    impl: async () => undefined,
  } satisfies MakaTool;

  const routed = routeWebSearchTools({
    tools: [webFetch],
    settings: { enabled: false, defaultProvider: 'model' },
    connection: {
      slug: 'deepseek',
      providerType: 'deepseek',
      defaultModel: 'deepseek-v4-flash',
    },
    model: 'deepseek-v4-flash',
    tavilyReady: false,
  });

  assert.deepEqual(
    routed.map((tool) => tool.name),
    ['WebFetch'],
  );
});
