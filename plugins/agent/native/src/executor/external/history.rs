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
use maka_agent_facts::{
    durable::{ExternalTaskId, RunId},
    input::MessageInput,
};

/// The Agent owner supplies canonical history and the actual queue consumer.
/// A runtime ID, transcript or restored Request cannot recreate this capability.
pub(crate) trait Inputs: Send + Sync {
    fn artifacts(
        &self,
    ) -> (
        maka_agent_state::artifacts::ArtifactStore,
        maka_agent_state::artifacts::SessionScope,
    );
    fn write_history<'a>(
        &'a self,
        task: ExternalTaskId,
        last_delivered: Option<RunId>,
        writer: &'a mut (dyn tokio::io::AsyncWrite + Unpin + Send),
    ) -> BoxFuture<'a, Result<(), Error>>;
    /// Observation only: dropping this future must not consume a queue entry.
    fn steering_ready(&self, task: ExternalTaskId) -> BoxFuture<'_, Result<(), Error>>;
    /// Atomically consume the ordered original queue prefix, close superseded
    /// interactions and return attributed input. Called outside select!.
    fn take_steering(
        &self,
        task: ExternalTaskId,
    ) -> BoxFuture<'_, Result<Option<MessageInput>, Error>>;
}
