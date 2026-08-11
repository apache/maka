import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CONNECTION_CATALOG_MAX_CONNECTIONS,
  CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION,
  CONNECTION_CREDENTIAL_PROFILE_MAX,
  decodeCanonicalConnectionCatalogEntry,
  decodeConnectionTarget,
  decodeConnectionTestSummary,
  decodeConnectionVersionBasis,
  decodeProviderType,
  decodeRuntimePolicyEntityId,
  normalizeConnectionCatalogEntryUpdateForProvider,
  normalizeConnectionModelDiscoveryResult,
  normalizeCreateCatalogConnectionInput,
  normalizeCreateCredentialProfileInput,
  normalizeRemoveCatalogConnectionInput,
  normalizeRemoveCredentialProfileInput,
  normalizeSetCredentialProfileEnabledInput,
  normalizeSetCredentialRoutingModeInput,
  normalizeSetDefaultConnectionTargetInput,
  normalizeUpdateCatalogConnectionInput,
  normalizeUpdateCredentialProfileInput,
  type ConnectionCatalogEntry,
  type ConnectionCatalogMutationResult,
  type ConnectionCatalogSnapshot,
  type ConnectionCredentialProfileEntry,
  type ConnectionCredentialRouting,
  type ConnectionModelDiscoveryResult,
  type ConnectionTarget,
  type ConnectionTestSummary,
  type ConnectionVersionBasis,
  type CreateCatalogConnectionInput,
  type CreateCredentialProfileInput,
  type CredentialProfileMutationResult,
  type CredentialProfileVersionBasis,
  type RemoveCatalogConnectionInput,
  type RemoveCredentialProfileInput,
  type SetCredentialProfileEnabledInput,
  type SetCredentialRoutingModeInput,
  type SetDefaultConnectionTargetInput,
  type UpdateCatalogConnectionInput,
  type UpdateCredentialProfileInput,
} from '@maka/core/runtime-policy';
import {
  deriveConnectionSlug,
  PROVIDER_DEFAULTS,
  reconcileConnectionAfterModelFetch,
} from '@maka/core/llm-connections';
import { modelIdAliasesForProvider } from '@maka/core/model-metadata';
import { pruneRelayModelProfiles } from '@maka/core/model-thinking';
import { deepFreeze, nextRevision, record, revision, unique } from './codec.js';
import {
  codecError,
  decodeConnectionInput,
  decodePersistedDomain,
  RuntimePolicyStoreError,
} from './errors.js';
import {
  CATALOG_DOCUMENT_MAX_BYTES,
  readBoundedJsonDocument,
  serializeJsonDocument,
  writeJsonDocument,
} from './document-io.js';
import { connectionCredentialLocator, type ProviderAuthKind } from './operations.js';

const FILE = 'connection-catalog.json';
export const CONNECTION_CATALOG_SCHEMA_VERSION_V1 = 1 as const;
export const CONNECTION_CATALOG_SCHEMA_VERSION_V2 = 2 as const;
export type ConnectionCatalogSchemaVersion =
  | typeof CONNECTION_CATALOG_SCHEMA_VERSION_V1
  | typeof CONNECTION_CATALOG_SCHEMA_VERSION_V2;

/**
 * Lazy-migrated catalog document. v1 connections are interpreted as implicit
 * primary (no `credentialRouting`); the document is only persisted as v2 once
 * the first Profile-related mutation touches it. Non-Profile mutations keep
 * the current schema version so v1-only installations can downgrade.
 */
export interface ConnectionCatalogDocument {
  readonly schemaVersion: ConnectionCatalogSchemaVersion;
  readonly revision: number;
  readonly defaultTarget: ConnectionTarget | null;
  readonly connections: readonly ConnectionCatalogEntry[];
}

export interface ConnectionTestModelBasis {
  readonly enabledModelIds: readonly string[];
  readonly modelSource: ConnectionCatalogEntry['modelSource'];
  readonly models: readonly {
    readonly id: string;
    readonly apiProtocol: ConnectionCatalogEntry['models'][number]['apiProtocol'];
  }[];
}

interface PreparedOnboardingResult {
  readonly kind: 'ready';
  readonly document: ConnectionCatalogDocument;
  readonly changed: boolean;
}

export class ConnectionCatalogDocumentOwner {
  async read(root: string): Promise<ConnectionCatalogDocument> {
    const value = await readBoundedJsonDocument(root, FILE, CATALOG_DOCUMENT_MAX_BYTES);
    if (value === undefined) {
      return {
        schemaVersion: CONNECTION_CATALOG_SCHEMA_VERSION_V1,
        revision: 0,
        defaultTarget: null,
        connections: [],
      };
    }
    const raw = record(value, FILE, 'invalid_document', [
      'schemaVersion',
      'revision',
      'defaultTarget',
      'connections',
    ]);
    if (
      raw.schemaVersion !== CONNECTION_CATALOG_SCHEMA_VERSION_V1 &&
      raw.schemaVersion !== CONNECTION_CATALOG_SCHEMA_VERSION_V2
    ) {
      throw codecError('invalid_document', `${FILE} has an unsupported schema version`);
    }
    if (
      !Array.isArray(raw.connections) ||
      raw.connections.length > CONNECTION_CATALOG_MAX_CONNECTIONS
    ) {
      throw codecError('invalid_document', `${FILE}.connections must be a bounded array`);
    }
    const connections = raw.connections.map((item) =>
      decodePersistedDomain(() => decodeCanonicalConnectionCatalogEntry(item)),
    );
    unique(
      connections.map((item) => item.slug),
      `${FILE} connection slugs`,
      'invalid_document',
    );
    unique(
      connections.map((item) => item.connectionId),
      `${FILE} connection ids`,
      'invalid_document',
    );
    if (raw.schemaVersion === CONNECTION_CATALOG_SCHEMA_VERSION_V2) {
      for (const connection of connections) {
        assertCanonicalCredentialRouting(connection, `${FILE} connection`);
      }
    }
    const defaultTarget =
      raw.defaultTarget === null
        ? null
        : decodePersistedDomain(() => decodeConnectionTarget(raw.defaultTarget));
    if (defaultTarget && !isValidTarget(defaultTarget, connections)) {
      throw codecError('invalid_document', `${FILE} contains an invalid default target`);
    }
    return {
      schemaVersion: raw.schemaVersion,
      revision: revision(raw.revision, `${FILE}.revision`, 'invalid_document'),
      defaultTarget,
      connections,
    };
  }

  async create(
    root: string,
    rawInput: CreateCatalogConnectionInput,
  ): Promise<ConnectionCatalogMutationResult> {
    const input = decodeConnectionInput(() => normalizeCreateCatalogConnectionInput(rawInput));
    const current = await this.read(root);
    if (current.revision !== input.expectedCatalogRevision) {
      return revisionConflict(input.expectedCatalogRevision, current.revision);
    }
    if (current.connections.some((item) => item.slug === input.connection.slug)) {
      return deepFreeze({ kind: 'connection_exists', slug: input.connection.slug });
    }
    if (current.connections.length >= CONNECTION_CATALOG_MAX_CONNECTIONS) {
      throw codecError(
        'invalid_connection_input',
        `Connection catalog cannot exceed ${CONNECTION_CATALOG_MAX_CONNECTIONS} entries`,
      );
    }
    const fallbackModels = fallbackInventory(input.connection.providerType);
    const next: ConnectionCatalogDocument = {
      ...current,
      revision: nextRevision(current.revision),
      connections: [
        ...current.connections,
        {
          ...input.connection,
          connectionId: randomUUID(),
          revision: 1,
          models: fallbackModels,
          ...(fallbackModels.length > 0
            ? { modelSource: 'fallback' as const, modelsFetchedAt: 0 }
            : {}),
        },
      ],
    };
    await this.write(root, next);
    return committed(next);
  }

  async update(
    root: string,
    rawInput: UpdateCatalogConnectionInput,
  ): Promise<ConnectionCatalogMutationResult> {
    const input = decodeConnectionInput(() => normalizeUpdateCatalogConnectionInput(rawInput));
    const current = await this.read(root);
    const index = findConnectionIndex(current, input.expected);
    const previous = index < 0 ? undefined : current.connections[index];
    if (!previous || previous.revision !== input.expected.revision) {
      return connectionStale(input.expected, previous ? connectionBasis(previous) : null);
    }
    const changes = decodeConnectionInput(() =>
      normalizeConnectionCatalogEntryUpdateForProvider(input.changes, previous.providerType),
    );
    const endpointChanged = previous.baseUrl !== changes.baseUrl;
    const testBasisChanged =
      endpointChanged ||
      previous.enabled !== changes.enabled ||
      !sameStringArray(previous.enabledModelIds, changes.enabledModelIds) ||
      (changes.requestBodyOverlay !== undefined &&
        !isDeepStrictEqual(previous.requestBodyOverlay, changes.requestBodyOverlay ?? undefined));
    const connections = [...current.connections];
    connections[index] = {
      connectionId: previous.connectionId,
      revision: nextRevision(previous.revision),
      slug: previous.slug,
      name: changes.name,
      providerType: previous.providerType,
      ...(changes.baseUrl === undefined ? {} : { baseUrl: changes.baseUrl }),
      enabled: changes.enabled,
      enabledModelIds: changes.enabledModelIds,
      // Profile-table semantics, in order:
      //  - the store invariant: profiles exist only for enabled models, so a
      //    selection change prunes whatever no longer qualifies (disabling a
      //    model deletes its profile);
      //  - a table replaces wholesale — it wins even over an endpoint change
      //    in the same update, because a writer submitting a new endpoint and
      //    a new table declares that the table belongs to the new endpoint
      //    (config import does exactly this);
      //  - null clears;
      //  - absent leaves the stored table alone, except that an endpoint
      //    change retires it: declarations are endpoint-keyed like the model
      //    inventory, and the old table must not outlive the relay it
      //    described.
      ...(changes.relayModelProfiles === undefined
        ? endpointChanged || previous.relayModelProfiles === undefined
          ? {}
          : {
              relayModelProfiles: pruneRelayModelProfiles(
                previous.relayModelProfiles,
                changes.enabledModelIds,
              ),
            }
        : changes.relayModelProfiles === null
          ? {}
          : { relayModelProfiles: changes.relayModelProfiles }),
      ...(changes.requestBodyOverlay === undefined
        ? previous.requestBodyOverlay === undefined
          ? {}
          : { requestBodyOverlay: previous.requestBodyOverlay }
        : changes.requestBodyOverlay === null
          ? {}
          : { requestBodyOverlay: changes.requestBodyOverlay }),
      models: endpointChanged ? [] : previous.models,
      ...(endpointChanged || previous.modelSource === undefined
        ? {}
        : { modelSource: previous.modelSource }),
      ...(endpointChanged || previous.modelsFetchedAt === undefined
        ? {}
        : { modelsFetchedAt: previous.modelsFetchedAt }),
      ...(testBasisChanged || previous.lastTest === undefined
        ? {}
        : { lastTest: previous.lastTest }),
    };
    if (current.defaultTarget && !isValidTarget(current.defaultTarget, connections)) {
      return deepFreeze({ kind: 'invalid_default_target', target: current.defaultTarget });
    }
    const next = { ...current, revision: nextRevision(current.revision), connections };
    await this.write(root, next);
    return committed(next);
  }

  async remove(
    root: string,
    rawInput: RemoveCatalogConnectionInput,
  ): Promise<ConnectionCatalogMutationResult> {
    const input = decodeConnectionInput(() => normalizeRemoveCatalogConnectionInput(rawInput));
    const current = await this.read(root);
    const index = findConnectionIndex(current, input.expected);
    const previous = index < 0 ? undefined : current.connections[index];
    if (!previous || previous.revision !== input.expected.revision) {
      return connectionStale(input.expected, previous ? connectionBasis(previous) : null);
    }
    const next: ConnectionCatalogDocument = {
      ...current,
      revision: nextRevision(current.revision),
      defaultTarget:
        current.defaultTarget && sameConnectionIdentity(current.defaultTarget, previous)
          ? null
          : current.defaultTarget,
      connections: current.connections.filter((_item, candidate) => candidate !== index),
    };
    await this.write(root, next);
    return committed(next);
  }

  async setDefaultTarget(
    root: string,
    rawInput: SetDefaultConnectionTargetInput,
  ): Promise<ConnectionCatalogMutationResult> {
    const input = decodeConnectionInput(() => normalizeSetDefaultConnectionTargetInput(rawInput));
    const current = await this.read(root);
    if (current.revision !== input.expectedCatalogRevision) {
      return revisionConflict(input.expectedCatalogRevision, current.revision);
    }
    if (input.target && !isValidTarget(input.target, current.connections)) {
      return deepFreeze({ kind: 'invalid_default_target', target: input.target });
    }
    const next = {
      ...current,
      revision: nextRevision(current.revision),
      defaultTarget: input.target,
    };
    await this.write(root, next);
    return committed(next);
  }

  /**
   * Create a secondary Credential Profile under a Connection. Fail-closed:
   * the new Profile is always created with `enabled=false`, and the routing
   * mode stays `legacy_primary` until the user explicitly activates
   * `balanced`. Creating the first Profile materializes the implicit primary
   * (`profileId === connectionId`, revision 1, enabled, weight 1).
   */
  async createCredentialProfile(
    root: string,
    rawInput: CreateCredentialProfileInput,
  ): Promise<CredentialProfileMutationResult> {
    const input = decodeConnectionInput(() => normalizeCreateCredentialProfileInput(rawInput));
    const current = await this.read(root);
    const index = findConnectionIndex(current, input.expected);
    const previous = index < 0 ? undefined : current.connections[index];
    if (!previous || previous.revision !== input.expected.revision) {
      return connectionStale(input.expected, previous ? connectionBasis(previous) : null);
    }
    const authKind = PROVIDER_DEFAULTS[previous.providerType].authKind;
    if (!profileCapableAuthKind(authKind)) {
      return deepFreeze({
        kind: 'auth_not_supported' as const,
        providerType: previous.providerType,
      });
    }
    const routing = previous.credentialRouting ?? implicitPrimaryRouting(previous.connectionId);
    if (routing.profiles.length >= CONNECTION_CREDENTIAL_PROFILE_MAX) {
      return deepFreeze({
        kind: 'capacity_limit' as const,
        max: CONNECTION_CREDENTIAL_PROFILE_MAX,
      });
    }
    if (profileLabelTaken(routing, input.label, null)) {
      return deepFreeze({ kind: 'profile_label_conflict' as const, label: input.label });
    }
    const profile: ConnectionCredentialProfileEntry = {
      profileId: randomUUID(),
      revision: 1,
      label: input.label,
      enabled: false,
      weight: input.weight,
    };
    const nextRouting: ConnectionCredentialRouting = {
      mode: 'legacy_primary',
      strategy: 'smooth_weighted_round_robin',
      profiles: [...routing.profiles, profile],
    };
    const connections = [...current.connections];
    connections[index] = {
      ...previous,
      revision: nextRevision(previous.revision),
      credentialRouting: nextRouting,
    };
    const next = {
      ...current,
      schemaVersion: CONNECTION_CATALOG_SCHEMA_VERSION_V2,
      revision: nextRevision(current.revision),
      connections,
    };
    assertDocumentCredentialRoutingInvariants(next, FILE);
    await this.write(root, next);
    return committedProfile(next);
  }

  async updateCredentialProfile(
    root: string,
    rawInput: UpdateCredentialProfileInput,
  ): Promise<CredentialProfileMutationResult> {
    const input = decodeConnectionInput(() => normalizeUpdateCredentialProfileInput(rawInput));
    const current = await this.read(root);
    const connection = findConnection(current, input.expected);
    if (!connection || connection.revision !== input.expected.connectionRevision) {
      return connectionStale(
        { connectionId: input.expected.connectionId, revision: input.expected.connectionRevision },
        connection ? connectionBasis(connection) : null,
      );
    }
    const routing = connection.credentialRouting;
    if (!routing) {
      return profileNotFound(input.expected);
    }
    const profileIndex = routing.profiles.findIndex(
      (profile) => profile.profileId === input.expected.profileId,
    );
    const previousProfile = routing.profiles[profileIndex];
    if (!previousProfile) {
      return profileNotFound(input.expected);
    }
    if (previousProfile.revision !== input.expected.profileRevision) {
      return deepFreeze({
        kind: 'profile_stale' as const,
        expected: input.expected,
        actual: {
          connectionId: connection.connectionId,
          connectionRevision: connection.revision,
          profileId: previousProfile.profileId,
          profileRevision: previousProfile.revision,
        },
      });
    }
    if (
      input.label !== undefined &&
      profileLabelTaken(routing, input.label, previousProfile.profileId)
    ) {
      return deepFreeze({ kind: 'profile_label_conflict' as const, label: input.label });
    }
    const profiles = [...routing.profiles];
    profiles[profileIndex] = {
      ...previousProfile,
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.weight === undefined ? {} : { weight: input.weight }),
      revision: nextRevision(previousProfile.revision),
    };
    const connections = [...current.connections];
    const index = findConnectionIndex(current, connection);
    connections[index] = {
      ...connection,
      revision: nextRevision(connection.revision),
      credentialRouting: { ...routing, profiles },
    };
    const next = {
      ...current,
      schemaVersion: CONNECTION_CATALOG_SCHEMA_VERSION_V2,
      revision: nextRevision(current.revision),
      connections,
    };
    assertDocumentCredentialRoutingInvariants(next, FILE);
    await this.write(root, next);
    return committedProfile(next);
  }

  async setCredentialProfileEnabled(
    root: string,
    rawInput: SetCredentialProfileEnabledInput,
  ): Promise<CredentialProfileMutationResult> {
    const input = decodeConnectionInput(() => normalizeSetCredentialProfileEnabledInput(rawInput));
    const current = await this.read(root);
    const connection = findConnection(current, input.expected);
    if (!connection || connection.revision !== input.expected.connectionRevision) {
      return connectionStale(
        { connectionId: input.expected.connectionId, revision: input.expected.connectionRevision },
        connection ? connectionBasis(connection) : null,
      );
    }
    const routing = connection.credentialRouting;
    if (!routing) {
      return profileNotFound(input.expected);
    }
    const profileIndex = routing.profiles.findIndex(
      (profile) => profile.profileId === input.expected.profileId,
    );
    const previousProfile = routing.profiles[profileIndex];
    if (!previousProfile) {
      return profileNotFound(input.expected);
    }
    if (previousProfile.revision !== input.expected.profileRevision) {
      return deepFreeze({
        kind: 'profile_stale' as const,
        expected: input.expected,
        actual: {
          connectionId: connection.connectionId,
          connectionRevision: connection.revision,
          profileId: previousProfile.profileId,
          profileRevision: previousProfile.revision,
        },
      });
    }
    if (previousProfile.enabled === input.enabled) {
      return committedProfile(current);
    }
    const profiles = [...routing.profiles];
    profiles[profileIndex] = {
      ...previousProfile,
      enabled: input.enabled,
      revision: nextRevision(previousProfile.revision),
    };
    const connections = [...current.connections];
    const index = findConnectionIndex(current, connection);
    connections[index] = {
      ...connection,
      revision: nextRevision(connection.revision),
      credentialRouting: { ...routing, profiles },
    };
    const next = {
      ...current,
      schemaVersion: CONNECTION_CATALOG_SCHEMA_VERSION_V2,
      revision: nextRevision(current.revision),
      connections,
    };
    assertDocumentCredentialRoutingInvariants(next, FILE);
    await this.write(root, next);
    return committedProfile(next);
  }

  /**
   * Remove a secondary Profile. The primary Profile's reserved identity is
   * never removable. If the connection still has a `credentialRouting`, the
   * routing mode is preserved: availability constraints must not silently
   * rewrite the mode back to `legacy_primary`.
   */
  async removeCredentialProfile(
    root: string,
    rawInput: RemoveCredentialProfileInput,
  ): Promise<CredentialProfileMutationResult> {
    const input = decodeConnectionInput(() => normalizeRemoveCredentialProfileInput(rawInput));
    const current = await this.read(root);
    const connection = findConnection(current, input.expected);
    if (!connection || connection.revision !== input.expected.connectionRevision) {
      return connectionStale(
        { connectionId: input.expected.connectionId, revision: input.expected.connectionRevision },
        connection ? connectionBasis(connection) : null,
      );
    }
    const routing = connection.credentialRouting;
    if (!routing) {
      return profileNotFound(input.expected);
    }
    if (input.expected.profileId === connection.connectionId) {
      return deepFreeze({ kind: 'primary_not_removable' as const });
    }
    const profileIndex = routing.profiles.findIndex(
      (profile) => profile.profileId === input.expected.profileId,
    );
    const previousProfile = routing.profiles[profileIndex];
    if (!previousProfile) {
      return profileNotFound(input.expected);
    }
    if (previousProfile.revision !== input.expected.profileRevision) {
      return deepFreeze({
        kind: 'profile_stale' as const,
        expected: input.expected,
        actual: {
          connectionId: connection.connectionId,
          connectionRevision: connection.revision,
          profileId: previousProfile.profileId,
          profileRevision: previousProfile.revision,
        },
      });
    }
    const connections = [...current.connections];
    const index = findConnectionIndex(current, connection);
    connections[index] = {
      ...connection,
      revision: nextRevision(connection.revision),
      credentialRouting: {
        ...routing,
        profiles: routing.profiles.filter(
          (profile) => profile.profileId !== input.expected.profileId,
        ),
      },
    };
    const next = {
      ...current,
      schemaVersion: CONNECTION_CATALOG_SCHEMA_VERSION_V2,
      revision: nextRevision(current.revision),
      connections,
    };
    assertDocumentCredentialRoutingInvariants(next, FILE);
    await this.write(root, next);
    return committedProfile(next);
  }

  /**
   * Materialize the implicit primary Profile into an explicit routing
   * declaration (RFC 4.2/5.1). Idempotent: a connection that already declares
   * `credentialRouting` is returned unchanged. This is the formal authority
   * entry point for imports that carry an explicit routing with only the
   * primary left — creating a secondary must never be the only way to
   * materialize the primary's enable state.
   */
  async materializePrimaryRouting(
    root: string,
    connectionId: string,
  ): Promise<CredentialProfileMutationResult> {
    const current = await this.read(root);
    const connection = findConnection(current, { connectionId });
    if (!connection) {
      // Materialization carries no expected revision: a missing connection is
      // a normal domain result, not a stale basis.
      return deepFreeze({ kind: 'connection_not_found' as const });
    }
    if (connection.credentialRouting) {
      return committedProfile(current);
    }
    const authKind = PROVIDER_DEFAULTS[connection.providerType].authKind;
    if (!profileCapableAuthKind(authKind)) {
      return deepFreeze({
        kind: 'auth_not_supported' as const,
        providerType: connection.providerType,
      });
    }
    const index = findConnectionIndex(current, connection);
    const connections = [...current.connections];
    connections[index] = {
      ...connection,
      revision: nextRevision(connection.revision),
      credentialRouting: implicitPrimaryRouting(connection.connectionId),
    };
    const next = {
      ...current,
      schemaVersion: CONNECTION_CATALOG_SCHEMA_VERSION_V2,
      revision: nextRevision(current.revision),
      connections,
    };
    assertDocumentCredentialRoutingInvariants(next, FILE);
    await this.write(root, next);
    return committedProfile(next);
  }

  /**
   * Switch the routing mode. `legacy_primary` is a plain CAS write and can
   * never be blocked by transient health. `balanced` requires the structural
   * preconditions that the catalog can verify on its own; the credential and
   * verification preconditions are enforced by the coordinator (which
   * combines Catalog, Vault and, once available, the Verification Store).
   */
  async setCredentialRoutingMode(
    root: string,
    rawInput: SetCredentialRoutingModeInput,
  ): Promise<CredentialProfileMutationResult> {
    const input = decodeConnectionInput(() => normalizeSetCredentialRoutingModeInput(rawInput));
    const current = await this.read(root);
    const index = findConnectionIndex(current, input.expected);
    const previous = index < 0 ? undefined : current.connections[index];
    if (!previous || previous.revision !== input.expected.revision) {
      return connectionStale(input.expected, previous ? connectionBasis(previous) : null);
    }
    if (input.mode === 'balanced') {
      const routing = previous.credentialRouting;
      if (!routing || routing.profiles.length < 2) {
        return deepFreeze({
          kind: 'balanced_activation_rejected' as const,
          reason: 'balanced routing requires at least two configured profiles',
        });
      }
      if (routing.profiles.filter((profile) => profile.enabled).length < 2) {
        return deepFreeze({
          kind: 'balanced_activation_rejected' as const,
          reason: 'balanced routing requires at least two enabled profiles',
        });
      }
    }
    const connections = [...current.connections];
    const routing = previous.credentialRouting;
    connections[index] = {
      ...previous,
      revision: nextRevision(previous.revision),
      ...(routing ? { credentialRouting: { ...routing, mode: input.mode } } : {}),
    };
    const next = {
      ...current,
      schemaVersion: CONNECTION_CATALOG_SCHEMA_VERSION_V2,
      revision: nextRevision(current.revision),
      connections,
    };
    assertDocumentCredentialRoutingInvariants(next, FILE);
    await this.write(root, next);
    return committedProfile(next);
  }

  async writeModelFetchResult(
    root: string,
    current: ConnectionCatalogDocument,
    expected: ConnectionVersionBasis,
    rawResult: ConnectionModelDiscoveryResult,
  ): Promise<ConnectionCatalogSnapshot> {
    const result = decodeConnectionInput(() => normalizeConnectionModelDiscoveryResult(rawResult));
    if (result.models.length === 0) {
      throw codecError('invalid_connection_input', 'Model discovery result must not be empty');
    }
    const index = findConnectionIndex(current, expected);
    const previous = current.connections[index];
    if (!previous || previous.revision !== expected.revision) {
      throw codecError('invalid_document', 'Coordinator admitted a stale model discovery result');
    }
    const currentDefaultTarget =
      current.defaultTarget?.connectionId === previous.connectionId
        ? current.defaultTarget
        : undefined;
    const reconciled =
      result.source === 'fetched'
        ? reconcileConnectionAfterModelFetch(
            {
              defaultModel: currentDefaultTarget?.modelId ?? previous.enabledModelIds[0],
              enabledModelIds: previous.enabledModelIds,
              // An entry always carries a `models` array, so "has an inventory"
              // has to be read off its contents: empty means this connection has
              // never had a list to pick from and discovery may seed one. A
              // non-empty one means an empty selection is the user's answer.
              hasModelInventory: previous.models.length > 0,
            },
            result.models,
            { aliases: modelIdAliasesForProvider(previous.providerType) },
          )
        : {
            defaultModel: currentDefaultTarget?.modelId ?? previous.enabledModelIds[0] ?? '',
            enabledModelIds: previous.enabledModelIds,
          };
    const defaultTarget = currentDefaultTarget
      ? { connectionId: previous.connectionId, modelId: reconciled.defaultModel }
      : current.defaultTarget;
    // A refresh is a new enabledModelIds authority on the same endpoint:
    // profiles keyed by a model the refresh dropped would violate the
    // subset invariant, and this write path bypasses the canonical decoder,
    // so prune here or the persisted document is un-loadable on next read.
    const relayModelProfiles = pruneRelayModelProfiles(
      previous.relayModelProfiles,
      reconciled.enabledModelIds,
    );
    const { relayModelProfiles: _staleProfiles, ...previousWithoutProfiles } = previous;
    const discovered: ConnectionCatalogEntry = {
      ...previousWithoutProfiles,
      ...(relayModelProfiles ? { relayModelProfiles } : {}),
      revision: nextRevision(previous.revision),
      enabledModelIds: reconciled.enabledModelIds,
      models: result.models,
      modelSource: result.source,
      modelsFetchedAt: result.fetchedAt,
    };
    const testBasisChanged = !sameConnectionTestModelBasis(
      connectionTestModelBasis(previous),
      connectionTestModelBasis(discovered),
    );
    const { lastTest: _lastTest, ...discoveredWithoutLastTest } = discovered;
    return this.writePatchedResult(
      root,
      current,
      index,
      testBasisChanged ? discoveredWithoutLastTest : discovered,
      defaultTarget,
    );
  }

  /**
   * Profile discovery metadata merge (RFC 11.2/13.2). Appends model metadata
   * the Profile discovered that the Connection inventory has not seen yet.
   * Never deletes inventory entries, never changes `enabledModelIds` or the
   * model source — the endpoint inventory authority stays with Connection-level
   * discovery, so a single Profile's missing models can never drive a deletion.
   */
  async mergeConnectionProfileDiscoveryMetadata(
    root: string,
    current: ConnectionCatalogDocument,
    expected: ConnectionVersionBasis,
    rawResult: ConnectionModelDiscoveryResult,
  ): Promise<ConnectionCatalogSnapshot> {
    const result = decodeConnectionInput(() => normalizeConnectionModelDiscoveryResult(rawResult));
    if (result.models.length === 0) {
      throw codecError('invalid_connection_input', 'Profile model discovery result must not be empty');
    }
    const index = findConnectionIndex(current, expected);
    const previous = current.connections[index];
    if (!previous || previous.revision !== expected.revision) {
      throw codecError('invalid_document', 'Coordinator admitted a stale profile model discovery result');
    }
    const known = new Set(previous.models.map((model) => model.id));
    const merged = [...previous.models];
    for (const model of result.models) {
      if (known.has(model.id)) continue;
      if (merged.length >= CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION) break;
      merged.push(model);
      known.add(model.id);
    }
    if (merged.length === previous.models.length) return catalogSnapshot(current);
    const discovered: ConnectionCatalogEntry = {
      ...previous,
      revision: nextRevision(previous.revision),
      models: merged,
      // A Profile discovery can seed a previously empty inventory: without a
      // source the persisted document would violate the canonical invariant.
      ...(previous.modelSource === undefined
        ? { modelSource: result.source, modelsFetchedAt: result.fetchedAt }
        : {}),
    };
    const testBasisChanged = !sameConnectionTestModelBasis(
      connectionTestModelBasis(previous),
      connectionTestModelBasis(discovered),
    );
    const { lastTest: _lastTest, ...discoveredWithoutLastTest } = discovered;
    return this.writePatchedResult(
      root,
      current,
      index,
      testBasisChanged ? discoveredWithoutLastTest : discovered,
    );
  }

  prepareOnboardingUpsert(
    current: ConnectionCatalogDocument,
    rawConnectionId: string,
    rawProviderType: unknown,
    rawEnabledModelIds: readonly string[],
    rawResult: ConnectionModelDiscoveryResult,
    invalidateLastTest: boolean,
  ): PreparedOnboardingResult | { readonly kind: 'slug_conflict' } {
    const connectionId = decodeConnectionInput(() => decodeRuntimePolicyEntityId(rawConnectionId));
    const providerType = decodeConnectionInput(() => decodeProviderType(rawProviderType));
    const definition = PROVIDER_DEFAULTS[providerType];
    const slug = deriveConnectionSlug(providerType);
    const index = current.connections.findIndex((connection) => connection.slug === slug);
    const previous = current.connections[index];
    if (previous && previous.providerType !== providerType) {
      return { kind: 'slug_conflict' };
    }
    if (previous && previous.connectionId !== connectionId) {
      throw codecError('invalid_document', 'Onboarding intent conflicts with the connection id');
    }
    if (!previous && current.connections.length >= CONNECTION_CATALOG_MAX_CONNECTIONS) {
      throw codecError(
        'invalid_connection_input',
        `Connection catalog cannot exceed ${CONNECTION_CATALOG_MAX_CONNECTIONS} entries`,
      );
    }
    const result = decodeConnectionInput(() => normalizeConnectionModelDiscoveryResult(rawResult));
    if (result.source !== 'fetched' || result.models.length === 0) {
      throw codecError(
        'invalid_connection_input',
        'Onboarding requires a non-empty fetched model inventory',
      );
    }
    const changes = decodeConnectionInput(() =>
      normalizeConnectionCatalogEntryUpdateForProvider(
        {
          name: previous?.name ?? definition.label,
          ...((previous?.baseUrl ?? definition.baseUrl)
            ? { baseUrl: previous?.baseUrl ?? definition.baseUrl }
            : {}),
          enabled: true,
          enabledModelIds: rawEnabledModelIds,
        },
        providerType,
      ),
    );
    const available = new Set(result.models.map(({ id }) => id));
    if (
      changes.enabledModelIds.length === 0 ||
      changes.enabledModelIds.some((modelId) => !available.has(modelId))
    ) {
      throw codecError(
        'invalid_connection_input',
        'Onboarding enabled models must come from the fetched inventory',
      );
    }
    const finalized: ConnectionCatalogEntry = {
      ...(previous ?? {
        connectionId,
        revision: 0,
        slug,
        name: definition.label,
        providerType,
        enabled: false,
        enabledModelIds: [],
        models: [],
      }),
      revision: previous ? nextRevision(previous.revision) : 1,
      enabled: true,
      enabledModelIds: changes.enabledModelIds,
      models: result.models,
      modelSource: result.source,
      modelsFetchedAt: result.fetchedAt,
    };
    const defaultTarget =
      current.defaultTarget === null
        ? { connectionId, modelId: changes.enabledModelIds[0]! }
        : current.defaultTarget.connectionId === connectionId &&
            !changes.enabledModelIds.includes(current.defaultTarget.modelId)
          ? { connectionId, modelId: changes.enabledModelIds[0]! }
          : current.defaultTarget;
    if (
      previous?.enabled &&
      sameStringArray(previous.enabledModelIds, changes.enabledModelIds) &&
      isDeepStrictEqual(previous.models, result.models) &&
      previous.modelSource === result.source &&
      previous.modelsFetchedAt === result.fetchedAt &&
      isDeepStrictEqual(current.defaultTarget, defaultTarget) &&
      (!invalidateLastTest || previous.lastTest === undefined)
    ) {
      return { kind: 'ready', document: current, changed: false };
    }
    const testBasisChanged = previous
      ? !sameConnectionTestModelBasis(
          connectionTestModelBasis(previous),
          connectionTestModelBasis(finalized),
        )
      : true;
    const { lastTest: _lastTest, ...finalizedWithoutLastTest } = finalized;
    const connections = [...current.connections];
    const entry = testBasisChanged || invalidateLastTest ? finalizedWithoutLastTest : finalized;
    if (previous) connections[index] = entry;
    else connections.push(entry);
    const next = {
      ...current,
      revision: nextRevision(current.revision),
      defaultTarget,
      connections,
    };
    this.assertDocumentSize(next);
    return { kind: 'ready', document: next, changed: true };
  }

  async commitPreparedOnboarding(
    root: string,
    prepared: PreparedOnboardingResult,
  ): Promise<ConnectionCatalogSnapshot> {
    if (prepared.changed) await this.write(root, prepared.document);
    return catalogSnapshot(prepared.document);
  }

  async writeConnectionTestResult(
    root: string,
    current: ConnectionCatalogDocument,
    expected: ConnectionVersionBasis,
    rawResult: ConnectionTestSummary,
  ): Promise<ConnectionCatalogSnapshot> {
    const result = decodeConnectionInput(() => decodeConnectionTestSummary(rawResult));
    const index = findConnectionIndex(current, expected);
    const previous = current.connections[index];
    if (!previous || previous.revision !== expected.revision) {
      throw codecError('invalid_document', 'Coordinator admitted a stale connection test result');
    }
    return this.writePatchedResult(root, current, index, {
      ...previous,
      revision: nextRevision(previous.revision),
      lastTest: result,
    });
  }

  async clearConnectionLastTest(
    root: string,
    current: ConnectionCatalogDocument,
    connectionId: string,
  ): Promise<boolean> {
    const index = findConnectionIndex(current, { connectionId });
    const previous = current.connections[index];
    if (!previous) {
      throw codecError('invalid_document', 'Coordinator admitted an unknown connection');
    }
    if (previous.lastTest === undefined) return false;
    const { lastTest: _lastTest, ...withoutLastTest } = previous;
    await this.writePatchedResult(root, current, index, {
      ...withoutLastTest,
      revision: nextRevision(previous.revision),
    });
    return true;
  }

  async clearAllConnectionLastTests(
    root: string,
    current: ConnectionCatalogDocument,
  ): Promise<boolean> {
    if (current.connections.every((connection) => connection.lastTest === undefined)) return false;
    const connections = current.connections.map((connection) => {
      if (connection.lastTest === undefined) return connection;
      const { lastTest: _lastTest, ...withoutLastTest } = connection;
      return {
        ...withoutLastTest,
        revision: nextRevision(connection.revision),
      };
    });
    await this.write(root, {
      ...current,
      revision: nextRevision(current.revision),
      connections,
    });
    return true;
  }

  private async writePatchedResult(
    root: string,
    current: ConnectionCatalogDocument,
    index: number,
    patched: ConnectionCatalogEntry,
    defaultTarget: ConnectionTarget | null = current.defaultTarget,
  ): Promise<ConnectionCatalogSnapshot> {
    const connections = [...current.connections];
    connections[index] = patched;
    if (defaultTarget && !isValidTarget(defaultTarget, connections)) {
      throw codecError('invalid_document', 'Connection effect produced an invalid default target');
    }
    const next = {
      ...current,
      revision: nextRevision(current.revision),
      defaultTarget,
      connections,
    };
    await this.write(root, next);
    return catalogSnapshot(next);
  }

  private async write(root: string, document: ConnectionCatalogDocument): Promise<void> {
    this.assertDocumentSize(document);
    await writeJsonDocument(root, FILE, document, CATALOG_DOCUMENT_MAX_BYTES);
  }

  private assertDocumentSize(document: ConnectionCatalogDocument): void {
    if (serializeJsonDocument(document).length > CATALOG_DOCUMENT_MAX_BYTES) {
      throw new RuntimePolicyStoreError(
        'invalid_connection_input',
        `connection catalog exceeds its ${CATALOG_DOCUMENT_MAX_BYTES} byte limit`,
      );
    }
  }
}

function fallbackInventory(
  providerType: ConnectionCatalogEntry['providerType'],
): ConnectionCatalogEntry['models'] {
  const provider = PROVIDER_DEFAULTS[providerType];
  return provider.modelDiscovery.kind === 'fallback'
    ? provider.fallbackModels.map((id) => ({ id }))
    : [];
}

export function catalogSnapshot(document: ConnectionCatalogDocument): ConnectionCatalogSnapshot {
  return deepFreeze({
    revision: document.revision,
    defaultTarget: structuredClone(document.defaultTarget),
    connections: structuredClone(document.connections),
  });
}

export function connectionBasis(connection: ConnectionCatalogEntry): ConnectionVersionBasis {
  return {
    connectionId: connection.connectionId,
    revision: connection.revision,
  };
}

export function findConnection(
  document: ConnectionCatalogDocument,
  identity: Pick<ConnectionVersionBasis, 'connectionId'>,
): ConnectionCatalogEntry | undefined {
  return document.connections.find((item) => sameConnectionIdentity(item, identity));
}

export function connectionTestModelBasis(
  connection: ConnectionCatalogEntry,
): ConnectionTestModelBasis {
  return {
    enabledModelIds: [...connection.enabledModelIds],
    modelSource: connection.modelSource,
    models: connection.models.map((model) => ({
      id: model.id,
      apiProtocol: model.apiProtocol,
    })),
  };
}

export function sameConnectionTestModelBasis(
  actual: ConnectionTestModelBasis,
  expected: ConnectionTestModelBasis,
): boolean {
  return (
    sameStringArray(actual.enabledModelIds, expected.enabledModelIds) &&
    actual.modelSource === expected.modelSource &&
    actual.models.length === expected.models.length &&
    actual.models.every(
      (model, index) =>
        model.id === expected.models[index]?.id &&
        model.apiProtocol === expected.models[index]?.apiProtocol,
    )
  );
}

function findConnectionIndex(
  document: ConnectionCatalogDocument,
  identity: Pick<ConnectionVersionBasis, 'connectionId'>,
): number {
  return document.connections.findIndex((item) => sameConnectionIdentity(item, identity));
}

function sameConnectionIdentity(
  left: Pick<ConnectionVersionBasis, 'connectionId'>,
  right: Pick<ConnectionVersionBasis, 'connectionId'>,
): boolean {
  return left.connectionId === right.connectionId;
}

function isValidTarget(
  target: ConnectionTarget,
  connections: readonly ConnectionCatalogEntry[],
): boolean {
  const connection = connections.find((item) => sameConnectionIdentity(item, target));
  return Boolean(connection?.enabled && connection.enabledModelIds.includes(target.modelId));
}

function sameStringArray(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function revisionConflict(expectedRevision: number, actualRevision: number) {
  return deepFreeze({ kind: 'revision_conflict' as const, expectedRevision, actualRevision });
}

function connectionStale(expected: ConnectionVersionBasis, actual: ConnectionVersionBasis | null) {
  return deepFreeze({ kind: 'connection_stale' as const, expected, actual });
}

function committed(document: ConnectionCatalogDocument): ConnectionCatalogMutationResult {
  return deepFreeze({ kind: 'committed', snapshot: catalogSnapshot(document) });
}

function committedProfile(document: ConnectionCatalogDocument): CredentialProfileMutationResult {
  return deepFreeze({ kind: 'committed', snapshot: catalogSnapshot(document) });
}

/**
 * The implicit primary Profile: `profileId === connectionId`, revision 1,
 * enabled, weight 1, per RFC section 4.2.
 */
function implicitPrimaryRouting(connectionId: string): ConnectionCredentialRouting {
  return {
    mode: 'legacy_primary',
    strategy: 'smooth_weighted_round_robin',
    profiles: [
      {
        profileId: connectionId,
        revision: 1,
        label: 'primary',
        enabled: true,
        weight: 1,
      },
    ],
  };
}

function profileCapableAuthKind(authKind: ProviderAuthKind): boolean {
  return authKind === 'api_key' || authKind === 'optional_api_key' || authKind === 'oauth_token';
}

/**
 * Case-insensitive label uniqueness within a Connection, excluding the profile
 * being updated (`excludeProfileId`).
 */
function profileLabelTaken(
  routing: ConnectionCredentialRouting,
  label: string,
  excludeProfileId: string | null,
): boolean {
  const normalized = label.toLowerCase();
  return routing.profiles.some(
    (profile) =>
      profile.profileId !== excludeProfileId && profile.label.toLowerCase() === normalized,
  );
}

function profileNotFound(expected: CredentialProfileVersionBasis): CredentialProfileMutationResult {
  return deepFreeze({ kind: 'profile_not_found' as const, expected });
}

/**
 * Structural invariants for a document that carries `credentialRouting`:
 * the primary Profile identity is reserved, profile ids and labels are
 * unique, and the primary profile is always present.
 */
function assertCanonicalCredentialRouting(
  connection: ConnectionCatalogEntry,
  context: string,
): void {
  const routing = connection.credentialRouting;
  if (!routing) return;
  if (!routing.profiles.some((profile) => profile.profileId === connection.connectionId)) {
    throw codecError(
      'invalid_document',
      `${context} credential routing must keep the primary profile identity`,
    );
  }
  const ids = routing.profiles.map((profile) => profile.profileId);
  if (new Set(ids).size !== ids.length) {
    throw codecError(
      'invalid_document',
      `${context} credential routing profile ids must be unique`,
    );
  }
  const labels = routing.profiles.map((profile) => profile.label.toLowerCase());
  if (new Set(labels).size !== labels.length) {
    throw codecError(
      'invalid_document',
      `${context} credential routing profile labels must be unique`,
    );
  }
}

function assertDocumentCredentialRoutingInvariants(
  document: ConnectionCatalogDocument,
  context: string,
): void {
  for (const connection of document.connections) {
    assertCanonicalCredentialRouting(connection, context);
  }
}
