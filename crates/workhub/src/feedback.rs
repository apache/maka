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

use crate::{Error, assignment::Assignments, invalid, observation::Observation};
use maka_plugins::execution::{MessageState, Progress};
use maka_runtime::event::InvocationOutcome;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Feedback {
    id: String,
    state: State,
    #[serde(skip_serializing_if = "Option::is_none")]
    result_preview: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum State {
    Accepted,
    Running,
    WaitingForUser,
    Completed,
    Failed,
    Aborted,
    Recovering,
}

impl Assignments {
    pub(super) async fn feedback(&self, ids: Vec<String>) -> Result<Vec<Feedback>, Error> {
        if ids.len() > 32 || ids.iter().any(|id| id.is_empty() || id.len() > 256) {
            return Err(invalid(
                "Feedback accepts at most 32 bounded assignment IDs",
            ));
        }
        let mut result = Vec::with_capacity(ids.len());
        for id in ids {
            let mut preview = None;
            let state = match self.query(&id, None).await?.map(|view| view.observation) {
                Some(Observation::Unaccepted) => State::Accepted,
                None | Some(Observation::Unavailable { .. }) => State::Recovering,
                Some(Observation::Current { state }) => match state {
                    MessageState::Pending => State::Accepted,
                    MessageState::Cancelled => State::Aborted,
                    MessageState::Delivered {
                        progress, answer, ..
                    } => match *progress {
                        Progress::Pending => State::Accepted,
                        Progress::Running => State::Running,
                        Progress::WaitingForUser => State::WaitingForUser,
                        Progress::Paused => State::Recovering,
                        Progress::Ended { outcome } => match outcome {
                            InvocationOutcome::Completed
                            | InvocationOutcome::ContextCompactFinished { .. } => {
                                preview = answer.and_then(|answer| {
                                    let normalized = answer
                                        .text
                                        .split_whitespace()
                                        .collect::<Vec<_>>()
                                        .join(" ");
                                    if normalized.is_empty() {
                                        return None;
                                    }
                                    let end =
                                        normalized.floor_char_boundary(normalized.len().min(1021));
                                    Some(if end < normalized.len() || !answer.complete {
                                        format!("{}…", &normalized[..end])
                                    } else {
                                        normalized
                                    })
                                });
                                State::Completed
                            }
                            InvocationOutcome::Cancelled { .. } => State::Aborted,
                            InvocationOutcome::Failed { .. } => State::Failed,
                            InvocationOutcome::HandoffPaused { .. } => State::Recovering,
                        },
                    },
                },
            };
            result.push(Feedback {
                id,
                state,
                result_preview: preview,
            });
        }
        Ok(result)
    }
}
