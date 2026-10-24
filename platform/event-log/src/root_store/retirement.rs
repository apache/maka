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

//! Retirement gates the same Session admission used by cross-partition workers.
use super::*;
use crate::sessions::{
    AbandonRevision, RemovalAuthority, RemovalPlan, RemoveFamilyResult, SessionMutation,
    SessionRetirement,
};
use std::collections::BTreeSet;

#[cfg(test)]
mod tests;

impl SessionStore {
    pub(super) async fn exclusive_metadata(&self, drain: bool) -> Result<EventLog, StoreError> {
        if self.execution.is_some() {
            return Err(StoreError::InvalidTransition(
                "execution scope cannot retire a Session".into(),
            ));
        }
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
        let mut ids = BTreeSet::new();
        for partition in &self.partitions {
            ids.extend(partition.pending_session_retirements(after).await?);
        }
        Ok(ids.into_iter().take(32).collect())
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
            SessionMutation::Committed(record) => Ok(record),
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
        authority: RemovalAuthority,
    ) -> Result<RemoveFamilyResult, StoreError> {
        let selected = self.session(id).await?;
        let owner = selected.owner()?;
        let authority = Arc::new(authority);
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
            // A preparing revision can become committed without touching a
            // locked ancestor. Compare the exact plan again in the write tx.
            if let Some(result) = owner
                .scoped(Arc::new((access, bindings)))
                .remove_session_family_guarded(id, expected, authority.clone(), Some(plan))
                .await?
            {
                return Ok(result);
            }
        }
    }
    pub async fn abandon_revision(&self, id: &str) -> Result<AbandonRevision, StoreError> {
        self.session(id)
            .await?
            .exclusive_metadata(true)
            .await?
            .abandon_revision(id)
            .await
    }
}
