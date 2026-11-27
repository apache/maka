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
//! Source-qualified Find and landmarks over one actual historical tree.
use super::snapshot::navigation::{FindInput, LocalFindPage, LocalFound, LocalLandmark};
use super::source_tree::{HistoryDataSource, SourceTree, location, qualify};
use super::sql::{bind_u64, read_u64};
use super::*;
use crate::{
    recall::{self, Field},
    store::invalid,
};
use maka_agent_facts::{
    history::{HistoryOrder, HistoryRowAddress, RowPosition},
    history_snapshot::{ImportedTurnOrdinal, SnapshotPosition},
    message::MessageOrigin,
};
use rusqlite::{OptionalExtension, params};
use tokio_util::sync::CancellationToken;
#[derive(Clone)]
pub struct SourceFind {
    pub after: Option<HistoryRowAddress>,
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub include_internal: bool,
    pub mask_evidence: bool,
}
pub struct SourceFound {
    pub position: HistoryRowAddress,
    pub order: HistoryOrder,
    pub field: Field,
    pub preview: String,
}
pub struct SourceFindPage {
    pub matches: Vec<SourceFound>,
    pub next_after: Option<HistoryRowAddress>,
}
pub struct SourceLandmark {
    pub turn_id: Option<String>,
    pub imported_turn: Option<ImportedTurnOrdinal>,
    pub position: HistoryRowAddress,
    pub last_position: HistoryRowAddress,
    pub order: HistoryOrder,
    pub last_order: HistoryOrder,
    pub label: String,
    pub origin: Option<MessageOrigin>,
}
struct ModelLandmarks(RunOwner, Vec<SourceLandmark>);

impl SessionHistory {
    pub async fn mask_landmark_labels(
        &self,
        landmarks: Vec<SourceLandmark>,
    ) -> Result<Vec<SourceLandmark>, StoreError> {
        self.data
            .query(ModelLandmarks(self.namespace.owner.clone(), landmarks))
            .await
    }
}

impl Query for ModelLandmarks {
    type Output = Vec<SourceLandmark>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let Self(owner, mut landmarks) = self;
        let mut restricted =
            crate::memory::recall::address_spans(c, &owner, landmarks.iter().map(|l| &l.position))?;
        if restricted.is_empty() {
            return Ok(landmarks);
        }
        let keys: Vec<_> = restricted
            .keys()
            .filter_map(|&i| match landmarks[i].position {
                HistoryRowAddress::Live {
                    sequence,
                    fact,
                    item_index,
                }
                | HistoryRowAddress::Snapshot {
                    sequence,
                    fact,
                    item_index,
                    ..
                } => Some((i, sequence, fact, item_index)),
                HistoryRowAddress::Imported { .. } => None,
            })
            .collect();
        // A label may include attachment names after the message. Only the indexed
        // Body field provides original user text with reliable byte coordinates.
        let mut stmt = c.prepare_cached(
            "SELECT k.value->>0,substr(d.body,1,96),d.fields_json->>'$[0].end'
             FROM json_each(?1) k CROSS JOIN agent_session_history h
             CROSS JOIN agent_namespaces ns ON ns.id=h.namespace_id
             CROSS JOIN agent_recall_messages d
             WHERE h.sequence=k.value->>1 AND h.fact_id=k.value->>2 AND ns.owner=?2
               AND d.namespace_id=h.namespace_id AND d.sequence=h.sequence AND d.ordinal=k.value->>3
               AND d.role='\"user\"' AND d.fields_json->>'$[0].field'='body' AND d.fields_json->>'$[0].start'=0"
        )?;
        let mut rows = stmt.query(params![
            serde_json::to_string(&keys)?,
            serde_json::to_string(&owner)?
        ])?;
        while let Some(row) = rows.next()? {
            let i = usize::try_from(row.get::<_, i64>(0)?)
                .map_err(|_| invalid("invalid landmark index"))?;
            let raw: String = row.get(1)?;
            let body_end = usize::try_from(row.get::<_, i64>(2)?)
                .map_err(|_| invalid("invalid landmark body length"))?;
            let spans = restricted
                .remove(&i)
                .expect("queried a restricted landmark");
            landmarks[i].label =
                masked_landmark_label(&raw, body_end, &landmarks[i].label, &spans)?;
        }
        for i in restricted.into_keys() {
            landmarks[i].label.clear();
        }
        Ok(landmarks)
    }
}
fn masked_landmark_label(
    raw: &str,
    body_end: usize,
    label: &str,
    spans: &[(u64, u64)],
) -> Result<String, StoreError> {
    let end = raw.floor_char_boundary(96.min(raw.len())).min(body_end);
    if label != recall::landmark_label(raw) || spans.iter().any(|&(a, b)| a == 0 && b >= end as u64)
    {
        return Ok(String::new());
    }
    let mut body = raw
        .get(..end)
        .ok_or_else(|| invalid("invalid landmark body boundary"))?
        .to_owned();
    crate::memory::recall::mask(&mut body, 0, spans);
    Ok(recall::landmark_label(&body))
}

fn cancelled(stop: &CancellationToken) -> Result<(), StoreError> {
    if stop.is_cancelled() {
        Err(invalid("source navigation cancelled"))
    } else {
        Ok(())
    }
}
impl SourceTree {
    pub async fn find_page(
        &self,
        input: SourceFind,
        stop: CancellationToken,
    ) -> Result<SourceFindPage, StoreError> {
        cancelled(&stop)?;
        if input.query.is_empty() {
            return Err(invalid("invalid history search"));
        }
        let start = match input.after.as_ref() {
            Some(address) => self.validate_address(address).await?,
            None => 0,
        };
        let mut matches = Vec::new();
        let mut last = None;
        let mut processed = input.after.clone();
        let mut work = recall::FindWork::default();
        for (index, section) in self.sections().iter().enumerate().skip(start) {
            cancelled(&stop)?;
            let local = FindInput {
                after: if index == start {
                    input.after.as_ref().map(|a| location(a).2)
                } else {
                    None
                },
                min_admission: section.after_admission,
                query: input.query.clone(),
                case_sensitive: input.case_sensitive,
                whole_word: input.whole_word,
                include_internal: input.include_internal,
                mask_evidence: input.mask_evidence,
                work,
            };
            let page = match &section.source {
                HistoryDataSource::Snapshot(snapshot) => {
                    snapshot.navigation_find(local, stop.clone()).await?
                }
                HistoryDataSource::Live { history, cut } => {
                    history
                        .data
                        .query(LiveFind(
                            history.namespace.clone(),
                            cut.clone(),
                            local,
                            stop.clone(),
                        ))
                        .await?
                }
            };
            work = page.work;
            if let Some(row) = &page.last_processed {
                processed = Some(qualify(section, row)?.address);
            }
            for found in page.matches {
                if matches.len() == 16 {
                    return Ok(SourceFindPage {
                        matches,
                        next_after: last,
                    });
                }
                let row = qualify(section, &found.row)?;
                last = Some(row.address.clone());
                matches.push(SourceFound {
                    position: row.address,
                    order: row.order,
                    field: found.field,
                    preview: found.preview,
                });
            }
            if let Some(row) = page.next_after {
                return Ok(SourceFindPage {
                    matches,
                    next_after: Some(qualify(section, &row)?.address),
                });
            }
            if work.stopped() {
                return Ok(SourceFindPage {
                    matches,
                    next_after: processed,
                });
            }
            if matches.len() == 16 && index + 1 < self.sections().len() {
                return Ok(SourceFindPage {
                    matches,
                    next_after: last,
                });
            }
        }
        Ok(SourceFindPage {
            matches,
            next_after: None,
        })
    }
    pub async fn landmarks(
        &self,
        limit: u32,
        stop: CancellationToken,
    ) -> Result<Vec<SourceLandmark>, StoreError> {
        cancelled(&stop)?;
        if !(1..=64).contains(&limit) {
            return Err(invalid("landmark limit must be 1..=64"));
        }
        let mut counts = Vec::with_capacity(self.sections().len());
        let mut total = 0u64;
        for section in self.sections() {
            cancelled(&stop)?;
            let count = match &section.source {
                HistoryDataSource::Snapshot(snapshot) => {
                    snapshot
                        .navigation_landmark_count(section.after_admission, stop.clone())
                        .await?
                }
                HistoryDataSource::Live { history, cut } => {
                    history
                        .data
                        .query(LiveLandmarkCount(
                            history.namespace.clone(),
                            cut.clone(),
                            section.after_admission,
                        ))
                        .await?
                }
            };
            total = total
                .checked_add(count)
                .ok_or_else(|| invalid("source turn count overflow"))?;
            counts.push(count);
        }
        let ranks = recall::landmark_ranks(total, limit);
        let mut offset = 0u64;
        let mut out = Vec::with_capacity(limit as usize);
        for (section, count) in self.sections().iter().zip(counts) {
            cancelled(&stop)?;
            let end = offset
                .checked_add(count)
                .ok_or_else(|| invalid("source turn ordinal overflow"))?;
            let selected: Vec<u64> = ranks
                .iter()
                .copied()
                .filter(|n| *n >= offset && *n < end)
                .map(|n| n - offset)
                .collect();
            offset = end;
            if selected.is_empty() {
                continue;
            }
            let landmarks = match &section.source {
                HistoryDataSource::Snapshot(snapshot) => {
                    snapshot
                        .navigation_landmarks(section.after_admission, selected, stop.clone())
                        .await?
                }
                HistoryDataSource::Live { history, cut } => {
                    history
                        .data
                        .query(LiveLandmarks(
                            history.namespace.clone(),
                            cut.clone(),
                            section.after_admission,
                            selected,
                            stop.clone(),
                        ))
                        .await?
                }
            };
            for item in landmarks {
                let first = qualify(section, &item.position)?;
                let last = qualify(section, &item.last_position)?;
                out.push(SourceLandmark {
                    turn_id: item.turn_id,
                    imported_turn: item.imported_turn,
                    position: first.address,
                    last_position: last.address,
                    order: first.order,
                    last_order: last.order,
                    label: item.label,
                    origin: item.origin,
                });
            }
        }
        Ok(out)
    }
}
fn live_scope(
    c: &Connection,
    scope: &HistoryNamespace,
    cut: &HistoryCut,
) -> Result<String, StoreError> {
    if scope.session != cut.session {
        return Err(invalid("history cut belongs to another source session"));
    }
    recall::checked_source_cut(c, &scope.owner, cut)?;
    Ok(serde_json::to_string(&scope.owner)?)
}
fn live_row(
    c: &Connection,
    scope: &HistoryNamespace,
    cut: &HistoryCut,
    position: RowPosition,
    min_admission: u64,
) -> Result<SnapshotPosition, StoreError> {
    if position.source_sequence > cut.through_sequence {
        return Err(invalid("history row exceeds original cut"));
    }
    let Some(namespace_id) = crate::namespace::find_owner_id(c, &scope.owner, &scope.session)?
    else {
        return Err(rusqlite::Error::QueryReturnedNoRows.into());
    };
    let indexed: Option<(String, u64, String, bool)> = c
        .query_row(
            "SELECT d.run,h.admission_sequence,h.fact_id,d.internal FROM agent_recall_messages d JOIN agent_session_history h ON h.namespace_id=d.namespace_id AND h.sequence=d.sequence WHERE d.namespace_id=? AND d.sequence=? AND d.ordinal=? AND h.admission_sequence>?",
            params![
                namespace_id,
                bind_u64(position.source_sequence)?,
                bind_u64(position.item_index)?,
                bind_u64(min_admission)?
            ],
            |r| Ok((r.get(0)?, read_u64(r, 1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    let (run, admission, fact, internal) = match indexed {
        Some(found) => found,
        None if position.item_index == 0 => {
            let (run, admission, fact, bytes): (String, u64, String, Vec<u8>) = c.query_row(
                "SELECT h.run,h.admission_sequence,h.fact_id,b.payload
                 FROM agent_session_history h
                 JOIN agent_facts f ON f.sequence=h.sequence
                 JOIN contents b ON b.id=f.body_content_id
                 WHERE h.namespace_id=? AND h.sequence=? AND h.admission_sequence>?
                   AND h.kind='external_task_observed'",
                params![
                    namespace_id,
                    bind_u64(position.source_sequence)?,
                    bind_u64(min_admission)?
                ],
                |r| Ok((r.get(0)?, read_u64(r, 1)?, r.get(2)?, r.get(3)?)),
            )?;
            let recorded: maka_agent_facts::durable::RecordedFact = serde_json::from_slice(&bytes)?;
            let internal = match recorded.fact {
                maka_agent_facts::durable::Fact::ExternalTaskObserved {
                    output: maka_agent_facts::executor::Output::ThinkingDelta { .. },
                    ..
                } => true,
                maka_agent_facts::durable::Fact::ExternalTaskObserved {
                    output: maka_agent_facts::executor::Output::OutputDelta { .. },
                    ..
                } => false,
                _ => return Err(StoreError::EventConflict),
            };
            (run, admission, fact, internal)
        }
        None => return Err(StoreError::EventConflict),
    };
    Ok(SnapshotPosition::Canonical {
        run: sql::identity(run)?,
        sequence: position.source_sequence,
        admission_sequence: admission,
        fact: sql::identity(fact)?,
        item_index: position.item_index,
        internal,
    })
}
struct LiveFind(HistoryNamespace, HistoryCut, FindInput, CancellationToken);
impl Query for LiveFind {
    type Output = LocalFindPage;
    fn execute(self, c: &Connection) -> Result<LocalFindPage, StoreError> {
        let Self(scope, cut, input, stop) = self;
        cancelled(&stop)?;
        let owner = live_scope(c, &scope, &cut)?;
        let mut work = input.work;
        let (page, last_processed) = recall::find_index(
            c,
            &owner,
            &cut,
            recall::Find {
                after: input
                    .after
                    .map(|(source_sequence, item_index)| RowPosition {
                        source_sequence,
                        item_index,
                    }),
                query: input.query,
                case_sensitive: input.case_sensitive,
                whole_word: input.whole_word,
                include_internal: input.include_internal,
            },
            &stop,
            input.min_admission,
            input.mask_evidence.then_some(&scope.owner),
            &mut work,
        )?;
        Ok(LocalFindPage {
            matches: page
                .matches
                .into_iter()
                .map(|found| {
                    Ok(LocalFound {
                        row: live_row(c, &scope, &cut, found.position, input.min_admission)?,
                        field: found.field,
                        preview: found.preview,
                    })
                })
                .collect::<Result<_, StoreError>>()?,
            next_after: page
                .next_after
                .map(|position| live_row(c, &scope, &cut, position, input.min_admission))
                .transpose()?,
            last_processed: last_processed
                .map(|position| live_row(c, &scope, &cut, position, input.min_admission))
                .transpose()?,
            work,
        })
    }
}
struct LiveLandmarkCount(HistoryNamespace, HistoryCut, u64);
impl Query for LiveLandmarkCount {
    type Output = u64;
    fn execute(self, c: &Connection) -> Result<u64, StoreError> {
        let owner = live_scope(c, &self.0, &self.1)?;
        recall::landmarks_count_index(c, &owner, &self.1, self.2)
    }
}
struct LiveLandmarks(
    HistoryNamespace,
    HistoryCut,
    u64,
    Vec<u64>,
    CancellationToken,
);
impl Query for LiveLandmarks {
    type Output = Vec<LocalLandmark>;
    fn execute(self, c: &Connection) -> Result<Vec<LocalLandmark>, StoreError> {
        let Self(scope, cut, min_admission, ranks, stop) = self;
        let owner = live_scope(c, &scope, &cut)?;
        let limit =
            u32::try_from(ranks.len()).map_err(|_| invalid("landmark selection too large"))?;
        recall::landmarks_selected_index(
            c,
            &owner,
            &cut,
            limit,
            &stop,
            min_admission,
            Some(&ranks),
        )?
        .into_iter()
        .map(|item| {
            Ok(LocalLandmark {
                turn_id: Some(item.turn_id),
                imported_turn: None,
                position: live_row(c, &scope, &cut, item.position, min_admission)?,
                last_position: live_row(c, &scope, &cut, item.last_position, min_admission)?,
                label: item.label,
                origin: item.origin,
            })
        })
        .collect()
    }
}

#[cfg(test)]
mod landmark_tests {
    use super::*;

    #[test]
    fn landmark_spans_use_original_bytes_and_exclude_attachment_labels() {
        let raw = format!("a\u{85}界{}附件", "x".repeat(100));
        let label = recall::landmark_label(&raw);
        assert_eq!(
            masked_landmark_label(&raw, raw.len(), &label, &[(100, 101)]).unwrap(),
            label
        );
        assert_eq!(
            masked_landmark_label(&raw, 6, &label, &[(3, 6)]).unwrap(),
            "a ***"
        );
        assert_eq!(
            masked_landmark_label(&raw, 6, "unmapped", &[(3, 6)]).unwrap(),
            ""
        );
    }
}
