---
title: nsh/i18n
description: "The app's translations, read from its locales/ files in rust-i18n's formats or added at run time, and the language it shows: t, setLocale, availableLocales, addTranslations."
order: 12.6
---

# nsh/i18n

`nsh/i18n` shows the app's text in the user's language. The translations are the app's `locales/` files, in
[rust-i18n](https://github.com/longbridge/rust-i18n)'s formats, which the build reads and the bundle carries, plus any
added at run time with `addTranslations`; the API is rust-i18n's, and Rust components have the same as `t!`,
`set_locale`, `available_locales` and `add_translations` in `nsh_core::prelude`. [I18n](../docs/i18n.md) walks through
translating an app.

```tsx
import { addTranslations, availableLocales, setLocale, t } from "nsh/i18n";
```

It works on every platform, the web included.

## t

```ts
function t<K extends TranslationKey>(
  key: K,
  options?: Translations[K] & { locale?: LocaleTag },
): string;
// Without `locales/`:
// function t(key: string, options?: { locale?: string; [name: string]: unknown }): string;
```

The text of `key` in the language the app shows: the first of the user's preferred languages
(`localeSettings().languages`) the app has translations in, else `locale()`'s.

- **Type checking**: when the app has a `locales/` directory, `nsh` generates `.nsh/types/nsh/translations.d.ts`
  (mirroring `.nsh/types/nsh/tokens.d.ts`), augmenting `Translations` and `TranslationLocales`. `nsh check` and editors
  check `key` (`TranslationKey`), require `options` whenever the key's message has `%{name}` placeholders (optional
  otherwise), and offer `LocaleTag` autocomplete. Without `locales/`, `TranslationKey` and `LocaleTag` fall back to
  `string`.
- When `locales/` is present, passing a plain `string` variable as `key` requires typing the variable (for example
  `TranslationKey` or a template-literal union like `` `status.${kind}` ``) or asserting it (`key as TranslationKey`),
  and calling keys loaded only at run time with `addTranslations` and arbitrary parameters can cast `t` (for example
  `(t as (key: string, options?: { locale?: LocaleTag; [name: string]: unknown }) => string)`).
- `options`' members other than `locale` fill the text's `%{name}` patterns, written as text (`String(value)`).
- `options.locale` asks for the text in another language.
- A key a language lacks comes from the language without its last subtag (`zh-Hant-TW`, `zh-Hant`, `zh`), then from
  English (`en`). Where no language has it, the text is `<locale>.<key>`.
- Reading it subscribes to the language and the translations: a text that shows it updates with `setLocale`, the
  user's settings and, in development, the files.

```tsx
t("hello");
t("messages.hello", { name: "Jason" });
t("hello", { locale: "zh-CN" });

<Text>{t("cart.items", { count: items().length })}</Text>;
```

## setLocale

```ts
function setLocale(locale: LocaleTag | null): void;
```

Shows the app in `locale`, a BCP 47 tag (`"zh-CN"`), whatever the user's language: `t`, `locale()`, the first of
`localeSettings().languages` and `Intl`'s default locale follow it at once. `null` follows the user's language again.
A string that is not a language tag throws a `RangeError`. The choice lasts while the app runs, on its surface only.

## availableLocales

```ts
function availableLocales(): string[];
```

The languages the app has translations in, sorted (`["en", "ja", "zh-CN"]`). Reading it subscribes to changes in the
translations, so a list that renders it updates when `addTranslations` adds a language.

## addTranslations

```ts
function addTranslations(translations: Record<string, Record<string, string>>): void;
```

Merges `translations` (keys and their text by language) into this surface's dictionary at run time: keys for an
existing language overwrite only those keys and leave the rest untouched, and new languages are added. Views reading
`t` (and Rust's `t!`) and `availableLocales()` update in place without restarting. Throws a `TypeError` if
`translations` is not a plain object mapping locale strings to plain objects of string values.

```tsx
addTranslations({
  en: { "settings.title": "Settings" },
  fr: { hello: "Bonjour" },
});
```

## Files

`locales/`, beside `nsh.json`, holds rust-i18n's files: YAML, JSON or TOML, one per language (`en.yml`,
`app.zh-CN.yml`) or one with every language (`_version: 2`). Keys nest with dots. See
[Translation files](../docs/i18n.md#translation-files).

## nsh.json

`"locales"` lists the languages whose number and date data the bundle carries, besides English; without it, the
languages of the translations ([Numbers and dates](../docs/i18n.md#numbers-and-dates)).
