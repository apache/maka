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
use maka_agent_facts::durable::RunId;
use maka_host_runtime::storage::Storage;
use maka_plugin_core::storage::{Data, Mutation, Store};
use maka_process::isolated::{Descriptor, SnapshotProof, TaskOwner};

pub(super) struct InstructionUpdate {
    digest: String,
    pub text: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Session {
    native_session: Option<String>,
    instructions_digest: Option<String>,
    last_delivered_run: Option<RunId>,
}

/// The session checkpoint follows the native conversation. Task bindings still
/// identify exactly one original execution for recovery.
pub(super) struct ProtocolSession {
    session: Session,
    storage: Storage,
    key: String,
    revision: Option<u64>,
    run: RunId,
    observation: runtime::Observation,
    command_basis: String,
    resource: Descriptor,
    snapshot: Option<SnapshotProof>,
}
impl ProtocolSession {
    pub async fn load(
        storage: Storage,
        request: &Request,
        binding: Arc<dyn TaskBinding>,
        command_basis: String,
        owner: &TaskOwner,
        raw: CancellationToken,
    ) -> Result<Self, Error> {
        let key = format!(
            "native-session/{}",
            hex::encode(Sha256::digest(
                serde_json::to_vec(&(
                    &request.conversation_key,
                    &request.settings.runtime,
                    &command_basis
                ))
                .map_err(persistence)?,
            ))
        );
        let record = storage.read(key.clone()).await.map_err(persistence)?;
        let revision = record.as_ref().map(|record| record.revision);
        let session = match record.and_then(|record| record.data.value().cloned()) {
            Some(record) => serde_json::from_value(record).map_err(persistence)?,
            None => Session::default(),
        };
        Ok(Self {
            session,
            storage,
            key,
            revision,
            run: request.execution.run_id,
            observation: runtime::Observation::new(binding, raw),
            command_basis,
            resource: owner.descriptor(),
            snapshot: owner.snapshot().cloned(),
        })
    }
    pub fn observation(&self) -> runtime::Observation {
        self.observation.clone()
    }
    pub async fn closed(&self, outcome: Outcome) -> Result<(), Error> {
        self.observation.closed(outcome).await
    }
    pub async fn bind_task(&self, task: NativeTask) -> Result<(), Error> {
        self.observation
            .binding
            .bound(NativeBinding {
                adapter_version: match task {
                    NativeTask::AntigravityAcp { .. } => AGY_ACP_VERSION,
                    _ => PRESENTATION_VERSION,
                },
                command_basis: self.command_basis.clone(),
                resource: self.resource.clone(),
                snapshot: self.snapshot.clone(),
                task,
            })
            .await?;
        let mut session = self.session.clone();
        session.last_delivered_run = Some(self.run);
        self.save(&session).await?;
        Ok(())
    }
    pub fn last_delivered_run(&self) -> Option<RunId> {
        self.session.last_delivered_run
    }
    pub fn instruction_update(&self, instructions: Option<&str>) -> Option<InstructionUpdate> {
        let digest = instruction_digest(instructions);
        if self.session.instructions_digest.as_deref() == Some(digest.as_str())
            || (instructions.is_none() && self.session.instructions_digest.is_none())
        {
            return None;
        }
        let text = instruction_text(instructions);
        Some(InstructionUpdate { digest, text })
    }
    pub async fn confirm_instructions(
        &mut self,
        update: Option<InstructionUpdate>,
    ) -> Result<(), Error> {
        self.session.instructions_digest =
            Some(update.map_or_else(|| instruction_digest(None), |update| update.digest));
        self.revision = Some(self.save(&self.session).await?);
        Ok(())
    }
    pub fn native_session(&self) -> Option<&str> {
        self.session.native_session.as_deref()
    }
    pub fn opened(&mut self, id: String) -> Result<(), Error> {
        if self.native_session().is_some_and(|previous| previous != id) {
            return Err(Error::Invalid(
                "External agent changed this task's native session".into(),
            ));
        }
        self.session.native_session = Some(id);
        Ok(())
    }
    async fn save(&self, session: &Session) -> Result<u64, Error> {
        let receipt = self
            .storage
            .batch(vec![Mutation {
                key: self.key.clone(),
                expected_revision: self.revision,
                data: Data::Present(serde_json::to_value(session).map_err(persistence)?),
            }])
            .await
            .map_err(persistence)?;
        receipt
            .first()
            .map(|record| record.revision)
            .ok_or_else(|| {
                Error::Persistence("External agent session checkpoint receipt missing".into())
            })
    }
}

pub(super) fn instruction_text(instructions: Option<&str>) -> String {
    match instructions {
            Some(text) => format!("These are the current Maka instructions. They replace all earlier Maka instruction blocks; do not retain superseded Maka instructions.\n\n{text}"),
            None => "The previous Maka instruction blocks are now cleared. Do not apply their instructions to subsequent requests. Continue following your native system instructions and the user's requests.".into(),
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

fn persistence(error: impl std::fmt::Display) -> Error {
    Error::Persistence(error.to_string())
}
