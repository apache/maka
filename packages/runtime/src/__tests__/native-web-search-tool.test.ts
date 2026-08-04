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

test('turn-start routing keeps native and client-executed search mutually exclusive', () => {
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
  });
  assert.equal(native.filter((tool) => tool.name === NATIVE_WEB_SEARCH_TOOL_NAME).length, 1);
  assert.equal(
    native.find((tool) => tool.name === NATIVE_WEB_SEARCH_TOOL_NAME)?.providerTool?.kind,
    'openai-web-search',
  );

  const external = routeWebSearchTools({
    tools: [read, clientSearch],
    settings: { enabled: true, defaultProvider: 'tavily' },
    connection,
    model: 'deepseek-v4-flash',
  });
  assert.equal(
    external.find((tool) => tool.name === NATIVE_WEB_SEARCH_TOOL_NAME),
    clientSearch,
  );

  const disabled = routeWebSearchTools({
    tools: [read, clientSearch],
    settings: { enabled: false, defaultProvider: 'model' },
    connection,
    model: 'deepseek-v4-flash',
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
  });

  assert.deepEqual(routed[0]?.providerTool, {
    kind: 'anthropic-web-search-20250305',
    maxUses: 8,
  });
});

test('root surfaces may add native search without widening scoped child tools', () => {
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
    allowAddNative: true,
  });
  assert.equal(root[0]?.providerTool?.kind, 'openai-web-search');

  const child = routeWebSearchTools({
    tools: [],
    settings: { enabled: true, defaultProvider: 'model' },
    connection,
    model: 'deepseek-v4-flash',
  });
  assert.deepEqual(child, []);
});
