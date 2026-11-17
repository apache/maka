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
use std::collections::HashSet;

use regex_syntax::hir::{ClassUnicode, ClassUnicodeRange};
use unicode_normalization::{
    IsNormalized, UnicodeNormalization, char::canonical_combining_class, is_nfc_quick,
};
const GRAM_BITS: u32 = 21;

fn append_token(result: &mut String, key: u64) {
    result.push('g');
    for shift in [2 * GRAM_BITS, GRAM_BITS, 0] {
        let scalar = (key >> shift) & ((1 << GRAM_BITS) - 1);
        if scalar == 0 {
            continue;
        }
        let mut value = scalar - 1;
        let mut encoded = [b'0'; 4];
        for digit in encoded.iter_mut().rev() {
            *digit = b"0123456789abcdefghijklmnopqrstuvwxyz"[(value % 36) as usize];
            value /= 36;
        }
        for byte in encoded {
            result.push(char::from(byte));
        }
    }
}

fn gram_keys(text: &str, minimum: u32) -> Vec<u64> {
    let mut keys = {
        let mut unique = HashSet::<u64>::new();
        let mut window = 0;
        let mut available = 0;
        for scalar in text.chars() {
            // Three nonzero 21-bit lanes fit in 63 bits, including U+0000 as 1.
            window = ((window << GRAM_BITS) | (u64::from(u32::from(scalar)) + 1)) & (u64::MAX >> 1);
            available = (available + 1).min(3);
            for size in minimum..=available {
                unique.insert(window & ((1 << (size * GRAM_BITS)) - 1));
            }
        }
        unique.into_iter().collect::<Vec<_>>()
    };
    keys.sort_unstable();
    keys
}

pub(crate) fn grams(text: &str) -> String {
    let keys = gram_keys(text, 1);
    let mut result = String::new();
    for key in keys {
        if !result.is_empty() {
            result.push(' ');
        }
        append_token(&mut result, key);
    }
    result
}

pub(crate) fn expression(terms: &[String]) -> String {
    terms
        .iter()
        .map(|term| {
            let mut tokens = String::new();
            for key in gram_keys(term, term.chars().count().min(3) as u32) {
                if !tokens.is_empty() {
                    tokens.push_str(" AND ");
                }
                append_token(&mut tokens, key);
            }
            format!("({tokens})")
        })
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// Grams guaranteed to survive the Recall index's NFC and lowercase transform.
pub(super) fn find_expression(query: &str, case_sensitive: bool) -> Option<String> {
    let mut previous: Option<String> = None;
    let mut run = String::new();
    let mut longest = String::new();
    for ch in query.chars() {
        let mut class = ClassUnicode::new([ClassUnicodeRange::new(ch, ch)]);
        if !case_sensitive {
            class.case_fold_simple();
        }
        let mut equivalent = class
            .ranges()
            .iter()
            .flat_map(|range| range.start()..=range.end())
            .map(|scalar| {
                let source = scalar.to_string();
                let first = source.nfd().next().expect("nonempty decomposition");
                let boundary = canonical_combining_class(first) == 0
                    && matches!(is_nfc_quick(std::iter::once(first)), IsNormalized::Yes);
                let normalized: String = source.nfc().collect();
                // Unicode default lowercase has a context-dependent mapping for capital sigma.
                let folded = (!normalized.contains('Σ')).then(|| normalized.to_lowercase());
                (boundary, folded)
            });
        let (mut boundary, mut folded) = equivalent.next().expect("nonempty literal class");
        for (starts_segment, lowercase) in equivalent {
            boundary &= starts_segment;
            if folded != lowercase {
                folded = None;
            }
        }
        // A starter that cannot compose backwards closes the preceding normalization segment.
        if boundary && let Some(prefix) = previous.take() {
            run.push_str(&prefix);
        } else {
            if run.chars().count() > longest.chars().count() {
                std::mem::swap(&mut run, &mut longest);
            }
            run.clear();
        }
        previous = if boundary { folded } else { None };
    }
    if run.chars().count() > longest.chars().count() {
        longest = run;
    }
    // One short conjunction is enough to detect a sparse posting list.
    let prefix: String = longest.chars().take(8).collect();
    (!prefix.is_empty()).then(|| expression(&[prefix]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use regex::RegexBuilder;
    use rusqlite::{Connection, params};

    #[test]
    fn recall_grams_keep_literal_unicode_matches() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE VIRTUAL TABLE terms USING fts5(grams, tokenize='ascii')")
            .unwrap();
        for (query, body, case_sensitive) in [
            ("Kelvin", "a KELVIN reading", false),
            ("scope", "the ſcope", false),
            ("cafe", "cafe\u{301}", true),
            ("COFFEE", "coffee\u{301}", false),
            ("éclair", "éclair\u{301}", false),
            ("字里行间", "看看字里行间", false),
            ("ΣΟΣ", "A ΣΟΣ", true),
            ("ΟΣ", "ΟΣ", false),
            ("각도", "각도", false),
        ] {
            assert!(
                RegexBuilder::new(&regex::escape(query))
                    .case_insensitive(!case_sensitive)
                    .build()
                    .unwrap()
                    .is_match(body)
            );
            let Some(expression) = find_expression(query, case_sensitive) else {
                continue;
            };
            db.execute("DELETE FROM terms", []).unwrap();
            db.execute(
                "INSERT INTO terms(grams) VALUES(?)",
                [grams(&super::super::fold(body))],
            )
            .unwrap();
            let found: i64 = db
                .query_row(
                    "SELECT count(*) FROM terms WHERE terms MATCH ?",
                    params![expression],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(found, 1, "{query:?} in {body:?}");
        }
        assert!(find_expression("字里行间", false).is_some());
        assert!(find_expression("e", true).is_none());
    }
}
