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
use maka_process::isolated::{Descriptor, SnapshotProof, TaskOwner};

pub(super) struct InstructionUpdate {
    digest: String,
    pub text: String,
}

/// State of this one private native session. Cross-task context comes only from
/// canonical history, never a previous native HOME or daemon session.
pub(super) struct ProtocolSession {
    native_session: Option<String>,
    bootstrap_completed: bool,
    instructions_digest: Option<String>,
    observation: runtime::Observation,
    command_basis: String,
    resource: Descriptor,
    snapshot: SnapshotProof,
}
impl ProtocolSession {
    pub fn new(
        binding: Arc<dyn TaskBinding>,
        command_basis: String,
        owner: &TaskOwner,
        raw: CancellationToken,
    ) -> Self {
        Self {
            native_session: None,
            bootstrap_completed: false,
            instructions_digest: None,
            observation: runtime::Observation::new(binding, raw),
            command_basis,
            resource: owner.descriptor(),
            snapshot: owner.snapshot().clone(),
        }
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
                adapter_version: PRESENTATION_VERSION,
                command_basis: self.command_basis.clone(),
                resource: self.resource.clone(),
                snapshot: self.snapshot.clone(),
                task,
            })
            .await
    }
    pub fn instruction_update(&self, instructions: Option<&str>) -> Option<InstructionUpdate> {
        let digest = instruction_digest(instructions);
        if self.instructions_digest.as_deref() == Some(digest.as_str())
            || (instructions.is_none() && self.instructions_digest.is_none())
        {
            return None;
        }
        let text = instruction_text(instructions);
        Some(InstructionUpdate { digest, text })
    }
    pub fn confirm_instructions(&mut self, update: InstructionUpdate) {
        self.instructions_digest = Some(update.digest);
    }
    pub fn bootstrap_completed(&self) -> bool {
        self.bootstrap_completed
    }
    pub fn complete_bootstrap(&mut self) {
        self.bootstrap_completed = true;
        if self.instructions_digest.is_none() {
            self.instructions_digest = Some(instruction_digest(None));
        }
    }
    pub fn native_session(&self) -> Option<&str> {
        self.native_session.as_deref()
    }
    pub fn opened(&mut self, id: String) -> Result<(), Error> {
        if self
            .native_session
            .as_ref()
            .is_some_and(|previous| previous != &id)
        {
            return Err(Error::Invalid(
                "External agent changed this task's native session".into(),
            ));
        }
        self.native_session = Some(id);
        Ok(())
    }
    pub fn revoke_unsubmitted(&mut self) {
        self.native_session = None;
        self.bootstrap_completed = false;
        self.instructions_digest = None;
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
