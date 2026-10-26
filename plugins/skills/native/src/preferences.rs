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
use maka_capabilities::storage::Data;
use maka_capabilities::storage::Mutation;
use maka_capabilities::storage::Namespace;
use maka_event_log::{RootStore, StoreError};

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
            .map_err(|error| match error {
                StoreError::OperationUnknown => "skills_preferences_unknown",
                _ => "skills_preferences_unavailable",
            })?;
        let revision = record.as_ref().map_or(0, |record| record.revision);
        let entries: BTreeMap<String, maka_skills::Preference> = match record.map(|r| r.data) {
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
    pub async fn set(
        &self,
        input: SetPreference,
        scope: &Scope,
    ) -> Result<PreferenceResult, String> {
        if !valid(&input.reference) || input.revision > (1_u64 << 53) - 1 {
            return Ok(PreferenceResult::Rejected {
                reason: "invalid_preference".into(),
            });
        }
        self.run(scope, move |store, scope| {
            Box::pin(async move {
                let mut current = store.snapshot().await?;
                if current.revision != input.revision {
                    return Ok(PreferenceResult::Changed);
                }
                if input.preference == maka_skills::Preference::default() {
                    current.entries.remove(&input.reference);
                } else {
                    current.entries.insert(input.reference, input.preference);
                }
                let value =
                    serde_json::to_value(&current.entries).map_err(|_| "skills_encoding_failed")?;
                if scope.cancellation.is_cancelled() {
                    return Err("skills_call_cancelled".into());
                }
                match store
                    .log
                    .plugin_data_batch(
                        &namespace(),
                        vec![Mutation {
                            key: store.key,
                            expected_revision: (input.revision != 0).then_some(input.revision),
                            data: Data::Present(value),
                        }],
                    )
                    .await
                {
                    Ok(records) => {
                        let [record]: [_; 1] = records
                            .try_into()
                            .map_err(|_| "skills_preferences_unknown")?;
                        // The commit receipt is sufficient; a second read must not
                        // turn a known commit into a failed or different operation.
                        Ok(PreferenceResult::Applied {
                            revision: record.revision,
                        })
                    }
                    Err(StoreError::RevisionConflict { .. }) => Ok(PreferenceResult::Changed),
                    Err(_) => Err("skills_preferences_unknown".into()),
                }
            })
        })
        .await
    }
}

#[cfg(test)]
mod tests;
