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
import type { Result } from "@maka/core/result";
import type {
  DesktopPricingMutationInput,
  DesktopPricingMutationOutcome,
  DesktopPricingSnapshot,
} from "../../shared/desktop-pricing.js";
import type { IpcHandler } from "../ipc-reconnect-policy.js";
import type { DesktopRuntimeHostClient } from "../runtime-host-client.js";
import { registerRuntimeHostPricingIpc } from "../runtime-host-pricing-ipc-main.js";
import { registerRuntimeHostUsageIpc } from "../runtime-host-usage-ipc-main.js";

function recordingIpc() {
  const handlers = new Map<string, IpcHandler>();
  return {
    handlers,
    ipcMain: {
      handle: (channel: string, listener: IpcHandler) => handlers.set(channel, listener),
      handleReconnectableRead: (channel: string, listener: IpcHandler) =>
        handlers.set(channel, listener),
    },
  };
}

const SNAPSHOT: DesktopPricingSnapshot = {
  hostEpoch: "epoch-1",
  connectionId: "conn-1",
  revision: 7,
  entries: [
    { source: "builtin", pricing: { modelKey: "openai:gpt-4o", inputUsdPer1M: 2.5, outputUsdPer1M: 10 } },
  ],
};

test("pricing IPC registers the two capabilities and fences the legacy handlers", () => {
  const { handlers, ipcMain } = recordingIpc();
  registerRuntimeHostUsageIpc({
    ipcMain,
    client: {} as unknown as DesktopRuntimeHostClient,
    sendToRenderer: () => undefined,
  });
  registerRuntimeHostPricingIpc({ ipcMain, client: {} as unknown as DesktopRuntimeHostClient });

  assert.ok(handlers.has("usage:pricing:load"));
  assert.ok(handlers.has("usage:pricing:mutate"));
  // Acceptance #12: the retired direct-Store routes must not coexist.
  assert.equal(handlers.has("usage:pricing:list"), false);
  assert.equal(handlers.has("usage:pricing:put"), false);
  assert.equal(handlers.has("usage:pricing:reset"), false);
});

test("pricing load returns the full snapshot as a Result", async () => {
  const { handlers, ipcMain } = recordingIpc();
  registerRuntimeHostPricingIpc({
    ipcMain,
    client: { loadPricingSnapshot: async () => SNAPSHOT } as unknown as DesktopRuntimeHostClient,
  });
  const handler = handlers.get("usage:pricing:load");
  assert.ok(handler);
  const result = (await handler({} as never)) as Result<DesktopPricingSnapshot>;
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.data.revision === 7);
  assert.ok(result.ok && result.data.entries.length === 1);
});

test("pricing mutate passes the renderer-supplied base straight through (no re-read)", async () => {
  let received: DesktopPricingMutationInput | undefined;
  let loadCalls = 0;
  const outcome: DesktopPricingMutationOutcome = {
    kind: "saved",
    disposition: "committed",
    snapshot: { ...SNAPSHOT, revision: 8 },
  };
  const { handlers, ipcMain } = recordingIpc();
  registerRuntimeHostPricingIpc({
    ipcMain,
    client: {
      loadPricingSnapshot: async () => {
        loadCalls += 1;
        return SNAPSHOT;
      },
      applyPricingMutation: async (input: DesktopPricingMutationInput) => {
        received = input;
        return outcome;
      },
    } as unknown as DesktopRuntimeHostClient,
  });
  const handler = handlers.get("usage:pricing:mutate");
  assert.ok(handler);

  const result = (await handler({} as never, SNAPSHOT, {
    kind: "upsert",
    pricing: { modelKey: "acme:coder", inputUsdPer1M: 1, outputUsdPer1M: 2 },
  })) as Result<DesktopPricingMutationOutcome>;

  assert.equal(result.ok, true);
  assert.ok(result.ok && result.data.kind === "saved");
  // The base carries the revision the renderer was viewing — the handler must
  // NOT reload the latest snapshot to synthesize a base (the retired-path bug).
  assert.equal(received?.base.revision, 7);
  assert.deepEqual(received?.base, SNAPSHOT);
  assert.deepEqual(received?.mutation, {
    kind: "upsert",
    pricing: { modelKey: "acme:coder", inputUsdPer1M: 1, outputUsdPer1M: 2 },
  });
  assert.equal(loadCalls, 0);
});

test("pricing mutate rejects a malformed base as a failed Result", async () => {
  let applyCalls = 0;
  const { handlers, ipcMain } = recordingIpc();
  registerRuntimeHostPricingIpc({
    ipcMain,
    client: {
      applyPricingMutation: async () => {
        applyCalls += 1;
        return { kind: "saved_refresh_failed", disposition: "committed" } as const;
      },
    } as unknown as DesktopRuntimeHostClient,
  });
  const handler = handlers.get("usage:pricing:mutate");
  assert.ok(handler);

  const result = (await handler({} as never, { revision: "nope" }, {
    kind: "delete",
    modelKey: "acme:coder",
  })) as Result<DesktopPricingMutationOutcome>;

  assert.equal(result.ok, false);
  assert.equal(applyCalls, 0);
});

test("pricing mutate reconciles (no replay) when the dispatch outcome is unknown", async () => {
  let reconciled: DesktopPricingMutationInput | undefined;
  let reconciledReason: string | undefined;
  const { handlers, ipcMain } = recordingIpc();
  registerRuntimeHostPricingIpc({
    ipcMain,
    client: {
      // The initial dispatch could not confirm its outcome on its own
      // (likely-lost) connection — and it was a confirmed revision conflict.
      applyPricingMutation: async () =>
        ({ kind: "reconciliation_unavailable", reason: "revision_conflict" }) as const,
      // The reconciled-control path reloads fresh authority and compares intent
      // WITHOUT re-dispatching the mutation, preserving the original reason.
      reconcilePricingMutation: async (
        input: DesktopPricingMutationInput,
        reason: "revision_conflict" | "outcome_unknown",
      ) => {
        reconciled = input;
        reconciledReason = reason;
        return {
          kind: "review_required",
          reason,
          snapshot: { ...SNAPSHOT, revision: 8 },
        } as const;
      },
    } as unknown as DesktopRuntimeHostClient,
  });
  const handler = handlers.get("usage:pricing:mutate");
  assert.ok(handler);

  const result = (await handler({} as never, SNAPSHOT, {
    kind: "delete",
    modelKey: "acme:coder",
  })) as Result<DesktopPricingMutationOutcome>;

  // The synchronous fallback runs dispatch → reconcile; the reconcile carries
  // the renderer's base and the original reason (not a blanket "unknown").
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.data.kind === "review_required");
  assert.equal(reconciledReason, "revision_conflict");
  assert.deepEqual(reconciled?.base, SNAPSHOT);
  assert.deepEqual(reconciled?.mutation, { kind: "delete", modelKey: "acme:coder" });
});
