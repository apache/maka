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

import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { AppSettings, UpdateAppSettingsInput } from '@maka/core/settings';
import type { BotChannelSettings } from '@maka/core/bot-chat-settings';
import type {
  BotOnboardingBrand,
  BotOnboardingProvider,
  BotOnboardingSnapshot,
  BotOnboardingStartInput,
  BotOnboardingState,
} from '@maka/core/bot-onboarding';
import { generalizedErrorMessageChinese, redactSecrets } from '@maka/core/redaction';
import { isBotOnboardingBrand, isBotOnboardingProvider } from '@maka/core/bot-onboarding';
import type { BotRegistry } from '@maka/runtime/bots';
import { proxiedFetch } from '@maka/runtime/bots';
import type { SettingsStore } from '@maka/storage';
import { createQQBindTask, pollQQBindTask } from './qq-bot-scan-login.js';
import { fetchWeChatQrcode, pollWeChatQrcodeStatus } from './wechat-scan-login.js';

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 30_000;
const DEFAULT_EXPIRES_IN_SECONDS = 10 * 60;
const DINGTALK_EXPIRES_IN_SECONDS = 2 * 60 * 60;
/** Consecutive transient poll failures tolerated before a session goes terminal. */
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

/**
 * Channel fields written by `channelPatchFromCredential` that are NOT part of
 * the credential identity: the runtime status/readiness writer owns these and
 * mutates them concurrently. They must be excluded from the rollback CAS
 * predicate (see rollbackCredential) so an unrelated status write cannot defeat
 * a cancel rollback.
 */
const VOLATILE_STATUS_FIELDS: ReadonlyArray<keyof BotChannelSettings> = [
  'connected',
  'readiness',
  'readinessReason',
  'readinessUpdatedAt',
  'lastError',
];

type OnboardingCredential =
  | { provider: 'dingtalk'; clientId: string; clientSecret: string }
  | { provider: 'feishu'; appId: string; appSecret: string; brand: BotOnboardingBrand; botName?: string }
  | { provider: 'wecom'; botId: string; secret: string }
  | { provider: 'wechat'; botToken: string; baseUrl: string; botId: string; userId: string }
  | { provider: 'qq'; appId: string; appSecret: string };

type ProviderStartResult = {
  opaqueToken: string;
  qrValue?: string;
  qrCodeDataUrl?: string;
  verificationUrl?: string;
  pollIntervalMs: number;
  expiresInSeconds: number;
};

type ProviderPollResult =
  | { status: 'pending' | 'scanned' | 'slow_down' }
  | { status: 'expired' | 'denied'; error?: string }
  | { status: 'confirmed'; credential: OnboardingCredential; identity?: { id?: string; displayName?: string } };

export interface BotOnboardingProviderAdapter {
  start(input: BotOnboardingStartInput, signal: AbortSignal): Promise<ProviderStartResult>;
  poll(session: Readonly<BotOnboardingSession>, signal: AbortSignal): Promise<ProviderPollResult>;
}

interface BotOnboardingSession {
  id: string;
  provider: BotOnboardingProvider;
  brand?: BotOnboardingBrand;
  state: BotOnboardingState | 'starting';
  opaqueToken?: string;
  qrCodeDataUrl?: string;
  verificationUrl?: string;
  expiresAt?: number;
  pollIntervalMs: number;
  nextPollAt: number;
  controller: AbortController;
  pollPromise?: Promise<BotOnboardingSnapshot>;
  pollFailures: number;
  identity?: { id?: string; displayName?: string };
  error?: string;
  warning?: string;
}

export interface BotOnboardingServiceDeps {
  settingsStore: SettingsStore;
  botRegistry: BotRegistry;
  applySettingsRuntimeEffects(settings: AppSettings, patch: UpdateAppSettingsInput): Promise<void>;
  adapters?: Partial<Record<BotOnboardingProvider, BotOnboardingProviderAdapter>>;
  now?: () => number;
  createId?: () => string;
  openExternal?: (url: string) => Promise<unknown>;
  productVersion?: string;
  /**
   * Fixture/test seam for the post-persist connection-health read (P0-3).
   * Defaults to the live `botRegistry.getStatus`. The dev-only e2e-fixture
   * fixture overrides it because it deliberately no-ops runtime effects (so no
   * real bridge starts) yet still demonstrates the successful "connected" path.
   */
  readChannelStatus?: (provider: BotOnboardingProvider) => { running: boolean; reason?: string };
}

/**
 * Main-process authority for QR onboarding. Device codes, provider secrets,
 * polling and credential persistence remain outside the renderer process.
 */
export class BotOnboardingService {
  private readonly sessions = new Map<string, BotOnboardingSession>();
  private readonly currentByProvider = new Map<BotOnboardingProvider, string>();
  private readonly adapters: Record<BotOnboardingProvider, BotOnboardingProviderAdapter>;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly openExternal: (url: string) => Promise<unknown>;
  private readonly readChannelStatus: (provider: BotOnboardingProvider) => { running: boolean; reason?: string };

  constructor(private readonly deps: BotOnboardingServiceDeps) {
    this.adapters = createProductionBotOnboardingAdapters(deps.productVersion ?? '0.1.0');
    for (const provider of BOT_ONBOARDING_PROVIDER_KEYS) {
      const override = deps.adapters?.[provider];
      if (override) this.adapters[provider] = override;
    }
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? randomUUID;
    this.readChannelStatus = deps.readChannelStatus
      ?? ((provider) => this.deps.botRegistry.getStatus(provider));
    this.openExternal = deps.openExternal ?? (async () => {
      throw new Error('External browser opening is unavailable');
    });
  }

  async start(rawInput: unknown): Promise<BotOnboardingSnapshot> {
    const input = parseStartInput(rawInput);
    this.cancelCurrent(input.provider);
    // PR1197 review (P2-9): the session map is otherwise append-only. Evict
    // terminal/superseded sessions (never the live current one per provider) so
    // repeated onboarding attempts don't leak session objects for the app's life.
    this.pruneSessions();

    const session: BotOnboardingSession = {
      id: this.createId(),
      provider: input.provider,
      brand: input.provider === 'feishu' ? (input.brand ?? 'feishu') : undefined,
      state: 'starting',
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      nextPollAt: 0,
      controller: new AbortController(),
      pollFailures: 0,
    };
    this.sessions.set(session.id, session);
    this.currentByProvider.set(session.provider, session.id);

    try {
      const result = await this.adapters[session.provider].start(
        { provider: session.provider, brand: session.brand },
        session.controller.signal,
      );
      this.assertCurrent(session);
      session.opaqueToken = result.opaqueToken;
      session.qrCodeDataUrl = result.qrCodeDataUrl ?? (await renderQrCode(result.qrValue ?? ''));
      session.verificationUrl = result.verificationUrl;
      session.pollIntervalMs = clampPollInterval(result.pollIntervalMs);
      session.expiresAt = this.now() + Math.max(1, result.expiresInSeconds) * 1_000;
      session.nextPollAt = this.now() + session.pollIntervalMs;
      session.state = 'waiting';
      // PR1197 review (P2-13): the QR data URL is large; emit it only on the
      // start snapshot. The modal caches it and every subsequent poll snapshot
      // omits it to keep the IPC payload small.
      return this.snapshot(session, true);
    } catch (error) {
      if (session.controller.signal.aborted || !this.isCurrent(session)) {
        session.state = 'cancelled';
        throw new Error('Bot onboarding cancelled');
      }
      session.state = 'error';
      session.error = safeProviderError(error);
      throw new Error(session.error);
    }
  }

  async poll(rawSessionId: unknown): Promise<BotOnboardingSnapshot> {
    const session = this.getSession(rawSessionId);
    if (session.state !== 'waiting' && session.state !== 'scanned') {
      return this.snapshot(session);
    }
    if (session.expiresAt !== undefined && session.expiresAt <= this.now()) {
      session.state = 'expired';
      return this.snapshot(session);
    }
    if (session.nextPollAt > this.now()) return this.snapshot(session);
    if (session.pollPromise) return session.pollPromise;

    const operation = this.pollOnce(session).finally(() => {
      if (session.pollPromise === operation) session.pollPromise = undefined;
    });
    session.pollPromise = operation;
    return operation;
  }

  cancel(rawSessionId: unknown): BotOnboardingSnapshot {
    const session = this.getSession(rawSessionId);
    this.cancelSession(session);
    return this.snapshot(session);
  }

  async openInBrowser(rawSessionId: unknown): Promise<void> {
    const session = this.getSession(rawSessionId);
    this.assertCurrent(session);
    if (!session.verificationUrl) throw new Error('This onboarding session has no browser URL');
    const url = new URL(session.verificationUrl);
    if (url.protocol !== 'https:') throw new Error('Only HTTPS onboarding URLs are allowed');
    await this.openExternal(url.toString());
  }

  dispose(): void {
    for (const session of this.sessions.values()) this.cancelSession(session);
    this.sessions.clear();
    this.currentByProvider.clear();
  }

  private async pollOnce(session: BotOnboardingSession): Promise<BotOnboardingSnapshot> {
    try {
      const result = await this.adapters[session.provider].poll(session, session.controller.signal);
      this.assertCurrent(session);
      // A response of any kind clears the transient-failure streak.
      session.pollFailures = 0;
      switch (result.status) {
        case 'pending':
          session.state = 'waiting';
          session.nextPollAt = this.now() + session.pollIntervalMs;
          break;
        case 'scanned':
          session.state = 'scanned';
          session.nextPollAt = this.now() + session.pollIntervalMs;
          break;
        case 'slow_down':
          session.state = 'waiting';
          session.pollIntervalMs = Math.min(session.pollIntervalMs + 5_000, MAX_POLL_INTERVAL_MS);
          session.nextPollAt = this.now() + session.pollIntervalMs;
          break;
        case 'expired':
          session.state = 'expired';
          session.error = result.error;
          break;
        case 'denied':
          session.state = 'denied';
          session.error = result.error;
          break;
        case 'confirmed':
          session.state = 'connecting';
          await this.persistCredential(session, result.credential);
          this.assertCurrent(session);
          session.identity = result.identity ?? identityFromCredential(result.credential);
          session.state = 'connected';
          // PR1197 review (P0-3): credentials are saved and valid, but the live
          // bridge may have failed to start (bot-registry swallows start()
          // errors — logs only). Read the channel's REAL runtime status; if the
          // bridge is not running, surface an honest warning instead of lying
          // about a healthy connection. Onboarding still succeeds — the user can
          // retry the connection later from settings.
          session.warning = this.connectionWarning(session.provider);
          break;
      }
      return this.snapshot(session);
    } catch (error) {
      if (session.controller.signal.aborted || !this.isCurrent(session)) {
        session.state = 'cancelled';
        return this.snapshot(session);
      }
      // PR1197 review (P1-5): a transient blip (timeout / network / server 5xx /
      // 429) must not burn a still-valid, possibly long-lived device code (e.g.
      // DingTalk's 2h window). Keep the session in its waiting/scanned state and
      // retry with backoff until enough CONSECUTIVE failures accumulate; only
      // then surface a terminal error. A definite provider/protocol error is
      // fatal immediately.
      if (isTransientPollError(error)) {
        session.pollFailures += 1;
        if (session.pollFailures < MAX_CONSECUTIVE_POLL_FAILURES) {
          session.pollIntervalMs = Math.min(session.pollIntervalMs + 2_000, MAX_POLL_INTERVAL_MS);
          session.nextPollAt = this.now() + session.pollIntervalMs;
          return this.snapshot(session);
        }
      }
      session.state = 'error';
      session.error = safeProviderError(error);
      return this.snapshot(session);
    }
  }

  private async persistCredential(session: BotOnboardingSession, credential: OnboardingCredential): Promise<void> {
    this.assertCurrent(session);
    const previousSettings = await this.deps.settingsStore.get();
    this.assertCurrent(session);
    const previousChannel = previousSettings.botChat.channels[session.provider];
    const channelPatch = channelPatchFromCredential(credential);
    const patch: UpdateAppSettingsInput = {
      botChat: { channels: { [session.provider]: channelPatch } },
    };
    const next = await this.deps.settingsStore.update(patch);
    const installedChannel = next.botChat.channels[session.provider];
    const ownedFields = Object.keys(channelPatch) as Array<keyof BotChannelSettings>;
    // Guard both sides of the runtime-effect commit window: if the session was
    // superseded/cancelled either right after the write or during the effect,
    // roll the credential back and bail.
    await this.rollbackIfSuperseded(session, previousChannel, installedChannel, ownedFields);
    await this.deps.applySettingsRuntimeEffects(next, patch);
    await this.rollbackIfSuperseded(session, previousChannel, installedChannel, ownedFields);
    const runtimeStatus = this.deps.botRegistry.getStatus(session.provider);
    if (runtimeStatus.identity) {
      session.identity = {
        id: runtimeStatus.identity.id,
        displayName: runtimeStatus.identity.displayName ?? runtimeStatus.identity.username,
      };
    }
  }

  private async rollbackIfSuperseded(
    session: BotOnboardingSession,
    previousChannel: AppSettings['botChat']['channels'][BotOnboardingProvider],
    installedChannel: BotChannelSettings,
    ownedFields: ReadonlyArray<keyof BotChannelSettings>,
  ): Promise<void> {
    if (this.isCurrent(session)) return;
    await this.rollbackCredential(session.provider, previousChannel, installedChannel, ownedFields);
    this.assertCurrent(session);
  }

  private async rollbackCredential(
    provider: BotOnboardingProvider,
    previousChannel: AppSettings['botChat']['channels'][BotOnboardingProvider],
    installedChannel: BotChannelSettings,
    ownedFields: ReadonlyArray<keyof BotChannelSettings>,
  ): Promise<void> {
    const previousValues = pickChannelFields(previousChannel, ownedFields);
    const rollbackPatch: UpdateAppSettingsInput = {
      botChat: { channels: { [provider]: previousValues } },
    };
    // PR1197 review (P0-2): the CAS predicate must compare ONLY the
    // credential-identity fields this onboarding owns exclusively. The full
    // `ownedFields` set also carries volatile status fields
    // (connected/readiness/readinessReason/readinessUpdatedAt/lastError) that
    // main.ts's concurrent onStatusChange persistence writer mutates during the
    // applySettingsRuntimeEffects window. Comparing those would let an unrelated
    // status write flip the predicate false and silently no-op the rollback,
    // leaving live credentials behind after a cancel. Narrowing to the identity
    // fields keeps the safety property the ":195" test pins: a LATER
    // user-initiated credential edit (which DOES change identity fields) still
    // flips the predicate false and is never clobbered.
    const identityFields = ownedFields.filter((field) => !VOLATILE_STATUS_FIELDS.includes(field));
    const rollback = await this.deps.settingsStore.updateIf(
      (current) => channelFieldsEqual(
        current.botChat.channels[provider],
        installedChannel,
        identityFields,
      ),
      rollbackPatch,
    );
    if (rollback.applied) {
      await this.deps.applySettingsRuntimeEffects(rollback.settings, rollbackPatch);
    }
  }

  /**
   * Inspect the live bridge status for a just-persisted channel. Returns an
   * honest, secret-free notice when the credentials were saved but the bridge
   * is not actually running, or `undefined` when the connection is healthy.
   */
  private connectionWarning(provider: BotOnboardingProvider): string | undefined {
    const status = this.readChannelStatus(provider);
    if (status.running) return undefined;
    const reason = connectionFailureReason(status.reason);
    return reason
      ? `凭据已保存，但连接未建立：${reason}，可稍后在设置中重试。`
      : '凭据已保存，但连接未建立，可稍后在设置中重试。';
  }

  private getSession(rawSessionId: unknown): BotOnboardingSession {
    if (typeof rawSessionId !== 'string' || !rawSessionId) throw new Error('sessionId must be a non-empty string');
    const session = this.sessions.get(rawSessionId);
    if (!session) throw new Error('Unknown bot onboarding session');
    return session;
  }

  private cancelCurrent(provider: BotOnboardingProvider): void {
    const currentId = this.currentByProvider.get(provider);
    if (!currentId) return;
    const current = this.sessions.get(currentId);
    if (current) this.cancelSession(current);
  }

  /** Drop terminal/superseded sessions, always keeping the live current one. */
  private pruneSessions(): void {
    for (const [id, session] of this.sessions) {
      if (this.currentByProvider.get(session.provider) === id) continue;
      if (session.controller.signal.aborted || isTerminalOnboardingState(session.state)) {
        this.sessions.delete(id);
      }
    }
  }

  private cancelSession(session: BotOnboardingSession): void {
    if (!session.controller.signal.aborted) session.controller.abort();
    if (session.state !== 'connected' && session.state !== 'expired' && session.state !== 'denied') {
      session.state = 'cancelled';
    }
    if (this.currentByProvider.get(session.provider) === session.id) {
      this.currentByProvider.delete(session.provider);
    }
  }

  private isCurrent(session: BotOnboardingSession): boolean {
    return !session.controller.signal.aborted
      && this.currentByProvider.get(session.provider) === session.id;
  }

  private assertCurrent(session: BotOnboardingSession): void {
    if (!this.isCurrent(session)) throw new Error('Bot onboarding session is no longer active');
  }

  private snapshot(session: BotOnboardingSession, includeQrCode = false): BotOnboardingSnapshot {
    const state = session.state === 'starting' ? 'waiting' : session.state;
    return {
      sessionId: session.id,
      provider: session.provider,
      ...(session.brand ? { brand: session.brand } : {}),
      state,
      ...(includeQrCode && session.qrCodeDataUrl ? { qrCodeDataUrl: session.qrCodeDataUrl } : {}),
      ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}),
      nextPollAfterMs: Math.max(0, session.nextPollAt - this.now()),
      canOpenInBrowser: Boolean(session.verificationUrl),
      ...(session.identity ? { identity: { ...session.identity } } : {}),
      ...(session.error ? { error: session.error } : {}),
      ...(session.warning ? { warning: session.warning } : {}),
    };
  }
}

function parseStartInput(value: unknown): BotOnboardingStartInput {
  if (!value || typeof value !== 'object') throw new Error('Bot onboarding input is required');
  const raw = value as { provider?: unknown; brand?: unknown };
  if (!isBotOnboardingProvider(raw.provider)) throw new Error('Unsupported bot onboarding provider');
  if (raw.brand !== undefined && !isBotOnboardingBrand(raw.brand)) throw new Error('Unsupported bot onboarding brand');
  if (raw.provider !== 'feishu' && raw.brand !== undefined) throw new Error('brand is only valid for Feishu onboarding');
  return { provider: raw.provider, ...(raw.brand ? { brand: raw.brand } : {}) };
}

function isTerminalOnboardingState(state: BotOnboardingSession['state']): boolean {
  return state === 'connected'
    || state === 'expired'
    || state === 'denied'
    || state === 'cancelled'
    || state === 'error';
}

function clampPollInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(Math.max(Math.round(value), 1_000), MAX_POLL_INTERVAL_MS);
}

function safeProviderError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return '扫码接入已取消。';
  // PR1197 review (P2-11): route through the shared categorizer so 超时 / 鉴权失败 /
  // 网络错误 survive as specific Chinese copy instead of collapsing to one generic
  // line. The helper redacts secrets before returning.
  return generalizedErrorMessageChinese(error, '扫码接入暂时不可用，请稍后重试。');
}

/**
 * Classify a poll error as a transient blip worth retrying (timeout, network
 * fault, server 5xx, or 429 rate limit) versus a fatal provider/protocol error.
 * User-initiated aborts are filtered out before this runs.
 */
function isTransientPollError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const message = error.message.toLowerCase();
  if (/fetch failed|network|socket|econn|enotfound|eai_again|und_err|timeout|timed out/.test(message)) {
    return true;
  }
  const httpMatch = message.match(/http (\d{3})/);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    return status === 429 || status >= 500;
  }
  return false;
}

function channelPatchFromCredential(credential: OnboardingCredential): Partial<BotChannelSettings> {
  const common = {
    enabled: true,
    connected: false,
    readiness: 'configured' as const,
    readinessReason: undefined,
    readinessUpdatedAt: Date.now(),
    lastError: undefined,
  };
  switch (credential.provider) {
    case 'dingtalk':
      return { ...common, appId: credential.clientId, appSecret: credential.clientSecret };
    case 'feishu':
      return {
        ...common,
        appId: credential.appId,
        appSecret: credential.appSecret,
        domain: credential.brand === 'lark' ? 'larksuite.com' : 'feishu.cn',
      };
    case 'wecom':
      return { ...common, appId: credential.botId, appSecret: credential.secret };
    case 'wechat':
      return {
        ...common,
        token: credential.botToken,
        webhookUrl: credential.baseUrl,
        botUserId: credential.botId,
      };
    case 'qq':
      return { ...common, appId: credential.appId, appSecret: credential.appSecret };
  }
}

function pickChannelFields(
  channel: BotChannelSettings,
  fields: ReadonlyArray<keyof BotChannelSettings>,
): Partial<BotChannelSettings> {
  return Object.fromEntries(fields.map((field) => [field, channel[field]])) as Partial<BotChannelSettings>;
}

function channelFieldsEqual(
  current: BotChannelSettings,
  expected: BotChannelSettings,
  fields: ReadonlyArray<keyof BotChannelSettings>,
): boolean {
  return fields.every((field) => Object.is(current[field], expected[field]));
}

/**
 * Turn a live-bridge `status.reason` into a short, redacted, user-facing cause
 * for the "credentials saved but not connected" warning. Transient lifecycle
 * markers carry no useful signal, so they collapse to `undefined` (the caller
 * then uses generic copy).
 */
function connectionFailureReason(reason: string | undefined): string | undefined {
  if (typeof reason !== 'string') return undefined;
  const trimmed = redactSecrets(reason).trim();
  if (!trimmed || trimmed === 'stopped' || trimmed === 'reconnecting') return undefined;
  return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
}

/**
 * PR1197 review (P1-6): map an undocumented WeCom `qc/query_result` status to a
 * terminal onboarding outcome, or `undefined` to keep polling. A user
 * cancel/reject reads as `denied`; any other recognizable dead/expired marker
 * reads as `expired`. Kept pure + exported so the mapping is unit-testable.
 */
export function wecomTerminalPollStatus(status: unknown): 'expired' | 'denied' | undefined {
  if (typeof status !== 'string') return undefined;
  if (/cancel|reject|refuse/i.test(status)) return 'denied';
  if (/expire|timeout|invalid|fail/i.test(status)) return 'expired';
  return undefined;
}

function identityFromCredential(credential: OnboardingCredential): { id?: string; displayName?: string } {
  switch (credential.provider) {
    case 'dingtalk': return { id: credential.clientId };
    case 'feishu': return { id: credential.appId, displayName: credential.botName };
    case 'wecom': return { id: credential.botId };
    case 'wechat': return { id: credential.botId };
    case 'qq': return { id: credential.appId };
  }
}

const require = createRequire(import.meta.url);

async function renderQrCode(value: string): Promise<string> {
  if (!value) throw new Error('Provider returned an empty QR payload');
  if (value.startsWith('data:image/')) return value;
  const qrcode = require('qrcode') as {
    toDataURL(input: string, options: Record<string, unknown>): Promise<string>;
  };
  return qrcode.toDataURL(value, { width: 320, margin: 2, errorCorrectionLevel: 'M' });
}

// PR1197 review (P2-12): all onboarding HTTP goes through proxiedFetch so a
// proxy user's device-code handshake is not silently routed direct. proxiedFetch
// composes the passed session signal with its own timeout, preserving the
// previous AbortSignal.any(signal, timeout) semantics.
async function postJson(url: string, body: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, any>> {
  const response = await proxiedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!response.ok) throw new Error(`Provider request failed with HTTP ${response.status}`);
  return response.json() as Promise<Record<string, any>>;
}

async function postForm(url: string, body: Record<string, string>, signal: AbortSignal): Promise<Record<string, any>> {
  const response = await proxiedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  const json = await response.json().catch(() => ({})) as Record<string, any>;
  if (!response.ok && typeof json.error !== 'string') {
    throw new Error(`Provider request failed with HTTP ${response.status}`);
  }
  return json;
}

function platformCode(): number {
  switch (process.platform) {
    case 'darwin': return 1;
    case 'win32': return 2;
    case 'linux': return 3;
    default: return 0;
  }
}

const BOT_ONBOARDING_PROVIDER_KEYS = [
  'dingtalk',
  'feishu',
  'wecom',
  'wechat',
  'qq',
] as const satisfies ReadonlyArray<BotOnboardingProvider>;

function createProductionBotOnboardingAdapters(
  productVersion: string,
): Record<BotOnboardingProvider, BotOnboardingProviderAdapter> {
  return {
    dingtalk: {
      async start(_input, signal) {
        const init = await postJson('https://oapi.dingtalk.com/app/registration/init', { source: 'MAKA' }, signal);
        if (init.errcode !== 0 || typeof init.nonce !== 'string') throw new Error('DingTalk registration init failed');
        const begin = await postJson('https://oapi.dingtalk.com/app/registration/begin', { nonce: init.nonce }, signal);
        const verificationUrl = begin.pc_verification_uri_complete ?? begin.verification_uri_complete;
        if (typeof begin.device_code !== 'string' || typeof verificationUrl !== 'string') {
          throw new Error('DingTalk registration begin returned an invalid response');
        }
        return {
          opaqueToken: begin.device_code,
          qrValue: verificationUrl,
          verificationUrl,
          pollIntervalMs: Number(begin.interval ?? 5) * 1_000,
          expiresInSeconds: Number(begin.expires_in ?? DINGTALK_EXPIRES_IN_SECONDS),
        };
      },
      async poll(session, signal) {
        const result = await postJson(
          'https://oapi.dingtalk.com/app/registration/poll',
          { device_code: session.opaqueToken },
          signal,
        );
        switch (result.status) {
          case 'SUCCESS':
            if (typeof result.client_id !== 'string' || typeof result.client_secret !== 'string') {
              throw new Error('DingTalk registration returned incomplete credentials');
            }
            return {
              status: 'confirmed',
              credential: { provider: 'dingtalk', clientId: result.client_id, clientSecret: result.client_secret },
              identity: { id: result.client_id },
            };
          case 'WAITING': return { status: 'pending' };
          case 'EXPIRED': return { status: 'expired' };
          case 'FAIL': return { status: 'denied' };
          default: throw new Error('DingTalk registration returned an unknown status');
        }
      },
    },
    feishu: {
      async start(input, signal) {
        const brand = input.brand ?? 'feishu';
        const accounts = brand === 'lark' ? 'accounts.larksuite.com' : 'accounts.feishu.cn';
        const endpoint = `https://${accounts}/oauth/v1/app/registration`;
        const init = await postForm(endpoint, { action: 'init' }, signal);
        if (!Array.isArray(init.supported_auth_methods) || !init.supported_auth_methods.includes('client_secret')) {
          throw new Error('Feishu registration does not support client_secret');
        }
        const begin = await postForm(endpoint, {
          action: 'begin',
          archetype: 'PersonalAgent',
          auth_method: 'client_secret',
          request_user_info: 'open_id',
        }, signal);
        if (typeof begin.device_code !== 'string' || typeof begin.verification_uri_complete !== 'string') {
          throw new Error('Feishu registration begin returned an invalid response');
        }
        const verificationUrl = new URL(begin.verification_uri_complete);
        verificationUrl.searchParams.set('from', 'maka');
        verificationUrl.searchParams.set('lpv', productVersion);
        return {
          opaqueToken: begin.device_code,
          qrValue: verificationUrl.toString(),
          verificationUrl: verificationUrl.toString(),
          pollIntervalMs: Number(begin.interval ?? 5) * 1_000,
          expiresInSeconds: Number(begin.expire_in ?? begin.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS),
        };
      },
      async poll(session, signal) {
        const brand = session.brand ?? 'feishu';
        const accounts = brand === 'lark' ? 'accounts.larksuite.com' : 'accounts.feishu.cn';
        const result = await postForm(`https://${accounts}/oauth/v1/app/registration`, {
          action: 'poll',
          device_code: session.opaqueToken ?? '',
        }, signal);
        if (typeof result.client_id === 'string' && typeof result.client_secret === 'string') {
          const botName = await fetchFeishuBotName(result.client_id, result.client_secret, brand, signal);
          return {
            status: 'confirmed',
            credential: {
              provider: 'feishu',
              appId: result.client_id,
              appSecret: result.client_secret,
              brand,
              ...(botName ? { botName } : {}),
            },
            identity: { id: result.client_id, ...(botName ? { displayName: botName } : {}) },
          };
        }
        switch (result.error) {
          case 'authorization_pending': return { status: 'pending' };
          case 'slow_down': return { status: 'slow_down' };
          case 'expired_token': return { status: 'expired' };
          case 'access_denied': return { status: 'denied' };
          default: throw new Error('Feishu registration returned an unknown status');
        }
      },
    },
    wecom: {
      async start(_input, signal) {
        const response = await proxiedFetch(
          `https://work.weixin.qq.com/ai/qc/generate?source=maka&plat=${platformCode()}`,
          { signal, timeoutMs: REQUEST_TIMEOUT_MS },
        );
        if (!response.ok) throw new Error(`WeCom QR generation failed with HTTP ${response.status}`);
        const json = await response.json() as { data?: { scode?: unknown; auth_url?: unknown } };
        if (typeof json.data?.scode !== 'string' || typeof json.data.auth_url !== 'string') {
          throw new Error('WeCom QR generation returned an invalid response');
        }
        return {
          opaqueToken: json.data.scode,
          qrValue: json.data.auth_url,
          verificationUrl: json.data.auth_url,
          pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
          expiresInSeconds: DEFAULT_EXPIRES_IN_SECONDS,
        };
      },
      async poll(session, signal) {
        const response = await proxiedFetch(
          `https://work.weixin.qq.com/ai/qc/query_result?scode=${encodeURIComponent(session.opaqueToken ?? '')}`,
          { signal, timeoutMs: REQUEST_TIMEOUT_MS },
        );
        if (!response.ok) throw new Error(`WeCom QR poll failed with HTTP ${response.status}`);
        const json = await response.json() as {
          data?: { status?: unknown; bot_info?: { botid?: unknown; secret?: unknown } };
        };
        const status = json.data?.status;
        if (status === 'success') {
          const info = json.data?.bot_info;
          if (typeof info?.botid !== 'string' || typeof info.secret !== 'string') {
            throw new Error('WeCom registration returned incomplete credentials');
          }
          return {
            status: 'confirmed',
            credential: { provider: 'wecom', botId: info.botid, secret: info.secret },
            identity: { id: info.botid },
          };
        }
        // PR1197 review (P1-6): the endpoint is undocumented, but a dead/expired
        // QR must not read as an endless "pending". Map any recognizable terminal
        // marker to a terminal session state so the modal can prompt a refresh
        // instead of spinning until the local TTL. Unknown/absent status stays
        // pending; the conservative local expiry (DEFAULT_EXPIRES_IN_SECONDS) is
        // the backstop for a server that never signals termination.
        const terminal = wecomTerminalPollStatus(status);
        return terminal ? { status: terminal } : { status: 'pending' };
      },
    },
    wechat: {
      async start(_input, signal) {
        const result = await fetchWeChatQrcode(signal);
        return {
          opaqueToken: result.qrToken,
          qrCodeDataUrl: result.qrcodeUrl,
          pollIntervalMs: 2_500,
          expiresInSeconds: DEFAULT_EXPIRES_IN_SECONDS,
        };
      },
      async poll(session, signal) {
        const result = await pollWeChatQrcodeStatus(session.opaqueToken ?? '', signal);
        if (result.status === 'waiting') return { status: 'pending' };
        if (result.status === 'expired') return { status: 'expired' };
        return {
          status: 'confirmed',
          credential: { provider: 'wechat', ...result.credentials },
          identity: { id: result.credentials.botId },
        };
      },
    },
    qq: {
      async start(_input, signal) {
        const task = await createQQBindTask(signal);
        return {
          opaqueToken: JSON.stringify({
            taskId: task.taskId,
            decryptionKey: task.decryptionKey,
          }),
          qrValue: task.verificationUrl,
          verificationUrl: task.verificationUrl,
          pollIntervalMs: 2_000,
          expiresInSeconds: DEFAULT_EXPIRES_IN_SECONDS,
        };
      },
      async poll(session, signal) {
        const token = parseQQOpaqueToken(session.opaqueToken);
        const result = await pollQQBindTask(token.taskId, token.decryptionKey, signal);
        if (result.status === 'pending') return { status: 'pending' };
        if (result.status === 'expired') return { status: 'expired' };
        return {
          status: 'confirmed',
          credential: {
            provider: 'qq',
            appId: result.appId,
            appSecret: result.appSecret,
          },
          identity: { id: result.appId },
        };
      },
    },
  };
}

function parseQQOpaqueToken(value: string | undefined): {
  taskId: string;
  decryptionKey: string;
} {
  if (!value) throw new Error('QQ bind session is missing');
  const parsed = JSON.parse(value) as { taskId?: unknown; decryptionKey?: unknown };
  if (typeof parsed.taskId !== 'string' || typeof parsed.decryptionKey !== 'string') {
    throw new Error('QQ bind session is invalid');
  }
  return { taskId: parsed.taskId, decryptionKey: parsed.decryptionKey };
}

async function fetchFeishuBotName(
  appId: string,
  appSecret: string,
  brand: BotOnboardingBrand,
  signal: AbortSignal,
): Promise<string | undefined> {
  const domain = brand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
  try {
    const token = await postJson(
      `https://${domain}/open-apis/auth/v3/tenant_access_token/internal/`,
      { app_id: appId, app_secret: appSecret },
      signal,
    );
    if (typeof token.tenant_access_token !== 'string') return undefined;
    const response = await proxiedFetch(`https://${domain}/open-apis/bot/v3/info/`, {
      headers: { Authorization: `Bearer ${token.tenant_access_token}` },
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response.ok) return undefined;
    const json = await response.json() as { bot?: { app_name?: unknown } };
    return typeof json.bot?.app_name === 'string' ? json.bot.app_name : undefined;
  } catch {
    return undefined;
  }
}
