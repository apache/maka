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

mod output;

use crate::{Engine, RunContext, RunError, RunningInvocation};
use maka_agent_facts::event::EventWrite;
use maka_agent_facts::event::Fact;
use maka_agent_facts::event::InvocationInput;
use maka_agent_facts::event::InvocationOutcome;
use maka_agent_facts::event::RuntimeEvent;
use maka_agent_facts::execution::InvocationConfiguration;
use maka_agent_facts::message::RootSourceMessage;
use maka_agent_ports::executor::Backend;
use maka_agent_ports::executor::Error;
use maka_agent_ports::executor::Outcome;
use maka_agent_ports::executor::Request;
use maka_event_log::root_store::SessionStore;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct ExecutorInput<B> {
    pub request: Request,
    pub binding: B,
    pub configuration: InvocationConfiguration,
    pub request_fingerprint: Option<String>,
    pub source_messages: Vec<RootSourceMessage>,
}

impl Engine {
    pub async fn start_executor<B: Backend>(
        &self,
        store: SessionStore,
        input: ExecutorInput<B>,
        cancellation: CancellationToken,
    ) -> Result<RunningInvocation, RunError> {
        crate::require_session(&store, &input.request.invocation)?;
        if input.configuration.model.is_some() || input.configuration.cwd != input.request.cwd {
            return Err(RunError::InvalidInput(
                "executor cannot carry a model binding or mismatched workspace".into(),
            ));
        }
        maka_agent_facts::message::validate_sources(&input.request.content, &input.source_messages)
            .map_err(|reason| RunError::InvalidInput(reason.into()))?;
        let admitted = input
            .binding
            .admit_execution(input.request.clone())
            .map_err(|error| RunError::InvalidInput(error.to_string()))?;
        let identity = admitted.identity;
        identity
            .validate()
            .map_err(|error| RunError::InvalidInput(error.into()))?;
        let call = admitted.execution;
        let execution = store
            .execution_scope(crate::permission_basis(&input.configuration))
            .await?;
        let inner = RunContext::new(self.0.clone(), execution.store(), &input.request.invocation)?;
        inner
            .clone()
            .start_owned(
                execution,
                input.request.invocation.clone(),
                Arc::default(),
                None,
                cancellation,
                move |cancellation, admitted, effects| async move {
                    if cancellation.is_cancelled() {
                        return Err(RunError::Cancelled);
                    }
                    let invocation = input.request.invocation;
                    // The durable backend identity precedes every external effect, in
                    // the same transaction as the invocation admission.
                    let writes = [
                        Fact::InvocationOpened {
                            configuration: Some(Box::new(input.configuration)),
                            input: InvocationInput::Message {
                                content: input.request.content,
                                request_fingerprint: input.request_fingerprint,
                                source_messages: input.source_messages,
                            },
                        },
                        Fact::ExecutorStarted {
                            binding: identity,
                            settings: input.request.settings,
                        },
                    ]
                    .into_iter()
                    .map(|fact| EventWrite::plain(RuntimeEvent::new(invocation.clone(), fact)))
                    .collect::<Result<Vec<_>, _>>()?;
                    inner.log.append_batch(&writes).await?;
                    let _ = admitted.send(());
                    let output = Arc::new(output::Recorder::new(
                        inner.log.clone(),
                        invocation.clone(),
                        cancellation.clone(),
                    ));
                    let settlement = call
                        .execute(
                            inner.log.execution_custody()?,
                            output.clone(),
                            cancellation.clone(),
                        )
                        .await;
                    if matches!(&settlement.result, Err(Error::CleanupUnconfirmed)) {
                        crate::cleanup::unconfirmed();
                    }
                    let outcome = match effects.settle().await {
                        Ok(()) => outcome(&settlement.result, &cancellation),
                        Err(error) => {
                            crate::cleanup::unconfirmed();
                            InvocationOutcome::Failed {
                                class: "outcome_unknown".into(),
                                model_failure: None,
                                message: Some(error.to_string().chars().take(2048).collect()),
                            }
                        }
                    };
                    let committed = output.finish(&settlement.result, &outcome).await;
                    drop(settlement); // the terminal fact owns the lease through its commit
                    committed?;
                    match outcome {
                        InvocationOutcome::Completed => {
                            Ok(crate::ActivationExit::Terminal(invocation))
                        }
                        InvocationOutcome::Cancelled { .. } => Err(RunError::Cancelled),
                        InvocationOutcome::Failed { message, .. } => Err(RunError::Internal(
                            message.unwrap_or_else(|| "external executor failed".into()),
                        )),
                        _ => unreachable!("executor outcomes"),
                    }
                },
            )
            .await
    }
}

fn outcome(result: &Result<Outcome, Error>, cancellation: &CancellationToken) -> InvocationOutcome {
    match result {
        Ok(Outcome::Completed { .. }) if !cancellation.is_cancelled() => {
            InvocationOutcome::Completed
        }
        Err(Error::Cancelled) | Ok(Outcome::Completed { .. }) => InvocationOutcome::Cancelled {
            source: "runtime_cancellation".into(),
        },
        Ok(Outcome::Cancelled { .. }) => InvocationOutcome::Cancelled {
            source: "executor_provider".into(),
        },
        Err(Error::Retired) => InvocationOutcome::Cancelled {
            source: "executor_retired".into(),
        },
        Ok(Outcome::Failed { message, .. }) => InvocationOutcome::Failed {
            model_failure: None,
            class: "executor".into(),
            message: Some(message.chars().take(2048).collect()),
        },
        Err(error) => InvocationOutcome::Failed {
            model_failure: None,
            class: if matches!(error, Error::CleanupUnconfirmed | Error::Unknown) {
                "outcome_unknown"
            } else {
                "executor"
            }
            .into(),
            message: Some(error.to_string().chars().take(2048).collect()),
        },
    }
}
