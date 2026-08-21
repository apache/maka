import {
  isUiLocalePreference,
  resolveSystemUiLocale,
  resolveUiLocale,
  type UiLocale,
} from '@maka/core/ui-locale';

type CliEnvironment = Readonly<Record<string, string | undefined>>;

export type CliUiLocaleResolution =
  | { readonly ok: true; readonly locale: UiLocale }
  | { readonly ok: false; readonly message: string };

/** Resolve the interactive TUI locale without changing the top-level CLI grammar. */
export function resolveCliUiLocale(environment: CliEnvironment): CliUiLocaleResolution {
  const rawPreference = environment.MAKA_LOCALE?.trim();
  const preference = rawPreference ? rawPreference.toLowerCase() : 'auto';
  if (!isUiLocalePreference(preference)) {
    return {
      ok: false,
      message: `Invalid MAKA_LOCALE ${JSON.stringify(rawPreference)}. Expected zh, en, or auto.`,
    };
  }

  // POSIX locale variables are authorities, not a preference list. Once a
  // higher-priority variable is set, a lower-priority one must not override it.
  const systemLanguage = [environment.LC_ALL, environment.LC_MESSAGES, environment.LANG]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
  const systemLocale = resolveSystemUiLocale(systemLanguage ? [systemLanguage] : []);
  return { ok: true, locale: resolveUiLocale(preference, systemLocale) };
}
