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
import test from "node:test";
import {
  createDefaultSettings,
  type UpdateAppSettingsInput,
} from "@maka/core/settings";
import {
  createDefaultRuntimePolicy,
  type RuntimePolicy,
  type UpdateNetworkProxyInput,
} from "@maka/core/runtime-policy";
import {
  createRuntimeHostSettingsModule,
  registerRuntimeHostSettingsIpc,
  runRuntimeHostSettingsExclusive,
} from "../runtime-host-settings-ipc-main.js";

type TestCandidate = RuntimePolicy["networkProxy"];

async function testCandidate(authEnabled: boolean): Promise<{
  candidate: TestCandidate;
  result: { ok: boolean; code: string };
}> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const policy = createDefaultRuntimePolicy();
  let candidate: TestCandidate | undefined;

  const module = createRuntimeHostSettingsModule({
    client: {
      async queryRuntimePolicy() {
        return { revision: 0, policy };
      },
      async testNetworkProxy(input: { networkProxy?: TestCandidate }) {
        candidate = input.networkProxy;
        return candidate?.authEnabled
          ? {
              ok: false,
              latencyMs: 0,
              error: "Proxy credential is not configured",
            }
          : { ok: true, latencyMs: 1, status: 200 };
      },
    } as never,
    settingsStore: {} as never,
    async applyClientSettings() {},
  });
  registerRuntimeHostSettingsIpc({
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener as (...args: unknown[]) => unknown);
      },
    },
    module,
  });

  const handler = handlers.get("settings:testNetworkProxy");
  assert.ok(handler);
  const result = await handler({}, {
    proxy: {
      enabled: true,
      type: "http",
      host: "127.0.0.1",
      port: 7897,
      authEnabled,
      bypassList: [],
    },
  });

  assert.ok(candidate);
  return {
    candidate,
    result: result as { ok: boolean; code: string },
  };
}

test("proxy test preserves enabled authentication when credentials are empty", async () => {
  const tested = await testCandidate(true);

  assert.equal(tested.candidate.authEnabled, true);
  assert.equal(tested.result.ok, false);
  assert.equal(tested.result.code, "proxy_credential_missing");
});

test("proxy test preserves disabled authentication for a local proxy", async () => {
  const tested = await testCandidate(false);

  assert.equal(tested.candidate.authEnabled, false);
  assert.equal(tested.result.ok, true);
  assert.equal(tested.result.code, "proxy_reachable");
});

function createModuleFixture(options: {
  configured?: boolean;
  beforeSetCredential?: () => Promise<void>;
  failFirstSet?: boolean;
  proxyTargetMismatch?: boolean;
} = {}) {
  let policy = createDefaultRuntimePolicy();
  if (options.configured) {
    policy = {
      ...policy,
      networkProxy: { ...policy.networkProxy, authEnabled: true },
    };
  }
  let policyRevision = 1;
  let secret = options.configured ? "saved-secret" : undefined;
  let revision = secret ? 1 : 0;
  let failFirstSet = options.failFirstSet ?? false;
  const events: string[] = [];
  const local = createDefaultSettings();

  const client = {
    async queryRuntimePolicy() {
      return { revision: policyRevision, policy };
    },
    async updateRuntimePolicy(
      createMutation: (value: RuntimePolicy) => {
        kind: string;
        value: RuntimePolicy["networkProxy"];
      },
    ) {
      const mutation = createMutation(policy);
      if (mutation.kind === "set_network_proxy") {
        policy = { ...policy, networkProxy: mutation.value };
      }
      policyRevision += 1;
      return { revision: policyRevision, policy };
    },
    async updateNetworkProxy(input: UpdateNetworkProxyInput) {
      if (input.expectedPolicyRevision !== policyRevision) {
        return {
          kind: "revision_conflict" as const,
          expectedRevision: input.expectedPolicyRevision,
          actualRevision: policyRevision,
        };
      }
      if (options.proxyTargetMismatch && input.credential.kind === "replace") {
        return {
          kind: "proxy_target_mismatch" as const,
          expected: input.credential.expectedTarget!,
          actual: {
            protocol: "http" as const,
            host: "proxy-b.example",
            port: 8080,
            username: "target-user",
          },
        };
      }
      if (input.credential.kind === "replace") {
        events.push(`set:${input.credential.secret}`);
        await options.beforeSetCredential?.();
        if (failFirstSet) {
          failFirstSet = false;
          throw new Error("credential write failed");
        }
        secret = input.credential.secret;
        revision += 1;
      } else if (input.credential.kind === "delete") {
        events.push("delete");
        secret = undefined;
        revision += 1;
      }
      policy = { ...policy, networkProxy: input.networkProxy };
      policyRevision += 1;
      return {
        kind: "committed" as const,
        revision: policyRevision,
        credentialStatus:
          secret === undefined
            ? {
                locator: { scope: "network_proxy" as const, kind: "password" as const },
                configured: false as const,
                credentialId: null,
                revision: null,
                updatedAt: null,
              }
            : {
                locator: { scope: "network_proxy" as const, kind: "password" as const },
                configured: true as const,
                credentialId: "proxy-credential",
                revision,
                updatedAt: 1,
              },
      };
    },
    async queryCredential(locator: { scope: string }) {
      if (locator.scope !== "network_proxy" || secret === undefined) return null;
      return {
        locator: { scope: "network_proxy", kind: "password" },
        configured: true,
        credentialId: "proxy-credential",
        revision,
        updatedAt: 1,
      };
    },
    async setCredential(input: { secret: string }) {
      events.push(`set:${input.secret}`);
      await options.beforeSetCredential?.();
      if (failFirstSet) {
        failFirstSet = false;
        throw new Error("credential write failed");
      }
      secret = input.secret;
      revision += 1;
      return { kind: "committed", snapshot: { revision, entries: [] } };
    },
    async deleteCredential() {
      events.push("delete");
      secret = undefined;
      revision += 1;
      return { kind: "committed", snapshot: { revision, entries: [] } };
    },
    async testNetworkProxy() {
      events.push("test");
      return { ok: true, latencyMs: 1, status: 200 };
    },
  };

  const module = createRuntimeHostSettingsModule({
    client: client as never,
    settingsStore: {
      async get() {
        return local;
      },
      async update(_patch: UpdateAppSettingsInput) {
        return local;
      },
    } as never,
    async applyClientSettings() {},
  });

  return {
    module,
    events,
    policy: () => policy,
    secret: () => secret,
  };
}

test("runtime settings project credential status without a password value", async () => {
  const fixture = createModuleFixture({ configured: true });

  const settings = await fixture.module.get();

  assert.equal(settings.network.proxy.passwordConfigured, true);
  assert.equal("password" in settings.network.proxy, false);
});

test("spread-back derived and legacy password fields never enter Runtime policy", async () => {
  const fixture = createModuleFixture({ configured: true });

  await fixture.module.update({
    network: {
      proxy: {
        host: "10.0.0.2",
        passwordConfigured: true,
        password: "legacy-secret",
      } as never,
    },
  });

  assert.equal(fixture.policy().networkProxy.host, "10.0.0.2");
  assert.equal("passwordConfigured" in fixture.policy().networkProxy, false);
  assert.equal("password" in fixture.policy().networkProxy, false);
});

test("proxy credential operations validate before any write", async () => {
  for (const proxy of [
    {
      credential: { kind: "replace", secret: "" },
    },
    {
      authEnabled: false,
      credential: { kind: "replace", secret: "new-secret" },
    },
  ] satisfies Array<NonNullable<UpdateAppSettingsInput["network"]>["proxy"]>) {
    const fixture = createModuleFixture({ configured: true });
    await assert.rejects(
      fixture.module.update({ network: { proxy } }),
      /credential|password|authentication/i,
    );
    assert.deepEqual(fixture.events, []);
    assert.equal(fixture.secret(), "saved-secret");
  }
});

test("disabling the proxy keeps credentials while disabling authentication removes them", async () => {
  const fixture = createModuleFixture({ configured: true });

  await fixture.module.update({ network: { proxy: { enabled: false } } });
  assert.equal(fixture.secret(), "saved-secret");

  await fixture.module.update({
    network: { proxy: { authEnabled: false } },
  });
  assert.equal(fixture.secret(), undefined);
  assert.deepEqual(fixture.events, ["delete"]);
});

test("keep, replace, and explicit delete preserve the derived credential contract", async () => {
  const fixture = createModuleFixture({ configured: true });

  const kept = await fixture.module.update({
    network: { proxy: { username: "updated-user" } },
  });
  assert.equal(fixture.secret(), "saved-secret");
  assert.equal(kept.network.proxy.passwordConfigured, true);

  const replaced = await fixture.module.update({
    network: {
      proxy: {
        authEnabled: true,
        credential: { kind: "replace", secret: "replacement" },
      },
    },
  });
  assert.equal(fixture.secret(), "replacement");
  assert.equal(replaced.network.proxy.passwordConfigured, true);

  const deleted = await fixture.module.update({
    network: {
      proxy: { authEnabled: true, credential: { kind: "delete" } },
    },
  });
  assert.equal(fixture.policy().networkProxy.authEnabled, true);
  assert.equal(fixture.secret(), undefined);
  assert.equal(deleted.network.proxy.passwordConfigured, false);
});

test("config import skips a proxy password whose bound target no longer matches", async () => {
  const fixture = createModuleFixture({ configured: true, proxyTargetMismatch: true });

  const imported = await runRuntimeHostSettingsExclusive(
    fixture.module,
    (settings) =>
      settings.updateForConfigImport({
        network: {
          proxy: {
            credential: {
              kind: "replace",
              secret: "source-import-secret",
              expectedTarget: {
                protocol: "http",
                host: "proxy-a.example",
                port: 8080,
                username: "source-user",
              },
            },
          },
        },
      }),
  );

  assert.equal(imported.skippedCredentials, 1);
  assert.equal(fixture.secret(), "saved-secret");
  assert.deepEqual(fixture.events, []);
});

test("a later authentication disable waits for an in-flight replacement and wins", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = createModuleFixture({ beforeSetCredential: () => blocked });

  const replace = fixture.module.update({
    network: {
      proxy: {
        authEnabled: true,
        credential: { kind: "replace", secret: "complete-secret" },
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const disable = fixture.module.update({
    network: { proxy: { authEnabled: false } },
  });

  assert.deepEqual(fixture.events, ["set:complete-secret"]);
  release();
  await Promise.all([replace, disable]);
  assert.deepEqual(fixture.events, ["set:complete-secret", "delete"]);
  assert.equal(fixture.secret(), undefined);
});

test("proxy tests wait for the lane and a failed operation does not poison it", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = createModuleFixture({
    beforeSetCredential: () => blocked,
    failFirstSet: true,
  });
  const replace = fixture.module.update({
    network: {
      proxy: {
        authEnabled: true,
        credential: { kind: "replace", secret: "complete-secret" },
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const testResult = fixture.module.testNetworkProxy({});

  assert.deepEqual(fixture.events, ["set:complete-secret"]);
  release();
  await assert.rejects(replace, /failed/);
  assert.equal((await testResult).ok, true);
  assert.deepEqual(fixture.events, ["set:complete-secret", "test"]);
});

test("a failed credential replacement does not commit proxy policy fields", async () => {
  const fixture = createModuleFixture({ configured: true, failFirstSet: true });
  const before = structuredClone(fixture.policy().networkProxy);

  await assert.rejects(
    fixture.module.update({
      network: {
        proxy: {
          enabled: true,
          host: "replacement.proxy.internal",
          authEnabled: true,
          username: "replacement-user",
          credential: { kind: "replace", secret: "replacement-secret" },
        },
      },
    }),
    /failed/,
  );

  assert.deepEqual(fixture.policy().networkProxy, before);
  assert.equal(fixture.secret(), "saved-secret");
});

test("compound config operations share the lane without re-entering it", async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = createModuleFixture({ beforeSetCredential: () => blocked });
  const replace = fixture.module.update({
    network: {
      proxy: {
        authEnabled: true,
        credential: { kind: "replace", secret: "complete-secret" },
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const config = runRuntimeHostSettingsExclusive(
    fixture.module,
    async (settings) => {
      fixture.events.push("config:start");
      await settings.update({ network: { proxy: { username: "imported-user" } } });
      const projected = await settings.get();
      fixture.events.push("config:end");
      return projected;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.events, ["set:complete-secret"]);

  release();
  await replace;
  const projected = await config;
  assert.equal(projected.network.proxy.username, "imported-user");
  assert.deepEqual(fixture.events, [
    "set:complete-secret",
    "config:start",
    "config:end",
  ]);
});
