import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  CONNECTION_CATALOG_MAX_CONNECTIONS,
  decodeCanonicalConnectionCatalogEntry,
  decodeConnectionSlug,
  decodeConnectionTarget,
  decodeConnectionTestSummary,
  decodeConnectionVersionBasis,
  decodeProviderType,
  decodeRuntimePolicyEntityId,
  normalizeConnectionCatalogEntryUpdateForProvider,
  normalizeConnectionModelDiscoveryResult,
  normalizeCreateCatalogConnectionInput,
  normalizeRemoveCatalogConnectionInput,
  normalizeSetDefaultConnectionTargetInput,
  normalizeUpdateCatalogConnectionInput,
  type ConnectionCatalogEntry,
  type ConnectionCatalogMutationResult,
  type ConnectionCatalogSnapshot,
  type ConnectionModelDiscoveryResult,
  type ConnectionTarget,
  type ConnectionTestSummary,
  type ConnectionVersionBasis,
  type CreateCatalogConnectionInput,
  type RemoveCatalogConnectionInput,
  type SetDefaultConnectionTargetInput,
  type UpdateCatalogConnectionInput,
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

const FILE = 'connection-catalog.json';
const SCHEMA_VERSION = 1 as const;

export interface ConnectionCatalogDocument {
  readonly schemaVersion: typeof SCHEMA_VERSION;
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
      return { schemaVersion: SCHEMA_VERSION, revision: 0, defaultTarget: null, connections: [] };
    }
    const raw = record(value, FILE, 'invalid_document', [
      'schemaVersion',
      'revision',
      'defaultTarget',
      'connections',
    ]);
    if (raw.schemaVersion !== SCHEMA_VERSION) {
      throw codecError('invalid_document', `${FILE} has an unsupported schema version`);
    }
    if (
      !Array.isArray(raw.connections) ||
      raw.connections.length > CONNECTION_CATALOG_MAX_CONNECTIONS
    ) {
      throw codecError('invalid_document', `${FILE}.connections must be a bounded array`);
    }
    // Releases before #3054 could persist the non-executable Gemini account
    // preview. Keep the raw file recoverable on read, but omit retired entries
    // from the active catalog; the next catalog mutation writes the canonical
    // supported set and completes the migration.
    const retiredConnections: Array<{
      readonly connectionId: ConnectionCatalogEntry['connectionId'];
      readonly slug: ConnectionCatalogEntry['slug'];
    }> = [];
    const maintainedConnections = raw.connections.filter((item) => {
      if (!isRetiredGeminiCliConnection(item)) return true;
      retiredConnections.push({
        connectionId: decodePersistedDomain(() => decodeRuntimePolicyEntityId(item.connectionId)),
        slug: decodePersistedDomain(() => decodeConnectionSlug(item.slug)),
      });
      return false;
    });
    const connections = maintainedConnections.map((item) =>
      decodePersistedDomain(() => decodeCanonicalConnectionCatalogEntry(item)),
    );
    const catalogIdentities = [...retiredConnections, ...connections];
    unique(
      catalogIdentities.map((item) => item.slug),
      `${FILE} connection slugs`,
      'invalid_document',
    );
    unique(
      catalogIdentities.map((item) => item.connectionId),
      `${FILE} connection ids`,
      'invalid_document',
    );
    const retiredConnectionIds = new Set(retiredConnections.map((item) => item.connectionId));
    const decodedDefaultTarget =
      raw.defaultTarget === null
        ? null
        : decodePersistedDomain(() => decodeConnectionTarget(raw.defaultTarget));
    const defaultTarget =
      decodedDefaultTarget && retiredConnectionIds.has(decodedDefaultTarget.connectionId)
        ? null
        : decodedDefaultTarget;
    if (defaultTarget && !isValidTarget(defaultTarget, connections)) {
      throw codecError('invalid_document', `${FILE} contains an invalid default target`);
    }
    return {
      schemaVersion: SCHEMA_VERSION,
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
    const next = this.nextDocument(current, [
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
    ]);
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
    const next = this.nextDocument(current, connections);
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
    const next = this.nextDocument(
      current,
      current.connections.filter((_item, candidate) => candidate !== index),
    );
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
    // The one call that states a target, so the one place an unusable one is
    // the caller's error rather than a consequence to release.
    if (input.target && !isValidTarget(input.target, current.connections)) {
      return deepFreeze({ kind: 'invalid_default_target', target: input.target });
    }
    const next = this.nextDocument(current, current.connections, input.target);
    await this.write(root, next);
    return committed(next);
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
    // Discovery MOVES a target: a provider's model rename carries the default
    // across by alias. A default outside the selection the reconciler just
    // decided is its own bug — fail closed where it is still attributable.
    const defaultTarget = currentDefaultTarget
      ? { connectionId: previous.connectionId, modelId: reconciled.defaultModel }
      : current.defaultTarget;
    if (currentDefaultTarget && !reconciled.enabledModelIds.includes(reconciled.defaultModel)) {
      throw codecError(
        'invalid_document',
        'Model discovery reconciled a default outside its own selection',
      );
    }
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
    // Onboarding only seeds the first default.
    const defaultTarget = current.defaultTarget ?? {
      connectionId,
      modelId: changes.enabledModelIds[0]!,
    };
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
    const next = this.nextDocument(current, connections, defaultTarget);
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
    await this.write(root, this.nextDocument(current, connections));
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
    const next = this.nextDocument(current, connections, defaultTarget);
    await this.write(root, next);
    return catalogSnapshot(next);
  }

  // The catalog's only next-version constructor: callers state the target they
  // want kept, never the one they have to police.
  private nextDocument(
    current: ConnectionCatalogDocument,
    connections: readonly ConnectionCatalogEntry[],
    defaultTarget: ConnectionTarget | null = current.defaultTarget,
  ): ConnectionCatalogDocument {
    return {
      ...current,
      revision: nextRevision(current.revision),
      defaultTarget: retainedDefaultTarget(defaultTarget, connections),
      connections,
    };
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

// `reconcileConnectionAfterEnabledModelsChange`'s rule, at catalog scope: a
// mutation that drops what the target names drops the target with it. Nothing
// here picks a replacement — see that function for why.
function retainedDefaultTarget(
  target: ConnectionTarget | null,
  connections: readonly ConnectionCatalogEntry[],
): ConnectionTarget | null {
  return target && isValidTarget(target, connections) ? target : null;
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

function isRetiredGeminiCliConnection(value: unknown): value is {
  readonly connectionId?: unknown;
  readonly providerType: 'gemini-cli';
  readonly slug?: unknown;
} {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Reflect.get(value, 'providerType') === 'gemini-cli'
  );
}

function committed(document: ConnectionCatalogDocument): ConnectionCatalogMutationResult {
  return deepFreeze({ kind: 'committed', snapshot: catalogSnapshot(document) });
}
