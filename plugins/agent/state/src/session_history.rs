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

//! Session history is a scoped read of canonical Agent facts, not a second
//! event sink. A captured prefix is immutable even when old work settles late.
use maka_agent_facts::durable::*;
use maka_event_log::{
    StoreError,
    connection::Query,
    root_store::DataWriter,
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

mod continuation;
mod fork;
pub mod inspection;
mod metrics;
pub mod navigation;
pub mod snapshot;
pub mod source_tree;
mod sql;
pub mod tool_result_source;
pub(crate) use continuation::admit_continuation;
pub(crate) use sql::{capture_at, source_content_at, sources_at, validate_cut};
pub(crate) use sql::{index, index_queue, index_retained};

pub use maka_agent_facts::history_snapshot::HistoryCut;
pub use metrics::{ModelCalibrationSample, ModelRequestRetry, SessionModelMetrics};

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryScope {
    pub step: Option<StepId>,
    pub attempt: Option<ModelAttemptId>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryItem {
    pub sequence: u64,
    pub admission_sequence: u64,
    pub scope: HistoryScope,
    /// Complete model items, result/projection refs, control and late evidence
    /// retain their original typed Run/attempt identity without reinterpretation.
    pub recorded: RecordedFact,
}
/// Read-time projection of native assistant text at a captured history cut.
#[derive(Default)]
pub struct ExecutorTranscript {
    messages: std::collections::BTreeMap<(String, bool), ExecutorText>,
}

pub struct ExecutorText {
    pub sequence: u64,
    pub fact: FactId,
    pub body: maka_agent_facts::model::body::TextBody,
}

impl ExecutorTranscript {
    pub fn text(&self, id: &str, thinking: bool) -> Option<&ExecutorText> {
        self.messages.get(&(id.to_owned(), thinking))
    }

    fn observe(&mut self, sequence: u64, record: &RecordedFact) {
        use maka_agent_facts::executor::Output;
        let Fact::ExternalTaskObserved { output, .. } = &record.fact else {
            return;
        };
        let (id, text, thinking) = match output {
            Output::OutputDelta { message_id, text } => (message_id, text, false),
            Output::ThinkingDelta { message_id, text } => (message_id, text, true),
            _ => return,
        };
        let message = self
            .messages
            .entry((id.clone(), thinking))
            .or_insert_with(|| ExecutorText {
                sequence,
                fact: record.id,
                body: Default::default(),
            });
        message.body = message
            .body
            .inserted(message.body.len_bytes(), text)
            .expect("append at text end");
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolResultSource {
    pub item: HistoryItem,
    pub tool_name: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryPage {
    pub items: Vec<HistoryItem>,
    pub next: Option<u64>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunSource {
    pub run: RunId,
    pub admission_sequence: u64,
    pub spec: RunSpec,
    pub spec_ref: ContentRef,
    pub admission: RecordedFact,
}
impl RunSource {
    pub fn execution(&self) -> ExecutionIdentity {
        ExecutionIdentity {
            session_id: self.spec.session_id.clone(),
            turn_id: self.spec.turn_id.clone(),
            run_id: self.run,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueSource {
    pub position: u64,
    pub queue_revision: u64,
    pub request: crate::queue::PreparedRequest,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueSourcePage {
    pub sources: Vec<QueueSource>,
    pub next: Option<u64>,
}

/// The live native owner supplies this same-Root ingress and namespace. A
/// deserialized HistoryCut alone cannot create this handle or access a Root.
#[derive(Clone)]
pub struct SessionHistory {
    data: DataWriter,
    namespace: HistoryNamespace,
}
#[derive(Clone)]
struct HistoryNamespace {
    owner: RunOwner,
    session: String,
}

pub struct LiveObservation {
    pub cut: HistoryCut,
    pub latest: Option<LiveRunObservation>,
}
pub struct LiveRunObservation {
    pub source: RunSource,
    pub pending_interactions: u64,
}

impl SessionHistory {
    pub fn new(data: DataWriter, owner: RunOwner, session: String) -> Self {
        Self {
            data,
            namespace: HistoryNamespace { owner, session },
        }
    }
    pub async fn resolve_tool_result(
        &self,
        cut: &HistoryCut,
        locator: &str,
    ) -> Result<Option<ToolResultSource>, StoreError> {
        self.data
            .query(ResolveToolResult(
                self.clone(),
                cut.clone(),
                locator.to_owned(),
            ))
            .await
    }
    pub async fn capture(&self) -> Result<HistoryCut, StoreError> {
        self.data.query(Capture(self.clone(), None)).await
    }
    /// Current pending requests and the latest original Run share one read snapshot.
    pub async fn live_observation(&self) -> Result<LiveObservation, StoreError> {
        self.data.query(ReadLiveObservation(self.clone())).await
    }
    /// Ordinary next-message context ends before this Run's original admission,
    /// never at today's latest sequence and never at a UUID/clock approximation.
    pub async fn chunk(
        &self,
        cut: &HistoryCut,
        run: RunId,
        reference: &ContentRef,
        offset: u64,
        limit: u32,
    ) -> Result<Vec<u8>, StoreError> {
        self.data
            .query(Chunk(
                self.clone(),
                cut.clone(),
                run,
                reference.clone(),
                offset,
                limit,
            ))
            .await
    }
    pub async fn capture_at(&self, through: u64) -> Result<HistoryCut, StoreError> {
        self.data.query(CaptureAt(self.clone(), through)).await
    }
    pub async fn fact_sequence(
        &self,
        cut: &HistoryCut,
        run: RunId,
        fact: FactId,
    ) -> Result<Option<u64>, StoreError> {
        self.data
            .query(FactSequence(self.clone(), cut.clone(), run, fact))
            .await
    }
    pub async fn item(
        &self,
        cut: &HistoryCut,
        sequence: u64,
    ) -> Result<Option<HistoryItem>, StoreError> {
        self.data
            .query(Item(self.clone(), cut.clone(), sequence))
            .await
    }
    pub async fn first_message(&self, cut: &HistoryCut) -> Result<Option<RunSource>, StoreError> {
        self.data
            .query(FirstMessage(self.clone(), cut.clone()))
            .await
    }
    pub async fn latest(&self, cut: &HistoryCut) -> Result<Option<RunSource>, StoreError> {
        self.data.query(Latest(self.clone(), cut.clone())).await
    }
    pub async fn view_at(
        &self,
        cut: &HistoryCut,
        run: RunId,
    ) -> Result<crate::fold::RunView, StoreError> {
        self.data
            .query(ViewAt(self.clone(), cut.clone(), run))
            .await
    }
    pub async fn tool_call(
        &self,
        cut: &HistoryCut,
        run: RunId,
        key: &ToolKey,
    ) -> Result<maka_agent_facts::model::ModelToolCall, StoreError> {
        self.data
            .query(ToolCall(self.clone(), cut.clone(), run, key.clone()))
            .await
    }
    pub async fn tool_position(
        &self,
        cut: &HistoryCut,
        id: &str,
    ) -> Result<Option<maka_agent_facts::history::RowPosition>, StoreError> {
        self.data
            .query(ToolPosition(self.clone(), cut.clone(), id.into()))
            .await
    }
    pub async fn tool_page(
        &self,
        cut: &HistoryCut,
        id: &str,
        after: u64,
        limit: u32,
    ) -> Result<HistoryPage, StoreError> {
        self.data
            .query(ToolPage(self.clone(), cut.clone(), id.into(), after, limit))
            .await
    }
    pub async fn capture_before(&self, run: RunId) -> Result<HistoryCut, StoreError> {
        self.data.query(Capture(self.clone(), Some(run))).await
    }
    pub async fn page(
        &self,
        cut: &HistoryCut,
        after_sequence: u64,
        limit: u32,
    ) -> Result<HistoryPage, StoreError> {
        self.data
            .query(Page(self.clone(), cut.clone(), after_sequence, limit))
            .await
    }
    pub async fn run_source(&self, run: RunId) -> Result<RunSource, StoreError> {
        self.data.query(Source(self.clone(), run)).await
    }
    pub async fn request(
        &self,
        cut: &HistoryCut,
        run: RunId,
        step: StepId,
    ) -> Result<RequestSpec, StoreError> {
        self.request_preparation(cut, run, step)
            .await
            .map(|(request, _)| request)
    }
    pub async fn request_preparation(
        &self,
        cut: &HistoryCut,
        run: RunId,
        step: StepId,
    ) -> Result<(RequestSpec, UnixMillis), StoreError> {
        self.data
            .query(Request(self.clone(), cut.clone(), run, step))
            .await
    }
    pub async fn content(&self, run: RunId, reference: &ContentRef) -> Result<Vec<u8>, StoreError> {
        self.data
            .query(Content(self.clone(), run, reference.clone()))
            .await
    }
    /// Runs on the original Root's blocking read lane. The reader cannot escape
    /// the snapshot. Only immutable-source materialization into already owned
    /// temporary prepared backing is allowed: no network, arbitrary user-file
    /// writes, runtime effects, async work or re-entry into the writer.
    pub async fn with_content<T: Send + 'static>(
        &self,
        cut: &HistoryCut,
        run: RunId,
        reference: &ContentRef,
        consume: impl FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.data
            .query(StreamContent(
                self.clone(),
                cut.clone(),
                run,
                reference.clone(),
                consume,
            ))
            .await
    }
    /// Newest-first keyset selection, returned in ascending canonical order.
    /// `next` is an exclusive before-sequence for the next older page.
    pub async fn previous_page(
        &self,
        cut: &HistoryCut,
        before_sequence: Option<u64>,
        limit: u32,
    ) -> Result<HistoryPage, StoreError> {
        self.data
            .query(Previous(self.clone(), cut.clone(), before_sequence, limit))
            .await
    }
    /// Exact queue snapshots consumed by the fact at sequence, in original
    /// source order. Pending/unconsumed follow-ups are never historical input.
    pub async fn sources(
        &self,
        cut: &HistoryCut,
        sequence: u64,
        after_position: Option<u64>,
        limit: u32,
    ) -> Result<QueueSourcePage, StoreError> {
        self.data
            .query(Sources(
                self.clone(),
                cut.clone(),
                sequence,
                after_position,
                limit,
            ))
            .await
    }
    pub async fn source_content(
        &self,
        cut: &HistoryCut,
        sequence: u64,
        position: u64,
        reference: &ContentRef,
    ) -> Result<Vec<u8>, StoreError> {
        self.data
            .query(SourceContent(
                self.clone(),
                cut.clone(),
                sequence,
                position,
                reference.clone(),
            ))
            .await
    }
    /// Uses the same blocking read lane and callback restrictions as `with_content`.
    pub async fn with_source<T: Send + 'static>(
        &self,
        cut: &HistoryCut,
        sequence: u64,
        position: u64,
        reference: &ContentRef,
        consume: impl FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.data
            .query(StreamSourceContent(
                self.clone(),
                cut.clone(),
                sequence,
                position,
                reference.clone(),
                consume,
            ))
            .await
    }
    /// Explicit repair on the original writer; canonical facts and pins remain.
    pub async fn rebuild(&self) -> Result<HistoryCut, StoreError> {
        self.data.write(Rebuild(self.clone())).await
    }
}
struct Capture(SessionHistory, Option<RunId>);
impl Query for Capture {
    type Output = HistoryCut;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::capture(c, &self.0.namespace, self.1)
    }
}
pub(crate) fn pending_interaction_count(
    c: &Connection,
    run: RunId,
    session: &str,
) -> Result<u64, StoreError> {
    Ok(c.query_row(
        "SELECT count(*) FROM agent_interaction_pending p JOIN agent_interaction_requests r ON r.request=p.request JOIN agent_runs ar ON ar.run=r.run WHERE p.session=?1 AND r.run=?2 AND ar.local=1 AND ar.stopped=0 AND ar.terminal IS NULL",
        rusqlite::params![session, run.to_string()],
        |row| sql::read_u64(row, 0),
    )?)
}
struct ReadLiveObservation(SessionHistory);
impl Query for ReadLiveObservation {
    type Output = LiveObservation;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let cut = sql::capture(c, &self.0.namespace, None)?;
        let latest = sql::latest(c, &self.0.namespace, &cut)?
            .map(|source| -> Result<_, StoreError> {
                let pending_interactions =
                    pending_interaction_count(c, source.run, &self.0.namespace.session)?;
                Ok(LiveRunObservation {
                    source,
                    pending_interactions,
                })
            })
            .transpose()?;
        Ok(LiveObservation { cut, latest })
    }
}
struct Page(SessionHistory, HistoryCut, u64, u32);
impl Query for Page {
    type Output = HistoryPage;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::page(c, &self.0.namespace, &self.1, self.2, self.3)
    }
}
struct Source(SessionHistory, RunId);
impl Query for Source {
    type Output = RunSource;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::run_source(c, &self.0.namespace, self.1)
    }
}
struct Request(SessionHistory, HistoryCut, RunId, StepId);
impl Query for Request {
    type Output = (RequestSpec, UnixMillis);
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::request_preparation(c, &self.0.namespace, &self.1, self.2, self.3)
    }
}
struct Content(SessionHistory, RunId, ContentRef);
impl Query for Content {
    type Output = Vec<u8>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::content(c, &self.0.namespace, self.1, &self.2)
    }
}
struct StreamContent<F>(SessionHistory, HistoryCut, RunId, ContentRef, F);
impl<T: Send + 'static, F> Query for StreamContent<F>
where
    F: FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
{
    type Output = T;
    fn execute(self, c: &Connection) -> Result<T, StoreError> {
        sql::with_content(c, &self.0.namespace, &self.1, self.2, &self.3, |blob| {
            (self.4)(blob)
        })
    }
}
struct Previous(SessionHistory, HistoryCut, Option<u64>, u32);
impl Query for Previous {
    type Output = HistoryPage;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::previous(c, &self.0.namespace, &self.1, self.2, self.3)
    }
}
struct Sources(SessionHistory, HistoryCut, u64, Option<u64>, u32);
impl Query for Sources {
    type Output = QueueSourcePage;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::sources(c, &self.0.namespace, &self.1, self.2, self.3, self.4)
    }
}
struct SourceContent(SessionHistory, HistoryCut, u64, u64, ContentRef);
impl Query for SourceContent {
    type Output = Vec<u8>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::source_content(c, &self.0.namespace, &self.1, self.2, self.3, &self.4)
    }
}
struct StreamSourceContent<F>(SessionHistory, HistoryCut, u64, u64, ContentRef, F);
impl<T: Send + 'static, F> Query for StreamSourceContent<F>
where
    F: FnOnce(&mut dyn std::io::Read) -> Result<T, StoreError> + Send + 'static,
{
    type Output = T;
    fn execute(self, c: &Connection) -> Result<T, StoreError> {
        sql::with_source(
            c,
            &self.0.namespace,
            &self.1,
            self.2,
            self.3,
            &self.4,
            |blob| (self.5)(blob),
        )
    }
}
struct Rebuild(SessionHistory);
impl Statement for Rebuild {
    type Value = HistoryCut;
    type Output = HistoryCut;
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let value = sql::rebuild(c, &self.0.namespace)?;
        Ok(Prepared {
            value,
            changed: true,
            notification: Notification::METADATA.with_sessions([self.0.namespace.session]),
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_) | StoreError::EventConflict
        )
    }
}

struct CaptureAt(SessionHistory, u64);
impl Query for CaptureAt {
    type Output = HistoryCut;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::capture_at(
            c,
            &self.0.namespace.owner,
            &self.0.namespace.session,
            Some(self.1),
        )
    }
}
struct Item(SessionHistory, HistoryCut, u64);
impl Query for Item {
    type Output = Option<HistoryItem>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::item(c, &self.0.namespace, &self.1, self.2)
    }
}
struct Latest(SessionHistory, HistoryCut);
impl Query for Latest {
    type Output = Option<RunSource>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::latest(c, &self.0.namespace, &self.1)
    }
}
struct ViewAt(SessionHistory, HistoryCut, RunId);
impl Query for ViewAt {
    type Output = crate::fold::RunView;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::view_at(c, &self.0.namespace, &self.1, self.2, |_, _| {})
    }
}
struct ExecutorViewAt(SessionHistory, HistoryCut, RunId);
impl Query for ExecutorViewAt {
    type Output = (crate::fold::RunView, ExecutorTranscript);
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        let mut transcript = ExecutorTranscript::default();
        let view = sql::view_at(c, &self.0.namespace, &self.1, self.2, |sequence, record| {
            transcript.observe(sequence, record);
        })?;
        Ok((view, transcript))
    }
}
struct ToolCall(SessionHistory, HistoryCut, RunId, ToolKey);
impl Query for ToolCall {
    type Output = maka_agent_facts::model::ModelToolCall;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::tool_call(c, &self.0.namespace, &self.1, self.2, &self.3)
    }
}
struct ToolPosition(SessionHistory, HistoryCut, String);
impl Query for ToolPosition {
    type Output = Option<maka_agent_facts::history::RowPosition>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::tool_position(c, &self.0.namespace, &self.1, &self.2)
    }
}
struct ToolPage(SessionHistory, HistoryCut, String, u64, u32);
impl Query for ToolPage {
    type Output = HistoryPage;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::tool_page(c, &self.0.namespace, &self.1, &self.2, self.3, self.4)
    }
}

struct Chunk(SessionHistory, HistoryCut, RunId, ContentRef, u64, u32);
impl Query for Chunk {
    type Output = Vec<u8>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::chunk(
            c,
            &self.0.namespace,
            &self.1,
            self.2,
            &self.3,
            self.4,
            self.5,
        )
    }
}

struct FirstMessage(SessionHistory, HistoryCut);
impl Query for FirstMessage {
    type Output = Option<RunSource>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::first_message(c, &self.0.namespace, &self.1)
    }
}

struct FactSequence(SessionHistory, HistoryCut, RunId, FactId);
impl Query for FactSequence {
    type Output = Option<u64>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::fact_sequence(c, &self.0.namespace, &self.1, self.2, self.3)
    }
}

struct ResolveToolResult(SessionHistory, HistoryCut, String);
impl Query for ResolveToolResult {
    type Output = Option<ToolResultSource>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::resolve_tool_result(c, &self.0, &self.1, &self.2)
    }
}
