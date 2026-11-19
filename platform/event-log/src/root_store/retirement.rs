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

//! Retirement shares Session admission with accepted workers.
use super::*;
use crate::sessions::{RemovalPlan, RemoveFamilyResult, SessionMutation, SessionRetirement};

mod prepared;

impl SessionStore {
    pub(super) async fn exclusive_metadata(&self, drain: bool) -> Result<EventLog, StoreError> {
        let owner = self.owner()?;
        let access = self
            .gates
            .write([gates::Key::Session(self.id.to_string())])
            .await?;
        let work = if drain {
            Some(
                self.gates
                    .try_write([gates::Key::Work(self.id.to_string())])?
                    .ok_or(StoreError::SessionBusy)?,
            )
        } else {
            None
        };
        let record = owner.get_session::<serde_json::Value>(&self.id).await?;
        let reference = record
            .as_ref()
            .map(|record| crate::workspace_bindings::attached(&record.configuration))
            .transpose()?
            .flatten();
        let binding = self
            .gates
            .read(
                reference
                    .iter()
                    .map(|reference| gates::Key::Binding(reference.id)),
            )
            .await?;
        Ok(owner
            // Release admission last: a following metadata owner must not
            // observe our completed operation's Work pin still being dropped.
            .scoped(Arc::new((work, binding, access)))
            .bind_session(self.id.clone()))
    }
    pub async fn session_retirement(
        &self,
        id: &str,
    ) -> Result<Option<SessionRetirement>, StoreError> {
        self.check_session(id)?;
        self.scoped().await?.session_retirement(id).await
    }
}
impl RootStore {
    pub async fn pending_session_retirements(
        &self,
        after: Option<&str>,
    ) -> Result<Vec<String>, StoreError> {
        self.require_open()?;
        self.log.pending_session_retirements(after).await
    }
    pub async fn session_retirement(
        &self,
        id: &str,
    ) -> Result<Option<SessionRetirement>, StoreError> {
        self.session(id).await?.session_retirement(id).await
    }
    pub async fn retiring_session<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
    ) -> Result<Option<SessionRecord<T>>, StoreError> {
        self.session(id)
            .await?
            .scoped()
            .await?
            .retiring_session(id)
            .await
    }
    /// Wait for physical Work custody, including releases that produce no SQL commit.
    /// This is not a retirement completion receipt; readiness and finish recheck it.
    pub async fn wait_session_retirement_work(&self, id: &str) -> Result<(), StoreError> {
        let selected = self.session(id).await?;
        {
            let access = self
                .gates
                .read([gates::Key::Session(id.to_owned())])
                .await?;
            let owner = selected.owner()?;
            if owner
                .scoped(Arc::new(access))
                .session_retirement(id)
                .await?
                .is_none()
            {
                return Err(StoreError::InvalidTransition(
                    "Session has no retirement fence".into(),
                ));
            }
        }
        // Accepted workers may need a Session metadata CAS before releasing Work.
        // Hold neither Session nor binding access while waiting for their custody.
        let _work = self.gates.write([gates::Key::Work(id.to_owned())]).await?;
        let owner = selected.owner()?;
        if owner.session_retirement(id).await?.is_none() {
            return Err(StoreError::InvalidTransition(
                "Session retirement fence was removed".into(),
            ));
        }
        Ok(())
    }

    pub async fn finish_session_retirement(
        &self,
        id: &str,
    ) -> Result<SessionRetirement, StoreError> {
        self.session(id)
            .await?
            .exclusive_metadata(true)
            .await?
            .finish_session_retirement(id)
            .await
    }
    pub async fn change_session_archived<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
        expected: Option<u64>,
        archived: bool,
        now: u64,
    ) -> Result<SessionMutation<T>, StoreError> {
        self.session(id)
            .await?
            .change_session_archived(id, expected, archived, now)
            .await
    }
    pub async fn set_session_archived<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
        archived: bool,
        now: u64,
    ) -> Result<SessionRecord<T>, StoreError> {
        match self
            .change_session_archived(id, None, archived, now)
            .await?
        {
            SessionMutation::Committed(record) => Ok(*record),
            SessionMutation::RevisionConflict { .. } => unreachable!("no revision precondition"),
        }
    }
    pub async fn session_removal_receipt(
        &self,
        id: &str,
    ) -> Result<Option<RemovalPlan>, StoreError> {
        self.session(id)
            .await?
            .scoped()
            .await?
            .session_removal_receipt(id)
            .await
    }
    pub async fn preview_session_removal(&self, id: &str) -> Result<RemovalPlan, StoreError> {
        self.session(id)
            .await?
            .scoped()
            .await?
            .preview_session_removal(id)
            .await
    }
    pub async fn remove_session_family(
        &self,
        id: &str,
        expected: u64,
    ) -> Result<RemoveFamilyResult, StoreError> {
        let selected = self.session(id).await?;
        let owner = selected.owner()?;
        loop {
            if let Some(receipt) = owner.session_removal_receipt(id).await? {
                return Ok(RemoveFamilyResult::Accepted(receipt));
            }
            let plan = owner.preview_session_removal(id).await?;
            let ids: Vec<_> = plan.remove.iter().chain(&plan.archive).cloned().collect();
            let access = self
                .gates
                .write(ids.iter().cloned().map(gates::Key::Session))
                .await?;
            // A previously accepted family creation may finish while gates are
            // acquired. Re-read under the parent gates before trusting the set.
            if owner.preview_session_removal(id).await? != plan {
                continue;
            }
            let mut references = Vec::new();
            for session in &ids {
                if let Some(record) = owner.get_session::<serde_json::Value>(session).await? {
                    references.extend(crate::workspace_bindings::attached(&record.configuration)?);
                }
            }
            let bindings = self
                .gates
                .read(
                    references
                        .iter()
                        .map(|reference| gates::Key::Binding(reference.id)),
                )
                .await?;
            // Compare the exact dependency plan again in the write transaction.
            if let Some(result) = owner
                .scoped(Arc::new((access, bindings)))
                .remove_session_family_guarded(id, expected, Some(plan))
                .await?
            {
                return Ok(result);
            }
        }
    }
}
