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

//! Actual native authority for an executor call and its imported protocol process.
use futures_util::future::BoxFuture;
use maka_agent_facts::durable::{ExecutionIdentity, ExternalTaskId};
use maka_agent_facts::interaction::{InteractionOutcome, InteractionRecord};
pub use maka_agent_ports::executor::Error;
use maka_host_runtime::application::Context;
use std::sync::Arc;

pub const HISTORY_FILE: &str = "canonical-history.md";

/// One original role is forwarded unchanged through the admitted service chain.
/// Neither this wrapper nor an implementation grants authority by itself: the
/// issuing native owner recognizes its own actual Context, custody and driver.
pub struct ExecutorCallContext(pub Arc<dyn ExecutorAccess>);

pub trait ExecutorAccess: Send + Sync {
    fn task_id(&self) -> ExternalTaskId;
    fn execution(&self) -> &ExecutionIdentity;
    fn observation_retired(&self) -> tokio_util::sync::CancellationToken;
    fn stop_requested(&self) -> BoxFuture<'_, Result<bool, Error>>;
    fn validate<'a>(&'a self, context: &'a Context) -> BoxFuture<'a, Result<(), Error>>;
    fn publish_form<'a>(
        &'a self,
        context: &'a Context,
        record: &'a InteractionRecord,
    ) -> BoxFuture<'a, Result<Option<InteractionOutcome>, String>>;
    /// Consume the original linear preparation, never snapshot or launch a replacement.
    /// No request path, saved descriptor or permission JSON selects the source.
    fn prepare_private_task<'a>(
        &'a self,
        context: &'a Context,
        selected: &'a maka_process::Command,
    ) -> BoxFuture<'a, Result<maka_process::isolated::TaskOwner, Error>>;
}
