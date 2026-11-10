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

//! Native application consent and logical app controls. No physical outcome is inferred here.
use crate::{ContentBlob, DriverClaim, Head};
use maka_agent_facts::{durable::*, interaction::*};
use maka_event_log::{
    StoreError,
    connection::Query,
    root_store::{DataChange, DataWriter},
    writeback::{Notification, Prepared, Statement},
};
use maka_plugin_core::operation::RecoveryRef;
use maka_sandbox::workspace::PermissionBasis;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

pub(crate) mod sql;
pub(crate) use sql::pin_run;

/// Immutable observation from the actual native adapter, not model arguments.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Subject {
    pub activity: ComputerAppActivity,
    pub basis: PermissionBasis,
    pub allow_always: bool,
    pub target: AuthorizationObligation,
    pub operation: RecoveryRef,
    /// Exact native discovery/protocol metadata; persisted and pinned with SubjectObserved.
    pub capture: ContentRef,
}
/// Canonical metadata of an already bound native producer. This is not a capability.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeSource {
    pub execution: ExecutionIdentity,
    pub target: AuthorizationObligation,
    pub original: RecoveryRef,
    pub native_epoch: String,
    pub generation: String,
    pub operation: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Fact {
    NativeSourceBound {
        source: NativeSource,
    },
    NativeTurnInterrupted {
        binding: FactId,
    },
    SubjectObserved {
        subject: Subject,
    },
    AppStopRequested {
        source_operation: String,
    },
    AppAuthorized {
        source_operation: String,
        request: Option<String>,
        basis: PermissionBasis,
    },
    ProfileGrantRevoked {
        source_operation: String,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub id: FactId,
    pub at: UnixMillis,
    pub fact: Fact,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ActivityState {
    pub subject: Subject,
    pub stopped: bool,
    pub authorized: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Consent {
    Absent,
    Once { request: String },
    Session { request: String },
    Profile { request: String },
    FullAccess,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Status {
    pub stopped: bool,
    pub authority_revision: u64,
    pub consent: Consent,
}
#[derive(Clone)]
pub struct ComputerStore {
    data: DataWriter,
}
impl ComputerStore {
    pub fn new(data: DataWriter) -> Self {
        Self { data }
    }
    pub fn same_root(&self, writer: &DataWriter) -> bool {
        self.data.same_root(writer)
    }
    pub fn subscribe(&self) -> Result<tokio::sync::watch::Receiver<()>, StoreError> {
        self.data.subscribe_changes()
    }
    pub async fn subject(
        &self,
        session: &str,
        operation: &str,
    ) -> Result<Option<Subject>, StoreError> {
        self.data
            .query(ReadSubject(session.into(), operation.into()))
            .await
    }
    pub async fn activities(
        &self,
        session: &str,
        owner: &RunOwner,
    ) -> Result<Vec<ActivityState>, StoreError> {
        self.data
            .query(ReadActivities(session.into(), owner.clone()))
            .await
    }
    pub async fn status(&self, session: &str, operation: &str) -> Result<Status, StoreError> {
        self.data
            .query(ReadStatus(session.into(), operation.into()))
            .await
    }
    /// Only fresh domain facts use a current driver. Root physical resources have independent custody.
    pub async fn append(
        &self,
        claim: &DriverClaim,
        head: Head,
        change: Change,
        contents: Vec<ContentBlob>,
    ) -> Result<bool, StoreError> {
        self.data
            .write(DriverWrite {
                data: self.data.clone(),
                claim: claim.clone(),
                head,
                change,
                contents,
            })
            .await
    }
    /// The human supplies only an observed operation identity. SQL derives its original Run and app.
    pub fn prepare_stop(
        &self,
        session: &str,
        operation: &str,
        id: FactId,
        at: UnixMillis,
    ) -> DataChange {
        self.data.prepare(Control {
            session: session.into(),
            operation: operation.into(),
            id,
            at,
            revoke: false,
        })
    }
    pub fn prepare_revoke(
        &self,
        session: &str,
        operation: &str,
        id: FactId,
        at: UnixMillis,
    ) -> DataChange {
        self.data.prepare(Control {
            session: session.into(),
            operation: operation.into(),
            id,
            at,
            revoke: true,
        })
    }
    /// Observe an original producer after its initiating call has completed or
    /// its driver claim has changed. This never admits another native action.
    pub async fn native_interrupted(
        &self,
        execution: &ExecutionIdentity,
        binding: FactId,
        id: FactId,
        at: UnixMillis,
    ) -> Result<bool, StoreError> {
        self.data
            .write(NativeInterruptionWrite {
                execution: execution.clone(),
                binding,
                id,
                at,
            })
            .await
    }
    pub async fn native_turn_interrupted(
        &self,
        execution: &ExecutionIdentity,
    ) -> Result<bool, StoreError> {
        self.data.query(ReadNativeFence(execution.clone())).await
    }
    pub async fn rebuild(&self) -> Result<(), StoreError> {
        self.data.write(Rebuild).await
    }
}
struct DriverWrite {
    data: DataWriter,
    claim: DriverClaim,
    head: Head,
    change: Change,
    contents: Vec<ContentBlob>,
}
impl Statement for DriverWrite {
    type Value = bool;
    type Output = bool;
    fn execute(self, c: &Connection) -> Result<Prepared<bool>, StoreError> {
        self.claim.with_current(&self.data, || {
            let session = sql::append(
                c,
                self.claim.run(),
                Some(self.head),
                self.change,
                self.contents,
                true,
            )?;
            Ok(Prepared {
                value: session.is_some(),
                changed: session.is_some(),
                notification: session.map_or(Notification::NONE, |s| {
                    Notification::METADATA.with_sessions([s])
                }),
            })
        })
    }
    fn committed(inserted: bool) -> bool {
        inserted
    }
    fn isolated_rejection(e: &StoreError) -> bool {
        rejection(e)
    }
}
struct NativeInterruptionWrite {
    execution: ExecutionIdentity,
    binding: FactId,
    id: FactId,
    at: UnixMillis,
}
impl Statement for NativeInterruptionWrite {
    type Value = bool;
    type Output = bool;
    fn execute(self, c: &Connection) -> Result<Prepared<bool>, StoreError> {
        sql::verify_native_binding(c, &self.execution, self.binding)?;
        let session = sql::append(
            c,
            self.execution.run_id,
            None,
            Change {
                id: self.id,
                at: self.at,
                fact: Fact::NativeTurnInterrupted {
                    binding: self.binding,
                },
            },
            vec![],
            false,
        )?;
        Ok(Prepared {
            value: session.is_some(),
            changed: session.is_some(),
            notification: session.map_or(Notification::NONE, |s| {
                Notification::METADATA.with_sessions([s])
            }),
        })
    }
    fn committed(inserted: bool) -> bool {
        inserted
    }
    fn isolated_rejection(e: &StoreError) -> bool {
        rejection(e)
    }
}
struct ReadNativeFence(ExecutionIdentity);
impl Query for ReadNativeFence {
    type Output = bool;
    fn execute(self, c: &Connection) -> Result<bool, StoreError> {
        sql::native_turn_interrupted(c, &self.0)
    }
}
struct Control {
    session: String,
    operation: String,
    id: FactId,
    at: UnixMillis,
    revoke: bool,
}
impl Statement for Control {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        let subject = sql::subject(c, &self.session, &self.operation)?
            .ok_or_else(|| crate::store::invalid("computer source operation missing"))?;
        let fact = if self.revoke {
            Fact::ProfileGrantRevoked {
                source_operation: self.operation,
            }
        } else {
            Fact::AppStopRequested {
                source_operation: self.operation,
            }
        };
        let session = sql::append(
            c,
            subject.activity.execution.run_id,
            None,
            Change {
                id: self.id,
                at: self.at,
                fact,
            },
            vec![],
            false,
        )?;
        Ok(Prepared {
            value: (),
            changed: session.is_some(),
            notification: session.map_or(Notification::NONE, |s| {
                Notification::METADATA.with_sessions([s])
            }),
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(e: &StoreError) -> bool {
        rejection(e)
    }
}
fn rejection(e: &StoreError) -> bool {
    matches!(
        e,
        StoreError::InvalidTransition(_)
            | StoreError::RevisionConflict { .. }
            | StoreError::EventConflict
    )
}
struct ReadSubject(String, String);
impl Query for ReadSubject {
    type Output = Option<Subject>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::subject(c, &self.0, &self.1)
    }
}
struct ReadActivities(String, RunOwner);
impl Query for ReadActivities {
    type Output = Vec<ActivityState>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::activities(c, &self.0, &self.1)
    }
}
struct ReadStatus(String, String);
impl Query for ReadStatus {
    type Output = Status;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::status(c, &self.0, &self.1)
    }
}
struct Rebuild;
impl Statement for Rebuild {
    type Value = ();
    type Output = ();
    fn execute(self, c: &Connection) -> Result<Prepared<()>, StoreError> {
        sql::rebuild(c)?;
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::METADATA,
        })
    }
    fn committed(_: ()) {}
    fn isolated_rejection(error: &StoreError) -> bool {
        rejection(error)
    }
}
