import type { IpcMain } from 'electron';
import {
  isWebSearchProvider,
  MASKED_TOKEN_SENTINEL,
  normalizeWebSearchLimit,
  normalizeWebSearchQuery,
} from '@maka/core';
import { SENSITIVE_PLACEHOLDER } from '@maka/core/settings/network-settings';
import type { DesktopRuntimeHostClient } from './runtime-host-client.js';

type RuntimeHostWebSearchClient = Pick<
  DesktopRuntimeHostClient,
  'executeWebSearch'
>;

interface RuntimeHostWebSearchIpcDeps {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly client: RuntimeHostWebSearchClient;
}

const unsupportedProvider = {
  ok: false,
  reason: 'unsupported_provider' as const,
  message: '当前配置不支持这个搜索引擎，请选择 Tavily 后重试。',
};

export function registerRuntimeHostWebSearchIpc(
  deps: RuntimeHostWebSearchIpcDeps,
): void {
  deps.ipcMain.handle(
    'web-search:query',
    async (
      _event,
      request: {
        query?: unknown;
        limit?: unknown;
        provider?: unknown;
        apiKey?: unknown;
      },
    ) => {
      if (
        request?.provider !== undefined &&
        !isWebSearchProvider(request.provider)
      ) {
        return unsupportedProvider;
      }
      if (request?.provider === 'model') {
        return {
          ok: false,
          reason: 'unsupported_provider' as const,
          message:
            '原生联网搜索由对话中的主模型请求执行，不支持从设置页单独调用。',
        };
      }
      const query = normalizeWebSearchQuery(request?.query);
      if (!query) {
        return {
          ok: false,
          reason: 'invalid_query' as const,
          message: '请输入有效的搜索关键词。',
        };
      }
      const apiKey = credentialOverride(request?.apiKey);
      return deps.client.executeWebSearch({
        kind: 'query',
        query,
        limit: normalizeWebSearchLimit(request?.limit),
        ...(apiKey ? { apiKey } : {}),
      });
    },
  );
  deps.ipcMain.handle(
    'web-search:test',
    async (
      _event,
      request: { provider?: unknown; apiKey?: unknown } | undefined,
    ) => {
      if (
        request?.provider !== undefined &&
        !isWebSearchProvider(request.provider)
      ) {
        return unsupportedProvider;
      }
      if (request?.provider === 'model') {
        return {
          ok: false,
          reason: 'unsupported_provider' as const,
          message:
            '原生联网搜索由对话中的主模型请求执行，不需要单独测试搜索凭据。',
        };
      }
      const apiKey = credentialOverride(request?.apiKey);
      return deps.client.executeWebSearch({
        kind: 'test',
        provider: 'tavily',
        ...(apiKey ? { apiKey } : {}),
      });
    },
  );
}

function credentialOverride(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === MASKED_TOKEN_SENTINEL ||
    value === SENSITIVE_PLACEHOLDER
  ) {
    return undefined;
  }
  return value;
}
