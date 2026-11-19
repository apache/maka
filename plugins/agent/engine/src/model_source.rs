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

use crate::RunError;
use futures_util::future::BoxFuture;
use maka_agent_facts::composition::SourceRevision;
use maka_agent_facts::context::ModelRequestContext;
use maka_model::ProviderConfig;
use serde_json::Value;

/// Host-owned preparation for one logical step. Selection remains bound to the
/// admitted Session model; retries do not call this interface again.
pub trait ModelSource: Send + Sync {
    fn capture(&self) -> BoxFuture<'_, Result<PreparedModel, RunError>>;
}

pub struct PreparedModel {
    pub provider_id: String,
    pub provider: ProviderConfig,
    pub options: Value,
    pub context: Option<ModelRequestContext>,
    pub main_output_limit: Option<u64>,
    pub supports_vision: bool,
    pub revision: SourceRevision,
}
