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

use super::{
    reader::{Reader, failed, sessions},
    search::{History, Session},
    types::{Query, fold},
};
use maka_agent_facts::tools::ToolError;
use maka_agent_ports::session::history::Chunk;
use maka_agent_ports::session::history::Role;
use maka_capabilities::call::Scope;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

pub(super) struct Source {
    pub summary: Session,
    pub through: Option<u64>,
}
#[derive(Clone)]
pub(super) struct Hit {
    pub session: usize,
    pub position: usize,
    pub row_position: maka_agent_ports::session::history::RowPosition,
    pub message_id: String,
    pub turn_id: String,
    pub timestamp: u64,
    pub role: Role,
    pub length: usize,
    pub frequencies: Vec<usize>,
    pub offset: usize,
    pub score: f64,
}
pub(super) struct Scan {
    pub sources: Vec<Source>,
    pub hits: Vec<Hit>,
    pub complete: bool,
    pub gaps: Vec<String>,
}
pub(super) async fn search(
    history: Arc<dyn History>,
    call: &Scope,
    query: &Query,
) -> Result<Scan, ToolError> {
    let (catalog, complete) = sessions(history.as_ref(), call, query.session_id.as_deref()).await?;
    let mut scan = Scan {
        sources: Vec::new(),
        hits: Vec::new(),
        complete,
        gaps: Vec::new(),
    };
    if catalog.is_empty() {
        scan.gaps
            .push("No matching Session exists in the readable catalog.".into());
    }
    let terms = Arc::new(
        query
            .terms
            .iter()
            .map(|term| fold(term))
            .collect::<Vec<_>>(),
    );
    // First collect corpus statistics under frozen per-source fences. The second
    // pass ranks against those same originals while retaining only the requested
    // number of distinct turns per Session, rather than every matching message.
    let mut corpus = 0usize;
    let mut matched = 0usize;
    let mut total_length = 0.0;
    let mut document_frequencies = vec![0; terms.len()];
    for summary in catalog {
        let session = scan.sources.len();
        let mut reader = Reader::new(history.clone(), call.clone(), summary.id.clone(), None);
        let mut position = 0;
        let mut local_corpus = 0usize;
        let mut local_matched = 0usize;
        let mut local_length = 0.0;
        let mut local_frequencies = vec![0; terms.len()];
        let valid = loop {
            let message = match reader.next().await {
                Ok(Some(message)) => message,
                Ok(None) => break true,
                Err(error) => {
                    if call.cancellation.is_cancelled() {
                        return Err(error);
                    }
                    scan.complete = false;
                    scan.gaps.push(format!(
                        "Session {} was not fully read: {error}",
                        summary.id
                    ));
                    break false;
                }
            };
            let ordinal = position;
            position += 1;
            local_corpus += 1;
            if !included(call, query, &summary.id, &message) {
                continue;
            }
            let terms = terms.clone();
            let hit =
                tokio::task::spawn_blocking(move || inspect(session, ordinal, message, &terms))
                    .await
                    .map_err(failed)?;
            if let Some(hit) = hit {
                local_matched += 1;
                local_length += hit.length as f64;
                for (count, frequency) in local_frequencies.iter_mut().zip(hit.frequencies) {
                    *count += usize::from(frequency > 0);
                }
            }
        };
        if valid {
            corpus += local_corpus;
            matched += local_matched;
            total_length += local_length;
            for (count, local) in document_frequencies.iter_mut().zip(local_frequencies) {
                *count += local;
            }
            scan.sources.push(Source {
                summary,
                through: reader.through(),
            });
        }
    }
    let average = (total_length / matched.max(1) as f64).max(1.0);
    let idf: Vec<_> = document_frequencies
        .into_iter()
        .map(|df| ((corpus.max(matched) as f64 - df as f64 + 0.5) / (df as f64 + 0.5) + 1.0).ln())
        .collect();
    let limit = query.limit;
    for (session, source) in scan.sources.iter().enumerate() {
        let mut reader = Reader::new(
            history.clone(),
            call.clone(),
            source.summary.id.clone(),
            source.through,
        );
        let mut candidates: BTreeMap<String, Hit> = BTreeMap::new();
        let mut position = 0;
        let valid = loop {
            let message = match reader.next().await {
                Ok(Some(message)) => message,
                Ok(None) => break true,
                Err(error) => {
                    if call.cancellation.is_cancelled() {
                        return Err(error);
                    }
                    scan.complete = false;
                    scan.gaps.push(format!(
                        "Session {} was not fully read: {error}",
                        source.summary.id
                    ));
                    break false;
                }
            };
            let ordinal = position;
            position += 1;
            if !included(call, query, &source.summary.id, &message) {
                continue;
            }
            let terms = terms.clone();
            if let Some(mut hit) =
                tokio::task::spawn_blocking(move || inspect(session, ordinal, message, &terms))
                    .await
                    .map_err(failed)?
            {
                score_hit(&mut hit, average, &idf);
                if let Some(candidate) = candidates.get_mut(&hit.turn_id) {
                    if compare(&hit, candidate).is_lt() {
                        *candidate = hit;
                    }
                } else {
                    candidates.insert(hit.turn_id.clone(), hit);
                }
                if let Some(limit) = limit
                    && candidates.len() > limit
                {
                    let worst = candidates
                        .iter()
                        .max_by(|left, right| compare(left.1, right.1))
                        .map(|(turn, _)| turn.clone())
                        .expect("nonempty candidates");
                    candidates.remove(&worst);
                }
            }
        };
        if valid {
            scan.hits.extend(candidates.into_values());
        }
    }
    scan.hits = select(scan.hits, limit);
    Ok(scan)
}
pub(super) fn excluded(call: &Scope, session: &str, message: &Chunk) -> bool {
    call.identity.agent().is_some_and(|invocation| {
        invocation.session_id == session && invocation.turn_id == message.turn_id
    })
}

fn inspect(session: usize, position: usize, message: Chunk, terms: &[String]) -> Option<Hit> {
    use unicode_normalization::UnicodeNormalization;
    let text: String = message.text.nfc().collect();
    let folded = text.to_lowercase();
    let frequencies: Vec<_> = terms
        .iter()
        .map(|term| folded.matches(term).count())
        .collect();
    if frequencies.iter().all(|count| *count == 0) {
        return None;
    }
    let first = terms
        .iter()
        .filter_map(|term| folded.find(term))
        .min()
        .unwrap();
    // Lowercasing can expand a Unicode scalar. Map its position back into the
    // NFC display text rather than slicing the original at a folded byte offset.
    let mut folded_offset = 0;
    let mut offset = 0;
    for (index, ch) in text.char_indices() {
        folded_offset += ch.to_lowercase().map(char::len_utf8).sum::<usize>();
        if first < folded_offset {
            offset = index;
            break;
        }
    }
    Some(Hit {
        session,
        position,
        row_position: message.position,
        message_id: message.message_id,
        turn_id: message.turn_id,
        timestamp: message.timestamp,
        role: message.role,
        length: folded.chars().count(),
        frequencies,
        offset,
        score: 0.0,
    })
}
fn included(call: &Scope, query: &Query, session: &str, message: &Chunk) -> bool {
    !excluded(call, session, message)
        && !query.since.is_some_and(|value| message.timestamp < value)
        && !query.until.is_some_and(|value| message.timestamp > value)
}

fn score_hit(hit: &mut Hit, average: f64, idf: &[f64]) {
    hit.score = hit
        .frequencies
        .iter()
        .zip(idf)
        .map(|(frequency, weight)| {
            let f = *frequency as f64;
            weight * f * 2.2 / (f + 1.2 * (0.25 + 0.75 * hit.length as f64 / average))
        })
        .sum::<f64>()
        * if hit.role == Role::ToolResult {
            0.5
        } else {
            1.0
        };
}

fn compare(a: &Hit, b: &Hit) -> std::cmp::Ordering {
    b.score
        .total_cmp(&a.score)
        .then_with(|| b.timestamp.cmp(&a.timestamp))
        .then_with(|| a.message_id.cmp(&b.message_id))
}

#[cfg(test)]
fn score(hits: &mut [Hit], terms: usize, corpus: usize) {
    if hits.is_empty() {
        return;
    }
    let average =
        (hits.iter().map(|hit| hit.length as f64).sum::<f64>() / hits.len() as f64).max(1.0);
    let idf: Vec<_> = (0..terms)
        .map(|term| {
            let df = hits.iter().filter(|hit| hit.frequencies[term] > 0).count() as f64;
            ((corpus.max(hits.len()) as f64 - df + 0.5) / (df + 0.5) + 1.0).ln()
        })
        .collect();
    for hit in hits {
        score_hit(hit, average, &idf);
    }
}
fn select(mut hits: Vec<Hit>, limit: Option<usize>) -> Vec<Hit> {
    hits.sort_by(compare);
    let Some(limit) = limit else { return hits };
    let mut selected = BTreeSet::new();
    let mut turns = BTreeSet::new();
    let mut by_session = BTreeMap::<usize, usize>::new();
    for quota in [Some((limit / 3).max(1)), None] {
        for (index, hit) in hits.iter().enumerate() {
            if selected.len() == limit {
                break;
            }
            if quota.is_some_and(|max| by_session.get(&hit.session).copied().unwrap_or(0) >= max)
                || !turns.insert((hit.session, hit.turn_id.clone()))
            {
                continue;
            }
            selected.insert(index);
            *by_session.entry(hit.session).or_default() += 1;
        }
    }
    hits.into_iter()
        .enumerate()
        .filter_map(|(index, hit)| selected.contains(&index).then_some(hit))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranking_preserves_unicode_anchors_and_diversifies_without_duplicate_turns() {
        let hit = |session, id: &str, turn: &str, role, text: &str, term: &str| {
            inspect(
                session,
                0,
                Chunk {
                    final_output: false,
                    model: None,
                    origin: None,
                    field: Default::default(),
                    message_id: id.into(),
                    turn_id: turn.into(),
                    timestamp: 1,
                    timing: None,
                    compaction: None,
                    role,
                    position: maka_agent_ports::session::history::RowPosition {
                        source_sequence: 1,
                        item_index: 0,
                    },
                    offset: 0,
                    total_bytes: text.len() as u64,
                    text: text.into(),
                    tool: None,
                    attachments: vec![],
                },
                &[term.into()],
            )
            .unwrap()
        };
        // U+0130 lowercases to two scalars; a match inside the expansion
        // must still anchor the original character, not the following one.
        let unicode = hit(
            0,
            "unicode",
            "u",
            Role::Assistant,
            "prefix İ end",
            "\u{307}",
        );
        assert_eq!(unicode.offset, "prefix ".len());
        let mut hits = vec![
            hit(0, "a", "one", Role::Assistant, "needle", "needle"),
            hit(0, "b", "one", Role::ToolResult, "needle", "needle"),
            hit(0, "c", "two", Role::Assistant, "needle", "needle"),
            hit(0, "d", "three", Role::Assistant, "needle", "needle"),
            hit(1, "e", "four", Role::ToolResult, "needle", "needle"),
        ];
        score(&mut hits, 1, 5);
        assert_eq!(hits[1].score * 2.0, hits[0].score);
        let selected = select(hits, Some(3));
        assert_eq!(
            selected
                .iter()
                .map(|hit| hit.message_id.as_str())
                .collect::<Vec<_>>(),
            ["a", "c", "e"]
        );
    }
}
