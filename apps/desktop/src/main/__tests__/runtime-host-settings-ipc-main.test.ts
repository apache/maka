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
  createDefaultRuntimePolicy,
  type RuntimePolicy,
} from "@maka/core/runtime-policy";
import { registerRuntimeHostSettingsIpc } from "../runtime-host-settings-ipc-main.js";

type TestCandidate = RuntimePolicy["networkProxy"];

/** Minimal local-settings shape `loadRuntimeHostSettings` projects onto. */
function localSettings() {
  return {
    webSearch: { providers: { tavily: { apiKey: "" } } },
  } as never;
}

async function testCandidate(authEnabled: boolean): Promise<{
  candidate: TestCandidate;
  result: { ok: boolean; code: string };
}> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const policy = createDefaultRuntimePolicy();
  let candidate: TestCandidate | undefined;

  registerRuntimeHostSettingsIpc({
    ipcMain: {
      handle(channel, listener) {
        handlers.set(channel, listener as (...args: unknown[]) => unknown);
      },
    },
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
  assert.equal(tested.result.code, "proxy_unreachable");
});

test("proxy test preserves disabled authentication for a local proxy", async () => {
  const tested = await testCandidate(false);

  assert.equal(tested.candidate.authEnabled, false);
  assert.equal(tested.result.ok, true);
  assert.equal(tested.result.code, "proxy_reachable");
});

test("selecting Auto clears a stored tool-mode override instead of being dropped", async () => {
  // #3850 review: the projection used to drop `auto` from the patch, so the
  // spread merge kept a stored `code_mode` — the selector said Auto, nothing
  // changed, and the only way back was editing settings by hand. The store
  // starts with `code_mode` active; selecting Auto must reach the host as a
  // non-override the codec normalizes away.
  const policyWithOverride = () => {
    const base = createDefaultRuntimePolicy();
    return {
      ...base,
      chatDefaults: { ...base.chatDefaults, toolModePreference: "code_mode" as const },
    };
  };
  const operations: unknown[] = [];

  const { updateRuntimeHostSettings } = await import(
    "../runtime-host-settings-ipc-main.js"
  );
  await updateRuntimeHostSettings(
    {
      ipcMain: { handle() {} },
      client: {
        async queryRuntimePolicy() {
          return { revision: 1, policy: policyWithOverride() };
        },
        async queryCredential() {
          return undefined;
        },
        async updateRuntimePolicy(build: (policy: RuntimePolicy) => unknown) {
          const operation = build(policyWithOverride()) as { value: unknown };
          operations.push(operation);
          return { kind: "committed" } as never;
        },
      } as never,
      settingsStore: {
        async get() {
          return localSettings();
        },
        async update() {
          return localSettings();
        },
      } as never,
      applyClientSettings: async () => {},
    },
    { chatDefaults: { toolModePreference: "auto" } } as never,
  );

  const operation = operations.at(-1) as {
    kind: string;
    value: { toolModePreference?: unknown };
  };
  assert.equal(operation.kind, "set_chat_defaults");
  assert.equal(operation.value.toolModePreference, undefined);
});

test("a concrete tool-mode override still rides the patch through to the host", async () => {
  const operations: unknown[] = [];

  const { updateRuntimeHostSettings } = await import(
    "../runtime-host-settings-ipc-main.js"
  );
  await updateRuntimeHostSettings(
    {
      ipcMain: { handle() {} },
      client: {
        async queryRuntimePolicy() {
          return { revision: 1, policy: createDefaultRuntimePolicy() };
        },
        async queryCredential() {
          return undefined;
        },
        async updateRuntimePolicy(build: (policy: RuntimePolicy) => unknown) {
          const operation = build(createDefaultRuntimePolicy()) as { value: unknown };
          operations.push(operation);
          return { kind: "committed" } as never;
        },
      } as never,
      settingsStore: {
        async get() {
          return localSettings();
        },
        async update() {
          return localSettings();
        },
      } as never,
      applyClientSettings: async () => {},
    },
    { chatDefaults: { toolModePreference: "direct" } } as never,
  );

  const operation = operations.at(-1) as {
    kind: string;
    value: { toolModePreference?: unknown };
  };
  assert.equal(operation.kind, "set_chat_defaults");
  assert.equal(operation.value.toolModePreference, "direct");
});
