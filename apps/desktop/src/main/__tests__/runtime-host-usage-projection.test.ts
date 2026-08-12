import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { UsageQuery } from "@maka/core/usage-stats/types";
import { loadUsageStatsSnapshot } from "../runtime-host-usage-ipc-main.js";

describe("Runtime Host Usage projection", () => {
  test("preserves missing model usage and aborted tools", async () => {
    const queries: UsageQuery[] = [];
    const client = usageClient({ queries });

    const stats = await loadUsageStatsSnapshot(client as never, "all", 2_000);

    assert.equal(stats.summary.totalRequests, 2);
    assert.equal(stats.logs[0]?.usageBasis, "reported");
    assert.equal(stats.logs[1]?.usageBasis, "missing");
    assert.equal(stats.logs[1]?.costBasis, "unpriced");
    assert.equal(stats.logs[2]?.status, "aborted");
    assert.deepEqual(stats.byProvider, [
      { provider: "openai", requests: 2, tokens: 5, costUsd: 0 },
    ]);
    assert.deepEqual(stats.byTool, [
      {
        tool: "Bash",
        calls: 1,
        success: 0,
        errors: 0,
        aborted: 1,
        avgDurationMs: 500,
      },
    ]);
    assert.ok(
      queries.every(
        (query) =>
          JSON.stringify(query.range) ===
          JSON.stringify({ from: 0, to: 2_000 }),
      ),
    );
  });

  test("retries instead of combining different Host snapshots", async () => {
    let snapshotAttempt = 0;
    const client = usageClient({
      onSummary: () => {
        snapshotAttempt += 1;
      },
      bucketRequests: (groupBy) =>
        snapshotAttempt === 1 && groupBy === "provider" ? 1 : 2,
    });

    const stats = await loadUsageStatsSnapshot(client as never, "all", 2_000);

    assert.equal(stats.summary.totalRequests, 2);
    assert.equal(snapshotAttempt, 2);
  });
});

function usageClient(options: {
  queries?: UsageQuery[];
  onSummary?: () => void;
  bucketRequests?: (groupBy: string) => number;
}) {
  return {
    async queryUsage(input: Record<string, unknown>) {
      options.queries?.push(input.query as UsageQuery);
      if (input.kind === "summary") {
        options.onSummary?.();
        return {
          kind: "summary",
          summary: usageSummary(),
          provenance: provenance(),
        };
      }
      if (input.kind === "buckets") {
        const groupBy = input.groupBy as string;
        const label = groupBy === "provider" ? "openai" : "openai:gpt-test";
        return {
          kind: "buckets",
          buckets: [
            {
              ...usageBucket(label),
              requests: options.bucketRequests?.(groupBy) ?? 2,
            },
          ],
          offset: 0,
          total: 1,
          nextOffset: null,
          provenance: provenance(),
        };
      }
      if (input.source === "tool") {
        return {
          kind: "logs",
          source: "tool",
          rows: [toolLog()],
          offset: 0,
          total: 1,
          nextOffset: null,
        };
      }
      return {
        kind: "logs",
        source: "llm",
        rows: [
          llmLog("reported", "priced", 2_000),
          llmLog("missing", "unpriced", 1_500),
        ],
        offset: 0,
        total: 2,
        nextOffset: null,
        provenance: provenance(),
      };
    },
  };
}

function provenance() {
  return {
    coverage: {
      attempts: 2,
      pricedAttempts: 1,
      unpricedAttempts: 1,
      usageReportedAttempts: 1,
      usagePartialAttempts: 0,
      usageMissingAttempts: 1,
    },
    legacyRecords: 0,
    unreadableRecords: 0,
    pendingRepairs: 0,
  };
}

function usageSummary() {
  return {
    range: { from: 0, to: 2_000 },
    totalRequests: 2,
    totalCostUsd: 0,
    totalTokens: {
      input: 3,
      output: 2,
      cacheMiss: 3,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 5,
    },
    cacheHitRequests: 0,
    cacheCreateRequests: 0,
    errorRequests: 0,
  };
}

function usageBucket(label: string) {
  return {
    key: label,
    label,
    requests: 2,
    inputTokens: 3,
    outputTokens: 2,
    cacheMissTokens: 3,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 5,
    costUsd: 0,
    avgLatencyMs: 250,
    errorRate: 0,
  };
}

function llmLog(
  usageBasis: "reported" | "missing",
  costBasis: "priced" | "unpriced",
  ts: number,
) {
  const reported = usageBasis === "reported";
  return {
    source: "llm",
    id: `llm-${usageBasis}`,
    ts,
    connectionSlug: "primary",
    providerId: "openai",
    modelId: "gpt-test",
    inputTokens: reported ? 3 : 0,
    outputTokens: reported ? 2 : 0,
    cacheMissTokens: reported ? 3 : 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: reported ? 5 : 0,
    usageBasis,
    ...(costBasis === "priced" ? { costUsd: 0 } : {}),
    costBasis,
    latencyMs: 250,
    status: "success",
    sessionId: "session-1",
    turnId: `turn-${usageBasis}`,
  };
}

function toolLog() {
  return {
    source: "tool",
    id: "tool-1",
    ts: 1_000,
    toolCallId: "call-1",
    toolName: "Bash",
    durationMs: 500,
    status: "aborted",
    bytesIn: 1,
    bytesOut: 0,
    startedAt: 500,
    sessionId: "session-1",
    turnId: "turn-missing",
  };
}
