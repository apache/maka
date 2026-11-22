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

//! Application invocation channels over authenticated physical streams.
//! The embedding authenticates a channel before selecting its peer approval.
mod catalogue;
mod client;
mod endpoints;
mod gateway;
mod policy;
mod server;
/// Bounded framing shared with trusted process bootstraps.
pub mod wire;
pub use catalogue::{Catalogue, Description, Selection};
pub use client::Call;
pub use endpoints::{Endpoints, HostEndpoint};
pub use gateway::{GATEWAY, with_gateway};
pub use policy::{Endpoint, NativeGrant, Peer, PeerApproval, PeerPolicy, Peers};
pub use server::Server;
pub use wire::{Reply, Source};

/// Explicit trusted exposure of methods on one captured service binding.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grant {
    pub methods: std::collections::BTreeSet<String>,
    pub recovery: bool,
}

pub use gateway::native as gateway_native;
