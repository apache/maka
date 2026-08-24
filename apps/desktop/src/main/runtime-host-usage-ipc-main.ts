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

const PAGE_LIMIT = 100;

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
