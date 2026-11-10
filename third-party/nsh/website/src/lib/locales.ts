import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Lang } from './site';

/**
 * Languages beyond English and Chinese are translated by machine and kept in
 * longbridge/nsh-website-translates: a published root's build clones it to
 * `website/translations/`. Without that directory (pull requests, older
 * versions, local builds) they are simply absent.
 */
export interface MachineLocale {
  code: string;
  name: string;
  /** `rtl` for a language written right to left (Arabic); left to right when absent. */
  dir?: 'ltr' | 'rtl';
}

const ROOT = join(process.cwd(), 'translations');
const REGISTRY = join(ROOT, 'locales.json');

// Chinese scripts lead the machine locales, so Traditional Chinese sits right
// after Simplified Chinese in the language menu; the rest keep the registry's
// order (the sort is stable).
export const machineLocales: MachineLocale[] = existsSync(REGISTRY)
  ? (JSON.parse(readFileSync(REGISTRY, 'utf8')) as MachineLocale[])
      .filter((l) => existsSync(join(ROOT, l.code, 'ui.json')))
      .sort((a, b) => Number(b.code.startsWith('zh-')) - Number(a.code.startsWith('zh-')))
  : [];

/** The direction a page in `locale` is written in. */
export function direction(locale: string): 'ltr' | 'rtl' {
  return machineLocales.find((l) => l.code === locale)?.dir === 'rtl' ? 'rtl' : 'ltr';
}

export function isMachine(locale: string): boolean {
  return locale !== 'en' && locale !== 'zh-CN';
}

/** The locale the site's own strings are written in, for a page in `locale`. */
export function chromeLang(locale: string): Lang {
  return locale === 'zh-CN' ? 'zh-CN' : 'en';
}

const UI_EN = {
  notice: 'This page was translated by machine and may contain errors.',
  fallback: 'This page has not been translated yet.',
  original: 'Read the English original',
  prev: 'Previous',
  next: 'Next',
  toc: 'On this page',
};
export type UiKey = keyof typeof UI_EN;
const cache = new Map<string, Record<string, string>>();

/** A machine locale's strings; whatever it lacks stays English. */
function uiOf(locale: string): Record<string, string> {
  let strings = cache.get(locale);
  if (!strings) {
    strings = JSON.parse(readFileSync(join(ROOT, locale, 'ui.json'), 'utf8')) as Record<string, string>;
    cache.set(locale, strings);
  }
  return strings;
}

export function ui(locale: string, key: UiKey): string {
  return (isMachine(locale) && uiOf(locale)[key]) || UI_EN[key];
}

/** A section's or sidebar group's label in `locale`. */
export function label(labels: Record<Lang, string>, locale: string): string {
  return (isMachine(locale) && uiOf(locale)[labels.en]) || labels[chromeLang(locale)];
}
