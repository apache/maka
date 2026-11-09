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
use maka_event_log::{EventLog, StoreError as LogError};
use maka_plugin_core::scope::Scope;
use maka_plugin_core::storage::Mutation;
use maka_plugin_core::storage::Namespace;
use maka_plugin_core::storage::Record;
use maka_plugin_core::storage::Store;
use maka_plugin_core::storage::StoreError;
use std::sync::Arc;

pub struct SqlStore(pub Arc<EventLog>);
impl Store for SqlStore {
    fn scan(
        &self,
        query: maka_plugin_core::storage::Scan,
    ) -> BoxFuture<'_, Result<maka_plugin_core::storage::Page, StoreError>> {
        Box::pin(async move {
            self.0
                .plugin_data_scan(&namespace(), query)
                .await
                .map_err(storage)
        })
    }
    fn read(&self, key: String) -> BoxFuture<'_, Result<Option<Record>, StoreError>> {
        Box::pin(async move {
            self.0
                .plugin_data(&namespace(), &key)
                .await
                .map_err(storage)
        })
    }
    fn batch(&self, mutations: Vec<Mutation>) -> BoxFuture<'_, Result<Vec<Record>, StoreError>> {
        Box::pin(async move {
            self.0
                .plugin_data_batch(&namespace(), mutations)
                .await
                .map_err(storage)
        })
    }
}
fn namespace() -> Namespace {
    Namespace::new("maka.scheduler", Scope::Profile).unwrap()
}
fn storage(error: LogError) -> StoreError {
    match error {
        LogError::RevisionConflict { expected, actual } => {
            StoreError::Conflict { expected, actual }
        }
        LogError::CommitUnknown(_) | LogError::OperationUnknown => {
            StoreError::OutcomeUnknown(error.to_string())
        }
        other => StoreError::Unavailable(other.to_string()),
    }
}
