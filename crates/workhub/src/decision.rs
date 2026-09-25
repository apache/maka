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
    assignment::{Route, Target},
    invalid,
    repository::digest,
};
use maka_plugins::{
    authorization,
    execution::{CreateRoot, RootSettings},
};
use maka_runtime::{event::Invocation, input::MessageInput};
use serde::{Deserialize, Serialize};

/// User-selected defaults are business configuration, not an authorization grant.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Creation {
    pub authorization: authorization::Target,
    pub settings: RootSettings,
}

#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Destination {
    Existing {
        #[schemars(length(min = 1, max = 256))]
        revision: String,
        #[schemars(length(min = 1, max = 256))]
        candidate: String,
    },
    Create {
        #[schemars(length(min = 1, max = 512))]
        title: String,
    },
}
#[derive(Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Decision {
    Select {
        #[schemars(length(min = 1, max = 256))]
        revision: String,
        #[schemars(length(min = 2, max = 16), inner(length(min = 1, max = 256)), extend("uniqueItems" = true))]
        candidates: Vec<String>,
        #[schemars(length(min = 1, max = 49152))]
        text: String,
    },
    Route {
        target: Destination,
        #[schemars(length(min = 1, max = 49152))]
        text: String,
    },
    Correct {
        #[schemars(length(min = 1, max = 256))]
        assignment_id: String,
        target: Destination,
        #[schemars(length(min = 1, max = 49152))]
        text: String,
    },
    Stop {
        #[schemars(length(min = 1, max = 256))]
        assignment_id: String,
    },
    Resume {
        #[schemars(length(min = 1, max = 256))]
        assignment_id: String,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Resolved {
    Selection(crate::selection::Selection),
    Route(Route),
    Control(crate::control::Request),
}
#[derive(Serialize, Deserialize)]
pub(super) struct Record {
    fingerprint: String,
    resolved: Resolved,
}

impl super::plugin::Manager {
    pub(super) async fn configure_creation(
        &self,
        creation: Creation,
        revision: Option<u64>,
    ) -> Result<(), Error> {
        let authorization::Target::Workspace { sandbox_mode, .. } = &creation.authorization else {
            return Err(invalid("New work requires explicit workspace consent"));
        };
        if *sandbox_mode != creation.settings.sandbox_mode {
            return Err(invalid("New-work permissions differ from consent"));
        }
        creation.settings.validate().map_err(invalid)?;
        self.access.commands(&creation.authorization).await?;
        self.assignments
            .repository
            .put("creation", revision, &creation)
            .await
    }

    pub(super) async fn candidates(&self) -> Result<crate::candidates::Candidates, Error> {
        let coordinator = self
            .coordinator
            .session_id()
            .await?
            .ok_or(Error::Conflict)?;
        let result = crate::candidates::discover(&self.access, &self.queries, &coordinator).await?;
        let repository = &self.assignments.repository;
        let revision = repository
            .read::<crate::candidates::Candidates>("candidates")
            .await?
            .map(|(revision, _)| revision);
        repository.put("candidates", revision, &result).await?;
        Ok(result)
    }

    pub(super) async fn decide(
        &self,
        operation: String,
        source: Invocation,
        input: Decision,
        cancellation: tokio_util::sync::CancellationToken,
    ) -> Result<serde_json::Value, Error> {
        maka_plugins::execution::Resume {
            operation_id: operation.clone(),
            source: source.clone(),
        }
        .validate()
        .map_err(invalid)?;
        if self.coordinator.session_id().await?.as_deref() != Some(&source.session_id) {
            return Err(Error::Conflict);
        }
        let repository = &self.assignments.repository;
        let key = key(&operation)?;
        let fingerprint = digest(&(&source, &input))?;
        let record = match repository.read::<Record>(&key).await? {
            Some((_, record)) => record,
            None => {
                let resolved = match input {
                    Decision::Select {
                        revision,
                        candidates,
                        text,
                    } => Resolved::Selection(
                        self.selection(operation.clone(), source, revision, candidates, text)
                            .await?,
                    ),
                    Decision::Route { target, text } => Resolved::Route(
                        self.resolve_route(operation.clone(), source, target, text)
                            .await?,
                    ),
                    Decision::Correct {
                        assignment_id,
                        target,
                        text,
                    } => Resolved::Control(crate::control::Request {
                        operation_id: operation.clone(),
                        assignment_id,
                        action: crate::control::Action::Correct {
                            replacement: Box::new(
                                self.resolve_route(
                                    format!("replacement:{}", digest(&operation)?),
                                    source,
                                    target,
                                    text,
                                )
                                .await?,
                            ),
                        },
                    }),
                    Decision::Stop { assignment_id } => {
                        Resolved::Control(crate::control::Request {
                            operation_id: operation.clone(),
                            assignment_id,
                            action: crate::control::Action::Stop,
                        })
                    }
                    Decision::Resume { assignment_id } => {
                        Resolved::Control(crate::control::Request {
                            operation_id: operation.clone(),
                            assignment_id,
                            action: crate::control::Action::Resume,
                        })
                    }
                };
                match &resolved {
                    Resolved::Route(route) => crate::assignment::validate(route)?,
                    Resolved::Control(control) => crate::control::validate(control)?,
                    Resolved::Selection(_) => {}
                }
                let record = Record {
                    fingerprint: fingerprint.clone(),
                    resolved,
                };
                match repository
                    .transition(
                        vec![crate::repository::mutation(&key, None, &record)?],
                        crate::repository::Pending::Decision(operation.clone()),
                        true,
                    )
                    .await
                {
                    Ok(()) => record,
                    Err(Error::Contended) => {
                        repository.read(&key).await?.ok_or(Error::Contended)?.1
                    }
                    Err(error) => return Err(error),
                }
            }
        };
        if record.fingerprint != fingerprint {
            return Err(Error::Conflict);
        }
        self.execute_decision(&operation, Some(cancellation)).await
    }

    pub(super) async fn execute_decision(
        &self,
        operation: &str,
        cancellation: Option<tokio_util::sync::CancellationToken>,
    ) -> Result<serde_json::Value, Error> {
        let record = self
            .assignments
            .repository
            .read::<Record>(&key(operation)?)
            .await?
            .ok_or(Error::Conflict)?
            .1;
        // Selection and mutable defaults are never consulted again after this point.
        let result = match record.resolved {
            Resolved::Selection(selection) => self.execute_selection(selection, cancellation).await,
            Resolved::Route(route) => {
                serde_json::to_value(self.assignments.route(route).await?).map_err(invalid)
            }
            Resolved::Control(control) => {
                serde_json::to_value(self.assignments.control(control).await?).map_err(invalid)
            }
        }?;
        self.assignments
            .repository
            .transition(
                vec![],
                crate::repository::Pending::Decision(operation.into()),
                false,
            )
            .await?;
        Ok(result)
    }

    async fn resolve_route(
        &self,
        operation_id: String,
        source: Invocation,
        destination: Destination,
        text: String,
    ) -> Result<Route, Error> {
        let content = self.delegation_content(&source, &text).await?;
        let (target, authorization) = match destination {
            Destination::Existing {
                revision,
                candidate,
            } => {
                let candidates = self
                    .assignments
                    .repository
                    .read::<crate::candidates::Candidates>("candidates")
                    .await?
                    .ok_or(Error::Conflict)?
                    .1;
                if candidates.revision != revision {
                    return Err(Error::Conflict);
                }
                let candidate = candidates
                    .entries
                    .into_iter()
                    .find(|entry| entry.reference == candidate)
                    .ok_or(Error::Conflict)?;
                let session_id = candidate.summary.session.session_id;
                (
                    Target::Existing {
                        session_id: session_id.clone(),
                    },
                    authorization::Target::Session { session_id },
                )
            }
            Destination::Create { title } => {
                let creation = self
                    .assignments
                    .repository
                    .read::<Creation>("creation")
                    .await?
                    .ok_or_else(|| {
                        invalid("Choose and authorize a new-work workspace in WorkHub first")
                    })?
                    .1;
                let request = CreateRoot {
                    managed: false,
                    operation_id: format!("root:{}", digest(&operation_id)?),
                    name: title,
                    settings: creation.settings,
                };
                request.validate().map_err(invalid)?;
                (
                    Target::Create {
                        request: Box::new(request),
                    },
                    creation.authorization,
                )
            }
        };
        Ok(Route {
            operation_id,
            source,
            authorization,
            target,
            content,
        })
    }

    pub(super) async fn delegation_content(
        &self,
        source: &Invocation,
        text: &str,
    ) -> Result<MessageInput, Error> {
        if text.trim().is_empty() || text.len() > 48 * 1024 {
            return Err(invalid("Delegation text must contain 1–49152 bytes"));
        }
        let (coordinator, commands) = self.coordinator.resolve().await?;
        if source.session_id != coordinator.session_id {
            return Err(Error::Conflict);
        }
        let original = commands
            .input(source.clone())
            .await?
            .ok_or(Error::Conflict)?;
        // Original metadata and attachments come from Host facts, never model arguments.
        // Preparation receipts cannot be asserted by a submitting plugin.
        let mut content = MessageInput::from(format!(
            "Original user request:\n{}\n\nDelegation instructions:\n{}",
            original.text, text,
        ));
        content.attachments = original.attachments;
        content.quotes = original.quotes;
        content.directory_references = original.directory_references;
        content.inline_references = original.inline_references;
        maka_plugins::execution::Submit {
            operation_id: "validate".into(),
            session_id: source.session_id.clone(),
            content: content.clone(),
            orchestration_mode: None,
        }
        .validate()
        .map_err(invalid)?;
        Ok(content)
    }
}

pub(super) fn key(operation: &str) -> Result<String, Error> {
    Ok(format!("decisions/{}", digest(&operation)?))
}
