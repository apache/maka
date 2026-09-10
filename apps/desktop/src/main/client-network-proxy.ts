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
 * Applies the Runtime Policy network proxy to the Client's own outbound
 * traffic.
 *
 * Model execution resolves the proxy inside the Host and injects a transport
 * per connection. The bot bridges do not: `BotRegistry` is constructed in this
 * process, so its `proxiedFetch` reads process-wide state that only this module
 * writes. Without it the seam stays empty and every bot request goes direct,
 * whatever the Network settings say (apache/maka#5091).
 */

import type { ProxySettings } from "@maka/core/settings/network-settings";
import type { RuntimeHostProfileKind } from "@maka/runtime-host/profile-kind";
import type { NetworkProxyResolveResult } from "@maka/runtime-host/protocol";
import { setActiveProxy } from "@maka/runtime/network/active-proxy-state";

/**
 * The first resolution runs while the Host connection is still settling, so a
 * `host_not_ready` refusal is expected rather than terminal. Without a retry a
 * Client that loses that race stays direct until the user next edits the proxy.
 */
const RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;

export interface ClientNetworkProxyDeps {
  readonly profileKind: RuntimeHostProfileKind;
  readonly resolve: () => Promise<NetworkProxyResolveResult>;
  readonly apply?: (proxy: ProxySettings | null) => void;
  readonly onError?: (error: unknown) => void;
  readonly schedule?: (run: () => void, delayMs: number) => void;
}

export interface ClientNetworkProxyApplier {
  /** Re-resolves and applies. Safe to call concurrently; calls are serialized. */
  refresh(): Promise<void>;
}

export function createClientNetworkProxyApplier(
  deps: ClientNetworkProxyDeps,
): ClientNetworkProxyApplier {
  const apply = deps.apply ?? setActiveProxy;
  const schedule =
    deps.schedule ??
    ((run, delayMs) => {
      setTimeout(run, delayMs).unref?.();
    });
  let lane: Promise<void> = Promise.resolve();
  let lastReportedError: string | undefined;
  let attempt = 0;

  const refreshWithoutLane = async (): Promise<void> => {
    // A non-local Host describes a different machine's network. The bot
    // bridges dial out from this one, so its proxy policy does not apply and
    // guessing would be worse than staying direct.
    if (deps.profileKind !== "local") {
      apply(null);
      return;
    }
    let resolved: NetworkProxyResolveResult;
    try {
      resolved = await deps.resolve();
    } catch (error) {
      // Keep the last applied proxy. A Host that is briefly unreachable is not
      // evidence that the user wants direct connections.
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastReportedError) {
        lastReportedError = message;
        deps.onError?.(error);
      }
      const delayMs = RETRY_DELAYS_MS[attempt];
      if (delayMs !== undefined) {
        attempt += 1;
        schedule(() => void enqueue(), delayMs);
      }
      return;
    }
    lastReportedError = undefined;
    attempt = 0;
    apply(resolved.kind === "ready" ? (resolved.proxy ?? null) : null);
  };

  const enqueue = (): Promise<void> => {
    const result = lane.then(refreshWithoutLane, refreshWithoutLane);
    lane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    refresh() {
      // An explicit refresh means the policy changed, so the pending retry
      // budget from an earlier failure no longer applies.
      attempt = 0;
      return enqueue();
    },
  };
}
