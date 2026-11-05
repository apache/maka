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
    last_delivered_run: Option<String>,
    bootstrap_completed: bool,
    instructions_digest: Option<String>,
}
pub(super) struct InstructionUpdate {
    digest: String,
    pub text: String,
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
                bootstrap_completed: false,
                instructions_digest: None,
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
    pub fn instruction_update(&self, instructions: Option<&str>) -> Option<InstructionUpdate> {
        let digest = instruction_digest(instructions);
        if self.record.instructions_digest.as_deref() == Some(digest.as_str())
            || (instructions.is_none() && self.record.instructions_digest.is_none())
        {
            return None;
        }
        let text = match instructions {
            Some(text) => format!("These are the current Maka instructions. They replace all earlier Maka instruction blocks; do not retain superseded Maka instructions.\n\n{text}"),
            None => "The previous Maka instruction blocks are now cleared. Do not apply their instructions to subsequent requests. Continue following your native system instructions and the user's requests.".into(),
        };
        Some(InstructionUpdate { digest, text })
    }
    pub async fn confirm_instructions(
        &mut self,
        storage: &Storage,
        update: InstructionUpdate,
    ) -> Result<(), Error> {
        let mut next = self.record.clone();
        next.instructions_digest = Some(update.digest);
        self.save(storage, next).await
    }
    pub fn bootstrap_completed(&self) -> bool {
        self.record.bootstrap_completed
    }
    pub async fn complete_bootstrap(&mut self, storage: &Storage) -> Result<(), Error> {
        let mut next = self.record.clone();
        next.bootstrap_completed = true;
        if next.instructions_digest.is_none() {
            next.instructions_digest = Some(instruction_digest(None));
        }
        self.save(storage, next).await
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
    // Caller proved this invocation allocated the UUID, submitted no prompt, and settled native cleanup.
    pub async fn revoke_unsubmitted(&mut self, storage: &Storage) -> Result<(), Error> {
        let mut next = self.record.clone();
        next.native_session = None;
        next.bootstrap_completed = false;
        next.instructions_digest = None;
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
fn instruction_digest(instructions: Option<&str>) -> String {
    let mut digest = Sha256::new();
    digest.update([u8::from(instructions.is_some())]);
    if let Some(text) = instructions {
        digest.update(text.as_bytes());
    }
    hex::encode(digest.finalize())
}

fn error(error: maka_capabilities::storage::StoreError) -> Error {
    Error::Persistence(error.to_string())
}
