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
// 12px text: about 120 Latin characters per line.
const DISPLAY_CHARACTERS: usize = 3 * 120;
const TOOL_CHARACTERS: usize = 720;

pub(super) fn tool_passages(
    mut results: maka_assistant::recall::search::ResultSet,
    stop: &CancellationToken,
) -> Result<maka_assistant::recall::search::ResultSet, String> {
    for passage in &mut results.passages {
        for message in &mut passage.messages {
            check(stop)?;
            let Some((end, _)) = message.text.char_indices().nth(TOOL_CHARACTERS) else {
                continue;
            };
            if message.is_anchor && !passage.matched_terms.is_empty() {
                message.text = excerpt_with_limit(
                    &message.text,
                    &passage.matched_terms,
                    TOOL_CHARACTERS,
                    false,
                    stop,
                )?
                .0;
            } else {
                message.text.truncate(end);
                message.text.push('…');
            }
        }
    }
    Ok(results)
}

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
    excerpt_with_limit(text, terms, DISPLAY_CHARACTERS, true, stop)
}

fn excerpt_with_limit(
    text: &str,
    terms: &[String],
    limit: usize,
    single_line: bool,
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
    let mut match_start = None;
    for term in &terms {
        check(stop)?;
        if let Some(at) = folded.find(term) {
            match_start = Some(match_start.map_or(at, |first: usize| first.min(at)));
        }
    }
    let mut start = 0;
    if let Some(match_start) = match_start {
        let mut folded_offset = 0;
        for (index, ch) in characters(&text, stop).enumerate() {
            let next = folded_offset + ch.to_lowercase().map(char::len_utf8).sum::<usize>();
            if next > match_start {
                start = index.saturating_sub(1);
                break;
            }
            folded_offset = next;
        }
    }
    check(stop)?;
    let mut characters = characters(&text, stop).skip(start);
    let shown: String = characters.by_ref().take(limit).collect();
    let suffix = characters.next().is_some();
    let prefix = usize::from(start > 0);
    let mut excerpt = String::new();
    if prefix != 0 {
        excerpt.push('…');
    }
    excerpt.extend(shown.chars().map(|ch| {
        if single_line && ch.is_whitespace() {
            ' '
        } else {
            ch
        }
    }));
    if suffix {
        excerpt.push('…');
    }
    if !single_line {
        check(stop)?;
        return Ok((excerpt, Vec::new()));
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

    #[test]
    fn recall_emits_a_hit_excerpt_and_retains_its_original_row_address() {
        use maka_agent_facts::{durable::FactId, history::HistoryRowAddress};
        use maka_agent_ports::session::history::Role;
        use maka_assistant::recall::search::{Passage, PassageMessage, ResultSet};

        let anchor_position = HistoryRowAddress::Live {
            sequence: 42,
            fact: FactId::new(),
            item_index: 0,
        };
        let text = format!("{}匹配位置\n{}", "旧正文".repeat(300), "尾部".repeat(800));
        let result = tool_passages(
            ResultSet {
                facts: vec![],
                next_facts_after: None,
                passages: vec![Passage {
                    session_id: "session".into(),
                    session_title: "Search fixture".into(),
                    anchor_message_id: "anchor".into(),
                    anchor_position: anchor_position.clone(),
                    through: 45,
                    turn_id: "turn".into(),
                    messages: vec![PassageMessage {
                        message_id: "anchor".into(),
                        role: Role::ToolResult,
                        text,
                        timestamp: 0,
                        is_anchor: true,
                        attachments: vec![],
                    }],
                    matched_terms: vec!["匹配位置".into()],
                    score: 1.,
                    has_more_before: false,
                    has_more_after: false,
                }],
                searched_every_session: true,
                gaps: vec![],
            },
            &CancellationToken::new(),
        )
        .unwrap();
        let passage = &result.passages[0];
        assert_eq!(
            passage.messages[0].text,
            format!("…文匹配位置\n{}…", "尾部".repeat(357))
        );
        let rendered = result.render();
        let original = rendered
            .lines()
            .find_map(|line| line.strip_prefix("Original: SessionRead("))
            .unwrap()
            .strip_suffix(')')
            .unwrap();
        let read: maka_agent_api::contract::SessionReadInput =
            serde_json::from_str(original).unwrap();
        let row = read.row.expect("exact row lookup");
        assert_eq!(row.through, Some(45));
        assert_eq!(row.position, anchor_position);
        assert_eq!(
            row.field,
            maka_agent_ports::session::history::HistoryField::Body
        );
    }
}
