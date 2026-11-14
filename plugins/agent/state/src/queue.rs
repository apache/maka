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

//! Session-owned requests exist before Run admission. Only the native owner
//! chooses delivery policy; these statements preserve its decisions and evidence.
use crate::{Change, ContentBlob, Head};
use maka_agent_facts::durable::*;
use maka_event_log::{
    StoreError,
    connection::Query,
    root_store::{DataWriter, SessionWorkFence},
    writeback::{Notification, Prepared, Statement},
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, sync::Arc};

mod sql;
pub(crate) use sql::{
    DeliveryTarget, Event, consume, consume_external_steering, consume_steering, release_steering,
    retract_interactive, stop_completions,
};

pub const GOAL_CONTROL_STOP: &str = "goal_control";

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct RequestId(pub String);
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreparedRequest {
    pub id: RequestId,
    pub message_id: String,
    pub spec: RunSpec,
    /// Exact RootSourceMessage, including trusted attribution and submission digest.
    pub source: ContentRef,
    /// Native-owned immutable resource recovery descriptors, never live handles.
    pub resources: ContentRef,
    pub required_tools: BTreeSet<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SteeringTarget {
    pub run: RunId,
    pub expected_head: Head,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Placement {
    Followup,
    Steering { run: RunId, expected_head: Head },
    Completion { caller: RunId },
}
impl Placement {
    pub fn is_followup(&self) -> bool {
        matches!(self, Self::Followup | Self::Completion { .. })
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueEntry {
    pub request: PreparedRequest,
    pub placement: Placement,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Queue {
    pub revision: u64,
    pub entries: Vec<QueueEntry>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum QueueEdit {
    Enqueue {
        request: Box<PreparedRequest>,
        placement: Placement,
    },
    Update {
        request: Box<PreparedRequest>,
    },
    Retract {
        request: RequestId,
    },
    RetractAll,
    Promote {
        request: RequestId,
        target: SteeringTarget,
    },
    Reorder {
        requests: Vec<RequestId>,
    },
}
/// Construct once from the original native command identity. Re-observation
/// uses this identity and exact edit, not a new request or new Run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueueCommand {
    pub id: FactId,
    pub at: UnixMillis,
    pub expected_revision: u64,
    pub edit: QueueEdit,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueueCommit {
    pub revision: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MessageResolution {
    Missing,
    Pending,
    Cancelled,
    Delivered { run: RunId, shared: bool },
}
/// A frozen queue cut, consumed only by the Run/Step's own Root statement.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Consume {
    pub session: String,
    pub requests: Vec<RequestId>,
    pub expected_revision: u64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadyCursor {
    pub session: String,
    pub position: u64,
    pub request: RequestId,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ReadyEntry {
    pub cursor: ReadyCursor,
    pub entry: QueueEntry,
}

pub enum Followup {
    Queued(RunId),
    Interrupt { run: RunId, stop: FactId },
}

impl Followup {
    fn original(&self) -> RunId {
        match *self {
            Self::Queued(run) | Self::Interrupt { run, .. } => run,
        }
    }
}

#[derive(Clone)]
pub struct QueueStore {
    data: DataWriter,
}
impl QueueStore {
    pub fn new(data: DataWriter) -> Self {
        Self { data }
    }
    /// Stage a same-Root mutation for the Host's original provider receipt
    /// transaction. Preparing is inert and does not mint an execution grant.
    pub fn prepare(
        &self,
        session: String,
        command: QueueCommand,
        contents: Vec<ContentBlob>,
    ) -> maka_event_log::root_store::DataChange {
        self.data.prepare(Write {
            session,
            command,
            contents,
            followup: None,
            work_fence: None,
        })
    }
    /// Fence a follow-up against the exact original Run observed by Native.
    /// The Run id is a commit-time condition, never an execution grant.
    pub fn prepare_followup(
        &self,
        session: String,
        command: QueueCommand,
        contents: Vec<ContentBlob>,
        followup: Followup,
    ) -> maka_event_log::root_store::DataChange {
        self.data.prepare(Write {
            session,
            command,
            contents,
            followup: Some(followup),
            work_fence: None,
        })
    }
    /// Native supplies the original positive fence selected for this same Root and Session.
    /// Retain that original owner through SQL settlement; this is not a grant.
    pub fn prepare_after_stop(
        &self,
        session: String,
        command: QueueCommand,
        contents: Vec<ContentBlob>,
        fence: SessionWorkFence,
    ) -> maka_event_log::root_store::DataChange {
        self.data.prepare(Write {
            session,
            command,
            contents,
            followup: None,
            work_fence: Some(Arc::new(fence)),
        })
    }
    pub fn prepare_with<S: Statement>(
        &self,
        session: String,
        command: QueueCommand,
        contents: Vec<ContentBlob>,
        followup: Option<Followup>,
        fence: Option<SessionWorkFence>,
        extra: S,
    ) -> maka_event_log::root_store::DataChange {
        self.data.prepare(WithExtra {
            queue: Write {
                session,
                command,
                contents,
                followup,
                work_fence: fence.map(Arc::new),
            },
            extra,
        })
    }
    pub async fn execute(
        &self,
        session: String,
        command: QueueCommand,
        contents: Vec<ContentBlob>,
    ) -> Result<QueueCommit, StoreError> {
        self.data
            .write(Write {
                session,
                command,
                contents,
                followup: None,
                work_fence: None,
            })
            .await
    }
    pub async fn read(&self, session: String) -> Result<Queue, StoreError> {
        self.data.query(Read(session)).await
    }
    pub async fn entry(
        &self,
        session: String,
        request: RequestId,
    ) -> Result<Option<QueueEntry>, StoreError> {
        self.data.query(ReadEntry(session, request)).await
    }
    /// Resolve the immutable source request by its submitted message identity.
    pub async fn message_entry(
        &self,
        session: String,
        message: String,
    ) -> Result<Option<QueueEntry>, StoreError> {
        self.data.query(ReadMessageEntry(session, message)).await
    }
    pub async fn resolve_message(
        &self,
        session: String,
        message: String,
    ) -> Result<MessageResolution, StoreError> {
        self.data.query(Resolve(session, message)).await
    }
    pub async fn content(
        &self,
        session: String,
        request: RequestId,
        reference: ContentRef,
    ) -> Result<Vec<u8>, StoreError> {
        self.data
            .query(ReadContent(session, request, reference))
            .await
    }
    /// Level-triggered keyset read. Wakeups are hints; committed readiness is SQL.
    pub async fn ready(
        &self,
        owner: RunOwner,
        after: Option<ReadyCursor>,
        limit: u32,
    ) -> Result<Vec<ReadyEntry>, StoreError> {
        self.data.query(Ready(owner, after, limit)).await
    }
    pub async fn steering(&self, session: String, run: RunId) -> Result<Queue, StoreError> {
        self.data.query(Steering(session, run)).await
    }
    pub async fn has_pending_steering(
        &self,
        session: String,
        run: RunId,
    ) -> Result<bool, StoreError> {
        self.data.query(HasPendingSteering(session, run)).await
    }
    pub async fn rebuild(&self, session: String) -> Result<QueueCommit, StoreError> {
        self.data.write(Rebuild(session)).await
    }
    pub async fn recover_undelivered_steering(
        &self,
        owner: RunOwner,
        at: UnixMillis,
    ) -> Result<(), StoreError> {
        self.data
            .write(RecoverUndeliveredSteering { owner, at })
            .await
    }
}
struct RecoverUndeliveredSteering {
    owner: RunOwner,
    at: UnixMillis,
}
impl Statement for RecoverUndeliveredSteering {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        let sessions = sql::recover_undelivered_steering(c, &self.owner, self.at)?;
        Ok(Prepared {
            value: (),
            changed: !sessions.is_empty(),
            notification: if sessions.is_empty() {
                Notification::NONE
            } else {
                Notification::METADATA.with_sessions(sessions)
            },
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(error: &StoreError) -> bool {
        Write::isolated_rejection(error)
    }
}
struct Write {
    session: String,
    command: QueueCommand,
    contents: Vec<ContentBlob>,
    followup: Option<Followup>,
    work_fence: Option<Arc<SessionWorkFence>>,
}
impl Statement for Write {
    type Value = QueueCommit;
    type Output = QueueCommit;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        vec![Arc::new((self.contents.clone(), self.work_fence.clone()))]
    }
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let at = self.command.at;
        let (value, changed) = sql::write(
            c,
            &self.session,
            self.command,
            self.contents,
            self.followup.as_ref().map(Followup::original),
        )?;
        if changed && let Some(Followup::Interrupt { run, stop }) = self.followup {
            // The queue entry and Stop share the same Root receipt transaction.
            crate::store::StopRun {
                run,
                change: Change {
                    id: stop,
                    at,
                    fact: Fact::StopRequested {
                        diagnostic: "steering_interrupt".into(),
                    },
                },
                retract_pending: false,
            }
            .execute(c)?;
        }
        Ok(Prepared {
            value,
            changed,
            notification: if changed {
                Notification::METADATA.with_sessions([self.session])
            } else {
                Notification::NONE
            },
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_)
                | StoreError::StatementRejected { .. }
                | StoreError::RevisionConflict { .. }
                | StoreError::EventConflict
        )
    }
}
struct Rebuild(String);
impl Statement for Rebuild {
    type Value = QueueCommit;
    type Output = QueueCommit;
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        Ok(Prepared {
            value: sql::rebuild(c, &self.0)?,
            changed: true,
            notification: Notification::METADATA.with_sessions([self.0]),
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        Write::isolated_rejection(error)
    }
}
struct Read(String);
impl Query for Read {
    type Output = Queue;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::read(c, &self.0, None)
    }
}
struct Steering(String, RunId);
impl Query for Steering {
    type Output = Queue;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::read(c, &self.0, Some(self.1))
    }
}
struct HasPendingSteering(String, RunId);
impl Query for HasPendingSteering {
    type Output = bool;
    fn execute(self, c: &Connection) -> Result<bool, StoreError> {
        c.prepare_cached(
            "SELECT EXISTS(SELECT 1 FROM agent_queue_items
             WHERE session=? AND target_run=? AND state='pending' AND lane='steering')",
        )?
        .query_row(rusqlite::params![self.0, self.1.to_string()], |row| {
            row.get(0)
        })
        .map_err(Into::into)
    }
}
struct ReadEntry(String, RequestId);
impl Query for ReadEntry {
    type Output = Option<QueueEntry>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::entry(c, &self.0, &self.1)
    }
}
struct Resolve(String, String);
impl Query for Resolve {
    type Output = MessageResolution;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::resolve(c, &self.0, &self.1)
    }
}
struct ReadContent(String, RequestId, ContentRef);
impl Query for ReadContent {
    type Output = Vec<u8>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::owned_content(c, &self.0, &self.1, &self.2)
    }
}
struct Ready(RunOwner, Option<ReadyCursor>, u32);
impl Query for Ready {
    type Output = Vec<ReadyEntry>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::ready(c, &self.0, self.1.as_ref(), self.2)
    }
}

struct ReadMessageEntry(String, String);
impl Query for ReadMessageEntry {
    type Output = Option<QueueEntry>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::message_entry(c, &self.0, &self.1)
    }
}

struct WithExtra<S> {
    queue: Write,
    extra: S,
}
impl<S: Statement> Statement for WithExtra<S> {
    type Value = (QueueCommit, S::Value);
    type Output = QueueCommit;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut retained = self.queue.retain();
        retained.extend(self.extra.retain());
        retained
    }
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.extra = self.extra.prepare()?;
        Ok(self)
    }
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let queue = self.queue.execute(c)?;
        let extra = self.extra.execute(c)?;
        Ok(Prepared {
            value: (queue.value, extra.value),
            changed: queue.changed || extra.changed,
            notification: queue.notification.combine(extra.notification),
        })
    }
    fn committed((queue, extra): Self::Value) -> Self::Output {
        S::committed(extra);
        queue
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        Write::isolated_rejection(error)
    }
}
