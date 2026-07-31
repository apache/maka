import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  PricingConfig,
  UsageBucket,
  UsageGroupBy,
  UsageLogRow,
  UsageQuery,
  UsageSummaryV2,
} from '@maka/core/usage-stats/types';
import { throwDeduplicatedFailures } from './failure-utils.js';
import { createPricingStore, type PricingStore } from './pricing-store.js';
import { syncDirectory } from './stable-storage.js';
import {
  decodeTelemetryFile,
  decodePersistedLlmCallRecord,
  decodePersistedToolInvocationRecord,
  emptyTelemetryFile,
  type PersistedLlmCallRecord,
  type PersistedToolInvocationRecord,
  type TelemetryFile,
} from './telemetry-file-schema.js';

export type {
  PersistedLlmCallRecord,
  PersistedToolInvocationRecord,
} from './telemetry-file-schema.js';

export interface ToolUsageQuery {
  readonly range: UsageQuery['range'];
  readonly toolName?: string;
  readonly status?: UsageQuery['status'];
}

export interface TelemetryRepo {
  insertLlmCall(record: PersistedLlmCallRecord): Promise<void>;
  insertToolInvocation(record: PersistedToolInvocationRecord): Promise<void>;
  summary(query: UsageQuery): UsageSummaryV2;
  buckets(query: UsageQuery, groupBy: UsageGroupBy): UsageBucket[];
  logs(query: UsageQuery, offset?: number, limit?: number): { rows: UsageLogRow[]; total: number };
  toolLogs(
    query: ToolUsageQuery,
    offset?: number,
    limit?: number,
  ): { rows: PersistedToolInvocationRecord[]; total: number };
  latestLlmRuntimeProbe(connectionSlug: string, modelId?: string): UsageLogRow | undefined;
  listPricingOverrides(): PricingConfig[];
  upsertPricing(pricing: PricingConfig): Promise<void>;
  deletePricing(modelKey: string): Promise<void>;
  legacyPricingOverrides(): readonly unknown[];
  publishCanonical(): Promise<void>;
  load(): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateTelemetryRepoOptions {
  readonly createIfMissing?: boolean;
  readonly managePricing?: boolean;
}

export class TelemetryRepoClosedError extends Error {
  constructor() {
    super('Telemetry repository is draining or closed');
    this.name = 'TelemetryRepoClosedError';
  }
}

export class TelemetryRepoNotLoadedError extends Error {
  constructor() {
    super('Telemetry repository has not been loaded');
    this.name = 'TelemetryRepoNotLoadedError';
  }
}

export class TelemetryQueryValidationError extends Error {
  constructor(message: string) {
    super(`Invalid telemetry query: ${message}`);
    this.name = 'TelemetryQueryValidationError';
  }
}

export class TelemetryRepoPublicationError extends Error {
  readonly domain = 'telemetry_authority';

  constructor(
    readonly commitUnknown: boolean,
    options: { cause: unknown },
  ) {
    super(
      commitUnknown
        ? 'Telemetry publication outcome is unknown; reopen before retrying'
        : 'Unable to publish telemetry',
      options,
    );
    this.name = 'TelemetryRepoPublicationError';
  }
}

export function createTelemetryRepo(
  workspaceRoot: string,
  options: CreateTelemetryRepoOptions = {},
): TelemetryRepo {
  return new FileTelemetryRepo(
    workspaceRoot,
    options.createIfMissing ?? true,
    options.managePricing ?? true,
  );
}

class FileTelemetryRepo implements TelemetryRepo {
  private readonly path: string;
  private file: TelemetryFile = emptyTelemetryFile();
  private legacyPricing: readonly unknown[] = [];
  private requiresCanonicalPublication = false;
  private pricingStore: PricingStore | undefined;
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();
  private failure: TelemetryRepoPublicationError | undefined;
  private state: 'open' | 'draining' | 'closed' = 'open';
  private loadPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;

  constructor(
    workspaceRoot: string,
    private readonly createIfMissing: boolean,
    private readonly managePricing: boolean,
  ) {
    this.path = join(workspaceRoot, 'telemetry.json');
  }

  load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.assertOpen();
    if (this.loadPromise) return this.loadPromise;
    const operation = this.loadFromDisk();
    this.loadPromise = operation;
    void operation.catch(() => {
      if (this.state === 'open' && this.loadPromise === operation) {
        this.loadPromise = undefined;
      }
    });
    return operation;
  }

  private async loadFromDisk(): Promise<void> {
    let missing = false;
    let file: TelemetryFile;
    let legacyPricing: readonly unknown[];
    let requiresCanonicalPublication: boolean;
    let pricingStore: PricingStore | undefined;
    try {
      const decoded = decodeTelemetryFile(JSON.parse(await readFile(this.path, 'utf8')));
      file = decoded.file;
      legacyPricing = decoded.legacyPricingOverrides;
      requiresCanonicalPublication = decoded.requiresCanonicalPublication;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing = true;
      file = emptyTelemetryFile();
      legacyPricing = [];
      requiresCanonicalPublication = false;
    }

    if (this.managePricing) {
      pricingStore = createPricingStore(dirname(this.path), {
        createIfMissing: this.createIfMissing,
        initialOverrides: legacyPricing,
      });
      await pricingStore.load();
    }
    if (this.createIfMissing && (missing || (this.managePricing && requiresCanonicalPublication))) {
      await this.publish(file);
      requiresCanonicalPublication = false;
    }

    this.file = file;
    this.legacyPricing = legacyPricing;
    this.requiresCanonicalPublication = requiresCanonicalPublication;
    this.pricingStore = pricingStore;
    this.loaded = true;
  }

  insertLlmCall(record: PersistedLlmCallRecord): Promise<void> {
    let admitted: PersistedLlmCallRecord;
    try {
      admitted = decodePersistedLlmCallRecord(record);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueueMutation((file) => ({
      ...file,
      usageRecords: upsertById(file.usageRecords, admitted),
    }));
  }

  insertToolInvocation(record: PersistedToolInvocationRecord): Promise<void> {
    let admitted: PersistedToolInvocationRecord;
    try {
      admitted = decodePersistedToolInvocationRecord(record);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueueMutation((file) => ({
      ...file,
      toolInvocations: upsertById(file.toolInvocations, admitted),
    }));
  }

  summary(query: UsageQuery): UsageSummaryV2 {
    this.assertReady();
    const { from, to } = resolveRange(query.range);
    const rows = this.filteredUsageRows(query, from, to);
    return detached({
      range: { from, to },
      totalRequests: rows.length,
      totalCostUsd: sum(rows.map((row) => row.costUsd)),
      totalTokens: {
        input: sum(rows.map((row) => row.inputTokens)),
        output: sum(rows.map((row) => row.outputTokens)),
        cacheMiss: sum(rows.map((row) => row.cacheMissInputTokens)),
        cacheRead: sum(rows.map((row) => row.cacheHitInputTokens)),
        cacheWrite: sum(rows.map((row) => row.cacheWriteInputTokens)),
        reasoning: sum(rows.map((row) => row.reasoningTokens)),
        total: sum(rows.map((row) => row.totalTokens)),
      },
      cacheHitRequests: rows.filter((row) => row.cacheHitInputTokens > 0).length,
      cacheCreateRequests: rows.filter((row) => row.cacheWriteInputTokens > 0).length,
      errorRequests: rows.filter((row) => row.status === 'error').length,
    });
  }

  buckets(query: UsageQuery, groupBy: UsageGroupBy): UsageBucket[] {
    this.assertReady();
    const { from, to } = resolveRange(query.range);
    if (groupBy === 'tool') {
      return detached(toolBuckets(this.filteredToolRows(query, from, to)));
    }
    const groups = new Map<string, PersistedLlmCallRecord[]>();
    for (const row of this.filteredUsageRows(query, from, to)) {
      const key = bucketKey(row, groupBy);
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(row);
    }
    return detached(
      [...groups.entries()]
        .map(([key, rows]) => usageBucket(key, rows))
        .sort((left, right) => right.requests - left.requests),
    );
  }

  logs(query: UsageQuery, offset = 0, limit = 100): { rows: UsageLogRow[]; total: number } {
    this.assertReady();
    if (query.toolName !== undefined) {
      throw new TelemetryQueryValidationError('toolName is not applicable to LLM logs');
    }
    const { from, to } = resolveRange(query.range);
    const rows = this.filteredUsageRows(query, from, to).sort((left, right) => right.ts - left.ts);
    const total = rows.length;
    return detached({
      rows: rows.slice(offset, offset + limit).map(toUsageLogRow),
      total,
    });
  }

  toolLogs(
    query: ToolUsageQuery,
    offset = 0,
    limit = 100,
  ): { rows: PersistedToolInvocationRecord[]; total: number } {
    this.assertReady();
    assertToolUsageQuery(query);
    const { from, to } = resolveRange(query.range);
    const rows = this.filteredToolRows(query, from, to).sort((left, right) => right.ts - left.ts);
    return detached({ rows: rows.slice(offset, offset + limit), total: rows.length });
  }

  latestLlmRuntimeProbe(connectionSlug: string, modelId?: string): UsageLogRow | undefined {
    return this.logs({ range: 'all', connectionSlug, ...(modelId ? { modelId } : {}) }, 0, 1)
      .rows[0];
  }

  listPricingOverrides(): PricingConfig[] {
    this.assertReady();
    if (this.pricingStore)
      return this.pricingStore.snapshot().overrides.map((item) => ({ ...item }));
    return [];
  }

  async upsertPricing(pricing: PricingConfig): Promise<void> {
    const store = this.requireManagedPricing();
    const snapshot = store.snapshot();
    await store.upsert(snapshot.revision, pricing);
  }

  async deletePricing(modelKey: string): Promise<void> {
    const store = this.requireManagedPricing();
    const snapshot = store.snapshot();
    await store.delete(snapshot.revision, modelKey);
  }

  legacyPricingOverrides(): readonly unknown[] {
    this.assertReady();
    return structuredClone(this.legacyPricing);
  }

  publishCanonical(): Promise<void> {
    this.assertReady();
    if (!this.requiresCanonicalPublication) return this.flush();
    return this.enqueueMutation((file) => file);
  }

  async flush(): Promise<void> {
    this.assertLoaded();
    await this.queue;
    if (this.failure) throw this.failure;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.state = 'draining';
    this.closePromise = this.closeResources().finally(() => {
      this.state = 'closed';
    });
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    const settled = await Promise.allSettled([
      this.loadPromise ?? Promise.resolve(),
      this.queue.then(() => {
        if (this.failure) throw this.failure;
      }),
    ]);
    const pricingResult = await Promise.allSettled([
      this.pricingStore?.close() ?? Promise.resolve(),
    ]);
    throwDeduplicatedFailures('Unable to close telemetry repository', [
      ...settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
      ...pricingResult.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
    ]);
  }

  private enqueueMutation(mutate: (file: TelemetryFile) => TelemetryFile): Promise<void> {
    this.assertReady();
    const operation = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      const candidate = mutate(this.file);
      try {
        await this.publish(candidate);
      } catch (error) {
        const failure =
          error instanceof TelemetryRepoPublicationError
            ? error
            : new TelemetryRepoPublicationError(false, { cause: error });
        this.failure = failure;
        throw failure;
      }
      this.file = candidate;
      this.requiresCanonicalPublication = false;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async publish(file: TelemetryFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let published = false;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(file, null, 2) + '\n', 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.path);
      published = true;
      await syncDirectory(dirname(this.path));
    } catch (cause) {
      throw new TelemetryRepoPublicationError(published, { cause });
    } finally {
      await handle?.close().catch(() => undefined);
      if (!published) await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private filteredUsageRows(query: UsageQuery, from: number, to: number) {
    return this.file.usageRecords.filter((row) => {
      if (row.ts < from || row.ts > to) return false;
      if (query.connectionSlug && row.connectionSlug !== query.connectionSlug) return false;
      if (query.providerId && row.providerId !== query.providerId) return false;
      if (query.modelId && row.modelId !== query.modelId) return false;
      if (query.status && query.status !== 'all' && row.status !== query.status) return false;
      return true;
    });
  }

  private filteredToolRows(query: UsageQuery, from: number, to: number) {
    return this.file.toolInvocations.filter((row) => {
      if (row.ts < from || row.ts > to) return false;
      if (query.toolName && row.toolName !== query.toolName) return false;
      if (query.status && query.status !== 'all' && row.status !== query.status) return false;
      return true;
    });
  }

  private requireManagedPricing(): PricingStore {
    this.assertReady();
    if (!this.pricingStore) {
      throw new Error('Telemetry repository does not own the compatibility pricing facade');
    }
    return this.pricingStore;
  }

  private assertLoaded(): void {
    if (!this.loaded) throw new TelemetryRepoNotLoadedError();
  }

  private assertOpen(): void {
    if (this.state !== 'open') throw new TelemetryRepoClosedError();
  }

  private assertReady(): void {
    this.assertOpen();
    this.assertLoaded();
    if (this.failure?.commitUnknown) throw this.failure;
  }
}

function toUsageLogRow(row: PersistedLlmCallRecord): UsageLogRow {
  return {
    id: row.id,
    ts: row.ts,
    ...(row.callKind ? { callKind: row.callKind } : {}),
    ...(row.callId ? { callId: row.callId } : {}),
    ...(row.connectionSlug ? { connectionSlug: row.connectionSlug } : {}),
    providerId: row.providerId,
    modelId: row.modelId,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheMissTokens: row.cacheMissInputTokens,
    cacheReadTokens: row.cacheHitInputTokens,
    cacheWriteTokens: row.cacheWriteInputTokens,
    ...(row.cacheMissInputSource ? { cacheMissInputSource: row.cacheMissInputSource } : {}),
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd,
    latencyMs: row.latencyMs,
    status: row.status,
    ...(row.errorClass ? { errorClass: row.errorClass } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    ...(row.turnId ? { turnId: row.turnId } : {}),
    ...(row.systemPromptHash ? { systemPromptHash: row.systemPromptHash } : {}),
    ...(row.prefixHash ? { prefixHash: row.prefixHash } : {}),
    ...(row.prefixChangeReason ? { prefixChangeReason: row.prefixChangeReason } : {}),
    ...(row.requestShapeHash ? { requestShapeHash: row.requestShapeHash } : {}),
    ...(row.requestShapeChangeReason
      ? { requestShapeChangeReason: row.requestShapeChangeReason }
      : {}),
    ...(row.toolSchemaChangeReason ? { toolSchemaChangeReason: row.toolSchemaChangeReason } : {}),
    ...(row.toolAvailability ? { toolAvailability: row.toolAvailability } : {}),
    ...(row.promptSegments ? { promptSegments: row.promptSegments } : {}),
    ...(row.contextBudget ? { contextBudget: row.contextBudget } : {}),
  };
}

function upsertById<T extends { id: string }>(rows: readonly T[], row: T): T[] {
  return [...rows.filter((current) => current.id !== row.id), row];
}

export function resolveRange(range: UsageQuery['range']): { from: number; to: number } {
  if (typeof range === 'object') return range;
  const now = Date.now();
  switch (range) {
    case '24h':
      return { from: now - 24 * 60 * 60 * 1000, to: now };
    case '7d':
      return { from: now - 7 * 24 * 60 * 60 * 1000, to: now };
    case '30d':
      return { from: now - 30 * 24 * 60 * 60 * 1000, to: now };
    case 'all':
      return { from: 0, to: now };
  }
}

function bucketKey(row: PersistedLlmCallRecord, groupBy: UsageGroupBy): string {
  switch (groupBy) {
    case 'provider':
      return row.providerId;
    case 'model':
      return `${row.providerId}:${row.modelId}`;
    case 'day':
      return row.date;
    case 'hour':
      return String(Math.floor(row.ts / (60 * 60 * 1000)));
    case 'tool':
      return '';
  }
}

function usageBucket(key: string, rows: readonly PersistedLlmCallRecord[]): UsageBucket {
  const errors = rows.filter((row) => row.status === 'error').length;
  return {
    key,
    label: key,
    requests: rows.length,
    inputTokens: sum(rows.map((row) => row.inputTokens)),
    outputTokens: sum(rows.map((row) => row.outputTokens)),
    cacheMissTokens: sum(rows.map((row) => row.cacheMissInputTokens)),
    cacheReadTokens: sum(rows.map((row) => row.cacheHitInputTokens)),
    cacheWriteTokens: sum(rows.map((row) => row.cacheWriteInputTokens)),
    reasoningTokens: sum(rows.map((row) => row.reasoningTokens)),
    totalTokens: sum(rows.map((row) => row.totalTokens)),
    costUsd: sum(rows.map((row) => row.costUsd)),
    avgLatencyMs: rows.length ? Math.round(sum(rows.map((row) => row.latencyMs)) / rows.length) : 0,
    errorRate: rows.length ? errors / rows.length : 0,
  };
}

function toolBuckets(rows: readonly PersistedToolInvocationRecord[]): UsageBucket[] {
  const groups = new Map<string, PersistedToolInvocationRecord[]>();
  for (const row of rows) {
    let group = groups.get(row.toolName);
    if (!group) {
      group = [];
      groups.set(row.toolName, group);
    }
    group.push(row);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const errors = group.filter((row) => row.status === 'error').length;
      const bytesIn = sum(group.map((row) => row.bytesIn));
      const bytesOut = sum(group.map((row) => row.bytesOut));
      return {
        key,
        label: key,
        requests: group.length,
        inputTokens: bytesIn,
        outputTokens: bytesOut,
        cacheMissTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: bytesIn + bytesOut,
        costUsd: 0,
        avgLatencyMs: group.length
          ? Math.round(sum(group.map((row) => row.durationMs)) / group.length)
          : 0,
        errorRate: group.length ? errors / group.length : 0,
      };
    })
    .sort((left, right) => right.requests - left.requests);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function assertToolUsageQuery(query: ToolUsageQuery): void {
  const keys = Object.keys(query);
  if (keys.some((key) => !['range', 'toolName', 'status'].includes(key))) {
    throw new TelemetryQueryValidationError('tool logs accept only range, toolName, and status');
  }
}

function detached<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
