import { deriveConnectionSlug } from '@maka/core/llm-connections';
import type { ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import {
  readRuntimeHostConnectionCatalog,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import { listApiKeyOnboardableProviders } from './onboarding-catalog.js';
import type {
  MakaOnboardingSurface,
  ModelChoice,
  OnboardingProviderEntry,
} from './pi-tui-contracts.js';

/** Adapt the TUI onboarding workflow to Host-owned verification and persistence. */
export function createRuntimeHostOnboardingSurface(
  connection: RuntimeHostConnection,
): MakaOnboardingSurface {
  return {
    listProviders: async () => projectProviders(await readRuntimeHostConnectionCatalog(connection)),
    verify: async (input) => {
      try {
        const result = await connection.request('connection.onboarding.verify', {
          providerType: input.providerType,
          apiKey: normalizedSecret(input.apiKey),
        });
        return result.kind === 'verified'
          ? { kind: 'ok', models: [...result.models] }
          : { kind: 'error', text: onboardingFailureText(result) };
      } catch (error) {
        return { kind: 'error', text: errorText(error) };
      }
    },
    save: async (input) => {
      try {
        const result = await connection.request('connection.onboarding.save', {
          providerType: input.providerType,
          apiKey: normalizedSecret(input.apiKey),
          enabledModelIds: [...input.enabledModelIds],
        });
        if (result.kind !== 'saved') {
          return { kind: 'error', text: onboardingFailureText(result) };
        }
        return {
          kind: 'ok',
          modelChoices: projectRuntimeHostModelChoices(
            await readRuntimeHostConnectionCatalog(connection),
          ),
        };
      } catch (error) {
        return { kind: 'error', text: errorText(error) };
      }
    },
  };
}

export function projectRuntimeHostModelChoices(catalog: ConnectionCatalogSnapshot): ModelChoice[] {
  const choices: ModelChoice[] = [];
  for (const connection of catalog.connections) {
    if (!connection.enabled) continue;
    const modelsById = new Map(connection.models.map((model) => [model.id, model]));
    const ids = new Set(connection.enabledModelIds);
    if (catalog.defaultTarget?.connectionId === connection.connectionId) {
      ids.add(catalog.defaultTarget.modelId);
    }
    for (const model of ids) {
      choices.push({
        connectionSlug: connection.slug,
        connectionName: connection.name,
        providerType: connection.providerType,
        model,
        isDefaultConnection: catalog.defaultTarget?.connectionId === connection.connectionId,
        contextWindow: modelsById.get(model)?.contextWindow,
      });
    }
  }
  return choices;
}

function projectProviders(catalog: ConnectionCatalogSnapshot): OnboardingProviderEntry[] {
  const bySlug = new Map(catalog.connections.map((connection) => [connection.slug, connection]));
  return listApiKeyOnboardableProviders().map((provider) => {
    const candidate = bySlug.get(deriveConnectionSlug(provider.providerType));
    const existing = candidate?.providerType === provider.providerType ? candidate : undefined;
    return {
      ...provider,
      hasConnection: existing !== undefined,
      enabledModelIds: existing ? [...existing.enabledModelIds] : [],
    };
  });
}

function normalizedSecret(value: string | undefined): string | null {
  const secret = value?.trim() ?? '';
  return secret.length === 0 ? null : secret;
}

function onboardingFailureText(input: {
  readonly kind: 'rejected' | 'failed';
  readonly reason?: string;
  readonly errorClass?: string;
}): string {
  if (input.kind === 'failed') return `Connection verification failed: ${input.errorClass}`;
  switch (input.reason) {
    case 'credential_not_configured':
      return 'API key is required';
    case 'provider_unsupported':
      return 'This provider does not support API-key onboarding';
    case 'slug_conflict':
      return 'The provider connection name is already used by another provider';
    case 'model_unavailable':
      return 'The selected model is no longer available';
    default:
      return 'Connection onboarding was rejected';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
