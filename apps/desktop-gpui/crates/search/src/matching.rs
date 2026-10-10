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

//! Where a query occurs in a text: plain substring matching, with case
//! folding and whole-word boundaries, and the fuzzy match of names (task
//! titles, commands). Pure, so a searchable item can run it on a background
//! thread over text it extracted for searching.

use std::ops::Range;

use crate::SearchQuery;

/// Whether `c` belongs to a word, for Match whole word: letters and digits
/// of every script, and `_`.
pub fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Whether `c` is a word of its own, never joined to a neighbour: a Han
/// ideograph or a hiragana, as Unicode's default word boundaries (UAX #29)
/// treat them. Chinese and Japanese put no spaces between words, so a run
/// of them is not one word: "测试" is a whole word in "运行测试通过", while a
/// Latin word beside Chinese still needs its own end ("API" is whole in
/// "API接口", not in "APIs"). Katakana and Hangul join as letters do.
fn stands_alone(c: char) -> bool {
    matches!(c,
        '\u{3005}' | '\u{3007}' // 々 and 〇
        | '\u{3040}'..='\u{309F}' // hiragana
        | '\u{3400}'..='\u{4DBF}' // extension A
        | '\u{4E00}'..='\u{9FFF}' // unified ideographs
        | '\u{F900}'..='\u{FAFF}' // compatibility ideographs
        | '\u{20000}'..='\u{323AF}' // extensions B to H, compatibility supplement
    )
}

/// The byte ranges of `query`'s occurrences in `text`, in order and never
/// overlapping. Each range starts and ends on a character boundary of
/// `text`. Without Match case, letters are compared by their lowercase
/// forms; a match then covers whole characters of `text` even where a
/// character folds to more than one.
pub fn find_ranges(text: &str, query: &SearchQuery) -> Vec<Range<usize>> {
    find_ranges_in_cut(text, None, query)
}

/// [`find_ranges`] in `text` cut from a longer text that went on with
/// `next`: a word the cut splits is not whole at the cut ("test" in a
/// summary cut after "test" from "testing").
pub fn find_ranges_in_cut(
    text: &str,
    next: Option<char>,
    query: &SearchQuery,
) -> Vec<Range<usize>> {
    if query.is_empty() || text.is_empty() {
        return Vec::new();
    }
    let whole_word = query.options().is_whole_word();
    if query.options().is_case_sensitive() {
        return occurrences(
            text,
            query.text(),
            |range| range,
            |range| !whole_word || is_whole_word(text, range, next),
        );
    }
    let folded = Folded::new(text);
    let needle = fold(query.text());
    occurrences(
        &folded.text,
        &needle,
        |range| folded.original(range),
        |range| !whole_word || is_whole_word(text, range, next),
    )
}

/// Every occurrence of `needle` in `haystack`, mapped to the text searched
/// by `map` and kept when `keep` accepts it. A rejected occurrence lets
/// the next one start inside it.
fn occurrences(
    haystack: &str,
    needle: &str,
    map: impl Fn(Range<usize>) -> Range<usize>,
    keep: impl Fn(Range<usize>) -> bool,
) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut from = 0;
    while let Some(at) = haystack[from..].find(needle) {
        let start = from + at;
        let end = start + needle.len();
        let range = map(start..end);
        if keep(range.clone()) {
            ranges.push(range);
            from = end;
        } else {
            from = start + haystack[start..].chars().next().map_or(1, char::len_utf8);
        }
    }
    ranges
}

/// Whether neither end of `range` in `text` joins a word character inside
/// it to one outside it. `next` stands for the character after the end of
/// `text` when `text` was cut from a longer one.
fn is_whole_word(text: &str, range: Range<usize>, next: Option<char>) -> bool {
    let joined = |outside: Option<char>, inside: Option<char>| {
        matches!((outside, inside), (Some(outside), Some(inside))
            if is_word_char(outside) && is_word_char(inside)
                && !stands_alone(outside) && !stands_alone(inside))
    };
    let before = text[..range.start].chars().next_back();
    let first = text[range.start..range.end].chars().next();
    let last = text[range.start..range.end].chars().next_back();
    let after = text[range.end..].chars().next().or(next);
    !joined(before, first) && !joined(after, last)
}

fn fold(text: &str) -> String {
    text.chars().flat_map(char::to_lowercase).collect()
}

/// A text in lowercase, with the offset in the original text of the
/// character each folded byte came from.
struct Folded<'a> {
    original: &'a str,
    text: String,
    /// For each byte of `text`, where its character starts in `original`.
    starts: Vec<u32>,
}

impl<'a> Folded<'a> {
    fn new(original: &'a str) -> Self {
        let mut text = String::with_capacity(original.len());
        let mut starts = Vec::with_capacity(original.len());
        for (at, c) in original.char_indices() {
            for lower in c.to_lowercase() {
                text.push(lower);
                starts.extend(std::iter::repeat_n(at as u32, lower.len_utf8()));
            }
        }
        Self { original, text, starts }
    }

    /// The range of the original text a range of the folded text came
    /// from, widened to whole characters.
    fn original(&self, range: Range<usize>) -> Range<usize> {
        let start = self.starts[range.start] as usize;
        let last = self.starts[range.end - 1] as usize;
        let end = last + self.original[last..].chars().next().map_or(0, char::len_utf8);
        start..end
    }
}

/// A fuzzy match of `query` in `text`, ignoring case and the query's
/// spaces, as the command palette and the Search page's task titles use it: every query character must appear in order. Higher is better:
/// each match scores, more when it continues the previous one, starts a
/// word, or starts the text; each skipped character costs a little. `None`
/// when a character is missing.
pub fn fuzzy_score(query: &str, text: &str) -> Option<i32> {
    let text: Vec<char> = text.chars().flat_map(char::to_lowercase).collect();
    let mut score = 0;
    let mut position = 0;
    let mut previous: Option<usize> = None;
    for wanted in query.chars().filter(|c| !c.is_whitespace()).flat_map(char::to_lowercase) {
        let found = (position..text.len()).find(|&ix| text[ix] == wanted)?;
        score += 10;
        if previous.is_some_and(|previous| previous + 1 == found) {
            score += 15;
        }
        let word_start = found == 0 || !text[found - 1].is_alphanumeric();
        if found == 0 {
            score += 20;
        } else if word_start {
            score += 12;
        }
        score -= (found - position).min(10) as i32;
        previous = Some(found);
        position = found + 1;
    }
    Some(score)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::SearchOptions;

    fn find(text: &str, query: &str, options: SearchOptions) -> Vec<String> {
        let query = SearchQuery::new(query, options);
        find_ranges(text, &query).into_iter().map(|range| text[range].to_owned()).collect()
    }

    fn any_case() -> SearchOptions {
        SearchOptions::new()
    }

    #[test]
    fn a_query_matches_in_any_case_unless_case_is_matched() {
        let text = "Hello HELLO hello hElLo";
        assert_eq!(find(text, "hello", any_case()), ["Hello", "HELLO", "hello", "hElLo"]);
        assert_eq!(find(text, "hello", any_case().case_sensitive(true)), ["hello"]);
        assert_eq!(find(text, "HELLO", any_case().case_sensitive(true)), ["HELLO"]);
        assert_eq!(find("ПРИВЕТ мир", "привет", any_case()), ["ПРИВЕТ"]);
    }

    #[test]
    fn matches_do_not_overlap_and_keep_their_byte_ranges() {
        let query = SearchQuery::new("aa", any_case());
        assert_eq!(find_ranges("aaaaa", &query), [0..2, 2..4]);
        let query = SearchQuery::new("é", any_case());
        assert_eq!(find_ranges("café CAFÉ", &query), [3..5, 9..11]);
    }

    #[test]
    fn a_whole_word_stands_alone() {
        let whole = any_case().whole_word(true);
        assert_eq!(find("test testing contest test_case test.", "test", whole), ["test", "test"]);
        assert_eq!(find("testing", "test", any_case()), ["test"], "inside words without it");
        // A rejected occurrence does not hide one that starts inside it.
        assert_eq!(find("aa a", "a", whole), ["a"]);
    }

    #[test]
    fn each_chinese_character_is_a_word() {
        let whole = any_case().whole_word(true);
        assert_eq!(
            find("运行测试通过", "测试", whole),
            ["测试"],
            "a run of Chinese is not one word"
        );
        assert_eq!(find("销售毛利率", "毛利", whole), ["毛利"]);
        assert_eq!(find("测试。再测试", "测试", whole), ["测试", "测试"]);
        assert_eq!(find("API接口 APIs", "api", whole), ["API"], "a Latin word still needs its end");
        assert_eq!(find("ひらがなテスト", "テスト", whole), ["テスト"], "hiragana stands alone");
        assert!(find("テストケース", "テスト", whole).is_empty(), "katakana joins");
    }

    #[test]
    fn a_cut_does_not_end_the_word_it_splits() {
        let whole = any_case().whole_word(true);
        let query = SearchQuery::new("test", whole);
        assert!(find_ranges_in_cut("run test", Some('i'), &query).is_empty(), "cut from testing");
        assert_eq!(find_ranges_in_cut("run test", Some(' '), &query), vec![4..8]);
        assert_eq!(find_ranges_in_cut("run test", None, &query), vec![4..8]);
        let query = SearchQuery::new("毛利", whole);
        assert_eq!(find_ranges_in_cut("净利润、毛利", Some('率'), &query), vec![12..18]);
    }

    #[test]
    fn a_letter_that_folds_to_two_covers_its_whole_character() {
        // İ lowercases to i and a combining dot.
        let query = SearchQuery::new("i", any_case());
        assert_eq!(find_ranges("İx", &query), vec![0..2]);
    }

    #[test]
    fn nothing_matches_an_empty_query_or_text() {
        assert!(find("text", "", any_case()).is_empty());
        assert!(find("", "text", any_case()).is_empty());
    }

    #[test]
    fn a_fuzzy_match_needs_every_character_in_order() {
        assert!(fuzzy_score("tgsb", "Toggle sidebar").is_some());
        assert!(fuzzy_score("sidebar", "Toggle sidebar").is_some());
        assert!(fuzzy_score("bs", "Toggle sidebar").is_none(), "out of order");
        assert!(fuzzy_score("xyz", "Toggle sidebar").is_none());
        assert!(fuzzy_score("任务", "新任务").is_some());
        assert_eq!(fuzzy_score("", "anything"), Some(0));
    }

    #[test]
    fn prefixes_and_word_starts_beat_scattered_matches() {
        let score = |query, text| fuzzy_score(query, text).expect("match");
        assert!(score("new", "New task") > score("new", "Renew the key"));
        assert!(score("st", "Stop turn") > score("st", "Toggle sidebar list"));
        assert!(score("dark", "Dark") > score("dark", "Dim background, dark mode"));
    }
}
