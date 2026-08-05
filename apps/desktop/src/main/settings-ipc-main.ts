import { app, ipcMain, shell } from "electron";
import type {
  AppSettings,
  BotOnboardingStartInput,
  SettingsTestResult,
  UpdateAppSettingsInput,
  UpdateAppSettingsResult,
} from "@maka/core";
import {
  SENSITIVE_PLACEHOLDER,
  type TestProxyInput,
} from "@maka/core/settings/network-settings";
import type { BotRegistry } from "@maka/runtime";
import { testProxyConnection } from "@maka/runtime/network/proxy-test";
import type { SettingsStore } from "@maka/storage";
import type { BotOnboardingProviderAdapter } from "./bot-onboarding-main.js";
import { toContractNetworkSettings } from "./network-settings-main.js";
import {
  buildSettingsUpdateResult,
  maskAppSettings,
  proxyTestFailure,
} from "./settings-ipc-helpers.js";
import { registerSettingsBotsIpc } from "./settings-bots-ipc-main.js";

export interface SettingsIpcDeps {
  settingsStore: SettingsStore;
  botRegistry: BotRegistry;
  normalizeSettingsPatch: (
    patch: UpdateAppSettingsInput,
  ) => Promise<UpdateAppSettingsInput>;
  applySettingsRuntimeEffects: (
    settings: AppSettings,
    patch: UpdateAppSettingsInput,
  ) => Promise<void>;
  botOnboardingAdapters?: Partial<
    Record<BotOnboardingStartInput["provider"], BotOnboardingProviderAdapter>
  >;
  botOnboardingApplySettingsRuntimeEffects?: (
    settings: AppSettings,
    patch: UpdateAppSettingsInput,
  ) => Promise<void>;
  botOnboardingReadChannelStatus?: (
    provider: BotOnboardingStartInput["provider"],
  ) => { running: boolean; reason?: string };
}

export interface SettingsIpcHandle {
  /** Tear down onboarding sessions (abort polls, clear the session map). */
  dispose(): void;
}

export function registerSettingsIpc(deps: SettingsIpcDeps): SettingsIpcHandle {
  const {
    settingsStore,
    botRegistry,
    normalizeSettingsPatch,
    applySettingsRuntimeEffects,
  } = deps;
  const bots = registerSettingsBotsIpc({
    ipcMain,
    settingsStore,
    botRegistry,
    applySettingsRuntimeEffects:
      deps.botOnboardingApplySettingsRuntimeEffects ??
      applySettingsRuntimeEffects,
    ...(deps.botOnboardingAdapters
      ? { botOnboardingAdapters: deps.botOnboardingAdapters }
      : {}),
    ...(deps.botOnboardingReadChannelStatus
      ? {
          botOnboardingReadChannelStatus: deps.botOnboardingReadChannelStatus,
        }
      : {}),
    productVersion: app.getVersion(),
    openExternal: (url) => shell.openExternal(url),
  });

  ipcMain.handle("settings:get", async () =>
    maskAppSettings(await settingsStore.get()),
  );
  ipcMain.handle(
    "settings:update",
    async (
      _event,
      patch: UpdateAppSettingsInput,
    ): Promise<UpdateAppSettingsResult> => {
      const normalizedPatch = await normalizeSettingsPatch(patch);
      const next = await settingsStore.update(normalizedPatch);
      await applySettingsRuntimeEffects(next, patch);
      return buildSettingsUpdateResult(next, patch);
    },
  );
  ipcMain.handle(
    "settings:testNetworkProxy",
    async (_event, input: TestProxyInput = {}) => {
      const started = Date.now();
      const stored = toContractNetworkSettings(
        (await settingsStore.get()).network,
      ).proxy;
      const proxy =
        input.proxy?.password === SENSITIVE_PLACEHOLDER
          ? { ...input.proxy, password: stored.password }
          : input.proxy;
      const testedProxy = proxy ?? stored;
      const result = await testProxyConnection({ ...input, proxy }, stored);
      const latencyMs = result.latencyMs ?? Date.now() - started;
      if (!result.ok) {
        const failure = proxyTestFailure(result);
        return {
          ok: false,
          ...failure,
          latencyMs,
          details: { status: result.status },
        } satisfies SettingsTestResult;
      }
      return {
        ok: true,
        code: "proxy_reachable",
        message: `The proxy ${testedProxy.type}://${testedProxy.host}:${testedProxy.port} is reachable.`,
        latencyMs,
        details: {
          endpoint: `${testedProxy.type}://${testedProxy.host}:${testedProxy.port}`,
          status: result.status,
          ip: result.ip,
          countryCode: result.countryCode,
          countryFlag: result.countryFlag,
          bypassList: testedProxy.bypassList,
        },
      } satisfies SettingsTestResult;
    },
  );
  return bots;
}
