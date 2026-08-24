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

import { useEffect, useRef, useState } from "react";
import type { AppSettings, UpdateAppSettingsResult } from '@maka/core/settings';
import type { BotOnboardingProvider } from '@maka/core/bot-onboarding';
import type { BotProvider } from '@maka/core/bot-chat-settings';
import type { BotStatus } from '@maka/runtime/bots';
import { useMountedRef, useToast, useUiLocale } from "@maka/ui";
import { settingsActionErrorMessage } from "./settings-error-copy";
import {
  BOT_LABELS,
  botStatusDetail,
  type BotPendingAction,
  type BotPendingActionName,
} from "./bot-chat-shared";
import { BotChatOverview } from "./bot-chat-overview";
import { BotChatChannelDetail } from "./bot-chat-detail";
import { getBotSettingsCopy } from "../locales/settings-bot-copy";
import { settingsTestResultMessage } from "../locales/settings-test-result-copy";

/**
 * Remote-access settings container: owns overview/detail routing, bot status
 * fetch + subscription, and the per-provider action lifecycles (test /
 * connect / restart / disconnect). The overview and detail views live in
 * `bot-chat-overview.tsx` and `bot-chat-detail.tsx`; shared brand metadata
 * and copy live in `bot-chat-shared.tsx`.
 */
export function BotChatSettingsPage(props: {
  settings: AppSettings;
  onUpdate(
    patch: Parameters<typeof window.maka.settings.update>[0],
  ): Promise<UpdateAppSettingsResult>;
  onReload(): Promise<void>;
}) {
  const [selected, setSelected] = useState<BotProvider>("telegram");
  const [detailOpen, setDetailOpen] = useState(false);
  // #1233 deferral: the `settings-bots-onboarding` e2e-fixture fixture opens a
  // provider's scan-login modal deterministically. `e2eFixture.getState()`
  // resolves null for real users, so this only fires under the dev fixture.
  const [autoOpenScanProvider, setAutoOpenScanProvider] =
    useState<BotOnboardingProvider | null>(null);
  const [pendingBotAction, setPendingBotAction] =
    useState<BotPendingAction | null>(null);
  const [statuses, setStatuses] = useState<Record<
    BotProvider,
    BotStatus
  > | null>(null);
  const [statusLoadError, setStatusLoadError] = useState<string | null>(null);
  const channel = props.settings.botChat.channels[selected];
  const toast = useToast();
  const locale = useUiLocale();
  const botCopy = getBotSettingsCopy(locale);
  const copy = botCopy.page;
  const selectedStatus = statuses?.[selected];
  const pendingBotActionRef = useRef<BotPendingAction | null>(null);
  const botPageMountedRef = useMountedRef();
  const botActionBusy = pendingBotAction !== null;
  const selectedBotActionPending =
    pendingBotAction?.provider === selected ? pendingBotAction.action : null;
  const restarting = selectedBotActionPending === "restart";

  useEffect(() => {
    return () => {
      pendingBotActionRef.current = null;
    };
  }, []);

  // #1233 deferral: under the settings-bots-onboarding e2e-fixture fixture,
  // jump straight to the seeded provider's detail view and flag the scan-login
  // modal to auto-open so the QR waiting state renders deterministically.
  useEffect(() => {
    let active = true;
    void window.maka.e2eFixture
      .getState()
      .then((fixtureState) => {
        if (!active || !fixtureState?.botOnboardingProvider) return;
        setSelected(fixtureState.botOnboardingProvider);
        setDetailOpen(true);
        setAutoOpenScanProvider(fixtureState.botOnboardingProvider);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  function beginBotAction(
    provider: BotProvider,
    action: BotPendingActionName,
  ): boolean {
    if (pendingBotActionRef.current !== null) return false;
    const next = { provider, action };
    pendingBotActionRef.current = next;
    setPendingBotAction(next);
    return true;
  }

  function finishBotAction(
    provider: BotProvider,
    action: BotPendingActionName,
  ) {
    const current = pendingBotActionRef.current;
    if (!current || current.provider !== provider || current.action !== action)
      return;
    pendingBotActionRef.current = null;
    if (botPageMountedRef.current) {
      setPendingBotAction(null);
    }
  }

  async function updateChannelFor(
    provider: BotProvider,
    patch: Partial<typeof channel>,
  ): Promise<boolean> {
    try {
      await props.onUpdate({ botChat: { channels: { [provider]: patch } } });
      if (!botPageMountedRef.current) return false;
      return true;
    } catch (error) {
      if (botPageMountedRef.current) {
        toast.error(
          copy.saveFailed(botCopy.providers[provider].label),
          settingsActionErrorMessage(error, locale),
        );
      }
      return false;
    }
  }

  async function updateChannel(
    patch: Partial<typeof channel>,
  ): Promise<boolean> {
    return updateChannelFor(selected, patch);
  }

  useEffect(() => {
    let active = true;
    void window.maka.settings.bots
      .listStatuses()
      .then((next) => {
        if (!active) return;
        setStatuses(next);
        setStatusLoadError(null);
      })
      .catch((error) => {
        if (!active) return;
        const message = settingsActionErrorMessage(error, locale);
        setStatusLoadError(message);
        toast.error(copy.loadFailed, message);
      });
    const unsubscribe = window.maka.settings.bots.subscribeStatusChanges(
      (status) => {
        if (!botPageMountedRef.current) return;
        setStatusLoadError(null);
        setStatuses((current) => ({
          ...(current ?? ({} as Record<BotProvider, BotStatus>)),
          [status.platform]: status,
        }));
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  async function testChannel() {
    const provider = selected;
    if (!beginBotAction(provider, "test")) return;
    try {
      const result = await window.maka.settings.testBotChannel(provider);
      if (!botPageMountedRef.current) return;
      const platform = botCopy.providers[provider].label;
      const message = settingsTestResultMessage(result, locale);
      if (result.ok) {
        // PR-BOT-CHAT-POLISH-0: title now matches kenji boundary 2's
        // 5-state readiness chain — a successful test PROVES
        // `credentials_valid`, NOT `operational`. The detail copy
        // still carries the IPC-side message so the user can see
        // latency / identity etc.
        toast.success(copy.credentialVerified(platform), message);
      } else {
        toast.error(copy.credentialTestFailed(platform), message);
      }
      await refreshBotStatuses();
    } catch (error) {
      if (botPageMountedRef.current) {
        toast.error(
          copy.testError(botCopy.providers[provider].label),
          settingsActionErrorMessage(error, locale),
        );
      }
    } finally {
      finishBotAction(provider, "test");
    }
  }

  /**
   * PR-BOT-SETTINGS-UI-0 (WAWQAQ msg `51c7b4ff`): combined "测试并连接"
   * action mirrors the reference design's primary CTA. Runs credential
   * test, then on success flips the enable toggle on and starts the
   * listener. On test failure stops at the credential step — does NOT
   * flip the toggle, so the user can fix the credentials and retry.
   */
  async function testAndConnect() {
    const provider = selected;
    const providerChannel = props.settings.botChat.channels[provider];
    const providerSupport = BOT_LABELS[provider].support;
    if (!beginBotAction(provider, "connect")) return;
    let testOk = false;
    try {
      const result = await window.maka.settings.testBotChannel(provider);
      if (!botPageMountedRef.current) return;
      const platform = botCopy.providers[provider].label;
      const message = settingsTestResultMessage(result, locale);
      testOk = result.ok;
      if (result.ok) {
        toast.success(copy.credentialVerified(platform), message);
      } else {
        toast.error(copy.credentialTestFailed(platform), message);
      }
      await refreshBotStatuses();
    } catch (error) {
      if (botPageMountedRef.current) {
        toast.error(
          copy.testError(botCopy.providers[provider].label),
          settingsActionErrorMessage(error, locale),
        );
      }
      finishBotAction(provider, "connect");
      return;
    }
    try {
      if (!botPageMountedRef.current) return;
      if (!testOk || providerSupport !== "runtime") return;
      if (!providerChannel.enabled) {
        const saved = await updateChannelFor(provider, { enabled: true });
        if (!saved) return;
      }
      if (!botPageMountedRef.current) return;
      await restartBotProvider(provider);
    } finally {
      finishBotAction(provider, "connect");
    }
  }

  async function restartBotProvider(provider: BotProvider): Promise<boolean> {
    if (!botPageMountedRef.current) return false;
    try {
      const status = await window.maka.settings.bots.restart(provider);
      if (!botPageMountedRef.current) return status.running;
      setStatuses((current) => ({
        ...(current ?? ({} as Record<BotProvider, BotStatus>)),
        [status.platform]: status,
      }));
      // PR-BOT-CHAT-POLISH-0: tone follows actual runtime state, not
      // the bare fact that the restart command returned. A restarted
      // bot that immediately stops (e.g. token rejected, network
      // down) was previously surfaced as a green success toast.
      const platform = botCopy.providers[provider].label;
      if (status.running) {
        toast.success(
          copy.listening(platform),
          botStatusDetail(status, locale),
        );
      } else {
        toast.error(
          copy.notListening(platform),
          botStatusDetail(status, locale),
        );
      }
      return status.running;
    } catch (error) {
      if (!botPageMountedRef.current) return false;
      const message = settingsActionErrorMessage(error, locale);
      toast.error(copy.startFailed(botCopy.providers[provider].label), message);
      return false;
    }
  }

  async function restartChannel() {
    const provider = selected;
    if (!beginBotAction(provider, "restart")) return;
    try {
      await restartBotProvider(provider);
    } finally {
      finishBotAction(provider, "restart");
    }
  }

  async function refreshBotStatuses(): Promise<boolean> {
    if (!botPageMountedRef.current) return false;
    try {
      await props.onReload();
      if (!botPageMountedRef.current) return false;
      const nextStatuses = await window.maka.settings.bots.listStatuses();
      if (!botPageMountedRef.current) return false;
      setStatuses(nextStatuses);
      setStatusLoadError(null);
      return true;
    } catch (error) {
      if (!botPageMountedRef.current) return false;
      const message = settingsActionErrorMessage(error, locale);
      setStatusLoadError(message);
      toast.error(copy.refreshFailed, message);
      return false;
    }
  }

  async function disconnectLinkedSession() {
    const provider = selected;
    const providerChannel = props.settings.botChat.channels[provider];
    if (provider !== "wechat") return;
    if (!beginBotAction(provider, "disconnect")) return;
    try {
      const ok = await toast.confirm({
        title: copy.disconnectTitle,
        description: copy.disconnectDescription,
        confirmLabel: copy.disconnect,
        cancelLabel: copy.cancel,
        destructive: true,
      });
      if (!ok) return;
      const isIlink =
        providerChannel.webhookUrl
          ?.trim()
          .startsWith("https://ilinkai.weixin.qq.com") ?? false;
      const saved = await updateChannelFor(provider, {
        token: "",
        ...(isIlink ? { webhookUrl: "" } : {}),
        botUserId: undefined,
        connected: false,
        readiness: "scaffolded",
        readinessReason: undefined,
        readinessUpdatedAt: Date.now(),
        lastError: undefined,
      });
      if (!saved) return;
      if (!botPageMountedRef.current) return;
      await refreshBotStatuses();
      if (botPageMountedRef.current) {
        toast.success(copy.disconnected, copy.credentialsCleared);
      }
    } finally {
      finishBotAction(provider, "disconnect");
    }
  }

  function openChannel(provider: BotProvider) {
    setSelected(provider);
    setDetailOpen(true);
  }

  if (!detailOpen) {
    return (
      <BotChatOverview
        channels={props.settings.botChat.channels}
        statuses={statuses}
        statusLoadError={statusLoadError}
        onOpenChannel={openChannel}
        onRefreshStatuses={refreshBotStatuses}
      />
    );
  }

  return (
    <BotChatChannelDetail
      provider={selected}
      autoOpenScanLogin={autoOpenScanProvider === selected}
      channel={channel}
      status={selectedStatus}
      statusLoadError={statusLoadError}
      actionBusy={botActionBusy}
      pendingAction={selectedBotActionPending}
      restarting={restarting}
      onBack={() => setDetailOpen(false)}
      onUpdateChannel={updateChannel}
      onTest={testChannel}
      onTestAndConnect={testAndConnect}
      onRestart={restartChannel}
      onDisconnectSession={disconnectLinkedSession}
      onReload={props.onReload}
      onRefreshStatuses={refreshBotStatuses}
    />
  );
}
