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

use futures_util::future::BoxFuture;
pub use maka_agent_facts::pricing::Entry;
pub use maka_agent_facts::pricing::Mutation;
pub use maka_agent_facts::pricing::Page;
pub use maka_agent_facts::pricing::Pricing;
pub use maka_agent_facts::pricing::Query;
pub use maka_agent_facts::pricing::Quote;
pub use maka_agent_facts::pricing::ResetEffect;
pub use maka_agent_facts::pricing::Update;
pub use maka_agent_facts::pricing::Updated;
use maka_agent_facts::tools::ToolError;
use maka_capabilities::authorization::CommandError;
use maka_capabilities::call::Scope;

/// Non-secret rates. Reads are available during activation; writes require an
/// explicitly authorized profile call. Neither operation dispatches a model.
pub trait Prices: Send + Sync {
    fn query(&self, input: Query) -> BoxFuture<'_, Result<Page, CommandError>>;
    /// CAS with durable revision; a lost reply may be followed by RevisionConflict.
    /// Accepted edits finish even if the caller stops waiting.
    fn update(&self, call: Scope, input: Update) -> BoxFuture<'_, Result<Updated, ToolError>>;
}
