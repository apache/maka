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
use crate::{ContentBlob, Head};
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
pub(crate) use sql::{DeliveryTarget, Event, consume, consume_external_steering, consume_steering};

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
            admission_fence: None,
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
        original: RunId,
    ) -> maka_event_log::root_store::DataChange {
        self.data.prepare(Write {
            session,
            command,
            contents,
            admission_fence: Some(original),
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
            admission_fence: None,
            work_fence: Some(Arc::new(fence)),
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
                admission_fence: None,
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
    pub async fn rebuild(&self, session: String) -> Result<QueueCommit, StoreError> {
        self.data.write(Rebuild(session)).await
    }
}
struct Write {
    session: String,
    command: QueueCommand,
    contents: Vec<ContentBlob>,
    admission_fence: Option<RunId>,
    work_fence: Option<Arc<SessionWorkFence>>,
}
impl Statement for Write {
    type Value = QueueCommit;
    type Output = QueueCommit;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        vec![Arc::new((self.contents.clone(), self.work_fence.clone()))]
    }
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let (value, changed) = sql::write(
            c,
            &self.session,
            self.command,
            self.contents,
            self.admission_fence,
        )?;
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
