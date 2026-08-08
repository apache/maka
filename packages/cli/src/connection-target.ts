import { isConnectionReady, type ChatConfigurationReason } from '@maka/core/connection-readiness';
import type { LlmConnection, ProviderType } from '@maka/core/llm-connections';
import { connectionEnabledModelIds, PROVIDER_DEFAULTS } from '@maka/core/llm-connections';
import { thinkingVariantsForConnection } from '@maka/core/model-thinking';
import {
  isOAuthSubscriptionProvider,
  resolveOAuthSubscriptionTokens,
  resolveSelectedModelContextWindow,
  type OAuthSubscriptionTokens,
} from '@maka/runtime';
import type { ConnectionStore, CredentialKind, CredentialStore } from '@maka/storage';
import type { ModelChoice } from './pi-tui-contracts.js';

export interface ReadySessionTarget {
  connection: LlmConnection;
  apiKey: string;
  model: string;
  oauthTokens?: OAuthSubscriptionTokens;
}

export function selectableModelIdsForTarget(
  target: Pick<ReadySessionTarget, 'connection' | 'model'>,
): string[] {
  // The picker mirrors the desktop's curated visibility: only the connection's
  // enabled models are offered (legacy connections collapse to their default
  // model, never the full discovered catalog). The session's current model
  // stays selectable even when the user curated it out.
  const candidates = [target.model, ...connectionEnabledModelIds(target.connection)];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const id = candidate.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export interface ResolveDefaultSessionTargetInput {
  connectionStore: Pick<ConnectionStore, 'get' | 'getDefault'>;
  credentialStore: Pick<CredentialStore, 'getSecret'> & Partial<Pick<CredentialStore, 'setSecret'>>;
  requestedModel?: string;
  now?: () => number;
  fetchFn?: typeof fetch;
}

export async function resolveDefaultSessionTarget(
  input: ResolveDefaultSessionTargetInput,
): Promise<ReadySessionTarget> {
  return resolveSessionTargetForSlug(await input.connectionStore.getDefault(), input);
}

/**
 * Resolve a ready target for a specific connection slug — the per-session path
 * the backend uses so the active session's connection (not the global default)
 * decides which provider a turn runs on, mirroring the desktop app.
 */
export async function resolveSessionTargetForSlug(
  slug: string | null | undefined,
  input: ResolveDefaultSessionTargetInput,
): Promise<ReadySessionTarget> {
  if (!slug || slug === 'fake') throw noRealConnection('missing_default_connection');

  const connection = await input.connectionStore.get(slug);
  if (!connection) throw noRealConnection('connection_missing');

  return resolveReadyTargetForConnection(connection, input);
}

async function resolveReadyTargetForConnection(
  connection: LlmConnection,
  input: ResolveDefaultSessionTargetInput,
): Promise<ReadySessionTarget> {
  const oauthProviderType = isOAuthSubscriptionProvider(connection.providerType)
    ? connection.providerType
    : null;
  const oauthTokens = oauthProviderType
    ? await resolveOAuthSubscriptionTokens({
        providerType: oauthProviderType,
        slug: connection.slug,
        credentialStore: input.credentialStore,
        now: input.now,
        fetchFn: input.fetchFn,
      })
    : undefined;
  const credentialKind = credentialKindForConnection(connection);
  const secret =
    !oauthProviderType && credentialKind
      ? await input.credentialStore.getSecret(connection.slug, credentialKind)
      : '';
  const apiKey = oauthProviderType ? oauthTokens?.access_token : secret;
  const verdict = isConnectionReady({
    connection,
    hasSecret: typeof apiKey === 'string' && apiKey.length > 0,
    requestedModel: input.requestedModel,
  });
  if (!verdict.ready) throw noRealConnection(verdict.reason);
  return {
    connection: oauthTokens?.base_url
      ? { ...connection, baseUrl: oauthTokens.base_url }
      : connection,
    apiKey: apiKey ?? '',
    model: verdict.model,
    ...(oauthTokens ? { oauthTokens } : {}),
  };
}

/**
 * Every selectable model across all ready connections, for the `/model` picker.
 * Readiness here is cheap and side-effect free — a stored secret, no OAuth token
 * refresh or network — since the backend does the real resolution at turn time;
 * this only decides which connections' models are worth offering.
 */
export async function listReadyModelChoices(input: {
  connectionStore: Pick<ConnectionStore, 'list' | 'getDefault'>;
  credentialStore: Pick<CredentialStore, 'getSecret'>;
}): Promise<ModelChoice[]> {
  const [connections, defaultSlug] = await Promise.all([
    input.connectionStore.list(),
    input.connectionStore.getDefault(),
  ]);
  const choices: ModelChoice[] = [];
  for (const connection of connections) {
    if (connection.slug === 'fake') continue;
    // Isolate each connection: reading one connection's secret can throw (a
    // legacy or corrupt credentials.json), and this list is an optional
    // convenience for the /model picker — it must never take down startup. A
    // failing or not-ready connection is simply skipped, so a usable default
    // (e.g. a keyless local model) still launches.
    try {
      const credentialKind = credentialKindForConnection(connection);
      const secret = credentialKind
        ? await input.credentialStore.getSecret(connection.slug, credentialKind)
        : '';
      const hasSecret =
        credentialKind === null || (typeof secret === 'string' && secret.length > 0);
      const verdict = isConnectionReady({ connection, hasSecret });
      if (!verdict.ready) continue;
      for (const model of selectableModelIdsForTarget({ connection, model: verdict.model })) {
        choices.push({
          connectionSlug: connection.slug,
          connectionName: connection.name,
          providerType: connection.providerType,
          model,
          isDefaultConnection: connection.slug === defaultSlug,
          contextWindow: resolveSelectedModelContextWindow(connection, model),
          thinkingLevels: thinkingVariantsForConnection(connection, model),
        });
      }
    } catch {
      // Unreadable credentials for this connection: skip it, keep the rest.
    }
  }
  return choices;
}

function credentialKindForConnection(connection: LlmConnection): CredentialKind | null {
  const authKind = PROVIDER_DEFAULTS[connection.providerType]?.authKind;
  switch (authKind) {
    case 'api_key':
      return 'api_key';
    case 'oauth_token':
      return 'oauth_token';
    case 'none':
      return null;
    default:
      return 'api_key';
  }
}

function noRealConnection(reason: ChatConfigurationReason): Error {
  return new Error(`NO_REAL_CONNECTION:${reason}`);
}
