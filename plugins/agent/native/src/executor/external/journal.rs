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
use maka_capabilities::storage::{Data, Mutation};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    cwd: String,
    native_session: Option<String>,
    running: Option<String>,
    #[serde(default)]
    last_delivered_run: Option<String>,
}
pub(super) struct Journal {
    key: String,
    revision: Option<u64>,
    record: Record,
}
impl Journal {
    pub async fn load(storage: &Storage, request: &Request) -> Result<Self, Error> {
        let key = format!(
            "conversation/{}",
            hex::encode(Sha256::digest(
                serde_json::to_vec(&(&request.conversation_key, &request.settings.runtime))
                    .map_err(|e| Error::Invalid(e.to_string()))?
            ))
        );
        let previous = storage.read(key.clone()).await.map_err(error)?;
        let revision = previous.as_ref().map(|r| r.revision);
        let record = match previous.and_then(|r| r.data.value().cloned()) {
            Some(value) => serde_json::from_value::<Record>(value)
                .map_err(|e| Error::Persistence(e.to_string()))?,
            None => Record {
                cwd: request.cwd.clone(),
                native_session: None,
                running: None,
                last_delivered_run: None,
            },
        };
        if record.cwd != request.cwd {
            return Err(Error::Invalid(
                "External agent conversation workspace changed".into(),
            ));
        }
        if record.running.is_some() {
            return Err(Error::Unknown);
        }
        Ok(Self {
            key,
            revision,
            record,
        })
    }
    pub fn last_delivered_run(&self) -> Option<&str> {
        self.record.last_delivered_run.as_deref()
    }
    pub async fn start(&mut self, storage: &Storage, invocation: &str) -> Result<(), Error> {
        let mut next = self.record.clone();
        next.running = Some(invocation.into());
        self.save(storage, next).await
    }
    pub async fn delivered(&mut self, storage: &Storage, run: &str) -> Result<(), Error> {
        let mut next = self.record.clone();
        next.last_delivered_run = Some(run.into());
        self.save(storage, next).await
    }
    pub fn native_session(&self) -> Option<&str> {
        self.record.native_session.as_deref()
    }
    pub async fn opened(&mut self, storage: &Storage, id: String) -> Result<(), Error> {
        if self
            .record
            .native_session
            .as_ref()
            .is_some_and(|previous| *previous != id)
        {
            return Err(Error::Invalid(
                "External agent did not resume the original native session".into(),
            ));
        }
        let mut next = self.record.clone();
        next.native_session = Some(id);
        self.save(storage, next).await
    }
    pub async fn ready(&mut self, storage: &Storage) -> Result<(), Error> {
        let mut next = self.record.clone();
        next.running = None;
        self.save(storage, next).await
    }
    async fn save(&mut self, storage: &Storage, record: Record) -> Result<(), Error> {
        let updated = storage
            .batch(vec![Mutation {
                key: self.key.clone(),
                expected_revision: self.revision,
                data: Data::Present(
                    serde_json::to_value(&record).map_err(|e| Error::Persistence(e.to_string()))?,
                ),
            }])
            .await
            .map_err(error)?;
        self.revision = Some(
            updated
                .first()
                .ok_or_else(|| Error::Persistence("External agent journal receipt missing".into()))?
                .revision,
        );
        self.record = record;
        Ok(())
    }
}
fn error(error: maka_capabilities::storage::StoreError) -> Error {
    Error::Persistence(error.to_string())
}
