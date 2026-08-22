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

import { isThinkingLevel, type ThinkingLevel } from './model-thinking.js';
import type { OnboardingMilestone } from './onboarding.js';
import { sanitizeOnboardingMilestones } from './onboarding.js';
import type { WebSearchSettingsPatch, WebSearchSettings } from './web-search.js';
import type { BotChatSettings, BotChatSettingsPatch } from './bot-chat-settings.js';
import {
  createDefaultBotChatSettings,
  mergeBotChatSettings,
  normalizeBotChatSettings,
} from './bot-chat-settings.js';
import type { LocalMemorySettings } from './local-memory.js';
import {
  defaultWebSearchSettings,
  mergeWebSearchSettings,
  normalizeWebSearchSettings,
} from './web-search.js';
import { defaultLocalMemorySettings, normalizeLocalMemorySettings } from './local-memory.js';
import type { PermissionMode } from './permission.js';
import {
  UI_LOCALE_PREFERENCES,
  isUiLocalePreference,
  type UiLocalePreference,
} from './ui-locale.js';
import { normalizeSubagentSettings, type SubagentSettings } from './subagent-settings.js';
import { isPetPackId } from './pet.js';

export { UI_LOCALE_PREFERENCES, isUiLocalePreference } from './ui-locale.js';
export type { UiLocalePreference } from './ui-locale.js';
export type {
  BotChannelSettings,
  BotChatSettings,
  BotDeliveryProvider,
  BotProvider,
  BotReadinessState,
} from './bot-chat-settings.js';
export {
  BOT_DELIVERY_PROVIDERS,
  BOT_PROVIDERS,
  BOT_READINESS_STATES,
  MAX_ALLOWED_USER_IDS,
  createDefaultBotChannel,
  hasBotChannelCredentials,
  isBotDeliveryProvider,
  isBotReadinessState,
  normalizeAllowedUserIds,
  parseAllowedUserIdsFromText,
} from './bot-chat-settings.js';

export const SETTINGS_SECTIONS = [
  'general',
  'appearance',
  'projects',
  'memory',
  'daily-review',
  'models',
  'subagents',
  'usage',
  // `maka://settings/<section>` is a public deep link, so the id names what
  // the page is rather than the noun it lives under.
  'archived-tasks',
  'import-tasks',
  'bot-chat',
  'search',
  'data',
  'permissions',
  'health',
  'about',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export type ProxyProtocol = 'http' | 'https' | 'socks5';

export interface NetworkProxySettings {
  enabled: boolean;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  authEnabled: boolean;
  username: string;
  password: string;
  bypassList: string[];
  autoBypassDomains: string[];
}

/**
 * Persisted application network settings. Runtime proxy execution uses the
 * separate contract in `settings/network-settings.ts`.
 */
export interface AppNetworkSettings {
  proxy: NetworkProxySettings;
}

export type UsageRange = '24h' | '7d' | '30d' | 'all';
export type UsageStatus = 'all' | 'success' | 'error';
export type UsageTab = 'requests' | 'providers' | 'models' | 'tools' | 'pricing';

export interface UsageSettings {
  range: UsageRange;
  status: UsageStatus;
  modelFilter: string;
  showDetails: boolean;
  activeTab: UsageTab;
}

export type ThemePreference = 'light' | 'dark' | 'auto';

/** Palette ids shared with `[data-maka-theme]` CSS selectors. */
export const THEME_PALETTES = [
  'default',
  'onedark',
  'catppuccin-mocha',
  'tokyo-night',
  'nord',
  // Product accent palettes named by color family. `coral` warm pink,
  // `azure` cool blue; `forest` deep moss, `dusk` violet twilight,
  // `sand` warm amber on cream, `mono` distraction-free grayscale.
  'coral',
  'azure',
  'forest',
  'dusk',
  'sand',
  'mono',
] as const;

export type ThemePalette = (typeof THEME_PALETTES)[number];

export function isThemePalette(value: unknown): value is ThemePalette {
  return typeof value === 'string' && (THEME_PALETTES as readonly string[]).includes(value);
}

export interface AppearanceSettings {
  theme: ThemePreference;
  /** Optional palette override; missing values normalize to `default`. */
  palette?: ThemePalette;
}

export interface PersonalizationSettings {
  /** How the assistant addresses the user. Empty falls back to "你". */
  displayName: string;
  /** Inline tone preference shown to the model in its system prompt. */
  assistantTone: string;
  /** UI locale preference; defaults to `auto`. */
  uiLocale: UiLocalePreference;
  /** User-selected custom PetPack. `null` keeps the pet surface disabled. */
  selectedPetId: string | null;
}

/** Persisted onboarding milestones; derived onboarding state is not stored. */
export interface OnboardingSettings {
  milestones: OnboardingMilestone[];
}

export interface WorkspaceInstructionsSettings {
  enabled: boolean;
}

/** Default project identity for new conversations. */
export interface ProjectPreferencesSettings {
  defaultProjectId?: string;
}

export interface PrivacySettings {
  incognitoActive: boolean;
}

/**
 * `explore` is excluded — it's reserved for Deep Research sessions and
 * Bot-incoming guards and is never a mode the user picks, in the composer
 * dropdown or here. Derived from the canonical PERMISSION_MODES (not a
 * hand-copied literal) so adding a future mode updates every consumer —
 * the Settings picker, the composer picker (@maka/ui re-exports this
 * list as PERMISSION_MODE_ORDER), and the settings validation — in one
 * place.
 */
export type ChatDefaultPermissionMode = Extract<PermissionMode, 'ask' | 'bypass'>;

export const CHAT_DEFAULT_PERMISSION_MODES: readonly ChatDefaultPermissionMode[] = [
  'ask',
  'bypass',
];

export function isChatDefaultPermissionMode(value: unknown): value is ChatDefaultPermissionMode {
  return (
    typeof value === 'string' &&
    (CHAT_DEFAULT_PERMISSION_MODES as readonly string[]).includes(value)
  );
}

/** Seeds new sessions' starting permission mode (Settings → 通用 → 默认权限模式). */
export interface ChatDefaultsSettings {
  permissionMode: ChatDefaultPermissionMode;
  /**
   * Seeds new sessions' thinking level. `undefined` means "whatever the model
   * does on its own" — the absence of a preference, not a level.
   *
   * A chosen level is a wish, not a guarantee: models expose different ladders,
   * so one that does not offer the chosen rung falls back to its own default
   * for that session rather than being forced to the nearest neighbour. The
   * composer already resolves it that way for the per-session picker.
   */
  thinkingLevel?: ThinkingLevel;
}

/**
 * Desktop OS notifications (Settings → 通用 → 通知). The runtime only
 * knows a turn ended from the renderer; the main process owns the focus
 * gate + native `Notification`, so this is a pure product on/off toggle.
 */
export interface NotificationSettings {
  /**
   * When enabled, the desktop app raises a native notification once an
   * agent turn finishes (completed or errored) **while its window is not
   * focused**. Focus + OS-permission gating live in the main process.
   */
  runComplete: boolean;
}

/**
 * System-level power behavior (Settings surface: the 定时任务 page's
 * capability row). Scheduled tasks are driven by an in-process timer; when
 * the machine sleeps, that timer is frozen and reminders silently never
 * fire. `keepSystemAwake` lets the user hold a power-save blocker so
 * background scheduled work keeps running.
 *
 * The main process owns the actual Electron `powerSaveBlocker`
 * (`prevent-app-suspension`, which keeps the system awake WITHOUT forcing
 * the display on). This flag is the pure product on/off toggle, mirroring
 * `notifications.runComplete`.
 */
export interface SystemSettings {
  keepSystemAwake: boolean;
}

/** Host-machine shell preference used by Bash tools and interactive PTYs. */
export type ShellPreference = 'auto' | 'git_bash';

export interface ShellSettings {
  /** `auto` preserves the platform default; `git_bash` is an explicit Windows override. */
  preference: ShellPreference;
  /** Absolute executable selected by the user. Retained while `auto` is active for easy reuse. */
  executable: string;
}

export interface AppSettings {
  schemaVersion: 1;
  network: AppNetworkSettings;
  botChat: BotChatSettings;
  usage: UsageSettings;
  appearance: AppearanceSettings;
  personalization: PersonalizationSettings;
  onboarding: OnboardingSettings;
  webSearch: WebSearchSettings;
  localMemory: LocalMemorySettings;
  workspaceInstructions: WorkspaceInstructionsSettings;
  privacy: PrivacySettings;
  chatDefaults: ChatDefaultsSettings;
  projects: ProjectPreferencesSettings;
  notifications: NotificationSettings;
  system: SystemSettings;
  shell: ShellSettings;
  subagents: SubagentSettings;
}

export interface UsageRequestLog {
  id: string;
  ts: number;
  kind: 'model' | 'tool';
  sessionId: string;
  turnId: string;
  provider: string;
  model: string;
  toolName?: string;
  inputTokens: number;
  outputTokens: number;
  cacheMiss?: number;
  cacheRead?: number;
  cacheCreation?: number;
  reasoning?: number;
  costUsd?: number;
  latencyMs?: number;
  status: 'success' | 'error';
}

export interface UsageSummary {
  totalRequests: number;
  totalCostUsd: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  cacheMiss: number;
  cacheRead: number;
  cacheCreation: number;
  reasoning: number;
}

export interface UsageStats {
  summary: UsageSummary;
  logs: UsageRequestLog[];
  byProvider: Array<{
    provider: string;
    requests: number;
    tokens: number;
    costUsd: number;
  }>;
  byModel: Array<{
    model: string;
    requests: number;
    tokens: number;
    costUsd: number;
  }>;
  byTool: Array<{
    tool: string;
    calls: number;
    success: number;
    errors: number;
    avgDurationMs: number;
  }>;
  pricing: Array<{
    provider: string;
    model: string;
    inputPerMTokUsd: number;
    outputPerMTokUsd: number;
  }>;
}

export interface SettingsTestResult {
  ok: boolean;
  code?: SettingsTestResultCode;
  message: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export type SettingsTestResultCode =
  | 'proxy_reachable'
  | 'proxy_disabled'
  | 'proxy_configuration_missing'
  | 'proxy_timeout'
  | 'proxy_http_error'
  | 'proxy_unreachable'
  | 'bot_credentials_valid'
  | 'bot_token_missing'
  | 'bot_token_invalid'
  | 'bot_app_credentials_missing'
  | 'bot_connection_failed';

export type UpdateAppSettingsInput = Partial<{
  network: Partial<{
    proxy: Partial<NetworkProxySettings>;
  }>;
  botChat: BotChatSettingsPatch;
  usage: Partial<UsageSettings>;
  appearance: Partial<AppearanceSettings>;
  personalization: Partial<PersonalizationSettings>;
  localMemory: Partial<LocalMemorySettings>;
  workspaceInstructions: Partial<WorkspaceInstructionsSettings>;
  privacy: Partial<PrivacySettings>;
  chatDefaults: Partial<ChatDefaultsSettings>;
  projects: Partial<ProjectPreferencesSettings>;
  notifications: Partial<NotificationSettings>;
  system: Partial<SystemSettings>;
  shell: Partial<ShellSettings>;
  webSearch: WebSearchSettingsPatch;
  subagents: SubagentSettings;
}>;

export type PersonalizationSettingsWarning =
  | 'override-attempt'
  | 'sensitive-pattern'
  | 'control-chars';

export interface UpdateAppSettingsWarnings {
  personalization?: PersonalizationSettingsWarning[];
}

export interface UpdateAppSettingsResult {
  settings: AppSettings;
  warnings?: UpdateAppSettingsWarnings;
}

export const DEFAULT_PROXY_BYPASS_DOMAINS = [
  'localhost',
  '127.0.0.1',
  '::1',
  '192.168.*',
  '10.*',
  '*.local',
];

export function createDefaultSettings(): AppSettings {
  return {
    schemaVersion: 1,
    network: {
      proxy: {
        enabled: false,
        protocol: 'http',
        host: '127.0.0.1',
        port: 7890,
        authEnabled: false,
        username: '',
        password: '',
        bypassList: ['metaso.cn', 'baidu.com'],
        autoBypassDomains: DEFAULT_PROXY_BYPASS_DOMAINS,
      },
    },
    botChat: createDefaultBotChatSettings(),
    usage: {
      range: '24h',
      status: 'all',
      modelFilter: '',
      showDetails: false,
      activeTab: 'requests',
    },
    appearance: {
      theme: 'auto',
      palette: 'default',
    },
    personalization: {
      displayName: '',
      assistantTone: '',
      uiLocale: 'auto',
      selectedPetId: null,
    },
    onboarding: {
      milestones: [],
    },
    webSearch: defaultWebSearchSettings(),
    localMemory: defaultLocalMemorySettings(),
    workspaceInstructions: {
      enabled: true,
    },
    privacy: defaultPrivacySettings(),
    projects: defaultProjectPreferencesSettings(),
    chatDefaults: defaultChatDefaultsSettings(),
    notifications: {
      runComplete: true,
    },
    system: {
      // Off by default: holding a power-save blocker is an explicit,
      // battery-affecting opt-in, not a silent default.
      keepSystemAwake: false,
    },
    shell: {
      preference: 'auto',
      executable: '',
    },
    subagents: { presets: [] },
  };
}

export function mergeSettings(current: AppSettings, patch: UpdateAppSettingsInput): AppSettings {
  return {
    ...current,
    network: {
      ...current.network,
      ...(patch.network ?? {}),
      proxy: {
        ...current.network.proxy,
        ...(patch.network?.proxy ?? {}),
      },
    },
    botChat: mergeBotChatSettings(current.botChat, patch.botChat),
    usage: {
      ...current.usage,
      ...(patch.usage ?? {}),
    },
    appearance: {
      ...current.appearance,
      ...(patch.appearance ?? {}),
    },
    personalization: {
      ...current.personalization,
      ...(patch.personalization ?? {}),
      selectedPetId: normalizeSelectedPetId(
        patch.personalization?.selectedPetId === undefined
          ? current.personalization.selectedPetId
          : patch.personalization.selectedPetId,
      ),
    },
    onboarding: {
      ...current.onboarding,
      // PR110b: milestones flow through a dedicated setMilestone IPC
      // rather than the generic UpdateAppSettingsInput patch surface.
      // Keep the existing list intact when callers patch other sections.
    },
    localMemory: patch.localMemory
      ? normalizeLocalMemorySettings({
          ...current.localMemory,
          ...patch.localMemory,
        })
      : current.localMemory,
    workspaceInstructions: patch.workspaceInstructions
      ? normalizeWorkspaceInstructionsSettings({
          ...current.workspaceInstructions,
          ...patch.workspaceInstructions,
        })
      : current.workspaceInstructions,
    privacy: patch.privacy
      ? normalizePrivacySettings({ ...current.privacy, ...patch.privacy })
      : current.privacy,
    projects: patch.projects
      ? normalizeProjectPreferencesSettings({ ...current.projects, ...patch.projects })
      : current.projects,
    chatDefaults: patch.chatDefaults
      ? normalizeChatDefaultsSettings({
          ...current.chatDefaults,
          ...patch.chatDefaults,
        })
      : current.chatDefaults,
    notifications: {
      ...current.notifications,
      ...(patch.notifications ?? {}),
    },
    system: {
      ...current.system,
      ...(patch.system ?? {}),
    },
    shell: {
      ...current.shell,
      ...(patch.shell ?? {}),
    },
    webSearch: mergeWebSearchSettings(current.webSearch, patch.webSearch),
    subagents:
      patch.subagents === undefined
        ? current.subagents
        : normalizeSubagentSettings(patch.subagents),
  };
}

export function normalizeSettings(input: unknown): AppSettings {
  const defaults = createDefaultSettings();
  if (!input || typeof input !== 'object') return defaults;
  const value = input as Partial<AppSettings>;
  const base = mergeSettings(defaults, {
    network: value.network,
    botChat: value.botChat,
    usage: value.usage,
    appearance: value.appearance,
    personalization: value.personalization,
    webSearch: value.webSearch,
    localMemory: value.localMemory,
    workspaceInstructions: value.workspaceInstructions,
    privacy: value.privacy,
    chatDefaults: value.chatDefaults,
    projects: value.projects,
    notifications: value.notifications,
    system: value.system,
    shell: value.shell,
    subagents: value.subagents,
  });
  // PR110b: milestones bypass the generic patch surface so we can
  // sanitize them with the closed-enum + at-most-one validator on
  // every read. The settings → onboarding dependency is one-way; there
  // is no cycle.
  const rawOnboarding = (value as { onboarding?: unknown }).onboarding;
  const rawMilestones =
    rawOnboarding && typeof rawOnboarding === 'object'
      ? (rawOnboarding as { milestones?: unknown }).milestones
      : undefined;
  const {
    toastPosition: _legacyToastPosition,
    density: _legacyDensity,
    ...appearanceWithoutLegacyFields
  } = base.appearance as AppearanceSettings & Record<string, unknown>;
  return {
    ...base,
    // PR-UI-D1 (@kenji msg 68bf2b13): closed-enum fail-closed for
    // appearance.palette. mergeSettings spreads the raw user value
    // straight in, so an unknown/garbage palette string would
    // otherwise survive the normalize pass and end up driving
    // `[data-maka-theme="evil-unknown"]` on the renderer with no
    // matching CSS block. Validate against the closed `THEME_PALETTES`
    // allowlist and fall back to `'default'` on any miss (undefined,
    // non-string, unknown string).
    //
    // Critical: this MUST NOT silently reset other appearance fields
    // (theme). We only override palette when it fails the type guard;
    // everything else keeps mergeSettings's behavior.
    // Legacy `appearance.toastPosition` and `appearance.density` are
    // intentionally stripped here. Toasts are fixed to one app-wide
    // position; UI density is no longer a product setting.
    appearance: {
      ...appearanceWithoutLegacyFields,
      palette: isThemePalette(base.appearance.palette) ? base.appearance.palette : 'default',
    },
    // PR-LANG-PREF-0: closed-enum fail-closed for the new
    // `personalization.uiLocale` preference. mergeSettings spreads
    // raw user values, so an unknown value would otherwise reach the
    // renderer outside the closed reactive-locale contract. Fall back to
    // 'auto' on any miss.
    personalization: {
      ...base.personalization,
      uiLocale: isUiLocalePreference(base.personalization.uiLocale)
        ? base.personalization.uiLocale
        : 'auto',
      selectedPetId: normalizeSelectedPetId(base.personalization.selectedPetId),
    },
    botChat: normalizeBotChatSettings(base.botChat, value.botChat),
    onboarding: {
      milestones: sanitizeOnboardingMilestones(rawMilestones),
    },
    webSearch: normalizeWebSearchSettings(base.webSearch),
    localMemory: normalizeLocalMemorySettings(base.localMemory),
    workspaceInstructions: normalizeWorkspaceInstructionsSettings(base.workspaceInstructions),
    privacy: normalizePrivacySettings(base.privacy),
    projects: normalizeProjectPreferencesSettings(base.projects),
    chatDefaults: normalizeChatDefaultsSettings(base.chatDefaults),
    // Fail-closed boolean coercion: mergeSettings spreads the raw user
    // value, so a non-boolean `runComplete` (from a hand-edited or
    // legacy settings.json) would otherwise reach the main-process gate
    // as a truthy/falsy non-boolean. Default a missing/garbage value to
    // the enabled default rather than silently disabling notifications.
    notifications: {
      runComplete:
        typeof base.notifications.runComplete === 'boolean' ? base.notifications.runComplete : true,
    },
    // Fail-closed boolean coercion, same reasoning as
    // `notifications.runComplete`: a non-boolean `keepSystemAwake` (from a
    // hand-edited or legacy settings.json) must not reach the main-process
    // power-save-blocker gate as a truthy/falsy non-boolean. Default a
    // missing/garbage value to `false` — never silently hold a power
    // blocker the user did not opt into.
    system: {
      keepSystemAwake:
        typeof base.system.keepSystemAwake === 'boolean' ? base.system.keepSystemAwake : false,
    },
    shell: normalizeShellSettings(base.shell),
    subagents: normalizeSubagentSettings(base.subagents),
  };
}

function normalizeSelectedPetId(value: unknown): string | null {
  return isPetPackId(value) ? value : null;
}

function normalizeShellSettings(settings: ShellSettings): ShellSettings {
  return {
    preference: settings.preference === 'git_bash' ? 'git_bash' : 'auto',
    executable:
      typeof settings.executable === 'string'
        ? settings.executable.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()
        : '',
  };
}

function normalizeWorkspaceInstructionsSettings(
  settings: WorkspaceInstructionsSettings,
): WorkspaceInstructionsSettings {
  return {
    enabled: settings.enabled !== false,
  };
}

function defaultPrivacySettings(): PrivacySettings {
  return { incognitoActive: false };
}

function defaultProjectPreferencesSettings(): ProjectPreferencesSettings {
  return {};
}

function defaultChatDefaultsSettings(): ChatDefaultsSettings {
  return { permissionMode: 'ask' };
}

// Closed-enum fail-closed, same reasoning as appearance.palette /
// personalization.uiLocale above: an unknown/garbage persisted value
// (corrupted settings.json, a downgraded build reading a newer schema)
// must not reach session-creation code as a `PermissionMode` the picker
// doesn't recognize -- fall back to the safest default instead.
function normalizeChatDefaultsSettings(settings: ChatDefaultsSettings): ChatDefaultsSettings {
  return {
    // Same fail-closed reasoning as the mode below: a garbage persisted level
    // drops to "no preference" (the model's own default) rather than reaching
    // session creation as a rung no picker recognizes.
    thinkingLevel: isThinkingLevel(settings.thinkingLevel) ? settings.thinkingLevel : undefined,
    permissionMode:
      (settings.permissionMode as unknown) === 'execute'
        ? 'ask'
        : isChatDefaultPermissionMode(settings.permissionMode)
          ? settings.permissionMode
          : 'ask',
  };
}

function normalizePrivacySettings(settings: PrivacySettings): PrivacySettings {
  return {
    incognitoActive: settings.incognitoActive === true,
  };
}

// A blank or non-string id is dropped rather than carried: it cannot name a
// project, and letting it through would make "has a default" true while
// nothing resolves. Whether the id still names a LIVE project is decided at
// read time by the catalog, not here -- a project can be archived or its folder
// removed long after this value was written, so normalization is the wrong
// place to answer that.
function normalizeProjectPreferencesSettings(
  settings: ProjectPreferencesSettings | undefined,
): ProjectPreferencesSettings {
  const id = settings?.defaultProjectId;
  return typeof id === 'string' && id.trim() !== '' ? { defaultProjectId: id } : {};
}
