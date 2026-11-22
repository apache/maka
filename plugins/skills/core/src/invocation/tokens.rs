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

use crate::{SkillInvocationReceipt, fields};
use maka_agent_facts::input::InlineReference;
use maka_agent_facts::input::InlineReferenceKind;
use std::{collections::HashMap, ops::Range};

pub(super) struct Token<'a> {
    pub name: &'a str,
    pub range: Range<usize>,
}

/// The shared token grammar is ASCII, but its left boundary is JS whitespace.
/// Keep byte ranges internally; only the transcript projection uses UTF-16.
pub(super) fn scan(text: &str) -> Vec<Token<'_>> {
    text.match_indices("/skill:")
        .filter_map(|(start, _)| {
            if start > 0
                && !text[..start]
                    .chars()
                    .next_back()
                    .is_some_and(fields::whitespace)
            {
                return None;
            }
            let name_start = start + "/skill:".len();
            let length = text[name_start..]
                .bytes()
                .take_while(|c| c.is_ascii_alphanumeric() || b"._-".contains(c))
                .count();
            (length > 0).then(|| Token {
                name: &text[name_start..name_start + length],
                range: start..name_start + length,
            })
        })
        .collect()
}

pub(super) fn strip(text: &str) -> String {
    let mut lines = Vec::new();
    for line in text.split('\n') {
        let tokens = scan(line);
        if tokens.is_empty() {
            lines.push(line.to_owned());
            continue;
        }
        let mut stripped = String::new();
        let mut position = 0;
        for token in tokens {
            stripped.push_str(&line[position..token.range.start]);
            position = token.range.end;
        }
        stripped.push_str(&line[position..]);
        let mut previous_space = false;
        let tidied: String = stripped
            .chars()
            .filter_map(|c| {
                let space = matches!(c, ' ' | '\t');
                let keep = !space || !previous_space;
                previous_space = space;
                keep.then_some(if space { ' ' } else { c })
            })
            .collect();
        let tidied = tidied.trim_matches(fields::whitespace);
        if !tidied.is_empty() {
            lines.push(tidied.to_owned());
        }
    }
    lines.join("\n")
}

/// Freeze only successful explicit tokens; offsets belong to the original
/// display text, never the instruction-expanded provider text.
pub fn inline_references(
    receipts: &[SkillInvocationReceipt],
    display_text: &str,
) -> Vec<InlineReference> {
    let mut by_name = HashMap::new();
    for receipt in receipts {
        if let SkillInvocationReceipt::Loaded(receipt) = receipt
            && receipt.invocation == crate::SkillInvocationMode::Explicit
        {
            by_name.insert(receipt.request.to_lowercase(), receipt);
            by_name.insert(receipt.id.to_lowercase(), receipt);
        }
    }
    scan(display_text)
        .into_iter()
        .filter_map(|token| {
            let receipt = by_name.get(&token.name.to_lowercase())?;
            let mut units = 0;
            let label = receipt
                .name
                .chars()
                .take_while(|c| {
                    units += c.len_utf16();
                    units <= 200
                })
                .collect();
            Some(InlineReference {
                kind: InlineReferenceKind::Skill,
                value: display_text[token.range.clone()].to_owned(),
                label,
                start: display_text[..token.range.start].encode_utf16().count() as u64,
            })
        })
        .collect()
}
