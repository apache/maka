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

//! Agent-owned human requests, answers and deterministic permission indexes.
//! Stored approval bytes are evidence, never a live capability.
use crate::{ContentBlob, DriverClaim, Head};
use maka_agent_facts::{durable::*, interaction::*};
use maka_event_log::{
    StoreError,
    connection::Query,
    root_store::{DataChange, DataWriter},
    writeback::{Notification, Prepared, Statement},
};
use maka_plugin_core::operation::RecoveryRef;
use maka_sandbox::{grant::Permissions, workspace::PermissionBasis};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

pub(crate) mod sql;
pub(crate) use sql::{
    consume, consume_cell_approval, consume_external_approval, validate_approval,
    validate_approval_refusal, validate_cell_approval,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovalBinding {
    pub approval: ApprovalId,
    pub target: AuthorizationObligation,
    pub phase: ApprovalPhase,
    pub input: ContentRef,
    pub resources: Vec<ResourceRecovery>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ApprovalPhase {
    Preparation,
    Host { original: RecoveryRef },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionGrant {
    pub approval_id: Option<ApprovalId>,
    pub request_id: String,
    pub permissions: Permissions,
    pub scope: PermissionScope,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingCursor {
    pub created_at: u64,
    pub request_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Pending {
    pub revision: u64,
    pub records: Vec<InteractionRecord>,
    pub next: Option<PendingCursor>,
}
#[derive(Clone)]
pub struct InteractionsStore {
    data: DataWriter,
}
impl InteractionsStore {
    pub fn new(data: DataWriter) -> Self {
        Self { data }
    }
    /// Subscribe before reading pending; notifications are hints, SQL is truth.
    pub fn subscribe(&self) -> Result<tokio::sync::watch::Receiver<()>, StoreError> {
        self.data.subscribe_changes()
    }
    pub async fn read(
        &self,
        session: &str,
        request: &str,
    ) -> Result<Option<InteractionRecord>, StoreError> {
        self.data
            .query(Read(session.to_owned(), request.to_owned()))
            .await
    }
    /// Recover the original transformed input/resources, never recompute them
    /// from a newer catalog or workspace after an approval wait.
    pub async fn binding(
        &self,
        session: &str,
        request: &str,
    ) -> Result<Option<ApprovalBinding>, StoreError> {
        self.data
            .query(Binding(session.to_owned(), request.to_owned()))
            .await
    }
    pub async fn pending(&self, session: &str) -> Result<Pending, StoreError> {
        self.pending_page(session, None, 256).await
    }
    pub async fn pending_page(
        &self,
        session: &str,
        after: Option<PendingCursor>,
        limit: u32,
    ) -> Result<Pending, StoreError> {
        self.data
            .query(ReadPending(session.to_owned(), after, limit))
            .await
    }
    pub async fn establish(
        &self,
        claim: &DriverClaim,
        head: Head,
        record: InteractionRecord,
        approval: Option<ApprovalBinding>,
        contents: Vec<ContentBlob>,
    ) -> Result<InteractionRecord, StoreError> {
        self.data
            .write(Establish {
                data: self.data.clone(),
                claim: claim.clone(),
                head,
                record,
                approval,
                contents,
            })
            .await
    }
    /// First committed answer wins, including across a lost acknowledgement.
    /// Late answers remain historical evidence but never revive a stopped Run.
    pub async fn commit_outcome(
        &self,
        session: &str,
        request: &str,
        outcome: InteractionOutcome,
    ) -> Result<InteractionRecord, StoreError> {
        self.data
            .write(Answer(session.to_owned(), request.to_owned(), outcome))
            .await
    }
    pub fn prepare_outcome(
        &self,
        session: &str,
        request: &str,
        outcome: InteractionOutcome,
    ) -> DataChange {
        self.data
            .prepare(Answer(session.to_owned(), request.to_owned(), outcome))
    }
    pub async fn permission_grants(
        &self,
        execution: &ExecutionIdentity,
        target: Option<&AuthorizationObligation>,
        basis: &PermissionBasis,
    ) -> Result<Vec<PermissionGrant>, StoreError> {
        self.data
            .query(Grants(execution.clone(), target.cloned(), *basis))
            .await
    }
    pub async fn external_approval(
        &self,
        execution: &ExecutionIdentity,
        key: maka_agent_facts::external_effects::ExternalEffectKey,
        basis: &PermissionBasis,
    ) -> Result<Option<ApprovalId>, StoreError> {
        self.data
            .query(ExternalApproval(execution.clone(), key, *basis))
            .await
    }
    pub async fn client_capability_grant(
        &self,
        session: &str,
        target: &GrantTarget,
    ) -> Result<Option<SessionGrant>, StoreError> {
        self.data
            .query(Capability(session.to_owned(), target.clone()))
            .await
    }
    pub async fn rebuild(&self, session: &str) -> Result<u64, StoreError> {
        self.data.write(Rebuild(session.to_owned())).await
    }
}
struct Establish {
    data: DataWriter,
    claim: DriverClaim,
    head: Head,
    record: InteractionRecord,
    approval: Option<ApprovalBinding>,
    contents: Vec<ContentBlob>,
}
impl Statement for Establish {
    type Value = InteractionRecord;
    type Output = InteractionRecord;
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        self.claim.with_current(&self.data, || {
            let (value, changed) = sql::establish(
                c,
                self.claim.run(),
                self.head,
                self.record,
                self.approval,
                self.contents,
            )?;
            let session = value.execution.session_id.clone();
            Ok(prepared(value, changed, session))
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        rejection(error)
    }
}
struct Answer(String, String, InteractionOutcome);
impl Statement for Answer {
    type Value = InteractionRecord;
    type Output = InteractionRecord;
    fn execute(self, c: &Connection) -> Result<Prepared<Self::Value>, StoreError> {
        let (value, changed) = sql::answer(c, &self.0, &self.1, self.2)?;
        let session = value.execution.session_id.clone();
        Ok(prepared(value, changed, session))
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        rejection(error)
    }
}
fn rejection(error: &StoreError) -> bool {
    matches!(
        error,
        StoreError::InvalidTransition(_)
            | StoreError::RevisionConflict { .. }
            | StoreError::EventConflict
    )
}
fn prepared<T>(value: T, changed: bool, session: String) -> Prepared<T> {
    Prepared {
        value,
        changed,
        notification: if changed {
            Notification::METADATA.with_sessions([session])
        } else {
            Notification::NONE
        },
    }
}
struct Read(String, String);
impl Query for Read {
    type Output = Option<InteractionRecord>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::read(c, &self.0, &self.1)
    }
}
struct Binding(String, String);
impl Query for Binding {
    type Output = Option<ApprovalBinding>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        entity_id(&self.0).map_err(crate::store::invalid)?;
        entity_id(&self.1).map_err(crate::store::invalid)?;
        sql::binding(c, &self.0, &self.1)
    }
}
struct ReadPending(String, Option<PendingCursor>, u32);
impl Query for ReadPending {
    type Output = Pending;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::pending(c, &self.0, self.1.as_ref(), self.2)
    }
}
struct Grants(
    ExecutionIdentity,
    Option<AuthorizationObligation>,
    PermissionBasis,
);
impl Query for Grants {
    type Output = Vec<PermissionGrant>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::grants(c, &self.0, self.1.as_ref(), self.2)
    }
}
struct ExternalApproval(
    ExecutionIdentity,
    maka_agent_facts::external_effects::ExternalEffectKey,
    PermissionBasis,
);
impl Query for ExternalApproval {
    type Output = Option<ApprovalId>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::external_approval(c, &self.0, self.1, self.2)
    }
}
struct Capability(String, GrantTarget);
impl Query for Capability {
    type Output = Option<SessionGrant>;
    fn execute(self, c: &Connection) -> Result<Self::Output, StoreError> {
        sql::capability(c, &self.0, &self.1)
    }
}
struct Rebuild(String);
impl Statement for Rebuild {
    type Value = u64;
    type Output = u64;
    fn execute(self, c: &Connection) -> Result<Prepared<u64>, StoreError> {
        let revision = sql::rebuild(c, &self.0)?;
        Ok(prepared(revision, true, self.0))
    }
    fn committed(value: u64) -> u64 {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        rejection(error)
    }
}
