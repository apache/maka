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

//! Durable retry decisions and exact checkpoint consumption evidence.
use crate::model::retry_transport::RetryTransportPhase;
use serde::{Deserialize, Serialize};

/// One decision's immutable deadline and post-decision phase budget.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetryPlan {
    pub failure_event_id: String,
    pub not_before_unix_ms: u64,
    pub failures: u32,
    pub transport_phase: RetryTransportPhase,
}

/// A request must consume this exact active checkpoint in its append transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModelRetryConsumption {
    pub checkpoint_id: String,
    pub revision: u64,
    pub plan: RetryPlan,
}
