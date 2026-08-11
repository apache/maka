import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultEnabledModelIdsWhenOmitted } from '@maka/core/llm-connections';
import {
  PROVIDER_DEFAULTS,
  connectionEnabledModelIds,
  normalizePersistedConnection,
  reconcileConnectionAfterEnabledModelsChange,
  persistedBaseUrl,
  reconcileConnectionAfterModelFetch,
  validateSlug,
  type CreateConnectionInput,
  type LlmConnection,
  type UpdateConnectionInput,
} from '@maka/core/llm-connections';
import { pruneRelayModelProfiles } from '@maka/core/model-thinking';
import { normalizeOptionalRequestBodyOverlay } from '@maka/core/runtime-policy';
import { relayProfilesForStorage } from './relay-profile-store.js';

export interface ConnectionStore {
  getSnapshot(): Promise<ConnectionStoreSnapshot>;
  list(): Promise<LlmConnection[]>;
  get(slug: string): Promise<LlmConnection | null>;
  create(input: CreateConnectionInput): Promise<LlmConnection>;
  update(slug: string, patch: UpdateConnectionInput): Promise<LlmConnection>;
  updateIfUnchanged(
    slug: string,
    expectedUpdatedAt: number,
    patch: UpdateConnectionInput,
  ): Promise<LlmConnection | null>;
  delete(slug: string): Promise<void>;
  save(connection: LlmConnection): Promise<LlmConnection>;
  remove(slug: string): Promise<void>;
  getDefault(): Promise<string | null>;
  setDefault(slug: string | null): Promise<void>;
  /** Resolve the default connection from one fail-closed file snapshot. */
  getDefaultConnection(): Promise<LlmConnection | null>;
}

export interface ConnectionStoreSnapshot {
  defaultSlug: string | null;
  connections: LlmConnection[];
}

interface ConnectionsFile {
  defaultSlug: string | null;
  connections: LlmConnection[];
}

const emptyConnectionsFile = (): ConnectionsFile => ({ defaultSlug: null, connections: [] });

export function createConnectionStore(workspaceRoot: string): ConnectionStore {
  return new FileConnectionStore(workspaceRoot);
}

/**
 * Construct a store rooted at an explicit `llm-connections.json` file path
 * rather than a workspace directory. Use this when the caller already holds
 * the full file path (e.g. a host honoring a connections file-path
 * contract); prefer {@link createConnectionStore} when you have the workspace
 * root, since desktop/CLI share that root across stores.
 */
export function createConnectionStoreForFile(connectionsFilePath: string): ConnectionStore {
  return new FileConnectionStore(dirname(connectionsFilePath), connectionsFilePath);
}

class FileConnectionStore implements ConnectionStore {
  private readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string, explicitPath?: string) {
    this.path = explicitPath ?? join(workspaceRoot, 'llm-connections.json');
  }

  async getSnapshot(): Promise<ConnectionStoreSnapshot> {
    return await this.read();
  }

  async list(): Promise<LlmConnection[]> {
    return (await this.read()).connections;
  }

  async get(slug: string): Promise<LlmConnection | null> {
    return (await this.read()).connections.find((connection) => connection.slug === slug) ?? null;
  }

  async create(input: CreateConnectionInput): Promise<LlmConnection> {
    const err = validateSlug(input.slug);
    if (err) throw new Error(err);

    let created: LlmConnection | null = null;
    await this.withQueue(async () => {
      const file = await this.readUnlocked();
      if (file.connections.some((connection) => connection.slug === input.slug)) {
        throw new Error(`Connection slug already exists: ${input.slug}`);
      }
      const defaults = PROVIDER_DEFAULTS[input.providerType];
      if (!defaults) {
        throw new Error(`Unknown provider type "${input.providerType}"`);
      }
      const now = Date.now();
      const baseUrl = persistedBaseUrl(input.providerType, input.baseUrl);
      const defaultModel = input.defaultModel || defaults.fallbackModels[0] || '';
      // Profiles prune against the same selection the connection will store —
      // not just the default. Import/create can seed enabledModelIds + profiles
      // together; using only defaultModel would drop every non-default profile.
      const enabledModelIds = connectionEnabledModelIds({
        defaultModel,
        // Only fill a missing selection. Explicit [] / subset stays as stated.
        enabledModelIds:
          input.enabledModelIds ?? defaultEnabledModelIdsWhenOmitted(input.providerType),
      });
      const relayModelProfiles = relayProfilesForStorage(
        input.providerType,
        input.relayModelProfiles,
        enabledModelIds,
      );
      const requestBodyOverlay =
        input.requestBodyOverlay === undefined
          ? undefined
          : normalizeOptionalRequestBodyOverlay(input.requestBodyOverlay);
      const next: LlmConnection = {
        slug: input.slug,
        name: input.name || defaults.label,
        providerType: input.providerType,
        ...(baseUrl ? { baseUrl } : {}),
        defaultModel,
        enabled: true,
        enabledModelIds,
        createdAt: now,
        updatedAt: now,
        ...(input.extras ? { extras: input.extras } : {}),
        ...(relayModelProfiles === undefined ? {} : { relayModelProfiles }),
        ...(requestBodyOverlay === undefined ? {} : { requestBodyOverlay }),
      };
      file.connections.push(next);
      claimVacantWorkspaceDefault(file, next);
      created = next;
      await this.write(file);
    });
    if (!created) throw new Error(`Failed to create connection: ${input.slug}`);
    return created;
  }

  async update(slug: string, patch: UpdateConnectionInput): Promise<LlmConnection> {
    const updated = await this.updateInternal(slug, patch);
    if (!updated) throw new Error(`No such connection: ${slug}`);
    return updated;
  }

  async updateIfUnchanged(
    slug: string,
    expectedUpdatedAt: number,
    patch: UpdateConnectionInput,
  ): Promise<LlmConnection | null> {
    return await this.updateInternal(slug, patch, expectedUpdatedAt);
  }

  private async updateInternal(
    slug: string,
    patch: UpdateConnectionInput,
    expectedUpdatedAt?: number,
  ): Promise<LlmConnection | null> {
    let updated: LlmConnection | null = null;
    await this.withQueue(async () => {
      const file = await this.readUnlocked();
      const index = file.connections.findIndex((connection) => connection.slug === slug);
      if (index < 0) return;
      const current = file.connections[index]!;
      if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) return;
      const updatesTestStatus =
        Object.prototype.hasOwnProperty.call(patch, 'lastTestStatus') ||
        Object.prototype.hasOwnProperty.call(patch, 'lastTestAt') ||
        Object.prototype.hasOwnProperty.call(patch, 'lastTestMessage');
      const updatesModelCache =
        Object.prototype.hasOwnProperty.call(patch, 'models') ||
        Object.prototype.hasOwnProperty.call(patch, 'modelSource') ||
        Object.prototype.hasOwnProperty.call(patch, 'modelsFetchedAt');
      const clearsTestStatus =
        !updatesTestStatus &&
        (patch.apiKey !== undefined ||
          patch.baseUrl !== undefined ||
          patch.defaultModel !== undefined ||
          patch.models !== undefined ||
          patch.requestBodyOverlay !== undefined);
      const models = updatesModelCache ? patch.models : current.models;
      // A patch carrying `enabledModelIds` is the user stating a selection, so
      // it is written as stated — including empty. Anything else re-asserts a
      // choice they just withdrew. `reconcileConnectionAfterEnabledModelsChange`
      // owns the one rule that follows from it: a default outside the new set
      // is no longer the default.
      const statesEnabledModels = Object.prototype.hasOwnProperty.call(patch, 'enabledModelIds');
      let defaultModel = patch.defaultModel ?? current.defaultModel;
      let enabledModelIds: string[];
      if (statesEnabledModels) {
        const selection = reconcileConnectionAfterEnabledModelsChange(
          { defaultModel },
          patch.enabledModelIds ?? [],
        );
        defaultModel = selection.defaultModel;
        enabledModelIds = selection.enabledModelIds;
      } else {
        enabledModelIds = connectionEnabledModelIds({
          defaultModel,
          enabledModelIds: current.enabledModelIds,
        });
      }
      // Authoritative live inventory wins: a retired default (common after
      // Moonshot renamed moonshot-v1-* → kimi-k2.*) must not strand the
      // connection as model_not_enabled once models are fetched. Fallback
      // catalogs and metadata-only updates do not own this selection.
      const writesFetchedModels =
        Object.prototype.hasOwnProperty.call(patch, 'models') && patch.modelSource === 'fetched';
      if (writesFetchedModels && models && models.length > 0) {
        const reconciled = reconcileConnectionAfterModelFetch(
          {
            defaultModel,
            enabledModelIds,
            hasModelInventory: (current.models?.length ?? 0) > 0,
          },
          models,
        );
        defaultModel = reconciled.defaultModel;
        enabledModelIds = reconciled.enabledModelIds;
      }
      // Endpoint-keyed semantics, matching the catalog document store: the
      // comparison must be between the CANONICALIZED endpoints — a patch
      // restating the current endpoint (or its equivalent) is not a move.
      const nextBaseUrl =
        patch.baseUrl !== undefined
          ? persistedBaseUrl(current.providerType, patch.baseUrl)
          : current.baseUrl;
      const endpointChanged = nextBaseUrl !== current.baseUrl;
      const requestBodyOverlay =
        patch.requestBodyOverlay === undefined
          ? current.requestBodyOverlay
          : patch.requestBodyOverlay === null
            ? undefined
            : normalizeOptionalRequestBodyOverlay(patch.requestBodyOverlay);
      const {
        requestBodyOverlay: _currentRequestBodyOverlay,
        ...currentWithoutRequestBodyOverlay
      } = current;
      const next: LlmConnection = {
        ...currentWithoutRequestBodyOverlay,
        name: patch.name ?? current.name,
        baseUrl: nextBaseUrl,
        defaultModel,
        enabled: patch.enabled ?? current.enabled,
        enabledModelIds,
        models,
        modelSource: updatesModelCache ? patch.modelSource : current.modelSource,
        modelsFetchedAt: updatesModelCache ? patch.modelsFetchedAt : current.modelsFetchedAt,
        lastTestStatus: updatesTestStatus
          ? patch.lastTestStatus
          : clearsTestStatus
            ? undefined
            : current.lastTestStatus,
        lastTestAt: updatesTestStatus
          ? patch.lastTestAt
          : clearsTestStatus
            ? undefined
            : current.lastTestAt,
        lastTestMessage: updatesTestStatus
          ? patch.lastTestMessage
          : clearsTestStatus
            ? undefined
            : current.lastTestMessage,
        extras: patch.extras ?? current.extras,
        ...(requestBodyOverlay === undefined ? {} : { requestBodyOverlay }),
        // Profiles only ever describe enabled models of THIS endpoint on a
        // relay connection: an explicit table passes the same gate+prune
        // every write shape applies (a new table in a moving update declares
        // itself bound to the NEW endpoint, matching the catalog store);
        // an untouched one retires with the old endpoint — declarations
        // belong to the relay that answered for them, and a model id that
        // coincides across endpoints is a different model — and only then
        // is pruned against the selection just computed.
        relayModelProfiles:
          patch.relayModelProfiles === undefined
            ? endpointChanged
              ? undefined
              : pruneRelayModelProfiles(current.relayModelProfiles, enabledModelIds)
            : relayProfilesForStorage(
                current.providerType,
                patch.relayModelProfiles,
                enabledModelIds,
              ),
        updatedAt: Date.now(),
      };
      file.connections[index] = next;
      // The workspace default is the pair {connection, model}. A connection
      // that is disabled, or that no longer has a default model, cannot supply
      // half of it — leaving the slug behind showed a "默认" badge next to a
      // picker that read 未设置.
      if (file.defaultSlug === slug && (next.enabled === false || !next.defaultModel)) {
        file.defaultSlug = null;
      }
      // The other direction: a provider with no `fallbackModels` is created
      // with no model at all, so its first discovery is where it becomes able
      // to hold the default. Without this the user finished setting up their
      // only connection and onboarding still had nothing to point at.
      claimVacantWorkspaceDefault(file, next);
      updated = next;
      await this.write(file);
    });
    return updated;
  }

  async delete(slug: string): Promise<void> {
    await this.remove(slug);
  }

  async save(connection: LlmConnection): Promise<LlmConnection> {
    // save() is a full-snapshot boundary, so callers providing authoritative
    // fetched models must already reconcile defaultModel/enabledModelIds
    // through `reconcileConnectionAfterModelFetch` — which is what the OAuth
    // account syncs now do. update() performs that reconciliation itself for
    // partial fetched-model patches.
    //
    // The selection rule deliberately does NOT live here. This boundary sees
    // only a snapshot, so it cannot tell a selection the user just stated from
    // one a sync echoed back unchanged; enforcing "written as stated" on it
    // threw away the repaired default a sync had just computed for a model the
    // provider had retired, leaving the connection pointing at nothing.
    let saved: LlmConnection | null = null;
    await this.withQueue(async () => {
      const file = await this.readUnlocked();
      const index = file.connections.findIndex((item) => item.slug === connection.slug);
      const now = Date.now();
      // save() is a full-replace write; route it through persistedBaseUrl too,
      // or a caller handing back defaults.baseUrl (e.g. OAuth sync) pins the
      // connection to the current default. Profiles come from the same
      // gate+prune as create/update — snapshot semantics must not bypass
      // either profile invariant.
      const baseUrl = persistedBaseUrl(connection.providerType, connection.baseUrl);
      const {
        baseUrl: _omit,
        relayModelProfiles: _rawProfiles,
        requestBodyOverlay: _rawRequestBodyOverlay,
        ...rest
      } = connection;
      const enabledModelIds = connectionEnabledModelIds(connection);
      const relayModelProfiles = relayProfilesForStorage(
        connection.providerType,
        connection.relayModelProfiles,
        enabledModelIds,
      );
      const requestBodyOverlay =
        connection.requestBodyOverlay === undefined
          ? undefined
          : normalizeOptionalRequestBodyOverlay(connection.requestBodyOverlay);
      const next: LlmConnection = {
        ...rest,
        ...(baseUrl ? { baseUrl } : {}),
        enabled: connection.enabled ?? true,
        enabledModelIds,
        ...(relayModelProfiles === undefined ? {} : { relayModelProfiles }),
        ...(requestBodyOverlay === undefined ? {} : { requestBodyOverlay }),
        createdAt: connection.createdAt ?? now,
        updatedAt: connection.updatedAt ?? now,
      };
      if (index >= 0) file.connections[index] = next;
      else file.connections.push(next);
      // Same {connection, model} pair as in update(): a connection with no
      // default model supplies only half of it, so it cannot keep the slug.
      // Without this an OAuth resync re-pointed the workspace default at a
      // connection whose model list the user had just emptied, and the list
      // showed a 默认 badge over 未设置.
      if (file.defaultSlug === connection.slug && (next.enabled === false || !next.defaultModel)) {
        file.defaultSlug = null;
      }
      if (index < 0) claimVacantWorkspaceDefault(file, next);
      await this.write(file);
      saved = next;
    });
    if (!saved) throw new Error(`Failed to save connection: ${connection.slug}`);
    return saved;
  }

  async remove(slug: string): Promise<void> {
    await this.withQueue(async () => {
      const file = await this.readUnlocked();
      file.connections = file.connections.filter((connection) => connection.slug !== slug);
      if (file.defaultSlug === slug) file.defaultSlug = null;
      await this.write(file);
    });
  }

  async getDefault(): Promise<string | null> {
    return (await this.read()).defaultSlug;
  }

  async setDefault(slug: string | null): Promise<void> {
    await this.withQueue(async () => {
      const file = await this.readUnlocked();
      if (slug) {
        const connection = file.connections.find((item) => item.slug === slug);
        if (!connection) throw new Error(`No such connection: ${slug}`);
        if (!connection.enabled) throw new Error(`Connection is disabled: ${slug}`);
        // Half of the {connection, model} pair is not a default. Symmetric with
        // the disabled check: a connection that cannot supply a model to start
        // a chat on cannot be the one a chat starts on.
        if (!connection.defaultModel) throw new Error(`Connection has no default model: ${slug}`);
      }
      file.defaultSlug = slug;
      await this.write(file);
    });
  }

  async getDefaultConnection(): Promise<LlmConnection | null> {
    const snapshot = await this.read();
    if (!snapshot.defaultSlug) return null;
    return snapshot.connections.find((c) => c.slug === snapshot.defaultSlug) ?? null;
  }

  private async read(): Promise<ConnectionsFile> {
    return this.readUnlocked();
  }

  private async readUnlocked(): Promise<ConnectionsFile> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      const parsed = normalizeConnectionsFile(raw);
      const connections = parsed.connections.map(normalizePersistedConnection);
      return {
        defaultSlug: normalizeDefaultSlug(parsed.defaultSlug, connections),
        connections,
      };
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return emptyConnectionsFile();
      throw error;
    }
  }

  private async write(file: ConnectionsFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, JSON.stringify(file, null, 2) + '\n', 'utf8');
    await rename(tempPath, this.path);
  }

  private withQueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => {});
    return next;
  }
}

function normalizeConnectionsFile(value: unknown): ConnectionsFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid connection file: expected an object');
  }
  const record = value as Partial<ConnectionsFile>;
  if (!Array.isArray(record.connections)) {
    throw new Error('Invalid connection file: connections must be an array');
  }
  if (
    record.defaultSlug !== undefined &&
    record.defaultSlug !== null &&
    typeof record.defaultSlug !== 'string'
  ) {
    throw new Error('Invalid connection file: defaultSlug must be a string or null');
  }
  return {
    defaultSlug: record.defaultSlug ?? null,
    connections: record.connections,
  };
}

/**
 * A workspace with no default takes one from the connection the user is
 * working on, so a fresh install is usable as soon as its first connection is
 * — including the four providers that ship no `fallbackModels`, which only
 * become able to hold it at their first discovery rather than at create.
 *
 * Only from the connection the user is working on. `save()` is the snapshot
 * boundary the OAuth sync writes on, and `connections:list` runs that sync
 * before every read, so letting it claim any vacant slug meant that clearing
 * your own default handed the workspace to whichever account happened to sync
 * first — your next chat went to a different provider, without you touching
 * anything. A sync that is bringing a brand-new connection into existence is
 * the one exception: that is the same event as create().
 */
function claimVacantWorkspaceDefault(file: ConnectionsFile, connection: LlmConnection): void {
  if (file.defaultSlug) return;
  if (connection.enabled === false || !connection.defaultModel) return;
  file.defaultSlug = connection.slug;
}

function normalizeDefaultSlug(
  defaultSlug: string | null | undefined,
  connections: LlmConnection[],
): string | null {
  if (!defaultSlug) return null;
  const connection = connections.find((item) => item.slug === defaultSlug);
  // Same pair rule as the write paths, applied to whatever is already on disk:
  // a file written before they enforced it can still point at a connection with
  // no default model, and that reads back as a 默认 badge over 未设置.
  if (!connection || connection.enabled === false || !connection.defaultModel) return null;
  return connection.slug;
}
