import { randomUUID } from 'node:crypto';
import {
  decodeConnectionModelId,
  decodeConnectionSlug,
  decodeConnectionTestSummary,
  decodeRuntimePolicyEntityId,
  decodeCredentialLocator,
  normalizeConnectionModelDiscoveryResult,
  normalizeDeleteCredentialInput,
  normalizeRemoveCatalogConnectionInput,
  normalizeRemoveCredentialProfileInput,
  normalizeRequestHeaderUpdates,
  normalizeRequestHeaders,
  normalizeSetCredentialInput,
  normalizeSetCredentialProfileEnabledInput,
  normalizeSetCredentialRoutingModeInput,
  normalizeCreateCredentialProfileInput,
  normalizeUpdateCredentialProfileInput,
  parseRequestHeaders,
  serializeRequestHeaders,
  RequestCustomizationValidationError,
  normalizeCredentialSecret,
  type ConnectionCatalogEntry,
  type ConnectionCatalogSnapshot,
  type ConnectionCredentialProfileEntry,
  type ConnectionVersionBasis,
  type ConnectionModelDiscoveryResult,
  type ConnectionTestSummary,
  type CreateCatalogConnectionInput,
  type CreateCredentialProfileInput,
  type CredentialLocator,
  type CredentialProfileMutationResult,
  type CredentialProfileVersionBasis,
  type CredentialStatus,
  type CredentialVersionBasis,
  type DeleteCredentialInput,
  type MutateRuntimePolicyInput,
  type RemoveCatalogConnectionInput,
  type RemoveCredentialProfileInput,
  type RuntimePolicy,
  type RequestHeaderUpdate,
  type SavedRequestHeaders,
  type SetCredentialInput,
  type SetCredentialProfileEnabledInput,
  type SetCredentialRoutingModeInput,
  type SetDefaultConnectionTargetInput,
  type UpdateCatalogConnectionInput,
  type UpdateCredentialProfileInput,
} from '@maka/core/runtime-policy';
import type { CredentialProfileVerificationRecord } from '@maka/core/provider-credential-routing';
import { deriveProviderAuthContract, type ProviderAuthAction } from '@maka/core/provider-auth';
import {
  deriveConnectionSlug,
  effectiveBaseUrl,
  PROVIDER_DEFAULTS,
  type ProviderType,
} from '@maka/core/llm-connections';
import {
  createSqliteProviderCredentialRoutingStore,
  executionBasisDigest,
  type ProviderCredentialRoutingStore,
} from '../provider-credential-routing-store.js';
import { deepFreeze } from './codec.js';
import {
  catalogSnapshot,
  connectionBasis,
  ConnectionCatalogDocumentOwner,
  connectionTestModelBasis,
  findConnection,
  sameConnectionTestModelBasis,
  type ConnectionCatalogDocument,
  type ConnectionTestModelBasis,
} from './connection-catalog-document.js';
import {
  credentialMaterial,
  credentialBasis,
  credentialStatus,
  CredentialVaultDocumentOwner,
  findCredential,
  type CredentialVaultDocument,
  sameCredentialBasis,
  vaultSnapshot,
} from './credential-vault-document.js';
import { cleanupRuntimePolicyDocumentTemps } from './document-io.js';
import {
  codecError,
  commitOutcomeUnknown,
  decodeConnectionInput,
  decodeCredentialInput,
  RuntimePolicyStoreError,
} from './errors.js';
import {
  connectionCredentialLocator,
  connectionProfileCredentialLocator,
  connectionRequestHeadersLocator,
  type CredentialStatusQueryResult,
  type RecordCredentialProfileVerificationInput,
  type RecordCredentialProfileVerificationResult,
  type BeginConnectionTestResult,
  type BeginModelFetchResult,
  type BeginConnectionProfileTestResult,
  type BeginConnectionProfileModelFetchResult,
  type BeginInteractiveOAuthLoginResult,
  type CompareAndSetOAuthCredentialInput,
  type ConnectionEffectChangedDomain,
  type ConnectionEffectCompletionResult,
  type ConnectionProfileModelFetchCompletionResult,
  type ConnectionProfileTestCompletionInput,
  type ConnectionProfileTestCompletionResult,
  type CommitConnectionOnboardingInput,
  type CommitConnectionOnboardingResult,
  type ConnectionTestTicket,
  type CredentialProfileReadinessEntry,
  type CredentialProfileReadinessResult,
  type InteractiveOAuthLoginCompletionResult,
  type InteractiveOAuthLoginProvider,
  type InteractiveOAuthLoginTicket,
  type ModelFetchTicket,
  type ProfileModelFetchTicket,
  type ProfileTestTicket,
  type ProviderAuthKind,
  type RuntimePolicyCredentialMaterial,
  type RuntimePolicyOperationSecretMaterial,
  type ResolveExecutionConnectionResult,
  type ResolveNetworkProxyExecutionInput,
  type ResolveNetworkProxyExecutionResult,
  type ResolveWebFetchExecutionResult,
  type ResolveWebSearchExecutionInput,
  type ResolveWebSearchExecutionResult,
  type ReplaceConnectionRequestHeadersResult,
} from './operations.js';
import {
  clearConnectionOnboardingIntent,
  prepareConnectionOnboardingIntent,
  readConnectionOnboardingIntent,
  writeConnectionOnboardingIntent,
  type ConnectionOnboardingIntent,
} from './onboarding-transaction.js';
import { policySnapshot, RuntimePolicyDocumentOwner } from './policy-document.js';
import { SerializedOperationLane } from '../serialized-operation-lane.js';

type RootExecutor = <T>(operation: (root: string) => Promise<T>) => Promise<T>;

interface PreparedConnectionMaterial {
  readonly kind: 'ready';
  readonly connection: ConnectionCatalogEntry;
  readonly connectionCredentialStatus: CredentialStatus | null;
  readonly requestHeadersCredentialStatus: CredentialStatus;
  readonly proxyCredentialStatus: CredentialStatus | null;
  readonly secretMaterial: RuntimePolicyOperationSecretMaterial;
  readonly networkProxy: RuntimePolicy['networkProxy'];
  /** Present only for Profile-scoped operations. */
  readonly profile?: ConnectionCredentialProfileEntry;
}

type ConnectionTicketKind =
  | 'model_fetch'
  | 'connection_test'
  | 'profile_test'
  | 'profile_model_fetch';
type TicketState = 'available' | 'in_flight' | 'consumed';

type EffectiveProxyConfigurationBasis =
  | { readonly kind: 'direct' }
  | {
      readonly kind: 'proxy';
      readonly protocol: RuntimePolicy['networkProxy']['protocol'];
      readonly host: string;
      readonly port: number;
      readonly authentication:
        | { readonly kind: 'none' }
        | { readonly kind: 'credentials'; readonly username: string };
      readonly bypassPatterns: readonly string[];
    };

interface CommonSemanticConnectionBasis {
  readonly connectionId: string;
  readonly providerType: ProviderType;
  readonly enabled: true;
  readonly effectiveEndpoint: string;
  readonly credential: CredentialStatus | null;
  readonly requestHeadersCredential: CredentialStatus;
  readonly effectiveProxy: EffectiveProxyConfigurationBasis;
  readonly proxyCredential: CredentialStatus | null;
}

type SemanticConnectionBasis =
  | (CommonSemanticConnectionBasis & {
      readonly kind: 'model_fetch';
      readonly enabledModelIds: readonly string[];
    })
  | (CommonSemanticConnectionBasis & {
      readonly kind: 'connection_test';
      readonly requestBodyOverlayJson: string;
      readonly model: ConnectionTestModelBasis;
    })
  | (CommonSemanticConnectionBasis &
      ProfileSemanticConnectionBasisFields & {
        readonly kind: 'profile_model_fetch';
        readonly enabledModelIds: readonly string[];
      })
  | (CommonSemanticConnectionBasis &
      ProfileSemanticConnectionBasisFields & {
        readonly kind: 'profile_test';
        readonly modelId: string | null;
        readonly requestBodyOverlayJson: string;
        readonly model: ConnectionTestModelBasis;
      });

interface ProfileSemanticConnectionBasisFields {
  readonly profileId: string;
  readonly profileEnabled: true;
  readonly profileRevision: number;
}

type ConnectionTicketRecord<K extends ConnectionTicketKind = ConnectionTicketKind> = {
  readonly kind: K;
  readonly basis: Extract<SemanticConnectionBasis, { readonly kind: K }>;
  state: TicketState;
};

interface InteractiveOAuthLoginTicketRecord {
  readonly kind: 'interactive_oauth_login';
  readonly connectionBasis: ConnectionVersionBasis;
  readonly providerType: InteractiveOAuthLoginProvider;
  readonly credentialBasis: CredentialVersionBasis | null;
  state: TicketState;
}

type OperationTicketRecord = ConnectionTicketRecord | InteractiveOAuthLoginTicketRecord;

export class RuntimePolicyCoordinator {
  private readonly lane: SerializedOperationLane<string>;
  private readonly policy = new RuntimePolicyDocumentOwner();
  private readonly catalog = new ConnectionCatalogDocumentOwner();
  private readonly vault = new CredentialVaultDocumentOwner();
  private readonly tickets = new WeakMap<object, OperationTicketRecord>();
  private onboardingRecoveryRequired = false;
  /**
   * Lazily-created routing Health/Verification authority (RFC 8.4). The
   * interactive policy root is the same directory that hosts runtime.sqlite,
   * so `root` from the write lane addresses it. One instance per coordinator
   * (per lease) keeps the operational database lease count bounded.
   */
  private routingStore: ProviderCredentialRoutingStore | null = null;
  private routingStoreRoot: string | null = null;

  private routingStoreFor(root: string): ProviderCredentialRoutingStore {
    if (this.routingStore && this.routingStoreRoot === root) return this.routingStore;
    if (this.routingStore && this.routingStoreRoot !== null) {
      // A different root cannot appear under one lease; fail closed rather
      // than writing to the wrong authority.
      throw codecError('invalid_document', 'Routing authority root changed under one coordinator');
    }
    this.routingStore = createSqliteProviderCredentialRoutingStore(root);
    this.routingStoreRoot = root;
    return this.routingStore;
  }

  constructor(private readonly execute: RootExecutor) {
    this.lane = new SerializedOperationLane(execute);
  }

  recoverForWrite(): Promise<void> {
    return this.lane.run(async (root) => {
      await cleanupRuntimePolicyDocumentTemps(root);
      await this.recoverConnectionOnboarding(root);
      const catalog = await this.catalog.read(root);
      const vault = await this.vault.read(root);
      await this.vault.deleteOrphanedConnectionCredentials(
        root,
        vault,
        new Set(catalog.connections.map((connection) => connection.connectionId)),
      );
    });
  }

  /**
   * Release the lazily-created routing authority lease (RFC P2-8). Called by
   * the writer facade on host shutdown so the operational database connection
   * is not leaked by Profile management operations.
   */
  dispose(): void {
    if (this.routingStore) {
      this.routingStore.dispose();
      this.routingStore = null;
      this.routingStoreRoot = null;
    }
  }

  getPolicySnapshot() {
    return this.inLane(async (root) => policySnapshot(await this.policy.read(root)));
  }

  getCatalogSnapshot() {
    return this.inLane(async (root) => catalogSnapshot(await this.catalog.read(root)));
  }

  getVaultSnapshot() {
    return this.inLane(async (root) => vaultSnapshot(await this.vault.read(root)));
  }

  getCredentialStatus(rawLocator: CredentialLocator): Promise<CredentialStatusQueryResult> {
    return this.inLane(async (root) => {
      const locator = decodeCredentialInput(() => decodeCredentialLocator(rawLocator));
      if (locator.scope === 'connection' || locator.scope === 'connection_profile') {
        const catalog = await this.catalog.read(root);
        if (!this.validateConnectionCredentialLocator(catalog, locator)) {
          return deepFreeze({ kind: 'connection_not_found' as const });
        }
      }
      const status = credentialStatus(await this.vault.read(root), locator);
      return deepFreeze({ kind: 'status' as const, status });
    });
  }

  mutatePolicy(input: MutateRuntimePolicyInput) {
    return this.inLane(async (root) => {
      const current = await this.policy.read(root);
      const prepared = this.policy.prepareMutation(current, input);
      if (prepared.kind !== 'ready') return prepared;
      const proxyChanged = !sameEffectiveProxyConfiguration(
        effectiveProxyConfigurationBasis(prepared.current.policy.networkProxy),
        effectiveProxyConfigurationBasis(prepared.next.policy.networkProxy),
      );
      const cleared = proxyChanged
        ? await this.catalog.clearAllConnectionLastTests(root, await this.catalog.read(root))
        : false;
      try {
        return await this.policy.commitMutation(root, prepared);
      } catch (error) {
        if (cleared) {
          throw commitOutcomeUnknown(
            'Connection verification was cleared before network proxy update completed',
            error,
          );
        }
        throw error;
      }
    });
  }

  createConnection(input: CreateCatalogConnectionInput) {
    return this.inLane((root) => this.catalog.create(root, input));
  }

  updateConnection(input: UpdateCatalogConnectionInput) {
    return this.inLane((root) => this.catalog.update(root, input));
  }

  removeConnection(rawInput: RemoveCatalogConnectionInput) {
    return this.inLane(async (root) => {
      const { expected } = decodeConnectionInput(() =>
        normalizeRemoveCatalogConnectionInput(rawInput),
      );
      const catalog = await this.catalog.read(root);
      const connection = findConnection(catalog, expected);
      if (connection && connection.revision !== expected.revision) {
        return deepFreeze({
          kind: 'connection_stale' as const,
          expected,
          actual: connectionBasis(connection),
        });
      }

      const vault = await this.vault.read(root);
      if (!connection) {
        await this.vault.deleteConnectionCredentials(root, vault, expected.connectionId);
        return deepFreeze({ kind: 'committed' as const, snapshot: catalogSnapshot(catalog) });
      }
      const result = await this.catalog.remove(root, { expected });
      if (result.kind === 'committed') {
        try {
          await this.vault.deleteConnectionCredentials(root, vault, expected.connectionId);
        } catch (error) {
          throw commitOutcomeUnknown(
            'Connection removal committed before credential cleanup completed',
            error,
          );
        }
      }
      return result;
    });
  }

  setDefaultTarget(input: SetDefaultConnectionTargetInput) {
    return this.inLane((root) => this.catalog.setDefaultTarget(root, input));
  }

  createCredentialProfile(
    input: CreateCredentialProfileInput,
  ): Promise<CredentialProfileMutationResult> {
    return this.inLane(async (root) => {
      const decoded = decodeConnectionInput(() => normalizeCreateCredentialProfileInput(input));
      return this.catalog.createCredentialProfile(root, decoded);
    });
  }

  updateCredentialProfile(
    input: UpdateCredentialProfileInput,
  ): Promise<CredentialProfileMutationResult> {
    return this.inLane(async (root) => {
      const decoded = decodeConnectionInput(() => normalizeUpdateCredentialProfileInput(input));
      return this.catalog.updateCredentialProfile(root, decoded);
    });
  }

  setCredentialProfileEnabled(
    input: SetCredentialProfileEnabledInput,
  ): Promise<CredentialProfileMutationResult> {
    return this.inLane(async (root) => {
      const decoded = decodeConnectionInput(() => normalizeSetCredentialProfileEnabledInput(input));
      return this.catalog.setCredentialProfileEnabled(root, decoded);
    });
  }

  /**
   * Fail-closed removal of a secondary Profile:
   * 1. Catalog CAS disables the Profile (stops new execution);
   * 2. Vault CAS deletes the Profile credential;
   * 3. Catalog CAS removes the Profile metadata.
   *
   * Crash states are safe: after step 1 the Profile is disabled but still
   * removable; after step 2 the metadata is unconfigured and cannot execute;
   * after step 3 any residual health rows are unreachable.
   */
  removeCredentialProfile(
    input: RemoveCredentialProfileInput,
  ): Promise<CredentialProfileMutationResult> {
    return this.inLane(async (root) => {
      const decoded = decodeConnectionInput(() => normalizeRemoveCredentialProfileInput(input));
      const catalog = await this.catalog.read(root);
      const connection = findConnection(catalog, decoded.expected);
      if (!connection || connection.revision !== decoded.expected.connectionRevision) {
        return deepFreeze({
          kind: 'connection_stale' as const,
          expected: {
            connectionId: decoded.expected.connectionId,
            revision: decoded.expected.connectionRevision,
          },
          actual: connection ? connectionBasis(connection) : null,
        });
      }
      const routing = connection.credentialRouting;
      if (!routing) return profileNotFound(decoded.expected);
      if (decoded.expected.profileId === connection.connectionId) {
        return deepFreeze({ kind: 'primary_not_removable' as const });
      }
      const profile = routing.profiles.find(
        (candidate) => candidate.profileId === decoded.expected.profileId,
      );
      if (!profile) return profileNotFound(decoded.expected);
      if (profile.revision !== decoded.expected.profileRevision) {
        return deepFreeze({
          kind: 'profile_stale' as const,
          expected: decoded.expected,
          actual: {
            connectionId: connection.connectionId,
            connectionRevision: connection.revision,
            profileId: profile.profileId,
            profileRevision: profile.revision,
          },
        });
      }

      // Step 1: disable the Profile (CAS on the same profile basis).
      const disabled = await this.catalog.setCredentialProfileEnabled(root, {
        expected: decoded.expected,
        enabled: false,
      });
      if (disabled.kind !== 'committed') return disabled;

      // Step 2: delete the Profile credential from the Vault (best effort —
      // an absent credential is the desired end state already).
      const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
      const locator = connectionProfileCredentialLocator(
        connection.connectionId,
        decoded.expected.profileId,
        authKind,
      );
      if (locator) {
        const vault = await this.vault.read(root);
        const entry = findCredential(vault, locator);
        if (entry) {
          try {
            await this.vault.delete(root, { expected: credentialBasis(entry) });
          } catch (error) {
            throw commitOutcomeUnknown(
              'Profile removal committed before credential deletion completed',
              error,
            );
          }
        }
      }

      // Step 3: remove the Profile metadata with fresh revisions.
      const catalogAfterDisable = await this.catalog.read(root);
      const current = findConnection(catalogAfterDisable, decoded.expected);
      if (!current) {
        throw codecError(
          'invalid_document',
          'Coordinator lost a connection during profile removal',
        );
      }
      const currentProfile = current.credentialRouting?.profiles.find(
        (candidate) => candidate.profileId === decoded.expected.profileId,
      );
      if (!currentProfile) {
        // Already removed by a concurrent operation; report the committed
        // disable state.
        return deepFreeze({
          kind: 'committed' as const,
          snapshot: catalogSnapshot(catalogAfterDisable),
        });
      }
      return this.catalog.removeCredentialProfile(root, {
        expected: {
          connectionId: current.connectionId,
          connectionRevision: current.revision,
          profileId: currentProfile.profileId,
          profileRevision: currentProfile.revision,
        },
      });
    });
  }

  /**
   * Balanced activation is a coordinator-level operation that combines the
   * Catalog structural preconditions with the Vault configuration check, so
   * a raw IPC call can never activate routing over unconfigured Profiles.
   * The Verification Store evidence check is layered in by the Runtime Host
   * routing integration (PR 2); until then the vault-configured gate is the
   * strongest check available without a routing authority.
   */
  setCredentialRoutingMode(
    input: SetCredentialRoutingModeInput,
  ): Promise<CredentialProfileMutationResult> {
    return this.inLane(async (root) => {
      const decoded = decodeConnectionInput(() => normalizeSetCredentialRoutingModeInput(input));
      if (decoded.mode === 'legacy_primary') {
        return this.catalog.setCredentialRoutingMode(root, decoded);
      }
      const catalog = await this.catalog.read(root);
      const connection = findConnection(catalog, decoded.expected);
      if (!connection || connection.revision !== decoded.expected.revision) {
        return deepFreeze({
          kind: 'connection_stale' as const,
          expected: decoded.expected,
          actual: connection ? connectionBasis(connection) : null,
        });
      }
      const routing = connection.credentialRouting;
      if (!routing || routing.profiles.length < 2) {
        return deepFreeze({
          kind: 'balanced_activation_rejected' as const,
          reason: 'balanced routing requires at least two configured profiles',
        });
      }
      const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
      if (!profileCapableAuthKind(authKind)) {
        return deepFreeze({
          kind: 'auth_not_supported' as const,
          providerType: connection.providerType,
        });
      }
      const vault = await this.vault.read(root);
      const enabledProfiles = routing.profiles.filter((profile) => profile.enabled);
      if (enabledProfiles.length < 2) {
        return deepFreeze({
          kind: 'balanced_activation_rejected' as const,
          reason: 'balanced routing requires at least two enabled profiles',
        });
      }
      const unconfigured = enabledProfiles.filter((profile) => {
        const locator =
          profile.profileId === connection.connectionId
            ? connectionCredentialLocator(connection.connectionId, authKind)
            : connectionProfileCredentialLocator(
                connection.connectionId,
                profile.profileId,
                authKind,
              );
        if (!locator) return true;
        return findCredential(vault, locator) === undefined;
      });
      if (unconfigured.length > 0) {
        return deepFreeze({
          kind: 'balanced_activation_rejected' as const,
          reason: 'balanced routing requires every enabled profile to have a configured credential',
        });
      }
      // Primary profile must keep its credential configured too.
      const primaryLocator = connectionCredentialLocator(connection.connectionId, authKind);
      if (primaryLocator && findCredential(vault, primaryLocator) === undefined) {
        return deepFreeze({
          kind: 'balanced_activation_rejected' as const,
          reason: 'balanced routing requires the primary profile credential to be configured',
        });
      }
      // RFC 4.1 activation gate: every enabled model needs at least one
      // enabled + configured + verified Profile, and at least one enabled
      // model needs two or more enabled Profiles with current support
      // evidence. A Profile with credentials but no verification evidence is
      // not ready: activating would make the first dispatch fail closed with
      // "no eligible credential profile". Transient cooldown is intentionally
      // ignored here (the dispatch layer applies health), but missing
      // verification is not.
      const store = this.routingStoreFor(root);
      const digests = new Map<string, string>();
      for (const modelId of connection.enabledModelIds) {
        digests.set(
          modelId,
          await this.connectionExecutionBasisDigest(root, vault, connection, modelId),
        );
      }
      const verifiedProfileIdsByModel = new Map<string, string[]>();
      for (const profile of enabledProfiles) {
        const locator =
          profile.profileId === connection.connectionId
            ? connectionCredentialLocator(connection.connectionId, authKind)
            : connectionProfileCredentialLocator(
                connection.connectionId,
                profile.profileId,
                authKind,
              );
        const credential = locator ? findCredential(vault, locator) : undefined;
        if (!credential) continue;
        const verification = await store.readProfileVerification(
          connection.connectionId,
          profile.profileId,
        );
        for (const modelId of connection.enabledModelIds) {
          const digest = digests.get(modelId)!;
          const supported = verification.some(
            (record) =>
              record.credentialId === credential.credentialId &&
              record.credentialRevision === credential.revision &&
              record.executionBasisDigest === digest &&
              record.modelId === modelId &&
              record.status === 'supported',
          );
          if (supported) {
            const list = verifiedProfileIdsByModel.get(modelId) ?? [];
            list.push(profile.profileId);
            verifiedProfileIdsByModel.set(modelId, list);
          }
        }
      }
      for (const modelId of connection.enabledModelIds) {
        if ((verifiedProfileIdsByModel.get(modelId)?.length ?? 0) < 1) {
          return deepFreeze({
            kind: 'balanced_activation_rejected' as const,
            reason: `balanced routing requires enabled model ${modelId} to have a verified profile`,
          });
        }
      }
      if (![...verifiedProfileIdsByModel.values()].some((profileIds) => profileIds.length >= 2)) {
        return deepFreeze({
          kind: 'balanced_activation_rejected' as const,
          reason:
            'balanced routing requires at least one enabled model with two or more verified profiles',
        });
      }
      return this.catalog.setCredentialRoutingMode(root, decoded);
    });
  }

  /**
   * Record Profile-level verification evidence (RFC 4.5). This is the
   * production writer for the routing Verification authority; the e2e path
   * seeds evidence through it before balanced activation. The write is
   * CAS-checked against the connection/profile revisions and keyed to the
   * current credential identity/revision + execution basis digest, so a stale
   * test completion cannot overwrite newer config or authorize an old key.
   */
  recordCredentialProfileVerification(
    input: RecordCredentialProfileVerificationInput,
  ): Promise<RecordCredentialProfileVerificationResult> {
    return this.inLane((root) => this.recordCredentialProfileVerificationInLane(root, input));
  }

  /**
   * In-lane verification writer shared by the public CAS entry point and the
   * Profile effect completions. Must never be called outside an active lane:
   * it reads Catalog/Vault state and writes the routing authority.
   */
  private async recordCredentialProfileVerificationInLane(
    root: string,
    input: RecordCredentialProfileVerificationInput,
  ): Promise<RecordCredentialProfileVerificationResult> {
    const catalog = await this.catalog.read(root);
    const connection = findConnection(catalog, { connectionId: input.connectionId });
    if (!connection) {
      return deepFreeze({ kind: 'connection_not_found' as const });
    }
    if (connection.revision !== input.connectionRevision) {
      return deepFreeze({
        kind: 'connection_stale' as const,
        expectedRevision: input.connectionRevision,
        actualRevision: connection.revision,
      });
    }
    const routing = connection.credentialRouting;
    const profile = routing?.profiles.find(
      (candidate) => candidate.profileId === input.profileId,
    );
    if (!profile || profile.revision !== input.profileRevision) {
      return deepFreeze({ kind: 'profile_not_found' as const });
    }
    if (!connection.enabledModelIds.includes(input.modelId)) {
      return deepFreeze({
        kind: 'invalid_request' as const,
        reason: 'verification can only be recorded for an enabled model',
      });
    }
    const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
    const locator =
      input.profileId === connection.connectionId
        ? connectionCredentialLocator(connection.connectionId, authKind)
        : connectionProfileCredentialLocator(connection.connectionId, input.profileId, authKind);
    if (!locator) {
      return deepFreeze({
        kind: 'invalid_request' as const,
        reason: 'provider auth does not support credential profiles',
      });
    }
    const vault = await this.vault.read(root);
    const credential = findCredential(vault, locator);
    if (!credential) {
      return deepFreeze({ kind: 'credential_not_configured' as const });
    }
    const digest = await this.connectionExecutionBasisDigest(
      root,
      vault,
      connection,
      input.modelId,
    );
    await this.routingStoreFor(root).upsertVerification({
      connectionId: connection.connectionId,
      profileId: input.profileId,
      credentialId: credential.credentialId,
      credentialRevision: credential.revision,
      executionBasisDigest: digest,
      modelId: input.modelId,
      status: input.status,
      source: input.source,
      evidence: input.evidence,
      checkedAt: input.checkedAt,
      ...(input.testSummary ? { testSummary: input.testSummary } : {}),
    });
    return deepFreeze({ kind: 'committed' as const });
  }

  /**
   * Versioned, non-secret execution basis digest for one Connection + model
   * (RFC 8.4). Must match the digest the Host resolver computes so the
   * activation gate and dispatch eligibility read the same verification rows.
   */
  private async connectionExecutionBasisDigest(
    root: string,
    vault: CredentialVaultDocument,
    connection: ConnectionCatalogEntry,
    modelId: string,
  ): Promise<string> {
    const requestHeaders = findCredential(
      vault,
      connectionRequestHeadersLocator(connection.connectionId),
    );
    const model = connection.models.find((candidate) => candidate.id === modelId);
    return executionBasisDigest({
      providerType: connection.providerType,
      endpoint: effectiveBaseUrl({
        providerType: connection.providerType,
        baseUrl: connection.baseUrl,
      }),
      apiProtocol: model?.apiProtocol,
      requestHeadersCredentialId: requestHeaders?.credentialId ?? null,
      requestHeadersCredentialRevision: requestHeaders?.revision ?? null,
      requestBodyOverlayJson: connection.requestBodyOverlay
        ? JSON.stringify(connection.requestBodyOverlay)
        : null,
    });
  }

  setCredential(rawInput: SetCredentialInput) {
    return this.setCredentialWithAuthority(rawInput, 'client');
  }

  importConnectionCredential(rawInput: SetCredentialInput) {
    return this.setCredentialWithAuthority(rawInput, 'migration');
  }

  private setCredentialWithAuthority(
    rawInput: SetCredentialInput,
    authority: 'client' | 'migration',
  ) {
    return this.inLane(async (root) => {
      const input = decodeCredentialInput(() => normalizeSetCredentialInput(rawInput));
      const { locator } = input;
      if (authority === 'migration' && locator.scope !== 'connection') {
        throw codecError(
          'invalid_credential_input',
          'Connection credential import requires a Connection credential locator',
        );
      }
      let catalog: ConnectionCatalogDocument | null = null;
      if (locator.scope === 'connection' || locator.scope === 'connection_profile') {
        catalog = await this.catalog.read(root);
        if (!this.validateConnectionCredentialLocator(catalog, locator)) {
          return deepFreeze({ kind: 'connection_not_found' as const });
        }
        if (locator.scope === 'connection' && locator.kind !== 'request_headers') {
          const connection = findConnection(catalog, locator);
          if (
            authority === 'client' &&
            locator.kind === 'oauth_token' &&
            connection?.providerType !== 'github-copilot'
          ) {
            throw codecError(
              'invalid_credential_input',
              'Client-supplied OAuth credentials are only accepted for GitHub Copilot',
            );
          }
        }
      }
      const prepared = this.vault.prepareSet(await this.vault.read(root), input);
      if (prepared.kind !== 'ready') return prepared;
      const cleared = await this.clearCredentialDependentLastTests(root, locator, catalog);
      try {
        await this.vault.commitSet(root, prepared);
        return deepFreeze({
          kind: 'committed' as const,
          snapshot: vaultSnapshot(prepared.document),
        });
      } catch (error) {
        if (cleared) {
          throw commitOutcomeUnknown(
            'Connection verification was cleared before credential update completed',
            error,
          );
        }
        throw error;
      }
    });
  }

  compareAndSetOAuthCredential(rawInput: CompareAndSetOAuthCredentialInput) {
    return this.inLane(async (root) => {
      const input = decodeCredentialInput(() => normalizeSetCredentialInput(rawInput));
      if (
        input.locator.scope !== 'connection' ||
        input.locator.kind !== 'oauth_token' ||
        input.expected === null
      ) {
        throw codecError(
          'invalid_credential_input',
          'OAuth refresh requires an existing connection OAuth credential generation',
        );
      }
      const catalog = await this.catalog.read(root);
      const connection = findConnection(catalog, input.locator);
      if (!connection) return deepFreeze({ kind: 'superseded' as const });
      if (PROVIDER_DEFAULTS[connection.providerType].authKind !== 'oauth_token') {
        throw codecError(
          'invalid_credential_input',
          'OAuth refresh credential does not match the provider auth contract',
        );
      }
      const prepared = this.vault.prepareSet(await this.vault.read(root), input);
      if (prepared.kind !== 'ready') return deepFreeze({ kind: 'superseded' as const });
      await this.vault.commitSet(root, prepared);
      return deepFreeze({
        kind: 'committed' as const,
        credentialId: prepared.entry.credentialId,
        revision: prepared.entry.revision,
      });
    });
  }

  beginInteractiveOAuthLogin(rawConnectionId: string): Promise<BeginInteractiveOAuthLoginResult> {
    return this.inLane(async (root) => {
      const connectionId = decodeConnectionInput(() =>
        decodeRuntimePolicyEntityId(rawConnectionId),
      );
      const catalog = await this.catalog.read(root);
      const connection = findConnection(catalog, { connectionId });
      if (!connection) return deepFreeze({ kind: 'connection_not_found' as const });
      if (!connection.enabled) return deepFreeze({ kind: 'connection_disabled' as const });
      if (!isInteractiveOAuthLoginProvider(connection.providerType)) {
        return deepFreeze({
          kind: 'provider_action_unavailable' as const,
          availability: 'hidden' as const,
        });
      }
      const contract = deriveProviderAuthContract({
        providerType: connection.providerType,
        enabled: true,
        hasSecret: false,
        lastTestStatus: connection.lastTest?.status,
      });
      if (contract.actionAvailability.start_oauth !== 'available') {
        return deepFreeze({
          kind: 'provider_action_unavailable' as const,
          availability: contract.actionAvailability.start_oauth,
        });
      }
      const prepared = await this.prepareConnectionMaterial(root, connection, false);
      if (prepared.kind !== 'ready') return prepared;
      const locator = connectionCredentialLocator(connection.connectionId, 'oauth_token');
      if (!locator || locator.kind !== 'oauth_token') {
        throw codecError(
          'invalid_document',
          'OAuth login admission produced no OAuth credential locator',
        );
      }
      const existing = findCredential(await this.vault.read(root), locator);
      const ticket = this.issueInteractiveOAuthLoginTicket(
        connectionBasis(connection),
        connection.providerType,
        existing ? credentialBasis(existing) : null,
      );
      return deepFreeze({
        kind: 'ready' as const,
        ticket,
        connection: structuredClone(connection) as ConnectionCatalogEntry & {
          readonly providerType: InteractiveOAuthLoginProvider;
        },
        secretMaterial: prepared.secretMaterial.networkProxy
          ? { networkProxy: prepared.secretMaterial.networkProxy }
          : {},
        networkProxy: structuredClone(prepared.networkProxy),
      });
    });
  }

  async completeInteractiveOAuthLogin(
    ticket: InteractiveOAuthLoginTicket,
    rawSecret: string,
  ): Promise<InteractiveOAuthLoginCompletionResult> {
    const claimed = this.claimInteractiveOAuthLoginTicket(ticket);
    return this.completeClaimedTicket(claimed, () =>
      this.inLane(async (root) => {
        const secret = decodeCredentialInput(() => normalizeCredentialSecret(rawSecret));
        const catalog = await this.catalog.read(root);
        const connection = findConnection(catalog, claimed.connectionBasis);
        const changed: Array<'connection' | 'credential'> = [];
        if (
          !connection ||
          connection.revision !== claimed.connectionBasis.revision ||
          connection.providerType !== claimed.providerType ||
          !connection.enabled
        ) {
          changed.push('connection');
        }
        const locator = {
          scope: 'connection',
          connectionId: claimed.connectionBasis.connectionId,
          kind: 'oauth_token',
        } as const;
        const vault = await this.vault.read(root);
        const actual = findCredential(vault, locator);
        if (
          claimed.credentialBasis
            ? !sameCredentialBasis(actual, claimed.credentialBasis)
            : actual !== undefined
        ) {
          changed.push('credential');
        }
        if (changed.length > 0) {
          return deepFreeze({ kind: 'superseded' as const, changed });
        }
        const prepared = this.vault.prepareSet(vault, {
          locator,
          expected: claimed.credentialBasis
            ? {
                credentialId: claimed.credentialBasis.credentialId,
                revision: claimed.credentialBasis.revision,
              }
            : null,
          secret,
        });
        if (prepared.kind !== 'ready') {
          return deepFreeze({
            kind: 'superseded' as const,
            changed: ['credential'] as const,
          });
        }
        const cleared = await this.catalog.clearConnectionLastTest(
          root,
          catalog,
          locator.connectionId,
        );
        try {
          await this.vault.commitSet(root, prepared);
        } catch (error) {
          if (cleared) {
            throw commitOutcomeUnknown(
              'Connection verification was cleared before OAuth login completed',
              error,
            );
          }
          throw error;
        }
        return deepFreeze({
          kind: 'committed' as const,
          credentialId: prepared.entry.credentialId,
          revision: prepared.entry.revision,
        });
      }),
    );
  }

  deleteCredential(rawInput: DeleteCredentialInput) {
    return this.inLane(async (root) => {
      const { expected } = decodeCredentialInput(() => normalizeDeleteCredentialInput(rawInput));
      const { locator } = expected;
      let catalog: ConnectionCatalogDocument | null = null;
      if (locator.scope === 'connection' || locator.scope === 'connection_profile') {
        catalog = await this.catalog.read(root);
        if (!this.validateConnectionCredentialLocator(catalog, locator)) {
          return deepFreeze({ kind: 'connection_not_found' as const });
        }
      }
      const prepared = this.vault.prepareDelete(await this.vault.read(root), { expected });
      if (prepared.kind !== 'ready') return prepared;
      const cleared = await this.clearCredentialDependentLastTests(root, locator, catalog);
      try {
        return await this.vault.commitDelete(root, prepared);
      } catch (error) {
        if (cleared) {
          throw commitOutcomeUnknown(
            'Connection verification was cleared before credential deletion completed',
            error,
          );
        }
        throw error;
      }
    });
  }

  resolveExecutionConnection(rawConnectionSlug: string): Promise<ResolveExecutionConnectionResult> {
    return this.inLane(async (root) => {
      const connectionSlug = decodeConnectionInput(() => decodeConnectionSlug(rawConnectionSlug));
      const catalog = await this.catalog.read(root);
      const connection = catalog.connections.find((candidate) => candidate.slug === connectionSlug);
      if (!connection) return deepFreeze({ kind: 'not_found' as const });
      if (!connection.enabled) return deepFreeze({ kind: 'disabled' as const });

      const contract = deriveProviderAuthContract({
        providerType: connection.providerType,
        enabled: true,
        hasSecret: true,
        lastTestStatus: connection.lastTest?.status,
      });
      const prepared = await this.prepareConnectionMaterial(
        root,
        connection,
        contract.requiresSecret,
      );
      if (prepared.kind !== 'ready') return prepared;
      return deepFreeze({
        kind: 'ready' as const,
        connection: structuredClone(connection),
        secretMaterial: prepared.secretMaterial,
        networkProxy: structuredClone(prepared.networkProxy),
      });
    });
  }

  exportCredentialMaterial(
    rawLocator: CredentialLocator,
  ): Promise<RuntimePolicyCredentialMaterial | null> {
    return this.inLane(async (root) => {
      const locator = decodeCredentialInput(() => decodeCredentialLocator(rawLocator));
      if (locator.scope === 'connection' || locator.scope === 'connection_profile') {
        const catalog = await this.catalog.read(root);
        if (!this.validateConnectionCredentialLocator(catalog, locator)) return null;
      }
      const credential = findCredential(await this.vault.read(root), locator);
      return credential ? credentialMaterial(credential) : null;
    });
  }

  getConnectionRequestHeaders(rawConnectionId: string): Promise<SavedRequestHeaders | null> {
    return this.inLane(async (root) => {
      const connectionId = decodeConnectionInput(() =>
        decodeRuntimePolicyEntityId(rawConnectionId),
      );
      const catalog = await this.catalog.read(root);
      if (!findConnection(catalog, { connectionId })) return null;
      const locator = connectionRequestHeadersLocator(connectionId);
      const credential = findCredential(await this.vault.read(root), locator);
      const headers = credential ? parseRequestHeaders(credential.secret) : {};
      return deepFreeze({ names: Object.keys(headers) });
    });
  }

  replaceConnectionRequestHeaders(
    rawConnectionId: string,
    rawUpdates: readonly RequestHeaderUpdate[],
  ): Promise<ReplaceConnectionRequestHeadersResult> {
    return this.inLane(async (root) => {
      const connectionId = decodeConnectionInput(() =>
        decodeRuntimePolicyEntityId(rawConnectionId),
      );
      const updates = decodeRequestHeaderUpdates(rawUpdates);
      const catalog = await this.catalog.read(root);
      if (!findConnection(catalog, { connectionId })) {
        return deepFreeze({ kind: 'connection_not_found' as const });
      }

      const locator = connectionRequestHeadersLocator(connectionId);
      const vault = await this.vault.read(root);
      const existing = findCredential(vault, locator);
      const savedHeaders = existing ? parseRequestHeaders(existing.secret) : {};
      const savedByName = new Map(
        Object.entries(savedHeaders).map(([name, value]) => [name.toLowerCase(), value]),
      );
      const merged = Object.fromEntries(
        updates.map(({ name, value }) => {
          const retained = value ?? savedByName.get(name.toLowerCase());
          if (retained === undefined) {
            throw codecError('invalid_credential_input', `Request header ${name} requires a value`);
          }
          return [name, retained];
        }),
      );
      const headers = decodeRequestHeaders(merged);
      const names = Object.keys(headers);

      if (names.length === 0) {
        if (!existing) return deepFreeze({ kind: 'unchanged' as const, names });
        const prepared = this.vault.prepareDelete(vault, { expected: credentialBasis(existing) });
        if (prepared.kind !== 'ready') {
          throw codecError('invalid_document', 'Request header credential changed within its lane');
        }
        const cleared = await this.clearCredentialDependentLastTests(root, locator, catalog);
        try {
          await this.vault.commitDelete(root, prepared);
        } catch (error) {
          if (cleared) {
            throw commitOutcomeUnknown(
              'Connection verification was cleared before request headers were deleted',
              error,
            );
          }
          throw error;
        }
        return deepFreeze({ kind: 'committed' as const, names });
      }

      const secret = serializeRequestHeaders(headers);
      if (existing?.secret === secret) {
        return deepFreeze({ kind: 'unchanged' as const, names });
      }
      const prepared = this.vault.prepareSet(vault, {
        locator,
        expected: existing
          ? { credentialId: existing.credentialId, revision: existing.revision }
          : null,
        secret,
      });
      if (prepared.kind !== 'ready') {
        throw codecError('invalid_document', 'Request header credential changed within its lane');
      }
      const cleared = await this.clearCredentialDependentLastTests(root, locator, catalog);
      try {
        await this.vault.commitSet(root, prepared);
      } catch (error) {
        if (cleared) {
          throw commitOutcomeUnknown(
            'Connection verification was cleared before request headers were updated',
            error,
          );
        }
        throw error;
      }
      return deepFreeze({ kind: 'committed' as const, names });
    });
  }

  resolveWebSearchExecution(
    input: ResolveWebSearchExecutionInput = {},
  ): Promise<ResolveWebSearchExecutionResult> {
    return this.inLane(async (root) => {
      const policy = (await this.policy.read(root)).policy;
      if (!input.bypassFeatureGate && policy.privacy.incognitoActive) {
        return deepFreeze({ kind: 'privacy_mode' as const });
      }

      const provider = input.provider ?? policy.webSearch.defaultProvider;
      if (!input.bypassFeatureGate && !policy.webSearch.enabled) {
        return deepFreeze({ kind: 'disabled' as const, provider });
      }

      if (provider === 'model') {
        return deepFreeze({ kind: 'model_native_only' as const, provider });
      }

      const vault = await this.vault.read(root);
      const locator = { scope: 'web_search', provider, kind: 'api_key' } as const;
      const webSearchCredential = findCredential(vault, locator);
      const secretOverride =
        input.secretOverride === undefined
          ? undefined
          : decodeCredentialInput(() => normalizeCredentialSecret(input.secretOverride));
      if (!webSearchCredential && secretOverride === undefined) {
        return deepFreeze({
          kind: 'credential_not_configured' as const,
          status: credentialStatus(vault, locator),
        });
      }

      const proxyLocator = requiresNetworkProxyCredential(policy.networkProxy)
        ? networkProxyCredentialLocator()
        : null;
      let proxyCredential: RuntimePolicyCredentialMaterial | undefined;
      if (proxyLocator) {
        const entry = findCredential(vault, proxyLocator);
        if (!entry) {
          return deepFreeze({
            kind: 'credential_not_configured' as const,
            status: credentialStatus(vault, proxyLocator),
          });
        }
        proxyCredential = credentialMaterial(entry);
      }

      return deepFreeze({
        kind: 'ready' as const,
        provider,
        secretMaterial: {
          webSearch:
            secretOverride === undefined
              ? credentialMaterial(webSearchCredential!)
              : {
                  locator,
                  credentialId: 'ephemeral-web-search-override',
                  revision: 0,
                  secret: secretOverride,
                },
          ...(proxyCredential ? { networkProxy: proxyCredential } : {}),
        },
        networkProxy: structuredClone(policy.networkProxy),
      });
    });
  }

  resolveNetworkProxyExecution(
    input: ResolveNetworkProxyExecutionInput = {},
  ): Promise<ResolveNetworkProxyExecutionResult> {
    return this.inLane(async (root) => {
      const networkProxy =
        input.networkProxy ?? structuredClone((await this.policy.read(root)).policy.networkProxy);
      if (!requiresNetworkProxyCredential(networkProxy)) {
        return deepFreeze({
          kind: 'ready' as const,
          networkProxy: structuredClone(networkProxy),
          secretMaterial: {},
        });
      }
      const locator = networkProxyCredentialLocator();
      const vault = await this.vault.read(root);
      const credential = findCredential(vault, locator);
      const secretOverride =
        input.secretOverride === undefined
          ? undefined
          : decodeCredentialInput(() => normalizeCredentialSecret(input.secretOverride));
      if (!credential && secretOverride === undefined) {
        return deepFreeze({
          kind: 'credential_not_configured' as const,
          status: credentialStatus(vault, locator),
        });
      }
      return deepFreeze({
        kind: 'ready' as const,
        networkProxy: structuredClone(networkProxy),
        secretMaterial: {
          networkProxy:
            secretOverride === undefined
              ? credentialMaterial(credential!)
              : {
                  locator,
                  credentialId: 'ephemeral-network-proxy-override',
                  revision: 0,
                  secret: secretOverride,
                },
        },
      });
    });
  }

  resolveWebFetchExecution(): Promise<ResolveWebFetchExecutionResult> {
    return this.inLane(async (root) => {
      const policy = (await this.policy.read(root)).policy;
      if (policy.privacy.incognitoActive) {
        return deepFreeze({ kind: 'privacy_mode' as const });
      }
      const proxyLocator = requiresNetworkProxyCredential(policy.networkProxy)
        ? networkProxyCredentialLocator()
        : null;
      if (!proxyLocator) {
        return deepFreeze({
          kind: 'ready' as const,
          networkProxy: structuredClone(policy.networkProxy),
          secretMaterial: {},
        });
      }
      const vault = await this.vault.read(root);
      const credential = findCredential(vault, proxyLocator);
      if (!credential) {
        return deepFreeze({
          kind: 'credential_not_configured' as const,
          status: credentialStatus(vault, proxyLocator),
        });
      }
      return deepFreeze({
        kind: 'ready' as const,
        networkProxy: structuredClone(policy.networkProxy),
        secretMaterial: { networkProxy: credentialMaterial(credential) },
      });
    });
  }

  beginModelFetch(rawConnectionId: string): Promise<BeginModelFetchResult> {
    return this.inLane(async (root) => {
      const connectionId = decodeConnectionInput(() =>
        decodeRuntimePolicyEntityId(rawConnectionId),
      );
      const prepared = await this.prepareConnectionOperation(root, connectionId, 'fetch_models');
      if (prepared.kind !== 'ready') return prepared;
      const ticket = this.issueTicket('model_fetch', modelFetchSemanticBasis(prepared));
      return deepFreeze({
        kind: 'ready' as const,
        ticket: ticket as ModelFetchTicket,
        connection: structuredClone(prepared.connection),
        secretMaterial: prepared.secretMaterial,
        networkProxy: structuredClone(prepared.networkProxy),
      });
    });
  }

  async completeModelFetch(
    ticket: ModelFetchTicket,
    result: ConnectionModelDiscoveryResult,
  ): Promise<ConnectionEffectCompletionResult> {
    const claimed = this.claimTicket(ticket, 'model_fetch');
    return this.completeClaimedTicket(claimed, () =>
      this.inLane(async (root) => {
        const catalog = await this.catalog.read(root);
        const checked = await this.checkSemanticConnectionBasis(root, catalog, claimed.basis);
        if (checked.changed.length > 0 || !checked.connection) {
          return deepFreeze({ kind: 'superseded' as const, changed: checked.changed });
        }
        const snapshot = await this.catalog.writeModelFetchResult(
          root,
          catalog,
          connectionBasis(checked.connection),
          result,
        );
        return deepFreeze({ kind: 'committed' as const, snapshot });
      }),
    );
  }

  commitConnectionOnboarding(
    input: CommitConnectionOnboardingInput,
  ): Promise<CommitConnectionOnboardingResult> {
    return this.inLane(async (root) => {
      const catalog = await this.catalog.read(root);
      const slug = deriveConnectionSlug(input.providerType);
      const existing = catalog.connections.find((connection) => connection.slug === slug);
      if (existing && existing.providerType !== input.providerType) {
        return deepFreeze({ kind: 'slug_conflict' as const });
      }
      const connectionId = existing?.connectionId ?? randomUUID();
      let invalidateLastTest = false;
      if (input.suppliedSecret !== null) {
        const locator = {
          scope: 'connection',
          connectionId,
          kind: 'api_key',
        } as const;
        const vault = await this.vault.read(root);
        const credential = findCredential(vault, locator);
        if (credential?.secret !== input.suppliedSecret) {
          invalidateLastTest = true;
          const prepared = this.vault.prepareSet(vault, {
            locator,
            expected: credential
              ? { credentialId: credential.credentialId, revision: credential.revision }
              : null,
            secret: input.suppliedSecret,
          });
          if (prepared.kind !== 'ready') {
            throw codecError(
              'invalid_document',
              `Onboarding credential preflight returned ${prepared.kind}`,
            );
          }
        }
      }
      const intent = prepareConnectionOnboardingIntent({
        ...input,
        connectionId,
        invalidateLastTest,
      });
      const catalogPreflight = this.catalog.prepareOnboardingUpsert(
        catalog,
        intent.connectionId,
        intent.providerType,
        intent.enabledModelIds,
        intent.discovery,
        intent.invalidateLastTest,
      );
      if (catalogPreflight.kind === 'slug_conflict') {
        return deepFreeze({ kind: 'slug_conflict' as const });
      }
      try {
        await writeConnectionOnboardingIntent(root, intent);
      } catch (error) {
        if (isCommitOutcomeUnknown(error)) this.onboardingRecoveryRequired = true;
        throw error;
      }
      try {
        const result = await this.applyConnectionOnboarding(root, intent);
        await clearConnectionOnboardingIntent(root);
        this.onboardingRecoveryRequired = false;
        return deepFreeze({ kind: 'committed' as const, ...result });
      } catch (error) {
        this.onboardingRecoveryRequired = true;
        if (isCommitOutcomeUnknown(error)) throw error;
        throw commitOutcomeUnknown(
          'Connection onboarding has a durable intent and must recover before retrying',
          error,
        );
      }
    });
  }

  beginConnectionTest(
    rawConnectionId: string,
    rawModelId: string | null,
  ): Promise<BeginConnectionTestResult> {
    return this.inLane(async (root) => {
      const connectionId = decodeConnectionInput(() =>
        decodeRuntimePolicyEntityId(rawConnectionId),
      );
      const prepared = await this.prepareConnectionOperation(
        root,
        connectionId,
        'test_credentials',
      );
      if (prepared.kind !== 'ready') return prepared;
      const modelId =
        rawModelId === null
          ? null
          : decodeConnectionInput(() => decodeConnectionModelId(rawModelId));
      if (modelId !== null && !isCanonicalConnectionTestModel(prepared.connection, modelId)) {
        throw codecError(
          'invalid_connection_input',
          'Connection test model is not in the canonical model set',
        );
      }
      const ticket = this.issueTicket('connection_test', connectionTestSemanticBasis(prepared));
      return deepFreeze({
        kind: 'ready' as const,
        ticket: ticket as ConnectionTestTicket,
        connection: structuredClone(prepared.connection),
        modelId,
        secretMaterial: prepared.secretMaterial,
        networkProxy: structuredClone(prepared.networkProxy),
      });
    });
  }

  async completeConnectionTest(
    ticket: ConnectionTestTicket,
    result: ConnectionTestSummary,
  ): Promise<ConnectionEffectCompletionResult> {
    const claimed = this.claimTicket(ticket, 'connection_test');
    return this.completeClaimedTicket(claimed, () =>
      this.inLane(async (root) => {
        const catalog = await this.catalog.read(root);
        const checked = await this.checkSemanticConnectionBasis(root, catalog, claimed.basis);
        if (checked.changed.length > 0 || !checked.connection) {
          return deepFreeze({ kind: 'superseded' as const, changed: checked.changed });
        }
        const snapshot = await this.catalog.writeConnectionTestResult(
          root,
          catalog,
          connectionBasis(checked.connection),
          result,
        );
        return deepFreeze({ kind: 'committed' as const, snapshot });
      }),
    );
  }

  beginConnectionProfileTest(
    rawConnectionId: string,
    rawProfileId: string,
    rawModelId: string | null,
  ): Promise<BeginConnectionProfileTestResult> {
    return this.inLane(async (root) => {
      const connectionId = decodeConnectionInput(() => decodeRuntimePolicyEntityId(rawConnectionId));
      const profileId = decodeConnectionInput(() => decodeRuntimePolicyEntityId(rawProfileId));
      const prepared = await this.prepareConnectionProfileOperation(
        root,
        connectionId,
        profileId,
        'test_credentials',
      );
      if (prepared.kind !== 'ready') return prepared;
      const modelId =
        rawModelId === null
          ? null
          : decodeConnectionInput(() => decodeConnectionModelId(rawModelId));
      if (modelId !== null && !isCanonicalConnectionTestModel(prepared.connection, modelId)) {
        throw codecError(
          'invalid_connection_input',
          'Profile test model is not in the canonical model set',
        );
      }
      const ticket = this.issueTicket('profile_test', profileTestSemanticBasis(prepared, modelId));
      return deepFreeze({
        kind: 'ready' as const,
        ticket: ticket as ProfileTestTicket,
        connection: structuredClone(prepared.connection),
        profile: structuredClone(prepared.profile!),
        modelId,
        secretMaterial: prepared.secretMaterial,
        networkProxy: structuredClone(prepared.networkProxy),
      });
    });
  }

  async completeConnectionProfileTest(
    ticket: ProfileTestTicket,
    result: ConnectionProfileTestCompletionInput,
  ): Promise<ConnectionProfileTestCompletionResult> {
    const claimed = this.claimTicket(ticket, 'profile_test');
    return this.completeClaimedTicket(claimed, () =>
      this.inLane(async (root) => {
        const catalog = await this.catalog.read(root);
        const checked = await this.checkSemanticConnectionBasis(root, catalog, claimed.basis);
        if (checked.changed.length > 0 || !checked.connection) {
          return deepFreeze({ kind: 'superseded' as const, changed: checked.changed });
        }
        const summary = decodeConnectionInput(() => decodeConnectionTestSummary(result.summary));
        if (
          summary.status === 'verified' &&
          result.modelId !== null &&
          checked.connection.enabledModelIds.includes(result.modelId)
        ) {
          const verification = await this.recordCredentialProfileVerificationInLane(root, {
            connectionId: checked.connection.connectionId,
            connectionRevision: checked.connection.revision,
            profileId: claimed.basis.profileId,
            profileRevision: claimed.basis.profileRevision,
            modelId: result.modelId,
            status: 'supported',
            source: 'tested',
            evidence: 'positive_only',
            checkedAt: Date.parse(summary.checkedAt),
            testSummary: summary,
          });
          switch (verification.kind) {
            case 'committed':
              return deepFreeze({ kind: 'committed' as const, verification: 'recorded' as const });
            case 'connection_not_found':
              return deepFreeze({ kind: 'connection_not_found' as const });
            case 'connection_stale':
              return deepFreeze({
                kind: 'connection_stale' as const,
                expectedRevision: verification.expectedRevision,
                actualRevision: verification.actualRevision,
              });
            case 'profile_not_found':
              return deepFreeze({ kind: 'profile_not_found' as const });
            case 'credential_not_configured':
              return deepFreeze({ kind: 'credential_not_configured' as const });
            case 'invalid_request':
              return deepFreeze({
                kind: 'invalid_request' as const,
                reason: verification.reason,
              });
          }
        }
        // A failed or model-less test never writes verification evidence.
        return deepFreeze({ kind: 'committed' as const, verification: 'not_recorded' as const });
      }),
    );
  }

  beginConnectionProfileModelFetch(
    rawConnectionId: string,
    rawProfileId: string,
  ): Promise<BeginConnectionProfileModelFetchResult> {
    return this.inLane(async (root) => {
      const connectionId = decodeConnectionInput(() => decodeRuntimePolicyEntityId(rawConnectionId));
      const profileId = decodeConnectionInput(() => decodeRuntimePolicyEntityId(rawProfileId));
      const prepared = await this.prepareConnectionProfileOperation(
        root,
        connectionId,
        profileId,
        'fetch_models',
      );
      if (prepared.kind !== 'ready') return prepared;
      const ticket = this.issueTicket(
        'profile_model_fetch',
        profileModelFetchSemanticBasis(prepared),
      );
      return deepFreeze({
        kind: 'ready' as const,
        ticket: ticket as ProfileModelFetchTicket,
        connection: structuredClone(prepared.connection),
        profile: structuredClone(prepared.profile!),
        secretMaterial: prepared.secretMaterial,
        networkProxy: structuredClone(prepared.networkProxy),
      });
    });
  }

  async completeConnectionProfileModelFetch(
    ticket: ProfileModelFetchTicket,
    result: ConnectionModelDiscoveryResult,
    evidence: 'positive_only' | 'authoritative',
  ): Promise<ConnectionProfileModelFetchCompletionResult> {
    const claimed = this.claimTicket(ticket, 'profile_model_fetch');
    return this.completeClaimedTicket(claimed, () =>
      this.inLane(async (root) => {
        const catalog = await this.catalog.read(root);
        const checked = await this.checkSemanticConnectionBasis(root, catalog, claimed.basis);
        if (checked.changed.length > 0 || !checked.connection) {
          return deepFreeze({ kind: 'superseded' as const, changed: checked.changed });
        }
        const discovery = decodeConnectionInput(() =>
          normalizeConnectionModelDiscoveryResult(result),
        );
        if (discovery.models.length === 0) {
          throw codecError(
            'invalid_connection_input',
            'Profile model discovery result must not be empty',
          );
        }
        const connection = checked.connection;
        const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
        const locator =
          claimed.basis.profileId === connection.connectionId
            ? connectionCredentialLocator(connection.connectionId, authKind)
            : connectionProfileCredentialLocator(
                connection.connectionId,
                claimed.basis.profileId,
                authKind,
              );
        const vault = await this.vault.read(root);
        const credential = locator ? findCredential(vault, locator) : undefined;
        if (!credential) {
          return deepFreeze({ kind: 'credential_not_configured' as const });
        }
        const supportedModelIds = discovery.models
          .map((model) => model.id)
          .filter((modelId) => connection.enabledModelIds.includes(modelId));
        if (supportedModelIds.length > 0) {
          const store = this.routingStoreFor(root);
          if (evidence === 'authoritative') {
            // Atomically replace each basis group: rows the current
            // authoritative discovery dropped (same credential + digest) are
            // removed, other digest groups are untouched.
            const modelIdsByDigest = new Map<string, string[]>();
            for (const modelId of supportedModelIds) {
              const digest = await this.connectionExecutionBasisDigest(root, vault, connection, modelId);
              const group = modelIdsByDigest.get(digest) ?? [];
              group.push(modelId);
              modelIdsByDigest.set(digest, group);
            }
            for (const [digest, modelIds] of modelIdsByDigest) {
              await store.replaceVerificationBasis(
                connection.connectionId,
                claimed.basis.profileId,
                credential.credentialId,
                credential.revision,
                digest,
                modelIds.map(
                  (modelId): CredentialProfileVerificationRecord => ({
                    connectionId: connection.connectionId,
                    profileId: claimed.basis.profileId,
                    credentialId: credential.credentialId,
                    credentialRevision: credential.revision,
                    executionBasisDigest: digest,
                    modelId,
                    status: 'supported',
                    source: 'discovered',
                    evidence: 'authoritative',
                    checkedAt: discovery.fetchedAt,
                  }),
                ),
              );
            }
          } else {
            for (const modelId of supportedModelIds) {
              const digest = await this.connectionExecutionBasisDigest(root, vault, connection, modelId);
              await store.upsertVerification({
                connectionId: connection.connectionId,
                profileId: claimed.basis.profileId,
                credentialId: credential.credentialId,
                credentialRevision: credential.revision,
                executionBasisDigest: digest,
                modelId,
                status: 'supported',
                source: 'discovered',
                evidence: 'positive_only',
                checkedAt: discovery.fetchedAt,
              });
            }
          }
        }
        // Verification is persisted first; the Catalog metadata merge runs
        // after, so a crash in between leaves at most "evidence present but
        // inventory not yet shown" — a safe state (RFC 13.2).
        const snapshot = await this.catalog.mergeConnectionProfileDiscoveryMetadata(
          root,
          catalog,
          connectionBasis(connection),
          discovery,
        );
        return deepFreeze({
          kind: 'committed' as const,
          verification: supportedModelIds.length > 0 ? ('recorded' as const) : ('not_recorded' as const),
          catalogRevision: snapshot.revision,
          snapshot,
        });
      }),
    );
  }

  readCredentialProfileReadiness(
    rawConnectionId: string,
  ): Promise<CredentialProfileReadinessResult> {
    return this.inLane((root) =>
      this.readCredentialProfileReadinessInLane(root, rawConnectionId),
    );
  }

  private async readCredentialProfileReadinessInLane(
    root: string,
    rawConnectionId: string,
  ): Promise<CredentialProfileReadinessResult> {
    const connectionId = decodeConnectionInput(() => decodeRuntimePolicyEntityId(rawConnectionId));
      const catalog = await this.catalog.read(root);
      const connection = findConnection(catalog, { connectionId });
      if (!connection) {
        return deepFreeze({ kind: 'connection_not_found' as const });
      }
      const routing = connection.credentialRouting;
      if (!routing) {
        return deepFreeze({
          kind: 'found' as const,
          connectionId: connection.connectionId,
          connectionRevision: connection.revision,
          routingMode: 'legacy_primary' as const,
          readyCandidateCount: 0,
          profiles: [],
        });
      }
      const vault = await this.vault.read(root);
      const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
      const store = this.routingStoreFor(root);
      const entries: CredentialProfileReadinessEntry[] = [];
      const readyProfileIdsByModel = new Map<string, string[]>();
      for (const profile of routing.profiles) {
        const locator =
          profile.profileId === connection.connectionId
            ? connectionCredentialLocator(connection.connectionId, authKind)
            : connectionProfileCredentialLocator(connection.connectionId, profile.profileId, authKind);
        const credential = locator ? findCredential(vault, locator) : undefined;
        const verificationRecords = await store.readProfileVerification(
          connection.connectionId,
          profile.profileId,
        );
        const supportedModels: string[] = [];
        let lastTest: CredentialProfileReadinessEntry['lastTest'] = null;
        let circuit:
          | CredentialProfileReadinessEntry['circuit']
          | null = null;
        if (credential) {
          for (const record of verificationRecords) {
            if (
              record.credentialId !== credential.credentialId ||
              record.credentialRevision !== credential.revision ||
              record.status !== 'supported'
            ) {
              continue;
            }
            if (connection.enabledModelIds.includes(record.modelId)) {
              supportedModels.push(record.modelId);
            }
            if (
              record.source === 'tested' &&
              record.testSummary &&
              (!lastTest || record.checkedAt > Date.parse(lastTest.checkedAt))
            ) {
              lastTest = record.testSummary;
            }
          }
          const digestModels = new Map<string, string[]>();
          for (const modelId of supportedModels) {
            const digest = await this.connectionExecutionBasisDigest(root, vault, connection, modelId);
            const group = digestModels.get(digest) ?? [];
            group.push(modelId);
            digestModels.set(digest, group);
          }
          for (const [digest, modelIds] of digestModels) {
            const health = await store.readHealth(
              connection.connectionId,
              profile.profileId,
              credential.credentialId,
              credential.revision,
              digest,
            );
            for (const row of health) {
              if (!modelIds.includes(row.modelId)) continue;
              if (row.circuitState === 'closed') continue;
              const severity =
                row.circuitState === 'invalid'
                  ? 3
                  : row.circuitState === 'open'
                    ? 2
                    : 1;
              const current =
                circuit?.state === 'invalid'
                  ? 3
                  : circuit?.state === 'open'
                    ? 2
                    : circuit?.state === 'half_open'
                      ? 1
                      : 0;
              if (severity > current) {
                circuit = {
                  state: row.circuitState,
                  blockedUntil: row.blockedUntil,
                  nextProbeAt: row.nextProbeAt,
                };
              }
            }
          }
        }
        entries.push(
          deepFreeze({
            profileId: profile.profileId,
            revision: profile.revision,
            label: profile.label,
            enabled: profile.enabled,
            weight: profile.weight,
            primary: profile.profileId === connection.connectionId,
            credentialConfigured: credential !== undefined,
            lastTest,
            supportedModels,
            circuit,
          }),
        );
        if (profile.enabled && credential) {
          const ready = (circuit === null || circuit.state === 'closed' || circuit.state === 'half_open') && supportedModels.length > 0;
          if (ready) {
            for (const modelId of supportedModels) {
              const list = readyProfileIdsByModel.get(modelId) ?? [];
              if (!list.includes(profile.profileId)) list.push(profile.profileId);
              readyProfileIdsByModel.set(modelId, list);
            }
          }
        }
      }
      const readyCandidateCount = [...readyProfileIdsByModel.values()].filter(
        (profileIds) => profileIds.length >= 2,
      ).length;
      return deepFreeze({
        kind: 'found' as const,
        connectionId: connection.connectionId,
        connectionRevision: connection.revision,
        routingMode: routing.mode,
        readyCandidateCount,
        profiles: entries,
      });
  }

  private async prepareConnectionProfileOperation(
    root: string,
    connectionId: string,
    profileId: string,
    action: ProviderAuthAction,
  ): Promise<
    | PreparedConnectionMaterial
    | Exclude<BeginConnectionProfileTestResult | BeginConnectionProfileModelFetchResult, { readonly kind: 'ready' }>
  > {
    const catalog = await this.catalog.read(root);
    const connection = findConnection(catalog, { connectionId });
    if (!connection) return deepFreeze({ kind: 'connection_not_found' as const });
    if (!connection.enabled) return deepFreeze({ kind: 'connection_disabled' as const });
    const routing = connection.credentialRouting;
    const profile = routing?.profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) return deepFreeze({ kind: 'profile_not_found' as const });
    if (!profile.enabled) return deepFreeze({ kind: 'profile_disabled' as const });

    const contract = deriveProviderAuthContract({
      providerType: connection.providerType,
      enabled: true,
      hasSecret: true,
      lastTestStatus: connection.lastTest?.status,
    });
    const availability = contract.actionAvailability[action];
    if (availability !== 'available') {
      return deepFreeze({ kind: 'provider_action_unavailable' as const, availability });
    }
    return this.prepareConnectionMaterial(root, connection, contract.requiresSecret, profile);
  }

  private async prepareConnectionOperation(
    root: string,
    connectionId: string,
    action: ProviderAuthAction,
  ): Promise<
    PreparedConnectionMaterial | Exclude<BeginModelFetchResult, { readonly kind: 'ready' }>
  > {
    const catalog = await this.catalog.read(root);
    const connection = findConnection(catalog, { connectionId });
    if (!connection) return deepFreeze({ kind: 'connection_not_found' as const });
    if (!connection.enabled) return deepFreeze({ kind: 'connection_disabled' as const });

    const contract = deriveProviderAuthContract({
      providerType: connection.providerType,
      enabled: true,
      hasSecret: true,
      lastTestStatus: connection.lastTest?.status,
    });
    const availability = contract.actionAvailability[action];
    if (availability !== 'available') {
      return deepFreeze({ kind: 'provider_action_unavailable' as const, availability });
    }
    return this.prepareConnectionMaterial(root, connection, contract.requiresSecret);
  }

  private async prepareConnectionMaterial(
    root: string,
    connection: ConnectionCatalogEntry,
    requiresConnectionSecret: boolean,
    profile?: ConnectionCredentialProfileEntry,
  ): Promise<
    | PreparedConnectionMaterial
    | { readonly kind: 'credential_not_configured'; readonly status: CredentialStatus }
  > {
    const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
    const locator = profile
      ? profile.profileId === connection.connectionId
        ? connectionCredentialLocator(connection.connectionId, authKind)
        : connectionProfileCredentialLocator(connection.connectionId, profile.profileId, authKind)
      : connectionCredentialLocator(connection.connectionId, authKind);
    const policy = await this.policy.read(root);
    const networkProxy = structuredClone(policy.policy.networkProxy);
    const proxyLocator = requiresNetworkProxyCredential(networkProxy)
      ? networkProxyCredentialLocator()
      : null;
    const requestHeadersLocator = connectionRequestHeadersLocator(connection.connectionId);
    let connectionCredentialStatus: CredentialStatus | null = null;
    let proxyCredentialStatus: CredentialStatus | null = null;
    const vault = await this.vault.read(root);
    const requestHeadersCredentialStatus = credentialStatus(vault, requestHeadersLocator);
    const secretMaterial: {
      connection?: RuntimePolicyCredentialMaterial;
      requestHeaders?: RuntimePolicyCredentialMaterial;
      networkProxy?: RuntimePolicyCredentialMaterial;
    } = {};

    const requestHeaders = findCredential(vault, requestHeadersLocator);
    if (requestHeaders) secretMaterial.requestHeaders = credentialMaterial(requestHeaders);
    if (locator || proxyLocator) {
      if (locator) {
        const status = credentialStatus(vault, locator);
        connectionCredentialStatus = status;
        const entry = findCredential(vault, locator);
        if (!entry) {
          if (requiresConnectionSecret) {
            return deepFreeze({
              kind: 'credential_not_configured' as const,
              status,
            });
          }
        } else {
          secretMaterial.connection = credentialMaterial(entry);
        }
      }
      if (proxyLocator) {
        const status = credentialStatus(vault, proxyLocator);
        proxyCredentialStatus = status;
        const entry = findCredential(vault, proxyLocator);
        if (!entry) {
          return deepFreeze({
            kind: 'credential_not_configured' as const,
            status,
          });
        }
        secretMaterial.networkProxy = credentialMaterial(entry);
      }
    }

    return {
      kind: 'ready',
      connection,
      connectionCredentialStatus,
      requestHeadersCredentialStatus,
      proxyCredentialStatus,
      secretMaterial,
      networkProxy,
      ...(profile ? { profile } : {}),
    };
  }

  private validateConnectionCredentialLocator(
    catalog: ConnectionCatalogDocument,
    locator: CredentialLocator,
  ): boolean {
    if (locator.scope === 'connection') {
      const connection = findConnection(catalog, locator);
      if (!connection) return false;
      if (locator.kind === 'request_headers') return true;
      const required = connectionCredentialLocator(
        connection.connectionId,
        PROVIDER_DEFAULTS[connection.providerType].authKind,
      );
      if (!required || required.kind !== locator.kind) {
        throw codecError(
          'invalid_credential_input',
          'Connection credential kind does not match the provider auth contract',
        );
      }
      return true;
    }
    if (locator.scope === 'connection_profile') {
      const connection = findConnection(catalog, locator);
      if (!connection) return false;
      if (locator.profileId === connection.connectionId) {
        // The primary Profile identity is reserved for the `connection` scope;
        // a primary locator smuggled through `connection_profile` would let a
        // client bypass the primary's kind/OAuth validation.
        throw codecError(
          'invalid_credential_input',
          'Primary profile credentials must use the connection credential locator',
        );
      }
      const routing = connection.credentialRouting;
      const profile = routing?.profiles.find(
        (candidate) => candidate.profileId === locator.profileId,
      );
      if (!profile) return false;
      const required = connectionProfileCredentialLocator(
        connection.connectionId,
        locator.profileId,
        PROVIDER_DEFAULTS[connection.providerType].authKind,
      );
      if (!required || required.kind !== locator.kind) {
        throw codecError(
          'invalid_credential_input',
          'Connection profile credential kind does not match the provider auth contract',
        );
      }
      return true;
    }
    // web_search / network_proxy scopes carry no Connection authority.
    return true;
  }

  private async clearCredentialDependentLastTests(
    root: string,
    locator: CredentialLocator,
    connectionCatalog: ConnectionCatalogDocument | null,
  ): Promise<boolean> {
    if (locator.scope === 'connection' || locator.scope === 'connection_profile') {
      return this.catalog.clearConnectionLastTest(root, connectionCatalog!, locator.connectionId);
    }
    if (locator.scope !== 'network_proxy') return false;
    const policy = await this.policy.read(root);
    if (!requiresNetworkProxyCredential(policy.policy.networkProxy)) return false;
    return this.catalog.clearAllConnectionLastTests(root, await this.catalog.read(root));
  }

  private async checkSemanticConnectionBasis(
    root: string,
    catalog: Awaited<ReturnType<ConnectionCatalogDocumentOwner['read']>>,
    basis: SemanticConnectionBasis,
  ): Promise<{
    readonly connection: ConnectionCatalogEntry | undefined;
    readonly changed: ConnectionEffectChangedDomain[];
  }> {
    const connection = findConnection(catalog, { connectionId: basis.connectionId });
    const changed: ConnectionEffectChangedDomain[] = [];
    if (
      !connection ||
      connection.providerType !== basis.providerType ||
      !connection.enabled ||
      canonicalEffectiveEndpoint(connection) !== basis.effectiveEndpoint ||
      ((basis.kind === 'model_fetch' || basis.kind === 'profile_model_fetch') &&
        !sameStringArray(connection.enabledModelIds, basis.enabledModelIds)) ||
      ((basis.kind === 'connection_test' || basis.kind === 'profile_test') &&
        JSON.stringify(connection.requestBodyOverlay ?? {}) !== basis.requestBodyOverlayJson) ||
      ((basis.kind === 'connection_test' || basis.kind === 'profile_test') &&
        !sameConnectionTestModelBasis(connectionTestModelBasis(connection), basis.model))
    ) {
      changed.push('connection');
    }
    if (basis.kind === 'profile_test' || basis.kind === 'profile_model_fetch') {
      const routing = connection?.credentialRouting;
      const profile = routing?.profiles.find(
        (candidate) => candidate.profileId === basis.profileId,
      );
      if (!connection || !profile || !profile.enabled || profile.revision !== basis.profileRevision) {
        changed.push('connection');
      }
    }

    const policy = await this.policy.read(root);
    if (
      !sameEffectiveProxyConfiguration(
        effectiveProxyConfigurationBasis(policy.policy.networkProxy),
        basis.effectiveProxy,
      )
    ) {
      changed.push('network_proxy');
    }

    if (basis.credential || basis.requestHeadersCredential || basis.proxyCredential) {
      const vault = await this.vault.read(root);
      const connectionCredentialChanged = Boolean(
        basis.credential &&
          !sameCredentialStatus(
            credentialStatus(vault, basis.credential.locator),
            basis.credential,
          ),
      );
      const proxyCredentialChanged = Boolean(
        basis.proxyCredential &&
          !sameCredentialStatus(
            credentialStatus(vault, basis.proxyCredential.locator),
            basis.proxyCredential,
          ),
      );
      const requestHeadersCredentialChanged = !sameCredentialStatus(
        credentialStatus(vault, basis.requestHeadersCredential.locator),
        basis.requestHeadersCredential,
      );
      if (
        connectionCredentialChanged ||
        requestHeadersCredentialChanged ||
        proxyCredentialChanged
      ) {
        changed.push('credential');
      }
    }
    return { connection, changed };
  }

  private issueTicket(kind: ConnectionTicketKind, basis: SemanticConnectionBasis): object {
    const ticket = Object.freeze(Object.create(null)) as object;
    this.tickets.set(ticket, { kind, basis, state: 'available' });
    return ticket;
  }

  private issueInteractiveOAuthLoginTicket(
    connectionBasisValue: ConnectionVersionBasis,
    providerType: InteractiveOAuthLoginProvider,
    credentialBasisValue: CredentialVersionBasis | null,
  ): InteractiveOAuthLoginTicket {
    const ticket = Object.freeze(Object.create(null)) as object;
    this.tickets.set(ticket, {
      kind: 'interactive_oauth_login',
      connectionBasis: connectionBasisValue,
      providerType,
      credentialBasis: credentialBasisValue,
      state: 'available',
    });
    return ticket as InteractiveOAuthLoginTicket;
  }

  private claimTicket<K extends ConnectionTicketKind>(
    ticket: object,
    expectedKind: K,
  ): ConnectionTicketRecord<K> {
    const record = ticket && typeof ticket === 'object' ? this.tickets.get(ticket) : undefined;
    if (!record || record.kind !== expectedKind || record.state !== 'available') {
      throw codecError(
        'invalid_connection_input',
        `Expected an authentic available ${ticketLabel(expectedKind)} ticket`,
      );
    }
    record.state = 'in_flight';
    return record as unknown as ConnectionTicketRecord<K>;
  }

  private claimInteractiveOAuthLoginTicket(
    ticket: InteractiveOAuthLoginTicket,
  ): InteractiveOAuthLoginTicketRecord {
    const record = ticket && typeof ticket === 'object' ? this.tickets.get(ticket) : undefined;
    if (!record || record.kind !== 'interactive_oauth_login' || record.state !== 'available') {
      throw codecError(
        'invalid_credential_input',
        'Expected an authentic available interactive OAuth login ticket',
      );
    }
    record.state = 'in_flight';
    return record;
  }

  private async completeClaimedTicket<T>(
    ticket: OperationTicketRecord,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } finally {
      ticket.state = 'consumed';
    }
  }

  private async recoverConnectionOnboarding(root: string): Promise<void> {
    const intent = await readConnectionOnboardingIntent(root);
    if (!intent) {
      this.onboardingRecoveryRequired = false;
      return;
    }
    this.onboardingRecoveryRequired = true;
    try {
      await this.applyConnectionOnboarding(root, intent);
      await clearConnectionOnboardingIntent(root);
      this.onboardingRecoveryRequired = false;
    } catch (error) {
      if (isCommitOutcomeUnknown(error)) throw error;
      throw commitOutcomeUnknown('Connection onboarding recovery did not converge', error);
    }
  }

  private async applyConnectionOnboarding(
    root: string,
    intent: ConnectionOnboardingIntent,
  ): Promise<{ readonly snapshot: ConnectionCatalogSnapshot; readonly changed: boolean }> {
    let changed = false;
    if (intent.suppliedSecret !== null) {
      const locator = {
        scope: 'connection',
        connectionId: intent.connectionId,
        kind: 'api_key',
      } as const;
      const vault = await this.vault.read(root);
      const existing = findCredential(vault, locator);
      if (existing?.secret !== intent.suppliedSecret) {
        const prepared = this.vault.prepareSet(vault, {
          locator,
          expected: existing
            ? { credentialId: existing.credentialId, revision: existing.revision }
            : null,
          secret: intent.suppliedSecret,
        });
        if (prepared.kind !== 'ready') {
          throw codecError(
            'invalid_document',
            `Onboarding credential write returned ${prepared.kind}`,
          );
        }
        await this.vault.commitSet(root, prepared);
        changed = true;
      }
    }

    const catalog = await this.catalog.read(root);
    const prepared = this.catalog.prepareOnboardingUpsert(
      catalog,
      intent.connectionId,
      intent.providerType,
      intent.enabledModelIds,
      intent.discovery,
      intent.invalidateLastTest,
    );
    if (prepared.kind === 'slug_conflict') {
      throw codecError('invalid_document', 'Onboarding intent conflicts with the connection slug');
    }
    const snapshot = await this.catalog.commitPreparedOnboarding(root, prepared);
    return { snapshot, changed: changed || prepared.changed };
  }

  private inLane<T>(operation: (root: string) => Promise<T>): Promise<T> {
    return this.lane.run(async (root) => {
      if (this.onboardingRecoveryRequired) await this.recoverConnectionOnboarding(root);
      return operation(root);
    });
  }
}

function isCommitOutcomeUnknown(error: unknown): error is RuntimePolicyStoreError {
  return error instanceof RuntimePolicyStoreError && error.code === 'commit_outcome_unknown';
}

function commonSemanticConnectionBasis(
  prepared: PreparedConnectionMaterial,
): CommonSemanticConnectionBasis {
  return {
    connectionId: prepared.connection.connectionId,
    providerType: prepared.connection.providerType,
    enabled: true,
    effectiveEndpoint: canonicalEffectiveEndpoint(prepared.connection),
    credential: prepared.connectionCredentialStatus,
    requestHeadersCredential: prepared.requestHeadersCredentialStatus,
    effectiveProxy: effectiveProxyConfigurationBasis(prepared.networkProxy),
    proxyCredential: prepared.proxyCredentialStatus,
  };
}

function modelFetchSemanticBasis(
  prepared: PreparedConnectionMaterial,
): Extract<SemanticConnectionBasis, { readonly kind: 'model_fetch' }> {
  return {
    kind: 'model_fetch',
    ...commonSemanticConnectionBasis(prepared),
    enabledModelIds: [...prepared.connection.enabledModelIds],
  };
}

function connectionTestSemanticBasis(
  prepared: PreparedConnectionMaterial,
): Extract<SemanticConnectionBasis, { readonly kind: 'connection_test' }> {
  return {
    kind: 'connection_test',
    ...commonSemanticConnectionBasis(prepared),
    requestBodyOverlayJson: JSON.stringify(prepared.connection.requestBodyOverlay ?? {}),
    model: connectionTestModelBasis(prepared.connection),
  };
}

function profileSemanticBasisFields(
  prepared: PreparedConnectionMaterial,
): ProfileSemanticConnectionBasisFields {
  const profile = prepared.profile;
  if (!profile) {
    throw codecError('invalid_connection_input', 'Profile ticket requires a Profile operation');
  }
  return {
    profileId: profile.profileId,
    profileEnabled: true,
    profileRevision: profile.revision,
  };
}

function profileTestSemanticBasis(
  prepared: PreparedConnectionMaterial,
  modelId: string | null,
): Extract<SemanticConnectionBasis, { readonly kind: 'profile_test' }> {
  return {
    kind: 'profile_test',
    ...commonSemanticConnectionBasis(prepared),
    ...profileSemanticBasisFields(prepared),
    modelId,
    requestBodyOverlayJson: JSON.stringify(prepared.connection.requestBodyOverlay ?? {}),
    model: connectionTestModelBasis(prepared.connection),
  };
}

function profileModelFetchSemanticBasis(
  prepared: PreparedConnectionMaterial,
): Extract<SemanticConnectionBasis, { readonly kind: 'profile_model_fetch' }> {
  return {
    kind: 'profile_model_fetch',
    ...commonSemanticConnectionBasis(prepared),
    ...profileSemanticBasisFields(prepared),
    enabledModelIds: [...prepared.connection.enabledModelIds],
  };
}

function isCanonicalConnectionTestModel(
  connection: ConnectionCatalogEntry,
  modelId: string,
): boolean {
  const basis = connectionTestModelBasis(connection);
  const inCanonicalModels = basis.models.some((model) => model.id === modelId);
  return basis.modelSource === 'fetched'
    ? inCanonicalModels
    : inCanonicalModels || basis.enabledModelIds.includes(modelId);
}

function canonicalEffectiveEndpoint(connection: ConnectionCatalogEntry): string {
  const endpoint = effectiveBaseUrl(connection);
  try {
    return new URL(endpoint).toString();
  } catch {
    throw codecError('invalid_document', 'Connection has an invalid effective endpoint');
  }
}

function effectiveProxyConfigurationBasis(
  networkProxy: RuntimePolicy['networkProxy'],
): EffectiveProxyConfigurationBasis {
  if (!networkProxy.enabled) return { kind: 'direct' };
  return {
    kind: 'proxy',
    protocol: networkProxy.protocol,
    host: networkProxy.host.trim().toLowerCase(),
    port: networkProxy.port,
    authentication: networkProxy.authEnabled
      ? { kind: 'credentials', username: networkProxy.username }
      : { kind: 'none' },
    bypassPatterns: normalizeProxyPatterns([
      ...networkProxy.bypassList,
      ...networkProxy.autoBypassDomains,
    ]),
  };
}

function sameEffectiveProxyConfiguration(
  actual: EffectiveProxyConfigurationBasis,
  expected: EffectiveProxyConfigurationBasis,
): boolean {
  if (actual.kind !== expected.kind) return false;
  if (actual.kind === 'direct' || expected.kind === 'direct') return true;
  return (
    actual.protocol === expected.protocol &&
    actual.host === expected.host &&
    actual.port === expected.port &&
    sameProxyAuthentication(actual.authentication, expected.authentication) &&
    sameStringArray(actual.bypassPatterns, expected.bypassPatterns)
  );
}

function sameProxyAuthentication(
  actual: Extract<EffectiveProxyConfigurationBasis, { kind: 'proxy' }>['authentication'],
  expected: Extract<EffectiveProxyConfigurationBasis, { kind: 'proxy' }>['authentication'],
): boolean {
  if (actual.kind !== expected.kind) return false;
  return (
    actual.kind === 'none' ||
    (expected.kind === 'credentials' && actual.username === expected.username)
  );
}

function normalizeProxyPatterns(patterns: readonly string[]): readonly string[] {
  return [
    ...new Set(
      patterns
        .map((pattern) => pattern.trim().toLowerCase())
        .filter((pattern) => pattern.length > 0),
    ),
  ].sort();
}

function sameStringArray(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function decodeRequestHeaderUpdates(value: unknown): readonly RequestHeaderUpdate[] {
  try {
    return normalizeRequestHeaderUpdates(value);
  } catch (error) {
    if (error instanceof RequestCustomizationValidationError) {
      throw codecError('invalid_credential_input', error.message);
    }
    throw error;
  }
}

function decodeRequestHeaders(value: unknown): Readonly<Record<string, string>> {
  try {
    return normalizeRequestHeaders(value);
  } catch (error) {
    if (error instanceof RequestCustomizationValidationError) {
      throw codecError('invalid_credential_input', error.message);
    }
    throw error;
  }
}

function sameCredentialStatus(actual: CredentialStatus, expected: CredentialStatus): boolean {
  return (
    sameCredentialLocator(actual.locator, expected.locator) &&
    actual.configured === expected.configured &&
    actual.credentialId === expected.credentialId &&
    actual.revision === expected.revision
  );
}

function sameCredentialLocator(actual: CredentialLocator, expected: CredentialLocator): boolean {
  return (
    actual.scope === expected.scope &&
    actual.kind === expected.kind &&
    (actual.scope !== 'connection' ||
      (expected.scope === 'connection' && actual.connectionId === expected.connectionId))
  );
}

function ticketLabel(kind: ConnectionTicketKind): string {
  switch (kind) {
    case 'model_fetch':
      return 'model fetch';
    case 'connection_test':
      return 'connection test';
    case 'profile_test':
      return 'profile test';
    case 'profile_model_fetch':
      return 'profile model fetch';
  }
}

function networkProxyCredentialLocator(): Extract<CredentialLocator, { scope: 'network_proxy' }> {
  return { scope: 'network_proxy', kind: 'password' };
}

function requiresNetworkProxyCredential(networkProxy: RuntimePolicy['networkProxy']): boolean {
  return networkProxy.enabled && networkProxy.authEnabled;
}

function isInteractiveOAuthLoginProvider(
  providerType: ProviderType,
): providerType is InteractiveOAuthLoginProvider {
  return (
    providerType === 'claude-subscription' ||
    providerType === 'openai-codex' ||
    providerType === 'xai-oauth'
  );
}

function profileNotFound(expected: CredentialProfileVersionBasis): CredentialProfileMutationResult {
  return deepFreeze({ kind: 'profile_not_found' as const, expected });
}

function profileCapableAuthKind(authKind: ProviderAuthKind): boolean {
  return authKind === 'api_key' || authKind === 'optional_api_key' || authKind === 'oauth_token';
}
