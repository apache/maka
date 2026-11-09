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

use maka_agent_facts::durable::*;
use maka_event_log::StoreError;
use maka_plugin_core::operation::OperationCleanup;
use serde::{Deserialize, Serialize};

use super::{RunView, require};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalTask {
    pub task: ExternalTaskId,
    pub descriptor: ContentRef,
    pub admitted: bool,
    pub binding: Option<ContentRef>,
    pub observed: u64,
    pub closed: Option<ExternalClosure>,
    pub cleanup: OperationCleanup,
    pub cleanup_not_before: Option<UnixMillis>,
    #[serde(default)]
    pub steering: Option<crate::external_steering::ExternalSteering>,
    #[serde(default)]
    pub effects: std::collections::BTreeMap<uuid::Uuid, crate::external_effects::ExternalEffect>,
    #[serde(default)]
    pub publication: Option<crate::external_publication::ExternalPublication>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalClosure {
    pub outcome: Terminal,
    pub diagnostic: Option<String>,
    pub final_message: Option<ExternalFinalMessage>,
}

impl RunView {
    /// Common run, revision and control-frontier checks belong to the parent fold.
    pub(super) fn apply_external(&mut self, recorded: &RecordedFact) -> Result<(), StoreError> {
        match &recorded.fact {
            Fact::ExternalTaskPrepared { task, descriptor } => {
                require(
                    matches!(self.spec.backend, BackendSpec::Executor { .. }),
                    "only an executor run can prepare an external task",
                )?;
                descriptor
                    .validate()
                    .map_err(|error| StoreError::InvalidTransition(error.into()))?;
                if let Some(existing) = &self.external {
                    if existing.task != *task || existing.descriptor != *descriptor {
                        return Err(StoreError::EventConflict);
                    }
                } else {
                    self.external = Some(ExternalTask {
                        task: *task,
                        descriptor: descriptor.clone(),
                        admitted: false,
                        binding: None,
                        observed: 0,
                        closed: None,
                        cleanup: OperationCleanup::Unconfirmed,
                        cleanup_not_before: None,
                        effects: Default::default(),
                        steering: None,
                        publication: None,
                    });
                }
            }
            Fact::ExternalTaskAdmitted { task } => {
                let current = self.external_task(task)?;
                require(
                    !current.admitted && current.closed.is_none(),
                    "external task is not awaiting admission",
                )?;
                require(
                    self.blockers
                        .values()
                        .all(|blocker| blocker.decision.is_some() || blocker.resolved_by.is_some()),
                    "run has an active blocker",
                )?;
                self.external
                    .as_mut()
                    .expect("validated external task")
                    .admitted = true;
            }
            Fact::ExternalTaskBound { task, descriptor } => {
                let current = self.external_task(task)?;
                require(
                    current.admitted,
                    "external binding has no original admission",
                )?;
                descriptor
                    .validate()
                    .map_err(|error| StoreError::InvalidTransition(error.into()))?;
                if let Some(existing) = &current.binding {
                    if existing != descriptor {
                        return Err(StoreError::EventConflict);
                    }
                }
                self.external
                    .as_mut()
                    .expect("validated external task")
                    .binding = Some(descriptor.clone());
            }
            Fact::ExternalTaskObserved {
                task,
                index,
                output,
            } => {
                let current = self.external_task(task)?;
                require(
                    current.admitted,
                    "external output has no original admission",
                )?;
                require(
                    current.closed.is_none(),
                    "external output follows canonical closure",
                )?;
                if *index < current.observed {
                    return Err(StoreError::EventConflict);
                }
                require(
                    *index == current.observed,
                    "noncontiguous external output index",
                )?;
                output
                    .validate()
                    .map_err(|error| StoreError::InvalidTransition(error.into()))?;
                let observed = current.observed.checked_add(1).ok_or_else(|| {
                    StoreError::InvalidTransition("external output index overflow".into())
                })?;
                // Tool activity in executor output is evidence, never Host dispatch intent.
                self.external
                    .as_mut()
                    .expect("validated external task")
                    .observed = observed;
            }
            Fact::ExternalTaskCleanupDeferred {
                task, not_before, ..
            } => {
                let current = self.external_task(task)?;
                require(current.admitted, "cleanup defer has no original admission")?;
                require(
                    current.cleanup != OperationCleanup::Confirmed,
                    "confirmed cleanup cannot be deferred",
                )?;
                require(
                    *not_before > recorded.at,
                    "cleanup defer is not in the future",
                )?;
                require(
                    current
                        .cleanup_not_before
                        .is_none_or(|due| due <= recorded.at),
                    "cleanup observation is not due",
                )?;
                self.external
                    .as_mut()
                    .expect("original task")
                    .cleanup_not_before = Some(*not_before);
            }
            Fact::ExternalTaskCleanupObserved { task, cleanup } => {
                let current = self.external_task(task)?;
                require(
                    current.admitted,
                    "external cleanup has no original admission",
                )?;
                let cleanup = match (&current.cleanup, cleanup) {
                    (OperationCleanup::Confirmed, _) | (_, OperationCleanup::Confirmed) => {
                        OperationCleanup::Confirmed
                    }
                    (OperationCleanup::Failed { .. }, _) => current.cleanup.clone(),
                    (_, OperationCleanup::Failed { .. }) => cleanup.clone(),
                    _ => OperationCleanup::Unconfirmed,
                };
                let current = self.external.as_mut().expect("validated external task");
                if cleanup == OperationCleanup::Confirmed {
                    current.cleanup_not_before = None;
                }
                current.cleanup = cleanup;
                self.resolve_external_observation(recorded.id);
            }
            Fact::ExternalTaskClosed {
                task,
                outcome,
                diagnostic,
                final_message,
            } => {
                let current = self.external_task(task)?;
                require(
                    current.admitted,
                    "external closure has no original admission",
                )?;
                if let Some(final_message) = final_message {
                    require(
                        *outcome == Terminal::Completed,
                        "only an original completed task may identify a final message",
                    )?;
                    require(
                        !final_message.message_id.is_empty()
                            && !final_message.message_id.chars().any(char::is_control),
                        "invalid original final native message identity",
                    )?;
                }
                let closure = ExternalClosure {
                    outcome: outcome.clone(),
                    diagnostic: diagnostic.clone(),
                    final_message: final_message.clone(),
                };
                if let Some(existing) = &current.closed {
                    if existing != &closure {
                        return Err(StoreError::EventConflict);
                    }
                } else {
                    self.external
                        .as_mut()
                        .expect("validated external task")
                        .closed = Some(closure);
                }
                self.resolve_external_observation(recorded.id);
            }
            _ => {
                return Err(StoreError::InvalidTransition(
                    "not an external task fact".into(),
                ));
            }
        }
        Ok(())
    }

    pub(super) fn resolve_external_observation(&mut self, fact: FactId) {
        if self.external.as_ref().is_some_and(|task| {
            task.closed.is_some() || (self.stopped && task.cleanup == OperationCleanup::Confirmed)
        }) {
            for blocker in self.blockers.values_mut() {
                if blocker.decision.is_none()
                    && blocker.resolved_by.is_none()
                    && matches!(
                        &blocker.reason,
                        BlockerKind::ExternalTaskUnobservable { .. }
                    )
                {
                    blocker.resolved_by = Some(fact);
                }
            }
        }
    }
    fn external_task(&self, task: &ExternalTaskId) -> Result<&ExternalTask, StoreError> {
        let current = self.external.as_ref().ok_or_else(|| {
            StoreError::InvalidTransition("external task has not been prepared".into())
        })?;
        require(
            current.task == *task,
            "fact belongs to another external task",
        )?;
        Ok(current)
    }

    pub(super) fn external_terminal_allowed(&self, terminal: &Terminal) -> bool {
        if self.cancelled_by_risk {
            return *terminal == Terminal::Cancelled
                && self.blockers.values().any(|blocker| {
                    blocker.decision.as_ref().is_some_and(|scoped| {
                        matches!(scoped.scope, RiskActionScope::RunCancellation)
                            && matches!(scoped.decision, RiskDecision::CancelBlockedRun { .. })
                    })
                });
        }
        let Some(task) = &self.external else {
            return true;
        };
        if !task.admitted {
            return *terminal == Terminal::Cancelled;
        }
        if task.closed.is_some() {
            return true;
        }
        *terminal == Terminal::Cancelled
            && self.stopped
            && task.cleanup == OperationCleanup::Confirmed
            && task.effects.values().all(|effect| !effect.pending())
    }
}
