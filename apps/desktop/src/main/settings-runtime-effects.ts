import type {
  AppSettings,
  UpdateAppSettingsInput,
} from '@maka/core';
import { setActiveProxy } from '@maka/runtime';
import type { BotRegistry } from '@maka/runtime';
import type { createSettingsStore } from '@maka/storage';
import { preserveSensitivePlaceholders } from './settings-ipc-helpers.js';
import { maskNetworkSettings, toContractNetworkSettings } from './network-settings-main.js';
import type { KeepSystemAwakeController } from './keep-system-awake.js';

type SettingsStore = ReturnType<typeof createSettingsStore>;

export interface SettingsRuntimeEffectsDeps {
  settingsStore: SettingsStore;
  botRegistry: BotRegistry;
  keepSystemAwake: KeepSystemAwakeController;
  safeSendToRenderer: (channel: string, ...args: unknown[]) => void;
  refreshIdleBackends: () => Promise<void>;
}

export interface SettingsRuntimeEffects {
  /** Merge a settings patch, re-hydrating masked secret placeholders from the
   *  persisted values so the renderer never has to round-trip a real secret. */
  normalizeSettingsPatch(patch: UpdateAppSettingsInput): Promise<UpdateAppSettingsInput>;
  /** Apply the side effects a settings change implies on the live process:
   *  proxy, bot bridges, and keep-awake. */
  applySettingsRuntimeEffects(settings: AppSettings, patch: UpdateAppSettingsInput): Promise<void>;
  /** Re-apply the full set of runtime effects after an external (config-file)
   *  settings edit, then notify the renderer to re-read. */
  handleExternalSettingsChange(): Promise<void>;
}

/**
 * Settings runtime-effects cluster extracted from main.ts (arch R5). Pure move
 * of `normalizeSettingsPatch` / `applySettingsRuntimeEffects` /
 * `handleExternalSettingsChange`.
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
    keepSystemAwake,
    safeSendToRenderer,
    refreshIdleBackends,
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
    if (patch.system) {
      // Start/stop the power-save blocker the instant the toggle flips so the
      // capability reflects the user's choice without waiting for a relaunch.
      keepSystemAwake.apply(settings.system.keepSystemAwake);
    }
    if (patch.webSearch || patch.privacy) {
      void refreshIdleBackends().catch((error) => {
        console.warn('[settings] failed to refresh backend tool snapshots:', error);
      });
    }
  }

  async function handleExternalSettingsChange(): Promise<void> {
    try {
      const settings = await settingsStore.get();
      const fullPatch: UpdateAppSettingsInput = {
        network: settings.network,
        botChat: settings.botChat,
        system: settings.system,
        webSearch: settings.webSearch,
        privacy: settings.privacy,
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
