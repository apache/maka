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
  readonly requestBodyOverlayJson: string | null;
  readonly authKind: 'api_key' | 'oauth_token' | 'optional_api_key' | 'none';
  readonly routing: ConnectionCredentialRouting;
  readonly now?: () => number;
}

/**
 * Compose a `ProviderCredentialResolver` for one balanced Connection (RFC
 * sections 6 and 9). Wires the pure Router from PR 2 to the Host's Catalog
 * (profile metadata), Vault (per-profile secrets via `exportCredentialMaterial`)
 * and the routing Health/Verification store.
 *
 * The returned resolver owns a Router with process-local SWRR state and turn
 * bindings; the routing store is process-local too (same `runtime.sqlite`).
 */
export function createHostCredentialResolver(
  input: CreateHostCredentialResolverInput,
): ProviderCredentialResolver {
  const routingStore = createSqliteProviderCredentialRoutingStore(input.workspaceRoot);
  const digest = executionBasisDigest({
    providerType: input.providerType,
    endpoint: input.endpoint,
    apiProtocol: input.apiProtocol,
    requestHeadersCredentialId: null,
    requestHeadersCredentialRevision: null,
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
    },
    { now: input.now },
  );
  return router;
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
    const health = await input.routingStore.readHealth(
      input.connectionId,
      profileId,
      material.credentialId,
      material.revision,
      input.digest,
    );
    if (health.some((row) => row.circuitState === 'open' || row.circuitState === 'invalid')) {
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
  switch (input.outcome.kind) {
    case 'success':
      await input.routingStore.settleSuccess(
        input.connectionId,
        input.lease.profileId,
        input.lease.credentialId,
        input.lease.credentialRevision,
        input.digest,
        '',
        now,
      );
      return;
    case 'aborted':
      // An abort does not change Profile health.
      return;
    case 'failure':
      await input.routingStore.settleFailure(
        input.connectionId,
        input.lease.profileId,
        input.lease.credentialId,
        input.lease.credentialRevision,
        input.digest,
        '',
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
