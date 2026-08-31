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

import assert from "node:assert/strict";
import { test } from "node:test";
import type { UsageStats } from "@maka/core/settings";
import type { UsageQueryInput, UsageQueryResult } from "@maka/runtime-host/protocol";
import type { IpcHandler } from "../ipc-reconnect-policy.js";
import type { DesktopRuntimeHostClient } from "../runtime-host-client.js";
import { registerRuntimeHostUsageIpc } from "../runtime-host-usage-ipc-main.js";

test("settings usage stats use the canonical model-call total and load every activity page", async () => {
  const handlers = new Map<string, IpcHandler>();
  const calls: Array<{ source?: "llm" | "tool"; offset?: number }> = [];
  const ranges: UsageQueryInput["query"]["range"][] = [];
  registerRuntimeHostUsageIpc({
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
    client: {
      queryUsage: async (input: UsageQueryInput) => {
        ranges.push(input.query.range);
        if (input.kind === "summary") {
          return {
            kind: "summary",
            summary: {
              range: { from: 1, to: 2 },
              totalRequests: 151,
              totalCostUsd: 12.5,
              totalTokens: {
                input: 3_000_000,
                output: 500_000,
                cacheMiss: 100_000,
                cacheRead: 400_000,
                cacheWrite: 43_090,
                reasoning: 90,
                total: 4_043_090,
              },
              cacheHitRequests: 10,
              cacheCreateRequests: 5,
              errorRequests: 2,
            },
            provenance: provenance(),
          } satisfies UsageQueryResult;
        }
        if (input.kind !== "logs") throw new Error("unexpected usage query");
        calls.push({ source: input.source, offset: input.offset });
        if (input.source === "llm") {
          const offset = input.offset ?? 0;
          const count = offset === 0 ? 100 : 51;
          return {
            kind: "logs",
            source: "llm",
            rows: Array.from({ length: count }, (_, index) => llmRow(offset + index)),
            offset,
            total: 151,
            nextOffset: offset === 0 ? 100 : null,
            provenance: provenance(),
          } satisfies UsageQueryResult;
        }
        const offset = input.offset ?? 0;
        const count = offset === 0 ? 100 : 71;
        return {
          kind: "logs",
          source: "tool",
          rows: Array.from({ length: count }, (_, index) => toolRow(offset + index)),
          offset,
          total: 171,
          nextOffset: offset === 0 ? 100 : null,
        } satisfies UsageQueryResult;
      },
      loadPricingSnapshot: async () => ({
        hostEpoch: "host-epoch",
        connectionId: "connection-id",
        revision: 1,
        entries: [
          {
            source: "custom",
            resetEffect: "become_unpriced",
            pricing: {
              modelKey: "provider-a:model-a",
              inputUsdPer1M: 1,
              outputUsdPer1M: 2,
            },
          },
        ],
      }),
    } as unknown as DesktopRuntimeHostClient,
    sendToRenderer: () => undefined,
  });

  const handler = handlers.get("settings:usageStats");
  assert.ok(handler);
  const stats = await handler({} as never, "24h") as UsageStats;

  assert.equal(stats.summary.totalRequests, 151);
  assert.equal(stats.summary.totalTokens, 4_043_090);
  assert.equal(stats.logs.length, 322);
  assert.equal(stats.logs.filter((row) => row.kind === "model").length, 151);
  assert.equal(stats.logs.filter((row) => row.kind === "tool").length, 171);
  const expectedCalls: Array<{ source?: "llm" | "tool"; offset?: number }> = [
    { source: "llm", offset: 0 },
    { source: "llm", offset: 100 },
    { source: "tool", offset: 0 },
    { source: "tool", offset: 100 },
  ];
  assert.deepEqual(calls.sort(compareCall), expectedCalls.sort(compareCall));
  assert.ok(ranges.every((range) => typeof range === "object"));
  assert.ok(ranges.every((range) => JSON.stringify(range) === JSON.stringify(ranges[0])));
  assert.equal(stats.logs.find((row) => row.id === "llm-150")?.status, "aborted");
  assert.equal(stats.logs.find((row) => row.id === "llm-150")?.sessionId, undefined);
  assert.equal(stats.logs.find((row) => row.id === "llm-150")?.costUsd, undefined);
  assert.equal(stats.logs.find((row) => row.id === "tool-170")?.status, "aborted");
  assert.deepEqual(stats.byProvider, [
    { provider: "provider-a", requests: 151, tokens: 604, costUsd: 150 },
  ]);
  assert.deepEqual(stats.byTool, [
    { tool: "Read", calls: 171, success: 170, errors: 0, avgDurationMs: 25 },
  ]);
  assert.deepEqual(stats.pricing, [
    {
      provider: "provider-a",
      model: "model-a",
      inputPerMTokUsd: 1,
      outputPerMTokUsd: 2,
    },
  ]);
  // The canonical summary provenance is carried through so the page can qualify
  // a cost that reads low; the full range fit under the cap, so not truncated.
  assert.deepEqual(stats.provenance, provenance());
  assert.equal(stats.logsTruncated, undefined);
});

test("settings usage stats reject a non-advancing activity page", async () => {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostUsageIpc({
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
    client: {
      queryUsage: async (input: UsageQueryInput) => {
        if (input.kind === "summary") {
          return {
            kind: "summary",
            summary: {
              range: { from: 1, to: 2 },
              totalRequests: 0,
              totalCostUsd: 0,
              totalTokens: {
                input: 0,
                output: 0,
                cacheMiss: 0,
                cacheRead: 0,
                cacheWrite: 0,
                reasoning: 0,
                total: 0,
              },
              cacheHitRequests: 0,
              cacheCreateRequests: 0,
              errorRequests: 0,
            },
            provenance: provenance(),
          } satisfies UsageQueryResult;
        }
        if (input.kind !== "logs") throw new Error("unexpected usage query");
        return input.source === "llm"
          ? ({
              kind: "logs",
              source: "llm",
              rows: [],
              offset: 0,
              total: 1,
              nextOffset: 0,
              provenance: provenance(),
            } satisfies UsageQueryResult)
          : ({
              kind: "logs",
              source: "tool",
              rows: [],
              offset: 0,
              total: 0,
              nextOffset: null,
            } satisfies UsageQueryResult);
      },
      loadPricingSnapshot: async () => ({
        hostEpoch: "host-epoch",
        connectionId: "connection-id",
        revision: 0,
        entries: [],
      }),
    } as unknown as DesktopRuntimeHostClient,
    sendToRenderer: () => undefined,
  });

  const handler = handlers.get("settings:usageStats");
  assert.ok(handler);
  await assert.rejects(() => handler({} as never, "24h"), /invalid Usage projection/);
});

test("settings usage stats degrade instead of erroring when logs disagree with the canonical summary", async () => {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostUsageIpc({
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
    client: {
      queryUsage: async (input: UsageQueryInput) => {
        if (input.kind === "summary") {
          return {
            kind: "summary",
            summary: {
              range: { from: 1, to: 2 },
              totalRequests: 2,
              totalCostUsd: 0,
              totalTokens: {
                input: 0,
                output: 0,
                cacheMiss: 0,
                cacheRead: 0,
                cacheWrite: 0,
                reasoning: 0,
                total: 0,
              },
              cacheHitRequests: 0,
              cacheCreateRequests: 0,
              errorRequests: 0,
            },
            provenance: provenance(),
          } satisfies UsageQueryResult;
        }
        if (input.kind !== "logs") throw new Error("unexpected usage query");
        return input.source === "llm"
          ? ({
              kind: "logs",
              source: "llm",
              rows: [llmRow(0)],
              offset: 0,
              total: 1,
              nextOffset: null,
              provenance: provenance(),
            } satisfies UsageQueryResult)
          : ({
              kind: "logs",
              source: "tool",
              rows: [],
              offset: 0,
              total: 0,
              nextOffset: null,
            } satisfies UsageQueryResult);
      },
      loadPricingSnapshot: async () => ({
        hostEpoch: "host-epoch",
        connectionId: "connection-id",
        revision: 0,
        entries: [],
      }),
    } as unknown as DesktopRuntimeHostClient,
    sendToRenderer: () => undefined,
  });

  const handler = handlers.get("settings:usageStats");
  assert.ok(handler);
  // A catch-up race (summary read before a repair commits, logs read after) must
  // not error the whole page. The canonical summary total stays authoritative,
  // the activity list holds what actually loaded, and provenance still rides along.
  const stats = await handler({} as never, "all") as UsageStats;
  assert.equal(stats.summary.totalRequests, 2);
  assert.equal(stats.logs.filter((row) => row.kind === "model").length, 1);
  assert.deepEqual(stats.provenance, provenance());
});

test("settings usage stats group the provider breakdown by connection", async () => {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostUsageIpc({
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
    client: {
      queryUsage: async (input: UsageQueryInput) => {
        if (input.kind === "summary") {
          return {
            kind: "summary",
            summary: {
              range: { from: 1, to: 2 },
              totalRequests: 2,
              totalCostUsd: 0,
              totalTokens: {
                input: 0,
                output: 0,
                cacheMiss: 0,
                cacheRead: 0,
                cacheWrite: 0,
                reasoning: 0,
                total: 0,
              },
              cacheHitRequests: 0,
              cacheCreateRequests: 0,
              errorRequests: 0,
            },
            provenance: provenance(),
          } satisfies UsageQueryResult;
        }
        if (input.kind !== "logs") throw new Error("unexpected usage query");
        // Two connections to the SAME provider type must stay two rows.
        return input.source === "llm"
          ? ({
              kind: "logs",
              source: "llm",
              rows: [
                { ...llmRow(0), connectionSlug: "conn-a", providerId: "provider-x" },
                { ...llmRow(1), connectionSlug: "conn-b", providerId: "provider-x" },
              ],
              offset: 0,
              total: 2,
              nextOffset: null,
              provenance: provenance(),
            } satisfies UsageQueryResult)
          : ({
              kind: "logs",
              source: "tool",
              rows: [],
              offset: 0,
              total: 0,
              nextOffset: null,
            } satisfies UsageQueryResult);
      },
      loadPricingSnapshot: async () => ({
        hostEpoch: "host-epoch",
        connectionId: "connection-id",
        revision: 0,
        entries: [],
      }),
    } as unknown as DesktopRuntimeHostClient,
    sendToRenderer: () => undefined,
  });

  const handler = handlers.get("settings:usageStats");
  assert.ok(handler);
  const stats = await handler({} as never, "all") as UsageStats;
  assert.deepEqual(
    stats.byProvider.map((row) => row.provider).sort(),
    ["conn-a", "conn-b"],
  );
});

test("settings usage stats truncate the activity log at the cap instead of erroring", async () => {
  const handlers = new Map<string, IpcHandler>();
  const PAGE = 100;
  // Above MAX_ACTIVITY_RECORDS (50_000) so paging must stop and flag truncation.
  const TOTAL = 50_150;
  registerRuntimeHostUsageIpc({
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
    client: {
      queryUsage: async (input: UsageQueryInput) => {
        if (input.kind === "summary") {
          return {
            kind: "summary",
            summary: {
              range: { from: 1, to: 2 },
              totalRequests: TOTAL,
              totalCostUsd: 0,
              totalTokens: {
                input: 0,
                output: 0,
                cacheMiss: 0,
                cacheRead: 0,
                cacheWrite: 0,
                reasoning: 0,
                total: 0,
              },
              cacheHitRequests: 0,
              cacheCreateRequests: 0,
              errorRequests: 0,
            },
            provenance: provenance(),
          } satisfies UsageQueryResult;
        }
        if (input.kind !== "logs") throw new Error("unexpected usage query");
        if (input.source === "llm") {
          const offset = input.offset ?? 0;
          const count = Math.min(PAGE, TOTAL - offset);
          const nextOffset = offset + count < TOTAL ? offset + count : null;
          return {
            kind: "logs",
            source: "llm",
            rows: Array.from({ length: count }, (_, index) => llmRow(offset + index)),
            offset,
            total: TOTAL,
            nextOffset,
            provenance: provenance(),
          } satisfies UsageQueryResult;
        }
        return {
          kind: "logs",
          source: "tool",
          rows: [],
          offset: 0,
          total: 0,
          nextOffset: null,
        } satisfies UsageQueryResult;
      },
      loadPricingSnapshot: async () => ({
        hostEpoch: "host-epoch",
        connectionId: "connection-id",
        revision: 0,
        entries: [],
      }),
    } as unknown as DesktopRuntimeHostClient,
    sendToRenderer: () => undefined,
  });

  const handler = handlers.get("settings:usageStats");
  assert.ok(handler);
  const stats = await handler({} as never, "all") as UsageStats;
  assert.equal(stats.logsTruncated, true);
  assert.equal(stats.logs.filter((row) => row.kind === "model").length, 50_000);
});

test("settings usage stats name each row from the Host-resolved session title", async () => {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostUsageIpc({
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
    client: {
      queryUsage: async (input: UsageQueryInput) => {
        if (input.kind === "summary") {
          return {
            kind: "summary",
            summary: {
              range: { from: 1, to: 2 },
              totalRequests: 2,
              totalCostUsd: 0,
              totalTokens: {
                input: 0,
                output: 0,
                cacheMiss: 0,
                cacheRead: 0,
                cacheWrite: 0,
                reasoning: 0,
                total: 0,
              },
              cacheHitRequests: 0,
              cacheCreateRequests: 0,
              errorRequests: 0,
            },
            provenance: provenance(),
          } satisfies UsageQueryResult;
        }
        if (input.kind !== "logs") throw new Error("unexpected usage query");
        // The Host carries `sessionTitle` on the projection (or omits it for
        // untitled/unreadable sessions). The desktop layer just surfaces it.
        return input.source === "llm"
          ? ({
              kind: "logs",
              source: "llm",
              rows: [
                {
                  ...llmRow(0),
                  sessionId: "session-named",
                  sessionTitle: "重构使用统计页请求日志的任务列",
                },
                { ...llmRow(1), sessionId: "session-untitled" },
              ],
              offset: 0,
              total: 2,
              nextOffset: null,
              provenance: provenance(),
            } satisfies UsageQueryResult)
          : ({
              kind: "logs",
              source: "tool",
              rows: [
                {
                  ...toolRow(0),
                  sessionId: "session-named",
                  sessionTitle: "重构使用统计页请求日志的任务列",
                },
              ],
              offset: 0,
              total: 1,
              nextOffset: null,
            } satisfies UsageQueryResult);
      },
      loadPricingSnapshot: async () => ({
        hostEpoch: "host-epoch",
        connectionId: "connection-id",
        revision: 0,
        entries: [],
      }),
    } as unknown as DesktopRuntimeHostClient,
    sendToRenderer: () => undefined,
  });

  const handler = handlers.get("settings:usageStats");
  assert.ok(handler);
  const stats = await handler({} as never, "all") as UsageStats;
  // A model row and a tool row carrying the title both surface it as sessionName.
  assert.equal(
    stats.logs.find((row) => row.id === "llm-0")?.sessionName,
    "重构使用统计页请求日志的任务列",
  );
  assert.equal(
    stats.logs.find((row) => row.id === "tool-0")?.sessionName,
    "重构使用统计页请求日志的任务列",
  );
  // A row the Host left untitled stays nameless so the UI falls back.
  assert.equal(stats.logs.find((row) => row.id === "llm-1")?.sessionName, undefined);
});

function llmRow(index: number) {
  return {
    source: "llm" as const,
    id: `llm-${index}`,
    ts: 1_000 + index,
    providerId: "provider-a",
    modelId: "model-a",
    inputTokens: 3,
    outputTokens: 1,
    cacheMissTokens: 1,
    cacheReadTokens: 2,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 7,
    ...(index === 150 ? { costBasis: "unpriced" as const } : { costUsd: 1 }),
    latencyMs: 10,
    status: index === 150 ? ("aborted" as const) : ("success" as const),
    ...(index === 150 ? {} : { sessionId: "session-a", turnId: `turn-${index}` }),
  };
}

function toolRow(index: number) {
  return {
    source: "tool" as const,
    id: `tool-${index}`,
    ts: 2_000 + index,
    toolName: "Read",
    durationMs: 25,
    status: index === 170 ? ("aborted" as const) : ("success" as const),
    bytesIn: 0,
    bytesOut: 0,
    startedAt: 1_975 + index,
    sessionId: "session-a",
    turnId: `turn-${index}`,
  };
}

function provenance() {
  return {
    coverage: {
      attempts: 148,
      pricedAttempts: 147,
      unpricedAttempts: 1,
      usageReportedAttempts: 148,
      usagePartialAttempts: 0,
      usageMissingAttempts: 0,
    },
    legacyRecords: 3,
    unreadableRecords: 0,
    pendingRepairs: 0,
  };
}

function compareCall(
  left: { source?: "llm" | "tool"; offset?: number },
  right: { source?: "llm" | "tool"; offset?: number },
): number {
  return `${left.source}:${left.offset}`.localeCompare(`${right.source}:${right.offset}`);
}
