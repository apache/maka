---
title: nsh/i18n
description: "应用的翻译（从 locales/ 中按 rust-i18n 格式读取的文件）和应用显示的语言：t、setLocale、availableLocales。"
order: 12.6
---

# nsh/i18n

`nsh/i18n` 以用户的语言显示应用的文本。翻译来自应用的 `locales/` 文件，格式与 [rust-i18n](https://github.com/longbridge/rust-i18n) 相同，构建时读取并随 bundle 一起提供；API 也与 rust-i18n 相同，Rust 组件在 `nsh_core::prelude` 中有对应的 `t!`、`set_locale` 和 `available_locales`。[I18n](../docs/i18n.md) 介绍了如何翻译一个应用。

```tsx
import { availableLocales, setLocale, t } from "nsh/i18n";
```

它在所有平台上可用，包括 Web。

## t

```ts
function t(key: string, options?: { locale?: string; [name: string]: unknown }): string;
```

返回 `key` 在应用显示的语言下的文本：用户偏好语言（`localeSettings().languages`）中第一个应用有翻译的语言，否则为 `locale()` 的语言。

- `options` 中除 `locale` 外的成员会填入文本的 `%{name}` 占位符，按文本写出（`String(value)`）。
- `options.locale` 用于取另一种语言的文本。
- 某个语言缺少的 key，会依次从去掉最后一个子标签的语言（`zh-Hant-TW`、`zh-Hant`、`zh`）中查找，再从英语（`en`）中查找。所有语言都没有时，文本为 `<locale>.<key>`。
- 读取它会订阅语言和翻译：显示它的文本会随 `setLocale`、用户设置以及开发中的文件变化而更新。

```tsx
<Text>{t("cart.items", { count: items().length })}</Text>
```

## setLocale

```ts
function setLocale(locale: string | null): void;
```

让应用显示 `locale`（BCP 47 标签，`"zh-CN"`），而不管用户的语言：`t`、`locale()`、`localeSettings().languages` 的第一项和 `Intl` 的默认 locale 会立即跟随它。`null` 重新跟随用户的语言。不是语言标签的字符串会抛出 `RangeError`。这个选择在应用运行期间有效，只作用于它所在的 surface。

## availableLocales

```ts
function availableLocales(): string[];
```

应用翻译所包含的语言，按文件中的写法排序（`["en", "ja", "zh-CN"]`）。

## 文件

`nsh.json` 旁边的 `locales/` 存放 rust-i18n 的文件：YAML、JSON 或 TOML，每种语言一个（`en.yml`、`app.zh-CN.yml`），或一个文件包含所有语言（`_version: 2`）。key 用点嵌套。见[翻译文件](../docs/i18n.md#翻译文件)。

## nsh.json

`"locales"` 列出除英语外 bundle 需要携带数字和日期数据的语言；没有它时为翻译所包含的语言（[数字和日期](../docs/i18n.md#数字和日期)）。
