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

use super::*;
use maka_agent_facts::durable::{self, Fact, FactId, RunId, Terminal, UnixMillis};
use maka_agent_state::{Change, fold::RunView};

pub(super) fn project(view: &RunView) -> Execution {
    let state = match &view.terminal {
        Some(Terminal::Completed) => ExecutionState::Completed,
        Some(Terminal::Failed) => ExecutionState::Failed {
            reason: view.recovery_failure().cloned(),
        },
        Some(Terminal::Cancelled) => ExecutionState::Cancelled,
        None => {
            let waits: Vec<_> = view
                .waits
                .values()
                .filter(|wait| wait.satisfied.is_none() && wait.cancelled.is_none())
                .map(|wait| wait.reason.clone())
                .collect();
            let authority_unavailable = view.waiting_for_authority();
            if !waits.is_empty() || authority_unavailable {
                ExecutionState::Waiting {
                    waits,
                    authority_unavailable,
                }
            } else if view.current_step.is_none() && !view.stopped {
                ExecutionState::Admitted
            } else {
                ExecutionState::Running
            }
        }
    };
    Execution {
        session_id: view.spec.session_id.clone(),
        turn_id: view.spec.turn_id.clone(),
        run_id: view.run,
        high_water: view.revision,
        state,
    }
}

impl Owner {
    pub(super) async fn session_run(
        &self,
        session: &str,
        run: RunId,
    ) -> Result<Option<RunView>, String> {
        self.session(session).await?;
        let view = self
            .durable
            .find_run(run)
            .await
            .map_err(|error| error.to_string())?;
        Ok(view
            .filter(|view| view.spec.session_id == session && view.spec.owner == self.run_owner()))
    }

    pub(crate) async fn work_readiness(&self, input: WorkRead) -> Result<WorkReadiness, String> {
        self.require_session(&input.session_id).await?;
        let ordered = match self.runs.try_ordered(&input.session_id) {
            Ok(ordered) => ordered,
            Err(_) => return Ok(WorkReadiness::Pending),
        };
        let runs = ordered.state().await;
        if runs.closing || self.stop.is_cancelled() {
            return Ok(WorkReadiness::Unavailable);
        }
        if runs.busy(&input.session_id) {
            return Ok(WorkReadiness::Pending);
        }
        drop(runs);
        let run = match input.target {
            WorkTarget::Run { run_id } => Some(run_id),
            WorkTarget::Message { message_id } => {
                match self
                    .durable
                    .queue()
                    .resolve_message(input.session_id.clone(), message_id)
                    .await
                    .map_err(|error| error.to_string())?
                {
                    maka_agent_state::queue::MessageResolution::Delivered { run, .. } => Some(run),
                    maka_agent_state::queue::MessageResolution::Cancelled => None,
                    maka_agent_state::queue::MessageResolution::Pending => {
                        return Ok(WorkReadiness::Pending);
                    }
                    maka_agent_state::queue::MessageResolution::Missing => {
                        return Ok(WorkReadiness::Unavailable);
                    }
                }
            }
        };
        if let Some(run) = run {
            let Some(view) = self.session_run(&input.session_id, run).await? else {
                return Ok(WorkReadiness::Unavailable);
            };
            if !matches!(
                &view.spec.origin,
                maka_agent_facts::durable::RunOrigin::Local
            ) {
                return Ok(WorkReadiness::Unavailable);
            }
            if view.terminal.is_none() {
                return Ok(WorkReadiness::Pending);
            }
        }
        let canonical = self
            .durable
            .session_quiescence(self.run_owner(), input.session_id)
            .await
            .map_err(|error| error.to_string())?;
        Ok(if canonical.is_quiescent() {
            WorkReadiness::Ready
        } else {
            WorkReadiness::Pending
        })
    }

    pub async fn work(&self, input: WorkRead) -> Result<Work, String> {
        use maka_agent_state::queue::MessageResolution;
        self.session(&input.session_id).await?;
        let (run, shared) = match input.target {
            WorkTarget::Run { run_id } => (run_id, false),
            WorkTarget::Message { message_id } => {
                match self
                    .durable
                    .queue()
                    .resolve_message(input.session_id.clone(), message_id)
                    .await
                    .map_err(|error| error.to_string())?
                {
                    MessageResolution::Missing => return Ok(Work::Missing),
                    MessageResolution::Pending => return Ok(Work::Pending),
                    MessageResolution::Cancelled => return Ok(Work::Cancelled),
                    MessageResolution::Delivered { run, shared } => (run, shared),
                }
            }
        };
        if input
            .cursor
            .as_ref()
            .is_some_and(|cursor| cursor.run_id != run)
        {
            return Ok(Work::Changed);
        }
        let offset = input.cursor.as_ref().map_or(0, |cursor| cursor.offset);
        let Some(observed) = self
            .durable
            .work(run, offset, 8192)
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(Work::Missing);
        };
        if observed.view.spec.session_id != input.session_id
            || observed.view.spec.owner != self.run_owner()
        {
            return Ok(Work::Missing);
        }
        let pending_interactions = observed
            .pending_interactions
            .try_into()
            .map_err(|_| "agent_interaction_count_overflow")?;
        let answer = if observed.answer.high_water == 0 {
            None
        } else {
            Some(AnswerPage {
                text: observed.answer.text,
                next: observed.answer.next.map(|offset| AnswerCursor {
                    run_id: run,
                    offset,
                }),
            })
        };
        Ok(Work::Delivered {
            shared,
            execution: project(&observed.view),
            answer,
            pending_interactions,
        })
    }

    pub async fn execution(&self, input: ExecutionRead) -> Result<ExecutionResult, String> {
        Ok(
            match self.session_run(&input.session_id, input.run_id).await? {
                Some(view) => ExecutionResult::Found {
                    execution: project(&view),
                },
                None => ExecutionResult::Missing,
            },
        )
    }

    pub async fn continue_run(
        self: &Arc<Self>,
        input: ContinueRun,
        operation: &maka_plugin_core::operation::RecoveryRef,
        parent: &maka_capabilities::call::Scope,
    ) -> Result<send::NativeMutation<ContinuationResult>, String> {
        let rejected = |reason| {
            Ok(send::NativeMutation::Returned(
                ContinuationResult::Rejected { reason },
            ))
        };
        if !self.may_control(parent, &input.session_id).await? {
            return rejected(ContinuationRejection::SourceMissing);
        }
        let Some(source) = self
            .session_run(&input.session_id, input.source_run_id)
            .await?
        else {
            return rejected(ContinuationRejection::SourceMissing);
        };
        if source.revision != input.source_high_water {
            return rejected(ContinuationRejection::SourceChanged);
        }
        if source.terminal.is_none() {
            return rejected(ContinuationRejection::SourceNotTerminal);
        }
        if !matches!(source.spec.origin, durable::RunOrigin::Local) {
            return rejected(ContinuationRejection::SafetyCheckFailed);
        }
        self.admit_continuation(source, input.model, input.thinking_level, operation, parent)
            .await
    }

    pub async fn prepare_stop_run(
        self: &Arc<Self>,
        session: &str,
        run: RunId,
        operation: &maka_plugin_core::operation::RecoveryRef,
    ) -> Result<NativeMutation<Stopped>, String> {
        let Some(view) = self.session_run(session, run).await? else {
            return Ok(NativeMutation::Returned(Stopped { requested: false }));
        };
        if view.stopped {
            return Ok(NativeMutation::Returned(Stopped { requested: true }));
        }
        if view.terminal.is_some() {
            return Ok(NativeMutation::Returned(Stopped { requested: false }));
        }
        let change = self.control_change(
            operation,
            "stop",
            Fact::StopRequested {
                diagnostic: "user_requested_stop".into(),
            },
        );
        self.prepare_stop_with_goal(session, run, change).await
    }

    fn control_change(
        &self,
        operation: &maka_plugin_core::operation::RecoveryRef,
        action: &str,
        fact: Fact,
    ) -> Change {
        Change {
            id: self.control_id(operation, action),
            at: UnixMillis(now().try_into().expect("Unix milliseconds")),
            fact,
        }
    }

    pub(super) fn control_id(
        &self,
        operation: &maka_plugin_core::operation::RecoveryRef,
        action: &str,
    ) -> FactId {
        let mut hash = Sha256::new();
        hash.update(action.as_bytes());
        hash.update(serde_json::to_vec(operation).expect("admitted operation reference"));
        let bytes: [u8; 16] = hash.finalize()[..16].try_into().expect("SHA256 prefix");
        FactId::try_from(Uuid::from_bytes(bytes)).expect("non-nil control identity")
    }
}
