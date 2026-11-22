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

//! Safe diagnostic projections bind each domain's cause to its actual origin.

use crate::durable::ExecutionIdentity;

use crate::event::ModelInterruption;
use crate::model::error::ModelFailureCause;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TitleFailureCause {
    Preparation,
    Model { cause: ModelFailureCause },
    InvalidOutput,
    OutputLimit,
    EmptyOutput,
}
impl TitleFailureCause {
    pub fn validate(&self) -> Result<(), crate::model::error::ModelError> {
        match self {
            Self::Model { cause } => cause.validate(),
            _ => Ok(()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionFailureReason {
    SessionBusy,
    ContinuationChanged,
    ReconciliationRequired,
    InvalidInput,
    Cancelled,
    ModelIncomplete,
    ModelInterrupted,
    EventCommit,
    EventStore,
    ModelTimeout,
    ModelHttp,
    ModelAdapter,
    ModelProvider,
    ContextOverflow,
    ToolExecution,
    RuntimeInternal,
    CleanupUnconfirmed,
    Executor,
    MessagePreparationFailed,
    HostInterrupted,
    OutcomeUnknown,
    ExecutionFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DiagnosticDetail {
    Execution {
        execution: ExecutionIdentity,
        reason: ExecutionFailureReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_failure: Option<ModelFailureCause>,
    },
    ModelStep {
        execution: ExecutionIdentity,
        step_id: crate::durable::StepId,
        attempt_id: crate::durable::ModelAttemptId,
        status: ModelInterruption,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_failure: Option<ModelFailureCause>,
    },
    SessionTitle {
        execution: ExecutionIdentity,
        cause: TitleFailureCause,
    },
}
