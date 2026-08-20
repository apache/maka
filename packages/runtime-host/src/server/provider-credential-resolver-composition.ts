import type {
  ConnectionCatalogEntry,
  ConnectionCredentialRouting,
  CredentialLocator,
} from '@maka/core/runtime-policy';
import {
  effectiveBaseUrl,
  type ProviderType,
  type RuntimeExecutionConnection,
} from '@maka/core/llm-connections';
import type {
  ProviderCredentialLease,
  ProviderCredentialOutcome,
  ProviderCredentialResolver,
} from '@maka/core/provider-credential-routing';
import {
  executionBasisDigest,
  createSqliteProviderCredentialRoutingStore,
  type ProviderCredentialRoutingStore,
} from '@maka/storage/provider-credential-routing-store';
import type { RuntimePolicyStoresWriter } from '@maka/storage/runtime-policy-stores';
import type {
  ProxiedFetchProxy,
  ProxiedFetchTransport,
} from '@maka/runtime/network/scoped-fetch-transport';
import {
  ProviderCredentialRouter,
  RouterCredentialResolutionError,
  type RouterCredentialMaterial,
} from './provider-credential-router.js';
import {
  createHostOAuthModelFetch,
  type HostOAuthExecutionAuthority,
  OAuthExecutionCredentialError,
} from './oauth-execution-authority.js';

export interface CreateHostCredentialResolverInput {
  readonly runtimePolicy: RuntimePolicyStoresWriter;
  readonly workspaceRoot: string;
  readonly connectionId: string;
  readonly connectionSlug: string;
  readonly providerType: ProviderType;
  /** Non-secret execution basis inputs shared with verification writes. */
  readonly endpoint: string;
  readonly apiProtocol: string | undefined;
  /** Connection-level request-headers credential identity (digest basis). */
  readonly requestHeadersCredentialId: string | null;
  readonly requestHeadersCredentialRevision: number | null;
  readonly requestBodyOverlayJson: string | null;
  readonly authKind: 'api_key' | 'oauth_token' | 'optional_api_key' | 'none';
  readonly routing: ConnectionCredentialRouting;
  readonly oauthCredentials?: HostOAuthExecutionAuthority;
  readonly connection?: RuntimeExecutionConnection;
  readonly sessionId?: string;
  readonly modelId?: string;
  readonly createFetchTransport?: (proxy: ProxiedFetchProxy | null) => ProxiedFetchTransport;
  readonly proxy?: ProxiedFetchProxy | null;
  readonly now?: () => number;
}

/**
 * A composed resolver plus its owned routing-store lease. The caller must call
 * `dispose()` exactly once when the backend is torn down (RFC P2-8), otherwise
 * the operational database connection is never released.
 */
export interface HostCredentialResolver extends ProviderCredentialResolver {
  dispose(): void;
}

/**
 * Compose a `ProviderCredentialResolver` for one balanced Connection (RFC
 * sections 6 and 9). Wires the pure Router from PR 2 to the Host's Catalog
 * (profile metadata), Vault (per-profile secrets via `exportCredentialMaterial`)
 * and the routing Health/Verification store.
 *
 * The returned resolver owns a Router with process-local SWRR state and turn
 * bindings; the routing store is process-local too (same `runtime.sqlite`) and
 * must be disposed with the resolver.
 */
export function createHostCredentialResolver(
  input: CreateHostCredentialResolverInput,
): HostCredentialResolver {
  const routingStore = createSqliteProviderCredentialRoutingStore(input.workspaceRoot);
  let modelFetchTransport: ProxiedFetchTransport | undefined;
  const getModelFetchTransport = (): ProxiedFetchTransport => {
    if (!input.createFetchTransport) {
      throw new Error('OAuth model fetch transport is unavailable');
    }
    modelFetchTransport ??= input.createFetchTransport(input.proxy ?? null);
    return modelFetchTransport;
  };
  const digest = executionBasisDigest({
    providerType: input.providerType,
    endpoint: input.endpoint,
    apiProtocol: input.apiProtocol,
    requestHeadersCredentialId: input.requestHeadersCredentialId,
    requestHeadersCredentialRevision: input.requestHeadersCredentialRevision,
    requestBodyOverlayJson: input.requestBodyOverlayJson,
  });
  const router = new ProviderCredentialRouter(
    {
      acquireExecutionBasis: async (connectionId, modelId) => {
        const current = await readCurrentExecutionBasis(input, connectionId, modelId);
        return current ?? { routing: disabledRouting(connectionId), digest: '' };
      },
      getEligibleProfileIds: async (connectionId, profileIds, modelId, digest) => {
        const current = await matchingExecutionBasis(input, connectionId, modelId, digest);
        if (!current || current.routing?.mode !== 'balanced') return new Set<string>();
        return filterEligibleProfiles({
          connectionId,
          profileIds,
          modelId,
          routing: current.routing,
          runtimePolicy: input.runtimePolicy,
          routingStore,
          digest,
          authKind: input.authKind,
        });
      },
      resolveCredential: async (connectionId, profileId, digest, modelId) => {
        const current = await matchingExecutionBasis(input, connectionId, modelId, digest);
        if (!current) return null;
        if (
          current.routing &&
          !current.routing.profiles.some(
            (profile) => profile.profileId === profileId && profile.enabled,
          )
        ) {
          return null;
        }
        return resolveProfileCredential({
          runtimePolicy: input.runtimePolicy,
          connectionId,
          profileId,
          authKind: input.authKind,
          providerType: input.providerType,
          connectionSlug: input.connectionSlug,
          oauthCredentials: input.oauthCredentials,
          connection: current.connection,
          sessionId: input.sessionId,
          modelId,
          createFetchTransport: input.createFetchTransport,
          getModelFetchTransport,
          proxy: input.proxy,
        });
      },
      settleHealth: (lease, outcome) =>
        settleRoutingOutcome({
          connectionId: input.connectionId,
          routingStore,
          digest: lease.executionBasisDigest ?? digest,
          lease,
          outcome,
          now: input.now ?? Date.now,
        }),
      probeEligibleProfiles: async (connectionId, profileIds, modelId, digest) => {
        const current = await matchingExecutionBasis(input, connectionId, modelId, digest);
        if (!current || current.routing?.mode !== 'balanced') return new Map<string, string>();
        return probeEligibleProfiles({
          connectionId,
          profileIds,
          modelId,
          routing: current.routing,
          runtimePolicy: input.runtimePolicy,
          routingStore,
          digest,
          authKind: input.authKind,
          now: input.now ?? Date.now,
        });
      },
      claimHalfOpenProbe: async (
        connectionId,
        profileId,
        circuitModelId,
        modelId,
        digest,
      ) => {
        const current = await matchingExecutionBasis(input, connectionId, modelId, digest);
        if (
          !current ||
          current.routing?.mode !== 'balanced' ||
          !current.routing.profiles.some(
            (profile) => profile.profileId === profileId && profile.enabled,
          )
        ) {
          return false;
        }
        return claimHalfOpenProbe({
          connectionId,
          profileId,
          circuitModelId,
          runtimePolicy: input.runtimePolicy,
          routingStore,
          digest,
          authKind: input.authKind,
          now: input.now ?? Date.now,
        });
      },
    },
    { now: input.now },
  );
  return {
    acquireAttempt: (context) => router.acquireAttempt(context),
    settle: (lease, outcome) => router.settle(lease, outcome),
    releaseTurn: (sessionId, turnId) => router.releaseTurn(sessionId, turnId),
    dispose: () => {
      void modelFetchTransport?.close();
      routingStore.dispose();
    },
  };
}

/**
 * Re-read immediately before an eligibility/materialization step, and accept
 * it only when the live execution basis still matches the one the Router
 * captured for this physical attempt. A newer basis makes the old step fail
 * closed rather than dispatch material authorized under different metadata.
 */
async function matchingExecutionBasis(
  input: CreateHostCredentialResolverInput,
  connectionId: string,
  modelId: string,
  digest: string,
): Promise<{
  readonly routing: ConnectionCredentialRouting | null;
  readonly digest: string;
  readonly connection: RuntimeExecutionConnection;
} | null> {
  const current = await readCurrentExecutionBasis(input, connectionId, modelId);
  return current?.digest === digest ? current : null;
}

/**
 * Verification is valid only for the live Catalog/Vault execution basis. This
 * prevents a configured-but-never-verified account (or an account verified on
 * an old endpoint/header/model basis) from entering a balanced attempt.
 */
async function readCurrentExecutionBasis(
  input: CreateHostCredentialResolverInput,
  connectionId: string,
  modelId: string,
): Promise<{
  readonly routing: ConnectionCredentialRouting | null;
  readonly digest: string;
  readonly connection: RuntimeExecutionConnection;
} | null> {
  const snapshot = await input.runtimePolicy.connectionCatalog.getSnapshot();
  const connection = snapshot.connections.find(
    (candidate) => candidate.connectionId === connectionId,
  );
  if (
    !connection ||
    !connection.enabled ||
    connection.providerType !== input.providerType ||
    !connection.enabledModelIds.includes(modelId)
  ) {
    return null;
  }
  const requestHeaders = await input.runtimePolicy.operations.exportCredentialMaterial({
    scope: 'connection',
    connectionId,
    kind: 'request_headers',
  });
  const model = connection.models.find((candidate) => candidate.id === modelId);
  return {
    routing: connection.credentialRouting ?? null,
    connection: runtimeExecutionConnection(input, connection),
    digest: executionBasisDigest({
      providerType: connection.providerType,
      endpoint: effectiveBaseUrl(connection),
      apiProtocol: model?.apiProtocol,
      requestHeadersCredentialId: requestHeaders?.credentialId ?? null,
      requestHeadersCredentialRevision: requestHeaders?.revision ?? null,
      requestBodyOverlayJson: connection.requestBodyOverlay
        ? JSON.stringify(connection.requestBodyOverlay)
        : null,
    }),
  };
}

function runtimeExecutionConnection(
  input: CreateHostCredentialResolverInput,
  connection: ConnectionCatalogEntry,
): RuntimeExecutionConnection {
  return {
    slug: connection.slug,
    providerType: connection.providerType,
    ...(connection.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }),
    defaultModel: input.connection?.defaultModel ?? connection.models[0]?.id ?? '',
    ...(connection.models.length > 0 ? { models: [...connection.models] } : {}),
    ...(connection.relayModelProfiles === undefined
      ? {}
      : { relayModelProfiles: connection.relayModelProfiles }),
    ...(connection.requestBodyOverlay === undefined
      ? {}
      : { requestBodyOverlay: connection.requestBodyOverlay }),
  };
}

function disabledRouting(connectionId: string): ConnectionCredentialRouting {
  return {
    mode: 'legacy_primary',
    strategy: 'smooth_weighted_round_robin',
    profiles: [
      {
        profileId: connectionId,
        revision: 0,
        label: 'disabled',
        enabled: false,
        weight: 1,
      },
    ],
  };
}

async function filterEligibleProfiles(input: {
  connectionId: string;
  profileIds: readonly string[];
  modelId: string;
  routing: ConnectionCredentialRouting;
  runtimePolicy: RuntimePolicyStoresWriter;
  routingStore: ProviderCredentialRoutingStore;
  digest: string;
  authKind: CreateHostCredentialResolverInput['authKind'];
}): Promise<ReadonlySet<string>> {
  const eligible = new Set<string>();
  for (const profileId of input.profileIds) {
    const profile = input.routing.profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile?.enabled) continue;
    const locator = profileLocator(input.connectionId, profileId, input.authKind);
    if (!locator) continue;
    const material = await input.runtimePolicy.operations.exportCredentialMaterial(locator);
    if (!material) continue;
    if (
      await blockedForModel(
        input,
        profileId,
        material.credentialId,
        material.revision,
        input.modelId,
      )
    ) {
      continue;
    }
    const verified = (
      await input.routingStore.readProfileVerification(input.connectionId, profileId)
    ).some(
      (record) =>
        record.credentialId === material.credentialId &&
        record.credentialRevision === material.revision &&
        record.executionBasisDigest === input.digest &&
        record.modelId === input.modelId &&
        record.status === 'supported',
    );
    if (!verified) continue;
    eligible.add(profileId);
  }
  return eligible;
}

/**
 * P1-5: model-scoped health isolation. A credential is blocked for `modelId`
 * only when the credential-global row (`model_id=''`) or the current model's
 * row is open/invalid — a `provider_permission` deny on one model must not
 * take the whole Profile out of rotation for every model.
 */
async function blockedForModel(
  input: {
    routingStore: ProviderCredentialRoutingStore;
    connectionId: string;
    digest: string;
  },
  profileId: string,
  credentialId: string,
  credentialRevision: number,
  modelId: string,
): Promise<boolean> {
  const rows = await input.routingStore.readHealth(
    input.connectionId,
    profileId,
    credentialId,
    credentialRevision,
    input.digest,
  );
  for (const row of rows) {
    if (row.modelId !== '' && row.modelId !== modelId) continue;
    // half_open is a claimed probe in flight: dispatching this Profile as an
    // ordinary candidate would bypass the Router's single-flight probe lease.
    if (
      row.circuitState === 'open' ||
      row.circuitState === 'half_open' ||
      row.circuitState === 'invalid'
    ) {
      return true;
    }
  }
  return false;
}

async function probeEligibleProfiles(input: {
  connectionId: string;
  profileIds: readonly string[];
  modelId: string;
  routing: ConnectionCredentialRouting;
  runtimePolicy: RuntimePolicyStoresWriter;
  routingStore: ProviderCredentialRoutingStore;
  digest: string;
  authKind: CreateHostCredentialResolverInput['authKind'];
  now: () => number;
}): Promise<ReadonlyMap<string, string>> {
  const eligible = new Map<string, string>();
  const now = input.now();
  for (const profileId of input.profileIds) {
    const profile = input.routing.profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile?.enabled) continue;
    const locator = profileLocator(input.connectionId, profileId, input.authKind);
    if (!locator) continue;
    const material = await input.runtimePolicy.operations.exportCredentialMaterial(locator);
    if (!material) continue;
    const verified = (
      await input.routingStore.readProfileVerification(input.connectionId, profileId)
    ).some(
      (record) =>
        record.credentialId === material.credentialId &&
        record.credentialRevision === material.revision &&
        record.executionBasisDigest === input.digest &&
        record.modelId === input.modelId &&
        record.status === 'supported',
    );
    if (!verified) continue;
    const rows = await input.routingStore.readHealth(
      input.connectionId,
      profileId,
      material.credentialId,
      material.revision,
      input.digest,
    );
    for (const row of rows) {
      if (row.modelId !== '' && row.modelId !== input.modelId) continue;
      if (row.circuitState === 'open') {
        const probeAt = Math.max(row.blockedUntil ?? 0, row.nextProbeAt ?? 0);
        // The map value is the exact circuit row key (`''` for the global
        // row, otherwise the model id) so the claim and the probe's settle
        // land on the same row (RFC 8.4).
        if (probeAt <= now) eligible.set(profileId, row.modelId);
      }
    }
  }
  return eligible;
}

async function claimHalfOpenProbe(input: {
  connectionId: string;
  profileId: string;
  circuitModelId: string;
  runtimePolicy: RuntimePolicyStoresWriter;
  routingStore: ProviderCredentialRoutingStore;
  digest: string;
  authKind: CreateHostCredentialResolverInput['authKind'];
  now: () => number;
}): Promise<boolean> {
  const locator = profileLocator(input.connectionId, input.profileId, input.authKind);
  if (!locator) return false;
  const material = await input.runtimePolicy.operations.exportCredentialMaterial(locator);
  if (!material) return false;
  return input.routingStore.claimHalfOpenProbe(
    input.connectionId,
    input.profileId,
    material.credentialId,
    material.revision,
    input.digest,
    input.circuitModelId,
    input.now(),
  );
}

async function resolveProfileCredential(input: {
  runtimePolicy: RuntimePolicyStoresWriter;
  connectionId: string;
  profileId: string;
  authKind: CreateHostCredentialResolverInput['authKind'];
  providerType: ProviderType;
  connectionSlug: string;
  oauthCredentials?: HostOAuthExecutionAuthority;
  connection?: RuntimeExecutionConnection;
  sessionId?: string;
  modelId?: string;
  createFetchTransport?: (proxy: ProxiedFetchProxy | null) => ProxiedFetchTransport;
  getModelFetchTransport?: () => ProxiedFetchTransport;
  proxy?: ProxiedFetchProxy | null;
}): Promise<RouterCredentialMaterial | null> {
  const locator = profileLocator(input.connectionId, input.profileId, input.authKind);
  if (!locator) return null;
  const material = await input.runtimePolicy.operations.exportCredentialMaterial(locator);
  if (!material) return null;
  if (input.authKind === 'oauth_token') {
    if (
      input.providerType !== 'openai-codex' ||
      !input.oauthCredentials ||
      !input.connection ||
      !input.sessionId ||
      !input.modelId ||
      !input.createFetchTransport ||
      !input.getModelFetchTransport
    ) {
      return null;
    }
    const binding = input.oauthCredentials.bind({
      providerType: input.providerType,
      connectionSlug: input.connectionSlug,
      material,
      createRefreshTransport: () => input.createFetchTransport!(input.proxy ?? null),
    });
    let tokens;
    try {
      tokens = await binding.resolve();
    } catch (error) {
      if (error instanceof OAuthExecutionCredentialError) {
        throw new RouterCredentialResolutionError(
          material.credentialId,
          material.revision,
          { kind: 'auth', scope: 'credential', evidence: 'provider_adapter' },
          `OAuth credential resolution failed: ${error.code}`,
        );
      }
      throw error;
    }
    const baseFetch: typeof globalThis.fetch = async (url, init) => {
      return input.getModelFetchTransport!().fetch(url, init);
    };
    return {
      credentialId: material.credentialId,
      credentialRevision: material.revision,
      apiKey: tokens.access_token,
      fetch: createHostOAuthModelFetch({
        binding,
        initialTokens: tokens,
        connection: input.connection,
        sessionId: input.sessionId,
        modelId: input.modelId,
        claudeDeviceId: '',
        fetchFn: baseFetch,
      }),
    };
  }
  return {
    credentialId: material.credentialId,
    credentialRevision: material.revision,
    apiKey: material.secret,
  };
}

async function settleRoutingOutcome(input: {
  connectionId: string;
  routingStore: ProviderCredentialRoutingStore;
  digest: string;
  lease: ProviderCredentialLease;
  outcome: ProviderCredentialOutcome;
  now: () => number;
}): Promise<void> {
  const now = input.now();
  // The health row to settle. A probe lease pins the exact circuit row it
  // claimed (`healthCircuitModelId`); otherwise the row follows the failure
  // scope (RFC 8.4): `credential` failures belong to the credential-global
  // row (`model_id=''`) so the whole Profile is blocked, while
  // `credential_model` failures belong to the current model row only.
  const healthModelId =
    input.lease.healthCircuitModelId ??
    (input.outcome.kind === 'failure' && input.outcome.routingHint.scope === 'credential'
      ? ''
      : (input.lease.modelId ?? ''));
  switch (input.outcome.kind) {
    case 'success':
      // A probe success closes the claimed circuit row; a normal success
      // closes the current model row. A normal model success never closes a
      // credential-global billing/usage circuit (RFC 8.4).
      await input.routingStore.settleSuccess(
        input.connectionId,
        input.lease.profileId,
        input.lease.credentialId,
        input.lease.credentialRevision,
        input.digest,
        healthModelId,
        now,
      );
      return;
    case 'aborted':
      // A normal abort does not change Profile health. A claimed half-open
      // probe that was cancelled must NOT stay half_open (that would block
      // every future probe): it is re-opened with a conservative cadence.
      if (input.lease.healthCircuitModelId !== undefined) {
        await input.routingStore.settleProbeAborted(
          input.connectionId,
          input.lease.profileId,
          input.lease.credentialId,
          input.lease.credentialRevision,
          input.digest,
          input.lease.healthCircuitModelId,
          now,
        );
      }
      return;
    case 'failure':
      await input.routingStore.settleFailure(
        input.connectionId,
        input.lease.profileId,
        input.lease.credentialId,
        input.lease.credentialRevision,
        input.digest,
        healthModelId,
        input.outcome.routingHint,
        now,
      );
      return;
  }
}

/**
 * The primary Profile uses the legacy `connection` locator; secondary
 * Profiles use the `connection_profile` locator (RFC 4.2/4.3).
 */
function profileLocator(
  connectionId: string,
  profileId: string,
  authKind: CreateHostCredentialResolverInput['authKind'],
): CredentialLocator | null {
  if (authKind === 'none') return null;
  const kind = authKind === 'oauth_token' ? ('oauth_token' as const) : ('api_key' as const);
  return profileId === connectionId
    ? { scope: 'connection', connectionId, kind }
    : { scope: 'connection_profile', connectionId, profileId, kind };
}
