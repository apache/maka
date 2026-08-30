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

import { resolveUsageRange } from "@maka/core/model-call-usage-projection";
import { tryResult } from "@maka/core/result";
import type { UsageRange, UsageStats } from "@maka/core/settings";
import {
  normalizePricingConfig,
  normalizePricingModelKey,
} from "@maka/core/usage-stats/pricing";
import type {
  PricingConfig,
  TimeRange,
  UsageGroupBy,
  UsageQuery,
} from "@maka/core/usage-stats/types";
import {
  USAGE_PAGE_MAX_ITEMS,
  type LlmUsageLogProjection,
  type ToolUsageLogProjection,
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
}

const MAX_ACTIVITY_RECORDS = 50_000;

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
      loadUsageStats(deps.client, normalizeUsageRange(range)),
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
        () => loadAllBuckets(deps.client, query),
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

async function loadUsageStats(
  client: DesktopRuntimeHostClient,
  range: UsageRange,
): Promise<UsageStats> {
  const query = { range: resolveUsageRange(range, Date.now()) } satisfies UsageQuery;
  const [summaryResult, llmResult, toolResult, pricing] = await Promise.all([
    client.queryUsage({ kind: "summary", query }),
    loadAllLogs(client, "llm", query),
    loadAllLogs(client, "tool", query),
    client.loadPricingSnapshot(),
  ]);
  if (summaryResult.kind !== "summary") throw invalidUsageProjection();
  const llmLogs = llmResult.rows;
  const toolLogs = toolResult.rows;
  const logsTruncated = llmResult.truncated || toolResult.truncated;
  // The canonical summary is the authoritative headline count. We no longer
  // throw when it disagrees with the number of activity rows we managed to
  // load: a Host restart with pending repairs can make the summary read land
  // before a catch-up commits and the logs read land after, and truncation
  // (above) deliberately shortens the list. Either way the summary total stays
  // correct; `provenance`/`logsTruncated` tell the page the activity list may
  // be incomplete instead of erroring the whole page.

  return {
    summary: {
      totalRequests: summaryResult.summary.totalRequests,
      totalCostUsd: summaryResult.summary.totalCostUsd,
      totalTokens: summaryResult.summary.totalTokens.total,
      inputTokens: summaryResult.summary.totalTokens.input,
      outputTokens: summaryResult.summary.totalTokens.output,
      cacheTokens:
        summaryResult.summary.totalTokens.cacheRead +
        summaryResult.summary.totalTokens.cacheWrite,
      cacheMiss: summaryResult.summary.totalTokens.cacheMiss,
      cacheRead: summaryResult.summary.totalTokens.cacheRead,
      cacheCreation: summaryResult.summary.totalTokens.cacheWrite,
      reasoning: summaryResult.summary.totalTokens.reasoning,
    },
    logs: [...llmLogs.map(projectLlmLog), ...toolLogs.map(projectToolLog)].sort(
      (left, right) => right.ts - left.ts,
    ),
    byProvider: aggregateModelLogs(llmLogs, "provider"),
    byModel: aggregateModelLogs(llmLogs, "model"),
    byTool: aggregateToolLogs(toolLogs),
    pricing: pricing.entries
      .filter((entry) => entry.source === "custom")
      .map(({ pricing: entry }) => projectPricing(entry))
      .sort(
        (left, right) =>
          left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model),
      ),
    provenance: summaryResult.provenance,
    ...(logsTruncated ? { logsTruncated: true } : {}),
  };
}

async function loadAllLogs(
  client: DesktopRuntimeHostClient,
  source: "llm",
  query: UsageQuery & { range: TimeRange },
): Promise<{ rows: LlmUsageLogProjection[]; truncated: boolean }>;
async function loadAllLogs(
  client: DesktopRuntimeHostClient,
  source: "tool",
  query: UsageQuery & { range: TimeRange },
): Promise<{ rows: ToolUsageLogProjection[]; truncated: boolean }>;
async function loadAllLogs(
  client: DesktopRuntimeHostClient,
  source: "llm" | "tool",
  query: UsageQuery & { range: TimeRange },
): Promise<{
  rows: Array<LlmUsageLogProjection | ToolUsageLogProjection>;
  truncated: boolean;
}> {
  const rows: Array<LlmUsageLogProjection | ToolUsageLogProjection> = [];
  let offset = 0;
  let total: number | undefined;
  while (true) {
    const result = await client.queryUsage(
      source === "llm"
        ? {
            kind: "logs",
            source,
            query: toLlmQuery(query),
            offset,
            limit: USAGE_PAGE_MAX_ITEMS,
          }
        : {
            kind: "logs",
            source,
            query: toToolQuery(query),
            offset,
            limit: USAGE_PAGE_MAX_ITEMS,
          },
    );
    if (result.kind !== "logs" || result.source !== source || result.offset !== offset) {
      throw invalidUsageProjection();
    }
    total ??= result.total;
    if (result.total !== total) throw invalidUsageProjection();
    rows.push(...result.rows);
    // Structural integrity: the Host must never return more rows than it claims.
    if (rows.length > total) throw invalidUsageProjection();
    // Client-side cap: when a range holds more activity than we render, keep the
    // newest MAX_ACTIVITY_RECORDS and stop paging. This is truncation, not a
    // protocol error, and the exhaustiveness check below is skipped for it — the
    // caller surfaces `logsTruncated` so the page can say the list is partial.
    if (total > MAX_ACTIVITY_RECORDS && rows.length >= MAX_ACTIVITY_RECORDS) {
      return { rows: rows.slice(0, MAX_ACTIVITY_RECORDS), truncated: true };
    }
    if (result.nextOffset === null) {
      if (rows.length !== total) throw invalidUsageProjection();
      return { rows, truncated: false };
    }
    if (result.nextOffset <= offset) throw invalidUsageProjection();
    offset = result.nextOffset;
  }
}

function projectLlmLog(row: LlmUsageLogProjection): UsageStats["logs"][number] {
  return {
    id: row.id,
    ts: row.ts,
    kind: "model",
    ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
    ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
    provider: row.providerId,
    model: row.modelId,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheMiss: row.cacheMissTokens,
    cacheRead: row.cacheReadTokens,
    cacheCreation: row.cacheWriteTokens,
    reasoning: row.reasoningTokens,
    ...(row.costUsd === undefined ? {} : { costUsd: row.costUsd }),
    latencyMs: row.latencyMs,
    status: row.status,
  };
}

function projectToolLog(row: ToolUsageLogProjection): UsageStats["logs"][number] {
  return {
    id: row.id,
    ts: row.ts,
    kind: "tool",
    ...(row.sessionId === undefined ? {} : { sessionId: row.sessionId }),
    ...(row.turnId === undefined ? {} : { turnId: row.turnId }),
    provider: row.providerId ?? "",
    model: row.modelId ?? "",
    toolName: row.toolName,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: row.durationMs,
    status: row.status,
  };
}

function aggregateModelLogs(
  logs: readonly LlmUsageLogProjection[],
  key: "provider",
): UsageStats["byProvider"];
function aggregateModelLogs(
  logs: readonly LlmUsageLogProjection[],
  key: "model",
): UsageStats["byModel"];
function aggregateModelLogs(
  logs: readonly LlmUsageLogProjection[],
  key: "provider" | "model",
): UsageStats["byProvider"] | UsageStats["byModel"] {
  const rows = new Map<string, { requests: number; tokens: number; costUsd: number }>();
  for (const log of logs) {
    // Provider breakdown keys on the connection the user configured, not the
    // raw provider type: two connections to the same provider are two rows, not
    // one collapsed row. `connectionSlug` is optional on pre-cutover rows, so
    // fall back to the provider id.
    const id = key === "provider" ? (log.connectionSlug ?? log.providerId) : log.modelId;
    const current = rows.get(id) ?? { requests: 0, tokens: 0, costUsd: 0 };
    current.requests += 1;
    current.tokens += log.inputTokens + log.outputTokens;
    current.costUsd += log.costUsd ?? 0;
    rows.set(id, current);
  }
  return [...rows.entries()]
    .map(([id, row]) => ({ [key]: id, ...row }))
    .sort((left, right) => right.requests - left.requests) as
      | UsageStats["byProvider"]
      | UsageStats["byModel"];
}

function aggregateToolLogs(logs: readonly ToolUsageLogProjection[]): UsageStats["byTool"] {
  const rows = new Map<
    string,
    { calls: number; success: number; errors: number; totalDurationMs: number }
  >();
  for (const log of logs) {
    const current = rows.get(log.toolName) ?? {
      calls: 0,
      success: 0,
      errors: 0,
      totalDurationMs: 0,
    };
    current.calls += 1;
    if (log.status === "success") current.success += 1;
    if (log.status === "error") current.errors += 1;
    current.totalDurationMs += log.durationMs;
    rows.set(log.toolName, current);
  }
  return [...rows.entries()]
    .map(([tool, row]) => ({
      tool,
      calls: row.calls,
      success: row.success,
      errors: row.errors,
      avgDurationMs: row.calls === 0 ? 0 : Math.round(row.totalDurationMs / row.calls),
    }))
    .sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool));
}

function projectPricing(pricing: PricingConfig): UsageStats["pricing"][number] {
  const separator = pricing.modelKey.indexOf(":");
  return {
    provider: separator < 0 ? "" : pricing.modelKey.slice(0, separator),
    model: separator < 0 ? pricing.modelKey : pricing.modelKey.slice(separator + 1),
    inputPerMTokUsd: pricing.inputUsdPer1M,
    outputPerMTokUsd: pricing.outputUsdPer1M,
  };
}

async function loadAllBuckets(
  client: DesktopRuntimeHostClient,
  query: UsageQuery & { groupBy: UsageGroupBy },
) {
  const buckets = [];
  let offset = 0;
  while (true) {
    const result = await client.queryUsage(
      query.groupBy === "tool"
        ? {
            kind: "buckets",
            query: toToolQuery(query),
            groupBy: "tool",
            offset,
            limit: USAGE_PAGE_MAX_ITEMS,
          }
        : {
            kind: "buckets",
            query: toLlmQuery(query),
            groupBy: query.groupBy,
            offset,
            limit: USAGE_PAGE_MAX_ITEMS,
          },
    );
    if (result.kind !== "buckets" || result.offset !== offset)
      throw invalidUsageProjection();
    buckets.push(...result.buckets);
    if (result.nextOffset === null) return buckets;
    if (result.nextOffset <= offset) throw invalidUsageProjection();
    offset = result.nextOffset;
  }
}

function toLlmQuery(query: UsageQuery) {
  const { toolName: _toolName, ...llmQuery } = query;
  return llmQuery;
}

function normalizeUsageRange(range: unknown): UsageRange {
  return range === "24h" || range === "7d" || range === "30d" || range === "all"
    ? range
    : "24h";
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
