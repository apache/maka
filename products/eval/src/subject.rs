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

//! Subject adapter trait and implementations for the Rust Maka Host and external CLI harnesses.

pub mod external_cli;
pub mod maka;

pub use external_cli::ExternalCliSubject;
pub use maka::RustHostSubject;

use crate::contract::{ContractError, ExecutionOutcome, ExperimentCell, JsonObject, SubjectKind};
use crate::environment::{BoxFuture, SubjectExecutionContext};
use crate::measurement::{MeteringState, NormalizedUsage};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubjectExecutionResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    pub usage: Option<NormalizedUsage>,
    pub metering_state: MeteringState,
    pub cost_usd: Option<f64>,
    pub duration_ms: u64,
    pub outcome: ExecutionOutcome,
    pub failure_reason: Option<String>,
    pub artifacts: Vec<JsonObject>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invocation_id: Option<String>,
}

pub trait SubjectAdapter: Send + Sync {
    fn kind(&self) -> SubjectKind;

    fn validate(&self, _cell: &ExperimentCell) -> Result<(), ContractError> {
        Ok(())
    }

    fn execute<'a>(
        &'a self,
        cell: &'a ExperimentCell,
        context: SubjectExecutionContext,
    ) -> BoxFuture<'a, SubjectExecutionResult>;
}
