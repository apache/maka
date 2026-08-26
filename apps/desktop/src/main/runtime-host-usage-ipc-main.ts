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

import { tryResult } from "@maka/core/result";
import {
  normalizePricingConfig,
  normalizePricingModelKey,
} from "@maka/core/usage-stats/pricing";
import type {
  PricingConfig,
  UsageGroupBy,
  UsageQuery,
} from "@maka/core/usage-stats/types";
import type { UsageRange, UsageStats } from "@maka/core/settings";
import { resolveUsageRange } from "@maka/core/model-call-usage-projection";
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
  tryReconnectableReadResult,
} from "./ipc-reconnect-policy.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";
import type { OperationOutput } from "@maka/runtime-host/protocol";
import { desktopSessionKey } from "../shared/runtime-host-identity.js";

interface RuntimeHostUsageIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: DesktopRuntimeHostClient;
  readonly hostId: string;
  readonly sendToRenderer: (channel: string, ...args: unknown[]) => void;
}

const PAGE_LIMIT = 100;

type LlmUsageLog = Extract<
  OperationOutput<"usage.query">,
  { kind: "logs"; source: "llm" }
>["rows"][number];
type ToolUsageLog = Extract<
  OperationOutput<"usage.query">,
  { kind: "logs"; source: "tool" }
>["rows"][number];

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
    "usage:stats",
    (_event, range?: UsageRange) =>
      tryReconnectableReadResult(
        () => loadDesktopUsageStats(deps.client, normalizeUsageRange(range), deps.hostId),
        "USAGE_STATS_FAILED",
      ),
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

export async function loadDesktopUsageStats(
  client: Pick<DesktopRuntimeHostClient, "queryUsage">,
  range: UsageRange,
  hostId?: string,
): Promise<UsageStats> {
  const query: UsageQuery = { range: resolveUsageRange(range, Date.now()) };
  const [summary, providers, models, tools, modelLogs, toolLogs] = await Promise.all([
    queryUsageSummary(client, query),
    loadAllBuckets(client, { ...query, groupBy: "provider" }),
    loadAllBuckets(client, { ...query, groupBy: "model" }),
    loadAllBuckets(client, { ...query, groupBy: "tool" }),
    loadAllLogs(client, "llm", query),
    loadAllLogs(client, "tool", query),
  ]);
  const logs = [
    ...modelLogs.map((row) => toUsageModelLog(row, hostId)),
    ...toolLogs.map((row) => toUsageToolLog(row, hostId)),
  ].sort((left, right) => right.ts - left.ts);
  return {
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
    logs,
    byProvider: providers.map((bucket) => ({
      provider: bucket.key,
      requests: bucket.requests,
      tokens: bucket.totalTokens,
      costUsd: bucket.costUsd,
    })),
    byModel: models.map((bucket) => ({
      model: bucket.key,
      requests: bucket.requests,
      tokens: bucket.totalTokens,
      costUsd: bucket.costUsd,
    })),
    byTool: aggregateToolUsage(toolLogs),
    pricing: [],
  };
}

async function queryUsageSummary(
  client: Pick<DesktopRuntimeHostClient, "queryUsage">,
  query: UsageQuery,
) {
  const result = await client.queryUsage({ kind: "summary", query: toLlmQuery(query) });
  if (result.kind !== "summary") throw invalidUsageProjection();
  return result.summary;
}

async function loadAllLogs(
  client: Pick<DesktopRuntimeHostClient, "queryUsage">,
  source: "llm",
  query: UsageQuery,
): Promise<readonly LlmUsageLog[]>;
async function loadAllLogs(
  client: Pick<DesktopRuntimeHostClient, "queryUsage">,
  source: "tool",
  query: UsageQuery,
): Promise<readonly ToolUsageLog[]>;
async function loadAllLogs(
  client: Pick<DesktopRuntimeHostClient, "queryUsage">,
  source: "llm" | "tool",
  query: UsageQuery,
): Promise<readonly (LlmUsageLog | ToolUsageLog)[]> {
  const rows: Array<LlmUsageLog | ToolUsageLog> = [];
  let offset = 0;
  while (true) {
    const result = await client.queryUsage(
      source === "llm"
        ? {
            kind: "logs",
            source,
            query: toLlmQuery(query),
            offset,
            limit: PAGE_LIMIT,
          }
        : {
            kind: "logs",
            source,
            query: toToolQuery(query),
            offset,
            limit: PAGE_LIMIT,
          },
    );
    if (result.kind !== "logs" || result.source !== source || result.offset !== offset) {
      throw invalidUsageProjection();
    }
    rows.push(...result.rows);
    if (result.nextOffset === null) return rows;
    if (result.nextOffset <= offset) throw invalidUsageProjection();
    offset = result.nextOffset;
  }
}

function normalizeUsageRange(range: UsageRange | undefined): UsageRange {
  if (range === "24h" || range === "7d" || range === "30d" || range === "all") return range;
  return "24h";
}

function toUsageModelLog(row: LlmUsageLog, hostId?: string): UsageStats["logs"][number] {
  return {
    id: row.id,
    ts: row.ts,
    kind: "model",
    sessionId: projectSessionId(hostId, row.sessionId),
    turnId: row.turnId ?? "unknown",
    provider: row.connectionSlug ?? row.providerId,
    model: row.modelId,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    ...(row.cacheMissTokens ? { cacheMiss: row.cacheMissTokens } : {}),
    ...(row.cacheReadTokens ? { cacheRead: row.cacheReadTokens } : {}),
    ...(row.cacheWriteTokens ? { cacheCreation: row.cacheWriteTokens } : {}),
    ...(row.reasoningTokens ? { reasoning: row.reasoningTokens } : {}),
    ...(row.costUsd === undefined ? {} : { costUsd: row.costUsd }),
    latencyMs: row.latencyMs,
    status: row.status,
  };
}

function toUsageToolLog(row: ToolUsageLog, hostId?: string): UsageStats["logs"][number] {
  return {
    id: row.id,
    ts: row.ts,
    kind: "tool",
    sessionId: projectSessionId(hostId, row.sessionId),
    turnId: row.turnId ?? "unknown",
    provider: row.providerId ?? "unknown",
    model: row.modelId ?? "unknown",
    toolName: row.toolName,
    inputTokens: 0,
    outputTokens: 0,
    latencyMs: row.durationMs,
    status: row.status,
  };
}

function projectSessionId(hostId: string | undefined, sessionId: string | undefined): string {
  if (!sessionId) return "unknown";
  return hostId ? desktopSessionKey({ hostId, sessionId }) : sessionId;
}

function aggregateToolUsage(rows: readonly ToolUsageLog[]): UsageStats["byTool"] {
  const grouped = new Map<string, { calls: number; success: number; errors: number; aborted: number; duration: number }>();
  for (const row of rows) {
    const current = grouped.get(row.toolName) ?? { calls: 0, success: 0, errors: 0, aborted: 0, duration: 0 };
    current.calls += 1;
    if (row.status === "success") current.success += 1;
    else if (row.status === "error") current.errors += 1;
    else current.aborted += 1;
    current.duration += row.durationMs;
    grouped.set(row.toolName, current);
  }
  return [...grouped.entries()]
    .map(([tool, row]) => ({
      tool,
      calls: row.calls,
      success: row.success,
      errors: row.errors,
      ...(row.aborted > 0 ? { aborted: row.aborted } : {}),
      avgDurationMs: row.calls === 0 ? 0 : Math.round(row.duration / row.calls),
    }))
    .sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool));
}

async function loadAllBuckets(
  client: Pick<DesktopRuntimeHostClient, "queryUsage">,
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
