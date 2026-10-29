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

//! Startup reconciliation of abandoned invocation facts, including uninstalled producers.
use crate::{EventLog, StoreError};
use maka_agent_facts::event::CommitError;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::ModelInterruption;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::tool_call::ToolRejection;

#[derive(Debug, thiserror::Error)]
pub enum RecoveryError {
    #[error(transparent)]
    Commit(#[from] CommitError),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("invalid recovery time: {0}")]
    Clock(String),
}

/// Requires exclusive Host Root ownership and no live model/tool workers.
/// Call before accepting connections or constructing execution workers. This
/// is not a live repair API: absence of T1 proves no effect only after the old
/// owner has exited. Errors fail host startup closed; retry requires reopening.
/// No model or tool executor is called, including for unfinished admissions.
pub async fn recover_invocations(log: &EventLog) -> Result<usize, RecoveryError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| RecoveryError::Clock(error.to_string()))?
        .as_millis();
    log.close_abandoned_interactions(
        u64::try_from(now).map_err(|error| RecoveryError::Clock(error.to_string()))?,
    )
    .await?;
    let mut after_sequence = 0;
    let mut recovered = 0;
    loop {
        let page = log.unfinished_invocations(after_sequence, 256).await?;
        if page.invocations.is_empty() {
            return Ok(recovered);
        }
        for invocation in &page.invocations {
            let state = log
                .invocation_recovery(invocation, 10_000, 8 * 1024 * 1024)
                .await?;
            let append = |fact| {
                let event = RuntimeEvent::new(invocation.clone(), fact);
                async move {
                    let write = maka_agent_facts::event::EventWrite::plain(event)?;
                    log.append(&write).await.map_err(RecoveryError::from)
                }
            };
            for step_id in state.unfinished_model_steps {
                append(Fact::ModelInterrupted {
                    partial: None,
                    model_failure: None,
                    step_id,
                    status: ModelInterruption::Failed,
                    diagnostic: Some("Host stopped before the model request settled.".into()),
                })
                .await?;
            }
            for call in state.undispatched_calls {
                // A refusal closes the accepted call without claiming dispatch.
                append(Fact::ToolRejected {
                    operation_id: call.operation_id,
                    call: call.identity,
                    name: call.name,
                    input: call.input,
                    reason: ToolRejection::Cancelled,
                })
                .await?;
            }
            append(Fact::InvocationEnded {
                outcome: InvocationOutcome::Failed {
                    model_failure: None,
                    class: if state.uncertain_operations.is_empty() && !state.unfinished_executor {
                        "host_interrupted"
                    } else {
                        "outcome_unknown"
                    }
                    .into(),
                    message: None,
                },
            })
            .await?;
        }
        recovered += page.invocations.len();
        after_sequence = page.through_sequence;
    }
}
