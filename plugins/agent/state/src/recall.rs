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
//! Search is a derived view over exact Agent history, never an execution source.
use crate::{
    session_catalog::{Record, SessionCatalog},
    session_history::HistoryCut,
    store::invalid,
};
use maka_agent_facts::{attachment::AttachmentRef, durable::*, history::RowPosition};
use maka_event_log::{
    StoreError,
    connection::Query,
    root_store::DataWriter,
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;
pub(crate) mod document;
mod find;
pub(crate) use find::{
    FindWork, find_index, landmark_ranks, landmarks_count_index, landmarks_selected_index,
};
mod index;
mod query;
pub(crate) use query::checked_source_cut;
pub(crate) mod terms;
pub use find::{Find, FindPage, Found, Landmark};
pub(crate) use index::{index_fact, index_sources};

fn number(n: u64) -> Result<i64, StoreError> {
    i64::try_from(n).map_err(|_| invalid("Recall value exceeds SQLite range"))
}
fn unsigned(n: i64) -> Result<u64, StoreError> {
    u64::try_from(n).map_err(|_| invalid("negative Recall source value"))
}
fn check(stop: &CancellationToken) -> Result<(), StoreError> {
    if stop.is_cancelled() {
        Err(invalid("Recall cancelled"))
    } else {
        Ok(())
    }
}
fn fold(s: &str) -> String {
    s.nfc().collect::<String>().to_lowercase()
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
    ToolCall,
    ToolResult,
    Compaction,
    Failure,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Field {
    Body,
    Thinking,
    ToolName,
    FailureMessage,
    ErrorClass,
    Arguments,
    Result,
    Receipt,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FieldSpan {
    pub field: Field,
    pub start: usize,
    pub end: usize,
    pub internal: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Message {
    pub message_id: String,
    pub position: RowPosition,
    pub run: RunId,
    pub turn_id: String,
    pub timestamp: u64,
    pub role: Role,
    pub body: String,
    pub attachments: Vec<AttachmentRef>,
    pub references: Vec<ContentRef>,
    pub fields: Vec<FieldSpan>,
    pub origin: Option<maka_agent_facts::message::MessageOrigin>,
}
#[derive(Clone)]
pub struct ExcludedTail {
    pub session_id: String,
    pub turn_id: String,
    pub covered_through: u64,
}
#[derive(Clone)]
pub struct SearchQuery {
    pub terms: Vec<String>,
    pub session_id: Option<String>,
    pub since: Option<u64>,
    pub until: Option<u64>,
    pub exclude: Option<ExcludedTail>,
    pub limit: Option<usize>,
}
impl SearchQuery {
    fn normalize(&mut self) -> Result<(), StoreError> {
        if self.terms.is_empty()
            || self.limit == Some(0)
            || self.since.zip(self.until).is_some_and(|(a, b)| a > b)
        {
            return Err(invalid("invalid Recall query"));
        }
        let mut seen = BTreeSet::new();
        let mut terms = vec![];
        for term in &self.terms {
            if term.trim().is_empty() || term.contains('\0') {
                return Err(invalid("empty Recall term"));
            }
            let term = fold(term.trim());
            if seen.insert(term.clone()) {
                terms.push(term);
            }
        }
        self.terms = terms;
        self.since.map(number).transpose()?;
        self.until.map(number).transpose()?;
        Ok(())
    }
}
#[derive(Clone, Debug)]
pub struct Hit {
    pub session: Record,
    pub cut: HistoryCut,
    pub anchor: Message,
    pub messages: Vec<Message>,
    pub matched_terms: Vec<String>,
    pub score: f64,
    pub has_more_before: bool,
    pub has_more_after: bool,
}
pub struct Batch {
    pub titles: Vec<Record>,
    pub hits: Vec<Hit>,
    pub gaps: Vec<String>,
}
pub struct Context {
    pub session: Record,
    pub cut: HistoryCut,
    pub anchor: Message,
    pub messages: Vec<Message>,
    pub has_more_before: bool,
    pub has_more_after: bool,
}
#[derive(Clone)]
pub struct RecallStore {
    data: DataWriter,
    owner: RunOwner,
    prefix: String,
}
#[derive(Clone, Copy)]
pub struct ContextWindow {
    pub before: usize,
    pub after: usize,
}

impl RecallStore {
    pub fn new(data: DataWriter, owner: RunOwner, prefix: String) -> Result<Self, StoreError> {
        SessionCatalog::new(data.clone(), owner.clone(), prefix.clone())?;
        Ok(Self {
            data,
            owner,
            prefix,
        })
    }
    pub async fn validate_execution(&self, execution: ExecutionIdentity) -> Result<(), StoreError> {
        self.data
            .query(VerifyExecution(self.clone(), execution))
            .await
    }
    pub async fn capture(
        &self,
        session: String,
        through: Option<u64>,
    ) -> Result<HistoryCut, StoreError> {
        self.data
            .query(Capture(self.clone(), session, through))
            .await
    }
    pub async fn positions(
        &self,
        cut: HistoryCut,
        anchor: Option<RowPosition>,
        reverse: bool,
        include_internal: bool,
        limit: u32,
        stop: CancellationToken,
    ) -> Result<Vec<RowPosition>, StoreError> {
        self.data
            .query(find::ReadPositions(
                self.clone(),
                cut,
                anchor,
                reverse,
                include_internal,
                limit,
                stop,
            ))
            .await
    }
    pub async fn find_page(
        &self,
        cut: HistoryCut,
        input: Find,
        stop: CancellationToken,
    ) -> Result<FindPage, StoreError> {
        self.data
            .query(find::ReadFind(self.clone(), cut, input, stop))
            .await
    }
    pub async fn landmarks(
        &self,
        cut: HistoryCut,
        limit: u32,
        stop: CancellationToken,
    ) -> Result<Vec<Landmark>, StoreError> {
        self.data
            .query(find::ReadLandmarks(self.clone(), cut, limit, stop))
            .await
    }
    pub async fn search(
        &self,
        mut query: SearchQuery,
        before: usize,
        after: usize,
        stop: CancellationToken,
    ) -> Result<Batch, StoreError> {
        query.normalize()?;
        self.data
            .query(Search(self.clone(), query, before, after, stop))
            .await
    }
    pub async fn context(
        &self,
        session: String,
        anchor: String,
        window: ContextWindow,
        cut: Option<HistoryCut>,
        exclude: Option<ExcludedTail>,
        stop: CancellationToken,
    ) -> Result<Context, StoreError> {
        self.data
            .query(ReadContext(
                self.clone(),
                session,
                anchor,
                window.before,
                window.after,
                cut,
                exclude,
                stop,
            ))
            .await
    }
    pub async fn rebuild(&self, session: String) -> Result<(), StoreError> {
        self.data.write(Rebuild(self.clone(), session)).await
    }
    pub async fn exclusion(&self, run: RunId) -> Result<ExcludedTail, StoreError> {
        self.data.query(Exclusion(self.clone(), run)).await
    }
    fn session(&self, id: &str) -> Result<(), StoreError> {
        maka_agent_facts::interaction::entity_id(id).map_err(invalid)?;
        if !id.starts_with(&self.prefix) {
            return Err(StoreError::SessionNotFound);
        }
        Ok(())
    }
    fn key(&self) -> Result<String, StoreError> {
        Ok(serde_json::to_string(&self.owner)?)
    }
    fn catalog(&self) -> Result<SessionCatalog, StoreError> {
        SessionCatalog::new(self.data.clone(), self.owner.clone(), self.prefix.clone())
    }
}
struct VerifyExecution(RecallStore, ExecutionIdentity);
impl Query for VerifyExecution {
    type Output = ();
    fn execute(self, c: &Connection) -> Result<(), StoreError> {
        self.0.session(&self.1.session_id)?;
        let view = crate::sql::load(c, self.1.run_id, &[], false)?;
        if view.spec.owner != self.0.owner
            || view.spec.session_id != self.1.session_id
            || view.spec.turn_id != self.1.turn_id
        {
            return Err(invalid("Recall Run belongs to another owner or Session"));
        }
        if view.terminal.is_some() || view.stopped {
            return Err(invalid("Recall Run closed"));
        }
        let record = crate::session_catalog::records_in_snapshot(
            c,
            &self.0.catalog()?,
            &[self.1.session_id],
        )?
        .pop()
        .ok_or(StoreError::SessionNotFound)?;
        if record.metadata.archived {
            return Err(invalid("Recall Session archived"));
        }
        Ok(())
    }
}
struct Capture(RecallStore, String, Option<u64>);
impl Query for Capture {
    type Output = HistoryCut;
    fn execute(self, c: &Connection) -> Result<HistoryCut, StoreError> {
        self.0.session(&self.1)?;
        crate::session_history::capture_at(c, &self.0.owner, &self.1, self.2)
    }
}
struct Search(RecallStore, SearchQuery, usize, usize, CancellationToken);
impl Query for Search {
    type Output = Batch;
    fn execute(self, c: &Connection) -> Result<Batch, StoreError> {
        query::search(c, self)
    }
}
struct ReadContext(
    RecallStore,
    String,
    String,
    usize,
    usize,
    Option<HistoryCut>,
    Option<ExcludedTail>,
    CancellationToken,
);
impl Query for ReadContext {
    type Output = Context;
    fn execute(self, c: &Connection) -> Result<Context, StoreError> {
        query::context(c, self)
    }
}
struct Exclusion(RecallStore, RunId);
impl Query for Exclusion {
    type Output = ExcludedTail;
    fn execute(self, c: &Connection) -> Result<ExcludedTail, StoreError> {
        query::exclusion(c, &self.0, self.1)
    }
}
struct Rebuild(RecallStore, String);
impl Statement for Rebuild {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        index::rebuild(c, &self.0, &self.1)?;
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::METADATA.with_sessions([self.1]),
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(e: &StoreError) -> bool {
        matches!(
            e,
            StoreError::InvalidTransition(_) | StoreError::EventConflict | StoreError::Json(_)
        )
    }
}
