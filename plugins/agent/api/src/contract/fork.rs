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

use super::{Rejection, Session};
use maka_plugin_core::operation::RecoveryRef;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentFork")]
pub struct Fork {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(range(min = 1, max = 9_007_199_254_740_991u64))]
    pub expected_revision: u64,
    /// Include history through a complete logical Turn, or all current history when null.
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<String>",
        length(min = 1)
    )]
    pub turn_id: Option<String>,
    #[schemars(length(min = 1))]
    pub title: String,
    pub labels: Vec<String>,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
#[schemars(rename = "AgentForkResult")]
pub enum ForkResult {
    Forked { session: Box<Session> },
    RevisionConflict { expected: u64, actual: u64 },
    Rejected { reason: Rejection },
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentForkReceipt")]
pub struct ForkReceipt {
    /// The complete original fork operation reference, including its fingerprint.
    pub reference: RecoveryRef,
}

#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentForkReceiptResult")]
pub struct ForkReceiptResult {
    /// A currently readable published fork. Null neither proves no effect nor
    /// authorizes replacing or redispatching the original operation.
    #[schemars(with = "maka_plugin_core::wire_schema::RequiredNullable<Box<Session>>")]
    pub session: Option<Box<Session>>,
}

/// Frozen conversation ancestry for presentation, not authority over the source.
#[derive(Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(rename = "AgentSessionBranch")]
pub struct SessionBranch {
    #[schemars(length(min = 1))]
    pub session_id: String,
    #[schemars(
        with = "maka_plugin_core::wire_schema::RequiredNullable<String>",
        length(min = 1)
    )]
    pub turn_id: Option<String>,
}
