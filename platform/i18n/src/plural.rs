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
//! CLDR cardinal plural category rules for supported locales.

use crate::BuiltinLocale;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PluralCategory {
    Zero,
    One,
    Two,
    Few,
    Many,
    Other,
}

impl PluralCategory {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Zero => "zero",
            Self::One => "one",
            Self::Two => "two",
            Self::Few => "few",
            Self::Many => "many",
            Self::Other => "other",
        }
    }
}

/// CLDR cardinal plural category for integer counts.
pub const fn plural_category(locale: BuiltinLocale, n: i64) -> PluralCategory {
    let abs = n.unsigned_abs();
    match locale {
        BuiltinLocale::ZhCn
        | BuiltinLocale::ZhTw
        | BuiltinLocale::ZhHk
        | BuiltinLocale::Ja
        | BuiltinLocale::Ko => PluralCategory::Other,
        BuiltinLocale::En | BuiltinLocale::De => {
            if abs == 1 {
                PluralCategory::One
            } else {
                PluralCategory::Other
            }
        }
        BuiltinLocale::Es | BuiltinLocale::It => {
            if abs == 1 {
                PluralCategory::One
            } else if abs != 0 && abs % 1_000_000 == 0 {
                PluralCategory::Many
            } else {
                PluralCategory::Other
            }
        }
        BuiltinLocale::Fr | BuiltinLocale::PtBr => {
            if abs == 0 || abs == 1 {
                PluralCategory::One
            } else if abs != 0 && abs % 1_000_000 == 0 {
                PluralCategory::Many
            } else {
                PluralCategory::Other
            }
        }
        BuiltinLocale::Ru => {
            let mod10 = abs % 10;
            let mod100 = abs % 100;
            if mod10 == 1 && mod100 != 11 {
                PluralCategory::One
            } else if matches!(mod10, 2..=4) && !matches!(mod100, 12..=14) {
                PluralCategory::Few
            } else {
                PluralCategory::Many
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cldr_cardinal_rules_match_all_twelve_locales() {
        for locale in [
            BuiltinLocale::ZhCn,
            BuiltinLocale::ZhTw,
            BuiltinLocale::ZhHk,
            BuiltinLocale::Ja,
            BuiltinLocale::Ko,
        ] {
            for n in [0, 1, 2, 5, 11, 21] {
                assert_eq!(plural_category(locale, n), PluralCategory::Other);
            }
        }
        for locale in [
            BuiltinLocale::En,
            BuiltinLocale::De,
            BuiltinLocale::Es,
            BuiltinLocale::It,
        ] {
            assert_eq!(plural_category(locale, 0), PluralCategory::Other);
            assert_eq!(plural_category(locale, 1), PluralCategory::One);
            assert_eq!(plural_category(locale, 2), PluralCategory::Other);
        }
        for locale in [BuiltinLocale::Fr, BuiltinLocale::PtBr] {
            assert_eq!(plural_category(locale, 0), PluralCategory::One);
            assert_eq!(plural_category(locale, 1), PluralCategory::One);
            assert_eq!(plural_category(locale, 2), PluralCategory::Other);
            assert_eq!(plural_category(locale, 1_000_000), PluralCategory::Many);
            assert_eq!(plural_category(locale, 2_000_000), PluralCategory::Many);
            assert_eq!(plural_category(locale, 1_000_001), PluralCategory::Other);
        }
        for locale in [BuiltinLocale::Es, BuiltinLocale::It] {
            assert_eq!(plural_category(locale, 1_000_000), PluralCategory::Many);
            assert_eq!(plural_category(locale, 1_000_001), PluralCategory::Other);
        }
        for locale in [BuiltinLocale::En, BuiltinLocale::De] {
            assert_eq!(plural_category(locale, 1_000_000), PluralCategory::Other);
        }
        assert_eq!(plural_category(BuiltinLocale::Ru, 0), PluralCategory::Many);
        assert_eq!(plural_category(BuiltinLocale::Ru, 1), PluralCategory::One);
        assert_eq!(plural_category(BuiltinLocale::Ru, 2), PluralCategory::Few);
        assert_eq!(plural_category(BuiltinLocale::Ru, 4), PluralCategory::Few);
        assert_eq!(plural_category(BuiltinLocale::Ru, 5), PluralCategory::Many);
        assert_eq!(plural_category(BuiltinLocale::Ru, 11), PluralCategory::Many);
        assert_eq!(plural_category(BuiltinLocale::Ru, 12), PluralCategory::Many);
        assert_eq!(plural_category(BuiltinLocale::Ru, 21), PluralCategory::One);
        assert_eq!(plural_category(BuiltinLocale::Ru, 22), PluralCategory::Few);
        assert_eq!(plural_category(BuiltinLocale::Ru, 25), PluralCategory::Many);
    }
}
