import type { AppSettings } from '@maka/core/settings';
import type { SettingsStore } from '@maka/storage';

export interface ClientSettingsEffects {
  apply(settings: AppSettings, notifyRenderer: boolean): Promise<boolean>;
  refresh(notifyRenderer: boolean): Promise<boolean>;
}

interface ClientSettingsEffectDependencies {
  readonly settingsStore: Pick<SettingsStore, 'get'>;
  readonly applyKeepSystemAwake: (enabled: boolean) => Promise<void>;
  readonly applyBotSettings: (settings: AppSettings['botChat']) => Promise<void>;
  readonly emitExternalChanged: () => void;
}

export function createClientSettingsEffects(
  dependencies: ClientSettingsEffectDependencies,
): ClientSettingsEffects {
  let rendererFingerprint: string | undefined;
  let botFingerprint: string | undefined;
  let keepSystemAwake: boolean | undefined;
  let tail = Promise.resolve();

  const schedule = (
    load: () => AppSettings | Promise<AppSettings>,
    notifyRenderer: boolean,
  ): Promise<boolean> => {
    const run = tail.then(async () => {
      const settings = await load();
      const nextRendererFingerprint = JSON.stringify(settings);
      const nextBotFingerprint = JSON.stringify(settings.botChat);
      const rendererChanged = nextRendererFingerprint !== rendererFingerprint;
      const keepAwakeChanged = settings.system.keepSystemAwake !== keepSystemAwake;
      const botChanged = nextBotFingerprint !== botFingerprint;
      if (keepAwakeChanged) {
        await dependencies.applyKeepSystemAwake(settings.system.keepSystemAwake);
        keepSystemAwake = settings.system.keepSystemAwake;
      }
      if (botChanged) {
        await dependencies.applyBotSettings(settings.botChat);
        botFingerprint = nextBotFingerprint;
      }
      rendererFingerprint = nextRendererFingerprint;
      if (notifyRenderer && rendererChanged) dependencies.emitExternalChanged();
      return rendererChanged || keepAwakeChanged || botChanged;
    });
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    apply: (settings, notifyRenderer) => schedule(() => settings, notifyRenderer),
    refresh: (notifyRenderer) => schedule(() => dependencies.settingsStore.get(), notifyRenderer),
  };
}
