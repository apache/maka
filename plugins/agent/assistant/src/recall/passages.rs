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

use super::search::{Content, History};
use super::{
    rank::{Hit, Source, excluded},
    reader::{Reader, failed},
    types::{Passage, PassageMessage},
};
use maka_agent_facts::tools::ToolError;
use maka_agent_ports::session::history::Chunk;
use maka_capabilities::call::Scope;
use std::sync::Arc;
use unicode_normalization::UnicodeNormalization;

pub(super) async fn build(
    history: Arc<dyn History>,
    call: &Scope,
    sources: &[Source],
    hits: &[Hit],
    terms: &[String],
    content: Content,
) -> Result<Vec<Passage>, ToolError> {
    let span = match content {
        Content::Anchor => (0, 0),
        Content::Context { before, after } => (before, after),
    };
    let mut passages: Vec<_> = hits
        .iter()
        .map(|hit| Passage {
            session_id: sources[hit.session].summary.id.clone(),
            session_title: sources[hit.session].summary.title.clone(),
            anchor_message_id: hit.message_id.clone(),
            anchor_position: hit.row_position,
            turn_id: hit.turn_id.clone(),
            messages: Vec::new(),
            matched_terms: terms
                .iter()
                .zip(&hit.frequencies)
                .filter_map(|(term, count)| (*count > 0).then_some(term.clone()))
                .collect(),
            score: hit.score,
            has_more_before: false,
            has_more_after: false,
            truncated: false,
        })
        .collect();
    let mut by_session = vec![Vec::new(); sources.len()];
    for (index, hit) in hits.iter().enumerate() {
        by_session[hit.session].push((index, hit));
    }
    for (session, source) in sources.iter().enumerate() {
        let wanted = &mut by_session[session];
        if wanted.is_empty() {
            continue;
        }
        wanted.sort_by_key(|(_, hit)| hit.position);
        let mut reader = Reader::new(
            history.clone(),
            call.clone(),
            source.summary.id.clone(),
            source.through,
        );
        let mut position = 0;
        let mut start = 0;
        let mut end = 0;
        let mut first = None;
        let mut last = None;
        while let Some(message) = reader.next().await? {
            let ordinal = position;
            position += 1;
            if excluded(call, &source.summary.id, &message) {
                continue;
            }
            first.get_or_insert(ordinal);
            last = Some(ordinal);
            while start < wanted.len() && wanted[start].1.position.saturating_add(span.1) < ordinal
            {
                start += 1;
            }
            end = end.max(start);
            while end < wanted.len() && wanted[end].1.position.saturating_sub(span.0) <= ordinal {
                end += 1;
            }
            let mut targets = Vec::new();
            for &(index, hit) in &wanted[start..end] {
                let anchor = ordinal == hit.position;
                targets.push((index, anchor, if anchor { hit.offset } else { 0 }));
            }
            if targets.is_empty() {
                continue;
            }
            let excerpts = tokio::task::spawn_blocking(move || {
                let text: String = match content {
                    Content::Anchor => message.text.clone(),
                    Content::Context { .. } => message.text.nfc().collect(),
                };
                targets
                    .into_iter()
                    .map(|(index, anchor, offset)| {
                        let excerpt = match content {
                            Content::Anchor => PassageMessage {
                                message_id: message.message_id.clone(),
                                role: message.role,
                                text: text.clone(),
                                timestamp: message.timestamp,
                                is_anchor: anchor,
                                offset: 0,
                                next_offset: None,
                                attachments: message.attachments.clone(),
                            },
                            Content::Context { .. } => excerpt(&message, &text, anchor, offset),
                        };
                        (index, excerpt)
                    })
                    .collect::<Vec<_>>()
            })
            .await
            .map_err(failed)?;
            for (index, excerpt) in excerpts {
                passages[index].messages.push(excerpt);
            }
            if matches!(content, Content::Anchor) && end == wanted.len() {
                break;
            }
        }
        if matches!(content, Content::Context { .. }) {
            for &(index, hit) in wanted.iter() {
                passages[index].has_more_before =
                    first.is_some_and(|position| position < hit.position.saturating_sub(span.0));
                passages[index].has_more_after =
                    last.is_some_and(|position| position > hit.position.saturating_add(span.1));
            }
        }
    }
    for passage in &mut passages {
        if !passage.messages.iter().any(|message| message.is_anchor) {
            return Err(failed("Recall anchor is no longer readable"));
        }
        if matches!(content, Content::Anchor) {
            continue;
        }
        // Keep the anchor first in the byte allocation, then nearest neighbors.
        let anchor = passage
            .messages
            .iter()
            .position(|message| message.is_anchor)
            .unwrap();
        let mut order: Vec<_> = (0..passage.messages.len()).collect();
        order.sort_by_key(|index| index.abs_diff(anchor));
        let mut budget = 12 * 1024;
        let mut keep = std::collections::BTreeSet::new();
        for index in order {
            let size = passage.messages[index].text.len()
                + 256
                + passage.messages[index]
                    .attachments
                    .iter()
                    .map(|a| a.text_bytes() + 128)
                    .sum::<usize>();
            if index == anchor || size <= budget {
                keep.insert(index);
                budget = budget.saturating_sub(size);
            } else {
                passage.truncated = true;
                if index < anchor {
                    passage.has_more_before = true;
                } else {
                    passage.has_more_after = true;
                }
            }
        }
        let mut index = 0;
        passage.messages.retain(|_| {
            let retain = keep.contains(&index);
            index += 1;
            retain
        });
        passage.truncated |= passage
            .messages
            .iter()
            .any(|message| message.offset > 0 || message.next_offset.is_some());
    }
    Ok(passages)
}
fn excerpt(message: &Chunk, text: &str, anchor: bool, requested: usize) -> PassageMessage {
    let offset = text.floor_char_boundary(requested.min(text.len()));
    let end = text.floor_char_boundary(offset.saturating_add(4 * 1024).min(text.len()));
    PassageMessage {
        message_id: message.message_id.clone(),
        role: message.role,
        text: text[offset..end].into(),
        timestamp: message.timestamp,
        is_anchor: anchor,
        offset,
        next_offset: (end < text.len()).then_some(end),
        attachments: message.attachments.clone(),
    }
}
