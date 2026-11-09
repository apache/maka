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

//! The durable Host queue is the only input authority; native writes never create messages.
use super::*;
use maka_agent_state::artifacts::{ArtifactStore, SessionScope};

pub(super) struct Steering {
    artifacts: ArtifactStore,
    scope: SessionScope,
    inputs: Arc<dyn Inputs>,
    task: maka_agent_facts::durable::ExternalTaskId,
    cancellation: CancellationToken,
    material_root: PathBuf,
}
impl Steering {
    pub fn new(
        artifacts: ArtifactStore,
        scope: SessionScope,
        cancellation: CancellationToken,
        inputs: Arc<dyn Inputs>,
        task: maka_agent_facts::durable::ExternalTaskId,
        material_root: PathBuf,
    ) -> Self {
        Self {
            artifacts,
            scope,
            inputs,
            task,
            cancellation,
            material_root,
        }
    }
    pub async fn ready(&self) -> Result<(), Error> {
        tokio::select! {
            biased;
            () = self.cancellation.cancelled() => std::future::pending().await,
            ready = self.inputs.steering_ready(self.task) => ready,
        }
    }
    pub async fn take(&mut self) -> Result<Option<Value>, Error> {
        let Some(content) = self.inputs.take_steering(self.task).await? else {
            return Ok(None);
        };
        if self.cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let mut materials = attachments::prepare(
            &self.artifacts,
            &self.scope,
            &content,
            &self.cancellation,
            &self.material_root,
        )
        .await?;
        let value = serde_json::json!({"message":materials.message,"images":materials.images});
        if self.cancellation.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let _ = materials.handoff();
        Ok(Some(value))
    }
}
