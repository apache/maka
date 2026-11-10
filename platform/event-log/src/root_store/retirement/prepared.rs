/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */
use super::super::*;
use crate::{
    sessions::{SessionMutation, SessionRemovalResult, SessionRetirement, metadata, removal},
    writeback::{Notification, Prepared, Statement},
};
use serde_json::Value;

impl RootStore {
    /// Return a guarded response choice, not visible metadata or a receipt.
    /// The original provider commits it with the concrete domain statement.
    pub async fn prepare_session_archived<T, S>(
        &self,
        id: &str,
        expected: u64,
        archived: bool,
        now: u64,
        writer: &DataWriter,
        statement: S,
    ) -> Result<(SessionRecord<T>, DataChange), StoreError>
    where
        T: DeserializeOwned + Send + 'static,
        S: Statement,
    {
        if !self.data_writer()?.same_root(writer) {
            return Err(invalid("foreign Root data writer"));
        }
        crate::sessions::validate_time(now)?;
        validate_expected(expected)?;
        let selected = self.session(id).await?;
        let custody = Arc::new(selected.exclusive_metadata(false).await?);
        let session = id.to_owned();
        let preview = custody
            .connection
            .read(move |db| {
                if !catalog::session_visible(db, &session)? {
                    return Err(StoreError::SessionNotFound);
                }
                match metadata::preview_archived::<Value>(
                    db,
                    &session,
                    Some(expected),
                    archived,
                    now,
                )?
                .0
                {
                    SessionMutation::Committed(record) => Ok(*record),
                    SessionMutation::RevisionConflict { expected, actual } => {
                        Err(StoreError::SessionRevisionConflict { expected, actual })
                    }
                }
            })
            .await?;
        let configuration: T = serde_json::from_value(preview.configuration.clone())?;
        let record = preview.clone().map_configuration(|_| configuration);
        let change = writer.prepare(RetirementChange {
            choice: Choice::Archive {
                preview,
                expected,
                archived,
                now,
            },
            statement,
            custody,
        });
        Ok((record, change))
    }

    pub async fn prepare_session_removal<S: Statement>(
        &self,
        id: &str,
        expected: u64,
        writer: &DataWriter,
        statement: S,
    ) -> Result<(SessionRetirement, DataChange), StoreError> {
        if !self.data_writer()?.same_root(writer) {
            return Err(invalid("foreign Root data writer"));
        }
        validate_expected(expected)?;
        let selected = self.session(id).await?;
        let custody = Arc::new(selected.exclusive_metadata(false).await?);
        let session = id.to_owned();
        let preview = custody
            .connection
            .read(
                move |db| match removal::preview_removal(db, &session, expected)?.0 {
                    SessionRemovalResult::Accepted(state) => Ok(state),
                    SessionRemovalResult::RevisionConflict { expected, actual } => {
                        Err(StoreError::SessionRevisionConflict { expected, actual })
                    }
                },
            )
            .await?;
        let change = writer.prepare(RetirementChange {
            choice: Choice::Remove {
                session: id.to_owned(),
                expected,
                preview,
            },
            statement,
            custody,
        });
        Ok((preview, change))
    }
}

fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

fn validate_expected(expected: u64) -> Result<(), StoreError> {
    if expected == 0 || expected > 9_007_199_254_740_991 {
        return Err(invalid("invalid expected Session revision"));
    }
    Ok(())
}

enum Choice {
    Archive {
        preview: SessionRecord,
        expected: u64,
        archived: bool,
        now: u64,
    },
    Remove {
        session: String,
        expected: u64,
        preview: SessionRetirement,
    },
}
struct RetirementChange<S> {
    choice: Choice,
    statement: S,
    custody: Arc<EventLog>,
}
impl<S: Statement> Statement for RetirementChange<S> {
    type Value = S::Value;
    type Output = S::Output;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;

    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut inputs = self.statement.retain();
        inputs.push(self.custody.clone());
        inputs
    }
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.statement = self.statement.prepare()?;
        Ok(self)
    }
    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<Self::Value>, StoreError> {
        let (session, changed) = match self.choice {
            Choice::Archive {
                preview,
                expected,
                archived,
                now,
            } => {
                if !catalog::session_visible(connection, &preview.id)? {
                    return Err(StoreError::SessionNotFound);
                }
                let (outcome, changed) = metadata::apply_archived::<Value>(
                    connection,
                    &preview.id,
                    Some(expected),
                    archived,
                    now,
                )?;
                match outcome {
                    SessionMutation::Committed(record) if *record == preview => {}
                    SessionMutation::Committed(_) => {
                        return Err(invalid("prepared Session metadata changed"));
                    }
                    SessionMutation::RevisionConflict { expected, actual } => {
                        return Err(StoreError::SessionRevisionConflict { expected, actual });
                    }
                }
                (preview.id, changed)
            }
            Choice::Remove {
                session,
                expected,
                preview,
            } => {
                let (outcome, changed) = removal::apply_removal(connection, &session, expected)?;
                match outcome {
                    SessionRemovalResult::Accepted(state) if state == preview => {}
                    SessionRemovalResult::Accepted(_) => {
                        return Err(invalid("prepared Session retirement changed"));
                    }
                    SessionRemovalResult::RevisionConflict { expected, actual } => {
                        return Err(StoreError::SessionRevisionConflict { expected, actual });
                    }
                }
                (session, changed)
            }
        };
        let domain = self.statement.execute(connection)?;
        let root = if changed {
            Notification::METADATA.with_sessions([session])
        } else {
            Notification::NONE
        };
        Ok(Prepared {
            value: domain.value,
            changed: changed || domain.changed,
            notification: domain.notification.combine(root),
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        S::committed(value)
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error)
            || matches!(
                error,
                StoreError::SessionNotFound
                    | StoreError::SessionRetired
                    | StoreError::SessionBusy
                    | StoreError::SessionRevisionConflict { .. }
                    | StoreError::InvalidTransition(_)
            )
    }
}
