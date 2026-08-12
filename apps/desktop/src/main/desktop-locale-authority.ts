import {
  resolveSystemUiLocale,
  resolveUiLocale,
  type UiLocale,
  type UiLocalePreference,
} from '@maka/core/ui-locale';
import type { AppSettings } from '@maka/core/settings';

type LocaleSettings = Pick<AppSettings, 'personalization'>;

export interface DesktopLocaleAuthority {
  /** Latest observed preference, resolved against the current system languages. */
  current(): UiLocale;
  /** Reads the persisted Client preference before an asynchronous native interaction. */
  resolve(): Promise<UiLocale>;
  /** Advances the synchronous projection from an already-read settings snapshot. */
  observe(settings: LocaleSettings): UiLocale;
}

/** One locale owner for post-settings Desktop main-process presentation. */
export function createDesktopLocaleAuthority(input: {
  readonly readSettings: () => Promise<LocaleSettings>;
  readonly preferredSystemLanguages: () => readonly string[];
}): DesktopLocaleAuthority {
  let preference: UiLocalePreference = 'auto';
  let observation = 0;
  const systemLocale = (): UiLocale =>
    resolveSystemUiLocale([...input.preferredSystemLanguages()]);
  const current = (): UiLocale => resolveUiLocale(preference, systemLocale());
  const observe = (settings: LocaleSettings): UiLocale => {
    observation += 1;
    preference = settings.personalization.uiLocale;
    return current();
  };
  return Object.freeze({
    current,
    observe,
    resolve: async () => {
      const request = ++observation;
      try {
        const settings = await input.readSettings();
        if (request === observation) preference = settings.personalization.uiLocale;
      } catch {
        // Locale presentation must not block startup or an unrelated native action.
      }
      return current();
    },
  });
}
