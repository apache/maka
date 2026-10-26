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
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;

// The search dialog shows three lines in a column at most 760px wide with
// 12px text: about 120 Latin characters per line. Only the display preview is
// windowed; its anchor always opens the complete source, including long terms.
const DISPLAY_CHARACTERS: usize = 3 * 120;

fn check(stop: &CancellationToken) -> Result<(), String> {
    if stop.is_cancelled() {
        Err("Recall cancelled".into())
    } else {
        Ok(())
    }
}

// Poll with the history reader's 8 KiB source granularity, keeping cancellation
// checks out of each scalar's mutex path while allowing arbitrarily long input.
fn characters<'a>(text: &'a str, stop: &'a CancellationToken) -> impl Iterator<Item = char> + 'a {
    let mut next_check = 0;
    text.char_indices()
        .take_while(move |(at, _)| {
            if *at < next_check {
                return true;
            }
            next_check = at.saturating_add(8 * 1024);
            !stop.is_cancelled()
        })
        .map(|(_, ch)| ch)
}

pub(super) fn excerpt(
    text: &str,
    terms: &[String],
    stop: &CancellationToken,
) -> Result<(String, Vec<RecallHighlight>), String> {
    check(stop)?;
    let text: String = characters(text, stop).nfc().collect();
    check(stop)?;
    let folded = text.to_lowercase();
    check(stop)?;
    let mut folded_terms = Vec::with_capacity(terms.len());
    for term in terms {
        check(stop)?;
        let term = characters(term, stop)
            .nfc()
            .collect::<String>()
            .to_lowercase();
        if !term.is_empty() {
            folded_terms.push(term);
        }
    }
    let terms = folded_terms;
    let mut first = None;
    for term in &terms {
        check(stop)?;
        if let Some(at) = folded.find(term) {
            let candidate = (at, at + term.len());
            if first.is_none_or(|(start, end)| at < start || (at == start && candidate.1 > end)) {
                first = Some(candidate);
            }
        }
    }
    let mut start = 0;
    let mut end = DISPLAY_CHARACTERS;
    if let Some((match_start, match_end)) = first {
        let mut folded_offset = 0;
        let mut first_character = None;
        for (index, ch) in characters(&text, stop).enumerate() {
            let next = folded_offset + ch.to_lowercase().map(char::len_utf8).sum::<usize>();
            if first_character.is_none() && next > match_start {
                first_character = Some(index);
            }
            if folded_offset < match_end && next >= match_end {
                start = first_character.unwrap_or(index).saturating_sub(1);
                end = (start + DISPLAY_CHARACTERS).max(index + 1);
                break;
            }
            folded_offset = next;
        }
    }
    check(stop)?;
    let mut characters = characters(&text, stop).skip(start);
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
    for ch in self::characters(&shown, stop) {
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
        check(stop)?;
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
    check(stop)?;
    Ok((excerpt, highlights))
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
        let terms = ["😀", "CAFÉ", "i", "終点", "fé"].map(str::to_owned);
        let (text, ranges) = excerpt(&source, &terms, &CancellationToken::new()).unwrap();
        assert!(text.starts_with('…') && text.ends_with('…'));
        assert!(text.contains("😀 café İ 終点"));
        let utf16: Vec<_> = text.encode_utf16().collect();
        let matches: Vec<_> = ranges
            .into_iter()
            .map(|range| String::from_utf16(&utf16[range.start..range.end]).unwrap())
            .collect();
        assert_eq!(matches, ["😀", "café", "İ", "終点"]);
    }
}
