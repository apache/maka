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

use super::*;
use crate::sessions::SessionMutation;
use serde::Serialize;

impl SessionStore {
    pub async fn update_session_metadata<T, F>(
        &self,
        id: &str,
        expected: u64,
        update: F,
    ) -> Result<SessionMutation<T>, StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
    {
        self.mutate_metadata(id, expected, None, update).await
    }

    pub async fn update_session_permissions<T, F>(
        &self,
        id: &str,
        expected: u64,
        now: u64,
        update: F,
    ) -> Result<SessionMutation<T>, StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
    {
        crate::sessions::validate_time(now)?;
        self.mutate_metadata(id, expected, Some(now), update).await
    }

    async fn mutate_metadata<T, F>(
        &self,
        id: &str,
        expected: u64,
        permission_time: Option<u64>,
        update: F,
    ) -> Result<SessionMutation<T>, StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
    {
        self.check_session(id)?;
        if self.execution.is_some() {
            return Err(StoreError::InvalidTransition(
                "execution scope cannot change Session configuration".into(),
            ));
        }
        if expected == 0 || expected > 9_007_199_254_740_991 {
            return Err(StoreError::InvalidTransition(
                "invalid expected Session revision".into(),
            ));
        }
        let owner = self.owner()?;
        let access = self
            .gates
            .write([gates::Key::Session(id.to_owned())])
            .await?;
        let record = owner
            .get_session::<T>(id)
            .await?
            .ok_or(StoreError::SessionNotFound)?;
        if record.revision != expected {
            return Ok(SessionMutation::RevisionConflict {
                expected,
                actual: record.revision,
            });
        }
        let mut normalized = serde_json::to_value(&record.configuration)?;
        let old = crate::workspace_bindings::attached(&normalized)?;
        crate::workspace_bindings::normalize(&mut normalized, record.workspace_binding.as_ref())?;
        let mut candidate: T = serde_json::from_value(normalized)?;
        update(&mut candidate)?;
        let new = crate::workspace_bindings::attached(&serde_json::to_value(&candidate)?)?;
        let attachment_changed = old.as_ref().map(|reference| reference.id)
            != new.as_ref().map(|reference| reference.id);
        let work = if attachment_changed {
            Some(
                self.gates
                    .try_write([gates::Key::Work(id.to_owned())])?
                    .ok_or(StoreError::SessionBusy)?,
            )
        } else {
            None
        };
        let binding = self
            .gates
            .read(
                old.iter()
                    .chain(new.iter())
                    .map(|reference| gates::Key::Binding(reference.id)),
            )
            .await?;
        let root_app_control = self.control.upgrade().ok_or(StoreError::ConnectionClosed)?;
        let control_dependency = if permission_time.is_some() {
            self.control_dependency()?
        } else {
            None
        };
        // The policy closure runs once. Root relocation between the snapshot and
        // pin acquisition changes effective revision and is rejected by this CAS.
        // Release Session admission last so a following owner cannot race the
        // completed attachment change's Work pin teardown.
        owner
            .scoped(Arc::new((work, binding, access, control_dependency)))
            .bind_session(self.id.clone())
            .mutate_session_metadata(
                id,
                expected,
                false,
                permission_time,
                Some(root_app_control),
                move |current| {
                    *current = candidate;
                    Ok(())
                },
            )
            .await
    }
}

impl RootStore {
    pub async fn update_session_metadata<T, F>(
        &self,
        id: &str,
        expected: u64,
        update: F,
    ) -> Result<SessionMutation<T>, StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
    {
        self.session(id)
            .await?
            .update_session_metadata(id, expected, update)
            .await
    }

    pub async fn update_session_permissions<T, F>(
        &self,
        id: &str,
        expected: u64,
        now: u64,
        update: F,
    ) -> Result<SessionMutation<T>, StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
    {
        self.session(id)
            .await?
            .update_session_permissions(id, expected, now, update)
            .await
    }

    pub async fn set_session_read_marker<T: DeserializeOwned + Send + 'static>(
        &self,
        id: &str,
        message_id: &str,
    ) -> Result<SessionRecord<T>, StoreError> {
        self.session(id)
            .await?
            .scoped()
            .await?
            .set_session_read_marker(id, message_id)
            .await
    }
}
