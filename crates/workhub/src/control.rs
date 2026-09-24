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

use crate::{
    Error,
    assignment::{Assignment, Assignments, Delivery, Route, execution_id},
    invalid,
    repository::{digest, mutation},
};
use maka_plugins::execution::{CommandError, MessageState, Progress, Resume, SessionMessage};
use maka_runtime::event::Invocation;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub operation_id: String,
    pub assignment_id: String,
    pub action: Action,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    Stop,
    Resume,
    Correct { replacement: Box<Route> },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Outcome {
    Stopped {
        disposition: Disposition,
    },
    Resumed {
        invocation: Invocation,
    },
    Corrected {
        replacement_id: String,
        previous: Disposition,
        replacement: Delivery,
    },
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    Cancelled,
    StopRequested,
    AlreadyFinished,
    Shared,
}

/// Selection is captured once. Recovery never decides to control a newer Run.
#[derive(Clone, Serialize, Deserialize)]
enum Selection {
    Pending,
    Owned {
        invocation: Invocation,
        state: State,
    },
    Shared,
    Cancelled,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
enum State {
    Active,
    Paused,
    Ended,
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Record {
    pub request: Request,
    selection: Selection,
    stopped: Option<Disposition>,
    pub outcome: Option<Outcome>,
}

impl Assignments {
    pub async fn control(&self, request: Request) -> Result<Outcome, Error> {
        validate(&request)?;
        let assignment_key = crate::assignment::key(&request.assignment_id)?;
        let control_key = key(&request.operation_id)?;
        let fingerprint = digest(&request)?;
        let mut record = self.repository.read::<Record>(&control_key).await?;
        while record.is_none() {
            let (revision, mut assignment) = self
                .repository
                .read::<Assignment>(&assignment_key)
                .await?
                .ok_or(Error::Conflict)?;
            if assignment.retired || assignment.control.is_some() {
                return Err(Error::Conflict);
            }
            let delivery = assignment.delivery.as_ref().ok_or(Error::Conflict)?;
            let commands = self.commands(&assignment).await?;
            let selection = select(commands.as_ref(), delivery, assignment.owner.as_ref()).await?;
            if matches!(request.action, Action::Resume)
                && !matches!(
                    selection,
                    Selection::Owned {
                        state: State::Ended | State::Paused,
                        ..
                    }
                )
            {
                return Err(Error::Conflict);
            }
            assignment.control = Some(request.operation_id.clone());
            let control = Record {
                request: request.clone(),
                selection,
                stopped: None,
                outcome: None,
            };
            match self
                .repository
                .transition(
                    vec![
                        mutation(&assignment_key, Some(revision), &assignment)?,
                        mutation(&control_key, None, &control)?,
                    ],
                    crate::repository::Pending::Control(control.request.operation_id.clone()),
                    true,
                )
                .await
            {
                Ok(()) | Err(Error::Contended) => {}
                Err(error) => return Err(error),
            }
            record = self.repository.read(&control_key).await?;
            tokio::task::yield_now().await;
        }
        let (mut revision, mut record) = record.ok_or(Error::Contended)?;
        if digest(&record.request)? != fingerprint {
            return Err(Error::Conflict);
        }
        loop {
            let (assignment_revision, mut assignment) = self
                .repository
                .read::<Assignment>(&assignment_key)
                .await?
                .ok_or(Error::Conflict)?;
            let commands = self.commands(&assignment).await?;
            if let Some(outcome) = record.outcome {
                return Ok(outcome);
            }
            if assignment.control.as_ref() != Some(&record.request.operation_id) {
                return Err(Error::Conflict);
            }
            if let Action::Resume = record.request.action {
                let Selection::Owned { invocation, .. } = &record.selection else {
                    return Err(Error::Conflict);
                };
                let resumed = commands
                    .resume(Resume {
                        operation_id: format!("control:{}", digest(&record.request.operation_id)?),
                        source: invocation.clone(),
                    })
                    .await?;
                assignment.owner = Some(resumed.clone());
                record.outcome = Some(Outcome::Resumed {
                    invocation: resumed,
                });
            } else {
                if record.stopped.is_none() {
                    match &record.selection {
                        Selection::Pending => {
                            // Retraction and delivery race inside Host, not in plugin state.
                            // If delivery won, freeze its exact result before attempting stop.
                            let delivery = assignment.delivery.as_ref().ok_or(Error::Conflict)?;
                            record.selection = match delivery {
                                Delivery::Submitted { .. } => {
                                    let observation = commands
                                        .cancel(execution_id(&assignment.request.operation_id)?)
                                        .await?;
                                    record.stopped = Some(
                                        if matches!(observation.progress, Progress::Pending) {
                                            Disposition::Cancelled
                                        } else {
                                            Disposition::StopRequested
                                        },
                                    );
                                    Selection::Cancelled
                                }
                                Delivery::Queued { receipt } => {
                                    let observation = commands
                                        .retract(execution_id(&assignment.request.operation_id)?)
                                        .await?;
                                    selection(observation.state, &receipt.invocation)
                                }
                            };
                        }
                        Selection::Cancelled => record.stopped = Some(Disposition::Cancelled),
                        Selection::Shared => record.stopped = Some(Disposition::Shared),
                        Selection::Owned { invocation, state } => {
                            record.stopped = Some(if matches!(state, State::Ended) {
                                Disposition::AlreadyFinished
                            } else {
                                commands.stop(invocation.clone()).await?;
                                Disposition::StopRequested
                            });
                        }
                    }
                    // Persist retirement before replacement admission. Neither a lost reply
                    // nor another activation can reinterpret which execution was retired.
                    match self
                        .repository
                        .put(&control_key, Some(revision), &record)
                        .await
                    {
                        Ok(()) | Err(Error::Contended) => {}
                        Err(error) => return Err(error),
                    }
                    (revision, record) = self
                        .repository
                        .read(&control_key)
                        .await?
                        .ok_or(Error::Conflict)?;
                    continue;
                }
                let disposition = record.stopped.ok_or(Error::Conflict)?;
                record.outcome = Some(match &record.request.action {
                    Action::Stop => Outcome::Stopped { disposition },
                    Action::Correct { replacement } => Outcome::Corrected {
                        replacement_id: replacement.operation_id.clone(),
                        previous: disposition,
                        replacement: self.route(*replacement.clone()).await?,
                    },
                    Action::Resume => unreachable!(),
                });
                assignment.retired = matches!(record.request.action, Action::Correct { .. });
            }
            assignment.control = None;
            assignment.observe_results = matches!(
                record.outcome,
                Some(
                    Outcome::Resumed { .. }
                        | Outcome::Stopped {
                            disposition: Disposition::Shared
                        }
                )
            );
            if matches!(record.request.action, Action::Resume) {
                // Resume may happen long after the previous result left the
                // index. Stage observation before closing the control intent.
                loop {
                    match self
                        .repository
                        .transition(
                            Vec::new(),
                            crate::repository::Pending::Route(
                                assignment.request.operation_id.clone(),
                            ),
                            true,
                        )
                        .await
                    {
                        Ok(()) => break,
                        Err(Error::Contended) => tokio::task::yield_now().await,
                        Err(error) => return Err(error),
                    }
                }
            }
            match self
                .repository
                .transition(
                    vec![
                        mutation(&assignment_key, Some(assignment_revision), &assignment)?,
                        mutation(&control_key, Some(revision), &record)?,
                    ],
                    crate::repository::Pending::Control(record.request.operation_id.clone()),
                    false,
                )
                .await
            {
                Ok(()) | Err(Error::Contended) => {}
                Err(error) => return Err(error),
            }
            (revision, record) = self
                .repository
                .read(&control_key)
                .await?
                .ok_or(Error::Conflict)?;
        }
    }
}

async fn select(
    commands: &dyn maka_plugins::execution::Commands,
    delivery: &Delivery,
    owner: Option<&Invocation>,
) -> Result<Selection, Error> {
    let (invocation, message) = match delivery {
        Delivery::Submitted { receipt } => (&receipt.invocation, &receipt.message_id),
        Delivery::Queued { receipt } => (&receipt.invocation, &receipt.message_id),
    };
    let state = commands
        .read_message(SessionMessage {
            session_id: invocation.session_id.clone(),
            message_id: message.clone(),
            cursor: None,
        })
        .await?
        .ok_or(Error::Execution(CommandError::NotFound))?;
    Ok(selection(state, owner.unwrap_or(invocation)))
}
fn selection(state: MessageState, expected: &Invocation) -> Selection {
    match state {
        MessageState::Pending => Selection::Pending,
        MessageState::Cancelled => Selection::Cancelled,
        MessageState::Delivered {
            invocation,
            exclusive,
            progress,
            ..
        } => {
            if !exclusive || invocation.turn_id != expected.turn_id {
                Selection::Shared
            } else {
                Selection::Owned {
                    invocation,
                    state: match *progress {
                        Progress::Ended { .. } => State::Ended,
                        Progress::Paused => State::Paused,
                        _ => State::Active,
                    },
                }
            }
        }
    }
}
pub(super) fn key(operation: &str) -> Result<String, Error> {
    Ok(format!("controls/{}", digest(&operation)?))
}
pub(super) fn validate(request: &Request) -> Result<(), Error> {
    for id in [&request.operation_id, &request.assignment_id] {
        if id.is_empty()
            || id.len() > 256
            || id.chars().any(|c| c.is_control() || c.is_whitespace())
        {
            return Err(invalid("invalid control identity"));
        }
    }
    if let Action::Correct { replacement } = &request.action {
        if replacement.operation_id == request.assignment_id {
            return Err(Error::Conflict);
        }
        crate::assignment::validate(replacement)?;
    }
    Ok(())
}
