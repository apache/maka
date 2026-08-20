import { tryResult } from "@maka/core/result";
import { randomUUID } from "node:crypto";
import type { UsageRange, UsageStats } from "@maka/core/settings";
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
import { RuntimeHostOperationError } from "@maka/runtime-host/client";
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
  tryReconnectableReadResult,
} from "./ipc-reconnect-policy.js";
import type {
  DesktopPricingSnapshot,
  DesktopRuntimeHostClient,
} from "./runtime-host-client.js";
import {
  desktopSessionKey,
  type DesktopHostRef,
} from "../shared/runtime-host-identity.js";

interface RuntimeHostUsageIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: DesktopRuntimeHostClient;
  readonly host: DesktopHostRef;
  readonly sendToRenderer: (channel: string, ...args: unknown[]) => void;
  readonly now?: () => number;
}

const PAGE_LIMIT = 100;
const SNAPSHOT_ATTEMPTS = 3;
/**
 * Hard bound on log paging inside one Usage snapshot: the requests table is a
 * diagnostic view, so a snapshot pulls at most this many pages (newest first)
 * per log source instead of walking an unbounded history. Aggregates
 * (summary, provider/model buckets, tool buckets) always cover the full
 * window regardless of this cap.
 */
const MAX_LOG_PAGES = 5;
type UsageTimeWindow = Extract<TimeRange, { from: number; to: number }>;

class UsageSnapshotChangedError extends Error {}

/**
 * The Host's per-page revision fence exhausts into this typed outcome when
 * ordinary write traffic keeps the Usage authority moving. It is the same
 * condition the Desktop detects locally as UsageSnapshotChangedError, so the
 * whole-snapshot retry below folds both into one policy.
 */
function isUsageRevisionChangedOutcome(error: unknown): boolean {
  return (
    error instanceof RuntimeHostOperationError && error.code === "usage_revision_changed"
  );
}

export function registerRuntimeHostUsageIpc(
  deps: RuntimeHostUsageIpcDeps,
): void {
  let pricingMutationQueue: Promise<void> = Promise.resolve();
  const enqueuePricingMutation = <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
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
      loadUsageStatsSnapshot(
        deps.client,
        deps.host,
        range,
        deps.now?.() ?? Date.now(),
      ),
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
        () =>
          loadAllBuckets(deps.client, query, randomUUID()).then(
            (result) => result.buckets,
          ),
        "USAGE_BUCKETS_FAILED",
      ),
  );
  handleReconnectableRead(
    deps.ipcMain,
    "usage:logs",
    (_event, query: UsageQuery & { offset?: number; limit?: number }) =>
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
      return customPricingEntries(snapshot.entries).map(
        (entry) => entry.pricing,
      );
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

interface UsagePage {
  readonly offset: number;
  readonly total: number;
  readonly nextOffset: number | null;
  readonly revision: number;
  readonly provenance?: UsageProvenance;
}

interface PagedUsageProjection<TItem> {
  readonly items: readonly TItem[];
  readonly total: number;
  readonly revision: number;
  readonly provenance: UsageProvenance | undefined;
  readonly truncated: boolean;
}

/**
 * The one paging loop every Usage view shares. Pages of one view must agree
 * on total, revision, and (when the view carries it) provenance; a
 * disagreement means the Usage authority moved mid-read, and the caller
 * retries the whole snapshot. `maxPages` bounds the log views (diagnostic
 * rows); bucket views stay unbounded because their size is the number of
 * distinct providers/models/tools, not the number of recorded calls.
 */
async function loadUsagePages<TItem, TPage extends UsagePage>(
  fetchPage: (offset: number) => Promise<TPage>,
  readItems: (page: TPage) => readonly TItem[],
  maxPages?: number,
): Promise<PagedUsageProjection<TItem>> {
  const items: TItem[] = [];
  let offset = 0;
  let total: number | undefined;
  let revision: number | undefined;
  let provenance: UsageProvenance | undefined;
  for (let pageCount = 1; ; pageCount += 1) {
    const page = await fetchPage(offset);
    if (
      (total !== undefined && total !== page.total) ||
      (revision !== undefined && revision !== page.revision) ||
      (provenance !== undefined &&
        page.provenance !== undefined &&
        !sameProvenance(provenance, page.provenance))
    ) {
      throw new UsageSnapshotChangedError();
    }
    total = page.total;
    revision = page.revision;
    provenance = page.provenance ?? provenance;
    items.push(...readItems(page));
    if (page.nextOffset === null) {
      if (items.length !== page.total) throw new UsageSnapshotChangedError();
      return {
        items,
        total: page.total,
        revision: page.revision,
        provenance,
        truncated: false,
      };
    }
    if (page.nextOffset <= offset) throw invalidUsageProjection();
    if (maxPages !== undefined && pageCount >= maxPages) {
      return {
        items,
        total: page.total,
        revision: page.revision,
        provenance,
        truncated: true,
      };
    }
    offset = page.nextOffset;
  }
}

function loadAllBuckets(
  client: DesktopRuntimeHostClient,
  query: UsageQuery & { groupBy: UsageGroupBy },
  snapshot: string,
): Promise<{ buckets: readonly UsageBucket[]; provenance: UsageProvenance; revision: number }> {
  return loadUsagePages(
    async (offset) => {
      const result = await client.queryUsage(
        query.groupBy === "tool"
          ? {
              kind: "buckets",
              query: toToolQuery(query),
              groupBy: "tool",
              offset,
              limit: PAGE_LIMIT,
              snapshot,
            }
          : {
              kind: "buckets",
              query: toLlmQuery(query),
              groupBy: query.groupBy,
              offset,
              limit: PAGE_LIMIT,
              snapshot,
            },
      );
      if (result.kind !== "buckets") throw invalidUsageProjection();
      return result;
    },
    (page) => page.buckets,
  ).then((page) => {
    if (page.provenance === undefined) throw invalidUsageProjection();
    return {
      buckets: page.items,
      provenance: page.provenance,
      revision: page.revision,
    };
  });
}

export async function loadUsageStatsSnapshot(
  client: DesktopRuntimeHostClient,
  host: DesktopHostRef,
  range: UsageRange,
  now: number,
): Promise<UsageStats> {
  const query = { range: usageRangeWindow(range, now) } satisfies UsageQuery;
  // One ticket per snapshot load pins the Host's bounded repair pass across
  // every view and every page below: a paginating reader must never trigger a
  // fresh pass, because its writes would advance the revision mid-snapshot
  // and trip the cross-page guards.
  const snapshot = randomUUID();
  for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
    let results;
    try {
      results = await Promise.all([
        client.queryUsage({ kind: "summary", query, snapshot }),
        loadAllBuckets(client, { ...query, groupBy: "provider" }, snapshot),
        loadAllBuckets(client, { ...query, groupBy: "model" }, snapshot),
        loadAllBuckets(client, { ...query, groupBy: "tool" }, snapshot),
        loadAllLlmLogs(client, query, snapshot),
        loadAllToolLogs(client, query, snapshot),
        client.loadPricingSnapshot(),
      ]);
    } catch (error) {
      if (error instanceof UsageSnapshotChangedError) continue;
      // The Host's per-page fence exhausted under ordinary write traffic;
      // that is the same condition as a locally observed revision change.
      if (isUsageRevisionChangedOutcome(error)) continue;
      throw error;
    }
    const [
      summaryResult,
      providerResult,
      modelResult,
      toolBucketResult,
      llmResult,
      toolResult,
      pricingSnapshot,
    ] = results;
    if (summaryResult.kind !== "summary") throw invalidUsageProjection();
    if (
      sameUsageSnapshot(
        query.range,
        summaryResult.revision,
        summaryResult.summary,
        summaryResult.provenance,
        providerResult,
        modelResult,
        toolBucketResult,
        llmResult,
        toolResult,
      )
    ) {
      return projectUsageStats(
        host,
        summaryResult.summary,
        summaryResult.provenance,
        providerResult.buckets,
        modelResult.buckets,
        toolBucketResult.buckets,
        llmResult.rows,
        toolResult.rows,
        llmResult.total + toolResult.total,
        llmResult.truncated || toolResult.truncated,
        projectCustomPricingRows(pricingSnapshot.entries),
      );
    }
  }
  throw new Error("Runtime Host Usage changed while Desktop read it");
}

function loadAllLlmLogs(
  client: DesktopRuntimeHostClient,
  query: UsageQuery,
  snapshot: string,
): Promise<{
  rows: readonly LlmUsageLogProjection[];
  total: number;
  provenance: UsageProvenance;
  revision: number;
  truncated: boolean;
}> {
  return loadUsagePages(
    async (offset) => {
      const result = await client.queryUsage({
        kind: "logs",
        source: "llm",
        query: toLlmQuery(query),
        offset,
        limit: PAGE_LIMIT,
        snapshot,
      });
      if (result.kind !== "logs" || result.source !== "llm")
        throw invalidUsageProjection();
      return result;
    },
    (page) => page.rows,
    MAX_LOG_PAGES,
  ).then((page) => {
    if (page.provenance === undefined) throw invalidUsageProjection();
    return {
      rows: page.items,
      total: page.total,
      provenance: page.provenance,
      revision: page.revision,
      truncated: page.truncated,
    };
  });
}

function loadAllToolLogs(
  client: DesktopRuntimeHostClient,
  query: UsageQuery,
  snapshot: string,
): Promise<{
  rows: readonly ToolUsageLogProjection[];
  total: number;
  revision: number;
  truncated: boolean;
}> {
  return loadUsagePages(
    async (offset) => {
      const result = await client.queryUsage({
        kind: "logs",
        source: "tool",
        query: toToolQuery(query),
        offset,
        limit: PAGE_LIMIT,
        snapshot,
      });
      if (result.kind !== "logs" || result.source !== "tool")
        throw invalidUsageProjection();
      return result;
    },
    (page) => page.rows,
    MAX_LOG_PAGES,
  ).then((page) => ({
    rows: page.items,
    total: page.total,
    revision: page.revision,
    truncated: page.truncated,
  }));
}

function sameUsageSnapshot(
  expectedRange: UsageTimeWindow,
  revision: number,
  summary: {
    readonly range: { readonly from: number; readonly to: number };
  },
  provenance: UsageProvenance,
  providers: {
    readonly provenance: UsageProvenance;
    readonly revision: number;
  },
  models: {
    readonly provenance: UsageProvenance;
    readonly revision: number;
  },
  toolBuckets: { readonly revision: number },
  logs: { readonly provenance: UsageProvenance; readonly revision: number },
  tools: { readonly revision: number },
): boolean {
  // Revision equality across every view is the consistency guarantee; the
  // summary range pins the window. Row-count cross-sums are intentionally not
  // re-checked here: they follow from one revision, and the log views may be
  // page-capped while the aggregate views always cover the full window.
  return (
    revision === providers.revision &&
    revision === models.revision &&
    revision === toolBuckets.revision &&
    revision === logs.revision &&
    revision === tools.revision &&
    summary.range.from === expectedRange.from &&
    summary.range.to === expectedRange.to &&
    sameProvenance(provenance, providers.provenance) &&
    sameProvenance(provenance, models.provenance) &&
    sameProvenance(provenance, logs.provenance)
  );
}

function sameProvenance(
  left: UsageProvenance,
  right: UsageProvenance,
): boolean {
  return (
    left.legacyRecords === right.legacyRecords &&
    left.unreadableRecords === right.unreadableRecords &&
    left.pendingRepairs === right.pendingRepairs &&
    left.coverage.attempts === right.coverage.attempts &&
    left.coverage.pricedAttempts === right.coverage.pricedAttempts &&
    left.coverage.unpricedAttempts === right.coverage.unpricedAttempts &&
    left.coverage.usageReportedAttempts ===
      right.coverage.usageReportedAttempts &&
    left.coverage.usagePartialAttempts ===
      right.coverage.usagePartialAttempts &&
    left.coverage.usageMissingAttempts === right.coverage.usageMissingAttempts
  );
}

function projectUsageStats(
  host: DesktopHostRef,
  summary: UsageSummaryV2,
  provenance: UsageProvenance,
  providerBuckets: readonly UsageBucket[],
  modelBuckets: readonly UsageBucket[],
  toolBuckets: readonly UsageBucket[],
  llmRows: readonly LlmUsageLogProjection[],
  toolRows: readonly ToolUsageLogProjection[],
  logsTotal: number,
  logsTruncated: boolean,
  pricing: UsageStats["pricing"],
): UsageStats {
  return {
    provenance,
    summary: {
      totalRequests: summary.totalRequests,
      totalCostUsd: summary.totalCostUsd,
      totalTokens: summary.totalTokens.total,
      inputTokens: summary.totalTokens.input,
      outputTokens: summary.totalTokens.output,
      cacheTokens:
        summary.totalTokens.cacheRead + summary.totalTokens.cacheWrite,
      cacheMiss: summary.totalTokens.cacheMiss,
      cacheRead: summary.totalTokens.cacheRead,
      cacheCreation: summary.totalTokens.cacheWrite,
      reasoning: summary.totalTokens.reasoning,
    },
    logsTotal,
    logsTruncated,
    logs: [
      ...llmRows.map((row) => ({
        id: row.id,
        ts: row.ts,
        kind: "model" as const,
        ...(row.sessionId === undefined
          ? {}
          : {
              sessionId: desktopSessionKey({
                hostId: host.hostId,
                sessionId: row.sessionId,
              }),
            }),
        ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
        provider: row.connectionSlug ?? row.providerId,
        model: row.modelId,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        // The stored canonical total (derived rows normalized at the Host's
        // read boundary) so the request row reconciles with the summary and
        // provider totals this same row feeds.
        totalTokens: row.totalTokens,
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
        ...(row.sessionId === undefined
          ? {}
          : {
              sessionId: desktopSessionKey({
                hostId: host.hostId,
                sessionId: row.sessionId,
              }),
            }),
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
    byTool: projectToolBuckets(toolBuckets),
    pricing,
  };
}

/** The `usage:pricing:list` handler and the snapshot projection share one
 * custom-source filter so the two list paths cannot drift. */
function customPricingEntries(
  entries: DesktopPricingSnapshot["entries"],
): DesktopPricingSnapshot["entries"] {
  return entries.filter((entry) => entry.source === "custom");
}

function projectCustomPricingRows(
  entries: DesktopPricingSnapshot["entries"],
): UsageStats["pricing"] {
  return customPricingEntries(entries).map((entry) => {
    const separator = entry.pricing.modelKey.indexOf(":");
    return {
      provider:
        separator > 0
          ? entry.pricing.modelKey.slice(0, separator)
          : entry.pricing.modelKey,
      model:
        separator >= 0 ? entry.pricing.modelKey.slice(separator + 1) : "",
      inputPerMTokUsd: entry.pricing.inputUsdPer1M,
      outputPerMTokUsd: entry.pricing.outputUsdPer1M,
    };
  });
}

function projectLlmBucketValues(bucket: UsageBucket) {
  return {
    requests: bucket.requests,
    tokens: bucket.totalTokens,
    costUsd: bucket.costUsd,
  };
}

/**
 * The tool table is the Host's own `groupBy: 'tool'` aggregate — the Desktop
 * no longer recomputes it from every tool row, which is what bounded the log
 * paging above. `avgLatencyMs` is the bucketed average invocation duration.
 */
function projectToolBuckets(
  buckets: readonly UsageBucket[],
): UsageStats["byTool"] {
  return buckets
    .map((bucket) => ({
      tool: bucket.label,
      calls: bucket.requests,
      success: bucket.successCount ?? 0,
      errors: bucket.errorCount ?? 0,
      aborted: bucket.abortedCount ?? 0,
      avgDurationMs: Math.round(bucket.avgLatencyMs),
    }))
    .sort(
      (left, right) =>
        right.calls - left.calls || left.tool.localeCompare(right.tool),
    );
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
