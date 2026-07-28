import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  PROVIDER_DEFAULTS,
  connectionEnabledModelIds,
  migrateConnectionV1ToV2,
  persistedBaseUrl,
  reconcileConnectionAfterModelFetch,
  validateSlug,
  type CreateConnectionInput,
  type LlmConnection,
  type UpdateConnectionInput,
} from '@maka/core/llm-connections';

export interface ConnectionStore {
  list(): Promise<LlmConnection[]>;
  get(slug: string): Promise<LlmConnection | null>;
  create(input: CreateConnectionInput): Promise<LlmConnection>;
  update(slug: string, patch: UpdateConnectionInput): Promise<LlmConnection>;
  delete(slug: string): Promise<void>;
  save(connection: LlmConnection): Promise<LlmConnection>;
  remove(slug: string): Promise<void>;
  getDefault(): Promise<string | null>;
  setDefault(slug: string | null): Promise<void>;
}

interface ConnectionsFile {
  defaultSlug: string | null;
  connections: LlmConnection[];
}

const emptyConnectionsFile = (): ConnectionsFile => ({ defaultSlug: null, connections: [] });

export function createConnectionStore(workspaceRoot: string): ConnectionStore {
  return new FileConnectionStore(workspaceRoot);
}

class FileConnectionStore implements ConnectionStore {
  private readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.path = join(workspaceRoot, 'llm-connections.json');
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
      const next: LlmConnection = {
        slug: input.slug,
        name: input.name || defaults.label,
        providerType: input.providerType,
        ...(baseUrl ? { baseUrl } : {}),
        defaultModel,
        enabled: true,
        enabledModelIds: connectionEnabledModelIds({ defaultModel }),
        createdAt: now,
        updatedAt: now,
      };
      file.connections.push(next);
      if (!file.defaultSlug) file.defaultSlug = next.slug;
      created = next;
      await this.write(file);
    });
    if (!created) throw new Error(`Failed to create connection: ${input.slug}`);
    return created;
  }

  async update(slug: string, patch: UpdateConnectionInput): Promise<LlmConnection> {
    let updated: LlmConnection | null = null;
    await this.withQueue(async () => {
      const file = await this.readUnlocked();
      const index = file.connections.findIndex((connection) => connection.slug === slug);
      if (index < 0) throw new Error(`No such connection: ${slug}`);
      const current = file.connections[index]!;
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
          patch.models !== undefined);
      const models = updatesModelCache ? patch.models : current.models;
      let defaultModel = patch.defaultModel ?? current.defaultModel;
      let enabledModelIds = connectionEnabledModelIds({
        defaultModel,
        enabledModelIds: patch.enabledModelIds ?? current.enabledModelIds,
      });
      // Authoritative live inventory wins: a retired default (common after
      // Moonshot renamed moonshot-v1-* → kimi-k2.*) must not strand the
      // connection as model_not_enabled once models are fetched. Fallback
      // catalogs and metadata-only updates do not own this selection.
      const writesFetchedModels =
        Object.prototype.hasOwnProperty.call(patch, 'models') && patch.modelSource === 'fetched';
      if (writesFetchedModels && models && models.length > 0) {
        const reconciled = reconcileConnectionAfterModelFetch(
          { defaultModel, enabledModelIds },
          models,
        );
        defaultModel = reconciled.defaultModel;
        enabledModelIds = reconciled.enabledModelIds;
      }
      const next: LlmConnection = {
        ...current,
        name: patch.name ?? current.name,
        baseUrl:
          patch.baseUrl !== undefined
            ? persistedBaseUrl(current.providerType, patch.baseUrl)
            : current.baseUrl,
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
        updatedAt: Date.now(),
      };
      file.connections[index] = next;
      if (file.defaultSlug === slug && next.enabled === false) {
        file.defaultSlug = null;
      }
      updated = next;
      await this.write(file);
    });
    if (!updated) throw new Error(`Failed to update connection: ${slug}`);
    return updated;
  }

  async delete(slug: string): Promise<void> {
    await this.remove(slug);
  }

  async save(connection: LlmConnection): Promise<LlmConnection> {
    // save() is a full-snapshot boundary, so callers providing authoritative
    // fetched models must already reconcile defaultModel/enabledModelIds.
    // update() performs that reconciliation for partial fetched-model patches.
    let saved: LlmConnection | null = null;
    await this.withQueue(async () => {
      const file = await this.readUnlocked();
      const index = file.connections.findIndex((item) => item.slug === connection.slug);
      const now = Date.now();
      // save() is a full-replace write; route it through persistedBaseUrl too,
      // or a caller handing back defaults.baseUrl (e.g. OAuth sync) pins the
      // connection to the current default.
      const baseUrl = persistedBaseUrl(connection.providerType, connection.baseUrl);
      const { baseUrl: _omit, ...rest } = connection;
      const next: LlmConnection = {
        ...rest,
        ...(baseUrl ? { baseUrl } : {}),
        enabled: connection.enabled ?? true,
        enabledModelIds: connectionEnabledModelIds(connection),
        createdAt: connection.createdAt ?? now,
        updatedAt: connection.updatedAt ?? now,
      };
      if (index >= 0) file.connections[index] = next;
      else file.connections.push(next);
      if (file.defaultSlug === connection.slug && next.enabled === false) {
        file.defaultSlug = null;
      }
      if (!file.defaultSlug && next.enabled !== false) file.defaultSlug = connection.slug;
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
      }
      file.defaultSlug = slug;
      await this.write(file);
    });
  }

  private async read(): Promise<ConnectionsFile> {
    return this.readUnlocked();
  }

  private async readUnlocked(): Promise<ConnectionsFile> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      const parsed = normalizeConnectionsFile(raw);
      const connections = parsed.connections.map((connection) =>
        migrateConnectionV1ToV2(connection),
      );
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

function normalizeDefaultSlug(
  defaultSlug: string | null | undefined,
  connections: LlmConnection[],
): string | null {
  if (!defaultSlug) return null;
  const connection = connections.find((item) => item.slug === defaultSlug);
  return connection && connection.enabled !== false ? connection.slug : null;
}
