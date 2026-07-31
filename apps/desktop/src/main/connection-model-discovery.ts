import {
  PROVIDER_DEFAULTS,
  providerAuthRequiresSecret,
  providerSupportsModelDiscovery,
  type ModelDiscoveryResult,
} from '@maka/core/llm-connections';
import { fetchProviderModels } from '@maka/runtime';
import type { ConnectionStore } from '@maka/storage';

export interface ConnectionModelDiscoveryDeps {
  connectionStore: Pick<ConnectionStore, 'get' | 'update'>;
  resolveConnectionSecret(slug: string): Promise<string | null>;
  fetchModels?: typeof fetchProviderModels;
  now?: () => number;
}

export class ConnectionModelDiscoveryPreconditionError extends Error {
  override readonly name = 'ConnectionModelDiscoveryPreconditionError';
}

export async function discoverConnectionModels(
  deps: ConnectionModelDiscoveryDeps,
  slug: string,
): Promise<ModelDiscoveryResult> {
  const connection = await deps.connectionStore.get(slug);
  if (!connection) throw new ConnectionModelDiscoveryPreconditionError(`找不到模型连接：${slug}`);
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  if (!defaults || !providerSupportsModelDiscovery(connection.providerType)) {
    throw new ConnectionModelDiscoveryPreconditionError(
      `Provider "${connection.providerType}" does not support remote model discovery`,
    );
  }
  const apiKey = await deps.resolveConnectionSecret(slug);
  if (providerAuthRequiresSecret(connection.providerType) && !apiKey) {
    throw new ConnectionModelDiscoveryPreconditionError(
      defaults.authKind === 'oauth_token'
        ? '这个 OAuth 模型连接还没有登录'
        : '这个模型连接还没有保存 API key',
    );
  }
  const fetchedAt = (deps.now ?? Date.now)();
  const models = await (deps.fetchModels ?? fetchProviderModels)(connection, apiKey ?? '');
  if (models.length === 0) {
    throw new Error('Provider returned no usable models');
  }
  await deps.connectionStore.update(slug, {
    models,
    modelSource: 'fetched',
    modelsFetchedAt: fetchedAt,
  });
  return {
    models,
    source: 'fetched',
    fetchedAt,
  };
}
