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
import type { IpcHandler } from "../ipc-reconnect-policy.js";
import {
  DesktopRuntimeHostClientError,
  type DesktopRuntimeHostClient,
} from "../runtime-host-client.js";
import { registerRuntimeHostUsageIpc } from "../runtime-host-usage-ipc-main.js";

test("settings usage stats use the canonical model-call total and load every activity page", async () => {
  const handlers = new Map<string, IpcHandler>();
  const ranges: unknown[] = [];
  registerRuntimeHostUsageIpc({
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
    client: {
      loadUsageSnapshot: async (range: unknown) => {
        ranges.push(range);
        return {
          revision: "snapshot-1",
          summary: usageSummary(151),
          provenance: provenance(),
          llmLogs: Array.from({ length: 151 }, (_, index) => llmRow(index)),
          toolLogs: Array.from({ length: 171 }, (_, index) => toolRow(index)),
          pricingEntries: [
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
          llmLogsTruncated: false,
          toolLogsTruncated: false,
        };
      },
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
  assert.equal(ranges.length, 1);
  assert.equal(typeof ranges[0], "object");
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

test("settings usage stats propagate an invalid snapshot projection", async () => {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostUsageIpc({
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
    client: {
      loadUsageSnapshot: async () => {
        throw new DesktopRuntimeHostClientError(
          "projection_unstable",
          "Runtime Host returned an invalid Usage snapshot projection",
        );
      },
    } as unknown as DesktopRuntimeHostClient,
    sendToRenderer: () => undefined,
  });

  const handler = handlers.get("settings:usageStats");
  assert.ok(handler);
  await assert.rejects(
    () => handler({} as never, "24h"),
    (error: unknown) =>
      error instanceof DesktopRuntimeHostClientError && error.code === "projection_unstable",
  );
});

test("settings usage stats fail when a coherent snapshot cannot be retained", async () => {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostUsageIpc({
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
    client: {
      loadUsageSnapshot: async () => {
        throw new DesktopRuntimeHostClientError(
          "usage_unstable",
          "Usage snapshot kept expiring while Desktop read it",
        );
      },
    } as unknown as DesktopRuntimeHostClient,
    sendToRenderer: () => undefined,
  });

  const handler = handlers.get("settings:usageStats");
  assert.ok(handler);
  await assert.rejects(
    () => handler({} as never, "all"),
    (error: unknown) =>
      error instanceof DesktopRuntimeHostClientError && error.code === "usage_unstable",
  );
});

test("settings usage stats group the provider breakdown by connection", async () => {
  const handlers = new Map<string, IpcHandler>();
  registerRuntimeHostUsageIpc({
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
    client: {
      loadUsageSnapshot: async () => ({
        revision: "snapshot-1",
        summary: usageSummary(2),
        provenance: provenance(),
        llmLogs: [
          { ...llmRow(0), connectionSlug: "conn-a", providerId: "provider-x" },
          { ...llmRow(1), connectionSlug: "conn-b", providerId: "provider-x" },
        ],
        toolLogs: [],
        pricingEntries: [],
        llmLogsTruncated: false,
        toolLogsTruncated: false,
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
  const TOTAL = 50_000;
  registerRuntimeHostUsageIpc({
    ipcMain: {
      handle: (channel, listener) => handlers.set(channel, listener),
      handleReconnectableRead: (channel, listener) => handlers.set(channel, listener),
    },
    client: {
      loadUsageSnapshot: async () => ({
        revision: "snapshot-1",
        summary: usageSummary(TOTAL + 150),
        provenance: provenance(),
        llmLogs: Array.from({ length: TOTAL }, (_, index) => llmRow(index)),
        toolLogs: [],
        pricingEntries: [],
        llmLogsTruncated: true,
        toolLogsTruncated: false,
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
      loadUsageSnapshot: async () => ({
        revision: "snapshot-1",
        summary: usageSummary(2),
        provenance: provenance(),
        llmLogs: [
          {
            ...llmRow(0),
            sessionId: "session-named",
            sessionTitle: "重构使用统计页请求日志的任务列",
          },
          { ...llmRow(1), sessionId: "session-untitled" },
        ],
        toolLogs: [
          {
            ...toolRow(0),
            sessionId: "session-named",
            sessionTitle: "重构使用统计页请求日志的任务列",
          },
        ],
        pricingEntries: [],
        llmLogsTruncated: false,
        toolLogsTruncated: false,
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

function usageSummary(totalRequests: number) {
  return {
    range: { from: 1, to: 2 },
    totalRequests,
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
    totalDurationMs: 0,
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
