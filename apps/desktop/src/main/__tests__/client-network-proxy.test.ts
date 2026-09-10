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
import { describe, test } from "node:test";
import type { ProxySettings } from "@maka/core/settings/network-settings";
import type { NetworkProxyResolveResult } from "@maka/runtime-host/protocol";
import { createClientNetworkProxyApplier } from "../client-network-proxy.js";

const RESOLVED: NetworkProxyResolveResult = {
  kind: "ready",
  proxy: {
    enabled: true,
    type: "http",
    host: "127.0.0.1",
    port: 7897,
    bypassList: ["localhost"],
  },
};

function harness(
  profileKind: "local" | "environment" | "remote",
  resolve: () => Promise<NetworkProxyResolveResult>,
) {
  const applied: (ProxySettings | null)[] = [];
  const errors: unknown[] = [];
  const scheduled: { run: () => void; delayMs: number }[] = [];
  const applier = createClientNetworkProxyApplier({
    profileKind,
    resolve,
    apply: (proxy) => applied.push(proxy),
    onError: (error) => errors.push(error),
    schedule: (run, delayMs) => scheduled.push({ run, delayMs }),
  });
  return { applier, applied, errors, scheduled };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("createClientNetworkProxyApplier", () => {
  test("applies the resolved proxy for a local Host", async () => {
    const { applier, applied } = harness("local", async () => RESOLVED);
    await applier.refresh();
    assert.deepStrictEqual(applied, [RESOLVED.proxy]);
  });

  test("applies direct when the policy disables the proxy", async () => {
    const { applier, applied } = harness("local", async () => ({ kind: "ready" }));
    await applier.refresh();
    assert.deepStrictEqual(applied, [null]);
  });

  test("applies direct when the proxy credential is missing", async () => {
    const { applier, applied } = harness("local", async () => ({
      kind: "credential_not_configured",
    }));
    await applier.refresh();
    assert.deepStrictEqual(applied, [null]);
  });

  test("never adopts a non-local Host's proxy policy", async () => {
    for (const kind of ["remote", "environment"] as const) {
      let resolved = false;
      const { applier, applied } = harness(kind, async () => {
        resolved = true;
        return RESOLVED;
      });
      await applier.refresh();
      // The bot bridges dial out from this machine, so a Host describing a
      // different network must not be asked, let alone applied.
      assert.strictEqual(resolved, false, `${kind} resolved the proxy`);
      assert.deepStrictEqual(applied, [null]);
    }
  });

  test("keeps the last applied proxy when resolution fails", async () => {
    let fail = false;
    const { applier, applied, errors } = harness("local", async () => {
      if (fail) throw new Error("Host unreachable");
      return RESOLVED;
    });
    await applier.refresh();
    fail = true;
    await applier.refresh();
    // A brief Host outage, or an older Host without the operation, is not
    // evidence that the user wants direct connections.
    assert.deepStrictEqual(applied, [RESOLVED.proxy]);
    assert.strictEqual(errors.length, 1);
  });

  test("reports a repeated resolution failure once", async () => {
    const { applier, errors } = harness("local", async () => {
      throw new Error("Host unreachable");
    });
    await applier.refresh();
    await applier.refresh();
    assert.strictEqual(errors.length, 1);
  });

  test("retries a failed first resolution instead of settling on direct", async () => {
    // The first refresh runs while the Host connection is still settling, so
    // losing that race must not leave the bot bridges direct until the user
    // next edits the proxy.
    let fail = true;
    const { applier, applied, scheduled } = harness("local", async () => {
      if (fail) throw new Error("host_not_ready");
      return RESOLVED;
    });
    await applier.refresh();
    assert.deepStrictEqual(applied, []);
    assert.strictEqual(scheduled.length, 1);

    fail = false;
    scheduled[0]?.run();
    await flush();
    assert.deepStrictEqual(applied, [RESOLVED.proxy]);
  });

  test("bounds the retry budget instead of reconnecting forever", async () => {
    const { applier, scheduled } = harness("local", async () => {
      throw new Error("host_not_ready");
    });
    await applier.refresh();
    for (let index = 0; index < 6; index += 1) {
      const pending = scheduled[index];
      if (!pending) break;
      pending.run();
      await flush();
    }
    assert.deepStrictEqual(
      scheduled.map((entry) => entry.delayMs),
      [1_000, 5_000, 15_000],
    );
  });

  test("serializes concurrent refreshes so the last resolution wins", async () => {
    const gates: (() => void)[] = [];
    const order: string[] = [];
    let call = 0;
    const { applier, applied } = harness("local", async () => {
      const index = call++;
      order.push(`start:${index}`);
      await new Promise<void>((resolve) => gates.push(resolve));
      order.push(`end:${index}`);
      return index === 0 ? RESOLVED : { kind: "ready" };
    });

    const first = applier.refresh();
    const second = applier.refresh();
    await flush();
    // The second resolution must not have begun while the first is in flight.
    assert.deepStrictEqual(order, ["start:0"]);
    gates[0]?.();
    await first;
    await flush();
    gates[1]?.();
    await second;
    assert.deepStrictEqual(order, ["start:0", "end:0", "start:1", "end:1"]);
    assert.deepStrictEqual(applied, [RESOLVED.proxy, null]);
  });
});
