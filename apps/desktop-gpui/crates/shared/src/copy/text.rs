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

//! The locale machinery behind the copy table: which language the interface
//! speaks ([`Locale`], a GPUI global), one translatable string ([`Text`]),
//! and the rules for filling its placeholders and picking a plural form.

use gpui_kit::{App, Global};

/// The interface language. The app keeps the current one as a GPUI global,
/// set from the saved preference at startup and whenever the preference
/// changes; views read it through [`Text::get`] on every render, so a change
/// shows everywhere at the next frame.
///
/// The tags match Maka Desktop's `UiLocale` (`packages/core/src/ui-locale.ts`)
/// and the catalogs gpui-kit's own strings ship with.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub enum Locale {
    #[default]
    English,
    SimplifiedChinese,
    TraditionalChinese,
}

impl Global for Locale {}

impl Locale {
    /// Every locale, in the order language pickers list them.
    pub const ALL: [Self; 3] = [Self::English, Self::SimplifiedChinese, Self::TraditionalChinese];

    /// The BCP 47 tag: `en`, `zh-CN`, or `zh-TW`.
    pub fn tag(self) -> &'static str {
        match self {
            Self::English => "en",
            Self::SimplifiedChinese => "zh-CN",
            Self::TraditionalChinese => "zh-TW",
        }
    }

    /// The locale a tag names. Script subtags (`zh-Hans`, `zh-Hant`) and
    /// the Hong Kong region read as their Chinese; case does not matter.
    pub fn from_tag(tag: &str) -> Option<Self> {
        match tag.to_ascii_lowercase().as_str() {
            "en" | "en-us" | "en-gb" => Some(Self::English),
            "zh" | "zh-cn" | "zh-hans" | "zh-sg" => Some(Self::SimplifiedChinese),
            "zh-tw" | "zh-hant" | "zh-hk" | "zh-mo" => Some(Self::TraditionalChinese),
            _ => None,
        }
    }

    /// Whether the language is written in CJK characters, which need one
    /// size step more than Latin at the smallest text sizes to stay legible.
    pub fn is_cjk(self) -> bool {
        matches!(self, Self::SimplifiedChinese | Self::TraditionalChinese)
    }

    /// The interface language of the app: the global, else English.
    pub fn current(cx: &App) -> Self {
        cx.try_global::<Self>().copied().unwrap_or_default()
    }

    /// Makes this the interface language: stores the global (its observers
    /// rebuild what they cached), hands the tag to gpui-kit's own strings
    /// (search placeholders, empty lists, input menus), and redraws every
    /// window. Setting the current locale again does nothing.
    pub fn apply(self, cx: &mut App) {
        if cx.try_global::<Self>() == Some(&self) {
            return;
        }
        cx.set_global(self);
        gpui_kit::component::set_locale(self.tag());
        cx.refresh_windows();
    }
}

/// One user-facing string in every locale: a key of the copy table.
///
/// Views call [`Text::get`] with the context they render in; pure code that
/// formats for a known locale calls [`Text::in_locale`]. A text may hold
/// `{name}` placeholders, filled by [`Text::fill`]; every locale's version
/// holds the same ones (the table test checks).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Text {
    en: &'static str,
    zh_cn: &'static str,
    zh_tw: &'static str,
}

impl Text {
    /// English, Simplified Chinese, and Traditional Chinese, in that order.
    pub const fn new(en: &'static str, zh_cn: &'static str, zh_tw: &'static str) -> Self {
        Self { en, zh_cn, zh_tw }
    }

    /// The text in the app's current locale.
    pub fn get(self, cx: &App) -> &'static str {
        self.in_locale(Locale::current(cx))
    }

    /// The text in `locale`.
    pub fn in_locale(self, locale: Locale) -> &'static str {
        match locale {
            Locale::English => self.en,
            Locale::SimplifiedChinese => self.zh_cn,
            Locale::TraditionalChinese => self.zh_tw,
        }
    }

    /// The English text, for tests that pin the default locale.
    pub fn en(self) -> &'static str {
        self.en
    }

    /// The text in `locale` with each `{name}` replaced by the value paired
    /// with `name` in `args`. One pass, so a value that itself contains
    /// braces is inserted as it is; a placeholder without a value stays.
    pub fn fill(self, locale: Locale, args: &[(&str, &str)]) -> String {
        fill(self.in_locale(locale), args)
    }

    /// The names of the `{name}` placeholders the text holds in `locale`,
    /// sorted.
    pub fn placeholders(self, locale: Locale) -> Vec<&'static str> {
        let mut names: Vec<&str> =
            placeholder_spans(self.in_locale(locale)).map(|(_, _, name)| name).collect();
        names.sort_unstable();
        names
    }
}

/// The form of a counted phrase: English distinguishes one from many;
/// Chinese uses one form for every count, so both texts carry it.
pub fn plural(count: u64, one: Text, other: Text) -> Text {
    if count == 1 { one } else { other }
}

/// `(start, end, name)` of each `{name}` in `template`, where a name is an
/// identifier (ASCII letters, digits, `_`).
fn placeholder_spans(template: &str) -> impl Iterator<Item = (usize, usize, &str)> {
    let bytes = template.as_bytes();
    let mut ix = 0;
    std::iter::from_fn(move || {
        while ix < bytes.len() {
            if bytes[ix] == b'{' {
                let start = ix;
                let name_start = ix + 1;
                let mut end = name_start;
                while end < bytes.len()
                    && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_')
                {
                    end += 1;
                }
                if end > name_start && end < bytes.len() && bytes[end] == b'}' {
                    ix = end + 1;
                    return Some((start, end + 1, &template[name_start..end]));
                }
            }
            ix += 1;
        }
        None
    })
}

fn fill(template: &str, args: &[(&str, &str)]) -> String {
    let mut out = String::with_capacity(template.len() + 16);
    let mut last = 0;
    for (start, end, name) in placeholder_spans(template) {
        if let Some((_, value)) = args.iter().find(|(key, _)| *key == name) {
            out.push_str(&template[last..start]);
            out.push_str(value);
            last = end;
        }
    }
    out.push_str(&template[last..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const GREETING: Text = Text::new("Hello, {name}.", "你好，{name}。", "你好，{name}。");

    #[test]
    fn a_text_reads_in_each_locale() {
        assert_eq!(GREETING.in_locale(Locale::English), "Hello, {name}.");
        assert_eq!(GREETING.in_locale(Locale::SimplifiedChinese), "你好，{name}。");
        assert_eq!(GREETING.en(), "Hello, {name}.");
    }

    #[test]
    fn placeholders_fill_in_one_pass() {
        assert_eq!(GREETING.fill(Locale::English, &[("name", "{name}")]), "Hello, {name}.");
        assert_eq!(GREETING.fill(Locale::SimplifiedChinese, &[("name", "Maka")]), "你好，Maka。");
        assert_eq!(GREETING.fill(Locale::English, &[]), "Hello, {name}.", "no value, no change");
        assert_eq!(fill("{a}{b} {c", &[("a", "1"), ("b", "2")]), "12 {c");
        assert_eq!(GREETING.placeholders(Locale::TraditionalChinese), ["name"]);
    }

    #[test]
    fn tags_round_trip_and_aliases_resolve() {
        for locale in Locale::ALL {
            assert_eq!(Locale::from_tag(locale.tag()), Some(locale));
        }
        assert_eq!(Locale::from_tag("zh-Hans"), Some(Locale::SimplifiedChinese));
        assert_eq!(Locale::from_tag("ZH-hant"), Some(Locale::TraditionalChinese));
        assert_eq!(Locale::from_tag("fr"), None);
    }

    #[test]
    fn a_plural_picks_the_form_by_count() {
        let one = Text::new("1 task", "1 个任务", "1 個任務");
        let other = Text::new("{count} tasks", "{count} 个任务", "{count} 個任務");
        assert_eq!(plural(1, one, other), one);
        assert_eq!(plural(0, one, other), other);
        assert_eq!(plural(2, one, other), other);
    }
}
