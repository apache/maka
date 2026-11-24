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

import type { DisplayText } from './generated/runtime.js';

export type TextDirection = 'ltr' | 'rtl';
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export interface SupportedLocaleInfo {
  readonly tag: SupportedLocaleTag;
  readonly autonym: string;
  readonly englishName: string;
  readonly dir: TextDirection;
  readonly overlay?: SupportedLocaleTag;
  readonly fallbacks: readonly SupportedLocaleTag[];
}

export type SupportedLocaleTag =
  | 'en'
  | 'zh-CN'
  | 'zh-TW'
  | 'zh-HK'
  | 'ja'
  | 'ko'
  | 'es'
  | 'fr'
  | 'de'
  | 'pt-BR'
  | 'ru'
  | 'it';

/** Authoritative manifest of built-in locales (synchronized with locales.manifest.json). */
export const SUPPORTED_LOCALES: readonly SupportedLocaleInfo[] = [
  { tag: 'en', autonym: 'English', englishName: 'English', dir: 'ltr', fallbacks: [] },
  {
    tag: 'zh-CN',
    autonym: '简体中文',
    englishName: 'Chinese (Simplified)',
    dir: 'ltr',
    fallbacks: ['en'],
  },
  {
    tag: 'zh-TW',
    autonym: '繁體中文（中國台灣）',
    englishName: 'Chinese (Traditional, Taiwan, China)',
    dir: 'ltr',
    fallbacks: ['en'],
  },
  {
    tag: 'zh-HK',
    autonym: '繁體中文（中國香港）',
    englishName: 'Chinese (Traditional, Hong Kong, China)',
    dir: 'ltr',
    overlay: 'zh-TW',
    fallbacks: ['zh-TW', 'en'],
  },
  { tag: 'ja', autonym: '日本語', englishName: 'Japanese', dir: 'ltr', fallbacks: ['en'] },
  { tag: 'ko', autonym: '한국어', englishName: 'Korean', dir: 'ltr', fallbacks: ['en'] },
  { tag: 'es', autonym: 'Español', englishName: 'Spanish', dir: 'ltr', fallbacks: ['en'] },
  { tag: 'fr', autonym: 'Français', englishName: 'French', dir: 'ltr', fallbacks: ['en'] },
  { tag: 'de', autonym: 'Deutsch', englishName: 'German', dir: 'ltr', fallbacks: ['en'] },
  {
    tag: 'pt-BR',
    autonym: 'Português (Brasil)',
    englishName: 'Portuguese (Brazil)',
    dir: 'ltr',
    fallbacks: ['en'],
  },
  { tag: 'ru', autonym: 'Русский', englishName: 'Russian', dir: 'ltr', fallbacks: ['en'] },
  { tag: 'it', autonym: 'Italiano', englishName: 'Italian', dir: 'ltr', fallbacks: ['en'] },
] as const;

const LOCALE_INFO_BY_TAG: Readonly<Record<SupportedLocaleTag, SupportedLocaleInfo>> =
  Object.fromEntries(SUPPORTED_LOCALES.map((entry) => [entry.tag, entry])) as Record<
    SupportedLocaleTag,
    SupportedLocaleInfo
  >;

const EXACT_TAG_MAP = new Map<string, SupportedLocaleTag>(
  SUPPORTED_LOCALES.map((entry) => [entry.tag.toLowerCase(), entry.tag]),
);

/** Normalize POSIX/BCP 47 locale tags into canonical BCP 47 casing. */
export function normalizeLocaleTag(raw: string): string | null {
  const head = raw.trim().split(/[.@]/, 1)[0]?.trim() ?? '';
  if (!head || head.length > 35) return null;
  const parts = head.replaceAll('_', '-').split('-');
  const first = parts[0];
  if (!first || !/^[a-zA-Z]{2,3}$/.test(first)) return null;
  const out = [first.toLowerCase()];
  for (let i = 1; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (!/^[a-zA-Z0-9]{1,8}$/.test(part)) return null;
    if (i === 1 && /^[a-zA-Z]{4}$/.test(part)) {
      out.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    } else if (/^[a-zA-Z]{2}$/.test(part) || /^[0-9]{3}$/.test(part)) {
      out.push(part.toUpperCase());
    } else {
      out.push(part.toLowerCase());
    }
  }
  return out.join('-');
}

/** Script-aware BCP 47 negotiation of a single tag against built-in locales; null if unsupported. */
export function negotiateSingleLocale(locale: string): SupportedLocaleTag | null {
  const normalized = normalizeLocaleTag(locale);
  if (!normalized) return null;
  const exact = EXACT_TAG_MAP.get(normalized.toLowerCase());
  if (exact) return exact;
  const parts = normalized.toLowerCase().split('-');
  const lang = parts[0];
  const rest = parts.slice(1);
  switch (lang) {
    case 'zh':
      if (rest.includes('hans')) return 'zh-CN';
      if (rest.includes('hant')) {
        return rest.includes('hk') || rest.includes('mo') ? 'zh-HK' : 'zh-TW';
      }
      if (rest.includes('hk') || rest.includes('mo')) return 'zh-HK';
      if (rest.includes('tw')) return 'zh-TW';
      return 'zh-CN';
    case 'yue':
      return rest.includes('hans') ? 'zh-CN' : 'zh-HK';
    case 'ja':
      return 'ja';
    case 'ko':
      return 'ko';
    case 'es':
      return 'es';
    case 'fr':
      return 'fr';
    case 'de':
      return 'de';
    case 'pt':
      return 'pt-BR';
    case 'ru':
      return 'ru';
    case 'it':
      return 'it';
    case 'en':
      return 'en';
    default:
      return null;
  }
}

/** Negotiate one or more preferred BCP 47 tags to a built-in locale, defaulting to 'en'. */
export function negotiateLocale(preferred: string | readonly string[]): SupportedLocaleTag {
  if (typeof preferred === 'string') {
    return negotiateSingleLocale(preferred) ?? 'en';
  }
  for (const tag of preferred) {
    const matched = negotiateSingleLocale(tag);
    if (matched) return matched;
  }
  return 'en';
}

/** Explicit product preference wins; 'auto' follows the bound native environment. */
export function resolveLocale(configured: string | null | undefined, native: unknown): string {
  if (configured && configured !== 'auto') {
    return normalizeLocaleTag(configured) ?? configured;
  }
  if (typeof native === 'string' && native.length > 0) {
    return normalizeLocaleTag(native) ?? native;
  }
  return 'en';
}

/** CLDR cardinal plural category for integer counts, aligned with maka-i18n. */
export function pluralCategory(locale: string, count: number): PluralCategory {
  const tag = negotiateLocale(locale);
  const abs = Math.abs(Math.trunc(count));
  switch (tag) {
    case 'zh-CN':
    case 'zh-TW':
    case 'zh-HK':
    case 'ja':
    case 'ko':
      return 'other';
    case 'fr':
    case 'pt-BR':
      return abs === 0 || abs === 1 ? 'one' : 'other';
    case 'ru': {
      const m10 = abs % 10;
      const m100 = abs % 100;
      if (m10 === 1 && m100 !== 11) return 'one';
      if (m10 >= 2 && m10 <= 4 && !(m100 >= 12 && m100 <= 14)) return 'few';
      return 'many';
    }
    default:
      return abs === 1 ? 'one' : 'other';
  }
}

type IcuNode =
  | { kind: 'lit'; text: string }
  | { kind: 'var'; name: string }
  | { kind: 'hash' }
  | { kind: 'plural'; name: string; exact: Map<number, IcuNode[]>; forms: Map<string, IcuNode[]> }
  | { kind: 'select'; name: string; cases: Map<string, IcuNode[]> };

const astCache = new Map<string, IcuNode[]>();

function parseIcu(input: string): IcuNode[] {
  const cached = astCache.get(input);
  if (cached) return cached;
  let pos = 0;

  const skipWs = () => {
    while (pos < input.length && /\s/.test(input[pos]!)) pos += 1;
  };
  const readIdent = () => {
    skipWs();
    const start = pos;
    while (pos < input.length && /[a-zA-Z0-9_=-]/.test(input[pos]!)) pos += 1;
    return input.slice(start, pos);
  };
  const parseNodes = (stopOnClose: boolean, inPlural: boolean): IcuNode[] => {
    const nodes: IcuNode[] = [];
    let lit = '';
    const flush = () => {
      if (lit) {
        nodes.push({ kind: 'lit', text: lit });
        lit = '';
      }
    };
    while (pos < input.length) {
      const ch = input[pos]!;
      if (ch === '}' && stopOnClose) {
        flush();
        return nodes;
      }
      if (ch === '#' && inPlural) {
        flush();
        nodes.push({ kind: 'hash' });
        pos += 1;
        continue;
      }
      if (ch === "'") {
        const next = input[pos + 1];
        if (next === "'") {
          lit += "'";
          pos += 2;
          continue;
        }
        if (next === '{' || next === '}' || next === '#') {
          pos += 1;
          while (pos < input.length) {
            if (input[pos] === "'") {
              if (input[pos + 1] === "'") {
                lit += "'";
                pos += 2;
              } else {
                pos += 1;
                break;
              }
            } else {
              lit += input[pos]!;
              pos += 1;
            }
          }
          continue;
        }
        lit += "'";
        pos += 1;
        continue;
      }
      if (ch === '{') {
        if (pos + 1 < input.length && /[a-zA-Z_]/.test(input[pos + 1]!)) {
          flush();
          nodes.push(parseBrace());
          continue;
        }
        lit += ch;
        pos += 1;
        continue;
      }
      lit += ch;
      pos += 1;
    }
    flush();
    return nodes;
  };

  const parseBrace = (): IcuNode => {
    pos += 1; // '{'
    const name = readIdent();
    skipWs();
    if (input[pos] === '}') {
      pos += 1;
      return { kind: 'var', name };
    }
    if (input[pos] === ',') {
      pos += 1;
      const type = readIdent();
      skipWs();
      if (input[pos] === ',') pos += 1;
      if (type === 'plural') {
        const exact = new Map<number, IcuNode[]>();
        const forms = new Map<string, IcuNode[]>();
        while (pos < input.length) {
          skipWs();
          if (input[pos] === '}') {
            pos += 1;
            break;
          }
          const sel = readIdent();
          skipWs();
          if (input[pos] === '{') pos += 1;
          const body = parseNodes(true, true);
          if (input[pos] === '}') pos += 1;
          if (sel.startsWith('=')) exact.set(Number(sel.slice(1)), body);
          else forms.set(sel, body);
        }
        return { kind: 'plural', name, exact, forms };
      }
      if (type === 'select') {
        const cases = new Map<string, IcuNode[]>();
        while (pos < input.length) {
          skipWs();
          if (input[pos] === '}') {
            pos += 1;
            break;
          }
          const key = readIdent();
          skipWs();
          if (input[pos] === '{') pos += 1;
          const body = parseNodes(true, false);
          if (input[pos] === '}') pos += 1;
          cases.set(key, body);
        }
        return { kind: 'select', name, cases };
      }
    }
    // Fallback: preserve malformed placeholder verbatim
    return { kind: 'lit', text: '{' + name + '}' };
  };

  const parsed = parseNodes(false, false);
  astCache.set(input, parsed);
  return parsed;
}

function evalNodes(
  nodes: readonly IcuNode[],
  locale: string,
  values: Readonly<Record<string, string | number>> | undefined,
  activeCount?: number,
): string {
  let out = '';
  for (const node of nodes) {
    switch (node.kind) {
      case 'lit':
        out += node.text;
        break;
      case 'var':
        out += values && node.name in values ? String(values[node.name]) : '{' + node.name + '}';
        break;
      case 'hash':
        out += activeCount !== undefined ? String(activeCount) : '#';
        break;
      case 'plural': {
        const raw = values?.[node.name];
        const num = typeof raw === 'number' ? raw : Number(raw ?? 0);
        const branch =
          node.exact.get(num) ??
          node.forms.get(pluralCategory(locale, num)) ??
          node.forms.get('other');
        if (branch) out += evalNodes(branch, locale, values, num);
        break;
      }
      case 'select': {
        const key = String(values?.[node.name] ?? '');
        const branch = node.cases.get(key) ?? node.cases.get('other');
        if (branch) out += evalNodes(branch, locale, values, activeCount);
        break;
      }
    }
  }
  return out;
}

/** Format an ICU MessageFormat string for `locale`. Static strings skip parsing completely. */
export function formatMessage(
  template: string,
  locale: string,
  values?: Readonly<Record<string, string | number>>,
): string {
  if (!template.includes('{') && !template.includes("'")) {
    return template;
  }
  return evalNodes(parseIcu(template), locale, values);
}

export type LocaleMessages<K extends string = string> = Readonly<Record<K, string>>;
export type PartialLocaleMessages<K extends string = string> = Readonly<Partial<Record<K, string>>>;

export type LocaleCatalogBundle<K extends string> = {
  readonly en: LocaleMessages<K>;
} & Readonly<Partial<Record<Exclude<SupportedLocaleTag, 'en'>, PartialLocaleMessages<K>>>>;

/** Build a locale-aware translator with overlay inheritance (e.g. zh-HK -> zh-TW -> en) and ICU formatting. */
export function createI18n<K extends string>(bundle: LocaleCatalogBundle<K>) {
  const resolved = new Map<SupportedLocaleTag, LocaleMessages<K>>();

  const catalogFor = (locale: string): LocaleMessages<K> => {
    const tag = negotiateLocale(locale);
    const hit = resolved.get(tag);
    if (hit) return hit;

    const info = LOCALE_INFO_BY_TAG[tag];
    const chain: SupportedLocaleTag[] = [...info.fallbacks].reverse();
    chain.push(tag);
    const merged: Record<string, string> = { ...bundle.en };
    for (const step of chain) {
      const layer = step === 'en' ? bundle.en : bundle[step];
      if (!layer) continue;
      for (const [k, v] of Object.entries(layer)) {
        if (typeof v === 'string') merged[k] = v;
      }
    }
    const frozen = Object.freeze(merged) as LocaleMessages<K>;
    resolved.set(tag, frozen);
    return frozen;
  };

  const t = (
    locale: string,
    key: K,
    values?: Readonly<Record<string, string | number>>,
  ): string => {
    const message = catalogFor(locale)[key];
    return values === undefined && !message.includes('{')
      ? message
      : formatMessage(message, locale, values);
  };

  return {
    catalogFor,
    t,
    /** Bind to a reactive locale getter (such as UiContext.locale). */
    bind(getLocale: () => string) {
      return (key: K, values?: Readonly<Record<string, string | number>>): string =>
        t(getLocale(), key, values);
    },
  };
}

/** Script-aware resolution for open translation maps (matches maka_i18n::resolve_translation). */
function resolveFromMap<V>(
  translations: Readonly<Record<string, V | undefined>> | undefined,
  locale: string,
): V | undefined {
  if (!translations) return undefined;
  if (translations[locale] !== undefined) return translations[locale];
  const normalized = normalizeLocaleTag(locale);
  if (!normalized) return undefined;
  if (translations[normalized] !== undefined) return translations[normalized];
  const lower = normalized.toLowerCase();
  for (const [key, value] of Object.entries(translations)) {
    if (value !== undefined && key.toLowerCase() === lower) return value;
  }
  const builtin = negotiateSingleLocale(normalized);
  if (builtin) {
    const info = LOCALE_INFO_BY_TAG[builtin];
    for (const candidate of [builtin, ...info.fallbacks]) {
      if (translations[candidate] !== undefined) return translations[candidate];
    }
  }
  const primary = normalized.split('-')[0]!;
  if (primary !== 'zh' && primary !== 'yue') {
    for (const [key, value] of Object.entries(translations)) {
      if (value !== undefined && key.toLowerCase() === primary) return value;
    }
  }
  return undefined;
}

/** Resolve an authored DisplayText in `locale` with script-aware fallback (zh-HK -> zh-TW -> fallback). */
export function resolveDisplayText(text: DisplayText, locale: string): string {
  return resolveFromMap(text.translations, locale) ?? text.fallback;
}

/** Resolve a plugin manifest's localized displayName and description. */
export function resolveLocalizedPresentation<
  T extends { displayName: string; description: string },
>(
  presentation: T & { localizations?: Readonly<Record<string, T | undefined>> },
  locale: string,
): T {
  return resolveFromMap(presentation.localizations, locale) ?? presentation;
}
