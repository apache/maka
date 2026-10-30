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

//! Provenance for managed physical directories; skill contents remain in the filesystem.
use maka_capabilities::storage::{Data, Mutation, Namespace, Scan};
use maka_event_log::RootStore;
use maka_skills_api::contract::Installation;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Clone)]
pub(super) struct Registrations {
    log: Arc<RootStore>,
}
#[derive(Deserialize, Serialize)]
struct Registration {
    path: String,
    installation: Installation,
}
pub(super) struct Current {
    pub revision: Option<u64>,
    pub installation: Option<Installation>,
}
const PREFIX: &str = "installations/";
fn namespace() -> Namespace {
    Namespace::new(
        maka_skills_api::IMPLEMENTATION,
        maka_plugin_core::scope::Scope::Profile,
    )
    .expect("built-in skills namespace")
}
fn key(path: &str) -> String {
    format!(
        "{PREFIX}{}",
        maka_agent_facts::artifact::content_digest(path.as_bytes())
    )
}
impl Registrations {
    pub fn new(log: Arc<RootStore>) -> Self {
        Self { log }
    }

    pub async fn list(&self) -> Result<BTreeMap<String, Installation>, String> {
        let mut result = BTreeMap::new();
        let mut after = None;
        loop {
            let page = self
                .log
                .plugin_data_scan(
                    &namespace(),
                    Scan {
                        prefix: PREFIX.into(),
                        after,
                    },
                )
                .await
                .map_err(|error| error.to_string())?;
            for entry in page.entries {
                if let Data::Present(value) = entry.record.data {
                    let record: Registration =
                        serde_json::from_value(value).map_err(|error| error.to_string())?;
                    result.insert(record.path, record.installation);
                }
            }
            match page.next_after {
                Some(next) => after = Some(next),
                None => return Ok(result),
            }
        }
    }
    pub async fn read(&self, path: &str) -> Result<Current, String> {
        let record = self
            .log
            .plugin_data(&namespace(), &key(path))
            .await
            .map_err(|error| error.to_string())?;
        let revision = record.as_ref().map(|record| record.revision);
        let installation = match record.map(|record| record.data) {
            Some(Data::Present(value)) => Some(
                serde_json::from_value::<Registration>(value)
                    .map_err(|error| error.to_string())?
                    .installation,
            ),
            Some(Data::Deleted) | None => None,
        };
        Ok(Current {
            revision,
            installation,
        })
    }
    pub async fn write(
        &self,
        path: &str,
        revision: Option<u64>,
        installation: Option<Installation>,
    ) -> Result<(), String> {
        let data = match installation {
            Some(installation) => Data::Present(
                serde_json::to_value(Registration {
                    path: path.into(),
                    installation,
                })
                .map_err(|error| error.to_string())?,
            ),
            None => Data::Deleted,
        };
        self.log
            .plugin_data_batch(
                &namespace(),
                vec![Mutation {
                    key: key(path),
                    expected_revision: revision,
                    data,
                }],
            )
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}
