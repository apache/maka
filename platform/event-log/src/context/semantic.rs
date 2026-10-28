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

//! Indexed semantic metadata with extracted pieces or canonical projection spans.
#[cfg(test)]
#[path = "semantic/age_tests.rs"]
mod age_tests;
pub(crate) mod gc;
mod source;
#[cfg(test)]
#[path = "semantic/tests.rs"]
mod tests;
mod write;
pub(crate) use write::{copy_member, record};

use crate::{EventLog, StoreError};
use maka_agent_facts::history::{
    RowPosition,
    semantic::{PartPayload, Payload, PayloadKey, ResolvedRow, SemanticKind, SemanticRow},
};
use serde::{Deserialize, Serialize};
use source::SemanticPayloadSource;
use sqlx::{Connection, Row, SqliteConnection};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticSelection {
    pub session: String,
    /// The authenticated selection's immutable {base,run} descriptor.
    pub lineage: Option<String>,
    pub after: u64,
    pub anchor_sequence: Option<u64>,
    pub through: u64,
    /// Exclusive visibility boundary for archives owned by this Session.
    pub before: u64,
    /// Physical publication watermark, distinct from the selected source cut.
    pub captured_through: u64,
    pub replay: Option<SemanticReplay>,
    pub prior_unknown: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticReplay {
    pub base: u64,
    pub current: String,
    pub route: String,
    pub model: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticCursor {
    pub order: RowPosition,
    pub id: RowPosition,
}

#[derive(Clone, Debug)]
pub struct SemanticPage {
    pub rows: Vec<SemanticRow>,
    pub next: Option<SemanticCursor>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemanticChangeCursor {
    pub revision: u64,
    pub change_id: u64,
}

#[derive(Clone, Debug)]
pub struct SemanticChange {
    pub order: RowPosition,
    pub id: RowPosition,
    pub revision: u64,
    pub deleted: bool,
}

#[derive(Clone, Debug)]
pub struct SemanticChangePage {
    pub changes: Vec<SemanticChange>,
    pub next: Option<SemanticChangeCursor>,
}

fn invalid(reason: impl Into<String>) -> StoreError {
    StoreError::InvalidTransition(reason.into())
}

fn page_limit(limit: usize) -> Result<i64, StoreError> {
    if limit == 0 {
        return Err(invalid("semantic page limit must be positive"));
    }
    Ok(limit.min(1024) as i64)
}

/// The source cut excludes unaccepted items and unreleased notifications.
/// Archives may be published later than that cut, but are frozen by both the
/// captured publication watermark and the archive selection boundary.
fn eligible(alias: &str) -> String {
    let source =
        super::selection::Selection::lineage_contains(&format!("{alias}.invocation_id"), "?6");
    let publication = super::selection::Selection::lineage_contains(
        &format!("{alias}.revision_invocation"),
        "?6",
    );
    format!(
        "{alias}.revision<=?4 AND (
        ({alias}.archived=0 AND {alias}.revision<=?3)
        OR ({alias}.archived=1 AND ({alias}.inherited=1 OR {alias}.revision<?5)))
        AND (?6 IS NULL OR {alias}.source_sequence<=json_extract(?6,'$.base')
             OR {source})
        AND ({alias}.archived=0 OR {alias}.inherited=1 OR ?6 IS NULL
             OR {alias}.revision<=json_extract(?6,'$.base')
             OR {publication})"
    )
}

fn replay_predicate(alias: &str, parameter: &str) -> String {
    format!(
        "({parameter} IS NULL OR {alias}.kind!='assistant_part'
        OR {alias}.source_sequence<=json_extract({parameter},'$.base')
        OR {alias}.invocation_id=json_extract({parameter},'$.current')
        OR EXISTS(SELECT 1 FROM context_semantic_cuts cut
            WHERE cut.owner_session_id=?1 AND cut.invocation_id={alias}.invocation_id
              AND ({alias}.source_sequence,{alias}.source_index)<(cut.cut_sequence,cut.cut_index)
              AND cut.revision=(SELECT revision FROM context_semantic_cuts latest
                WHERE latest.owner_session_id=?1 AND latest.invocation_id=cut.invocation_id AND latest.revision<=MIN(?3,?4)
                ORDER BY revision DESC LIMIT 1)))"
    )
}

pub(crate) async fn available(
    connection: &mut SqliteConnection,
    session: &str,
) -> Result<(), StoreError> {
    available_at(connection, session, i64::MAX as u64).await
}

pub(crate) async fn available_at(
    connection: &mut SqliteConnection,
    session: &str,
    captured: u64,
) -> Result<(), StoreError> {
    let reason:Option<String> = sqlx::query_scalar("SELECT unavailable_reason FROM context_semantic_heads WHERE session_id=? AND unavailable_at<=?")
        .bind(session).bind(captured as i64).fetch_optional(connection).await?;
    if let Some(reason) = reason {
        return Err(invalid(format!(
            "semantic projection unavailable: {reason}"
        )));
    }
    Ok(())
}

pub(crate) async fn rows(
    connection: &mut SqliteConnection,
    selection: &SemanticSelection,
    cursor: Option<SemanticCursor>,
    limit: usize,
    group: Option<u64>,
) -> Result<SemanticPage, StoreError> {
    available_at(connection, &selection.session, selection.captured_through).await?;
    let limit = page_limit(limit)?;
    let zero = RowPosition {
        source_sequence: 0,
        item_index: 0,
    };
    let point = cursor.unwrap_or(SemanticCursor {
        order: zero,
        id: zero,
    });
    let query = rows_query(group.is_some());
    let records: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(query))
        .bind(&selection.session)
        .bind(selection.after as i64)
        .bind(selection.through as i64)
        .bind(selection.captured_through as i64)
        .bind(selection.before.min(i64::MAX as u64) as i64)
        .bind(&selection.lineage)
        .bind(point.order.source_sequence as i64)
        .bind(point.order.item_index as i64)
        .bind(point.id.source_sequence as i64)
        .bind(point.id.item_index as i64)
        .bind(group.map(|value| value as i64))
        .bind(limit + 1)
        .bind(selection.anchor_sequence.map(|value| value as i64))
        .bind(
            selection
                .replay
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
        )
        .bind(selection.prior_unknown)
        .fetch_all(connection)
        .await?;
    let more = records.len() > limit as usize;
    let rows: Vec<SemanticRow> = records
        .into_iter()
        .take(limit as usize)
        .map(|json| serde_json::from_str(&json))
        .collect::<Result<_, _>>()?;
    let next = more
        .then(|| {
            rows.last().map(|row| SemanticCursor {
                order: row.order,
                id: row.id,
            })
        })
        .flatten();
    Ok(SemanticPage { rows, next })
}

fn rows_query(group: bool) -> String {
    // Keep exact group reads as direct ordered-index seeks.
    let group_filter = if group {
        "r.order_sequence=?11"
    } else {
        "?11 IS NULL"
    };
    // A source window can contain rows ordered before its source cutoff (for
    // example a late tool result). Seek each source range first, then sort only
    // that window. The anchor branch is disjoint even if it lies in the window.
    let (window, from) = if group {
        (
            String::new(),
            "context_semantic_rows r INDEXED BY context_semantic_row_order",
        )
    } else {
        (
            "WITH window AS MATERIALIZED (
            SELECT * FROM context_semantic_rows WHERE owner_session_id=?1
              AND source_sequence>?2 AND source_sequence<=?3
            UNION ALL
            SELECT * FROM context_semantic_rows WHERE owner_session_id=?1
              AND source_sequence=?13 AND source_sequence<=?2 AND source_sequence<=?3
        ) "
            .to_owned(),
            "window r",
        )
    };
    format!("{window}SELECT r.row_json FROM {from}
        WHERE r.owner_session_id=?1 AND (r.source_sequence>?2 OR r.source_sequence=?13) AND r.source_sequence<=?3
          AND {} AND r.visible=1 AND {} AND (?15=1 OR (r.kind!='unknown_tool' AND r.unknown_only=0))
          AND (r.order_sequence,r.order_index,r.source_sequence,r.source_index)>(?7,?8,?9,?10)
          AND {group_filter}
          AND NOT EXISTS(SELECT 1 FROM context_semantic_rows n
            WHERE n.owner_session_id=r.owner_session_id AND n.source_sequence=r.source_sequence
              AND n.source_index=r.source_index AND n.revision>r.revision AND {})
        ORDER BY r.order_sequence,r.order_index,r.source_sequence,r.source_index LIMIT ?12",
        eligible("r"),replay_predicate("r","?14"),eligible("n"))
}

/// A cold projection starts from the selected source window, not from the
/// first change ever published by this Session. The anchor is a separate seek.
/// Discovery pages the source primary key, not DISTINCT semantic order. Dirty
/// insertion owns deduplication; repeating a source window for each order page
/// would turn cold preparation into quadratic work.
pub(crate) type GroupCursor = (i64, i64, i64, i64);
pub(crate) struct GroupPage {
    pub groups: Vec<u64>,
    pub next: Option<GroupCursor>,
}
fn group_page(rows: Vec<sqlx::sqlite::SqliteRow>, limit: usize) -> Result<GroupPage, StoreError> {
    let more = rows.len() > limit;
    let mut groups = Vec::with_capacity(limit);
    let mut last = None;
    for row in rows.into_iter().take(limit) {
        groups.push(crate::sequence_number(row.try_get("order_sequence")?)?);
        last = Some((
            row.try_get("source_sequence")?,
            row.try_get("source_index")?,
            row.try_get("revision")?,
            row.try_get("order_sequence")?,
        ));
    }
    Ok(GroupPage {
        groups,
        next: if more { last } else { None },
    })
}
pub(crate) async fn initial_groups(
    connection: &mut SqliteConnection,
    selection: &SemanticSelection,
    cursor: Option<GroupCursor>,
    anchor: bool,
    limit: usize,
) -> Result<GroupPage, StoreError> {
    available_at(connection, &selection.session, selection.captured_through).await?;
    let floor = if anchor {
        let Some(anchor) = selection.anchor_sequence else {
            return Ok(GroupPage {
                groups: Vec::new(),
                next: None,
            });
        };
        anchor
    } else {
        selection.after.saturating_add(1)
    };
    let lower = if anchor {
        "r.source_sequence=?2 AND (r.source_index,r.revision)>(?8,?9)"
    } else {
        "(r.source_sequence,r.source_index,r.revision)>(?7,?8,?9)"
    };
    let query = format!(
        "SELECT r.source_sequence,r.source_index,r.revision,r.order_sequence
        FROM context_semantic_rows r WHERE r.owner_session_id=?1 AND {lower}
        AND r.source_sequence<=?3 AND {}
        ORDER BY r.source_sequence,r.source_index,r.revision LIMIT ?10",
        eligible("r")
    );
    let point = cursor.unwrap_or((floor as i64, -1, -1, -1));
    let limit = limit.clamp(1, 256);
    let rows = sqlx::query(sqlx::AssertSqlSafe(query))
        .bind(&selection.session)
        .bind(floor as i64)
        .bind(selection.through as i64)
        .bind(selection.captured_through as i64)
        .bind(selection.before.min(i64::MAX as u64) as i64)
        .bind(&selection.lineage)
        .bind(point.0)
        .bind(point.1)
        .bind(point.2)
        .bind((limit + 1) as i64)
        .fetch_all(connection)
        .await?;
    group_page(rows, limit)
}

pub(crate) async fn changes(
    connection: &mut SqliteConnection,
    selection: &SemanticSelection,
    since: u64,
    cursor: Option<SemanticChangeCursor>,
    limit: usize,
) -> Result<SemanticChangePage, StoreError> {
    available_at(connection, &selection.session, selection.captured_through).await?;
    let limit = page_limit(limit)?;
    let point = cursor.unwrap_or(SemanticChangeCursor {
        revision: since,
        change_id: 0,
    });
    let query=format!("SELECT r.change_id,r.revision,r.source_sequence,r.source_index,r.order_sequence,r.order_index,r.deleted
        FROM context_semantic_changes r WHERE r.owner_session_id=?1
        AND (r.source_sequence>?2 OR r.source_sequence=?11) AND r.source_sequence<=?3 AND {}
        AND r.revision>?7 AND (r.revision,r.change_id)>(?8,?9)
        ORDER BY r.revision,r.change_id LIMIT ?10",eligible("r"));
    let records = sqlx::query(sqlx::AssertSqlSafe(query))
        .bind(&selection.session)
        .bind(selection.after as i64)
        .bind(selection.through as i64)
        .bind(selection.captured_through as i64)
        .bind(selection.before.min(i64::MAX as u64) as i64)
        .bind(&selection.lineage)
        .bind(since as i64)
        .bind(point.revision as i64)
        .bind(point.change_id as i64)
        .bind(limit + 1)
        .bind(selection.anchor_sequence.map(|value| value as i64))
        .fetch_all(connection)
        .await?;
    let more = records.len() > limit as usize;
    let mut changes = Vec::new();
    let mut next = None;
    for record in records.into_iter().take(limit as usize) {
        let revision = crate::sequence_number(record.try_get("revision")?)?;
        next = Some(SemanticChangeCursor {
            revision,
            change_id: crate::sequence_number(record.try_get("change_id")?)?,
        });
        changes.push(SemanticChange {
            order: RowPosition {
                source_sequence: crate::sequence_number(record.try_get("order_sequence")?)?,
                item_index: crate::sequence_number(record.try_get("order_index")?)?,
            },
            id: RowPosition {
                source_sequence: crate::sequence_number(record.try_get("source_sequence")?)?,
                item_index: crate::sequence_number(record.try_get("source_index")?)?,
            },
            revision,
            deleted: record.try_get("deleted")?,
        });
    }
    Ok(SemanticChangePage {
        changes,
        next: if more { next } else { None },
    })
}

type NeighborKey = (i64, i64, i64, i64, i64);

async fn neighbor_row(
    connection: &mut SqliteConnection,
    session: &str,
    key: NeighborKey,
) -> Result<SemanticRow, StoreError> {
    let json: String = sqlx::query_scalar("SELECT row_json FROM context_semantic_rows WHERE owner_session_id=? AND source_sequence=? AND source_index=? AND revision=?")
        .bind(session).bind(key.2).bind(key.3).bind(key.4)
        .fetch_one(connection).await?;
    serde_json::from_str(&json).map_err(StoreError::from)
}

pub(crate) async fn neighbor(
    connection: &mut SqliteConnection,
    selection: &SemanticSelection,
    group: u64,
    before: bool,
) -> Result<Option<SemanticRow>, StoreError> {
    // Race ordered seeks against a source-window scan. Dense windows finish
    // from the order index; compacted gaps finish from the source primary key.
    // Neither path can force every neighbor to scan the entire other range.
    const PAGE: usize = 64;
    let (comparison, direction) = if before { ("<", "DESC") } else { (">", "ASC") };
    let predicate = format!(
        "(r.source_sequence>?2 OR r.source_sequence=?9) AND r.source_sequence<=?3
        AND {} AND {} AND r.visible=1 AND (?8=1 OR (r.kind!='unknown_tool' AND r.unknown_only=0))
        AND r.order_sequence {comparison} ?10
        AND NOT EXISTS(SELECT 1 FROM context_semantic_rows n WHERE n.owner_session_id=r.owner_session_id
            AND n.source_sequence=r.source_sequence AND n.source_index=r.source_index AND n.revision>r.revision AND {})",
        eligible("r"), replay_predicate("r", "?7"), eligible("n")
    );
    let columns = format!(
        "r.order_sequence,r.order_index,r.source_sequence,r.source_index,r.revision,
        CASE WHEN {predicate} THEN 1 ELSE 0 END AS selected"
    );
    let order_query = format!("SELECT {columns} FROM context_semantic_rows r INDEXED BY context_semantic_row_order
        WHERE r.owner_session_id=?1
        AND (r.order_sequence,r.order_index,r.source_sequence,r.source_index,r.revision) {comparison} (?11,?12,?13,?14,?15)
        ORDER BY r.order_sequence {direction},r.order_index {direction},r.source_sequence {direction},r.source_index {direction},r.revision {direction} LIMIT ?16");
    let replay = selection
        .replay
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    let mut ordered: NeighborKey = if before {
        (group as i64, 0, 0, 0, 0)
    } else {
        (group as i64, i64::MAX, i64::MAX, i64::MAX, i64::MAX)
    };
    let mut anchor = selection
        .anchor_sequence
        .is_some_and(|value| value <= selection.after && value <= selection.through);
    let mut source = if anchor {
        (
            selection.anchor_sequence.expect("anchor selected") as i64,
            -1,
            -1,
        )
    } else {
        (selection.after.saturating_add(1) as i64, -1, -1)
    };
    let mut best: Option<NeighborKey> = None;
    let mut order_limit = 1;
    loop {
        let records = sqlx::query(sqlx::AssertSqlSafe(order_query.as_str()))
            .bind(&selection.session)
            .bind(selection.after as i64)
            .bind(selection.through as i64)
            .bind(selection.captured_through as i64)
            .bind(selection.before.min(i64::MAX as u64) as i64)
            .bind(&selection.lineage)
            .bind(&replay)
            .bind(selection.prior_unknown)
            .bind(selection.anchor_sequence.map(|value| value as i64))
            .bind(group as i64)
            .bind(ordered.0)
            .bind(ordered.1)
            .bind(ordered.2)
            .bind(ordered.3)
            .bind(ordered.4)
            .bind(order_limit as i64)
            .fetch_all(&mut *connection)
            .await?;
        for record in &records {
            ordered = neighbor_key(record)?;
            if record.try_get::<bool, _>("selected")? {
                return neighbor_row(connection, &selection.session, ordered)
                    .await
                    .map(Some);
            }
        }
        if records.len() < order_limit {
            return Ok(None);
        }
        order_limit = PAGE;
        let lower = if anchor {
            "r.source_sequence=?9 AND r.source_sequence<=?2 AND r.source_sequence<=?3
             AND (r.source_index,r.revision)>(?12,?13)"
        } else {
            "(r.source_sequence,r.source_index,r.revision)>(?11,?12,?13) AND r.source_sequence<=?3"
        };
        let source_query = format!(
            "SELECT {columns} FROM context_semantic_rows r WHERE r.owner_session_id=?1 AND {lower}
            ORDER BY r.source_sequence,r.source_index,r.revision LIMIT {PAGE}"
        );
        let records = sqlx::query(sqlx::AssertSqlSafe(source_query))
            .bind(&selection.session)
            .bind(selection.after as i64)
            .bind(selection.through as i64)
            .bind(selection.captured_through as i64)
            .bind(selection.before.min(i64::MAX as u64) as i64)
            .bind(&selection.lineage)
            .bind(&replay)
            .bind(selection.prior_unknown)
            .bind(selection.anchor_sequence.map(|value| value as i64))
            .bind(group as i64)
            .bind(source.0)
            .bind(source.1)
            .bind(source.2)
            .fetch_all(&mut *connection)
            .await?;
        for record in &records {
            let key = neighbor_key(record)?;
            source = (key.2, key.3, key.4);
            if record.try_get::<bool, _>("selected")?
                && best.is_none_or(|current| if before { key > current } else { key < current })
            {
                best = Some(key);
            }
        }
        if records.len() < PAGE {
            if anchor {
                anchor = false;
                source = (selection.after.saturating_add(1) as i64, -1, -1);
            } else {
                return match best {
                    Some(key) => neighbor_row(connection, &selection.session, key)
                        .await
                        .map(Some),
                    None => Ok(None),
                };
            }
        }
    }
}

fn neighbor_key(record: &sqlx::sqlite::SqliteRow) -> Result<NeighborKey, StoreError> {
    Ok((
        record.try_get("order_sequence")?,
        record.try_get("order_index")?,
        record.try_get("source_sequence")?,
        record.try_get("source_index")?,
        record.try_get("revision")?,
    ))
}

pub(crate) async fn meaningful_history(
    connection: &mut SqliteConnection,
    selection: &SemanticSelection,
) -> Result<bool, StoreError> {
    let query=format!("SELECT EXISTS(SELECT 1 FROM context_semantic_rows r WHERE r.owner_session_id=?1
        AND r.source_sequence>?2 AND r.source_sequence<=?3 AND r.kind IN ('user','assistant_part','imported_user','imported_assistant')
        AND {} AND {} AND r.visible=1
        AND NOT EXISTS(SELECT 1 FROM context_semantic_rows n WHERE n.owner_session_id=r.owner_session_id
            AND n.source_sequence=r.source_sequence AND n.source_index=r.source_index AND n.revision>r.revision AND {}))",
        eligible("r"),replay_predicate("r","?7"),eligible("n"));
    sqlx::query_scalar(sqlx::AssertSqlSafe(query))
        .bind(&selection.session)
        .bind(selection.after as i64)
        .bind(selection.through as i64)
        .bind(selection.captured_through as i64)
        .bind(selection.before.min(i64::MAX as u64) as i64)
        .bind(&selection.lineage)
        .bind(
            selection
                .replay
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
        )
        .fetch_one(connection)
        .await
        .map_err(StoreError::from)
}

async fn cut_sequence(
    connection: &mut SqliteConnection,
    owner: &str,
    invocation: &str,
    through: u64,
) -> Result<u64, StoreError> {
    let cut:Option<i64>=sqlx::query_scalar("SELECT cut_sequence FROM context_semantic_cuts WHERE owner_session_id=? AND invocation_id=? AND revision<=? ORDER BY revision DESC LIMIT 1")
        .bind(owner).bind(invocation).bind(through as i64).fetch_optional(connection).await?;
    Ok(cut.unwrap_or(0) as u64)
}

/// Selector changes touch only the formerly/currently inherited unstable tail.
/// A provider-policy switch can affect historical reasoning and deliberately
/// invalidates those candidate groups; unchanged policy never scans them.
pub(crate) async fn selection_dirty_groups(
    connection: &mut SqliteConnection,
    previous: &SemanticSelection,
    next: &SemanticSelection,
    branch: u8,
    cursor: Option<GroupCursor>,
    limit: usize,
) -> Result<GroupPage, StoreError> {
    let all_assistant = match (&previous.replay, &next.replay) {
        (Some(a), Some(b)) => a.route != b.route || a.model != b.model,
        (None, None) => false,
        _ => true,
    };
    let mut floor = next.after.saturating_add(1);
    let mut through = next.through;
    let mut invocation = None;
    let unknown = branch == 4;
    let active = match branch {
        0 => all_assistant,
        1 | 2 => {
            if let (Some(a), Some(b)) = (&previous.replay, &next.replay) {
                if !all_assistant && a.current != b.current {
                    let current = if branch == 1 { &a.current } else { &b.current };
                    let old_cut =
                        cut_sequence(connection, &previous.session, current, previous.through)
                            .await?;
                    let new_cut =
                        cut_sequence(connection, &next.session, current, next.through).await?;
                    floor = old_cut
                        .min(new_cut)
                        .max(a.base.min(b.base).saturating_add(1))
                        .max(floor);
                    invocation = Some(current);
                    true
                } else {
                    false
                }
            } else {
                false
            }
        }
        3 => {
            if let (Some(a), Some(b)) = (&previous.replay, &next.replay) {
                if !all_assistant && a.base != b.base {
                    floor = a.base.min(b.base).max(next.after).saturating_add(1);
                    through = a.base.max(b.base).min(next.through);
                    true
                } else {
                    false
                }
            } else {
                false
            }
        }
        4 => previous.prior_unknown != next.prior_unknown,
        _ => false,
    };
    if !active || floor > through {
        return Ok(GroupPage {
            groups: Vec::new(),
            next: None,
        });
    }
    let point = cursor.unwrap_or((floor as i64, -1, -1, -1));
    let limit = limit.clamp(1, 256);
    // Preserve each branch's equality/partial-index predicate. Optional ORs
    // would lose the invocation/unknown seek and scan unrelated old history.
    let predicate = if unknown {
        "unknown_only=1"
    } else if invocation.is_some() {
        "kind='assistant_part' AND invocation_id=?6"
    } else {
        "kind='assistant_part'"
    };
    let index = if unknown {
        "INDEXED BY context_semantic_unknown_rows"
    } else if invocation.is_some() {
        "INDEXED BY context_semantic_invocation_rows"
    } else {
        ""
    };
    let (position, order) = if unknown {
        (
            "(source_sequence,order_sequence,source_index,revision)>(?7,?11,?8,?9)",
            "source_sequence,order_sequence,source_index,revision",
        )
    } else {
        (
            "(source_sequence,source_index,revision)>(?7,?8,?9)",
            "source_sequence,source_index,revision",
        )
    };
    let query=format!("SELECT source_sequence,source_index,revision,order_sequence FROM context_semantic_rows {index}
        WHERE owner_session_id=?1 AND source_sequence<=?3 AND revision<=?4 AND {predicate} AND {position}
        ORDER BY {order} LIMIT ?10");
    let query = sqlx::query(sqlx::AssertSqlSafe(query))
        .bind(&next.session)
        .bind(floor as i64)
        .bind(through as i64)
        .bind(next.captured_through as i64)
        .bind(unknown)
        .bind(invocation)
        .bind(point.0)
        .bind(point.1)
        .bind(point.2)
        .bind((limit + 1) as i64);
    let query = if unknown { query.bind(point.3) } else { query };
    let rows = query.fetch_all(connection).await?;
    group_page(rows, limit)
}

async fn payload(
    connection: &mut SqliteConnection,
    key: PayloadKey,
) -> Result<Payload, StoreError> {
    let sequence = i64::try_from(key.source_sequence)
        .map_err(|_| invalid("semantic payload sequence exceeds SQLite range"))?;
    let index = i64::try_from(key.item_index)
        .map_err(|_| invalid("semantic payload index exceeds SQLite range"))?;
    crate::connection::worker_query(connection, move |worker| {
        Box::pin(async move {
            use futures_util::TryStreamExt;
            // One indexed seek handles Pieces and source metadata together. Canonical
            // fragments have no pieces, so their LEFT JOIN produces one metadata row.
            let mut records = sqlx::query(
                "SELECT f.storage_kind,f.byte_offset,f.byte_len,p.bytes
            FROM context_semantic_fragments f LEFT JOIN context_semantic_fragment_pieces p
              ON p.source_sequence=f.source_sequence AND p.source_index=f.source_index
            WHERE f.source_sequence=? AND f.source_index=? ORDER BY p.piece_index",
            )
            .bind(sequence)
            .bind(index)
            .fetch(&mut *worker);
            let first = records
                .try_next()
                .await?
                .ok_or_else(|| invalid("semantic payload is missing"))?;
            let source = SemanticPayloadSource::from_metadata(
                sequence,
                index,
                first.try_get("storage_kind")?,
                first.try_get("byte_offset")?,
                first.try_get("byte_len")?,
            )?;
            match source {
                SemanticPayloadSource::CanonicalToolProjection(span) => {
                    if first.try_get::<Option<Vec<u8>>, _>("bytes")?.is_some() {
                        return Err(invalid("canonical semantic payload has extracted pieces"));
                    }
                    drop(records);
                    span.read(worker)
                }
                SemanticPayloadSource::Pieces => {
                    let mut bytes: Vec<u8> = first
                        .try_get::<Option<Vec<u8>>, _>("bytes")?
                        .ok_or_else(|| invalid("semantic payload is missing"))?;
                    while let Some(piece) = records.try_next().await? {
                        let piece: Vec<u8> = piece.try_get("bytes")?;
                        bytes.extend_from_slice(&piece);
                    }
                    Ok(serde_json::from_slice(&bytes)?)
                }
            }
        })
    })
    .await
}

pub(crate) async fn resolve(
    connection: &mut SqliteConnection,
    rows: Vec<SemanticRow>,
) -> Result<Vec<ResolvedRow>, StoreError> {
    let mut resolved = Vec::with_capacity(rows.len());
    for row in rows {
        let value = match &row.kind {
            SemanticKind::UnknownTool { .. } => None,
            SemanticKind::AssistantPart {
                payload:
                    PartPayload::Text {
                        part,
                        end,
                        text_kind,
                    },
                ..
            } => {
                let mut text = String::new();
                let mut options = None;
                let mut after = 0i64;
                loop {
                    let keys:Vec<(i64,i64)>=sqlx::query_as("SELECT source_sequence,source_index FROM context_semantic_fragments WHERE part_sequence=? AND part_index=? AND source_sequence>? AND source_sequence<=? ORDER BY source_sequence,source_index LIMIT 128")
                        .bind(part.source_sequence as i64).bind(part.item_index as i64).bind(after).bind(*end as i64).fetch_all(&mut *connection).await?;
                    if keys.is_empty() {
                        break;
                    }
                    for (sequence, index) in keys {
                        let Payload::TextDelta {
                            text: delta,
                            provider_options,
                        } = payload(
                            connection,
                            RowPosition {
                                source_sequence: crate::sequence_number(sequence)?,
                                item_index: crate::sequence_number(index)?,
                            },
                        )
                        .await?
                        else {
                            return Err(invalid("streamed text has a non-text fragment"));
                        };
                        text.push_str(&delta);
                        maka_agent_facts::model::merge_provider_options(
                            &mut options,
                            provider_options,
                        );
                        after = sequence;
                    }
                }
                Some(Payload::Part(maka_agent_facts::model::ModelPart::Text {
                    text_kind: *text_kind,
                    text,
                    provider_options: options,
                }))
            }
            SemanticKind::AssistantPart {
                payload: PartPayload::Complete(key),
                ..
            }
            | SemanticKind::User { payload: key, .. }
            | SemanticKind::ImportedUser { payload: key }
            | SemanticKind::ImportedAssistant { payload: key }
            | SemanticKind::ExecutorText { payload: key }
            | SemanticKind::ToolResult { payload: key, .. }
            | SemanticKind::Notification { payload: key, .. } => {
                Some(payload(connection, *key).await?)
            }
        };
        resolved.push(ResolvedRow {
            row,
            payload: value,
        });
    }
    Ok(resolved)
}

impl EventLog {
    pub async fn context_semantic_rows(
        &self,
        selection: &SemanticSelection,
        cursor: Option<SemanticCursor>,
        limit: usize,
    ) -> Result<SemanticPage, StoreError> {
        self.validate_root()?;
        let selection = selection.clone();
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move { rows(connection, &selection, cursor, limit, None).await })
            })
            .await
    }

    pub async fn context_semantic_group_rows(
        &self,
        selection: &SemanticSelection,
        group: u64,
        cursor: Option<SemanticCursor>,
        limit: usize,
    ) -> Result<SemanticPage, StoreError> {
        self.validate_root()?;
        let selection = selection.clone();
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(
                    async move { rows(connection, &selection, cursor, limit, Some(group)).await },
                )
            })
            .await
    }

    pub async fn context_semantic_changes(
        &self,
        selection: &SemanticSelection,
        since_revision: u64,
        cursor: Option<SemanticChangeCursor>,
        limit: usize,
    ) -> Result<SemanticChangePage, StoreError> {
        self.validate_root()?;
        let selection = selection.clone();
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    changes(connection, &selection, since_revision, cursor, limit).await
                })
            })
            .await
    }

    /// Explicit materialization boundary for one dirty/rendered group.
    pub async fn context_semantic_resolve(
        &self,
        rows: &[SemanticRow],
    ) -> Result<Vec<ResolvedRow>, StoreError> {
        self.validate_root()?;
        let rows = rows.to_vec();
        self.connection
            .read_interruptible(move |connection| {
                Box::pin(async move {
                    let mut transaction = connection.begin().await?;
                    let resolved = resolve(&mut transaction, rows).await?;
                    transaction.commit().await?;
                    Ok(resolved)
                })
            })
            .await
    }

    pub async fn context_semantic_stable_cut(
        &self,
        owner: &str,
        invocation: &str,
        through: u64,
    ) -> Result<Option<RowPosition>, StoreError> {
        self.validate_root()?;
        let invocation = invocation.to_owned();
        let owner = owner.to_owned();
        self.connection.read_interruptible(move |connection|Box::pin(async move {
            let cut:Option<(i64,i64)>=sqlx::query_as("SELECT cut_sequence,cut_index FROM context_semantic_cuts WHERE owner_session_id=? AND invocation_id=? AND revision<=? ORDER BY revision DESC LIMIT 1")
                .bind(owner).bind(invocation).bind(through as i64).fetch_optional(connection).await?;
            cut.map(|(sequence,index)|Ok(RowPosition { source_sequence:crate::sequence_number(sequence)?,item_index:crate::sequence_number(index)? })).transpose()
        })).await
    }
}
