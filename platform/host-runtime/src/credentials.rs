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
use maka_capabilities::credentials;
use maka_capabilities::credentials::Record;
use maka_capabilities::credentials::Write;
use maka_capabilities::credentials::WriteResult;
use maka_config::ConfigurationStore;
use maka_plugin_core::storage::Namespace;
use maka_plugin_core::storage::StoreError;
use maka_plugin_core::storage::validate_key;
use maka_plugin_core::work::resources::Resources;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
#[derive(Clone)]
pub struct Credentials {
    pub configuration: Arc<ConfigurationStore>,
    pub namespace: Namespace,
    pub prefix: String,
    pub resources: Arc<Resources>,
    pub stopping: CancellationToken,
}
fn error(error: maka_config::ConfigError) -> StoreError {
    match error {
        maka_config::ConfigError::CommitUnknown => StoreError::OutcomeUnknown(error.to_string()),
        error => StoreError::Unavailable(error.to_string()),
    }
}
impl credentials::Credentials for Credentials {
    fn read(&self, key: String) -> BoxFuture<'_, Result<Option<Record>, StoreError>> {
        Box::pin(async move {
            if self.stopping.is_cancelled() {
                return Err(StoreError::Retired);
            }
            validate_key(&key).map_err(|e| StoreError::Unavailable(e.to_string()))?;
            self.configuration
                .plugin_credential(self.namespace.clone(), format!("{}{key}", self.prefix))
                .await
                .map_err(error)
        })
    }
    fn write(&self, mut input: Write) -> BoxFuture<'_, Result<WriteResult, StoreError>> {
        Box::pin(async move {
            if self.stopping.is_cancelled() {
                return Err(StoreError::Retired);
            }
            input
                .validate()
                .map_err(|e| StoreError::Unavailable(e.to_string()))?;
            input.key = format!("{}{}", self.prefix, input.key);
            let mut ticket = self.resources.reserve().map_err(|_| StoreError::Retired)?;
            let owner = self.clone();
            tokio::spawn(async move {
                ticket.start();
                let result = owner
                    .configuration
                    .write_plugin_credential(owner.namespace, input)
                    .await
                    .map_err(error);
                if matches!(result, Err(StoreError::OutcomeUnknown(_))) {
                    owner.stopping.cancel();
                }
                ticket.complete(Ok(()));
                result
            })
            .await
            .map_err(|_| StoreError::OutcomeUnknown("Credential worker disappeared".into()))?
        })
    }
}
