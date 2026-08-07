import {
  PROVIDER_DEFAULTS,
  connectionEnabledModelIds,
  deriveConnectionSlug,
  providerAuthSupportsApiKey,
  type ConnectionLastTestStatus,
  type LlmConnection,
  type ModelDiscoverySource,
  type ModelInfo,
  type ProviderType,
} from '@maka/core/llm-connections';
import type { ConnectionStore, CredentialStore } from '@maka/storage';
import { listReadyModelChoices } from './connection-target.js';
import { listApiKeyOnboardableProviders } from './onboarding-catalog.js';
import type {
  MakaOnboardingSurface,
  ModelChoice,
  OnboardingProviderEntry,
  OnboardingSaveInput,
  OnboardingSaveResult,
  OnboardingVerifyInput,
  OnboardingVerifyResult,
} from './pi-tui-contracts.js';

/** Build the onboarding surface the TUI wizard calls, owning the connection and
 *  credential stores plus the model probe so the first-run host (cli.ts) and
 *  the in-session host (runtime-bootstrap) share one write path. */
export function createApiKeyOnboardingSurface(deps: {
  connectionStore: Pick<
    ConnectionStore,
    'list' | 'get' | 'create' | 'update' | 'remove' | 'getDefault' | 'setDefault'
  >;
  credentialStore: Pick<CredentialStore, 'getSecret' | 'setSecret' | 'deleteSecret'>;
  fetchModels: (connection: LlmConnection, apiKey: string) => Promise<ModelInfo[]>;
}): MakaOnboardingSurface {
  return {
    listProviders: () => listOnboardingProviders({ connectionStore: deps.connectionStore }),
    verify: (input) =>
      verifyApiKeyConnection({
        providerType: input.providerType,
        apiKey: input.apiKey,
        connectionStore: deps.connectionStore,
        credentialStore: deps.credentialStore,
        fetchModels: deps.fetchModels,
      }),
    save: (input) =>
      saveApiKeyConnection({
        providerType: input.providerType,
        apiKey: input.apiKey,
        enabledModelIds: input.enabledModelIds,
        models: input.models,
        connectionStore: deps.connectionStore,
        credentialStore: deps.credentialStore,
        fetchModelChoices: () =>
          listReadyModelChoices({
            connectionStore: deps.connectionStore,
            credentialStore: deps.credentialStore,
          }),
      }),
  };
}

/** Catalog API-key providers (phase 1) annotated with the host's existing
 *  connection state. The wizard calls this when it opens so `已设置` and the
 *  preserved enabled set reflect live storage, not a startup snapshot. */
export async function listOnboardingProviders(input: {
  connectionStore: Pick<ConnectionStore, 'list'>;
}): Promise<OnboardingProviderEntry[]> {
  const connections = await input.connectionStore.list();
  const bySlug = new Map(connections.map((connection) => [connection.slug, connection]));
  return listApiKeyOnboardableProviders().map((provider) => {
    const candidate = bySlug.get(deriveConnectionSlug(provider.providerType));
    const existing = candidate?.providerType === provider.providerType ? candidate : undefined;
    return {
      ...provider,
      hasConnection: existing !== undefined,
      enabledModelIds: existing ? connectionEnabledModelIds(existing) : [],
    };
  });
}

export interface VerifyApiKeyConnectionInput extends OnboardingVerifyInput {
  /** Supplied key. Blank for an existing connection reuses the stored secret;
   *  blank for a new required-key connection is rejected. Never returned to the
   *   wizard — verify is host-owned. */
  apiKey?: string;
  connectionStore: Pick<ConnectionStore, 'get'>;
  credentialStore: Pick<CredentialStore, 'getSecret'>;
  fetchModels: (connection: LlmConnection, apiKey: string) => Promise<ModelInfo[]>;
}

export type VerifyApiKeyConnectionResult = OnboardingVerifyResult;

/** Probe a provider with a supplied or stored secret without persisting: the
 *  wizard's key step verifies the key works and discovers models, then defers
 *  all persistence to {@link saveApiKeyConnection}. An existing connection may
 *  leave the key blank to reuse the stored secret; a new required-key connection
 *  must supply one. Pure and dependency-injected so the TUI wizard drives the
 *  same seam the tests do. */
export async function verifyApiKeyConnection(
  input: VerifyApiKeyConnectionInput,
): Promise<VerifyApiKeyConnectionResult> {
  if (!providerAuthSupportsApiKey(input.providerType)) {
    return { kind: 'error', text: `Provider "${input.providerType}" does not accept an API key` };
  }
  const def = PROVIDER_DEFAULTS[input.providerType];
  const requiresKey = def?.authKind === 'api_key';
  const suppliedKey = input.apiKey?.trim() ?? '';
  const canonicalSlug = deriveConnectionSlug(input.providerType);
  const candidate = await input.connectionStore.get(canonicalSlug);
  if (candidate && candidate.providerType !== input.providerType) {
    return {
      kind: 'error',
      text: `Connection slug "${canonicalSlug}" belongs to another provider`,
    };
  }
  const existing = candidate;
  let connection: LlmConnection;
  let secret: string;
  if (existing) {
    connection = existing;
    if (suppliedKey) {
      secret = suppliedKey;
    } else {
      const stored = (await input.credentialStore.getSecret(existing.slug, 'api_key')) ?? '';
      if (requiresKey && !stored) return { kind: 'error', text: 'API key is required' };
      secret = stored;
    }
  } else {
    if (requiresKey && !suppliedKey) return { kind: 'error', text: 'API key is required' };
    secret = suppliedKey;
    connection = transientOnboardingConnection(input.providerType);
  }
  try {
    const models = await input.fetchModels(connection, secret);
    return { kind: 'ok', models };
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
  }
}

/** Build a transient, in-memory connection from catalog defaults so a new
 *  provider's verify can probe without persisting a half-configured connection. */
function transientOnboardingConnection(providerType: ProviderType): LlmConnection {
  const def = PROVIDER_DEFAULTS[providerType];
  const now = Date.now();
  return {
    slug: deriveConnectionSlug(providerType),
    name: def.label,
    providerType,
    ...(def.baseUrl ? { baseUrl: def.baseUrl } : {}),
    defaultModel: def.fallbackModels[0] ?? '',
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
}

export interface SaveApiKeyConnectionInput extends OnboardingSaveInput {
  /** Supplied key. Blank for an existing connection leaves the stored secret
   *   untouched; a new connection must supply one (verify already enforced it). */
  apiKey?: string;
  /** Curated enabled model ids — at least one is required before saving. */
  enabledModelIds: readonly string[];
  /** Discovered models from verify, cached on the connection. */
  models: readonly ModelInfo[];
  connectionStore: Pick<
    ConnectionStore,
    'get' | 'create' | 'update' | 'remove' | 'getDefault' | 'setDefault'
  >;
  credentialStore: Pick<CredentialStore, 'getSecret' | 'setSecret' | 'deleteSecret'>;
  /** Refreshed authoritative ready model choices for the running TUI. */
  fetchModelChoices: () => Promise<ModelChoice[]>;
}

export type SaveApiKeyConnectionResult = OnboardingSaveResult;

/** Persist the verified connection with the curated enabled-model set, caching
 *  discovered models and normalizing the required compatibility `defaultModel`
 *  (kept when still enabled, otherwise the first enabled model — never a user
 *  default choice). `setDefault` runs only when no default connection exists, so
 *  in-session setup never replaces an existing default. A new connection's
 *  secret-write failure rolls back the created connection; an existing
 *  connection's rotation failure leaves it untouched. Pure and DI so the TUI
 *  wizard drives the same seam the tests do. */
export async function saveApiKeyConnection(
  input: SaveApiKeyConnectionInput,
): Promise<SaveApiKeyConnectionResult> {
  if (!providerAuthSupportsApiKey(input.providerType)) {
    return { kind: 'error', text: `Provider "${input.providerType}" does not accept an API key` };
  }
  const enabled = input.enabledModelIds.map((id) => id.trim()).filter(Boolean);
  if (enabled.length === 0) {
    return { kind: 'error', text: '至少选择一个模型再保存' };
  }
  const def = PROVIDER_DEFAULTS[input.providerType];
  const suppliedKey = input.apiKey?.trim() ?? '';
  const canonicalSlug = deriveConnectionSlug(input.providerType);
  const candidate = await input.connectionStore.get(canonicalSlug);
  if (candidate && candidate.providerType !== input.providerType) {
    return {
      kind: 'error',
      text: `Connection slug "${canonicalSlug}" belongs to another provider`,
    };
  }
  const existing = candidate;
  const normalizedDefault =
    existing && enabled.includes(existing.defaultModel) ? existing.defaultModel : enabled[0]!;
  const testAt = new Date().toISOString();
  const modelPatch = {
    enabled: true,
    defaultModel: normalizedDefault,
    enabledModelIds: enabled,
    models: [...input.models],
    modelSource: 'fetched' as ModelDiscoverySource,
    modelsFetchedAt: Date.now(),
    lastTestStatus: 'verified' as ConnectionLastTestStatus,
    lastTestAt: testAt,
  };
  let connectionSlug: string;

  if (existing) {
    connectionSlug = existing.slug;
    // Rotate the key first (if supplied): a rotation failure leaves the existing
    // connection untouched (previous secret + previous curation stand). A failed
    // curation write rolls the rotation back so the connection keeps its previous
    // secret + curation — save stays atomic from the caller's view.
    if (suppliedKey) {
      const previousSecret = await input.credentialStore.getSecret(connectionSlug, 'api_key');
      try {
        await input.credentialStore.setSecret(connectionSlug, 'api_key', suppliedKey);
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
      }
      try {
        await input.connectionStore.update(connectionSlug, modelPatch);
      } catch (error) {
        if (previousSecret !== null) {
          await input.credentialStore.setSecret(connectionSlug, 'api_key', previousSecret);
        } else {
          await input.credentialStore.deleteSecret(connectionSlug, 'api_key');
        }
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
      }
    } else {
      try {
        await input.connectionStore.update(connectionSlug, modelPatch);
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
      }
    }
  } else {
    const created = await input.connectionStore.create({
      slug: canonicalSlug,
      name: def.label,
      providerType: input.providerType,
      defaultModel: normalizedDefault,
    });
    connectionSlug = created.slug;
    try {
      await input.credentialStore.setSecret(connectionSlug, 'api_key', suppliedKey);
    } catch (error) {
      // Atomicity: a newly-created connection is rolled back when the secret
      // write fails, so no half-configured connection becomes the default.
      await input.connectionStore.remove(connectionSlug);
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
    }
    try {
      await input.connectionStore.update(connectionSlug, modelPatch);
    } catch (error) {
      // Atomicity: a failed curation write rolls back the new connection + secret
      // so no half-configured default connection is left behind for first-run.
      await input.connectionStore.remove(connectionSlug);
      await input.credentialStore.deleteSecret(connectionSlug, 'api_key');
      return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
    }
  }

  // setDefault only when no default connection exists (first run, or a host with
  // no prior default). In-session setup never replaces an existing default.
  if ((await input.connectionStore.getDefault()) === null) {
    await input.connectionStore.setDefault(connectionSlug);
  }

  const modelChoices = await input.fetchModelChoices();
  return { kind: 'ok', modelChoices };
}
