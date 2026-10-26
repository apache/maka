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
use maka_capabilities::call::Resources;
use maka_capabilities::storage;
use maka_capabilities::storage::Mutation;
use maka_capabilities::storage::Namespace;
use maka_capabilities::storage::Page;
use maka_capabilities::storage::Record;
use maka_capabilities::storage::Scan;
use maka_capabilities::storage::StoreError;
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
impl Storage {
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
fn error(error: maka_event_log::StoreError) -> StoreError {
    match error {
        maka_event_log::StoreError::RevisionConflict { expected, actual } => {
            StoreError::Conflict { expected, actual }
        }
        maka_event_log::StoreError::CommitUnknown(_)
        | maka_event_log::StoreError::OperationUnknown => {
            StoreError::OutcomeUnknown(error.to_string())
        }
        error => StoreError::Unavailable(error.to_string()),
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
                        .map_err(error)?;
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
                        .map_err(error)
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
                        .map_err(error)
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
