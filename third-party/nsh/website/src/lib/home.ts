import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import en from '../home/en.json';
import zh from '../home/zh-CN.json';
import { isMachine, machineLocales } from './locales';
import { url } from './site';

/**
 * The home page's words (`src/home/<lang>.json`): English and Chinese are
 * written here, other languages are machine translated in
 * longbridge/nsh-website-translates from `en.json` (its `<code>/home.json`).
 * Numbers, commands and code stay in `Home.astro`, the same in every language.
 */
export type HomeCopy = typeof en;

export interface Home {
  copy: HomeCopy;
  /** Whether a machine locale has its translation; else the page is the English. */
  translated: boolean;
}

const ROOT = join(process.cwd(), 'translations');

/**
 * `translation` over `english`, string by string: what the translation lacks,
 * or holds in another shape (an older English), stays English.
 */
function overlay<T>(english: T, translation: unknown): T {
  if (typeof english === 'string') return (typeof translation === 'string' && translation.trim() ? translation : english) as T;
  if (Array.isArray(english)) {
    const list = Array.isArray(translation) ? translation : [];
    return english.map((item, i) => overlay(item, list[i])) as T;
  }
  if (english && typeof english === 'object') {
    const fields = translation && typeof translation === 'object' && !Array.isArray(translation) ? (translation as Record<string, unknown>) : {};
    return Object.fromEntries(Object.entries(english).map(([key, value]) => [key, overlay(value, fields[key])])) as T;
  }
  return english;
}

/** The home page's words in `locale`. */
export function homeCopy(locale: string): Home {
  if (locale === 'zh-CN') return { copy: zh as HomeCopy, translated: true };
  if (!isMachine(locale)) return { copy: en, translated: true };
  const file = join(ROOT, locale, 'home.json');
  if (!existsSync(file)) return { copy: en, translated: false };
  const { strings } = JSON.parse(readFileSync(file, 'utf8')) as { strings?: unknown };
  return strings ? { copy: overlay(en, strings), translated: true } : { copy: en, translated: false };
}

/** The home page in each language, for the language menu. */
export function homeLanguages(): { code: string; name: string; href: string }[] {
  return [
    { code: 'en', name: 'English', href: url('') },
    { code: 'zh-CN', name: '简体中文', href: url('zh-CN') },
    ...machineLocales.map(({ code, name }) => ({ code, name, href: url(code) })),
  ];
}

/** Routes of the home page in each language that has it, for hreflang. */
export function homeAlternates(): Record<string, string> {
  const routes: Record<string, string> = { en: '/', 'zh-CN': '/zh-CN' };
  for (const { code } of machineLocales) if (homeCopy(code).translated) routes[code] = `/${code}`;
  return routes;
}
