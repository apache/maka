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
use rusqlite::{Connection as RawConnection, OptionalExtension, params};
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, HashSet},
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

const GRAM_BITS: u32 = 21;

fn append_token(result: &mut String, key: u64) {
    result.push('g');
    for shift in [2 * GRAM_BITS, GRAM_BITS, 0] {
        let scalar = (key >> shift) & ((1 << GRAM_BITS) - 1);
        if scalar == 0 {
            continue;
        }
        let mut value = scalar - 1;
        let mut encoded = [b'0'; 4];
        for digit in encoded.iter_mut().rev() {
            *digit = b"0123456789abcdefghijklmnopqrstuvwxyz"[(value % 36) as usize];
            value /= 36;
        }
        for byte in encoded {
            result.push(char::from(byte));
        }
    }
}

fn gram_keys(text: &str, minimum: u32) -> Vec<u64> {
    let mut keys = {
        let mut unique = HashSet::<u64>::new();
        let mut window = 0;
        let mut available = 0;
        for scalar in text.chars() {
            // Three nonzero 21-bit lanes fit in 63 bits, including U+0000 as 1.
            window = ((window << GRAM_BITS) | (u64::from(u32::from(scalar)) + 1)) & (u64::MAX >> 1);
            available = (available + 1).min(3);
            for size in minimum..=available {
                unique.insert(window & ((1 << (size * GRAM_BITS)) - 1));
            }
        }
        unique.into_iter().collect::<Vec<_>>()
    };
    keys.sort_unstable();
    keys
}

pub(crate) fn grams(text: &str) -> String {
    let keys = gram_keys(text, 1);
    let mut result = String::new();
    for key in keys {
        if !result.is_empty() {
            result.push(' ');
        }
        append_token(&mut result, key);
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

struct LiteralTerm<'a> {
    text: &'a str,
    scalars: usize,
}

fn expression(terms: &[LiteralTerm<'_>]) -> String {
    let mut result = String::new();
    for term in terms {
        if !result.is_empty() {
            result.push_str(" OR ");
        }
        result.push('(');
        for (index, key) in gram_keys(term.text, term.scalars.min(3) as u32)
            .into_iter()
            .enumerate()
        {
            if index != 0 {
                result.push_str(" AND ");
            }
            append_token(&mut result, key);
        }
        result.push(')');
    }
    result
}

fn literal_density(
    folded: &str,
    terms: &[LiteralTerm<'_>],
    cancellation: &CancellationToken,
) -> Result<(Vec<String>, f64), StoreError> {
    let mut matched = Vec::new();
    let mut coverage = 0.0;
    for term in terms {
        check(cancellation)?;
        let mut occurrences = 0usize;
        for _ in folded.matches(term.text) {
            check(cancellation)?;
            occurrences += 1;
        }
        if occurrences != 0 {
            matched.push(term.text.to_owned());
            coverage += occurrences as f64 * term.scalars as f64;
        }
    }
    let score = if matched.is_empty() {
        0.0
    } else {
        check(cancellation)?;
        coverage / folded.chars().count() as f64
    };
    check(cancellation)?;
    Ok((matched, score))
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

const COLUMNS: &str =
    "d.session_id,d.message_id,d.source_sequence,d.item_index,d.turn_id,d.timestamp,d.role";
// Indexed candidates must drive scope checks, rather than probing FTS for every session document.
const VISIBLE:&str="CROSS JOIN root_control.session_routes r ON r.session_id=s.id
    WHERE r.partition=?1 AND r.ready=1 AND r.visible=1 AND instr(s.id,?2)=1
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

fn render_hit(
    db: &RawConnection,
    session: &str,
    source: i64,
    item: i64,
    message: &maka_presentation::Message,
    through: u64,
) -> Result<SearchHit, StoreError> {
    let query = format!(
        "WITH source(payload) AS (VALUES(?4)) SELECT {COLUMNS},{},
             CASE WHEN d.role='user' THEN COALESCE(json_extract(payload,'$.attachments'),'[]') ELSE '[]' END
         FROM transcript_directory d,source
         WHERE d.session_id=?1 AND d.source_sequence=?2 AND d.item_index=?3",
        crate::transcript::directory::RECALL_BODY,
    );
    let payload = serde_json::to_vec(message)?;
    let mut statement = db.prepare_cached(&query)?;
    let mut rows = statement.query(params![session, source, item, payload])?;
    hit(rows.next()?.ok_or(StoreError::TranscriptConflict)?, through)
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
    through: u64,
    cancellation: &CancellationToken,
) -> Result<SearchBatch, StoreError> {
    check(cancellation)?;
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
    let terms: Vec<_> = input
        .terms
        .iter()
        .map(|term| LiteralTerm {
            text: term,
            scalars: term.chars().count(),
        })
        .collect();
    let query = format!(
        "SELECT {COLUMNS}
         FROM recall_terms CROSS JOIN transcript_directory d ON d.rowid=recall_terms.rowid CROSS JOIN session_control s ON s.id=d.session_id {VISIBLE}
         AND recall_terms MATCH ?3 AND (?4 IS NULL OR d.session_id=?4)
         AND (?5 IS NULL OR d.timestamp>=?5) AND (?6 IS NULL OR d.timestamp<=?6)
         AND NOT(d.session_id=COALESCE(?7,'') AND d.turn_id=COALESCE(?8,''))
         AND d.source_sequence<=?9
         AND NOT EXISTS(SELECT 1 FROM transcript_failures f WHERE f.session_id=d.session_id AND f.source_sequence<=?9)
         ORDER BY d.session_id,d.source_sequence,d.item_index"
    );
    let exclude = input.exclude.as_ref();
    let mut statement = db.prepare_cached(&query)?;
    let mut rows = statement.query(params![
        partition as i64,
        prefix,
        expression(&terms),
        input.session_id,
        input.since.map(number).transpose()?,
        input.until.map(number).transpose()?,
        exclude.map(|x| x.0.as_str()),
        exclude.map(|x| x.1.as_str()),
        through_sql,
    ])?;
    let mut ranked = Ranked::new(input.limit);
    let mut source_rows: Option<((String, i64), Vec<maka_presentation::Row>)> = None;
    while let Some(row) = rows.next()? {
        check(cancellation)?;
        let session: String = row.get(0)?;
        let source: i64 = row.get(2)?;
        let item: i64 = row.get(3)?;
        let key = (session, source);
        if source_rows.as_ref().is_none_or(|(prior, _)| prior != &key) {
            source_rows = Some((
                key.clone(),
                crate::transcript::directory::source_on_handle(db, &key.0, source)?,
            ));
        }
        let message: String = row.get(1)?;
        let rendered = source_rows
            .as_ref()
            .and_then(|(_, rows)| {
                rows.iter().find(|rendered| {
                    rendered.position.item_index == item as u64 && rendered.message.id == message
                })
            })
            .ok_or(StoreError::TranscriptConflict)?;
        let mut found = render_hit(db, &key.0, source, item, &rendered.message, through)?;
        let folded = fold(&found.body);
        let (matched_terms, score) = literal_density(&folded, &terms, cancellation)?;
        if matched_terms.is_empty() {
            continue;
        }
        found.matched_terms = matched_terms;
        found.score = score
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
    if maintenance::visible_sessions(db, partition, prefix, Some(session), cancellation)?.is_empty()
    {
        return Err(invalid("history context anchor is unavailable"));
    }
    crate::transcript::directory::ensure_on_handle(db, session, through)?;
    let through_sql = number(through)?;
    let failed: bool = db.prepare_cached(
        "SELECT EXISTS(SELECT 1 FROM transcript_failures WHERE session_id=?1 AND source_sequence<=?2)"
    )?.query_row(params![session,through_sql],|row|row.get(0))?;
    if failed {
        return Err(invalid("history context source is incomplete"));
    }
    let exclusion = exclude.as_ref();
    let query = format!(
        "SELECT d.source_sequence,d.item_index,d.message_id FROM transcript_directory d
         CROSS JOIN session_control s ON s.id=d.session_id {VISIBLE}
         AND d.session_id=?3 AND d.message_id=?4 AND d.source_sequence<=?5
         AND NOT(d.session_id=COALESCE(?6,'') AND d.turn_id=COALESCE(?7,''))"
    );
    let anchor: (i64, i64, String) = db
        .prepare_cached(&query)?
        .query_row(
            params![
                partition as i64,
                prefix,
                session,
                message,
                through_sql,
                exclusion.map(|x| x.0.as_str()),
                exclusion.map(|x| x.1.as_str())
            ],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?
        .ok_or_else(|| invalid("history context anchor is unavailable"))?;
    let mut selected = BTreeMap::from([((anchor.0, anchor.1), anchor.2)]);
    let mut more = [false, false];
    for (side, count) in [before, after].into_iter().enumerate() {
        check(cancellation)?;
        let order = if side == 0 { "DESC" } else { "ASC" };
        let comparison = if side == 0 { "<" } else { ">" };
        let mut query = format!(
            "SELECT d.source_sequence,d.item_index,d.message_id FROM transcript_directory d INDEXED BY transcript_context_eligible
             CROSS JOIN session_control s ON s.id=d.session_id {VISIBLE}
             AND d.session_id=?3 AND d.source_sequence<=?4
             AND (d.source_sequence,d.item_index){comparison}(?5,?6)
             AND NOT(d.session_id=COALESCE(?7,'') AND d.turn_id=COALESCE(?8,''))
             AND d.context_eligible=1
             ORDER BY d.source_sequence {order},d.item_index {order}"
        );
        // Select eligible positions, including one lookahead, before rendering bodies.
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
            anchor.0,
            anchor.1,
            exclusion.map(|x| x.0.as_str()),
            exclusion.map(|x| x.1.as_str())
        ])?;
        let mut seen = 0;
        while let Some(row) = rows.next()? {
            check(cancellation)?;
            if seen == count {
                more[side] = true;
                break;
            }
            selected.insert(
                (row.get::<_, i64>(0)?, row.get::<_, i64>(1)?),
                row.get::<_, String>(2)?,
            );
            seen += 1;
        }
    }
    let document_query = format!(
        "WITH source(payload) AS (VALUES(?4))
                 SELECT d.session_id,d.message_id,d.source_sequence,d.item_index,d.turn_id,d.timestamp,d.role,{},
                    CASE WHEN d.role='user' THEN COALESCE(json_extract(payload,'$.attachments'),'[]') ELSE '[]' END
                 FROM transcript_directory d,source WHERE d.session_id=?1 AND d.source_sequence=?2 AND d.item_index=?3",
        crate::transcript::directory::RECALL_BODY,
    );
    let mut rendered = BTreeMap::new();
    let sources: BTreeSet<_> = selected.keys().map(|(source, _)| *source).collect();
    for source in sources {
        check(cancellation)?;
        for row in crate::transcript::directory::source_on_handle(db, session, source)? {
            check(cancellation)?;
            let key = (
                number(row.position.source_sequence)?,
                number(row.position.item_index)?,
            );
            let Some(message_id) = selected.get(&key) else {
                continue;
            };
            if message_id != &row.message.id {
                return Err(StoreError::TranscriptConflict);
            }
            let payload = serde_json::to_vec(&row.message)?;
            let mut statement = db.prepare_cached(&document_query)?;
            let mut rows = statement.query(params![session, key.0, key.1, payload])?;
            let found = rows.next()?.ok_or(StoreError::TranscriptConflict)?;
            rendered.insert(key, hit(found, through)?);
        }
    }
    if rendered.len() != selected.len() {
        return Err(StoreError::TranscriptConflict);
    }
    let anchor = rendered
        .remove(&(anchor.0, anchor.1))
        .ok_or(StoreError::TranscriptConflict)?;
    check(cancellation)?;
    Ok(SearchContext {
        anchor,
        messages: rendered.into_values().collect(),
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
        let operation =
            self.search_partition_fenced(partition, prefix, input, cancellation.clone());
        tokio::select! {biased; _=cancellation.cancelled()=>Err(cancelled()), result=operation=>result}
    }

    async fn search_partition_fenced(
        &self,
        partition: usize,
        prefix: String,
        input: SearchQuery,
        cancellation: CancellationToken,
    ) -> Result<SearchBatch, StoreError> {
        let through = self
            .connection
            .read_interruptible(|connection| {
                Box::pin(async move {
                    let sequence: i64 =
                        sqlx::query_scalar("SELECT COALESCE(MAX(sequence),0) FROM event_log")
                            .fetch_one(connection)
                            .await?;
                    crate::sequence_number(sequence)
                })
            })
            .await?;
        self.search_partition_through(partition, prefix, input, through, cancellation)
            .await
    }

    pub(crate) async fn search_partition_through(
        &self,
        partition: usize,
        prefix: String,
        input: SearchQuery,
        through: u64,
        cancellation: CancellationToken,
    ) -> Result<SearchBatch, StoreError> {
        check(&cancellation)?;
        let stop = cancellation.clone();
        let operation = self.connection.observe(move |connection| {
            crate::transcript::bodycache::run(connection, move |tx| {
                Box::pin(async move {
                    tx.run_on_worker(move |handle| {
                        // SAFETY: the observation worker exclusively owns this callback-local handle.
                        let db = unsafe { RawConnection::from_handle(handle.as_ptr()) }?;
                        if through > fence(&db)? {
                            return Err(invalid("history search fence exceeds committed history"));
                        }
                        for session in maintenance::visible_sessions(
                            &db,
                            partition,
                            &prefix,
                            input.session_id.as_deref(),
                            &stop,
                        )? {
                            match maintenance::ensure_session(&db, &session, through, &stop) {
                                Ok(()) | Err(StoreError::TranscriptSource { .. }) => {}
                                Err(error) => return Err(error),
                            }
                        }
                        search_on_handle(&db, partition, &prefix, input, through, &stop)
                    })
                    .await?
                })
            })
        });
        let result = tokio::select! {biased; _=cancellation.cancelled()=>Err(cancelled()), result=operation=>result};
        self.validate_root()?;
        result
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
        let read = self.connection.observe(move |db| {
            crate::transcript::bodycache::run(db, move |tx| {
                Box::pin(async move {
                    tx.run_on_worker(move |handle| {
                        // SAFETY: callback-local exclusive borrow; all returned history values are owned.
                        let db = unsafe { RawConnection::from_handle(handle.as_ptr()) }?;
                        context_on_handle(
                            &db, partition, &prefix, &session, &message, before, after, through,
                            exclude, &stop,
                        )
                    })
                    .await?
                })
            })
        });
        tokio::select! {biased; _=cancellation.cancelled()=>Err(cancelled()), result=read=>result}
    }
}
