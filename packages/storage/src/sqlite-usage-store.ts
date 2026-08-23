/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type {
  PricingConfig,
  UsageBucket,
  UsageGroupBy,
  UsageLogRow,
  UsageQuery,
  UsageSummaryV2,
} from '@maka/core/usage-stats/types';
import { clampCacheReadTokens } from '@maka/core/model-call-usage-projection';
import {
  canonicalPricingConfigsEqual,
  comparePricingModelKeys,
  normalizePricingConfig,
  normalizePricingModelKey,
} from '@maka/core/usage-stats/pricing';
import { usageBucketKey } from '@maka/core/usage-stats/bucket-key';
import {
  PricingRevisionConflictError,
  PricingStoreClosedError,
  PricingStoreNotLoadedError,
  PricingStorePublicationError,
  PricingValidationError,
  type CreatePricingStoreOptions,
  type PricingMutationResult,
  type PricingSnapshot,
  type PricingStore,
} from './pricing-store.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';
import {
  decodePersistedLlmCallRecord,
  decodePersistedToolInvocationRecord,
  type PersistedLlmCallRecord,
  type PersistedToolInvocationRecord,
} from './telemetry-file-schema.js';
import {
  resolveRange,
  TelemetryQueryValidationError,
  TelemetryRepoClosedError,
  TelemetryRepoNotLoadedError,
  TelemetryRepoPublicationError,
  type CreateTelemetryRepoOptions,
  type TelemetryRepo,
  type ToolUsageQuery,
} from './telemetry-repo.js';

export interface CreateSqliteUsageStoreOptions {}

export function createSqliteTelemetryRepo(
  workspaceRoot: string,
  options: CreateTelemetryRepoOptions & CreateSqliteUsageStoreOptions = {},
): TelemetryRepo {
  return new SqliteTelemetryRepo(
    workspaceRoot,
    options.createIfMissing ?? true,
    options.managePricing ?? true,
  );
}

export function createSqlitePricingStore(
  workspaceRoot: string,
  options: CreatePricingStoreOptions & CreateSqliteUsageStoreOptions = {},
): PricingStore {
  return new SqlitePricingStore(workspaceRoot, options.createIfMissing ?? true);
}

class SqliteTelemetryRepo implements TelemetryRepo {
  readonly #root: string;
  readonly #lease: OperationalStateDatabaseLease;
  readonly #pricingStore: PricingStore | undefined;
  #loaded = false;
  #state: 'open' | 'draining' | 'closed' = 'open';
  #queue: Promise<void> = Promise.resolve();
  #loadPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(workspaceRoot: string, createIfMissing: boolean, managePricing: boolean) {
    this.#root = resolve(workspaceRoot);
    this.#lease = acquireOperationalStateDatabase(this.#root);
    this.#pricingStore = managePricing
      ? createSqlitePricingStore(this.#root, { createIfMissing })
      : undefined;
  }

  load(): Promise<void> {
    if (this.#loaded) return Promise.resolve();
    this.assertOpen();
    if (this.#loadPromise) return this.#loadPromise;
    const operation = (async () => {
      if (this.#pricingStore) await this.#pricingStore.load();
      this.#loaded = true;
    })();
    this.#loadPromise = operation;
    void operation.catch(() => {
      if (this.#state === 'open' && this.#loadPromise === operation) {
        this.#loadPromise = undefined;
      }
    });
    return operation;
  }

  insertLlmCall(record: PersistedLlmCallRecord): Promise<void> {
    let admitted: PersistedLlmCallRecord;
    try {
      admitted = decodePersistedLlmCallRecord(record);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueueMutation(() => {
      this.#lease.database
        .prepare(`
          INSERT INTO usage_llm_calls(storage_key, id, ts, record_json, session_id)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(storage_key) DO UPDATE SET
            id = excluded.id,
            ts = excluded.ts,
            record_json = excluded.record_json,
            session_id = excluded.session_id
        `)
        .run(
          usageIdentityKey(admitted.id),
          admitted.id,
          admitted.ts,
          JSON.stringify(admitted),
          admitted.sessionId ?? null,
        );
    });
  }

  insertToolInvocation(record: PersistedToolInvocationRecord): Promise<void> {
    let admitted: PersistedToolInvocationRecord;
    try {
      admitted = decodePersistedToolInvocationRecord(record);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.enqueueMutation(() => {
      this.#lease.database
        .prepare(`
          INSERT INTO usage_tool_invocations(storage_key, id, ts, record_json)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(storage_key) DO UPDATE SET
            id = excluded.id,
            ts = excluded.ts,
            record_json = excluded.record_json
        `)
        .run(usageIdentityKey(admitted.id), admitted.id, admitted.ts, JSON.stringify(admitted));
    });
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
        cacheRead: sum(
          rows.map((row) => clampCacheReadTokens(row.inputTokens, row.cacheHitInputTokens)),
        ),
        cacheWrite: sum(rows.map((row) => row.cacheWriteInputTokens)),
        reasoning: sum(rows.map((row) => row.reasoningTokens)),
        total: sum(rows.map((row) => row.totalTokens)),
      },
      cacheHitRequests: rows.filter(
        (row) => clampCacheReadTokens(row.inputTokens, row.cacheHitInputTokens) > 0,
      ).length,
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
      const key = usageBucketKey(row, groupBy);
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
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
    return detached({
      rows: rows.slice(offset, offset + limit).map(toUsageLogRow),
      total: rows.length,
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
    return this.requireManagedPricing()
      .snapshot()
      .overrides.map((item) => ({ ...item }));
  }

  async upsertPricing(pricing: PricingConfig): Promise<void> {
    const store = this.requireManagedPricing();
    await store.upsert(store.snapshot().revision, pricing);
  }

  async deletePricing(modelKey: string): Promise<void> {
    const store = this.requireManagedPricing();
    await store.delete(store.snapshot().revision, modelKey);
  }

  async flush(): Promise<void> {
    this.assertLoaded();
    await this.#queue;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#state = 'draining';
    this.#closePromise = Promise.allSettled([
      this.#loadPromise ?? Promise.resolve(),
      this.#queue,
      this.#pricingStore?.close() ?? Promise.resolve(),
    ])
      .then((results) => {
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      })
      .finally(() => {
        this.#state = 'closed';
        this.#lease.close();
      });
    return this.#closePromise;
  }

  private filteredUsageRows(query: UsageQuery, from: number, to: number) {
    return this.readLlmRows(from, to, query.sessionId).filter((row) => {
      if (query.sessionId && row.sessionId !== query.sessionId) return false;
      if (query.connectionSlug && row.connectionSlug !== query.connectionSlug) return false;
      if (query.providerId && row.providerId !== query.providerId) return false;
      if (query.modelId && row.modelId !== query.modelId) return false;
      if (query.status && query.status !== 'all' && row.status !== query.status) return false;
      return true;
    });
  }

  private filteredToolRows(query: UsageQuery | ToolUsageQuery, from: number, to: number) {
    return this.readToolRows().filter((row) => {
      if (row.ts < from || row.ts > to) return false;
      if (query.toolName && row.toolName !== query.toolName) return false;
      if (query.status && query.status !== 'all' && row.status !== query.status) return false;
      return true;
    });
  }

  private readLlmRows(from: number, to: number, sessionId?: string): PersistedLlmCallRecord[] {
    return (
      this.#lease.database
        .prepare(
          sessionId
            ? `SELECT record_json FROM usage_llm_calls
               WHERE session_id = ? AND ts >= ? AND ts <= ?`
            : `SELECT record_json FROM usage_llm_calls
               WHERE ts >= ? AND ts <= ?`,
        )
        .all(...(sessionId ? [sessionId, from, to] : [from, to])) as Array<{
        record_json: string;
      }>
    ).map((row) => decodePersistedLlmCallRecord(JSON.parse(row.record_json)));
  }

  private readToolRows(): PersistedToolInvocationRecord[] {
    return (
      this.#lease.database
        .prepare('SELECT record_json FROM usage_tool_invocations')
        .all() as Array<{ record_json: string }>
    ).map((row) => decodePersistedToolInvocationRecord(JSON.parse(row.record_json)));
  }

  private enqueueMutation(operation: () => void): Promise<void> {
    this.assertReady();
    const accepted = this.#queue.then(() => {
      try {
        this.#lease.transaction('write', operation);
      } catch (cause) {
        throw new TelemetryRepoPublicationError(false, { cause });
      }
    });
    this.#queue = accepted.catch(() => undefined);
    return accepted;
  }

  private requireManagedPricing(): PricingStore {
    this.assertReady();
    if (!this.#pricingStore) {
      throw new Error('Telemetry repository does not own the managed pricing store');
    }
    return this.#pricingStore;
  }

  private assertLoaded(): void {
    if (!this.#loaded) throw new TelemetryRepoNotLoadedError();
  }

  private assertOpen(): void {
    if (this.#state !== 'open') throw new TelemetryRepoClosedError();
  }

  private assertReady(): void {
    this.assertOpen();
    this.assertLoaded();
  }
}

class SqlitePricingStore implements PricingStore {
  readonly #root: string;
  readonly #lease: OperationalStateDatabaseLease;
  #loaded = false;
  #state: 'open' | 'draining' | 'closed' = 'open';
  #queue: Promise<void> = Promise.resolve();
  #loadPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(workspaceRoot: string, createIfMissing: boolean) {
    this.#root = resolve(workspaceRoot);
    this.#lease = acquireOperationalStateDatabase(this.#root);
  }

  load(): Promise<void> {
    if (this.#loaded) return Promise.resolve();
    this.assertOpen();
    if (this.#loadPromise) return this.#loadPromise;
    const operation = Promise.resolve().then(() => {
      this.#loaded = true;
    });
    this.#loadPromise = operation;
    void operation.catch(() => {
      if (this.#state === 'open' && this.#loadPromise === operation) {
        this.#loadPromise = undefined;
      }
    });
    return operation;
  }

  snapshot(): PricingSnapshot {
    this.assertReady();
    return readPricingSnapshot(this.#lease);
  }

  upsert(expectedRevision: number, pricing: PricingConfig): Promise<PricingMutationResult> {
    assertRevision(expectedRevision, 'expectedRevision');
    const normalized = normalizePricingConfig(pricing);
    if (!normalized.ok) throw new PricingValidationError(normalized.error);
    return this.enqueueMutation(expectedRevision, (current) => {
      const existing = current.find((item) => item.modelKey === normalized.value.modelKey);
      if (existing && canonicalPricingConfigsEqual(existing, normalized.value)) return current;
      return [
        ...current.filter((item) => item.modelKey !== normalized.value.modelKey),
        normalized.value,
      ].sort((left, right) => comparePricingModelKeys(left.modelKey, right.modelKey));
    });
  }

  delete(expectedRevision: number, modelKey: string): Promise<PricingMutationResult> {
    assertRevision(expectedRevision, 'expectedRevision');
    const normalized = normalizePricingModelKey(modelKey);
    if (!normalized.ok) throw new PricingValidationError(normalized.error);
    return this.enqueueMutation(expectedRevision, (current) =>
      current.some((item) => item.modelKey === normalized.value)
        ? current.filter((item) => item.modelKey !== normalized.value)
        : current,
    );
  }

  async flush(): Promise<void> {
    this.assertLoaded();
    await this.#queue;
  }

  beginDrain(): Promise<void> {
    if (this.#state === 'open') this.#state = 'draining';
    return this.flush();
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#state = 'draining';
    this.#closePromise = Promise.allSettled([this.#loadPromise ?? Promise.resolve(), this.#queue])
      .then((results) => {
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      })
      .finally(() => {
        this.#state = 'closed';
        this.#lease.close();
      });
    return this.#closePromise;
  }

  private enqueueMutation(
    expectedRevision: number,
    mutate: (current: readonly Readonly<PricingConfig>[]) => readonly Readonly<PricingConfig>[],
  ): Promise<PricingMutationResult> {
    this.assertReady();
    const operation = this.#queue.then(() => {
      try {
        return this.#lease.transaction('write', () => {
          const current = readPricingSnapshot(this.#lease);
          if (current.revision !== expectedRevision) {
            throw new PricingRevisionConflictError(expectedRevision, current.revision);
          }
          const overrides = mutate(current.overrides);
          if (overrides === current.overrides) {
            return { committed: false, changed: false, snapshot: current };
          }
          if (current.revision === Number.MAX_SAFE_INTEGER) {
            throw new PricingValidationError(
              'revision cannot advance beyond Number.MAX_SAFE_INTEGER',
            );
          }
          const revision = current.revision + 1;
          this.#lease.database.prepare('DELETE FROM usage_pricing_overrides').run();
          const insert = this.#lease.database.prepare(`
            INSERT INTO usage_pricing_overrides(model_key, record_json)
            VALUES (?, ?)
          `);
          for (const override of overrides) {
            insert.run(override.modelKey, JSON.stringify(override));
          }
          this.#lease.database
            .prepare('UPDATE usage_pricing_authority SET revision = ? WHERE singleton = 1')
            .run(revision);
          return {
            committed: true,
            changed: true,
            snapshot: freezePricingSnapshot(revision, overrides),
          };
        });
      } catch (error) {
        if (
          error instanceof PricingRevisionConflictError ||
          error instanceof PricingValidationError
        ) {
          throw error;
        }
        throw new PricingStorePublicationError({ cause: error });
      }
    });
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private assertLoaded(): void {
    if (!this.#loaded) throw new PricingStoreNotLoadedError();
  }

  private assertOpen(): void {
    if (this.#state !== 'open') throw new PricingStoreClosedError();
  }

  private assertReady(): void {
    this.assertOpen();
    this.assertLoaded();
  }
}

function readPricingSnapshot(lease: OperationalStateDatabaseLease): PricingSnapshot {
  const authority = lease.database
    .prepare('SELECT revision FROM usage_pricing_authority WHERE singleton = 1')
    .get() as { revision?: unknown } | undefined;
  if (!authority || !Number.isSafeInteger(authority.revision)) {
    throw new PricingValidationError('SQLite pricing authority is missing or invalid');
  }
  const overrides = (
    lease.database
      .prepare('SELECT record_json FROM usage_pricing_overrides ORDER BY model_key')
      .all() as Array<{ record_json: string }>
  ).map((row) => {
    const normalized = normalizePricingConfig(JSON.parse(row.record_json));
    if (!normalized.ok) throw new PricingValidationError(normalized.error);
    return normalized.value;
  });
  return freezePricingSnapshot(authority.revision as number, overrides);
}

function freezePricingSnapshot(
  revision: number,
  overrides: readonly Readonly<PricingConfig>[],
): PricingSnapshot {
  return Object.freeze({
    revision,
    overrides: Object.freeze(overrides.map((value) => Object.freeze({ ...value }))),
  });
}

function countRows(
  database: OperationalStateDatabaseLease['database'],
  table: 'usage_llm_calls' | 'usage_tool_invocations' | 'usage_pricing_overrides',
): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count?: unknown;
  };
  if (!Number.isSafeInteger(row.count)) throw new Error(`Invalid row count for ${table}`);
  return row.count as number;
}

function usageIdentityKey(id: string): string {
  return createHash('sha256').update(JSON.stringify(id)).digest('hex');
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

function usageBucket(key: string, rows: readonly PersistedLlmCallRecord[]): UsageBucket {
  const errors = rows.filter((row) => row.status === 'error').length;
  return {
    key,
    label: key,
    requests: rows.length,
    inputTokens: sum(rows.map((row) => row.inputTokens)),
    outputTokens: sum(rows.map((row) => row.outputTokens)),
    cacheMissTokens: sum(rows.map((row) => row.cacheMissInputTokens)),
    cacheReadTokens: sum(
      rows.map((row) => clampCacheReadTokens(row.inputTokens, row.cacheHitInputTokens)),
    ),
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
    const group = groups.get(row.toolName);
    if (group) group.push(row);
    else groups.set(row.toolName, [row]);
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
  if (Object.keys(query).some((key) => !['range', 'toolName', 'status'].includes(key))) {
    throw new TelemetryQueryValidationError('tool logs accept only range, toolName, and status');
  }
}

function assertRevision(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PricingValidationError(`${label} must be a nonnegative safe integer`);
  }
}

function detached<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}
