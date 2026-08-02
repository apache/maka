import { ipcMain } from 'electron';
import {
  isWebSearchProvider,
  normalizeWebSearchLimit,
  normalizeWebSearchQuery,
} from '@maka/core';
import type { WorkspacePrivacyContext } from '@maka/core/incognito';
import type { createSettingsStore } from '@maka/storage';
import { resolveTavilyApiKey } from './web-search/credentials.js';
import { queryTavily, TAVILY_TEST_LIMIT, TAVILY_TEST_QUERY } from './web-search/tavily.js';

type SettingsStore = ReturnType<typeof createSettingsStore>;

interface WebSearchIpcDeps {
  settingsStore: SettingsStore;
  getWorkspacePrivacyContext: () => Promise<WorkspacePrivacyContext>;
}

const unsupportedWebSearchProviderResponse = {
  ok: false,
  reason: 'unsupported_provider' as const,
  message: '当前配置不支持这个搜索引擎，请选择 Tavily 后重试。',
};

export function registerWebSearchIpc(deps: WebSearchIpcDeps): void {
  ipcMain.handle(
    'web-search:query',
    async (
      _event,
      request: { query?: unknown; limit?: unknown; provider?: unknown; apiKey?: unknown },
    ) => {
      const provider = request?.provider;
      if (provider !== undefined && !isWebSearchProvider(provider)) {
        return unsupportedWebSearchProviderResponse;
      }
      const query = normalizeWebSearchQuery(request?.query);
      if (query === null) {
        return { ok: false, reason: 'invalid_query' as const, message: '请输入有效的搜索关键词。' };
      }
      const privacy = await deps.getWorkspacePrivacyContext();
      if (privacy.incognitoActive) {
        return { ok: false, reason: 'incognito_active' as const, message: '隐身模式下禁用联网搜索。' };
      }
      const settings = await deps.settingsStore.get();
      if (!settings.webSearch.enabled) {
        return {
          ok: false,
          reason: 'not_configured' as const,
          message: '请先在 设置 · 联网搜索 中启用 Tavily。',
        };
      }
      const effectiveKey = resolveTavilyApiKey({ settings, draftKey: request?.apiKey });
      const limit = normalizeWebSearchLimit(request?.limit);
      return queryTavily({ apiKey: effectiveKey, query, limit });
    },
  );

  ipcMain.handle(
    'web-search:test',
    async (
      _event,
      request: { provider?: unknown; apiKey?: unknown } | undefined,
    ) => {
      const provider = request?.provider;
      if (provider !== undefined && !isWebSearchProvider(provider)) {
        return unsupportedWebSearchProviderResponse;
      }
      const settings = await deps.settingsStore.get();
      const effectiveKey = resolveTavilyApiKey({ settings, draftKey: request?.apiKey });
      return queryTavily({
        apiKey: effectiveKey,
        query: TAVILY_TEST_QUERY,
        limit: TAVILY_TEST_LIMIT,
      });
    },
  );
}
