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

use super::{Manager, error};
use crate::Error as WorkhubError;
use futures_util::future::BoxFuture;
use maka_plugins::{
    authorization::{Capability, Request as Authorization, Target},
    contributions::Staged,
    execution::{CommandError, Configure, Submit},
    remote::{Caller, Endpoint, Error, Handler, Method, key},
};
use maka_runtime::attachment::AttachmentRef;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::sync::Arc;

pub(super) fn publish(
    staged: &mut Staged,
    manager: Arc<Manager>,
    package: &str,
    digest: &str,
) -> Result<(), String> {
    super::terminal::publish(staged, manager.clone(), package)?;
    for (name, action) in [
        ("authorize", Action::Authorize),
        ("consent", Action::Consent),
        ("creation-template", Action::Template),
        ("resolve", Action::Resolve),
        ("models", Action::Models),
        ("executors", Action::Executors),
        ("select-coordinator-model", Action::SelectModel),
        ("delegation-model", Action::DelegationModel),
        ("select-delegation-model", Action::SelectDelegationModel),
        ("query", Action::Query),
        ("candidates", Action::Candidates),
        ("configure-creation", Action::Creation),
        ("inspect", Action::Inspect),
        ("feedback", Action::Feedback),
        ("assignments", Action::Assignments),
        ("decide", Action::Decide),
        ("route", Action::Route),
        ("control", Action::Control),
        ("answer", Action::Answer),
        ("answer-receipt", Action::Receipt),
        ("answer-cancel", Action::Cancel),
        ("configure-model", Action::Configure),
        ("enqueue", Action::Enqueue),
    ] {
        staged
            .insert(
                key(package, name).map_err(error)?,
                Endpoint::new(
                    digest.into(),
                    Handler::Method(Arc::new(Call {
                        manager: manager.clone(),
                        action,
                    })),
                ),
            )
            .map_err(error)?;
    }
    Ok(())
}
#[derive(Clone, Copy)]
pub(super) enum Action {
    Authorize,
    Consent,
    Template,
    Resolve,
    Models,
    Executors,
    SelectModel,
    DelegationModel,
    SelectDelegationModel,
    Query,
    Candidates,
    Creation,
    Inspect,
    Feedback,
    Assignments,
    Decide,
    Route,
    Control,
    Answer,
    Receipt,
    Cancel,
    Configure,
    Enqueue,
}
pub(super) struct Call {
    pub(super) manager: Arc<Manager>,
    pub(super) action: Action,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Answer {
    operation_id: String,
    text: String,
    attachments: Option<Vec<AttachmentRef>>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Consent {
    id: maka_plugins::authorization::Id,
}

impl Method for Call {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let manager = self.manager.clone();
        let action = self.action;
        Box::pin(async move {
            let _wake = Wake(&manager);
            if caller.cancellation.is_cancelled() {
                return Err(Error::Cancelled);
            }
            match action {
                Action::Consent => {
                    let target: Target = decode(input)?;
                    encode(manager.access.remembered(&target).await.map_err(failure)?)
                }
                Action::Template => {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct Template {
                        authorization: Target,
                        collaboration_mode: maka_runtime::execution::CollaborationMode,
                        target: maka_plugins::execution::Target,
                    }
                    let request: Template = decode(input)?;
                    let Target::Workspace { sandbox_mode, .. } = &request.authorization else {
                        return Err(Error::Invalid("Expected a workspace".into()));
                    };
                    request
                        .target
                        .validate()
                        .map_err(|error| Error::Invalid(error.to_string()))?;
                    let collaboration_mode = if matches!(
                        request.target,
                        maka_plugins::execution::Target::Executor { .. }
                    ) {
                        maka_runtime::execution::CollaborationMode::Agent
                    } else {
                        request.collaboration_mode
                    };
                    encode(crate::decision::Creation {
                        settings: maka_plugins::execution::RootSettings {
                            target: request.target,
                            sandbox_mode: *sandbox_mode,
                            approval_policy: maka_runtime::execution::ApprovalPolicy::OnRequest,
                            collaboration_mode,
                            behavior: Default::default(),
                            bound_tools: None,
                            instructions: None,
                        },
                        authorization: request.authorization,
                    })
                }
                Action::Authorize => {
                    let request: Consent = decode(input)?;
                    encode(manager.access.remember(request.id).await.map_err(failure)?)
                }
                Action::Resolve => {
                    empty(input)?;
                    let (view, _) = manager.coordinator.resolve().await.map_err(failure)?;
                    encode(view)
                }
                Action::Models => encode(
                    manager
                        .coordinator
                        .models
                        .search(decode(input)?)
                        .await
                        .map_err(|error| Error::Provider(error.to_string()))?,
                ),
                Action::Executors => encode(
                    manager
                        .executor_choices
                        .search(decode(input)?)
                        .await
                        .map_err(|error| Error::Provider(error.to_string()))?,
                ),
                Action::SelectModel => {
                    let target = decode(input)?;
                    let authority = caller
                        .views
                        .authorize(Authorization {
                            operation_id: uuid::Uuid::new_v4(),
                            title: "Choose the WorkHub coordinator model".into(),
                            target: Target::PluginWorkspace {
                                sandbox_mode: maka_runtime::execution::SandboxMode::WorkspaceWrite,
                            },
                            capabilities: [Capability::Executions].into(),
                        })
                        .await?;
                    let result = async {
                        let commands = manager
                            .executions
                            .acquire(authority.scope())
                            .await
                            .map_err(command)?;
                        encode(
                            manager
                                .coordinator
                                .select_model(target, commands)
                                .await
                                .map_err(failure)?,
                        )
                    }
                    .await;
                    authority
                        .finish()
                        .await
                        .map_err(|_| Error::CleanupUnconfirmed)?;
                    result
                }
                Action::Query => {
                    empty(input)?;
                    Ok(
                        json!({"coordinatorSessionId":manager.coordinator.session_id().await.map_err(failure)?, "recovery":manager.report.lock().unwrap().clone()}),
                    )
                }
                Action::DelegationModel => {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct Input {
                        assignment_id: String,
                    }
                    let input: Input = decode(input)?;
                    encode(
                        manager
                            .assignments
                            .model_choice(&input.assignment_id)
                            .await
                            .map_err(failure)?,
                    )
                }
                Action::SelectDelegationModel => {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct Input {
                        assignment_id: String,
                        expected_revision: Option<u64>,
                        target: maka_plugins::execution::Target,
                    }
                    let input: Input = decode(input)?;
                    let choice = manager
                        .assignments
                        .model_choice(&input.assignment_id)
                        .await
                        .map_err(failure)?;
                    let authority = caller
                        .views
                        .authorize(Authorization {
                            operation_id: uuid::Uuid::new_v4(),
                            title: "Choose the delegated task model".into(),
                            target: choice.authorization,
                            capabilities: [Capability::Executions].into(),
                        })
                        .await?;
                    let result = async {
                        let commands = manager
                            .executions
                            .acquire(authority.scope())
                            .await
                            .map_err(command)?;
                        encode(
                            manager
                                .assignments
                                .select_model(
                                    &input.assignment_id,
                                    input.expected_revision,
                                    input.target,
                                    commands.as_ref(),
                                )
                                .await
                                .map_err(failure)?,
                        )
                    }
                    .await;
                    authority
                        .finish()
                        .await
                        .map_err(|_| Error::CleanupUnconfirmed)?;
                    result
                }
                Action::Candidates => {
                    empty(input)?;
                    encode(manager.candidates().await.map_err(failure)?)
                }
                Action::Creation => {
                    let creation: crate::decision::Creation = decode(input)?;
                    let revision = manager
                        .assignments
                        .repository
                        .read::<crate::decision::Creation>("creation")
                        .await
                        .map_err(failure)?
                        .map(|(revision, _)| revision);
                    configure_creation(&manager, &caller, creation, revision).await
                }
                Action::Decide => {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct Decision {
                        operation_id: String,
                        source: maka_runtime::event::Invocation,
                        decision: crate::decision::Decision,
                    }
                    let request: Decision = decode(input)?;
                    if caller.session_id.as_deref() != Some(&request.source.session_id)
                        || manager
                            .coordinator
                            .session_id()
                            .await
                            .map_err(failure)?
                            .as_deref()
                            != Some(&request.source.session_id)
                    {
                        return Err(Error::Invalid(
                            "Decision source is not the coordinator".into(),
                        ));
                    }
                    manager
                        .decide(
                            request.operation_id,
                            request.source,
                            request.decision,
                            caller.cancellation,
                        )
                        .await
                        .map_err(failure)
                }
                Action::Assignments => {
                    #[derive(Deserialize)]
                    #[serde(deny_unknown_fields)]
                    struct Page {
                        after: Option<String>,
                    }
                    let request: Page = decode(input)?;
                    encode(
                        manager
                            .assignments
                            .list(request.after)
                            .await
                            .map_err(failure)?,
                    )
                }
                Action::Feedback => encode(
                    manager
                        .assignments
                        .feedback(decode(input)?)
                        .await
                        .map_err(failure)?,
                ),
                Action::Inspect => {
                    #[derive(Deserialize)]
                    #[serde(rename_all = "camelCase", deny_unknown_fields)]
                    struct Inspect {
                        assignment_id: String,
                        cursor: Option<maka_plugins::execution::AnswerCursor>,
                    }
                    let input: Inspect = decode(input)?;
                    encode(
                        manager
                            .assignments
                            .query(&input.assignment_id, input.cursor)
                            .await
                            .map_err(failure)?,
                    )
                }
                Action::Route => {
                    let request: crate::assignment::Route = decode(input)?;
                    if caller.session_id.as_deref() != Some(&request.source.session_id) {
                        return Err(Error::Invalid(
                            "Route source is not the calling Session".into(),
                        ));
                    }
                    encode(manager.assignments.route(request).await.map_err(failure)?)
                }
                Action::Control => encode(
                    manager
                        .assignments
                        .control(decode(input)?)
                        .await
                        .map_err(failure)?,
                ),
                Action::Answer
                | Action::Receipt
                | Action::Cancel
                | Action::Configure
                | Action::Enqueue => {
                    let session = manager
                        .coordinator
                        .session_id()
                        .await
                        .map_err(failure)?
                        .ok_or_else(|| Error::Invalid("Resolve the coordinator first".into()))?;
                    if caller.session_id.as_deref() != Some(&session) {
                        return Err(Error::Invalid(
                            "WorkHub requires its coordinator Session".into(),
                        ));
                    }
                    // Authenticated user input has its own source, not a synthetic Agent call.
                    let authority = caller
                        .views
                        .authorize(Authorization {
                            operation_id: uuid::Uuid::new_v4(),
                            title: "Use WorkHub".into(),
                            target: Target::Session {
                                session_id: session.clone(),
                            },
                            capabilities: [Capability::Executions].into(),
                        })
                        .await?;
                    let result = async {
                        let commands = manager
                            .executions
                            .acquire(authority.scope())
                            .await
                            .map_err(command)?;
                        match action {
                            Action::Configure => {
                                let request: Configure = decode(input)?;
                                if request.session_id != session {
                                    return Err(Error::Invalid("Different Session".into()));
                                }
                                encode(commands.configure(request).await.map_err(command)?)
                            }
                            Action::Enqueue => encode(
                                crate::queue::submit(
                                    &manager.assignments.repository,
                                    commands.as_ref(),
                                    session,
                                    decode(input)?,
                                )
                                .await
                                .map_err(failure)?,
                            ),
                            _ => {
                                let input: Answer = decode(input)?;
                                let mut content: maka_runtime::input::MessageInput =
                                    input.text.into();
                                content.attachments = input.attachments;
                                let request = Submit {
                                    operation_id: input.operation_id,
                                    session_id: session,
                                    content,
                                    orchestration_mode: None,
                                };
                                let digest = request
                                    .digest()
                                    .map_err(|e| Error::Invalid(e.to_string()))?;
                                if matches!(action, Action::Answer) {
                                    return encode(
                                        commands.submit(request).await.map_err(command)?,
                                    );
                                }
                                let observation =
                                    match commands.query(request.operation_id.clone()).await {
                                        Ok(observation) => observation,
                                        Err(CommandError::NotFound)
                                            if matches!(action, Action::Receipt) =>
                                        {
                                            return Ok(Value::Null);
                                        }
                                        Err(error) => return Err(command(error)),
                                    };
                                if observation.receipt.content_digest != digest {
                                    return Err(command(CommandError::Conflict));
                                }
                                encode(if matches!(action, Action::Cancel) {
                                    commands
                                        .cancel(request.operation_id)
                                        .await
                                        .map_err(command)?
                                } else {
                                    observation
                                })
                            }
                        }
                    }
                    .await;
                    authority
                        .finish()
                        .await
                        .map_err(|_| Error::CleanupUnconfirmed)?;
                    result
                }
            }
        })
    }
}
/// Both clients use the same authority and configuration boundary. The terminal
/// can retain its observed revision across editing and consent.
pub(super) async fn configure_creation(
    manager: &Manager,
    caller: &Caller,
    creation: crate::decision::Creation,
    revision: Option<u64>,
) -> Result<Value, Error> {
    let _wake = Wake(manager);
    let authority = caller
        .views
        .authorize(Authorization {
            operation_id: uuid::Uuid::new_v4(),
            title: "Choose WorkHub task defaults".into(),
            target: creation.authorization.clone(),
            capabilities: [Capability::Executions].into(),
        })
        .await?;
    let result = manager
        .configure_creation(creation, revision)
        .await
        .map_err(failure);
    authority
        .finish()
        .await
        .map_err(|_| Error::CleanupUnconfirmed)?;
    result.map(|()| Value::Null)
}
fn decode<T: DeserializeOwned>(input: Value) -> Result<T, Error> {
    serde_json::from_value(input).map_err(|e| Error::Invalid(e.to_string()))
}
fn encode(input: impl Serialize) -> Result<Value, Error> {
    serde_json::to_value(input).map_err(|e| Error::Provider(e.to_string()))
}
fn empty(input: Value) -> Result<(), Error> {
    if input.is_null() || input.as_object().is_some_and(|input| input.is_empty()) {
        Ok(())
    } else {
        Err(Error::Invalid("Expected empty input".into()))
    }
}
fn command(error: CommandError) -> Error {
    failure(error.into())
}
pub(super) fn failure(error: WorkhubError) -> Error {
    match error {
        WorkhubError::Storage(maka_plugins::storage::StoreError::OutcomeUnknown(reason))
        | WorkhubError::Execution(CommandError::OutcomeUnknown(reason)) => {
            Error::OutcomeUnknown(reason)
        }
        WorkhubError::Execution(CommandError::Revoked)
        | WorkhubError::Storage(maka_plugins::storage::StoreError::Retired) => Error::Retired,
        WorkhubError::Conflict
        | WorkhubError::Invalid(_)
        | WorkhubError::Execution(
            CommandError::Invalid(_) | CommandError::Conflict | CommandError::Denied,
        ) => Error::Invalid(error.to_string()),
        _ => Error::Provider(error.to_string()),
    }
}

struct Wake<'a>(&'a Manager);
impl Drop for Wake<'_> {
    fn drop(&mut self) {
        self.0.wake.notify_one();
    }
}
