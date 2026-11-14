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

use crate::search::{SearchEndpoint, presets};
use maka_capabilities::credentials;
use maka_plugin_core::storage;
use maka_web_api::contract::Basis;
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
    pub(crate) async fn search_settings(&self) -> Result<SearchSettings, storage::StoreError> {
        let (revision, settings) = self.settings().await?;
        let endpoint = SearchEndpoint::resolve(&settings.backend)
            .map_err(|error| storage::StoreError::Unavailable(error.into()))?;
        let key = endpoint.credential_key(&settings.backend);
        let credential = match &key {
            Some(key) => self.credentials.read(key.clone()).await?,
            None => None,
        };
        Ok(SearchSettings {
            revision,
            settings,
            endpoint,
            key,
            credential,
        })
    }

    pub(crate) async fn search_is_current(
        &self,
        basis: &Basis,
        key: Option<&str>,
    ) -> Result<bool, storage::StoreError> {
        let revision = self
            .store
            .read(SETTINGS.into())
            .await?
            .map(|record| record.revision);
        if revision != basis.revision {
            return Ok(false);
        }
        match key {
            Some(key) => Ok(self
                .credentials
                .read(key.to_owned())
                .await?
                .is_some_and(|record| {
                    Some(record.revision) == basis.credential_revision
                        && record
                            .secret
                            .is_some_and(|secret| !secret.trim().is_empty())
                })),
            None => Ok(true),
        }
    }

    pub async fn snapshot(&self) -> Result<Snapshot, storage::StoreError> {
        let current = self.search_settings().await?;
        let key_revision = current.credential_revision();
        let configured = current.secret().is_some();
        let check = self
            .store
            .read(CHECK.into())
            .await?
            .and_then(|record| record.data.value().cloned())
            .map(serde_json::from_value::<Check>)
            .transpose()
            .map_err(encoding)?
            .filter(|check| {
                (current.key.is_none() || configured)
                    && check.settings_revision == current.revision
                    && check.credential_revision == key_revision
            });
        Ok(Snapshot {
            revision: current.revision,
            settings: current.settings,
            credential: Credential {
                revision: key_revision,
                configured,
                check,
            },
            presets: presets(),
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
    pub async fn record_check(
        &self,
        check: Check,
        key: Option<&str>,
    ) -> Result<bool, storage::StoreError> {
        let previous = self.store.read(CHECK.into()).await?;
        let basis = Basis {
            revision: check.settings_revision,
            credential_revision: check.credential_revision,
        };
        if !self.search_is_current(&basis, key).await? {
            return Ok(false);
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
            Ok(_) | Err(storage::StoreError::Conflict { .. }) => Ok(true),
            Err(error) => Err(error),
        }
    }
}
pub(crate) struct SearchSettings {
    pub revision: Option<u64>,
    pub settings: Settings,
    pub endpoint: SearchEndpoint,
    pub key: Option<String>,
    credential: Option<credentials::Record>,
}
impl SearchSettings {
    pub fn credential_revision(&self) -> Option<u64> {
        self.credential.as_ref().map(|value| value.revision)
    }
    pub fn secret(&self) -> Option<&str> {
        self.credential
            .as_ref()?
            .secret
            .as_deref()
            .filter(|secret| !secret.trim().is_empty())
    }
    pub fn available(&self) -> bool {
        self.settings.enabled && (self.key.is_none() || self.secret().is_some())
    }
    pub fn matches(&self, basis: &Basis) -> bool {
        self.available()
            && self.revision == basis.revision
            && self.credential_revision() == basis.credential_revision
    }
}

fn encoding(error: serde_json::Error) -> storage::StoreError {
    storage::StoreError::Unavailable(error.to_string())
}
