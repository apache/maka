import { randomUUID } from 'node:crypto';
import {
  CONNECTION_CATALOG_MAX_CONNECTIONS,
  decodeCanonicalConnectionCatalogEntry,
  decodeConnectionTarget,
  decodeConnectionTestSummary,
  decodeConnectionVersionBasis,
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
import { PROVIDER_DEFAULTS, reconcileConnectionAfterModelFetch } from '@maka/core/llm-connections';
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
    const defaultTarget =
      raw.defaultTarget === null
        ? null
        : decodePersistedDomain(() => decodeConnectionTarget(raw.defaultTarget));
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
      !sameStringArray(previous.enabledModelIds, changes.enabledModelIds);
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
          )
        : {
            defaultModel: currentDefaultTarget?.modelId ?? previous.enabledModelIds[0] ?? '',
            enabledModelIds: previous.enabledModelIds,
          };
    const defaultTarget = currentDefaultTarget
      ? { connectionId: previous.connectionId, modelId: reconciled.defaultModel }
      : current.defaultTarget;
    const discovered: ConnectionCatalogEntry = {
      ...previous,
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
    if (serializeJsonDocument(document).length > CATALOG_DOCUMENT_MAX_BYTES) {
      throw new RuntimePolicyStoreError(
        'invalid_connection_input',
        `connection catalog exceeds its ${CATALOG_DOCUMENT_MAX_BYTES} byte limit`,
      );
    }
    await writeJsonDocument(root, FILE, document, CATALOG_DOCUMENT_MAX_BYTES);
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
