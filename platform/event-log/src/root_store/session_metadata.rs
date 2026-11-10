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

mod prepared;

/// A delayed metadata CAS on one original Root/Session, not authorization to
/// read history or admit work. Execute it in the bound writer's transaction.
pub struct SessionRevisionGuard {
    owner: Weak<root::RootOwner>,
    session: Arc<str>,
    expected: u64,
}

impl SessionRevisionGuard {
    pub fn session_id(&self) -> &str {
        &self.session
    }

    pub fn same_root(&self, writer: &DataWriter) -> bool {
        self.owner
            .upgrade()
            .is_some_and(|owner| writer.matches_owner(&owner))
    }

    /// Only SQL on the original physical actor: caller policy and actual writer
    /// affinity must already be bound before enqueueing the containing statement.
    pub fn validate(&self, connection: &SqliteConnection) -> Result<(), StoreError> {
        let _owner = self.owner.upgrade().ok_or(StoreError::ConnectionClosed)?;
        if !super::catalog::session_visible(connection, &self.session)? {
            return Err(StoreError::SessionNotFound);
        }
        let actual =
            crate::workspace_bindings::current_session_revision(connection, &self.session)?
                .ok_or(StoreError::SessionNotFound)?;
        if actual != self.expected {
            return Err(StoreError::SessionRevisionConflict {
                expected: self.expected,
                actual,
            });
        }
        Ok(())
    }
}

impl SessionStore {
    pub fn revision_guard(
        &self,
        writer: &DataWriter,
        expected: u64,
    ) -> Result<SessionRevisionGuard, StoreError> {
        if expected == 0 || expected > 9_007_199_254_740_991 {
            return Err(StoreError::InvalidTransition(
                "invalid expected Session revision".into(),
            ));
        }
        let owner = self.owner()?.owned_root()?;
        if !writer.matches_owner(&owner) {
            return Err(StoreError::InvalidTransition(
                "foreign Root data writer".into(),
            ));
        }
        Ok(SessionRevisionGuard {
            owner: Arc::downgrade(&owner),
            session: self.id.clone(),
            expected,
        })
    }

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
        self.mutate_metadata(id, expected, update).await
    }

    async fn mutate_metadata<T, F>(
        &self,
        id: &str,
        expected: u64,
        update: F,
    ) -> Result<SessionMutation<T>, StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
    {
        let (custody, change) = match self.metadata_change(id, expected, update).await {
            Ok(change) => change,
            Err(StoreError::SessionRevisionConflict { expected, actual }) => {
                return Ok(SessionMutation::RevisionConflict { expected, actual });
            }
            Err(error) => return Err(error),
        };
        let commits = custody.commits.session(id);
        custody
            .connection
            .run(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Immediate,
                )?;
                match change.validate(&tx) {
                    Ok(()) => {}
                    Err(StoreError::SessionRevisionConflict { expected, actual }) => {
                        return Ok(SessionMutation::RevisionConflict { expected, actual });
                    }
                    Err(error) => return Err(error),
                }
                let (record, changed) = change.apply(&tx)?;
                if changed {
                    tx.commit().map_err(StoreError::CommitUnknown)?;
                    commits.metadata();
                }
                Ok(SessionMutation::Committed(Box::new(record)))
            })
            .await
    }

    async fn metadata_change<T, F>(
        &self,
        id: &str,
        expected: u64,
        update: F,
    ) -> Result<(EventLog, crate::sessions::metadata::MetadataChange<T>), StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
    {
        self.check_session(id)?;
        if expected == 0 || expected > 9_007_199_254_740_991 {
            return Err(StoreError::InvalidTransition(
                "invalid expected Session revision".into(),
            ));
        }
        let owner = self.owner()?;
        let accepted = if let Some(pins) = &self.work {
            self.work_lifetime()?;
            Some(pins.custody()?)
        } else {
            None
        };
        let access = self
            .gates
            .write([gates::Key::Session(id.to_owned())])
            .await?;
        let selected = id.to_owned();
        let scoped = match &accepted {
            Some(custody) => owner.scoped(custody.clone()),
            None => owner.scoped(owner.clone()),
        };
        let change = scoped
            .connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                crate::sessions::metadata::preview_metadata(&tx, &selected, expected, false, update)
            })
            .await?;
        let strong_boundary = change.requires_work_fence()?;
        let work = if strong_boundary {
            Some(
                self.gates
                    .try_write([gates::Key::Work(id.to_owned())])?
                    .ok_or(StoreError::SessionBusy)?,
            )
        } else {
            None
        };
        let binding = if accepted.is_some() && !strong_boundary {
            None
        } else {
            Some(
                self.gates
                    .read(change.binding_ids().map(gates::Key::Binding))
                    .await?,
            )
        };
        let custody = owner
            .scoped(Arc::new((accepted, work, binding, access)))
            .bind_session(self.id.clone());
        let change = custody
            .connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                change.validate(&tx)?;
                Ok(change)
            })
            .await?;
        Ok((custody, change))
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
}
