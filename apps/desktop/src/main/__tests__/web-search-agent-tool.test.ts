/**
 * PR-AGENT-WEB-SEARCH-TOOL-0 — fail-closed gates for the agent
 * WebSearch tool. The Tavily HTTP call itself is exercised in
 * `tavily.ts` but stubbed here via a settings store that puts the
 * tool in the various non-network branches.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { buildWebSearchAgentTool, WEB_SEARCH_TOOL_NAME } from '../web-search/agent-tool.js';
import { defaultWebSearchSettings } from '@maka/core';
import type { AppSettings } from '@maka/core';
import type { SettingsStore } from '@maka/storage';
import { createDefaultSettings } from '@maka/core/settings';

function makeSettingsStore(override: (s: AppSettings) => AppSettings): SettingsStore {
  const base = override(createDefaultSettings());
  return {
    get: async () => base,
    update: async () => ({ settings: base }),
    setOnboardingMilestone: async () => base,
    usageStats: async () => ({
      summary: {
        totalRequests: 0,
        totalCostUsd: 0,
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheTokens: 0,
        cacheRead: 0,
        cacheCreation: 0,
      },
      logs: [],
      byProvider: [],
      byModel: [],
      byTool: [],
      pricing: [],
    }),
  } as unknown as SettingsStore;
}

async function runTool(
  store: SettingsStore,
  args: { query?: unknown; limit?: number } = { query: 'hello' },
  extraDeps: Partial<Parameters<typeof buildWebSearchAgentTool>[0]> = {},
) {
  const tool = buildWebSearchAgentTool({ settingsStore: store, ...extraDeps });
  return tool.impl(args as Parameters<typeof tool.impl>[0], {
    sessionId: 's',
    turnId: 't',
    cwd: '/tmp',
    toolCallId: 'tc',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
  });
}

describe('WebSearch agent tool (PR-AGENT-WEB-SEARCH-TOOL-0)', () => {
  it('registers under the canonical WebSearch name', () => {
    const tool = buildWebSearchAgentTool({ settingsStore: makeSettingsStore((s) => s) });
    assert.equal(tool.name, WEB_SEARCH_TOOL_NAME);
    assert.equal(tool.name, 'WebSearch');
    assert.equal(tool.categoryHint, undefined);
  });

  it('fails closed with invalid_query for empty / whitespace-only query', async () => {
    const store = makeSettingsStore((s) => ({
      ...s,
      webSearch: {
        ...defaultWebSearchSettings(),
        enabled: true,
        defaultProvider: 'tavily',
        providers: { tavily: { ...defaultWebSearchSettings().providers.tavily, apiKey: 'tvly-xxx' } },
      },
    }));
    const out1 = (await runTool(store, { query: '' })) as { ok: boolean; reason?: string };
    assert.equal((out1 as { kind?: string }).kind, 'web_search_error');
    assert.equal(out1.ok, false);
    assert.equal(out1.reason, 'invalid_query');
    const out2 = (await runTool(store, { query: '    ' })) as { ok: boolean; reason?: string };
    assert.equal((out2 as { kind?: string }).kind, 'web_search_error');
    assert.equal(out2.ok, false);
    assert.equal(out2.reason, 'invalid_query');
  });

  it('fails closed with not_configured when webSearch.enabled is false', async () => {
    const store = makeSettingsStore((s) => ({
      ...s,
      webSearch: {
        ...defaultWebSearchSettings(),
        enabled: false,
        defaultProvider: 'tavily',
        providers: { tavily: { ...defaultWebSearchSettings().providers.tavily, apiKey: 'tvly-real-key' } },
      },
    }));
    const out = (await runTool(store)) as { ok: boolean; reason?: string };
    assert.equal((out as { kind?: string; credentialSource?: string }).kind, 'web_search_error');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'not_configured');
    assert.equal((out as { credentialSource?: string }).credentialSource, 'saved');
  });

  it('fails closed before reading settings when incognito is active', async () => {
    let settingsReads = 0;
    const store = {
      ...makeSettingsStore((s) => s),
      get: async () => {
        settingsReads += 1;
        return createDefaultSettings();
      },
    } as unknown as SettingsStore;
    const out = (await runTool(store, { query: 'latest ai news' }, {
      getPrivacyContext: async () => ({ incognitoActive: true }),
    })) as { ok: boolean; reason?: string; message?: string };
    assert.equal((out as { kind?: string }).kind, 'web_search_error');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'incognito_active');
    assert.match(out.message ?? '', /隐身模式/);
    assert.equal(settingsReads, 0);
  });

  it('fails closed before reading settings when privacy context is malformed', async () => {
    let settingsReads = 0;
    const store = {
      ...makeSettingsStore((s) => s),
      get: async () => {
        settingsReads += 1;
        return createDefaultSettings();
      },
    } as unknown as SettingsStore;
    const out = (await runTool(store, { query: 'latest ai news' }, {
      getPrivacyContext: async () => ({}),
    })) as { ok: boolean; reason?: string; message?: string };
    assert.equal((out as { kind?: string }).kind, 'web_search_error');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'incognito_active');
    assert.match(out.message ?? '', /隐私状态无法确认/);
    assert.equal(settingsReads, 0);
  });

  it('fails closed with not_configured when apiKey is empty', async () => {
    const store = makeSettingsStore((s) => ({
      ...s,
      webSearch: {
        ...defaultWebSearchSettings(),
        enabled: true,
        defaultProvider: 'tavily',
        providers: { tavily: { ...defaultWebSearchSettings().providers.tavily, apiKey: '' } },
      },
    }));
    const out = (await runTool(store)) as { ok: boolean; reason?: string; message?: string };
    assert.equal((out as { kind?: string; credentialSource?: string }).kind, 'web_search_error');
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'not_configured');
    assert.equal((out as { credentialSource?: string }).credentialSource, 'none');
    // Generalized copy — never leaks the empty-key fact as a raw code.
    assert.match(out.message ?? '', /Tavily/);
  });

  it('tool description warns the agent against speculative calls', () => {
    const tool = buildWebSearchAgentTool({ settingsStore: makeSettingsStore((s) => s) });
    assert.match(tool.description, /never call speculatively|explicit user approval/i);
  });
});
