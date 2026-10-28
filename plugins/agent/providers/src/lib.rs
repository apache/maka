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

//! Compiled model providers with explicit definitions for native service owners.
pub mod api;
pub mod catalog;
pub mod codex;
mod facts;

/// Compiled native provider policy. Persisted identities cannot name arbitrary
/// code or change the provider scope accepted by a native application.
pub fn definition(
    identity: &maka_agent_facts::provider::Identity,
    snapshot: std::sync::Arc<catalog::Snapshot>,
) -> Result<maka_agent_ports::provider::Definition, String> {
    use maka_plugin_core::scope::Scope;
    if identity.scope != Scope::Profile || identity.package_id != identity.entry_id {
        return Err("provider is unavailable".into());
    }
    match identity.package_id.as_str() {
        api::ID => api::ApiProviders::definition(&identity.name, snapshot),
        codex::ID if identity.name == "chatgpt" => {
            codex::Codex.definition().map_err(|e| e.to_string())
        }
        _ => Err("provider is unavailable".into()),
    }
}
