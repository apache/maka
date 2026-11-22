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

//! Narrow host ports shared by ordinary service embeddings.
use futures_util::future::BoxFuture;
use maka_agent_facts::capability::FormResult;
use maka_agent_ports::execution::OfferInteraction;
use maka_capabilities::call::ReadResource;
use maka_capabilities::call::Scope;
use maka_capabilities::filesystem::Operation;
use maka_capabilities::filesystem::Output;
use maka_capabilities::process::Processes;
use maka_plugin_core::storage::Store;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
pub struct Ports {
    pub processes: Arc<dyn Processes>,
    pub storage: Arc<dyn Store>,
    pub callbacks: Arc<dyn Callbacks>,
}
/// An immutable attachment from the admitted request.
pub struct PromptAttachment {
    pub name: String,
    pub mime_type: String,
    pub resource: Arc<dyn ReadResource>,
}
/// Data observed from this call's original isolated process, not authority.
pub struct PrivatePaths {
    pub working_directory: String,
    pub history_file: String,
}

/// Each callback identity belongs to one accepted protocol callback. Repeated
/// pages retain it; separate identical requests are still separate operations.
pub trait Callbacks: Send + Sync {
    /// Observed from this call's actual isolated process, never the source cwd.
    fn private_paths(&self, scope: &Scope) -> Result<PrivatePaths, String>;

    /// Actual immutable resources from this admitted call, never filesystem locators.
    fn prompt_attachments(&self, _scope: &Scope) -> Result<Vec<PromptAttachment>, String> {
        Ok(vec![])
    }

    fn file(
        &self,
        scope: Scope,
        identity: String,
        operation: Operation,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<Output, String>>;
    fn form(
        &self,
        scope: Scope,
        offer: OfferInteraction,
        cancellation: CancellationToken,
    ) -> BoxFuture<'_, Result<Option<FormResult>, String>>;
}
