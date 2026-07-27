import { isDeepResearchSession } from '@maka/core';
import type {
  AppSettings,
  PermissionMode,
  SessionChangedReason,
  UpdateAppSettingsInput,
} from '@maka/core';
import { setActiveProxy } from '@maka/runtime';
import type { BotRegistry, SessionManager } from '@maka/runtime';
import type { createSettingsStore } from '@maka/storage';
import { preserveSensitivePlaceholders } from './settings-ipc-helpers.js';
import { maskNetworkSettings, toContractNetworkSettings } from './network-settings-main.js';
import type { OpenGatewayService } from './open-gateway.js';
import type { KeepSystemAwakeController } from './keep-system-awake.js';

type SettingsStore = ReturnType<typeof createSettingsStore>;

export interface SettingsRuntimeEffectsDeps {
  settingsStore: SettingsStore;
  botRegistry: BotRegistry;
  openGateway: OpenGatewayService;
  keepSystemAwake: KeepSystemAwakeController;
  runtime: SessionManager;
  safeSendToRenderer: (channel: string, ...args: unknown[]) => void;
  emitSessionsChanged: (reason: SessionChangedReason, sessionId?: string) => void;
}

export interface SettingsRuntimeEffects {
  /** Merge a settings patch, re-hydrating masked secret placeholders from the
   *  persisted values so the renderer never has to round-trip a real secret. */
  normalizeSettingsPatch(patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsInput>;
  /** Apply the side effects a settings change implies on the live process:
   *  proxy, bot bridges, open-gateway, per-session permission mode, keep-awake. */
  applySettingsRuntimeEffects(settings: AppSettings, patch: UpdateAppSettingsInput): Promise<void>;
  /** Re-apply the full set of runtime effects after an external (config-file)
   *  settings edit, then notify the renderer to re-read. */
  handleExternalSettingsChange(): Promise<void>;
}

/**
 * Settings runtime-effects cluster extracted from main.ts (arch R5). Pure move
 * of `normalizeSettingsPatch` / `applySettingsRuntimeEffects` /
 * `syncDefaultPermissionModeToSessions` (internal) / `handleExternalSettingsChange`.
 * The keep-awake effect (#1207) rides `applySettingsRuntimeEffects` unchanged.
 * All process-scoped collaborators are injected so the bodies stay behaviorally
 * identical to their in-main.ts originals.
 */
export function createSettingsRuntimeEffects(
  deps: SettingsRuntimeEffectsDeps,
): SettingsRuntimeEffects {
  const {
    settingsStore,
    botRegistry,
    openGateway,
    keepSystemAwake,
    runtime,
    safeSendToRenderer,
    emitSessionsChanged,
  } = deps;

  async function normalizeSettingsPatch(patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsInput> {
    const current = await settingsStore.get();
    return preserveSensitivePlaceholders(patch, current);
  }

  async function applySettingsRuntimeEffects(settings: AppSettings, patch: UpdateAppSettingsInput): Promise<void> {
    if (patch.network) {
      const network = toContractNetworkSettings(settings.network);
      setActiveProxy(network.proxy);
      safeSendToRenderer('settings:network:changed', maskNetworkSettings(network));
    }
    if (patch.botChat) {
      await botRegistry.applySettings(settings.botChat);
    }
    if (patch.openGateway) {
      const status = await openGateway.sync(settings.openGateway);
      safeSendToRenderer('gateway:statusChanged', status);
    }
    if (patch.chatDefaults?.permissionMode) {
      await syncDefaultPermissionModeToSessions(settings.chatDefaults.permissionMode);
    }
    if (patch.system) {
      // Start/stop the power-save blocker the instant the toggle flips so the
      // capability reflects the user's choice without waiting for a relaunch.
      keepSystemAwake.apply(settings.system.keepSystemAwake);
    }
  }

  async function syncDefaultPermissionModeToSessions(mode: Exclude<PermissionMode, 'explore'>): Promise<void> {
    const sessions = await runtime.listSessions();
    await Promise.all(sessions.map(async (session) => {
      if (session.permissionMode === mode) return;
      // A conferred boundary is not the user's styling choice to overwrite.
      //
      // `explore` is structurally unreachable as a global default
      // (`ChatDefaultPermissionMode` excludes it) and the picker never
      // offers it, so a session sitting in `explore` was put there by a
      // deliberate seed: Deep Research, a bot conversation, an expert-team
      // review crew, a cron automation. Each one chose read-only as its
      // security boundary. Flipping the global default is the user
      // restyling their own chats; it must not silently dissolve a
      // boundary they never set and cannot see from here.
      //
      // Only Deep Research was exempt before, by label — so bot,
      // expert-team and cron sessions were all being escalated, and only
      // bot self-healed (on its next inbound message).
      if (session.permissionMode === 'explore') return;
      // Kept alongside the check above: this one says "Deep Research is
      // always exempt", which still holds if such a session is ever moved
      // off `explore` by some other path.
      if (isDeepResearchSession(session.labels)) return;
      if (session.status === 'running' || session.status === 'waiting_for_user') return;
      try {
        await runtime.setPermissionMode(session.id, mode);
        emitSessionsChanged('mode-change', session.id);
      } catch {
        // Best effort: the persisted global default is still the authority for
        // new sessions; busy sessions can be reconciled on a later change.
      }
    }));
  }

  async function handleExternalSettingsChange(): Promise<void> {
    try {
      const settings = await settingsStore.get();
      const fullPatch: UpdateAppSettingsInput = {
        network: settings.network,
        botChat: settings.botChat,
        openGateway: settings.openGateway,
        system: settings.system,
      };
      await applySettingsRuntimeEffects(settings, fullPatch);
    } catch (error) {
      console.error('[config-watcher] failed to apply external settings change:', error);
    }
    // Always notify renderer, even on partial failure above
    safeSendToRenderer('settings:externalChanged', { ts: Date.now() });
  }

  return {
    normalizeSettingsPatch,
    applySettingsRuntimeEffects,
    handleExternalSettingsChange,
  };
}
