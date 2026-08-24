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

import type { IpcMain } from 'electron';
import type { AppSettings, UpdateAppSettingsInput } from '@maka/core/settings';
import type { BotOnboardingSnapshot, BotOnboardingStartInput } from '@maka/core/bot-onboarding';
import type { BotProvider, BotReadinessState } from '@maka/core/bot-chat-settings';
import { tryResult } from '@maka/core/result';
import {
  getWechatBridgeQrCode,
  testBotChannel as testRuntimeBotChannel,
  type BotRegistry,
} from '@maka/runtime/bots';
import type { SettingsStore } from '@maka/storage';
import {
  BotOnboardingService,
  type BotOnboardingProviderAdapter,
} from './bot-onboarding-main.js';
import {
  botTestErrorMessage,
  toSettingsTestResult,
} from './settings-ipc-helpers.js';

export interface SettingsBotsIpcDeps {
  readonly ipcMain: Pick<IpcMain, 'handle'>;
  readonly settingsStore: SettingsStore;
  readonly botRegistry: BotRegistry;
  readonly applySettingsRuntimeEffects: (
    settings: AppSettings,
    patch: UpdateAppSettingsInput,
  ) => Promise<void>;
  readonly productVersion: string;
  readonly openExternal: (url: string) => Promise<unknown>;
  readonly botOnboardingAdapters?: Partial<
    Record<BotOnboardingStartInput['provider'], BotOnboardingProviderAdapter>
  >;
  readonly botOnboardingReadChannelStatus?: (
    provider: BotOnboardingStartInput['provider'],
  ) => { running: boolean; reason?: string };
}

export interface SettingsBotsIpcHandle {
  dispose(): void;
}

export function registerSettingsBotsIpc(
  deps: SettingsBotsIpcDeps,
): SettingsBotsIpcHandle {
  const botOnboarding = new BotOnboardingService({
    settingsStore: deps.settingsStore,
    botRegistry: deps.botRegistry,
    applySettingsRuntimeEffects: deps.applySettingsRuntimeEffects,
    adapters: deps.botOnboardingAdapters,
    ...(deps.botOnboardingReadChannelStatus
      ? { readChannelStatus: deps.botOnboardingReadChannelStatus }
      : {}),
    productVersion: deps.productVersion,
    openExternal: deps.openExternal,
  });

  deps.ipcMain.handle('settings:testBotChannel', async (_event, provider: BotProvider) => {
    const settings = await deps.settingsStore.get();
    const result = await testRuntimeBotChannel(
      provider,
      settings.botChat.channels[provider],
    );
    const channelPatch =
      result.verified === false
        ? { lastTestAt: Date.now() }
        : {
            connected: result.ok,
            readiness: (result.ok
              ? 'credentials_valid'
              : 'configured') as BotReadinessState,
            readinessReason: result.ok
              ? undefined
              : botTestErrorMessage(provider, result.error),
            readinessUpdatedAt: Date.now(),
            lastTestAt: Date.now(),
            lastError: result.ok
              ? undefined
              : botTestErrorMessage(provider, result.error),
          };
    await deps.settingsStore.update({
      botChat: { channels: { [provider]: channelPatch } },
    });
    const next = await deps.settingsStore.get();
    await deps.applySettingsRuntimeEffects(next, {
      botChat: { channels: { [provider]: {} } },
    });
    return toSettingsTestResult(provider, result);
  });
  deps.ipcMain.handle('settings:bots:listStatuses', () =>
    tryResult(async () => deps.botRegistry.allStatuses(), 'BOTS_STATUS_FAILED'),
  );
  deps.ipcMain.handle('settings:bots:restart', (_event, provider: BotProvider) =>
    tryResult(async () => {
      await deps.botRegistry.applySettings(
        (await deps.settingsStore.get()).botChat,
      );
      return deps.botRegistry.getStatus(provider);
    }, 'BOTS_RESTART_FAILED'),
  );
  deps.ipcMain.handle(
    'settings:bots:onboarding:start',
    (_event, input: BotOnboardingStartInput) =>
      tryResult<BotOnboardingSnapshot>(
        () => botOnboarding.start(input),
        'BOT_ONBOARDING_START_FAILED',
      ),
  );
  deps.ipcMain.handle(
    'settings:bots:onboarding:poll',
    (_event, sessionId: unknown) =>
      tryResult<BotOnboardingSnapshot>(
        () => botOnboarding.poll(sessionId),
        'BOT_ONBOARDING_POLL_FAILED',
      ),
  );
  deps.ipcMain.handle(
    'settings:bots:onboarding:cancel',
    (_event, sessionId: unknown) =>
      tryResult<BotOnboardingSnapshot>(
        async () => botOnboarding.cancel(sessionId),
        'BOT_ONBOARDING_CANCEL_FAILED',
      ),
  );
  deps.ipcMain.handle(
    'settings:bots:onboarding:open',
    (_event, sessionId: unknown) =>
      tryResult<void>(
        () => botOnboarding.openInBrowser(sessionId),
        'BOT_ONBOARDING_OPEN_FAILED',
      ),
  );
  deps.ipcMain.handle('settings:bots:wechatQrCode', async () =>
    getWechatBridgeQrCode(
      (await deps.settingsStore.get()).botChat.channels.wechat,
    ),
  );

  return { dispose: () => botOnboarding.dispose() };
}
