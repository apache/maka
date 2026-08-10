import type { ConnectionCredentialRouting, CredentialLocator } from '@maka/core/runtime-policy';
import type { ProviderType } from '@maka/core/llm-connections';
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
import {
  ProviderCredentialRouter,
  type RouterCredentialMaterial,
} from './provider-credential-router.js';

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
      getRouting: async () => input.routing,
      getEligibleProfileIds: (connectionId, profileIds, modelId) =>
        filterEligibleProfiles({
          connectionId,
          profileIds,
          modelId,
          routing: input.routing,
          runtimePolicy: input.runtimePolicy,
          routingStore,
          digest,
          authKind: input.authKind,
        }),
      resolveCredential: (connectionId, profileId) =>
        resolveProfileCredential({
          runtimePolicy: input.runtimePolicy,
          connectionId,
          profileId,
          authKind: input.authKind,
        }),
      settleHealth: (lease, outcome) =>
        settleRoutingOutcome({
          connectionId: input.connectionId,
          routingStore,
          digest,
          lease,
          outcome,
          now: input.now ?? Date.now,
        }),
      probeEligibleProfiles: (connectionId, profileIds, modelId) =>
        probeEligibleProfiles({
          connectionId,
          profileIds,
          modelId,
          routing: input.routing,
          runtimePolicy: input.runtimePolicy,
          routingStore,
          digest,
          authKind: input.authKind,
          now: input.now ?? Date.now,
        }),
      claimHalfOpenProbe: (connectionId, profileId, circuitModelId) =>
        claimHalfOpenProbe({
          connectionId,
          profileId,
          circuitModelId,
          runtimePolicy: input.runtimePolicy,
          routingStore,
          digest,
          authKind: input.authKind,
          now: input.now ?? Date.now,
        }),
    },
    { now: input.now },
  );
  return {
    acquireAttempt: (context) => router.acquireAttempt(context),
    settle: (lease, outcome) => router.settle(lease, outcome),
    releaseTurn: (sessionId, turnId) => router.releaseTurn(sessionId, turnId),
    dispose: () => routingStore.dispose(),
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
    // Explicit Profile routing requires model-support evidence; unknown is
    // never optimistically scheduled (RFC 11.1).
    const verification = await input.routingStore.readProfileVerification(
      input.connectionId,
      profileId,
    );
    const current = verification.filter(
      (record) =>
        record.credentialId === material.credentialId &&
        record.credentialRevision === material.revision &&
        record.executionBasisDigest === input.digest,
    );
    if (
      !current.some((record) => record.modelId === input.modelId && record.status === 'supported')
    ) {
      continue;
    }
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
    if (row.circuitState === 'open' || row.circuitState === 'invalid') return true;
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
}): Promise<RouterCredentialMaterial | null> {
  const locator = profileLocator(input.connectionId, input.profileId, input.authKind);
  if (!locator) return null;
  const material = await input.runtimePolicy.operations.exportCredentialMaterial(locator);
  if (!material) return null;
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
