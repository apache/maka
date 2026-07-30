import { app, ipcMain, shell } from 'electron';
import {
  generalizedErrorMessageChinese,
  redactSecrets,
} from '@maka/core';
import type {
  AppSettings,
  BotOnboardingSnapshot,
  BotOnboardingStartInput,
  BotProvider,
  BotReadinessState,
  SettingsTestResult,
  UpdateAppSettingsInput,
  UpdateAppSettingsResult,
} from '@maka/core';
import {
  SENSITIVE_PLACEHOLDER,
  type TestProxyInput,
  type TestProxyResult,
} from '@maka/core/settings/network-settings';
import { tryResult } from '@maka/core/result';
import {
  getWechatBridgeQrCode,
  testBotChannel as testRuntimeBotChannel,
} from '@maka/runtime';
import type { BotRegistry } from '@maka/runtime';
import { testProxyConnection } from '@maka/runtime/network/proxy-test';
import type { SettingsStore } from '@maka/storage';
import {
  BotOnboardingService,
  type BotOnboardingProviderAdapter,
} from './bot-onboarding-main.js';
import { toContractNetworkSettings } from './network-settings-main.js';
import {
  botTestErrorMessage,
  buildSettingsUpdateResult,
  maskAppSettings,
  toSettingsTestResult,
} from './settings-ipc-helpers.js';

export interface SettingsIpcDeps {
  settingsStore: SettingsStore;
  botRegistry: BotRegistry;
  normalizeSettingsPatch: (patch: UpdateAppSettingsInput) => Promise<UpdateAppSettingsInput>;
  applySettingsRuntimeEffects: (settings: AppSettings, patch: UpdateAppSettingsInput) => Promise<void>;
  botOnboardingAdapters?: Partial<Record<BotOnboardingStartInput['provider'], BotOnboardingProviderAdapter>>;
  botOnboardingApplySettingsRuntimeEffects?: (settings: AppSettings, patch: UpdateAppSettingsInput) => Promise<void>;
  botOnboardingReadChannelStatus?: (
    provider: BotOnboardingStartInput['provider'],
  ) => { running: boolean; reason?: string };
}

function proxyTestFailureMessage(result: TestProxyResult): string {
  const raw = redactSecrets(result.error ?? '').trim();
  const lower = raw.toLowerCase();
  if (lower.includes('proxy disabled')) return '代理未启用，请先打开代理开关。';
  if (lower.includes('proxy host/port required')) return '请填写代理服务器地址和端口后再测试。';
  if (lower.includes('proxy test timeout') || lower.includes('timeout')) return '代理测试超时，请检查代理服务是否可达。';
  if (result.status) return `代理测试返回 HTTP ${result.status}，请检查代理服务或测试地址。`;
  const classified = generalizedErrorMessageChinese(raw, '');
  if (classified) return classified;
  if (raw && /[\u4E00-\u9FFF]/.test(raw)) return raw;
  return '代理不可达，请检查代理服务器地址、端口或认证信息。';
}

export interface SettingsIpcHandle {
  /** Tear down onboarding sessions (abort polls, clear the session map). */
  dispose(): void;
}

export function registerSettingsIpc(deps: SettingsIpcDeps): SettingsIpcHandle {
  const { settingsStore, botRegistry, normalizeSettingsPatch, applySettingsRuntimeEffects } = deps;
  const botOnboarding = new BotOnboardingService({
    settingsStore,
    botRegistry,
    applySettingsRuntimeEffects: deps.botOnboardingApplySettingsRuntimeEffects ?? applySettingsRuntimeEffects,
    adapters: deps.botOnboardingAdapters,
    ...(deps.botOnboardingReadChannelStatus
      ? { readChannelStatus: deps.botOnboardingReadChannelStatus }
      : {}),
    productVersion: app.getVersion(),
    openExternal: (url) => shell.openExternal(url),
  });

  ipcMain.handle('settings:get', async () => maskAppSettings(await settingsStore.get()));
  ipcMain.handle('settings:update', async (_event, patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsResult> => {
    const normalizedPatch = await normalizeSettingsPatch(patch);
    const next = await settingsStore.update(normalizedPatch);
    await applySettingsRuntimeEffects(next, patch);
    return buildSettingsUpdateResult(next, patch);
  });
  ipcMain.handle('settings:testNetworkProxy', async (_event, input: TestProxyInput = {}) => {
    const started = Date.now();
    const stored = toContractNetworkSettings((await settingsStore.get()).network).proxy;
    const proxy = input.proxy?.password === SENSITIVE_PLACEHOLDER
      ? { ...input.proxy, password: stored.password }
      : input.proxy;
    const testedProxy = proxy ?? stored;
    const result = await testProxyConnection({ ...input, proxy }, stored);
    const latencyMs = result.latencyMs ?? (Date.now() - started);
    if (!result.ok) {
      return {
        ok: false,
        message: proxyTestFailureMessage(result),
        latencyMs,
      } satisfies SettingsTestResult;
    }
    return {
      ok: true,
      message: result.ip
        ? `代理配置有效：${testedProxy.type}://${testedProxy.host}:${testedProxy.port} · ${result.countryFlag ?? ''} ${result.ip}`.trim()
        : `代理配置有效：${testedProxy.type}://${testedProxy.host}:${testedProxy.port}`,
      latencyMs,
      details: {
        status: result.status,
        ip: result.ip,
        countryCode: result.countryCode,
        countryFlag: result.countryFlag,
        bypassList: testedProxy.bypassList,
      },
    } satisfies SettingsTestResult;
  });
  ipcMain.handle('settings:testBotChannel', async (_event, provider: BotProvider) => {
    const settings = await settingsStore.get();
    const result = await testRuntimeBotChannel(provider, settings.botChat.channels[provider]);
    // PR1197 review (P1-4): an unverified probe (`verified === false`, e.g. the
    // WeCom AI-bot shape check) proves nothing about live connectivity, so it
    // must NOT overwrite connected/readiness — doing so would mark a working
    // channel disconnected. Record only that a test ran; the live bridge status
    // stays authoritative. A real credential probe persists the outcome as before.
    const channelPatch = result.verified === false
      ? { lastTestAt: Date.now() }
      : {
          connected: result.ok,
          readiness: (result.ok ? 'credentials_valid' : 'configured') as BotReadinessState,
          readinessReason: result.ok ? undefined : botTestErrorMessage(provider, result.error),
          readinessUpdatedAt: Date.now(),
          lastTestAt: Date.now(),
          lastError: result.ok ? undefined : botTestErrorMessage(provider, result.error),
        };
    await settingsStore.update({
      botChat: {
        channels: {
          [provider]: channelPatch,
        },
      },
    });
    const next = await settingsStore.get();
    await applySettingsRuntimeEffects(next, { botChat: { channels: { [provider]: {} } } });
    return toSettingsTestResult(provider, result);
  });
  ipcMain.handle('settings:bots:listStatuses', () =>
    tryResult(async () => botRegistry.allStatuses(), 'BOTS_STATUS_FAILED'),
  );
  ipcMain.handle('settings:bots:restart', (_event, provider: BotProvider) =>
    tryResult(async () => {
      const settings = await settingsStore.get();
      await botRegistry.applySettings(settings.botChat);
      return botRegistry.getStatus(provider);
    }, 'BOTS_RESTART_FAILED'),
  );
  ipcMain.handle('settings:bots:onboarding:start', (_event, input: BotOnboardingStartInput) =>
    tryResult<BotOnboardingSnapshot>(
      () => botOnboarding.start(input),
      'BOT_ONBOARDING_START_FAILED',
    ),
  );
  ipcMain.handle('settings:bots:onboarding:poll', (_event, sessionId: unknown) =>
    tryResult<BotOnboardingSnapshot>(
      () => botOnboarding.poll(sessionId),
      'BOT_ONBOARDING_POLL_FAILED',
    ),
  );
  ipcMain.handle('settings:bots:onboarding:cancel', (_event, sessionId: unknown) =>
    tryResult<BotOnboardingSnapshot>(
      async () => botOnboarding.cancel(sessionId),
      'BOT_ONBOARDING_CANCEL_FAILED',
    ),
  );
  ipcMain.handle('settings:bots:onboarding:open', (_event, sessionId: unknown) =>
    tryResult<void>(
      () => botOnboarding.openInBrowser(sessionId),
      'BOT_ONBOARDING_OPEN_FAILED',
    ),
  );

  ipcMain.handle('settings:bots:wechatQrCode', async () => {
    const settings = await settingsStore.get();
    return getWechatBridgeQrCode(settings.botChat.channels.wechat);
  });

  return { dispose: () => botOnboarding.dispose() };
}
