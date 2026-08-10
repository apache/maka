import { tryResult } from "@maka/core/result";
import type { UsageRange, UsageStats } from "@maka/core";
import {
  normalizePricingConfig,
  normalizePricingModelKey,
} from "@maka/core/usage-stats/pricing";
import type {
  PricingConfig,
  TimeRange,
  UsageBucket,
  UsageGroupBy,
  UsageQuery,
  UsageSummaryV2,
} from "@maka/core/usage-stats/types";
import type { UsageProvenance } from "@maka/core/usage-ledger-merge";
import type {
  LlmUsageLogProjection,
  ToolUsageLogProjection,
} from "@maka/runtime-host/protocol";
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
  tryReconnectableReadResult,
} from "./ipc-reconnect-policy.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";

interface RuntimeHostUsageIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: DesktopRuntimeHostClient;
  readonly sendToRenderer: (channel: string, ...args: unknown[]) => void;
  readonly now?: () => number;
}

const PAGE_LIMIT = 100;
const SNAPSHOT_ATTEMPTS = 3;
type UsageTimeWindow = Extract<TimeRange, { from: number; to: number }>;

class UsageSnapshotChangedError extends Error {}

export function registerRuntimeHostUsageIpc(
  deps: RuntimeHostUsageIpcDeps,
): void {
  let pricingMutationQueue: Promise<void> = Promise.resolve();
  const enqueuePricingMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pricingMutationQueue.then(operation);
    pricingMutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  handleReconnectableRead(
    deps.ipcMain,
    "settings:usageStats",
    (_event, range: UsageRange = "24h") =>
      loadUsageStatsSnapshot(deps.client, range, deps.now?.() ?? Date.now()),
  );

  handleReconnectableRead(
    deps.ipcMain,
    "usage:summary",
    (_event, query: UsageQuery) =>
      tryReconnectableReadResult(async () => {
        const result = await deps.client.queryUsage({
          kind: "summary",
          query: toLlmQuery(query),
        });
        if (result.kind !== "summary") throw invalidUsageProjection();
        return { ...result.summary, provenance: result.provenance };
      }, "USAGE_SUMMARY_FAILED"),
  );
  handleReconnectableRead(
    deps.ipcMain,
    "usage:buckets",
    (_event, query: UsageQuery & { groupBy: UsageGroupBy }) =>
      tryReconnectableReadResult(
        () => loadAllBuckets(deps.client, query).then((result) => result.buckets),
        "USAGE_BUCKETS_FAILED",
      ),
  );
  handleReconnectableRead(
    deps.ipcMain,
    "usage:logs",
    (
      _event,
      query: UsageQuery & { offset?: number; limit?: number },
    ) =>
      tryReconnectableReadResult(async () => {
        const result = await deps.client.queryUsage({
          kind: "logs",
          source: "llm",
          query: toLlmQuery(query),
          offset: query.offset,
          limit: query.limit,
        });
        if (result.kind !== "logs" || result.source !== "llm")
          throw invalidUsageProjection();
        return {
          rows: result.rows,
          total: result.total,
          provenance: result.provenance,
        };
      }, "USAGE_LOGS_FAILED"),
  );
  handleReconnectableRead(deps.ipcMain, "usage:pricing:list", () =>
    tryReconnectableReadResult(async () => {
      const snapshot = await deps.client.loadPricingSnapshot();
      return snapshot.entries
        .filter((entry) => entry.source === "custom")
        .map((entry) => entry.pricing);
    }, "USAGE_PRICING_LIST_FAILED"),
  );
  deps.ipcMain.handle("usage:pricing:put", (_event, pricing: unknown) =>
    tryResult(
      () =>
        enqueuePricingMutation(async () => {
          const normalized = normalizePricingConfig(pricing);
          if (!normalized.ok) throw new Error(normalized.error);
          await applyPricingMutation(deps.client, {
            kind: "upsert",
            pricing: normalized.value,
          });
          deps.sendToRenderer("usage:pricing:changed");
          return normalized.value;
        }),
      "USAGE_PRICING_PUT_FAILED",
    ),
  );
  deps.ipcMain.handle("usage:pricing:reset", (_event, modelKey: unknown) =>
    tryResult(
      () =>
        enqueuePricingMutation(async () => {
          const normalized = normalizePricingModelKey(modelKey);
          if (!normalized.ok) throw new Error(normalized.error);
          await applyPricingMutation(deps.client, {
            kind: "delete",
            modelKey: normalized.value,
          });
          deps.sendToRenderer("usage:pricing:changed");
        }),
      "USAGE_PRICING_RESET_FAILED",
    ),
  );
}

async function loadAllBuckets(
  client: DesktopRuntimeHostClient,
  query: UsageQuery & { groupBy: UsageGroupBy },
): Promise<{ buckets: UsageBucket[]; provenance: UsageProvenance }> {
  const buckets: UsageBucket[] = [];
  let offset = 0;
  let total: number | undefined;
  let provenance: UsageProvenance | undefined;
  while (true) {
    const result = await client.queryUsage(
      query.groupBy === "tool"
        ? {
            kind: "buckets",
            query: toToolQuery(query),
            groupBy: "tool",
            offset,
            limit: PAGE_LIMIT,
          }
        : {
            kind: "buckets",
            query: toLlmQuery(query),
            groupBy: query.groupBy,
            offset,
            limit: PAGE_LIMIT,
          },
    );
    if (result.kind !== "buckets" || result.offset !== offset)
      throw invalidUsageProjection();
    if (
      (total !== undefined && total !== result.total) ||
      (provenance && !sameProvenance(provenance, result.provenance))
    ) {
      throw new UsageSnapshotChangedError();
    }
    total = result.total;
    provenance = result.provenance;
    buckets.push(...result.buckets);
    if (result.nextOffset === null) {
      if (buckets.length !== result.total) throw new UsageSnapshotChangedError();
      return { buckets, provenance: result.provenance };
    }
    if (result.nextOffset <= offset) throw invalidUsageProjection();
    offset = result.nextOffset;
  }
}

async function loadUsageStatsSnapshot(
  client: DesktopRuntimeHostClient,
  range: UsageRange,
  now: number,
): Promise<UsageStats> {
  const query = { range: usageRangeWindow(range, now) } satisfies UsageQuery;
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    let results;
    try {
      results = await Promise.all([
        client.queryUsage({ kind: "summary", query }),
        loadAllBuckets(client, { ...query, groupBy: "provider" }),
        loadAllBuckets(client, { ...query, groupBy: "model" }),
        loadAllLlmLogs(client, query),
        loadAllToolLogs(client, query),
      ]);
    } catch (error) {
      if (error instanceof UsageSnapshotChangedError) continue;
      throw error;
    }
    const [summaryResult, providerResult, modelResult, llmResult, toolResult] = results;
    if (summaryResult.kind !== "summary") throw invalidUsageProjection();
    if (
      sameUsageSnapshot(
        query.range,
        summaryResult.summary,
        summaryResult.provenance,
        providerResult,
        modelResult,
        llmResult,
      )
    ) {
      return projectUsageStats(
        summaryResult.summary,
        summaryResult.provenance,
        providerResult.buckets,
        modelResult.buckets,
        llmResult.rows,
        toolResult.rows,
      );
    }
  }
  throw new Error("Runtime Host Usage changed while Desktop read it");
}

async function loadAllLlmLogs(
  client: DesktopRuntimeHostClient,
  query: UsageQuery,
): Promise<{
  rows: LlmUsageLogProjection[];
  total: number;
  provenance: UsageProvenance;
}> {
  const rows: LlmUsageLogProjection[] = [];
  let offset = 0;
  let total: number | undefined;
  let provenance: UsageProvenance | undefined;
  while (true) {
    const result = await client.queryUsage({
      kind: "logs",
      source: "llm",
      query: toLlmQuery(query),
      offset,
      limit: PAGE_LIMIT,
    });
    if (result.kind !== "logs" || result.source !== "llm" || result.offset !== offset)
      throw invalidUsageProjection();
    if (
      (total !== undefined && total !== result.total) ||
      (provenance && !sameProvenance(provenance, result.provenance))
    ) {
      throw new UsageSnapshotChangedError();
    }
    provenance = result.provenance;
    total = result.total;
    rows.push(...result.rows);
    if (result.nextOffset === null) {
      if (rows.length !== result.total) throw new UsageSnapshotChangedError();
      return { rows, total: result.total, provenance: result.provenance };
    }
    if (result.nextOffset <= offset) throw invalidUsageProjection();
    offset = result.nextOffset;
  }
}

async function loadAllToolLogs(
  client: DesktopRuntimeHostClient,
  query: UsageQuery,
): Promise<{ rows: ToolUsageLogProjection[]; total: number }> {
  const rows: ToolUsageLogProjection[] = [];
  let offset = 0;
  let total: number | undefined;
  while (true) {
    const result = await client.queryUsage({
      kind: "logs",
      source: "tool",
      query: toToolQuery(query),
      offset,
      limit: PAGE_LIMIT,
    });
    if (result.kind !== "logs" || result.source !== "tool" || result.offset !== offset)
      throw invalidUsageProjection();
    if (total !== undefined && total !== result.total)
      throw new UsageSnapshotChangedError();
    total = result.total;
    rows.push(...result.rows);
    if (result.nextOffset === null) {
      if (rows.length !== result.total) throw new UsageSnapshotChangedError();
      return { rows, total: result.total };
    }
    if (result.nextOffset <= offset) throw invalidUsageProjection();
    offset = result.nextOffset;
  }
}

function sameUsageSnapshot(
  expectedRange: UsageTimeWindow,
  summary: { readonly range: { readonly from: number; readonly to: number }; readonly totalRequests: number },
  provenance: UsageProvenance,
  providers: { readonly buckets: readonly UsageBucket[]; readonly provenance: UsageProvenance },
  models: { readonly buckets: readonly UsageBucket[]; readonly provenance: UsageProvenance },
  logs: { readonly total: number; readonly provenance: UsageProvenance },
): boolean {
  return (
    summary.range.from === expectedRange.from &&
    summary.range.to === expectedRange.to &&
    summary.totalRequests === logs.total &&
    summary.totalRequests === sumRequests(providers.buckets) &&
    summary.totalRequests === sumRequests(models.buckets) &&
    sameProvenance(provenance, providers.provenance) &&
    sameProvenance(provenance, models.provenance) &&
    sameProvenance(provenance, logs.provenance)
  );
}

function sameProvenance(left: UsageProvenance, right: UsageProvenance): boolean {
  return (
    left.legacyRecords === right.legacyRecords &&
    left.unreadableRecords === right.unreadableRecords &&
    left.pendingRepairs === right.pendingRepairs &&
    left.coverage.attempts === right.coverage.attempts &&
    left.coverage.pricedAttempts === right.coverage.pricedAttempts &&
    left.coverage.unpricedAttempts === right.coverage.unpricedAttempts &&
    left.coverage.usageReportedAttempts === right.coverage.usageReportedAttempts &&
    left.coverage.usagePartialAttempts === right.coverage.usagePartialAttempts &&
    left.coverage.usageMissingAttempts === right.coverage.usageMissingAttempts
  );
}

function sumRequests(buckets: readonly UsageBucket[]): number {
  return buckets.reduce((total, bucket) => total + bucket.requests, 0);
}

function projectUsageStats(
  summary: UsageSummaryV2,
  provenance: UsageProvenance,
  providerBuckets: readonly UsageBucket[],
  modelBuckets: readonly UsageBucket[],
  llmRows: readonly LlmUsageLogProjection[],
  toolRows: readonly ToolUsageLogProjection[],
): UsageStats {
  return {
    provenance,
    summary: {
      totalRequests: summary.totalRequests,
      totalCostUsd: summary.totalCostUsd,
      totalTokens: summary.totalTokens.total,
      inputTokens: summary.totalTokens.input,
      outputTokens: summary.totalTokens.output,
      cacheTokens: summary.totalTokens.cacheRead + summary.totalTokens.cacheWrite,
      cacheMiss: summary.totalTokens.cacheMiss,
      cacheRead: summary.totalTokens.cacheRead,
      cacheCreation: summary.totalTokens.cacheWrite,
      reasoning: summary.totalTokens.reasoning,
    },
    logs: [
      ...llmRows.map((row) => ({
        id: row.id,
        ts: row.ts,
        kind: "model" as const,
        ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
        ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
        provider: row.connectionSlug ?? row.providerId,
        model: row.modelId,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheMiss: row.cacheMissTokens,
        cacheRead: row.cacheReadTokens,
        cacheCreation: row.cacheWriteTokens,
        reasoning: row.reasoningTokens,
        ...(row.usageBasis === undefined ? {} : { usageBasis: row.usageBasis }),
        ...(row.costUsd === undefined ? {} : { costUsd: row.costUsd }),
        ...(row.costBasis === undefined ? {} : { costBasis: row.costBasis }),
        latencyMs: row.latencyMs,
        status: row.status,
      })),
      ...toolRows.map((row) => ({
        id: row.id,
        ts: row.ts,
        kind: "tool" as const,
        ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
        ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
        provider: row.providerId ?? "",
        model: row.modelId ?? "",
        toolName: row.toolName,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: row.durationMs,
        status: row.status,
      })),
    ].sort((left, right) => right.ts - left.ts),
    byProvider: providerBuckets.map((bucket) => ({
      provider: bucket.label,
      ...projectLlmBucketValues(bucket),
    })),
    byModel: modelBuckets.map((bucket) => ({
      model: bucket.label,
      ...projectLlmBucketValues(bucket),
    })),
    byTool: projectToolBuckets(toolRows),
    pricing: [],
  };
}

function projectLlmBucketValues(bucket: UsageBucket) {
  return {
    requests: bucket.requests,
    tokens: bucket.totalTokens,
    costUsd: bucket.costUsd,
  };
}

function projectToolBuckets(rows: readonly ToolUsageLogProjection[]): UsageStats["byTool"] {
  const buckets = new Map<
    string,
    { calls: number; success: number; errors: number; aborted: number; durationMs: number }
  >();
  for (const row of rows) {
    const bucket = buckets.get(row.toolName) ?? {
      calls: 0,
      success: 0,
      errors: 0,
      aborted: 0,
      durationMs: 0,
    };
    bucket.calls += 1;
    bucket[row.status === "error" ? "errors" : row.status] += 1;
    bucket.durationMs += row.durationMs;
    buckets.set(row.toolName, bucket);
  }
  return [...buckets.entries()]
    .map(([tool, bucket]) => ({
      tool,
      calls: bucket.calls,
      success: bucket.success,
      errors: bucket.errors,
      aborted: bucket.aborted,
      avgDurationMs: bucket.calls === 0 ? 0 : Math.round(bucket.durationMs / bucket.calls),
    }))
    .sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool));
}

function usageRangeWindow(range: UsageRange, now: number): UsageTimeWindow {
  if (range === "all") return { from: 0, to: now };
  const spans = {
    "24h": 24 * 60 * 60 * 1_000,
    "7d": 7 * 24 * 60 * 60 * 1_000,
    "30d": 30 * 24 * 60 * 60 * 1_000,
  } satisfies Record<Exclude<UsageRange, "all">, number>;
  return { from: now - spans[range], to: now };
}

function toLlmQuery(query: UsageQuery) {
  const { toolName: _toolName, ...llmQuery } = query;
  return llmQuery;
}

function toToolQuery(query: UsageQuery) {
  return {
    range: query.range,
    ...(query.toolName === undefined ? {} : { toolName: query.toolName }),
    ...(query.status === undefined ? {} : { status: query.status }),
  };
}

async function applyPricingMutation(
  client: DesktopRuntimeHostClient,
  mutation:
    | { readonly kind: "upsert"; readonly pricing: PricingConfig }
    | { readonly kind: "delete"; readonly modelKey: string },
): Promise<void> {
  const outcome = await client.applyPricingMutation({
    base: await client.loadPricingSnapshot(),
    mutation,
  });
  if (
    outcome.kind === "saved" ||
    outcome.kind === "saved_refresh_failed" ||
    outcome.kind === "synchronized"
  ) {
    return;
  }
  throw new Error("Pricing changed concurrently; reload it before retrying");
}

function invalidUsageProjection(): Error {
  return new Error("Runtime Host returned an invalid Usage projection");
}
