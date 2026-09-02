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

import type {
  AppSettings,
  RuntimeHostAppSettings,
  SettingsTestResult,
  UpdateAppSettingsInput,
  UpdateAppSettingsResult,
} from '@maka/core/settings';
import type {
  CredentialLocator,
  CredentialStatus,
  RuntimePolicy,
} from "@maka/core/runtime-policy";
import { SENSITIVE_PLACEHOLDER } from "@maka/core/settings/network-settings";
import type {
  TestProxyInput,
  TestProxySettings,
} from "@maka/core/settings/network-settings";
import type { SettingsStore } from "@maka/storage/settings-store";
import {
  buildSettingsUpdateResult,
  maskAppSettings,
  proxyTestFailure,
} from "./settings-ipc-helpers.js";
import type { DesktopRuntimeHostClient } from "./runtime-host-client.js";
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from "./ipc-reconnect-policy.js";
import {
  clientOwnedSettingsPatch,
  hasSettingsPatch,
} from "../shared/settings-ownership.js";

type RuntimeHostSettingsClient = Pick<
  DesktopRuntimeHostClient,
  | "deleteCredential"
  | "queryCredential"
  | "queryRuntimePolicy"
  | "setCredential"
  | "testNetworkProxy"
  | "updateNetworkProxy"
  | "updateRuntimePolicy"
>;

const PROXY_CREDENTIAL: CredentialLocator = {
  scope: "network_proxy",
  kind: "password",
};
const WEB_SEARCH_CREDENTIAL: CredentialLocator = {
  scope: "web_search",
  provider: "tavily",
  kind: "api_key",
};

export interface RuntimeHostSettingsIpcDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly client: RuntimeHostSettingsClient;
  readonly settingsStore: SettingsStore;
  readonly applyClientSettings: (settings: AppSettings) => Promise<void>;
}

export type RuntimeHostSettingsModuleDeps = Omit<
  RuntimeHostSettingsIpcDeps,
  "ipcMain"
>;

export interface RuntimeHostSettingsModule {
  get(): Promise<RuntimeHostAppSettings>;
  update(patch: UpdateAppSettingsInput): Promise<RuntimeHostAppSettings>;
  testNetworkProxy(input?: TestProxyInput): Promise<SettingsTestResult>;
}

export interface RuntimeHostSettingsExclusiveAccess {
  get(): Promise<RuntimeHostAppSettings>;
  update(patch: UpdateAppSettingsInput): Promise<RuntimeHostAppSettings>;
  updateForConfigImport(
    patch: UpdateAppSettingsInput,
  ): Promise<RuntimeHostSettingsImportResult>;
}

export interface RuntimeHostSettingsImportResult {
  readonly settings: RuntimeHostAppSettings;
  readonly skippedCredentials: number;
}

type RuntimeHostSettingsExclusiveRunner = <T>(
  operation: (access: RuntimeHostSettingsExclusiveAccess) => Promise<T>,
) => Promise<T>;

const exclusiveRunners = new WeakMap<
  RuntimeHostSettingsModule,
  RuntimeHostSettingsExclusiveRunner
>();

interface RuntimeHostSettingsIpcRegistrationDeps {
  readonly ipcMain: ReconnectableReadIpcMain;
  readonly module: RuntimeHostSettingsModule;
}

export function createRuntimeHostSettingsModule(
  deps: RuntimeHostSettingsModuleDeps,
): RuntimeHostSettingsModule {
  let lane: Promise<void> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = lane.then(operation, operation);
    lane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  const module: RuntimeHostSettingsModule = {
    get: () => enqueue(() => loadRuntimeHostSettingsWithoutLane(deps)),
    update: (patch) =>
      enqueue(() =>
        updateRuntimeHostSettingsForImportWithoutLane(deps, patch).then(
          (result) => result.settings,
        ),
      ),
    testNetworkProxy: (input = {}) =>
      enqueue(() => testNetworkProxyWithoutLane(deps.client, input)),
  };
  exclusiveRunners.set(module, (operation) =>
    enqueue(() =>
      operation({
        get: () => loadRuntimeHostSettingsWithoutLane(deps),
        update: (patch) =>
          updateRuntimeHostSettingsForImportWithoutLane(deps, patch).then(
            (result) => result.settings,
          ),
        updateForConfigImport: (patch) =>
          updateRuntimeHostSettingsForImportWithoutLane(deps, patch),
      }),
    ),
  );
  return module;
}

/**
 * Runs a compound Settings adapter operation in this Runtime Host's lane.
 * The supplied accessors deliberately bypass re-entry into the public queue.
 */
export function runRuntimeHostSettingsExclusive<T>(
  module: RuntimeHostSettingsModule,
  operation: (access: RuntimeHostSettingsExclusiveAccess) => Promise<T>,
): Promise<T> {
  const run = exclusiveRunners.get(module);
  if (!run) {
    throw new Error('Runtime Host Settings module does not own an exclusive lane');
  }
  return run(operation);
}

export function registerRuntimeHostSettingsIpc(
  deps: RuntimeHostSettingsIpcRegistrationDeps,
): void {
  const module = deps.module;
  handleReconnectableRead(deps.ipcMain, "settings:get", async () =>
    maskAppSettings(await module.get()),
  );
  deps.ipcMain.handle(
    "settings:testNetworkProxy",
    async (_event, input: TestProxyInput = {}) => module.testNetworkProxy(input),
  );
  deps.ipcMain.handle(
    "settings:update",
    async (
      _event,
      patch: UpdateAppSettingsInput,
    ): Promise<UpdateAppSettingsResult<RuntimeHostAppSettings>> => {
      const settings = await module.update(patch);
      return buildSettingsUpdateResult(settings, patch);
    },
  );
}

function toRuntimeHostProxyPolicy(
  proxy: TestProxySettings,
  autoBypassDomains: readonly string[],
): RuntimePolicy["networkProxy"] {
  const username = proxy.username?.trim() ?? "";
  const authEnabled =
    proxy.authEnabled ?? Boolean(username);
  return {
    enabled: proxy.enabled,
    protocol: proxy.type,
    host: proxy.host.trim(),
    port: proxy.port,
    authEnabled,
    username: authEnabled ? username : "",
    bypassList: [...proxy.bypassList],
    autoBypassDomains: [...autoBypassDomains],
  };
}

async function testNetworkProxyWithoutLane(
  client: RuntimeHostSettingsClient,
  input: TestProxyInput,
): Promise<SettingsTestResult> {
  const current = (await client.queryRuntimePolicy()).policy.networkProxy;
  const candidate = input.proxy
    ? toRuntimeHostProxyPolicy(input.proxy, current.autoBypassDomains)
    : undefined;
  const result = await client.testNetworkProxy({
    ...(candidate ? { networkProxy: candidate } : {}),
    ...(input.url ? { url: input.url } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
  const tested = candidate ?? current;
  if (!result.ok) {
    const failure = proxyTestFailure(result);
    return {
      ok: false,
      ...failure,
      latencyMs: result.latencyMs,
      details: { status: result.status },
    };
  }
  return {
    ok: true,
    code: "proxy_reachable",
    message: `The proxy ${tested.protocol}://${tested.host}:${tested.port} is reachable.`,
    latencyMs: result.latencyMs,
    details: {
      endpoint: `${tested.protocol}://${tested.host}:${tested.port}`,
      status: result.status,
      ip: result.ip,
      countryCode: result.countryCode,
      countryFlag: result.countryFlag,
      bypassList: tested.bypassList,
    },
  };
}

async function loadRuntimeHostSettingsWithoutLane(
  deps: RuntimeHostSettingsModuleDeps,
): Promise<RuntimeHostAppSettings> {
  const [local, runtimePolicy, proxyCredential, webSearchCredential] =
    await Promise.all([
      deps.settingsStore.get(),
      deps.client.queryRuntimePolicy(),
      deps.client.queryCredential(PROXY_CREDENTIAL),
      deps.client.queryCredential(WEB_SEARCH_CREDENTIAL),
    ]);
  const policy = runtimePolicy.policy;
  return {
    ...local,
    network: {
      proxy: {
        ...policy.networkProxy,
        bypassList: [...policy.networkProxy.bypassList],
        autoBypassDomains: [...policy.networkProxy.autoBypassDomains],
        passwordConfigured: proxyCredential?.configured === true,
      },
    },
    personalization: {
      ...local.personalization,
      ...policy.personalization,
    },
    localMemory: policy.memory,
    workspaceInstructions: policy.workspaceInstructions,
    privacy: policy.privacy,
    chatDefaults: policy.chatDefaults,
    shell: policy.shell,
    webSearch: {
      ...local.webSearch,
      ...policy.webSearch,
      providers: {
        tavily: projectWebSearchCredential(local, webSearchCredential),
      },
    },
    subagents: policy.subagents,
  };
}

async function updateRuntimeHostSettingsForImportWithoutLane(
  deps: RuntimeHostSettingsModuleDeps,
  patch: UpdateAppSettingsInput,
): Promise<RuntimeHostSettingsImportResult> {
  validateProxyPatch(patch.network?.proxy);
  const skippedCredentials = await applyHostPatchWithoutLane(deps.client, patch);
  const clientPatch = clientOwnedSettingsPatch(patch);
  const local = hasSettingsPatch(clientPatch)
    ? await deps.settingsStore.update(clientPatch)
    : await deps.settingsStore.get();
  await deps.applyClientSettings(local);
  return {
    settings: await loadRuntimeHostSettingsWithoutLane(deps),
    skippedCredentials,
  };
}

function projectWebSearchCredential(
  local: AppSettings,
  credential: CredentialStatus | null,
): AppSettings["webSearch"]["providers"]["tavily"] {
  if (!credential?.configured) {
    return {
      ...local.webSearch.providers.tavily,
      apiKey: "",
      credentialSource: "none",
      credentialStatus: "not_configured",
    };
  }
  return {
    ...local.webSearch.providers.tavily,
    apiKey: SENSITIVE_PLACEHOLDER,
    credentialSource: "saved",
    credentialVersion: credential.revision,
    credentialStatus: "untested",
    credentialCheckedAt: new Date(credential.updatedAt).toISOString(),
  };
}

async function applyHostPatchWithoutLane(
  client: RuntimeHostSettingsClient,
  patch: UpdateAppSettingsInput,
): Promise<number> {
  let skippedCredentials = 0;
  if (patch.network?.proxy) {
    skippedCredentials += await updateNetworkProxy(client, patch.network.proxy);
  }
  if (
    patch.personalization?.displayName !== undefined ||
    patch.personalization?.assistantTone !== undefined
  ) {
    const personalization = patch.personalization;
    await client.updateRuntimePolicy((policy) => ({
      kind: "set_personalization",
      value: {
        ...policy.personalization,
        ...(personalization.displayName === undefined
          ? {}
          : { displayName: personalization.displayName }),
        ...(personalization.assistantTone === undefined
          ? {}
          : { assistantTone: personalization.assistantTone }),
      },
    }));
  }
  if (patch.localMemory) {
    await mergePolicy(client, "memory", patch.localMemory, "set_memory");
  }
  if (patch.workspaceInstructions) {
    await mergePolicy(
      client,
      "workspaceInstructions",
      patch.workspaceInstructions,
      "set_workspace_instructions",
    );
  }
  if (patch.privacy)
    await mergePolicy(client, "privacy", patch.privacy, "set_privacy");
  if (patch.chatDefaults) {
    await mergePolicy(
      client,
      "chatDefaults",
      patch.chatDefaults,
      "set_chat_defaults",
    );
  }
  if (patch.shell) {
    await mergePolicy(client, "shell", patch.shell, "set_shell");
  }
  if (patch.webSearch) {
    const webSearch = patch.webSearch;
    await client.updateRuntimePolicy((policy) => ({
      kind: "set_web_search",
      value: {
        ...policy.webSearch,
        ...(webSearch.enabled === undefined
          ? {}
          : { enabled: webSearch.enabled }),
        ...(webSearch.defaultProvider === undefined
          ? {}
          : { defaultProvider: webSearch.defaultProvider }),
      },
    }));
    const apiKey = webSearch.providers?.tavily?.apiKey;
    if (apiKey !== undefined && apiKey !== SENSITIVE_PLACEHOLDER) {
      if (apiKey.length === 0)
        await deleteCredential(client, WEB_SEARCH_CREDENTIAL);
      else await setCredential(client, WEB_SEARCH_CREDENTIAL, apiKey);
    }
  }
  if (patch.subagents) {
    await client.updateRuntimePolicy(() => ({
      kind: "set_subagents",
      value: patch.subagents!,
    }));
  }
  return skippedCredentials;
}

async function updateNetworkProxy(
  client: RuntimeHostSettingsClient,
  patch: NonNullable<NonNullable<UpdateAppSettingsInput["network"]>["proxy"]>,
): Promise<number> {
  const [policy, credential] = await Promise.all([
    client.queryRuntimePolicy(),
    client.queryCredential(PROXY_CREDENTIAL),
  ]);
  const networkProxy = {
    ...policy.policy.networkProxy,
    ...withoutCredential(patch),
  };
  const operation =
    patch.credential?.kind === "replace"
      ? patch.credential
      : !networkProxy.authEnabled || patch.credential?.kind === "delete"
        ? ({ kind: "delete" } as const)
        : ({ kind: "keep" } as const);
  const result = await client.updateNetworkProxy({
    expectedPolicyRevision: policy.revision,
    expectedCredential: credential?.configured
      ? {
          locator: credential.locator,
          credentialId: credential.credentialId,
          revision: credential.revision,
        }
      : null,
    networkProxy,
    credential: operation,
  });
  if (result.kind === "committed") return 0;
  if (result.kind === "proxy_target_mismatch") return 1;
  if (result.kind === "revision_conflict") {
    throw new Error("Runtime Host proxy policy changed while Desktop updated it");
  }
  throw new Error("Runtime Host proxy credential changed while Desktop updated it");
}

async function mergePolicy<
  K extends "memory" | "workspaceInstructions" | "privacy" | "chatDefaults" | "shell",
>(
  client: RuntimeHostSettingsClient,
  key: K,
  patch: Partial<RuntimePolicy[K]>,
  kind:
    | "set_memory"
    | "set_workspace_instructions"
    | "set_privacy"
    | "set_chat_defaults"
    | "set_shell",
): Promise<void> {
  await client.updateRuntimePolicy(
    ((policy) => ({
      kind,
      value: { ...policy[key], ...patch },
    })) as Parameters<DesktopRuntimeHostClient["updateRuntimePolicy"]>[0],
  );
}

async function setCredential(
  client: RuntimeHostSettingsClient,
  locator: CredentialLocator,
  secret: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await client.queryCredential(locator);
    const result = await client.setCredential({
      locator,
      expected: current?.configured
        ? { credentialId: current.credentialId, revision: current.revision }
        : null,
      secret,
    });
    if (result.kind === "committed") return;
    if (result.kind !== "credential_stale") {
      throw new Error("Runtime Host rejected the credential update");
    }
  }
  throw new Error("Credential kept changing while Desktop updated it");
}

async function deleteCredential(
  client: RuntimeHostSettingsClient,
  locator: CredentialLocator,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await client.queryCredential(locator);
    if (!current?.configured) return;
    const result = await client.deleteCredential({
      expected: {
        locator,
        credentialId: current.credentialId,
        revision: current.revision,
      },
    });
    if (result.kind === "committed") return;
    if (result.kind !== "credential_stale") {
      throw new Error("Runtime Host rejected the credential removal");
    }
  }
  throw new Error("Credential kept changing while Desktop removed it");
}

function withoutCredential(
  patch: NonNullable<NonNullable<UpdateAppSettingsInput["network"]>["proxy"]>,
): Partial<RuntimePolicy["networkProxy"]> {
  const {
    credential: _credential,
    password: _legacyPassword,
    passwordConfigured: _derivedStatus,
    ...value
  } = patch as typeof patch & {
    password?: unknown;
    passwordConfigured?: unknown;
  };
  return value;
}

function validateProxyPatch(
  proxy: NonNullable<UpdateAppSettingsInput["network"]>["proxy"] | undefined,
): void {
  const operation = proxy?.credential;
  if (!operation) return;
  if (operation.kind === "replace") {
    if (typeof operation.secret !== "string" || operation.secret.length === 0) {
      throw new Error("Proxy credential replacement requires a non-empty password");
    }
    if (proxy.authEnabled === false) {
      throw new Error(
        "Cannot replace the proxy credential while authentication is disabled",
      );
    }
    return;
  }
  if (operation.kind !== "delete") {
    throw new Error("Unsupported proxy credential operation");
  }
}
