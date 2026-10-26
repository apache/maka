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

//! Package storage follows a stable data writer; Session-scoped data shares its family.
use super::*;
use maka_capabilities::storage::{Mutation, Namespace, Page, Record, Scan};
use maka_plugin_core::scope::Scope;

impl RootStore {
    async fn plugin_storage(&self, namespace: &Namespace) -> Result<EventLog, StoreError> {
        self.require_open()?;
        if let Scope::Session(session) = namespace.scope() {
            return self.session(session).await?.scoped().await;
        }
        let identity =
            serde_json::to_string(&(namespace.package(), String::from(namespace.scope().clone())))?;
        Ok(self.partitions[partition_for(b"plugin-storage", &identity)].scoped(Arc::new(())))
    }
    pub async fn plugin_data_scan(
        &self,
        namespace: &Namespace,
        query: Scan,
    ) -> Result<Page, StoreError> {
        self.plugin_storage(namespace)
            .await?
            .plugin_data_scan(namespace, query)
            .await
    }
    pub async fn plugin_data(
        &self,
        namespace: &Namespace,
        key: &str,
    ) -> Result<Option<Record>, StoreError> {
        self.plugin_storage(namespace)
            .await?
            .plugin_data(namespace, key)
            .await
    }
    pub async fn plugin_data_batch(
        &self,
        namespace: &Namespace,
        mutations: Vec<Mutation>,
    ) -> Result<Vec<Record>, StoreError> {
        self.plugin_storage(namespace)
            .await?
            .plugin_data_batch(namespace, mutations)
            .await
    }
}
