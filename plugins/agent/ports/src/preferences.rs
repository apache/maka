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

//! Read-only, non-secret user preferences shared by native and JS plugins.
use futures_util::future::BoxFuture;
use maka_agent_facts::configuration::policy::Personalization;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub revision: u64,
    pub personalization: Personalization,
    pub workspace_instructions: bool,
}

/// This view is not configuration authority: it grants no filesystem or
/// execution permission and contains no credentials or provider settings.
pub trait Preferences: Send + Sync {
    fn read(&self) -> BoxFuture<'_, Result<Snapshot, crate::Error>>;
}

/// User-facing preference edits are admitted by the captured Remote caller.
/// This contract cannot change sandbox, credentials or execution policy.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Mutation {
    Personalization { value: Personalization },
    WorkspaceInstructions { enabled: bool },
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Update {
    pub expected_revision: u64,
    pub mutation: Mutation,
}
pub use maka_agent_facts::configuration::policy::RuntimePolicyMutationResult as Updated;
