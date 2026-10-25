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

//! Indexed immutable history text. Session authority stays with RootStore.

use crate::{EventLog, StoreError};
use maka_agent_facts::{attachment::AttachmentRef, history::RowPosition};
use maka_agent_ports::session::history::Role;
use rusqlite::{Connection as RawConnection, params};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet},
    fmt::Write,
};
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;

pub(crate) mod maintenance;

#[derive(Clone)]
pub struct SearchQuery {
    pub terms: Vec<String>,
    pub session_id: Option<String>,
    pub since: Option<u64>,
    pub until: Option<u64>,
    pub exclude: Option<(String, String)>,
    pub limit: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct SearchHit {
    pub session_id: String,
    pub message_id: String,
    pub position: RowPosition,
    pub turn_id: String,
    pub timestamp: u64,
    pub role: Role,
    pub body: String,
    pub attachments: Vec<AttachmentRef>,
    pub matched_terms: Vec<String>,
    pub score: f64,
    pub through: u64,
}

pub struct SearchBatch {
    pub hits: Vec<SearchHit>,
    pub gaps: Vec<String>,
}

pub struct SearchContext {
    pub anchor: SearchHit,
    /// Neighbors in source order, without a second copy of the anchor.
    pub messages: Vec<SearchHit>,
    pub has_more_before: bool,
    pub has_more_after: bool,
}

pub(crate) fn fold(text: &str) -> String {
    text.nfc().collect::<String>().to_lowercase()
}

fn token(chars: &[char]) -> String {
    let mut result = String::with_capacity(1 + 4 * chars.len());
    result.push('g');
    for ch in chars {
        let mut value = *ch as u32;
        let mut encoded = [b'0'; 4];
        for digit in encoded.iter_mut().rev() {
            *digit = b"0123456789abcdefghijklmnopqrstuvwxyz"[(value % 36) as usize];
            value /= 36;
        }
        for byte in encoded {
            result.push(char::from(byte));
        }
    }
    result
}

pub(crate) fn grams(text: &str) -> String {
    let chars: Vec<_> = text.chars().collect();
    let mut result = String::new();
    for size in 1..=3.min(chars.len()) {
        for window in chars.windows(size) {
            if !result.is_empty() {
                result.push(' ');
            }
            result.push_str(&token(window));
        }
    }
    result
}

pub(crate) fn normalize_query(input: &mut SearchQuery) -> Result<(), StoreError> {
    if input.terms.is_empty()
        || input
            .terms
            .iter()
            .any(|term| term.trim().is_empty() || term.contains('\0'))
        || input.limit == Some(0)
        || input.since.zip(input.until).is_some_and(|(a, b)| a > b)
    {
        return Err(invalid("invalid history search"));
    }
    let mut seen = BTreeSet::new();
    input.terms = input
        .terms
        .iter()
        .map(|term| fold(term.trim()))
        .filter(|term| seen.insert(term.clone()))
        .collect();
    if let Some(session) = &input.session_id {
        crate::sessions::validate_id(session)?;
    }
    Ok(())
}

fn expression(terms: &[String]) -> String {
    terms
        .iter()
        .map(|term| {
            let chars: Vec<_> = term.chars().collect();
            let tokens: BTreeSet<_> = chars.windows(3.min(chars.len())).map(token).collect();
            format!("({})", tokens.into_iter().collect::<Vec<_>>().join(" AND "))
        })
        .collect::<Vec<_>>()
        .join(" OR ")
}

#[derive(Clone)]
struct Rank {
    score: f64,
    timestamp: u64,
    message_id: String,
    session_id: String,
    turn_id: String,
}
impl Rank {
    fn of(hit: &SearchHit) -> Self {
        Self {
            score: hit.score,
            timestamp: hit.timestamp,
            message_id: hit.message_id.clone(),
            session_id: hit.session_id.clone(),
            turn_id: hit.turn_id.clone(),
        }
    }
    fn turn(&self) -> (String, String) {
        (self.session_id.clone(), self.turn_id.clone())
    }
}
impl PartialEq for Rank {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for Rank {}
impl PartialOrd for Rank {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Rank {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .score
            .total_cmp(&self.score)
            .then_with(|| other.timestamp.cmp(&self.timestamp))
            .then_with(|| self.message_id.cmp(&other.message_id))
            .then_with(|| self.session_id.cmp(&other.session_id))
            .then_with(|| self.turn_id.cmp(&other.turn_id))
    }
}

pub(crate) struct Ranked {
    hits: BTreeMap<(String, String), SearchHit>,
    order: BTreeSet<Rank>,
    limit: Option<usize>,
}
impl Ranked {
    pub(crate) fn new(limit: Option<usize>) -> Self {
        Self {
            hits: BTreeMap::new(),
            order: BTreeSet::new(),
            limit,
        }
    }
    pub(crate) fn push(&mut self, hit: SearchHit) {
        let rank = Rank::of(&hit);
        let turn = rank.turn();
        if let Some(prior) = self.hits.get(&turn) {
            let old = Rank::of(prior);
            if rank >= old {
                return;
            }
            self.order.remove(&old);
        }
        self.hits.insert(turn, hit);
        self.order.insert(rank);
        if self.limit.is_some_and(|limit| self.order.len() > limit) {
            let removed = self.order.pop_last().expect("nonempty ranked history");
            self.hits.remove(&removed.turn());
        }
    }
    pub(crate) fn finish(
        mut self,
        cancellation: &CancellationToken,
    ) -> Result<Vec<SearchHit>, StoreError> {
        let mut hits = Vec::with_capacity(self.hits.len());
        for rank in self.order {
            check(cancellation)?;
            hits.push(
                self.hits
                    .remove(&rank.turn())
                    .expect("ranked history identity"),
            );
        }
        check(cancellation)?;
        Ok(hits)
    }
}

const COLUMNS: &str = "d.session_id,d.message_id,d.source_sequence,d.item_index,d.turn_id,d.timestamp,d.role,d.body,d.attachments";
const VISIBLE:&str="JOIN session_control s ON s.id=d.session_id JOIN root_control.session_routes r ON r.session_id=s.id
    WHERE r.partition=?1 AND r.ready=1 AND r.visible=1 AND instr(d.session_id,?2)=1
    AND NOT EXISTS(SELECT 1 FROM session_retirements retired WHERE retired.session_id=s.id AND retired.remove_session=1)";

fn hit(row: &rusqlite::Row<'_>, through: u64) -> Result<SearchHit, StoreError> {
    let role: String = row.get(6)?;
    let role = match role.as_str() {
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool_call" => Role::ToolCall,
        "tool_result" => Role::ToolResult,
        "context_compacted" => Role::Compaction,
        "turn_state" | "model_interruption" => Role::Failure,
        _ => return Err(invalid("unsupported history search role")),
    };
    let attachments: String = row.get(8)?;
    Ok(SearchHit {
        session_id: row.get(0)?,
        message_id: row.get(1)?,
        position: RowPosition {
            source_sequence: crate::sequence_number(row.get(2)?)?,
            item_index: crate::sequence_number(row.get(3)?)?,
        },
        turn_id: row.get(4)?,
        timestamp: crate::sequence_number(row.get(5)?)?,
        role,
        body: row.get(7)?,
        attachments: serde_json::from_str(&attachments)?,
        matched_terms: Vec::new(),
        score: 0.0,
        through,
    })
}

fn fence(db: &RawConnection) -> Result<u64, StoreError> {
    crate::sequence_number(
        db.prepare_cached("SELECT COALESCE(MAX(sequence),0) FROM event_log")?
            .query_row([], |row| row.get(0))?,
    )
}

fn number(value: u64) -> Result<i64, StoreError> {
    i64::try_from(value).map_err(|_| invalid("history value exceeds SQLite integer range"))
}
fn cancelled() -> StoreError {
    invalid("history search cancelled")
}
fn check(cancel: &CancellationToken) -> Result<(), StoreError> {
    if cancel.is_cancelled() {
        Err(cancelled())
    } else {
        Ok(())
    }
}
fn invalid(reason: &str) -> StoreError {
    StoreError::InvalidTransition(reason.into())
}

fn search_on_handle(
    db: &RawConnection,
    partition: usize,
    prefix: &str,
    input: SearchQuery,
    cancellation: &CancellationToken,
) -> Result<SearchBatch, StoreError> {
    check(cancellation)?;
    let through = fence(db)?;
    let through_sql = number(through)?;
    let mut gaps = Vec::new();
    let mut incomplete = BTreeSet::new();
    let mut failed = db.prepare_cached(
        "SELECT f.session_id,f.source_sequence,f.category,COALESCE(f.reason,'source unavailable')
         FROM transcript_failures f JOIN session_control s ON s.id=f.session_id
         JOIN root_control.session_routes r ON r.session_id=s.id
         WHERE r.partition=?1 AND r.ready=1 AND r.visible=1 AND instr(f.session_id,?2)=1
           AND (?3 IS NULL OR f.session_id=?3) AND f.source_sequence<=?4
           AND NOT EXISTS(SELECT 1 FROM session_retirements retired WHERE retired.session_id=s.id AND retired.remove_session=1)
         ORDER BY f.session_id,f.source_sequence",
    )?;
    let mut failures = failed.query(params![
        partition as i64,
        prefix,
        input.session_id,
        through_sql
    ])?;
    while let Some(row) = failures.next()? {
        check(cancellation)?;
        let session: String = row.get(0)?;
        if incomplete.insert(session.clone()) {
            gaps.push(format!(
                "Session {session} was not fully read: history source {}: {}: {}",
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ));
        }
    }
    let query = format!(
        "SELECT {COLUMNS},d.folded,bm25(recall_terms)
         FROM recall_terms JOIN recall_documents d ON d.id=recall_terms.rowid {VISIBLE}
         AND recall_terms MATCH ?3 AND (?4 IS NULL OR d.session_id=?4)
         AND (?5 IS NULL OR d.timestamp>=?5) AND (?6 IS NULL OR d.timestamp<=?6)
         AND NOT(d.session_id=COALESCE(?7,'') AND d.turn_id=COALESCE(?8,''))
         AND d.source_sequence<=?9
         AND NOT EXISTS(SELECT 1 FROM transcript_failures f WHERE f.session_id=d.session_id AND f.source_sequence<=?9)"
    );
    let exclude = input.exclude.as_ref();
    let mut statement = db.prepare_cached(&query)?;
    let mut rows = statement.query(params![
        partition as i64,
        prefix,
        expression(&input.terms),
        input.session_id,
        input.since.map(number).transpose()?,
        input.until.map(number).transpose()?,
        exclude.map(|x| x.0.as_str()),
        exclude.map(|x| x.1.as_str()),
        through_sql,
    ])?;
    let mut ranked = Ranked::new(input.limit);
    while let Some(row) = rows.next()? {
        check(cancellation)?;
        let folded: String = row.get(9)?;
        let matched_terms: Vec<_> = input
            .terms
            .iter()
            .filter(|term| folded.contains(term.as_str()))
            .cloned()
            .collect();
        if matched_terms.is_empty() {
            continue;
        }
        let mut found = hit(row, through)?;
        found.matched_terms = matched_terms;
        found.score = -row.get::<_, f64>(10)?
            * if found.role == Role::ToolResult {
                0.5
            } else {
                1.0
            };
        ranked.push(found);
    }
    check(cancellation)?;
    Ok(SearchBatch {
        hits: ranked.finish(cancellation)?,
        gaps,
    })
}

#[allow(clippy::too_many_arguments)]
fn context_on_handle(
    db: &RawConnection,
    partition: usize,
    prefix: &str,
    session: &str,
    message: &str,
    before: usize,
    after: usize,
    through: Option<u64>,
    exclude: Option<(String, String)>,
    cancellation: &CancellationToken,
) -> Result<SearchContext, StoreError> {
    check(cancellation)?;
    let high_water = fence(db)?;
    let through = through.unwrap_or(high_water);
    if through > high_water {
        return Err(invalid("history context fence exceeds committed history"));
    }
    let through_sql = number(through)?;
    let failed: bool = db.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM transcript_failures WHERE session_id=?1 AND source_sequence<=?2)"
    )?.query_row(params![session,through_sql],|row|row.get(0))?;
    if failed {
        return Err(invalid("history context source is incomplete"));
    }
    let exclusion = exclude.as_ref();
    let query = format!(
        "SELECT {COLUMNS} FROM recall_documents d {VISIBLE}
         AND d.session_id=?3 AND d.message_id=?4 AND d.source_sequence<=?5
         AND NOT(d.session_id=COALESCE(?6,'') AND d.turn_id=COALESCE(?7,''))"
    );
    let anchor = {
        let mut statement = db.prepare_cached(&query)?;
        let mut rows = statement.query(params![
            partition as i64,
            prefix,
            session,
            message,
            through_sql,
            exclusion.map(|x| x.0.as_str()),
            exclusion.map(|x| x.1.as_str()),
        ])?;
        let row = rows
            .next()?
            .ok_or_else(|| invalid("history context anchor is unavailable"))?;
        hit(row, through)?
    };
    let mut messages = Vec::new();
    let mut more = [false, false];
    for (side, count) in [before, after].into_iter().enumerate() {
        check(cancellation)?;
        let order = if side == 0 { "DESC" } else { "ASC" };
        let comparison = if side == 0 { "<" } else { ">" };
        let mut query = format!(
            "SELECT d.source_sequence,d.item_index FROM recall_documents d INDEXED BY recall_document_context {VISIBLE}
             AND d.session_id=?3 AND d.source_sequence<=?4
             AND (d.source_sequence,d.item_index){comparison}(?5,?6)
             AND NOT(d.session_id=COALESCE(?7,'') AND d.turn_id=COALESCE(?8,''))
             AND (d.body<>'' OR d.role IN('tool_call','tool_result'))
             ORDER BY d.source_sequence {order},d.item_index {order}"
        );
        // One lookahead reports continuation without copying another large body.
        write!(
            &mut query,
            " LIMIT {}",
            count.saturating_add(1).min(i64::MAX as usize)
        )
        .expect("format history context query");
        let mut statement = db.prepare_cached(&query)?;
        let mut rows = statement.query(params![
            partition as i64,
            prefix,
            session,
            through_sql,
            number(anchor.position.source_sequence)?,
            number(anchor.position.item_index)?,
            exclusion.map(|x| x.0.as_str()),
            exclusion.map(|x| x.1.as_str()),
        ])?;
        let mut seen = 0;
        while let Some(row) = rows.next()? {
            check(cancellation)?;
            if seen == count {
                more[side] = true;
                break;
            }
            let source: i64 = row.get(0)?;
            let item: i64 = row.get(1)?;
            let mut full = db.prepare_cached(&format!(
                "SELECT {COLUMNS} FROM recall_documents d WHERE d.session_id=?1 AND d.source_sequence=?2 AND d.item_index=?3"
            ))?;
            let mut full_rows = full.query(params![session, source, item])?;
            let full_row = full_rows.next()?.ok_or(StoreError::TranscriptConflict)?;
            messages.push(hit(full_row, through)?);
            seen += 1;
        }
    }
    messages.sort_by_key(|message| {
        (
            message.position.source_sequence,
            message.position.item_index,
        )
    });
    check(cancellation)?;
    Ok(SearchContext {
        anchor,
        messages,
        has_more_before: more[0],
        has_more_after: more[1],
    })
}

impl EventLog {
    pub(crate) async fn search_history_partition(
        &self,
        partition: usize,
        prefix: String,
        input: SearchQuery,
        cancellation: CancellationToken,
    ) -> Result<SearchBatch, StoreError> {
        self.validate_root()?;
        let stop = cancellation.clone();
        let read = self.connection.read_interruptible(move |db| {
            Box::pin(async move {
                let mut tx = sqlx::Connection::begin(db).await?;
                let result = tx
                    .run_on_worker(move |handle| {
                        // SAFETY: callback-local exclusive borrow; no SQLite-backed values escape.
                        let db = unsafe { RawConnection::from_handle(handle.as_ptr()) }?;
                        search_on_handle(&db, partition, &prefix, input, &stop)
                    })
                    .await??;
                tx.commit().await?;
                Ok(result)
            })
        });
        tokio::select! {biased; _=cancellation.cancelled()=>Err(cancelled()), result=read=>result}
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn history_context_partition(
        &self,
        partition: usize,
        prefix: String,
        session: String,
        message: String,
        before: usize,
        after: usize,
        through: Option<u64>,
        exclude: Option<(String, String)>,
        cancellation: CancellationToken,
    ) -> Result<SearchContext, StoreError> {
        self.validate_root()?;
        let stop = cancellation.clone();
        let read = self.connection.read_interruptible(move |db| {
            Box::pin(async move {
                let mut tx = sqlx::Connection::begin(db).await?;
                let result = tx
                    .run_on_worker(move |handle| {
                        // SAFETY: callback-local exclusive borrow; all returned history values are owned.
                        let db = unsafe { RawConnection::from_handle(handle.as_ptr()) }?;
                        context_on_handle(
                            &db, partition, &prefix, &session, &message, before, after, through,
                            exclude, &stop,
                        )
                    })
                    .await??;
                tx.commit().await?;
                Ok(result)
            })
        });
        tokio::select! {biased; _=cancellation.cancelled()=>Err(cancelled()), result=read=>result}
    }
}
