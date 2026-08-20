import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { UsageQuery } from "@maka/core/usage-stats/types";
import { RuntimeHostOperationError } from "@maka/runtime-host/client";
import { loadUsageStatsSnapshot } from "../runtime-host-usage-ipc-main.js";

const HOST_A = { hostId: "host-a" };
const PAGE_LIMIT = 100;
const MAX_LOG_PAGES = 5;

describe("Runtime Host Usage projection", () => {
  test("preserves missing model usage and aborted tools", async () => {
    const queries: UsageQuery[] = [];
    const client = usageClient({ queries });

    const stats = await loadUsageStatsSnapshot(client as never, HOST_A, "all", 2_000);

    assert.equal(stats.summary.totalRequests, 2);
    assert.equal(stats.logs[0]?.usageBasis, "reported");
    assert.equal(stats.logs[1]?.usageBasis, "missing");
    assert.equal(stats.logs[1]?.costBasis, "unpriced");
    assert.equal(stats.logs[2]?.status, "aborted");
    assert.equal(stats.logsTotal, 3);
    assert.equal(stats.logsTruncated, false);
    assert.deepEqual(stats.byProvider, [
      { provider: "openai", requests: 2, tokens: 5, costUsd: 0 },
    ]);
    // The tool table comes from the Host's own groupBy:'tool' aggregate, not
    // from recomputing the paged tool rows.
    assert.deepEqual(stats.byTool, [
      {
        tool: "Bash",
        calls: 8,
        success: 5,
        errors: 2,
        aborted: 1,
        avgDurationMs: 640,
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

  test("threads one snapshot ticket through every view and page", async () => {
    const inputs: Record<string, unknown>[] = [];
    const client = usageClient({ inputs, llmRowTotal: 230 });

    await loadUsageStatsSnapshot(client as never, HOST_A, "all", 2_000);

    const tickets = new Set(inputs.map((input) => input.snapshot));
    assert.equal(tickets.size, 1);
    const [ticket] = tickets;
    assert.equal(typeof ticket, "string");
    assert.ok((ticket as string).length > 0);
  });

  test("retries instead of combining different Host snapshots", async () => {
    let snapshotAttempt = 0;
    const client = usageClient({
      onSummary: () => {
        snapshotAttempt += 1;
      },
      revision: (input) =>
        snapshotAttempt === 1 && input.kind === "buckets" && input.groupBy === "provider"
          ? 99
          : snapshotAttempt,
    });

    const stats = await loadUsageStatsSnapshot(client as never, HOST_A, "all", 2_000);

    assert.equal(stats.summary.totalRequests, 2);
    assert.equal(snapshotAttempt, 2);
  });

  test("retries a same-count payload mutation identified by the Host revision", async () => {
    let snapshotAttempt = 0;
    const client = usageClient({
      onSummary: () => {
        snapshotAttempt += 1;
      },
      revision: (input) =>
        snapshotAttempt === 1 && input.kind === "buckets" && input.groupBy === "provider"
          ? 2
          : snapshotAttempt,
      bucketTokens: (groupBy) =>
        snapshotAttempt === 1 && groupBy === "provider" ? 9 : 5,
    });

    const stats = await loadUsageStatsSnapshot(client as never, HOST_A, "all", 2_000);

    assert.equal(snapshotAttempt, 2);
    assert.equal(stats.summary.totalTokens, 5);
    assert.equal(stats.byProvider[0]?.tokens, 5);
  });

  test("folds the Host's fence-exhaustion outcome into the snapshot retry", async () => {
    let snapshotAttempt = 0;
    const client = usageClient({
      onSummary: () => {
        snapshotAttempt += 1;
      },
      summaryFailure: (attempt) =>
        attempt === 1
          ? new RuntimeHostOperationError(
              "usage.query",
              "usage_revision_changed",
              "Usage authority changed while reading the projection",
            )
          : undefined,
    });

    const stats = await loadUsageStatsSnapshot(client as never, HOST_A, "all", 2_000);

    assert.equal(stats.summary.totalRequests, 2);
    assert.equal(snapshotAttempt, 2);
  });

  test("surfaces persistent fence exhaustion after the snapshot attempts", async () => {
    let snapshotAttempt = 0;
    const client = usageClient({
      onSummary: () => {
        snapshotAttempt += 1;
      },
      summaryFailure: () =>
        new RuntimeHostOperationError(
          "usage.query",
          "usage_revision_changed",
          "Usage authority changed while reading the projection",
        ),
    });

    await assert.rejects(
      loadUsageStatsSnapshot(client as never, HOST_A, "all", 2_000),
      /changed while Desktop read it/,
    );
    assert.equal(snapshotAttempt, 3);
  });

  test("bounds log paging round trips and payload inside one snapshot", async () => {
    const inputs: Record<string, unknown>[] = [];
    const client = usageClient({
      inputs,
      llmRowTotal: 600,
      toolRowTotal: 200,
    });

    const stats = await loadUsageStatsSnapshot(client as never, HOST_A, "all", 2_000);

    const llmPageRequests = inputs.filter(
      (input) => input.kind === "logs" && input.source === "llm",
    );
    const toolPageRequests = inputs.filter(
      (input) => input.kind === "logs" && input.source === "tool",
    );
    // 600 LLM rows would take six unbounded pages; the snapshot stops at the
    // page cap instead. 200 tool rows still fit in two pages.
    assert.equal(llmPageRequests.length, MAX_LOG_PAGES);
    assert.equal(toolPageRequests.length, 2);
    assert.equal(stats.logs.length, MAX_LOG_PAGES * PAGE_LIMIT + 200);
    assert.equal(stats.logsTotal, 800);
    assert.equal(stats.logsTruncated, true);
    // Aggregates still cover the full window regardless of the log cap.
    assert.deepEqual(stats.byTool, [
      {
        tool: "Bash",
        calls: 8,
        success: 5,
        errors: 2,
        aborted: 1,
        avgDurationMs: 640,
      },
    ]);
  });

  test("retries when the revision moves mid-pagination", async () => {
    let snapshotAttempt = 0;
    const client = usageClient({
      onSummary: () => {
        snapshotAttempt += 1;
      },
      llmRowTotal: 200,
      revision: (input) =>
        snapshotAttempt === 1 && input.source === "llm" && input.offset === 100
          ? 9
          : snapshotAttempt,
    });

    const stats = await loadUsageStatsSnapshot(client as never, HOST_A, "all", 2_000);

    assert.equal(snapshotAttempt, 2);
    assert.equal(stats.logsTruncated, false);
    assert.equal(stats.logs.length, 200 + 1);
  });

  test("rejects a non-advancing page offset without retrying", async () => {
    let snapshotAttempt = 0;
    const client = usageClient({
      onSummary: () => {
        snapshotAttempt += 1;
      },
      llmRowTotal: 200,
      llmNextOffset: (offset) => offset,
    });

    await assert.rejects(
      loadUsageStatsSnapshot(client as never, HOST_A, "all", 2_000),
      /invalid Usage projection/,
    );
    assert.equal(snapshotAttempt, 1);
  });

  test("retries a short final page and fails when it persists", async () => {
    let snapshotAttempt = 0;
    const client = usageClient({
      onSummary: () => {
        snapshotAttempt += 1;
      },
      llmShortFinalPage: true,
    });

    await assert.rejects(
      loadUsageStatsSnapshot(client as never, HOST_A, "all", 2_000),
      /changed while Desktop read it/,
    );
    assert.equal(snapshotAttempt, 3);
  });

  test("projects only custom pricing overrides for the pricing tab", async () => {
    const client = usageClient({
      pricingEntries: [
        {
          pricing: {
            modelKey: "zai-coding-plan:glm-4.7",
            inputUsdPer1M: 1.25,
            outputUsdPer1M: 2.5,
          },
          source: "custom" as const,
          resetEffect: "restore_builtin" as const,
        },
        {
          pricing: {
            modelKey: "anthropic:claude-test",
            inputUsdPer1M: 3,
            outputUsdPer1M: 15,
          },
          source: "builtin" as const,
        },
      ],
    });

    const stats = await loadUsageStatsSnapshot(client as never, HOST_A, "all", 2_000);

    assert.deepEqual(stats.pricing, [
      {
        provider: "zai-coding-plan",
        model: "glm-4.7",
        inputPerMTokUsd: 1.25,
        outputPerMTokUsd: 2.5,
      },
    ]);
  });

  test("projects Host-local session IDs into collision-safe Desktop keys", async () => {
    const client = usageClient({});

    const [first, second] = await Promise.all([
      loadUsageStatsSnapshot(client as never, HOST_A, "all", 2_000),
      loadUsageStatsSnapshot(client as never, { hostId: "host-b" }, "all", 2_000),
    ]);

    assert.equal(first.logs[0]?.sessionId, '["host-a","session-1"]');
    assert.equal(first.logs[2]?.sessionId, '["host-a","session-1"]');
    assert.equal(second.logs[0]?.sessionId, '["host-b","session-1"]');
    assert.notEqual(first.logs[0]?.sessionId, second.logs[0]?.sessionId);
  });

  test("preserves an absent Host-local session ID", async () => {
    const client = usageClient({ omitSessionId: true });

    const stats = await loadUsageStatsSnapshot(client as never, HOST_A, "all", 2_000);

    assert.ok(stats.logs.every((row) => row.sessionId === undefined));
  });
});

function usageClient(options: {
  queries?: UsageQuery[];
  inputs?: Record<string, unknown>[];
  onSummary?: () => void;
  summaryFailure?: (attempt: number) => Error | undefined;
  bucketRequests?: (groupBy: string) => number;
  bucketTokens?: (groupBy: string) => number;
  revision?: (input: Record<string, unknown>) => number;
  llmRowTotal?: number;
  toolRowTotal?: number;
  llmNextOffset?: (offset: number) => number | null;
  llmShortFinalPage?: boolean;
  pricingEntries?: readonly {
    pricing: {
      modelKey: string;
      inputUsdPer1M: number;
      outputUsdPer1M: number;
    };
    source: "custom" | "builtin";
    resetEffect?: "restore_builtin" | "become_unpriced";
  }[];
  omitSessionId?: boolean;
}) {
  let summaryAttempt = 0;
  return {
    async queryUsage(input: Record<string, unknown>) {
      options.inputs?.push(input);
      options.queries?.push(input.query as UsageQuery);
      if (input.kind === "summary") {
        summaryAttempt += 1;
        options.onSummary?.();
        const failure = options.summaryFailure?.(summaryAttempt);
        if (failure) throw failure;
        return {
          kind: "summary",
          revision: options.revision?.(input) ?? 0,
          summary: usageSummary(),
          provenance: provenance(),
        };
      }
      if (input.kind === "buckets") {
        const groupBy = input.groupBy as string;
        if (groupBy === "tool") {
          return {
            kind: "buckets",
            revision: options.revision?.(input) ?? 0,
            buckets: [toolBucket()],
            offset: 0,
            total: 1,
            nextOffset: null,
            provenance: provenance(),
          };
        }
        const label = groupBy === "provider" ? "openai" : "openai:gpt-test";
        return {
          kind: "buckets",
          revision: options.revision?.(input) ?? 0,
          buckets: [
            {
              ...usageBucket(label),
              requests: options.bucketRequests?.(groupBy) ?? 2,
              totalTokens: options.bucketTokens?.(groupBy) ?? 5,
            },
          ],
          offset: 0,
          total: 1,
          nextOffset: null,
          provenance: provenance(),
        };
      }
      if (input.source === "tool") {
        return pagedToolLogs(options, input);
      }
      return pagedLlmLogs(options, input);
    },
    async loadPricingSnapshot() {
      return {
        hostEpoch: "epoch",
        connectionId: "connection",
        revision: 0,
        entries: options.pricingEntries ?? [],
      };
    },
  };
}

function pagedLlmLogs(
  options: Parameters<typeof usageClient>[0],
  input: Record<string, unknown>,
) {
  const offset = (input.offset as number | undefined) ?? 0;
  const limit = (input.limit as number | undefined) ?? PAGE_LIMIT;
  const total = options.llmRowTotal ?? 2;
  const rows = [];
  const count = Math.min(limit, total - offset);
  for (let index = 0; index < count; index += 1) {
    rows.push(
      index < 2 && offset === 0 && options.llmRowTotal === undefined
        ? index === 0
          ? llmLog("reported", "priced", 2_000, options.omitSessionId)
          : llmLog("missing", "unpriced", 1_500, options.omitSessionId)
        : {
            ...llmLog("reported", "priced", 2_000 - offset - index, options.omitSessionId),
            id: `llm-${offset + index}`,
          },
    );
  }
  const delivered =
    options.llmShortFinalPage && offset + limit >= total ? rows.slice(0, -1) : rows;
  const nextOffset =
    offset + count < total
      ? options.llmNextOffset?.(offset) ?? offset + count
      : null;
  return {
    kind: "logs",
    source: "llm",
    revision: options.revision?.(input) ?? 0,
    rows: delivered,
    offset,
    total,
    nextOffset,
    provenance: provenance(),
  };
}

function pagedToolLogs(
  options: Parameters<typeof usageClient>[0],
  input: Record<string, unknown>,
) {
  const offset = (input.offset as number | undefined) ?? 0;
  const limit = (input.limit as number | undefined) ?? PAGE_LIMIT;
  const total = options.toolRowTotal ?? 1;
  const count = Math.min(limit, total - offset);
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    rows.push({
      ...toolLog(options.omitSessionId),
      id: `tool-${offset + index}`,
      ts: 1_000 - offset - index,
    });
  }
  return {
    kind: "logs",
    source: "tool",
    revision: options.revision?.(input) ?? 0,
    rows,
    offset,
    total,
    nextOffset: offset + count < total ? offset + count : null,
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

function toolBucket() {
  return {
    key: "Bash",
    label: "Bash",
    requests: 8,
    inputTokens: 0,
    outputTokens: 0,
    cacheMissTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    avgLatencyMs: 640,
    errorRate: 0.375,
    successCount: 5,
    errorCount: 2,
    abortedCount: 1,
  };
}

function llmLog(
  usageBasis: "reported" | "missing",
  costBasis: "priced" | "unpriced",
  ts: number,
  omitSessionId = false,
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
    ...(omitSessionId ? {} : { sessionId: "session-1" }),
    turnId: `turn-${usageBasis}`,
  };
}

function toolLog(omitSessionId = false) {
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
    ...(omitSessionId ? {} : { sessionId: "session-1" }),
    turnId: "turn-missing",
  };
}
