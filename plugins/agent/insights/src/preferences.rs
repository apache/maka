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

use maka_agent_facts::accounting::Selection;
use maka_plugin_core::storage;
use serde::{Deserialize, Serialize};

const KEY: &str = "view";

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
pub enum Range {
    #[serde(rename = "24h")]
    Day,
    #[default]
    #[serde(rename = "7d")]
    Week,
    #[serde(rename = "30d")]
    Month,
    #[serde(rename = "all")]
    All,
}
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tab {
    #[default]
    Overview,
    Activity,
    Providers,
    Models,
    Tools,
    Pricing,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub range: Range,
    pub tab: Tab,
    pub selection: Selection,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: Option<u64>,
    pub preferences: Preferences,
}

pub async fn read(store: &dyn storage::Store) -> Result<Snapshot, storage::StoreError> {
    let record = store.read(KEY.into()).await?;
    let revision = record.as_ref().map(|record| record.revision);
    let preferences = record
        .and_then(|record| record.data.value().cloned())
        .map(serde_json::from_value)
        .transpose()
        .map_err(encoding)?
        .unwrap_or_default();
    Ok(Snapshot {
        revision,
        preferences,
    })
}
pub async fn write(
    store: &dyn storage::Store,
    expected_revision: Option<u64>,
    preferences: Preferences,
) -> Result<Snapshot, storage::StoreError> {
    let record = store
        .batch(vec![storage::Mutation {
            key: KEY.into(),
            expected_revision,
            data: storage::Data::Present(serde_json::to_value(&preferences).map_err(encoding)?),
        }])
        .await?
        .pop()
        .ok_or_else(|| storage::StoreError::Unavailable("view receipt missing".into()))?;
    Ok(Snapshot {
        revision: Some(record.revision),
        preferences,
    })
}
fn encoding(error: serde_json::Error) -> storage::StoreError {
    storage::StoreError::Unavailable(error.to_string())
}
