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

use crate::contract::RecallHighlight;
use unicode_normalization::UnicodeNormalization;

// The search dialog shows three lines in a column at most 760px wide with
// 12px text: about 120 Latin characters per line. Only the display preview is
// windowed; its anchor always opens the complete source, including long terms.
const DISPLAY_CHARACTERS: usize = 3 * 120;

pub(super) fn excerpt(text: &str, terms: &[String]) -> (String, Vec<RecallHighlight>) {
    let text: String = text.nfc().collect();
    let folded = text.to_lowercase();
    let terms: Vec<String> = terms
        .iter()
        .map(|term| term.nfc().collect::<String>().to_lowercase())
        .filter(|term| !term.is_empty())
        .collect();
    let first = terms
        .iter()
        .filter_map(|term| folded.find(term).map(|at| (at, at + term.len())))
        .min_by_key(|(start, end)| (*start, std::cmp::Reverse(*end)));
    let mut start = 0;
    let mut end = DISPLAY_CHARACTERS;
    if let Some((match_start, match_end)) = first {
        let mut folded_offset = 0;
        let mut first_character = None;
        for (index, ch) in text.chars().enumerate() {
            let next = folded_offset + ch.to_lowercase().map(char::len_utf8).sum::<usize>();
            if first_character.is_none() && next > match_start {
                first_character = Some(index);
            }
            if folded_offset < match_end && next >= match_end {
                start = first_character
                    .unwrap_or(index)
                    .saturating_sub(DISPLAY_CHARACTERS / 4);
                end = (start + DISPLAY_CHARACTERS).max(index + 1);
                break;
            }
            folded_offset = next;
        }
    }
    let mut characters = text.chars().skip(start);
    let shown: String = characters.by_ref().take(end - start).collect();
    let suffix = characters.next().is_some();
    let prefix = usize::from(start > 0);
    let mut excerpt = String::new();
    if prefix != 0 {
        excerpt.push('…');
    }
    excerpt.extend(
        shown
            .chars()
            .map(|ch| if ch.is_whitespace() { ' ' } else { ch }),
    );
    if suffix {
        excerpt.push('…');
    }

    // Lowercasing can expand a scalar; map matches back to the displayed
    // UTF-16 boundaries instead of applying folded byte offsets to JS text.
    let mut units = Vec::new();
    let mut folded_offset = 0;
    let mut display_offset = prefix;
    for ch in shown.chars() {
        let next_folded = folded_offset + ch.to_lowercase().map(char::len_utf8).sum::<usize>();
        let next_display = display_offset
            + if ch.is_whitespace() {
                1
            } else {
                ch.len_utf16()
            };
        units.push((folded_offset, next_folded, display_offset, next_display));
        folded_offset = next_folded;
        display_offset = next_display;
    }
    let folded = shown.to_lowercase();
    let mut ranges = Vec::new();
    for term in terms {
        for (at, _) in folded.match_indices(&term) {
            let first = units.partition_point(|unit| unit.1 <= at);
            let after = units.partition_point(|unit| unit.0 < at + term.len());
            if first < after {
                ranges.push((units[first].2, units[after - 1].3));
            }
        }
    }
    ranges.sort_unstable();
    let mut highlights: Vec<RecallHighlight> = Vec::new();
    for (start, end) in ranges {
        if let Some(last) = highlights.last_mut()
            && start <= last.end
        {
            last.end = last.end.max(end);
        } else {
            highlights.push(RecallHighlight { start, end });
        }
    }
    (excerpt, highlights)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_unicode_sources_preview_the_match_with_native_utf16_highlights() {
        let source = format!(
            "{}😀 cafe\u{301}\nİ 終点 {}",
            "old ".repeat(200),
            "later ".repeat(200)
        );
        let terms = ["CAFÉ", "i", "終点", "fé"].map(str::to_owned);
        let (text, ranges) = excerpt(&source, &terms);
        assert!(text.starts_with('…') && text.ends_with('…'));
        assert!(text.contains("😀 café İ 終点"));
        let utf16: Vec<_> = text.encode_utf16().collect();
        let matches: Vec<_> = ranges
            .into_iter()
            .map(|range| String::from_utf16(&utf16[range.start..range.end]).unwrap())
            .collect();
        assert_eq!(matches, ["café", "İ", "終点"]);
    }
}
