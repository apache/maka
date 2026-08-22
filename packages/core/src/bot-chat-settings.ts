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

export type BotProvider =
  | 'telegram'
  | 'feishu'
  | 'wecom'
  | 'wechat'
  | 'discord'
  | 'dingtalk'
  | 'qq'
  | 'slack';

export const BOT_READINESS_STATES = [
  'unscaffolded',
  'scaffolded',
  'configured',
  'credentials_valid',
  'operational',
  'degraded',
] as const;
export type BotReadinessState = (typeof BOT_READINESS_STATES)[number];

export interface BotChannelSettings {
  provider: BotProvider;
  enabled: boolean;
  /**
   * Legacy credential-test boolean. Do not use this to mean runtime
   * operational; prefer `readiness`.
   */
  connected: boolean;
  readiness: BotReadinessState;
  readinessReason?: string;
  readinessUpdatedAt?: number;
  token: string;
  proxyUrl: string;
  webhookUrl?: string;
  /** Public callback/domain configured in the bot platform console. */
  domain?: string;
  appId?: string;
  appSecret?: string;
  botUserId?: string;
  lastTestAt?: number;
  lastError?: string;
  /**
   * PR-BOT-USER-ALLOWLIST-0 (external bot research): platform-native user IDs
   * permitted to message this bot. `undefined` or empty means no
   * restriction (preserves the V0.1 behavior for existing installs).
   * When non-empty, the bot bridge silently drops inbound messages from
   * any other user — no acknowledgement is sent back, so unauthorized
   * scanners cannot use bounce behavior to enumerate the bot's policy.
   *
   * Stored as a string array since Telegram IDs are 64-bit and JS
   * `Number` loses precision past 2^53.
   */
  allowedUserIds?: ReadonlyArray<string>;
}

export interface BotChatSettings {
  channels: Record<BotProvider, BotChannelSettings>;
}

export type BotChatSettingsPatch = Partial<{
  channels: Partial<Record<BotProvider, Partial<BotChannelSettings>>>;
}>;

export function isBotReadinessState(value: unknown): value is BotReadinessState {
  return typeof value === 'string' && (BOT_READINESS_STATES as readonly string[]).includes(value);
}

export const BOT_PROVIDERS: BotProvider[] = [
  'telegram',
  'feishu',
  'wecom',
  'wechat',
  'discord',
  'dingtalk',
  'qq',
  'slack',
];

export type BotDeliveryProvider = Extract<
  BotProvider,
  'telegram' | 'wechat' | 'discord' | 'dingtalk' | 'qq' | 'slack'
>;

export const BOT_DELIVERY_PROVIDERS: BotDeliveryProvider[] = [
  'telegram',
  'wechat',
  'discord',
  'dingtalk',
  'qq',
  'slack',
];

export function isBotDeliveryProvider(value: unknown): value is BotDeliveryProvider {
  return typeof value === 'string' && (BOT_DELIVERY_PROVIDERS as readonly string[]).includes(value);
}

export function createDefaultBotChannel(provider: BotProvider): BotChannelSettings {
  return {
    provider,
    enabled: false,
    connected: false,
    readiness: 'scaffolded',
    token: '',
    proxyUrl: provider === 'telegram' ? 'http://127.0.0.1:7890' : '',
    ...(provider === 'wechat' ? { webhookUrl: 'http://127.0.0.1:18400' } : {}),
  };
}

export function createDefaultBotChatSettings(): BotChatSettings {
  return {
    channels: Object.fromEntries(
      BOT_PROVIDERS.map((provider) => [provider, createDefaultBotChannel(provider)]),
    ) as Record<BotProvider, BotChannelSettings>,
  };
}

export function mergeBotChatSettings(
  current: BotChatSettings,
  patch: BotChatSettingsPatch | undefined,
): BotChatSettings {
  return {
    ...current,
    channels: {
      ...current.channels,
      ...Object.fromEntries(
        Object.entries(patch?.channels ?? {}).map(([provider, channelPatch]) => {
          const merged = {
            ...current.channels[provider as BotProvider],
            ...channelPatch,
          };
          // PR-BOT-USER-ALLOWLIST-0: keep the persisted allowlist
          // shape consistent on every save, not only on initial load.
          // The renderer textarea sends an array; the normalize step
          // trims/dedups/caps and downgrades the empty case to
          // `undefined` (the V0.1 "no restriction" sentinel).
          if ('allowedUserIds' in (channelPatch ?? {})) {
            const normalized = normalizeAllowedUserIds(merged.allowedUserIds);
            if (normalized) merged.allowedUserIds = normalized;
            else delete merged.allowedUserIds;
          }
          return [provider, merged];
        }),
      ),
    },
  };
}

export function normalizeBotChatSettings(
  settings: BotChatSettings,
  rawSettings: Partial<BotChatSettings> | undefined,
): BotChatSettings {
  return {
    channels: Object.fromEntries(
      BOT_PROVIDERS.map((provider) => {
        const rawChannel = rawSettings?.channels?.[provider] as
          | Partial<BotChannelSettings>
          | undefined;
        return [provider, normalizeBotChannel(provider, settings.channels[provider], rawChannel)];
      }),
    ) as Record<BotProvider, BotChannelSettings>,
  };
}

function normalizeBotChannel(
  provider: BotProvider,
  channel: BotChannelSettings,
  rawChannel: Partial<BotChannelSettings> | undefined,
): BotChannelSettings {
  const hasExplicitReadiness = rawChannel && 'readiness' in rawChannel;
  const connected = channel.connected === true;
  const candidateReadiness =
    hasExplicitReadiness && isBotReadinessState(rawChannel?.readiness)
      ? channel.readiness
      : connected
        ? 'credentials_valid'
        : readinessFromChannel(channel);
  const allowedUserIds = normalizeAllowedUserIds(channel.allowedUserIds);
  return {
    ...channel,
    provider,
    connected,
    ...(allowedUserIds ? { allowedUserIds } : { allowedUserIds: undefined }),
    // PR-HEALTH-1 (xuan msg `e4887ffd`, I1 — bot readiness single-authority,
    // write path): coerce the persisted readiness to be consistent with
    // current credential state. The previous behavior trusted whatever was
    // on disk, so clearing a token with `mergeBotChatSettings` over
    // `{ readiness: 'credentials_valid', token: 'X' }` would persist a
    // stale `'credentials_valid'` even though credentials no longer exist.
    // `coerceReadinessForCurrentState` downgrades credential-claiming states
    // (`configured` / `credentials_valid` / `operational` / `degraded`)
    // back to `'scaffolded'` when no credentials remain. Live bridges keep
    // their own authoritative readiness via `BotStatus`; they are not
    // affected by this settings-write coerce path.
    readiness: coerceReadinessForCurrentState(channel, candidateReadiness),
    readinessReason:
      typeof channel.readinessReason === 'string' ? channel.readinessReason : undefined,
    readinessUpdatedAt:
      typeof channel.readinessUpdatedAt === 'number' && Number.isFinite(channel.readinessUpdatedAt)
        ? channel.readinessUpdatedAt
        : undefined,
  };
}

export function hasBotChannelCredentials(channel: BotChannelSettings): boolean {
  if (channel.provider === 'slack') {
    return channel.token.trim().length > 0 && Boolean(channel.appSecret?.trim());
  }
  if (channel.token.trim().length > 0 || Boolean(channel.appId) || Boolean(channel.appSecret))
    return true;
  if (channel.provider === 'wechat' && Boolean(channel.webhookUrl?.trim())) return true;
  return false;
}

function readinessFromChannel(channel: BotChannelSettings): BotReadinessState {
  if (!channel.enabled) return 'scaffolded';
  if (!hasBotChannelCredentials(channel)) return 'scaffolded';
  return 'configured';
}

/**
 * PR-HEALTH-1 (xuan msg `e4887ffd`, I1 lock): downgrade a persisted
 * `BotReadinessState` to be consistent with the channel's current
 * credential state.
 *
 * Why: `mergeBotChatSettings` spreads a `channelPatch` over the current channel.
 * If the user clears `token` without explicitly patching `readiness`, the
 * prior `'credentials_valid'` (or any other credential-claiming state)
 * survives. That stale value then surfaces through
 * `bot-registry.scaffoldStatus()` into `BotStatus.readiness`, which the
 * capability snapshot maps into `CapabilityRuntimeProbeSignal.state` —
 * producing a "configured / verified" UI for a channel that actually has
 * no credentials.
 *
 * Rule: credential-claiming readiness (`'configured'` / `'credentials_valid'`
 * / `'operational'` / `'degraded'`) requires SOMETHING in the credential
 * trio (`token` / `appId` / `appSecret`). When all three are empty,
 * downgrade to `'scaffolded'`. `'unscaffolded'` and `'scaffolded'` are
 * always consistent with any credential state, so they pass through.
 *
 * Note: this is a write-path consistency gate, not an operational probe.
 * Even when credentials exist, we do NOT promote `'scaffolded'` to
 * `'configured'` here — that is the live bridge / connection-test path's
 * responsibility. We only downgrade; never upgrade.
 */
function coerceReadinessForCurrentState(
  channel: BotChannelSettings,
  candidate: BotReadinessState,
): BotReadinessState {
  const hasCredentials = hasBotChannelCredentials(channel);
  const claimsCredentials =
    candidate === 'configured' ||
    candidate === 'credentials_valid' ||
    candidate === 'operational' ||
    candidate === 'degraded';
  if (claimsCredentials && !hasCredentials) {
    return 'scaffolded';
  }
  return candidate;
}

/**
 * PR-BOT-USER-ALLOWLIST-0: shape-validate the persisted allowlist.
 * Returns `undefined` when there is nothing to enforce (preserves the
 * V0.1 "no restriction" behavior). Drops non-strings, trims, dedups, and
 * caps at MAX_ALLOWED_USER_IDS entries; the cap is defensive against
 * pathological persisted settings, not a product UX limit.
 *
 * IDs are stored as strings because Telegram user IDs are 64-bit and
 * JS `Number` loses precision past 2^53. Trimming a candidate to '' is
 * treated as absent rather than as a wildcard.
 */
export const MAX_ALLOWED_USER_IDS = 50;
export function normalizeAllowedUserIds(
  candidate: ReadonlyArray<string> | undefined | unknown,
): ReadonlyArray<string> | undefined {
  if (!Array.isArray(candidate)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidate) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_ALLOWED_USER_IDS) break;
  }
  return out.length === 0 ? undefined : Object.freeze(out);
}

/**
 * PR-BOT-USER-ALLOWLIST-UI-0: textarea-friendly parse helper for the
 * Settings UI. Splits on newline, trims each line, drops blanks, dedups,
 * and caps at MAX_ALLOWED_USER_IDS. Returns a string[] (not undefined)
 * because the renderer needs to be able to show "current 0 / 50" before
 * commit. The IPC merge layer will downgrade an empty list to `undefined`
 * at persist time so the V0.1 "no restriction" sentinel is preserved.
 */
export function parseAllowedUserIdsFromText(raw: string): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_ALLOWED_USER_IDS) break;
  }
  return out;
}
