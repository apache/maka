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

//! Additional execution access approved through canonical Host interactions.

use crate::call::Scope;
use futures_util::future::BoxFuture;
use maka_agent_facts::tools::ToolError;
pub use maka_sandbox::grant::Permissions;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub reason: String,
    pub permissions: Permissions,
}

pub trait Access: Send + Sync {
    /// Agent tools and Executors may ask under the current approval policy.
    /// Returns the approved subset, not a bearer token. Every effect rechecks
    /// its authority. Independent Remote/background work uses explicit consent.
    fn request(
        &self,
        call: Scope,
        request: Request,
    ) -> BoxFuture<'_, Result<Permissions, ToolError>>;
}
