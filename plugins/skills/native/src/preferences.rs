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
use maka_event_log::root_store::{DataChange, DataWriter};
use maka_event_log::writeback::{Notification, Prepared, Statement};
use maka_event_log::{RootStore, StoreError};
use maka_plugin_core::storage::{Data, Mutation, Namespace, Record};

#[derive(Clone)]
pub(super) struct Store {
    log: Arc<RootStore>,
    key: String,
}
pub(super) struct Snapshot {
    pub revision: u64,
    pub entries: BTreeMap<String, maka_skills::Preference>,
}
fn namespace() -> Namespace {
    Namespace::new(IMPLEMENTATION, maka_plugin_core::scope::Scope::Profile)
        .expect("built-in skill library namespace")
}
fn valid(reference: &str) -> bool {
    !reference.is_empty() && !reference.chars().any(char::is_control)
}
impl Store {
    pub fn new(log: Arc<RootStore>, owner: String) -> Self {
        Self {
            log,
            key: format!("{owner}preferences"),
        }
    }
    pub fn execution_basis(&self) -> Option<Value> {
        let root = self.log.owned_root().ok()?;
        let namespace = namespace();
        serde_json::to_value((
            root.root_id(),
            namespace.package(),
            namespace.scope(),
            &self.key,
        ))
        .ok()
    }
    async fn snapshot(&self) -> Result<Snapshot, String> {
        let record = self
            .log
            .plugin_data(&namespace(), &self.key)
            .await
            .map_err(|error| match error.underlying() {
                StoreError::CommitUnknown(_) | StoreError::OperationUnknown => {
                    "skills_preferences_unknown"
                }
                _ => "skills_preferences_unavailable",
            })?;
        decode_snapshot(record)
    }

    // The task keeps the original Call ticket until SQL returns. Dropping its
    // observer cannot acknowledge cleanup or cancel an already accepted write.
    async fn run<T: Send + 'static>(
        &self,
        scope: &Scope,
        work: impl FnOnce(Self, Scope) -> BoxFuture<'static, Result<T, String>> + Send + 'static,
    ) -> Result<T, String> {
        let store = self.clone();
        let scope = scope.clone();
        let mut ticket = scope
            .resources
            .reserve()
            .map_err(|_| "skills_call_closed")?;
        tokio::spawn(async move {
            ticket.start();
            let result = if scope.cancellation.is_cancelled() {
                Err("skills_call_cancelled".into())
            } else {
                work(store, scope).await
            };
            // The task actually returned. A commit's business uncertainty is
            // not a failed cleanup; an unwound/lost task still fails via Ticket::drop.
            ticket.complete(Ok(()));
            result
        })
        .await
        .map_err(|_| "skills_preferences_unknown")?
    }
    pub async fn read(&self, scope: &Scope) -> Result<Snapshot, String> {
        self.run(scope, |store, _| {
            Box::pin(async move { store.snapshot().await })
        })
        .await
    }
    pub fn set(&self, input: SetPreference, scope: &Scope) -> Result<DataChange, String> {
        if scope.cancellation.is_cancelled() {
            return Err("skills_call_cancelled".into());
        }
        let writer = if let Some(execution) = scope.identity.agent() {
            let custody = scope.work_custody().ok_or("skills_call_closed")?;
            self.log
                .data_writer_for_work(custody.as_ref(), &execution.session_id)
        } else {
            self.log.data_writer()
        }
        .map_err(|_| "skills_preferences_unavailable")?;
        let store = self.clone();
        writer
            .prepare_result(move |writer| {
                Ok(Set {
                    store,
                    writer,
                    input,
                })
            })
            .map_err(|_| "skills_preferences_unavailable".into())
    }
}

fn decode_snapshot(record: Option<Record>) -> Result<Snapshot, String> {
    let revision = record.as_ref().map_or(0, |record| record.revision);
    let entries: BTreeMap<String, maka_skills::Preference> = match record.map(|record| record.data)
    {
        Some(Data::Present(value)) => {
            serde_json::from_value(value).map_err(|_| "skills_preferences_invalid")?
        }
        None | Some(Data::Deleted) => BTreeMap::new(),
    };
    if entries.keys().any(|reference| !valid(reference)) {
        return Err("skills_preferences_invalid".into());
    }
    Ok(Snapshot { revision, entries })
}
struct Set {
    store: Store,
    writer: DataWriter,
    input: SetPreference,
}
impl Statement for Set {
    type Value = Value;
    type Output = Value;
    fn execute(self, connection: &rusqlite::Connection) -> Result<Prepared<Value>, StoreError> {
        let result = |result: PreferenceResult| -> Result<Prepared<Value>, StoreError> {
            Ok(Prepared {
                value: serde_json::to_value(result)?,
                changed: false,
                notification: Notification::NONE,
            })
        };
        if !valid(&self.input.reference) || self.input.revision > (1_u64 << 53) - 1 {
            return result(PreferenceResult::Rejected {
                reason: "invalid_preference".into(),
            });
        }
        self.store
            .log
            .validate_data_writer_in_transaction(&self.writer, connection)?;
        let record = maka_event_log::EventLog::read_plugin_data_in_transaction(
            connection,
            &namespace(),
            &self.store.key,
        )?;
        let mut current = decode_snapshot(record).map_err(StoreError::InvalidTransition)?;
        if current.revision != self.input.revision {
            return result(PreferenceResult::Changed);
        }
        if self.input.preference == maka_skills::Preference::default() {
            current.entries.remove(&self.input.reference);
        } else {
            current
                .entries
                .insert(self.input.reference, self.input.preference);
        }
        let statement = self.store.log.prepare_plugin_data_statement(
            &namespace(),
            vec![Mutation {
                key: self.store.key.clone(),
                expected_revision: (self.input.revision != 0).then_some(self.input.revision),
                data: Data::Present(serde_json::to_value(current.entries)?),
            }],
            &self.writer,
        )?;
        let prepared = statement.execute(connection)?;
        let [record]: [_; 1] = prepared.value.try_into().map_err(|_| {
            StoreError::InvalidTransition("skills preference write lost its actual record".into())
        })?;
        Ok(Prepared {
            value: serde_json::to_value(PreferenceResult::Applied {
                revision: record.revision,
            })?,
            changed: prepared.changed,
            notification: prepared.notification,
        })
    }
    fn committed(value: Value) -> Value {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::InvalidTransition(_) | StoreError::RevisionConflict { .. }
        )
    }
}

#[cfg(test)]
pub(crate) mod tests;
