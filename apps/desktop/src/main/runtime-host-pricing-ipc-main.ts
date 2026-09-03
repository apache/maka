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

/**
 * Pricing Settings IPC — the renderer's two capabilities from #2015:
 *
 *   - `usage:pricing:load`   → one complete effective snapshot (built-in ∪
 *                              overrides), revision- and connection-stamped.
 *   - `usage:pricing:mutate` → apply one upsert/delete against the revision the
 *                              renderer was viewing.
 *
 * The renderer round-trips the exact snapshot it loaded back as the CAS `base`;
 * this handler passes it straight to the adapter and never re-reads the latest
 * snapshot to synthesize a base (the bug in the retired `usage:pricing:put`
 * path, which defeated conflict detection). CAS + reconciliation live entirely
 * in `DesktopRuntimeHostClient.applyPricingMutation`.
 */

import type { Result } from "@maka/core/result";
import {
  normalizePricingConfig,
  normalizePricingModelKey,
} from "@maka/core/usage-stats/pricing";
import type { PricingMutation } from "@maka/runtime-host/protocol";
import { decodeDesktopPricingSnapshot } from "../shared/desktop-pricing-decode.js";
import type {
  DesktopPricingMutationInput,
  DesktopPricingMutationOutcome,
} from "../shared/desktop-pricing.js";
import {
  handleReconciledControl,
  handleReconnectableRead,
  rethrowReconnectableReadFailure,
  type ReconnectableReadIpcMain,
  tryReconnectableReadResult,
} from "./ipc-reconnect-policy.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";

interface RuntimeHostPricingIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: DesktopRuntimeHostClient;
}

type PricingMutateResult = Result<DesktopPricingMutationOutcome>;
type PricingReconcileReason = "revision_conflict" | "outcome_unknown";
interface PricingReconcileContext {
  readonly input: DesktopPricingMutationInput;
  readonly reason: PricingReconcileReason;
}

export function registerRuntimeHostPricingIpc(
  deps: RuntimeHostPricingIpcDeps,
): void {
  handleReconnectableRead(deps.ipcMain, "usage:pricing:load", () =>
    tryReconnectableReadResult(
      () => deps.client.loadPricingSnapshot(),
      "USAGE_PRICING_LOAD_FAILED",
    ),
  );
  // Reconciled control (like `goal:arm`): when the write's outcome is unknown
  // (a response-losing disconnect), defer to the harness to wait for a
  // replacement Host and reconcile against it — reload fresh authority and
  // compare the intended end state, never replaying the mutation. The original
  // conflict reason rides along so a confirmed revision conflict is not later
  // reported as merely uncertain.
  handleReconciledControl<PricingReconcileContext, PricingMutateResult>(
    deps.ipcMain,
    "usage:pricing:mutate",
    {
      dispatch: async (_event, base: unknown, mutation: unknown) => {
        let input: DesktopPricingMutationInput;
        try {
          input = {
            base: decodeDesktopPricingSnapshot(base),
            mutation: decodePricingMutation(mutation),
          };
        } catch (error) {
          return { kind: "completed", value: mutateFailure(error) };
        }
        try {
          const outcome = await deps.client.applyPricingMutation(input);
          // The adapter could not reload on its own (likely-lost) connection;
          // wait for a replacement Host and reconcile there instead of
          // returning "unavailable" immediately.
          if (outcome.kind === "reconciliation_unavailable") {
            return { kind: "reconcile", context: { input, reason: outcome.reason } };
          }
          return { kind: "completed", value: { ok: true, data: outcome } };
        } catch (error) {
          return { kind: "completed", value: mutateFailure(error) };
        }
      },
      reconcile: async (context) => {
        try {
          return {
            ok: true,
            data: await deps.client.reconcilePricingMutation(context.input, context.reason),
          };
        } catch (error) {
          rethrowReconnectableReadFailure(error);
          return mutateFailure(error);
        }
      },
      reconciliationUnavailable: async (context) => ({
        ok: true,
        data: { kind: "reconciliation_unavailable", reason: context.reason },
      }),
    },
  );
}

function mutateFailure(error: unknown): PricingMutateResult {
  return {
    ok: false,
    error: {
      code: "USAGE_PRICING_MUTATE_FAILED",
      message: error instanceof Error ? error.message : String(error),
      details: error,
    },
  };
}

/**
 * Shape-guard the renderer-supplied mutation for an early, user-facing error.
 * The Host is still the authoritative validator — the adapter re-decodes this
 * before dispatch — but rejecting a malformed payload here beats throwing deep
 * inside the adapter.
 */
function decodePricingMutation(value: unknown): PricingMutation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Pricing mutation must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.kind === "upsert") {
    const normalized = normalizePricingConfig(record.pricing);
    if (!normalized.ok) throw new Error(normalized.error);
    return { kind: "upsert", pricing: normalized.value };
  }
  if (record.kind === "delete") {
    const normalized = normalizePricingModelKey(record.modelKey);
    if (!normalized.ok) throw new Error(normalized.error);
    return { kind: "delete", modelKey: normalized.value };
  }
  throw new Error('Pricing mutation kind must be "upsert" or "delete"');
}
