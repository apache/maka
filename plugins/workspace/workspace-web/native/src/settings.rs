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

use maka_capabilities::credentials;
use maka_plugin_core::storage;
use std::sync::Arc;

const SETTINGS: &str = "settings";
const CHECK: &str = "credential-check";

use maka_web_api::settings::*;

#[derive(Clone)]
pub struct Repository {
    pub store: Arc<dyn storage::Store>,
    pub credentials: Arc<dyn credentials::Credentials>,
}
impl Repository {
    pub async fn settings(&self) -> Result<(Option<u64>, Settings), storage::StoreError> {
        let record = self.store.read(SETTINGS.into()).await?;
        let revision = record.as_ref().map(|record| record.revision);
        let settings = match record.and_then(|record| record.data.value().cloned()) {
            Some(value) => serde_json::from_value(value).map_err(encoding)?,
            None => Settings::default(),
        };
        Ok((revision, settings))
    }
    pub async fn snapshot(&self) -> Result<Snapshot, storage::StoreError> {
        let (revision, settings) = self.settings().await?;
        let credential = self.credentials.read(KEY.into()).await?;
        let key_revision = credential.as_ref().map(|record| record.revision);
        let configured = credential
            .as_ref()
            .and_then(|record| record.secret.as_ref())
            .is_some_and(|secret| !secret.trim().is_empty());
        let check = self
            .store
            .read(CHECK.into())
            .await?
            .and_then(|record| record.data.value().cloned())
            .map(serde_json::from_value::<Check>)
            .transpose()
            .map_err(encoding)?
            .filter(|check| configured && Some(check.credential_revision) == key_revision);
        Ok(Snapshot {
            revision,
            settings,
            credential: Credential {
                revision: key_revision,
                configured,
                check,
            },
        })
    }
    pub async fn save(
        &self,
        expected: Option<u64>,
        settings: Settings,
    ) -> Result<storage::Record, storage::StoreError> {
        self.store
            .batch(vec![storage::Mutation {
                key: SETTINGS.into(),
                expected_revision: expected,
                data: storage::Data::Present(serde_json::to_value(settings).map_err(encoding)?),
            }])
            .await?
            .pop()
            .ok_or_else(|| storage::StoreError::Unavailable("settings receipt is missing".into()))
    }
    pub async fn record_check(&self, check: Check) -> Result<(), storage::StoreError> {
        let previous = self.store.read(CHECK.into()).await?;
        if let Some(value) = previous.as_ref().and_then(|record| record.data.value()) {
            let previous: Check = serde_json::from_value(value.clone()).map_err(encoding)?;
            // A slow check for an old key cannot replace a newer key's status.
            if previous.credential_revision > check.credential_revision {
                return Ok(());
            }
        }
        match self
            .store
            .batch(vec![storage::Mutation {
                key: CHECK.into(),
                expected_revision: previous.map(|record| record.revision),
                data: storage::Data::Present(serde_json::to_value(check).map_err(encoding)?),
            }])
            .await
        {
            Ok(_) | Err(storage::StoreError::Conflict { .. }) => Ok(()),
            Err(error) => Err(error),
        }
    }
}
fn encoding(error: serde_json::Error) -> storage::StoreError {
    storage::StoreError::Unavailable(error.to_string())
}
