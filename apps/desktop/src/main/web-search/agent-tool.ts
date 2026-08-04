/**
 * PR-AGENT-WEB-SEARCH-TOOL-0 — `WebSearch` agent tool. Returns a
 * `MakaTool` factory that closes over the existing main-process
 * Tavily client + the settings store. Renderer never imports this.
 *
 * Policy hookup: the tool name `WebSearch` is mapped to category
 * `web_read` in `@maka/core/permission`. The PR matrix change makes
 * `web_read` `prompt` in `explore` / `ask` and `allow` in `execute`,
 * so the agent emits a permission request the user must approve in
 * the default mode.
 *
 * Fail-closed paths:
 *   - incognito context active → `incognito_active`
 *   - `webSearch.enabled === false` → `not_configured`
 *   - Tavily key empty → `not_configured`
 *
 * The query is treated as user-derived content; we never persist it
 * to telemetry (see the `argsSummary` scrub in main.ts).
 */

import { z } from 'zod';
import {
  WEB_SEARCH_DEFAULT_LIMIT,
  WEB_SEARCH_MAX_LIMIT,
  normalizeWebSearchLimit,
  normalizeWebSearchQuery,
  validateWorkspacePrivacyContext,
  type WebSearchCredentialSource,
  type WebSearchErrorReason,
  type WebSearchProvider,
} from '@maka/core';
import { defaultWorkspacePrivacyContext } from '@maka/core/incognito';
import type { MakaTool } from '@maka/runtime';
import { queryTavily } from './tavily.js';
import type { SettingsStore } from '@maka/storage';
import { getTavilyCredentialSource, resolveTavilyApiKey } from './credentials.js';

export const WEB_SEARCH_TOOL_NAME = 'WebSearch';

function webSearchErrorContent(input: {
  reason: WebSearchErrorReason;
  message: string;
  query?: string;
  credentialSource?: WebSearchCredentialSource;
  provider?: WebSearchProvider;
}) {
  return {
    kind: 'web_search_error' as const,
    ok: false as const,
    provider: input.provider ?? 'tavily',
    ...(input.query ? { query: input.query } : {}),
    reason: input.reason,
    message: input.message,
    ...(input.credentialSource ? { credentialSource: input.credentialSource } : {}),
  };
}

export function buildWebSearchAgentTool(deps: {
  settingsStore: SettingsStore;
  getPrivacyContext?: () => Promise<unknown>;
}): MakaTool {
  return {
    name: WEB_SEARCH_TOOL_NAME,
    description:
      'Query the live web through the configured external search provider. ' +
      'Returns a short list of {title, url, snippet, source} rows. ' +
      'Use ONLY when the user asks for current external information; ' +
      'never call speculatively. Each call is gated on explicit user ' +
      'approval in the default permission mode.',
    parameters: z.object({
      query: z
        .string()
        .min(1)
        .max(200)
        .describe('Search query, plain text, max 200 chars'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(WEB_SEARCH_MAX_LIMIT)
        .optional()
        .describe(`Max results to return (default ${WEB_SEARCH_DEFAULT_LIMIT}).`),
    }),
    displayName: '联网搜索',
    impl: async ({ query, limit }, context) => {
      const normalizedQuery = normalizeWebSearchQuery(query);
      if (normalizedQuery === null) {
        return webSearchErrorContent({
          reason: 'invalid_query',
          message: '联网搜索请求未提供有效查询。',
        });
      }
      const privacyPayload = await (deps.getPrivacyContext?.() ?? defaultWorkspacePrivacyContext());
      const privacy = validateWorkspacePrivacyContext(privacyPayload);
      if (!privacy.ok) {
        return webSearchErrorContent({
          reason: 'incognito_active',
          message: '联网搜索已关闭，因为工作区隐私状态无法确认。',
          query: normalizedQuery,
        });
      }
      if (privacy.value.incognitoActive) {
        return webSearchErrorContent({
          reason: 'incognito_active',
          message: '隐身模式下禁用联网搜索。',
          query: normalizedQuery,
        });
      }
      const settings = await deps.settingsStore.get();
      const credentialSource =
        settings.webSearch.defaultProvider === 'tavily'
          ? getTavilyCredentialSource(settings)
          : undefined;
      if (!settings.webSearch.enabled) {
        return webSearchErrorContent({
          reason: 'not_configured',
          message: '请先在 设置 · 联网搜索 中启用联网搜索。',
          query: normalizedQuery,
          ...(credentialSource ? { credentialSource } : {}),
        });
      }
      if (settings.webSearch.defaultProvider === 'model') {
        return webSearchErrorContent({
          reason: 'unsupported_provider',
          message: '原生联网搜索必须由主模型请求执行，不能通过本地 WebSearch 工具调用。',
          query: normalizedQuery,
          provider: 'model',
        });
      }
      const apiKey = resolveTavilyApiKey({ settings });
      if (apiKey.length === 0) {
        return webSearchErrorContent({
          reason: 'not_configured',
          message: '请先在 设置 · 联网搜索 中保存 Tavily API key。',
          query: normalizedQuery,
          credentialSource,
        });
      }
      const tavilyResponse = await queryTavily({
        apiKey,
        query: normalizedQuery,
        limit: normalizeWebSearchLimit(limit),
      });
      if (!tavilyResponse.ok) {
        return webSearchErrorContent({
          reason: tavilyResponse.reason,
          message: tavilyResponse.message,
          query: normalizedQuery,
          credentialSource,
        });
      }
      // PR-CHAT-WEB-SEARCH-RENDER-0: wrap the success result as
      // `kind: 'web_search'` so the chat-side ToolResultPreview can
      // render plain-text cards instead of dumping JSON. The LLM
      // still reads the rows directly — same fields, just nested.
      return {
        kind: 'web_search' as const,
        provider: 'tavily',
        query: normalizedQuery,
        rows: tavilyResponse.results.map((row) => ({
          title: row.title,
          url: row.url,
          snippet: row.snippet,
          source: row.source,
        })),
      };
    },
  };
}
