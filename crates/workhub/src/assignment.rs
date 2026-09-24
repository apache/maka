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

use crate::{Access, Error, Repository, invalid, repository::digest};
use maka_plugins::{
    authorization::Target as AuthorizationTarget,
    execution::{Commands, CreateRoot, Enqueue, MessageReceipt, Progress, Receipt, Submit},
};
use maka_runtime::{event::Invocation, input::MessageInput, message::Placement};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Route {
    pub operation_id: String,
    pub source: Invocation,
    pub authorization: AuthorizationTarget,
    pub target: Target,
    pub content: MessageInput,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Target {
    Existing { session_id: String },
    Create { request: Box<CreateRoot> },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Delivery {
    Submitted { receipt: Receipt },
    Queued { receipt: MessageReceipt },
}
impl Delivery {
    pub fn invocation(&self) -> &Invocation {
        match self {
            Self::Submitted { receipt } => &receipt.invocation,
            Self::Queued { receipt } => &receipt.invocation,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Submission {
    Submit(Submit),
    Enqueue(Enqueue),
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Assignment {
    pub request: Route,
    /// Recorded before sending. A retry must never switch between steering and a new Turn.
    pub submission: Option<Submission>,
    pub delivery: Option<Delivery>,
    pub owner: Option<Invocation>,
    /// A persisted control intent serializes correction, stop and resume across activations.
    pub control: Option<String>,
    pub retired: bool,
    pub result: Option<crate::results::Return>,
    pub observe_results: bool,
}
impl Assignment {
    fn new(request: Route) -> Self {
        Self {
            request,
            submission: None,
            delivery: None,
            owner: None,
            control: None,
            retired: false,
            result: None,
            observe_results: true,
        }
    }
}

pub struct Assignments {
    pub coordinator: Arc<crate::Coordinator>,
    pub repository: Arc<Repository>,
    pub access: Arc<Access>,
}
impl Assignments {
    /// Freeze the complete request before root creation or execution admission. The caller
    /// resolves business choices once; this layer only executes that persisted decision.
    pub async fn route(&self, request: Route) -> Result<Delivery, Error> {
        validate(&request)?;
        let (coordinator, source) = self.coordinator.resolve().await?;
        if request.source.session_id != coordinator.session_id
            || source.input(request.source.clone()).await?.is_none()
        {
            return Err(Error::Conflict);
        }
        let key = key(&request.operation_id)?;
        let fingerprint = digest(&request)?;
        let mut record = loop {
            match self.repository.read::<Assignment>(&key).await? {
                Some(record) => break record,
                None => {
                    match self
                        .repository
                        .transition(
                            vec![crate::repository::mutation(
                                &key,
                                None,
                                &Assignment::new(request.clone()),
                            )?],
                            crate::repository::Pending::Route(request.operation_id.clone()),
                            true,
                        )
                        .await
                    {
                        Ok(()) | Err(Error::Contended) => {}
                        Err(error) => return Err(error),
                    }
                    tokio::task::yield_now().await;
                }
            }
        };
        loop {
            let (revision, mut assignment) = record;
            if digest(&assignment.request)? != fingerprint {
                return Err(Error::Conflict);
            }
            // Current consent is checked even when reporting an old receipt.
            let commands = self.commands(&assignment).await?;
            if let Some(delivery) = assignment.delivery {
                return Ok(delivery);
            }
            if assignment.retired || assignment.control.is_some() {
                return Err(Error::Conflict);
            }
            match assignment.submission.clone() {
                None => {
                    let session = match &assignment.request.target {
                        Target::Existing { session_id } => session_id.clone(),
                        Target::Create { request } => {
                            self.restore_or_create_root(commands.as_ref(), request)
                                .await?
                        }
                    };
                    let mut content = assignment.request.content.clone();
                    if let Some(attachments) = &mut content.attachments {
                        for attachment in attachments {
                            *attachment = commands
                                .copy_attachment(
                                    source.clone(),
                                    maka_plugins::execution::CopyAttachment {
                                        target_session_id: session.clone(),
                                        attachment: attachment.clone(),
                                    },
                                )
                                .await?;
                        }
                    }
                    let activity = commands.activity(session.clone()).await?;
                    let operation_id = execution_id(&assignment.request.operation_id)?;
                    assignment.submission = Some(if activity.busy {
                        let owner = activity
                            .execution
                            .filter(|execution| {
                                matches!(
                                    execution.progress,
                                    Progress::Pending
                                        | Progress::Running
                                        | Progress::WaitingForUser
                                )
                            })
                            .ok_or(Error::Execution(
                                maka_plugins::execution::CommandError::Busy,
                            ))?;
                        Submission::Enqueue(Enqueue {
                            operation_id,
                            message_id: uuid::Uuid::new_v4().to_string(),
                            invocation: owner.invocation,
                            content: content.clone(),
                            placement: Placement::CurrentTurn,
                        })
                    } else {
                        Submission::Submit(Submit {
                            operation_id,
                            session_id: session,
                            content,
                            orchestration_mode: None,
                        })
                    });
                }
                Some(submission) => {
                    assignment.delivery = Some(match submission {
                        Submission::Submit(request) => Delivery::Submitted {
                            receipt: commands.submit(request).await?,
                        },
                        Submission::Enqueue(request) => Delivery::Queued {
                            receipt: commands.enqueue(request).await?,
                        },
                    });
                }
            }
            if assignment.owner.is_none() {
                assignment.owner = assignment
                    .delivery
                    .as_ref()
                    .map(|delivery| delivery.invocation().clone());
            }
            // A lost storage reply is not a rejected Host admission. Recovery reads the
            // same record, then replays the same Host operation with identical content.
            match self
                .repository
                .transition(
                    vec![crate::repository::mutation(
                        &key,
                        Some(revision),
                        &assignment,
                    )?],
                    crate::repository::Pending::Route(assignment.request.operation_id.clone()),
                    true,
                )
                .await
            {
                Ok(()) | Err(Error::Contended) => {}
                Err(error) => return Err(error),
            }
            record = self.repository.read(&key).await?.ok_or(Error::Conflict)?;
        }
    }

    pub(super) async fn commands(
        &self,
        assignment: &Assignment,
    ) -> Result<Arc<dyn Commands>, Error> {
        let commands = self
            .access
            .commands(&assignment.request.authorization)
            .await?;
        match &assignment.request.target {
            Target::Create { request } => {
                // Reattach exactly the root this grant created, including after a restart.
                self.restore_or_create_root(commands.as_ref(), request)
                    .await?;
            }
            Target::Existing { session_id } => {
                commands.session(session_id.clone()).await?;
            }
        }
        Ok(commands)
    }
}
pub(super) fn key(operation: &str) -> Result<String, Error> {
    Ok(format!("assignments/{}", digest(&operation)?))
}
pub(super) fn execution_id(operation: &str) -> Result<String, Error> {
    Ok(format!("assignment:{}", digest(&operation)?))
}
pub(super) fn validate(request: &Route) -> Result<(), Error> {
    match (&request.target, &request.authorization) {
        (
            Target::Existing { session_id },
            AuthorizationTarget::Session {
                session_id: granted,
            },
        ) if session_id == granted => {}
        (
            Target::Create { .. },
            AuthorizationTarget::Workspace { .. } | AuthorizationTarget::PluginWorkspace { .. },
        ) => {}
        _ => return Err(invalid("route target and consent scope differ")),
    }
    maka_plugins::execution::Resume {
        operation_id: request.operation_id.clone(),
        source: request.source.clone(),
    }
    .validate()
    .map_err(invalid)?;
    if let Target::Create { request } = &request.target {
        request.validate().map_err(invalid)?;
    }
    let session_id = match &request.target {
        Target::Existing { session_id } => session_id.clone(),
        Target::Create { .. } => "unresolved".into(),
    };
    Submit {
        operation_id: execution_id(&request.operation_id)?,
        session_id,
        content: request.content.clone(),
        orchestration_mode: None,
    }
    .validate()
    .map_err(invalid)
}
