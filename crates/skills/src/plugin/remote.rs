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
mod changes;
mod request;
use self::request::Request;
use super::{ID, Skills};
use crate::api::{ImportSourceInput, InvocableTarget, WorkspaceContext};
use futures_util::future::BoxFuture;
use maka_plugins::{
    client::Bundle,
    contributions::Staged,
    remote::{Caller, Endpoint, Error, Handler, Method, WorkspaceViewInput, key},
};
use maka_runtime::execution::{CollaborationMode, SandboxMode, WorkspaceTarget};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

/// Plugin-local wiring assembled from public Host capabilities.
#[derive(Clone)]
pub(super) struct ClientSupport {
    pub bundle: Arc<Bundle>,
}
pub const CLIENT_SERVICE: &str = "maka.skills.client";

#[derive(Clone, Copy)]
enum Source {
    User,
    Session,
    Project,
    Path,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectRequest {
    project_id: String,
    sandbox_mode: SandboxMode,
    collaboration_mode: CollaborationMode,
    request: Request,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PathRequest {
    path: String,
    sandbox_mode: SandboxMode,
    collaboration_mode: CollaborationMode,
    request: Request,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UserRequest {
    workspace: Option<WorkspaceViewInput>,
    request: Request,
}

pub(super) fn publish(
    skills: &Skills,
    staged: &mut Staged,
    support: ClientSupport,
) -> Result<(), String> {
    staged
        .insert(
            key(ID, "changes").map_err(message)?,
            Endpoint::new(
                support.bundle.content_digest.clone(),
                Handler::Stream(Arc::new(changes::Provider(skills.changed.clone()))),
            ),
        )
        .map_err(message)?;
    for (name, source) in [
        ("user-request", Source::User),
        ("request", Source::Session),
        ("project-request", Source::Project),
        ("path-request", Source::Path),
    ] {
        let endpoint = Endpoint::new(
            support.bundle.content_digest.clone(),
            Handler::Method(Arc::new(Service {
                skills: skills.clone(),
                source,
            })),
        );
        let endpoint = if matches!(source, Source::Path | Source::User) {
            endpoint.requiring_host_paths()
        } else {
            endpoint
        };
        staged
            .insert(key(ID, name).map_err(message)?, endpoint)
            .map_err(message)?;
    }
    staged
        .insert(
            key(ID, "user-authorization").map_err(message)?,
            Endpoint::new(
                support.bundle.content_digest.clone(),
                Handler::Method(Arc::new(UserAuthorization(skills.clone()))),
            )
            .requiring_host_paths(),
        )
        .map_err(message)?;
    staged
        .insert(
            key(ID, "locations").map_err(message)?,
            Endpoint::new(
                support.bundle.content_digest.clone(),
                Handler::Method(Arc::new(Locations(skills.clone()))),
            )
            .requiring_host_paths(),
        )
        .map_err(message)?;
    staged
        .insert(
            key(ID, "import-source").map_err(message)?,
            Endpoint::new(
                support.bundle.content_digest.clone(),
                Handler::Method(Arc::new(Import(skills.clone()))),
            )
            .requiring_host_paths(),
        )
        .map_err(message)
}
struct Service {
    skills: Skills,
    source: Source,
}
impl Method for Service {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let skills = self.skills.clone();
        let source = self.source;
        Box::pin(async move {
            let (request, view, target) = match source {
                Source::User => {
                    let UserRequest { workspace, request } = decode(input)?;
                    if !request.requires_user_files() {
                        return Err(Error::Invalid(
                            "User request requires a user-library mutation".into(),
                        ));
                    }
                    match workspace {
                        Some(input) => {
                            let sandbox_mode = input.sandbox_mode;
                            let collaboration_mode = input.collaboration_mode;
                            let view = caller.views.workspace(input).await?;
                            let target = InvocableTarget::NewSession {
                                context: WorkspaceContext {
                                    workspace: view.workspace.target.clone(),
                                },
                                sandbox_mode,
                                collaboration_mode,
                            };
                            (request, view, target)
                        }
                        None => {
                            let session_id = caller.session_id.clone().ok_or_else(|| {
                                Error::Invalid("Skills requires a Session".into())
                            })?;
                            (
                                request,
                                caller.views.session().await?,
                                InvocableTarget::Session { session_id },
                            )
                        }
                    }
                }
                Source::Session => {
                    let request = decode(input)?;
                    let session_id = caller
                        .session_id
                        .clone()
                        .ok_or_else(|| Error::Invalid("Skills requires a Session".into()))?;
                    let view = caller.views.session().await?;
                    (request, view, InvocableTarget::Session { session_id })
                }
                Source::Project | Source::Path => {
                    let (request, input) = match source {
                        Source::Project => {
                            let ProjectRequest {
                                project_id,
                                sandbox_mode,
                                collaboration_mode,
                                request,
                            } = decode(input)?;
                            (
                                request,
                                WorkspaceViewInput {
                                    workspace: WorkspaceTarget::Project { project_id },
                                    sandbox_mode,
                                    collaboration_mode,
                                },
                            )
                        }
                        Source::Path => {
                            let PathRequest {
                                path,
                                sandbox_mode,
                                collaboration_mode,
                                request,
                            } = decode(input)?;
                            (
                                request,
                                WorkspaceViewInput {
                                    workspace: WorkspaceTarget::HostPath { path },
                                    sandbox_mode,
                                    collaboration_mode,
                                },
                            )
                        }
                        Source::Session | Source::User => unreachable!(),
                    };
                    let sandbox_mode = input.sandbox_mode;
                    let collaboration_mode = input.collaboration_mode;
                    let view = caller.views.workspace(input).await?;
                    let target = InvocableTarget::NewSession {
                        context: WorkspaceContext {
                            workspace: view.workspace.target.clone(),
                        },
                        sandbox_mode,
                        collaboration_mode,
                    };
                    (request, view, target)
                }
            };
            if request.requires_user_files() && !matches!(source, Source::User) {
                return Err(Error::Invalid(
                    "User-library mutations require the user-request endpoint".into(),
                ));
            }
            if caller.cancellation.is_cancelled() {
                return Err(Error::Cancelled);
            }
            if request.requires_user_files() {
                authorize_user(
                    &skills,
                    &caller,
                    uuid::Uuid::new_v4(),
                    "Manage user Skills".into(),
                )
                .await?;
            }
            request.execute(&skills, view, target).await
        })
    }
}
struct Import(Skills);
struct Locations(Skills);
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LocationsInput {
    workspace: Option<WorkspaceViewInput>,
    action: crate::api::LocationAction,
}
impl Method for Locations {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let skills = self.0.clone();
        Box::pin(async move {
            let input: LocationsInput = decode(input)?;
            let project = match input.workspace {
                Some(workspace) => caller.views.workspace(workspace).await,
                None => caller.views.session().await,
            };
            // A missing Project must not hide independent private/user locations.
            let files = match project {
                Ok(view) => Some((view.files, view.workspace.target)),
                Err(Error::Cancelled | Error::Retired) => return Err(Error::Cancelled),
                Err(_) => None,
            };
            if caller.cancellation.is_cancelled() {
                return Err(Error::Cancelled);
            }
            encode(skills.locations(input.action, files, &caller).await?)
        })
    }
}
struct UserAuthorization(Skills);
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum UserAuthorizationRequest {
    Status,
    Recover {
        grant: maka_plugins::authorization::Id,
    },
}
impl Method for UserAuthorization {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let skills = self.0.clone();
        Box::pin(async move {
            if caller.cancellation.is_cancelled() {
                return Err(Error::Cancelled);
            }
            match decode::<UserAuthorizationRequest>(input)? {
                UserAuthorizationRequest::Status => {}
                UserAuthorizationRequest::Recover { grant } => {
                    authorize_user(
                        &skills,
                        &caller,
                        uuid::Uuid::new_v4(),
                        "Resume user Skill publication".into(),
                    )
                    .await?;
                    skills.resume_user(grant).await.map_err(failure)?
                }
            }
            encode(skills.user_status().await.map_err(failure)?)
        })
    }
}
impl Method for Import {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let skills = self.0.clone();
        Box::pin(async move {
            if caller.cancellation.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let input: ImportSourceInput = decode(input)?;
            authorize_user(
                &skills,
                &caller,
                uuid::Uuid::new_v4(),
                "Import local Skill source".into(),
            )
            .await?;
            let source = import_view(&caller, &input.source_path).await?;
            encode(skills.import_source(input, source).await.map_err(failure)?)
        })
    }
}
/// A stored grant never substitutes for the current foreground caller.
pub(super) async fn authorize_user(
    skills: &Skills,
    caller: &Caller,
    operation_id: uuid::Uuid,
    title: String,
) -> Result<maka_plugins::authorization::Request, Error> {
    use maka_plugins::authorization::{Capability, Request};
    let request = Request {
        operation_id,
        title,
        target: skills.user_target().map_err(failure)?,
        capabilities: [Capability::ReadFiles, Capability::WriteFiles].into(),
    };
    request
        .validate()
        .map_err(message)
        .map_err(Error::Invalid)?;
    let authority = caller.views.authorize(request.clone()).await?;
    authority
        .finish()
        .await
        .map_err(|_| Error::CleanupUnconfirmed)?;
    Ok(request)
}
pub(super) async fn import_view(
    caller: &Caller,
    path: &str,
) -> Result<maka_plugins::filesystem::ReadDirectory, Error> {
    let path = std::path::Path::new(path);
    let parent = path
        .parent()
        .filter(|_| path.is_absolute())
        .and_then(|parent| parent.to_str())
        .ok_or_else(|| Error::Invalid("Import requires an absolute file path".into()))?;
    Ok(caller
        .views
        .workspace(WorkspaceViewInput {
            workspace: WorkspaceTarget::HostPath {
                path: parent.into(),
            },
            sandbox_mode: SandboxMode::ReadOnly,
            collaboration_mode: CollaborationMode::Agent,
        })
        .await?
        .files)
}
fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, Error> {
    serde_json::from_value(value).map_err(|error| Error::Invalid(error.to_string()))
}
fn encode(value: impl serde::Serialize) -> Result<Value, Error> {
    serde_json::to_value(value).map_err(|error| Error::Provider(error.to_string()))
}
fn message(error: impl ToString) -> String {
    error.to_string()
}
pub(super) fn failure(error: super::Error) -> Error {
    match error {
        super::Error::Invalid(message) => Error::Invalid(message),
        super::Error::Retired => Error::Retired,
        super::Error::OutcomeUnknown(message) => Error::OutcomeUnknown(message),
        other => Error::Provider(other.to_string()),
    }
}
