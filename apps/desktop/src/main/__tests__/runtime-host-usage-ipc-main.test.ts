import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { registerRuntimeHostUsageIpc } from "../runtime-host-usage-ipc-main.js";

type Handler = (event: unknown, ...args: any[]) => unknown;

describe("Runtime Host Usage IPC", () => {
  test("preserves the Desktop Usage projection and exhausts bucket pages", async () => {
    const handlers = new Map<string, Handler>();
    const queries: Array<Record<string, unknown>> = [];
    const client = {
      async queryUsage(input: Record<string, unknown>) {
        queries.push(input);
        if (input.kind === "summary") {
          return {
            kind: "summary",
            summary: { totalRequests: 3 },
            provenance: { pendingRepairs: 0 },
          };
        }
        if (input.kind === "logs") {
          return {
            kind: "logs",
            source: "llm",
            rows: [{ id: "call-1" }],
            offset: 2,
            total: 4,
            nextOffset: null,
            provenance: { pendingRepairs: 1 },
          };
        }
        const offset = input.offset as number;
        return {
          kind: "buckets",
          buckets: [{ key: `tool-${offset}` }],
          offset,
          total: 2,
          nextOffset: offset === 0 ? 1 : null,
          provenance: { pendingRepairs: 0 },
        };
      },
      async loadPricingSnapshot() {
        return { entries: [] };
      },
    };
    register(handlers, client);

    assert.deepEqual(
      await handlers.get("usage:summary")?.({}, {
        range: "7d",
        toolName: "ignored-for-llm",
      }),
      {
        ok: true,
        data: { totalRequests: 3, provenance: { pendingRepairs: 0 } },
      },
    );
    assert.deepEqual(
      await handlers.get("usage:buckets")?.({}, {
        range: "7d",
        groupBy: "tool",
        toolName: "browser",
      }),
      { ok: true, data: [{ key: "tool-0" }, { key: "tool-1" }] },
    );
    assert.deepEqual(
      await handlers.get("usage:logs")?.({}, {
        range: "7d",
        offset: 2,
        limit: 1,
      }),
      {
        ok: true,
        data: {
          rows: [{ id: "call-1" }],
          total: 4,
          provenance: { pendingRepairs: 1 },
        },
      },
    );
    assert.deepEqual(queries[0], {
      kind: "summary",
      query: { range: "7d" },
    });
    assert.deepEqual(queries[1], {
      kind: "buckets",
      query: { range: "7d", toolName: "browser" },
      groupBy: "tool",
      offset: 0,
      limit: 100,
    });
  });

  test("serializes Pricing changes against fresh Host snapshots", async () => {
    const handlers = new Map<string, Handler>();
    const mutations: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    let revision = 1;
    const client = {
      async queryUsage() {
        throw new Error("not used");
      },
      async loadPricingSnapshot() {
        return {
          hostEpoch: "epoch",
          connectionId: "connection",
          revision,
          entries:
            revision === 1
              ? []
              : [
                  {
                    source: "custom",
                    resetEffect: "become_unpriced",
                    pricing: {
                      modelKey: "provider:model",
                      inputUsdPer1M: 1,
                      outputUsdPer1M: 2,
                    },
                  },
                ],
        };
      },
      async applyPricingMutation(input: Record<string, unknown>) {
        mutations.push(input);
        revision += 1;
        return {
          kind: "saved_refresh_failed",
          disposition: "committed",
        };
      },
    };
    register(handlers, client, events);

    const put = handlers.get("usage:pricing:put")?.({}, {
      modelKey: "provider:model",
      inputUsdPer1M: 1,
      outputUsdPer1M: 2,
    });
    const reset = handlers.get("usage:pricing:reset")?.({}, "provider:model");
    assert.equal((await put as { ok: boolean }).ok, true);
    assert.equal((await reset as { ok: boolean }).ok, true);
    assert.equal(mutations.length, 2);
    assert.equal((mutations[0]!.base as { revision: number }).revision, 1);
    assert.equal((mutations[1]!.base as { revision: number }).revision, 2);
    assert.deepEqual(events, [
      "usage:pricing:changed",
      "usage:pricing:changed",
    ]);
  });
});

function register(
  handlers: Map<string, Handler>,
  client: object,
  events: string[] = [],
): void {
  registerRuntimeHostUsageIpc({
    ipcMain: {
      handle: (channel, handler) => {
        handlers.set(channel, handler as Handler);
      },
    },
    client: client as never,
    sendToRenderer: (channel) => events.push(channel),
  });
}
