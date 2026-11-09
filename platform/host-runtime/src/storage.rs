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

use futures_util::future::BoxFuture;
use maka_plugin_core::storage;
use maka_plugin_core::storage::Mutation;
use maka_plugin_core::storage::Namespace;
use maka_plugin_core::storage::Page;
use maka_plugin_core::storage::Record;
use maka_plugin_core::storage::Scan;
use maka_plugin_core::storage::StoreError;
use maka_plugin_core::work::resources::Resources;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct Storage {
    log: Arc<maka_event_log::root_store::RootStore>,
    prefix: String,
    namespace: Namespace,
    drain: CancellationToken,
    resources: Arc<Resources>,
}
/// A pure write description bound to the actual native data owner. It cannot
/// be serialized or select another package or Root at final commit.
pub struct StateChange(Change);
enum Change {
    Storage {
        store: Storage,
        mutations: Vec<Mutation>,
    },
    Statement {
        change: maka_event_log::root_store::DataChange,
        operation: maka_event_log::applications::operations::OperationDispatchScope,
    },
}
impl std::fmt::Debug for StateChange {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut debug = formatter.debug_struct("StateChange");
        match &self.0 {
            Change::Storage { mutations, .. } => {
                debug.field("mutations", &mutations.len());
            }
            Change::Statement { operation, .. } => {
                debug.field("operation", operation.reference());
            }
        }
        debug.finish_non_exhaustive()
    }
}
enum Completion {
    Fixed(serde_json::Value),
    Computed(Arc<jsonschema::Validator>),
}
impl StateChange {
    pub(crate) fn statement(
        change: maka_event_log::root_store::DataChange,
        operation: maka_event_log::applications::operations::OperationDispatchScope,
    ) -> Self {
        Self(Change::Statement { change, operation })
    }
    pub(crate) async fn commit(
        self,
        claim: &maka_event_log::applications::operations::DispatchClaim,
        value: serde_json::Value,
    ) -> Result<maka_plugin_core::operation::OperationObservation, maka_event_log::StoreError> {
        self.commit_completion(claim, Completion::Fixed(value))
            .await
    }
    pub(crate) async fn commit_result(
        self,
        claim: &maka_event_log::applications::operations::DispatchClaim,
        output: Arc<jsonschema::Validator>,
    ) -> Result<maka_plugin_core::operation::OperationObservation, maka_event_log::StoreError> {
        self.commit_completion(claim, Completion::Computed(output))
            .await
    }
    async fn commit_completion(
        self,
        claim: &maka_event_log::applications::operations::DispatchClaim,
        completion: Completion,
    ) -> Result<maka_plugin_core::operation::OperationObservation, maka_event_log::StoreError> {
        match self.0 {
            Change::Storage { store, mutations } => {
                let Completion::Fixed(value) = completion else {
                    return Err(maka_event_log::StoreError::InvalidTransition(
                        "storage mutations require their declared output".into(),
                    ));
                };
                let reference = claim.reference();
                let owner_prefix = instance_prefix(
                    &reference.source.state_domain,
                    reference.source.deployment,
                    &reference.namespace,
                );
                if !store.prefix.starts_with(&owner_prefix) {
                    return Err(maka_event_log::StoreError::InvalidTransition(
                        "state completion belongs to another provider instance".into(),
                    ));
                }
                store
                    .log
                    .commit_operation_data(
                        claim,
                        &store.namespace,
                        mutations,
                        maka_plugin_core::operation::OperationResult::Success { value },
                    )
                    .await
            }
            Change::Statement { change, operation } => {
                if operation.reference() != claim.reference() {
                    return Err(maka_event_log::StoreError::InvalidTransition(
                        "state completion belongs to another original operation".into(),
                    ));
                }
                match completion {
                    Completion::Fixed(value) => {
                        change
                            .commit(
                                claim,
                                maka_plugin_core::operation::OperationResult::Success { value },
                            )
                            .await
                    }
                    Completion::Computed(output) => {
                        change
                            .commit_result(claim, move |value| {
                                output.validate(value).map_err(|error| {
                                    maka_event_log::StoreError::StatementRejected {
                                    diagnostic: error.to_string(),
                                    cause: Arc::new(maka_event_log::StoreError::InvalidTransition(
                                        "native completion output violates its original contract"
                                            .into(),
                                    )),
                                }
                                })
                            })
                            .await
                    }
                }
            }
        }
    }
}
impl Storage {
    /// Prepare only data; the Host commits it with the original provider receipt
    /// after the handler has returned and its declared output has been checked.
    pub fn prepare(&self, mut mutations: Vec<Mutation>) -> Result<StateChange, StoreError> {
        if self.drain.is_cancelled() {
            return Err(StoreError::Retired);
        }
        for mutation in &mut mutations {
            mutation
                .validate()
                .map_err(|cause| StoreError::Unavailable(cause.to_string()))?;
            mutation.key = format!("{}{}", self.prefix, mutation.key);
        }
        Ok(StateChange(Change::Storage {
            store: self.clone(),
            mutations,
        }))
    }
    /// Compose pure namespace-scoped data with the original native completion.
    pub fn prepare_statement(
        &self,
        mut mutations: Vec<Mutation>,
        writer: &maka_event_log::root_store::DataWriter,
    ) -> Result<
        impl maka_event_log::writeback::Statement<Value = Vec<Record>, Output = Vec<Record>> + Clone,
        maka_event_log::StoreError,
    > {
        if self.drain.is_cancelled() {
            return Err(maka_event_log::StoreError::InvalidTransition(
                "native storage owner is retired".into(),
            ));
        }
        for mutation in &mut mutations {
            mutation.validate().map_err(|cause| {
                maka_event_log::StoreError::InvalidTransition(cause.to_string())
            })?;
            mutation.key = format!("{}{}", self.prefix, mutation.key);
        }
        self.log
            .prepare_plugin_data_statement(&self.namespace, mutations, writer)
    }
    pub fn new(
        log: Arc<maka_event_log::root_store::RootStore>,
        prefix: String,
        namespace: Namespace,
    ) -> Self {
        Self {
            log,
            prefix,
            namespace,
            drain: CancellationToken::new(),
            resources: Arc::default(),
        }
    }
    /// Native domain validation on the caller's same-Root transaction only.
    pub fn read_in_transaction(
        &self,
        connection: &rusqlite::Connection,
        key: &str,
        writer: &maka_event_log::root_store::DataWriter,
    ) -> Result<Option<Record>, maka_event_log::StoreError> {
        storage::validate_key(key)
            .map_err(|cause| maka_event_log::StoreError::InvalidTransition(cause.to_string()))?;
        self.log
            .validate_data_writer_in_transaction(writer, connection)?;
        maka_event_log::EventLog::read_plugin_data_in_transaction(
            connection,
            &self.namespace,
            &format!("{}{key}", self.prefix),
        )
    }
    pub fn validate_root(
        &self,
        data: &maka_event_log::root_store::DataWriter,
    ) -> Result<(), maka_event_log::StoreError> {
        self.log.validate_data_writer(data)
    }
    /// Captured data target, for comparing native executions across activations.
    /// Mutable records and call lifecycle are deliberately not identity facts.
    pub fn execution_basis(&self) -> Option<serde_json::Value> {
        let root = self.log.owned_root().ok()?;
        serde_json::to_value((
            root.root_id(),
            self.namespace.package(),
            self.namespace.scope(),
            &self.prefix,
        ))
        .ok()
    }
    pub async fn finish(&self) -> Result<(), String> {
        self.drain.cancel();
        self.resources.finish().await.map_err(|e| e.to_string())
    }
    async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce(Self) -> BoxFuture<'static, Result<T, StoreError>> + Send + 'static,
    ) -> Result<T, StoreError> {
        if self.drain.is_cancelled() {
            return Err(StoreError::Retired);
        }
        let mut ticket = self.resources.reserve().map_err(|_| StoreError::Retired)?;
        let store = self.clone();
        tokio::spawn(async move {
            ticket.start();
            let drain = store.drain.clone();
            let result = work(store).await;
            if matches!(result, Err(StoreError::OutcomeUnknown(_))) {
                drain.cancel();
            }
            // The SQL worker returned even when its business commit is unknown.
            ticket.complete(Ok(()));
            result
        })
        .await
        .map_err(|_| StoreError::OutcomeUnknown("native storage worker disappeared".into()))?
    }
}
fn error(cause: &maka_event_log::StoreError) -> StoreError {
    match cause {
        maka_event_log::StoreError::Shared(cause) => error(cause),
        maka_event_log::StoreError::RevisionConflict { expected, actual } => StoreError::Conflict {
            expected: expected.clone(),
            actual: actual.clone(),
        },
        maka_event_log::StoreError::CommitUnknown(_)
        | maka_event_log::StoreError::OperationUnknown
        | maka_event_log::StoreError::RollbackFailed { .. } => {
            StoreError::OutcomeUnknown(cause.to_string())
        }
        cause => StoreError::Unavailable(cause.to_string()),
    }
}

impl storage::Store for Storage {
    fn scan(&self, query: Scan) -> BoxFuture<'_, Result<Page, StoreError>> {
        Box::pin(async move {
            self.run(move |store| {
                Box::pin(async move {
                    query
                        .validate()
                        .map_err(|e| StoreError::Unavailable(e.to_string()))?;
                    let mut page = store
                        .log
                        .plugin_data_scan(
                            &store.namespace,
                            Scan {
                                prefix: format!("{}{}", store.prefix, query.prefix),
                                after: query.after.map(|key| format!("{}{key}", store.prefix)),
                            },
                        )
                        .await
                        .map_err(|cause| error(&cause))?;
                    for entry in &mut page.entries {
                        entry.key = entry.key[store.prefix.len()..].to_owned();
                    }
                    page.next_after = page
                        .next_after
                        .map(|key| key[store.prefix.len()..].to_owned());
                    Ok(page)
                })
            })
            .await
        })
    }
    fn read(&self, key: String) -> BoxFuture<'_, Result<Option<Record>, StoreError>> {
        Box::pin(async move {
            self.run(move |store| {
                Box::pin(async move {
                    storage::validate_key(&key)
                        .map_err(|e| StoreError::Unavailable(e.to_string()))?;
                    store
                        .log
                        .plugin_data(&store.namespace, &format!("{}{key}", store.prefix))
                        .await
                        .map_err(|cause| error(&cause))
                })
            })
            .await
        })
    }
    fn batch(
        &self,
        mut mutations: Vec<Mutation>,
    ) -> BoxFuture<'_, Result<Vec<Record>, StoreError>> {
        Box::pin(async move {
            self.run(move |store| {
                Box::pin(async move {
                    for mutation in &mut mutations {
                        mutation
                            .validate()
                            .map_err(|e| StoreError::Unavailable(e.to_string()))?;
                        mutation.key = format!("{}{}", store.prefix, mutation.key);
                    }
                    store
                        .log
                        .plugin_data_batch(&store.namespace, mutations)
                        .await
                        .map_err(|cause| error(&cause))
                })
            })
            .await
        })
    }
}

/// Stable data selection only; this prefix grants no service or filesystem authority.
pub fn instance_prefix(
    domain: &str,
    deployment: uuid::Uuid,
    instance: &maka_plugin_core::composition::InstanceId,
) -> String {
    let bytes =
        serde_json::to_vec(&(domain, deployment, instance)).expect("native owner namespace");
    format!(
        "ma_{}_",
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(bytes))
    )
}
