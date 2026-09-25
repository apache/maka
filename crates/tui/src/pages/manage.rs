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

pub mod choose_project;
pub mod connection;
mod connection_test;
pub mod credentials;
pub mod directory;
pub mod enabled_models;
pub mod locations;
mod model_fetch;
mod model_inventory;
pub mod models;
pub mod oauth;
mod project;
mod references;
pub mod removal;
pub mod sandbox;
pub(crate) mod view;
pub(crate) use view::{draw_field, sheet};

use crate::{
    app::{Action, App, ConnectionState},
    editor::Editor,
    navigation::Route,
};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use maka_client::{Client, RequestFailure};
use maka_protocol::session::*;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    root: String,
    epoch: String,
    name: String,
    entity: Entity,
}
impl Target {
    pub(crate) fn is_default_model(&self) -> bool {
        matches!(self.entity, Entity::Defaults)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum Entity {
    Oauth,
    Defaults,
    SandboxDefaults,
    Session {
        id: String,
        revision: u64,
        workspace: String,
        project_bound: bool,
    },
    Project {
        id: String,
    },
    Registration,
    Input(super::references::Target),
    Connection(std::sync::Arc<super::connections::Row>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Reference,
    Oauth,
    Register,
    Relink,
    Rename,
    Workspace,
    Project,
    Locations,
    Model,
    Sandbox,
    Archive,
    Restore,
    Remove,
    Connection(connection::Change),
    Credential(credentials::Change),
}
impl Kind {
    pub fn label(self, target: &Target) -> &'static str {
        match (self, &target.entity) {
            (Self::Reference, _) => "references-title",
            (Self::Oauth, _) => "oauth-title",
            (Self::Credential(change), _) => change.label(),
            (Self::Connection(change), _) => change.label(),
            (Self::Rename, Entity::Connection(_)) => "connection-rename",
            (Self::Register, _) => "project-register",
            (Self::Relink, _) => "project-relink",
            (Self::Locations, _) => "project-locations",
            (Self::Model, Entity::Defaults) => "default-model-title",
            (Self::Model, _) => "session-model-change",
            (Self::Sandbox, Entity::SandboxDefaults) => "sandbox-default-title",
            (Self::Sandbox, _) => "session-sandbox-change",
            (Self::Rename, Entity::Project { .. }) => "project-rename",
            (Self::Archive, Entity::Project { .. }) => "project-archive",
            (Self::Restore, Entity::Project { .. }) => "project-restore",
            _ => match self {
                Self::Reference
                | Self::Oauth
                | Self::Register
                | Self::Relink
                | Self::Locations
                | Self::Model
                | Self::Sandbox
                | Self::Connection(_)
                | Self::Credential(_) => unreachable!(),
                Self::Rename => "session-rename",
                Self::Workspace => "session-workspace-change",
                Self::Project => "session-project-change",
                Self::Archive => "session-archive",
                Self::Restore => "session-restore",
                Self::Remove => "session-remove",
            },
        }
    }
    fn edits_text(self) -> bool {
        matches!(
            self,
            Self::Register
                | Self::Relink
                | Self::Rename
                | Self::Workspace
                | Self::Connection(connection::Change::Configuration)
        )
    }
    fn requires_review(self) -> bool {
        matches!(
            self,
            Self::Relink | Self::Connection(connection::Change::Configuration)
        )
    }
    fn edits_configuration(self) -> bool {
        self == Self::Connection(connection::Change::Configuration)
    }
    fn edits_path(self) -> bool {
        matches!(self, Self::Register | Self::Relink | Self::Workspace)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Command {
    Oauth(oauth::Command),
    CredentialRetry,
    RemovalQuery,
    Open(Target, Kind),
    Browse,
    Directory(directory::Command),
    ChooseProject(choose_project::Command),
    Locations(locations::Command),
    Models(models::Command),
    Sandbox(sandbox::Command),
    EnabledModels(enabled_models::Command),
    Save,
    Edit,
    Close,
}
impl Command {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Oauth(command) => command.label(),
            Self::Open(target, kind) => kind.label(target),
            Self::Browse => "directory-browse",
            Self::CredentialRetry => "credential-retry",
            Self::RemovalQuery => "session-remove-query",
            Self::Directory(command) => command.label(),
            Self::ChooseProject(command) => command.label(),
            Self::Locations(command) => command.label(),
            Self::Models(command) => command.label(),
            Self::Sandbox(mode) => mode.label(),
            Self::EnabledModels(command) => command.label(),
            Self::Save => "session-save",
            Self::Edit => "project-relink-edit",
            Self::Close => "session-cancel",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Ticket {
    target: Target,
    kind: Kind,
    text: String,
    directory: Option<directory::Location>,
    project_id: Option<String>,
    model: Option<models::Choice>,
    thinking_level: Option<ThinkingLevel>,
    sandbox_mode: Option<SandboxMode>,
    approval_policy: Option<ApprovalPolicy>,
    policy_revision: Option<u64>,
    enabled_model_ids: Option<Vec<String>>,
    model_overrides:
        Option<std::collections::BTreeMap<String, maka_protocol::configuration::ModelOverride>>,
    catalog_revision: Option<u64>,
    credential: Option<Box<maka_protocol::configuration::CredentialStatus>>,
}
pub enum Updated {
    Policy(maka_protocol::configuration::policy::RuntimePolicyMutationResult),
    ConnectionTest(maka_protocol::connection_effects::ConnectionTestRunResult),
    ModelFetch(maka_protocol::connection_effects::ConnectionModelFetchResult),
    Credential(maka_protocol::configuration::CredentialMutationResult),
    Catalog(maka_protocol::configuration::CatalogMutationResult),
    Session(SessionUpdateResult),
    Removal(SessionRemoveResult),
    Project(maka_protocol::project::Project),
}

#[derive(Default)]
pub struct Management {
    sandbox_sequence: u64,
    pub oauth: oauth::State,
    pub dialog: Option<Dialog>,
    pending: Option<Ticket>,
    directory_sequence: u64,
    directory_pending: Option<directory::Request>,
    chooser_sequence: u64,
    chooser_pending: Option<choose_project::Request>,
    locations_sequence: u64,
    locations_pending: Option<locations::Request>,
    models_sequence: u64,
    models_pending: Option<models::Request>,
    enabled_models_sequence: u64,
    enabled_models_pending: Option<enabled_models::Request>,
    credential_sequence: u64,
    credential_pending: Option<credentials::Request>,
    removal_sequence: u64,
    removal_pending: Option<removal::Request>,
}
pub struct Dialog {
    connection_test: Option<maka_protocol::connection_effects::ConnectionTestProjection>,
    target: Target,
    kind: Kind,
    editor: Editor,
    visible: bool,
    blocked: bool,
    error: Option<&'static str>,
    browser: Option<directory::Browser>,
    reviewing: bool,
    chooser: Option<choose_project::Chooser>,
    locations: Option<locations::Locations>,
    models: Option<models::Models>,
    sandbox: Option<sandbox::State>,
    enabled_models: Option<enabled_models::State>,
    credentials: Option<credentials::State>,
    removal: Option<removal::State>,
}

pub async fn execute(client: &Client, ticket: &Ticket) -> Result<Updated, RequestFailure> {
    if matches!(ticket.target.entity, Entity::SandboxDefaults) {
        return sandbox::defaults::write(client, ticket)
            .await
            .map(Updated::Policy);
    }
    if matches!(ticket.kind, Kind::Credential(_)) {
        return credentials::execute(client, ticket).await;
    }
    if ticket.target.is_default_model() {
        let revision = ticket.catalog_revision.ok_or_else(|| {
            RequestFailure::NotDispatched(maka_client::ClientError::Protocol(
                "Missing default model catalog revision".into(),
            ))
        })?;
        return client
            .set_default_model(
                maka_protocol::configuration::SetDefaultConnectionTargetInput {
                    expected_catalog_revision: revision,
                    target: ticket.model.as_ref().map(|model| {
                        maka_protocol::configuration::ConnectionTarget {
                            connection_id: model.connection_id.clone(),
                            model_id: model.model.clone(),
                        }
                    }),
                },
            )
            .await
            .map(Updated::Catalog);
    }
    if let Entity::Connection(row) = &ticket.target.entity {
        if ticket.kind == Kind::Connection(connection::Change::Test) {
            return client
                .test_connection(maka_protocol::connection_effects::ConnectionTestRunInput {
                    connection_id: row.id.clone(),
                    model_id: None,
                })
                .await
                .map(Updated::ConnectionTest);
        }
        if ticket.kind == Kind::Connection(connection::Change::FetchModels) {
            return client
                .fetch_connection_models(&row.id)
                .await
                .map(Updated::ModelFetch);
        }
        return connection::execute(client, ticket)
            .await
            .map(Updated::Catalog);
    }
    let Entity::Session { id, revision, .. } = &ticket.target.entity else {
        return project::execute(client, ticket).await.map(Updated::Project);
    };
    let result = match ticket.kind {
        Kind::Remove => {
            return client
                .remove_session(SessionRemoveInput {
                    session_id: id.clone(),
                    expected_revision: *revision,
                })
                .await
                .map(Updated::Removal);
        }
        Kind::Sandbox => {
            let mut patch = serde_json::json!({});
            if let Some(mode) = ticket.sandbox_mode {
                patch["sandboxMode"] = serde_json::to_value(mode).unwrap();
            }
            if let Some(approval) = ticket.approval_policy {
                patch["approvalPolicy"] = serde_json::to_value(approval).unwrap();
            }
            client
                .update_session_configuration(
                    decode_session_configuration_update_input(&serde_json::json!({
                        "sessionId":id,"expectedRevision":revision,"patch":patch
                    }))
                    .map_err(|e| {
                        RequestFailure::NotDispatched(maka_client::ClientError::Protocol(
                            e.to_string(),
                        ))
                    })?,
                )
                .await
        }
        Kind::Model => {
            let choice = ticket.model.as_ref().ok_or_else(|| {
                RequestFailure::NotDispatched(maka_client::ClientError::Protocol(
                    "Missing model selection".into(),
                ))
            })?;
            client.update_session_configuration(decode_session_configuration_update_input(&serde_json::json!({
                "sessionId":id,"expectedRevision":revision,"patch":{
                    "modelTarget":{"kind":"explicit","connectionId":choice.connection_id,"connectionSlug":choice.slug,"model":choice.model},
                    "thinkingLevel":ticket.thinking_level
                }
            })).map_err(|e|RequestFailure::NotDispatched(maka_client::ClientError::Protocol(e.to_string())))?).await
        }
        Kind::Rename => {
            client
                .update_session_metadata(SessionMetadataUpdateInput {
                    session_id: id.clone(),
                    expected_revision: *revision,
                    patch: SessionMetadataPatch {
                        name: Some(ticket.text.clone()),
                        labels: None,
                        is_flagged: None,
                    },
                })
                .await
        }
        Kind::Workspace | Kind::Project => {
            let workspace = if ticket.kind == Kind::Project {
                WorkspaceTarget::Project {
                    project_id: ticket.project_id.clone().ok_or_else(|| {
                        RequestFailure::NotDispatched(maka_client::ClientError::Protocol(
                            "Missing selected project".into(),
                        ))
                    })?,
                }
            } else {
                WorkspaceTarget::HostPath {
                    path: ticket.text.clone(),
                }
            };
            client
                .relocate_session_workspace(SessionWorkspaceRelocateInput {
                    session_id: id.clone(),
                    expected_revision: *revision,
                    workspace,
                })
                .await
        }
        Kind::Archive | Kind::Restore => client
            .set_session_lifecycle(SessionLifecycleSetInput {
                session_id: id.clone(),
                state: if ticket.kind == Kind::Archive {
                    SessionLifecycleState::Archived
                } else {
                    SessionLifecycleState::Active
                },
            })
            .await
            .map(|session| SessionUpdateResult::Committed {
                session: Box::new(session),
            }),
        Kind::Reference
        | Kind::Oauth
        | Kind::Register
        | Kind::Relink
        | Kind::Locations
        | Kind::Connection(_)
        | Kind::Credential(_) => {
            return Err(RequestFailure::NotDispatched(
                maka_client::ClientError::Protocol("Invalid management target".into()),
            ));
        }
    };
    result.map(Updated::Session)
}

impl App {
    fn management_identity(&self, target: &Target) -> bool {
        matches!(&self.connection, ConnectionState::Connected {root_id, epoch} if *root_id == target.root && *epoch == target.epoch)
    }
    pub fn management_commands(&self) -> Vec<(Action, &'static str)> {
        let ConnectionState::Connected { root_id, epoch } = &self.connection else {
            return vec![];
        };
        if self.navigation.current() == Route::Projects {
            return self.project_management_commands(root_id, epoch);
        }
        if self.navigation.current() == Route::Connections {
            return self.connection_management_commands(root_id, epoch);
        }
        if self.navigation.current() == Route::Settings {
            return self
                .sandbox_defaults_action()
                .into_iter()
                .map(|action| (action, "sandbox-default-title"))
                .collect();
        }
        let item = match self.navigation.current() {
            Route::Session(id) => match &self.sessions.detail {
                super::sessions::Detail::Ready(item) if item.id == id => item.as_ref(),
                _ => {
                    // A catalog-opened session is already identified before its
                    // detail query completes. Keep commands available from that
                    // last confirmed projection; the Host still enforces CAS.
                    let Some(item) = self
                        .sessions
                        .items
                        .iter()
                        .chain(&self.inbox.items)
                        .find(|item| item.id == id)
                    else {
                        return vec![];
                    };
                    item
                }
            },
            Route::Workspace => {
                let catalog = self.catalog();
                let Some(item) = catalog
                    .items
                    .iter()
                    .find(|item| Some(&item.id) == catalog.selected.as_ref())
                else {
                    return vec![];
                };
                item
            }
            _ => return vec![],
        };
        let target = Target {
            root: root_id.clone(),
            epoch: epoch.clone(),
            name: item.name.clone(),
            entity: Entity::Session {
                id: item.id.clone(),
                revision: item.revision,
                workspace: item.workspace.host_cwd.clone(),
                project_bound: matches!(item.workspace.target, WorkspaceTarget::Project { .. }),
            },
        };
        let mut kinds = vec![
            Kind::Rename,
            if item.is_archived {
                Kind::Restore
            } else {
                Kind::Archive
            },
        ];
        if !item.is_archived {
            kinds.push(Kind::Sandbox);
            kinds.push(Kind::Workspace);
            kinds.push(Kind::Project);
            if item.backend == Backend::AiSdk {
                kinds.push(Kind::Model);
            }
        }
        kinds.push(Kind::Remove);
        kinds
            .into_iter()
            .map(|kind| {
                let label = kind.label(&target);
                (Action::Manage(Command::Open(target.clone(), kind)), label)
            })
            .collect()
    }
    pub fn management_enabled(&self, command: &Command) -> bool {
        match command {
            Command::Oauth(command) => self.oauth_enabled(*command),
            Command::CredentialRetry => self.credential_retry_enabled(),
            Command::RemovalQuery => self.removal_query_enabled(),
            Command::Models(command) => self.models_enabled(command),
            Command::Sandbox(_) => self.management.dialog.as_ref().is_some_and(|d| {
                d.sandbox.as_ref().is_some_and(sandbox::State::loaded)
                    && d.visible
                    && !d.blocked
                    && self.management.pending.is_none()
                    && self.management_identity(&d.target)
            }),
            Command::EnabledModels(command) => self.enabled_models_enabled(command),
            Command::Locations(command) => self.locations_enabled(command),
            Command::Browse => self.management.dialog.as_ref().is_some_and(|d| {
                d.kind == Kind::Register
                    && d.visible
                    && !d.blocked
                    && d.browser.is_none()
                    && self.management.pending.is_none()
                    && self.management_identity(&d.target)
            }),
            Command::Directory(command) => self.directory_enabled(command),
            Command::ChooseProject(command) => self.choose_project_enabled(command),
            Command::Open(target, kind) => {
                self.management_identity(target)
                    && self.connection_target_known(target)
                    && matches!(
                        (&target.entity, kind),
                        (Entity::Oauth, Kind::Oauth)
                            | (Entity::Registration, Kind::Register)
                            | (Entity::Input(_), Kind::Reference)
                            | (Entity::Defaults, Kind::Model)
                            | (Entity::SandboxDefaults, Kind::Sandbox)
                            | (
                                Entity::Connection(_),
                                Kind::Oauth
                                    | Kind::Rename
                                    | Kind::Connection(_)
                                    | Kind::Credential(_)
                            )
                            | (
                                Entity::Session { .. },
                                Kind::Rename
                                    | Kind::Workspace
                                    | Kind::Project
                                    | Kind::Model
                                    | Kind::Sandbox
                                    | Kind::Archive
                                    | Kind::Restore
                                    | Kind::Remove
                            )
                            | (
                                Entity::Project { .. },
                                Kind::Rename
                                    | Kind::Relink
                                    | Kind::Locations
                                    | Kind::Archive
                                    | Kind::Restore
                            )
                    )
                    && self.management.dialog.is_none()
                    && self.management.pending.is_none()
            }
            Command::Close => self.management.dialog.is_some(),
            Command::Edit => self.management.dialog.as_ref().is_some_and(|dialog| {
                dialog.reviewing
                    && !dialog.blocked
                    && self.management.pending.is_none()
                    && self.management_identity(&dialog.target)
            }),
            Command::Save if self.directory_reference_active() => self.reference_can_select(),
            Command::Save => self.management.dialog.as_ref().is_some_and(|dialog| {
                dialog.kind != Kind::Oauth
                    && dialog.sandbox.as_ref().is_none_or(sandbox::State::changed)
                    && dialog.visible
                    && self.credential_can_save()
                    && dialog.removal.as_ref().is_none_or(|state| state.can_save())
                    && dialog.locations.is_none()
                    && dialog
                        .enabled_models
                        .as_ref()
                        .is_none_or(|state| state.can_save())
                    && dialog
                        .models
                        .as_ref()
                        .is_none_or(|models| models.can_submit())
                    && dialog
                        .chooser
                        .as_ref()
                        .is_none_or(|chooser| chooser.selection().is_some())
                    && !dialog.blocked
                    && (dialog.browser.is_some() || dialog.editor.error.is_none())
                    && self.management.pending.is_none()
                    && self.management_identity(&dialog.target)
                    && dialog.browser.as_ref().map_or_else(
                        || {
                            dialog.kind.edits_configuration()
                                || !dialog.kind.edits_text()
                                || !dialog.editor.text().trim().is_empty()
                        },
                        |browser| browser.can_register(),
                    )
            }),
        }
    }
    pub fn management_action(&mut self, command: Command) -> Option<Action> {
        match command {
            Command::Oauth(command) => return self.oauth_action(command),
            Command::CredentialRetry => {
                self.credential_retry();
                return None;
            }
            Command::Models(command) => return self.models_action(command),
            Command::Sandbox(mode) => {
                self.sandbox_update(mode);
            }
            Command::RemovalQuery => {
                self.request_removal_query();
            }
            Command::EnabledModels(command) => return self.enabled_models_action(command),
            Command::Locations(command) => return self.locations_action(command),
            Command::ChooseProject(command) => return self.choose_project_action(command),
            Command::Edit => {
                let dialog = self.management.dialog.as_mut()?;
                dialog.reviewing = false;
                dialog.error = None;
                dialog.visible = false;
                self.hits.clear();
            }
            Command::Browse => {
                self.management.directory_sequence += 1;
                let dialog = self.management.dialog.as_mut()?;
                dialog.browser = Some(directory::Browser::new(self.management.directory_sequence));
                dialog.error = None;
                dialog.editor.invalidate_geometry();
                dialog.visible = false;
                self.hits.clear();
            }
            Command::Directory(command) => return self.directory_action(command),
            Command::Open(mut target, kind) => {
                if let Entity::Connection(row) = &target.entity {
                    // A menu names an entity, not a write basis. Read its latest
                    // confirmed projection when opening; the dialog then freezes
                    // that basis for review and Host CAS, even across refreshes.
                    let current = self
                        .connections
                        .rows
                        .iter()
                        .find(|item| item.id == row.id)?;
                    target.name = current.name.clone();
                    target.entity = Entity::Connection(current.clone());
                } else if let Entity::Session { id, revision, .. } = &target.entity {
                    let detail = match &self.sessions.detail {
                        super::sessions::Detail::Ready(item) => Some(item.as_ref()),
                        _ => None,
                    };
                    // Catalog and detail reads can finish in either order.
                    // Freeze the newest observed revision when opening, never
                    // rebase an already reviewed dialog on a later refresh.
                    if let Some(current) = detail
                        .into_iter()
                        .chain(self.sessions.items.iter())
                        .chain(self.inbox.items.iter())
                        .filter(|item| item.id == *id && item.revision >= *revision)
                        .max_by_key(|item| item.revision)
                    {
                        target.name = current.name.clone();
                        target.entity = Entity::Session {
                            id: current.id.clone(),
                            revision: current.revision,
                            workspace: current.workspace.host_cwd.clone(),
                            project_bound: matches!(
                                current.workspace.target,
                                WorkspaceTarget::Project { .. }
                            ),
                        };
                    }
                }
                if kind == Kind::Oauth {
                    self.oauth_open(&target);
                }
                self.invalidate_editor_geometry();
                self.palette = None;
                self.hover = None;
                let sandbox = if kind == Kind::Sandbox {
                    self.management.sandbox_sequence += 1;
                    Some(if matches!(target.entity, Entity::SandboxDefaults) {
                        sandbox::State::defaults(self.management.sandbox_sequence)
                    } else {
                        sandbox::State::for_target(self, &target)?
                    })
                } else {
                    None
                };
                let models = if kind == Kind::Model {
                    self.management.models_sequence += 1;
                    let mut models = models::Models::new(
                        self.management.models_sequence,
                        target.is_default_model(),
                    );
                    if let Entity::Session { id, revision, .. } = &target.entity {
                        let detail = match &self.sessions.detail {
                            super::sessions::Detail::Ready(item) => Some(item.as_ref()),
                            _ => None,
                        };
                        models.thinking = detail
                            .into_iter()
                            .chain(self.sessions.items.iter())
                            .find(|item| item.id == *id && item.revision == *revision)
                            .and_then(|item| item.thinking_level);
                    }
                    Some(models)
                } else {
                    None
                };
                let locations = if kind == Kind::Locations {
                    self.management.locations_sequence += 1;
                    Some(locations::Locations::new(
                        self.management.locations_sequence,
                    ))
                } else {
                    None
                };
                let chooser = if kind == Kind::Project {
                    self.management.chooser_sequence += 1;
                    Some(choose_project::Chooser::new(
                        self.management.chooser_sequence,
                    ))
                } else {
                    None
                };
                let mut editor = Editor::bounded(
                    if kind.edits_configuration() {
                        64 * 1024
                    } else if kind.edits_path() {
                        4096
                    } else if matches!(target.entity, Entity::Project { .. }) {
                        16 * 1024
                    } else if matches!(target.entity, Entity::Connection(_)) {
                        1024
                    } else {
                        320
                    },
                    if kind.edits_configuration() {
                        "connection-configuration-too-large"
                    } else if kind.edits_path() {
                        "session-path-too-large"
                    } else {
                        "session-name-too-large"
                    },
                );
                let configuration;
                editor.insert(if kind.edits_configuration() {
                    let Entity::Connection(row) = &target.entity else {
                        unreachable!()
                    };
                    configuration = row.configuration.to_string();
                    &configuration
                } else if kind == Kind::Workspace {
                    let Entity::Session { workspace, .. } = &target.entity else {
                        unreachable!()
                    };
                    workspace
                } else if kind == Kind::Relink || matches!(kind, Kind::Credential(_)) {
                    ""
                } else {
                    &target.name
                });
                editor.key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL));
                let credentials = if matches!(kind, Kind::Credential(_)) {
                    self.management.credential_sequence += 1;
                    Some(credentials::State::new(self.management.credential_sequence))
                } else {
                    None
                };
                let enabled_models = if matches!(
                    kind,
                    Kind::Connection(
                        connection::Change::EnabledModels | connection::Change::ModelOverrides
                    )
                ) {
                    let Entity::Connection(row) = &target.entity else {
                        unreachable!()
                    };
                    let query = self.connections.model_query(&row.id).unwrap_or(
                        maka_protocol::configuration::ConnectionCatalogQueryInput::Start,
                    );
                    self.management.enabled_models_sequence += 1;
                    Some(enabled_models::State::new(
                        self.management.enabled_models_sequence,
                        &target,
                        query,
                        kind == Kind::Connection(connection::Change::ModelOverrides),
                    ))
                } else {
                    None
                };
                if kind == Kind::Reference {
                    self.management.directory_sequence += 1;
                }
                self.management.dialog = Some(Dialog {
                    removal: if kind == Kind::Remove {
                        self.management.removal_sequence += 1;
                        Some(removal::State::new(self.management.removal_sequence))
                    } else {
                        None
                    },
                    connection_test: None,
                    target,
                    kind,
                    editor,
                    visible: false,
                    blocked: false,
                    error: None,
                    browser: (kind == Kind::Reference)
                        .then(|| directory::Browser::new(self.management.directory_sequence)),
                    reviewing: false,
                    chooser,
                    locations,
                    models,
                    sandbox,
                    enabled_models,
                    credentials,
                });
            }
            Command::Close => {
                self.management.dialog = None;
                self.hits.clear();
            }
            Command::Save if self.directory_reference_active() => {
                self.resolve_directory_reference();
            }
            Command::Save => {
                let dialog = self.management.dialog.as_mut()?;
                if dialog.kind.requires_review() && !dialog.reviewing {
                    if dialog.kind.edits_configuration() {
                        let Entity::Connection(row) = &dialog.target.entity else {
                            unreachable!()
                        };
                        match connection::configuration(row, dialog.editor.text()) {
                            Ok(endpoint) => {
                                dialog
                                    .editor
                                    .key(KeyEvent::new(KeyCode::Char('a'), KeyModifiers::CONTROL));
                                dialog.editor.insert(&endpoint);
                                dialog.error = None;
                            }
                            Err(key) => {
                                dialog.error = Some(key);
                                return None;
                            }
                        }
                    }
                    dialog.reviewing = true;
                    if dialog.kind.edits_configuration() {
                        dialog
                            .editor
                            .key(KeyEvent::new(KeyCode::Home, KeyModifiers::CONTROL));
                    }
                    dialog.visible = false;
                    dialog.editor.invalidate_geometry();
                    self.hits.clear();
                } else {
                    return Some(Action::Manage(Command::Save));
                }
            }
        }
        None
    }
    pub fn management_request(&mut self) -> Option<Ticket> {
        if self.directory_reference_active() || !self.management_enabled(&Command::Save) {
            return None;
        }
        let dialog = self.management.dialog.as_mut()?;
        if dialog.kind.requires_review() && !dialog.reviewing {
            return None;
        }
        dialog.error = None;
        let ticket = Ticket {
            target: dialog.target.clone(),
            kind: dialog.kind,
            text: if dialog.credentials.is_some() {
                String::new()
            } else {
                dialog.editor.text().into()
            },
            credential: dialog
                .credentials
                .as_ref()
                .and_then(|s| s.status.clone())
                .map(Box::new),
            directory: dialog.browser.as_ref().and_then(|b| b.location.clone()),
            project_id: dialog
                .chooser
                .as_ref()
                .and_then(|c| c.selection().map(|item| item.id.clone())),
            model: dialog
                .models
                .as_ref()
                .and_then(|m| m.selection().map(|row| row.choice.clone())),
            thinking_level: dialog.models.as_ref().and_then(|m| m.thinking_level()),
            sandbox_mode: dialog.sandbox.as_ref().and_then(sandbox::State::mode_patch),
            approval_policy: dialog
                .sandbox
                .as_ref()
                .and_then(sandbox::State::approval_patch),
            policy_revision: dialog
                .sandbox
                .as_ref()
                .and_then(|state| state.defaults.as_ref())
                .and_then(|state| state.revision),
            enabled_model_ids: dialog
                .enabled_models
                .as_ref()
                .filter(|state| !state.edit_profiles)
                .map(|state| state.selected_ids()),
            model_overrides: dialog
                .enabled_models
                .as_ref()
                .and_then(|state| state.updated_profiles()),
            catalog_revision: dialog.models.as_ref().and_then(|m| m.catalog.revision()),
        };
        self.management.pending = Some(ticket.clone());
        Some(ticket)
    }
    pub fn management_completed(
        &mut self,
        ticket: Ticket,
        result: Result<Updated, RequestFailure>,
    ) {
        if self.management.pending.as_ref() != Some(&ticket) {
            return;
        }
        self.management.pending = None;
        if !self.management_identity(&ticket.target) {
            if ticket.kind == Kind::Remove
                && let Some(state) = self
                    .management
                    .dialog
                    .as_mut()
                    .and_then(|d| d.removal.as_mut())
            {
                state.uncertain = true;
            }
            self.abandon_management();
            return;
        }
        if ticket.kind == Kind::Remove {
            self.removal_written(ticket, result);
            return;
        }
        if let Ok(Updated::Session(SessionUpdateResult::Committed { session })) = &result {
            if ticket.kind == Kind::Model
                && self.navigation.current() == Route::Session(session.id.clone())
            {
                self.chat.context.refresh();
            }
            self.sessions.updated(session.clone());
            self.inbox.updated(session.clone());
        } else if let Entity::Session { id, .. } = &ticket.target.entity {
            self.sessions.invalidate(id);
            self.inbox.refresh();
        } else if ticket.target.is_default_model() {
            self.connections.refresh();
            self.models_catalog_changed();
        } else if matches!(ticket.target.entity, Entity::Connection(_)) {
            if let Ok(Updated::Catalog(result)) = &result {
                self.connection_acknowledged(&ticket, result);
            }
            if let Ok(Updated::ModelFetch(result)) = &result {
                self.connection_models_acknowledged(result);
            }
            if let Ok(Updated::ConnectionTest(
                maka_protocol::connection_effects::ConnectionTestRunResult::Committed {
                    connection,
                    ..
                },
            )) = &result
            {
                self.connections.rows.retain(|row| {
                    row.id != connection.connection_id || row.revision >= connection.revision
                });
            }
            if matches!(&result, Err(RequestFailure::Unknown(_)))
                || matches!(&result, Err(RequestFailure::Rejected(maka_client::ClientError::Rejected(error)))
                    if error.code == maka_protocol::OperationErrorCode::CommitOutcomeUnknown)
            {
                let Entity::Connection(row) = &ticket.target.entity else {
                    unreachable!()
                };
                // An uncertain write cannot reuse its old basis without a new authoritative read.
                self.connections.rows.retain(|current| current.id != row.id);
                if self.connections.selected.as_ref() == Some(&row.id) {
                    self.connections.selected = None;
                }
            }
            self.connections.refresh();
            self.models_catalog_changed();
            self.chat.context.refresh();
        } else {
            if let Ok(Updated::Project(project)) = &result {
                self.projects.updated(project);
                if ticket.kind == Kind::Register
                    && self
                        .management
                        .dialog
                        .as_ref()
                        .is_some_and(|d| d.target == ticket.target)
                    && self.navigation.current() == Route::Projects
                {
                    self.projects.selected = Some(project.id.clone());
                    self.focus = crate::app::Focus::List;
                    self.projects.restart();
                }
            } else {
                self.projects.refresh();
            }
        }
        let Some(dialog) = self
            .management
            .dialog
            .as_mut()
            .filter(|d| d.target == ticket.target && d.kind == ticket.kind)
        else {
            return;
        };
        match result {
            Ok(Updated::Removal(_)) => unreachable!("removal handled separately"),
            Ok(Updated::ConnectionTest(result)) => {
                use maka_protocol::connection_effects::ConnectionTestRunResult as Test;
                dialog.blocked = true;
                match result {
                    Test::Committed { test, .. } => dialog.connection_test = Some(test),
                    Test::Superseded { .. } => dialog.error = Some("connection-test-changed"),
                    Test::Rejected { reason } => {
                        dialog.error = Some(connection_test::rejection(reason))
                    }
                }
            }
            Ok(
                Updated::Policy(
                    maka_protocol::configuration::policy::RuntimePolicyMutationResult::Committed {
                        ..
                    },
                )
                | Updated::Session(SessionUpdateResult::Committed { .. })
                | Updated::Project(_)
                | Updated::Catalog(maka_protocol::configuration::CatalogMutationResult::Committed {
                    ..
                })
                | Updated::Credential(
                    maka_protocol::configuration::CredentialMutationResult::Committed { .. },
                )
                | Updated::ModelFetch(
                    maka_protocol::connection_effects::ConnectionModelFetchResult::Committed {
                        ..
                    },
                ),
            ) => self.management.dialog = None,
            Ok(Updated::Policy(_)) => {
                dialog.blocked = true;
                dialog.error = Some("sandbox-default-conflict");
            }
            Ok(Updated::ModelFetch(result)) => {
                let (error, blocked) = model_fetch::failure(&result);
                dialog.error = Some(error);
                dialog.blocked = blocked;
            }
            Ok(Updated::Credential(_)) => {
                dialog.blocked = true;
                dialog.error = Some("credential-conflict");
            }
            Ok(Updated::Catalog(result)) => {
                dialog.blocked = true;
                dialog.error = Some(if dialog.target.is_default_model() {
                    if matches!(
                        result,
                        maka_protocol::configuration::CatalogMutationResult::InvalidDefaultTarget { .. }
                    ) {
                        "default-model-unavailable"
                    } else {
                        "default-model-conflict"
                    }
                } else {
                    "connection-edit-conflict"
                });
            }
            Ok(Updated::Session(SessionUpdateResult::RevisionConflict { .. })) => {
                dialog.blocked = true;
                dialog.error = Some("session-edit-conflict");
            }
            Err(RequestFailure::Unknown(_)) => {
                dialog.blocked = true;
                dialog.error = Some("session-edit-unknown");
            }
            Err(RequestFailure::Rejected(maka_client::ClientError::Rejected(error)))
                if error.code == maka_protocol::OperationErrorCode::CommitOutcomeUnknown =>
            {
                dialog.blocked = true;
                dialog.error = Some("session-edit-unknown");
            }
            Err(RequestFailure::Rejected(maka_client::ClientError::Rejected(error)))
                if error.code == maka_protocol::OperationErrorCode::SessionBusy =>
            {
                dialog.error = Some("session-edit-busy");
            }
            Err(_) if matches!(dialog.kind, Kind::Credential(_)) => {
                dialog.blocked = true;
                dialog.error = Some("credential-write-failed");
            }
            Err(_) if dialog.kind == Kind::Connection(connection::Change::Test) => {
                dialog.blocked = true;
                dialog.error = Some("connection-test-unavailable");
            }
            Err(RequestFailure::Rejected(maka_client::ClientError::Rejected(error)))
                if dialog.kind == Kind::Connection(connection::Change::FetchModels)
                    && error.code == maka_protocol::OperationErrorCode::OperationUnavailable =>
            {
                dialog.error = Some("connection-models-fetch-not-ready");
                dialog.blocked = true;
            }
            Err(_) if dialog.kind == Kind::Connection(connection::Change::FetchModels) => {
                dialog.error = Some("connection-models-fetch-failed");
            }
            Err(RequestFailure::Rejected(maka_client::ClientError::Rejected(error)))
                if dialog.kind == Kind::Workspace
                    && error.code == maka_protocol::OperationErrorCode::InvalidRequest =>
            {
                dialog.error = Some("session-workspace-invalid");
            }
            Err(RequestFailure::Rejected(maka_client::ClientError::Rejected(_)))
                if dialog.target.is_default_model() =>
            {
                dialog.error = Some("default-model-failed");
            }
            Err(RequestFailure::Rejected(maka_client::ClientError::Rejected(error)))
                if matches!(dialog.target.entity, Entity::Connection(_)) =>
            {
                dialog.error = Some(
                    if error.code == maka_protocol::OperationErrorCode::InvalidRequest {
                        "connection-edit-invalid"
                    } else {
                        "connection-edit-failed"
                    },
                );
            }
            Err(_) if matches!(dialog.target.entity, Entity::SandboxDefaults) => {
                dialog.blocked = true;
                dialog.error = Some("sandbox-default-failed");
            }
            Err(RequestFailure::Rejected(maka_client::ClientError::Rejected(error)))
                if !matches!(dialog.target.entity, Entity::Session { .. }) =>
            {
                if error.code == maka_protocol::OperationErrorCode::NotFound {
                    dialog.blocked = true;
                    dialog.error = Some("project-edit-missing");
                } else {
                    dialog.error = Some(match dialog.kind {
                        Kind::Register => "project-register-failed",
                        Kind::Relink => "project-relink-failed",
                        _ => "project-edit-failed",
                    });
                }
            }
            Err(RequestFailure::NotDispatched(maka_client::ClientError::Protocol(_)))
                if matches!(dialog.target.entity, Entity::Connection(_)) =>
            {
                dialog.error = Some("connection-edit-invalid");
            }
            Err(RequestFailure::NotDispatched(maka_client::ClientError::Protocol(_)))
                if dialog.kind.edits_path() =>
            {
                dialog.error = Some("session-workspace-invalid");
            }
            Err(RequestFailure::Rejected(maka_client::ClientError::Rejected(error)))
                if dialog.kind == Kind::Workspace
                    && error.code == maka_protocol::OperationErrorCode::OperationConflict =>
            {
                dialog.blocked = true;
                dialog.error = Some("session-workspace-unavailable");
            }
            Err(_) if dialog.kind == Kind::Project => {
                dialog.error = Some("session-project-failed");
                if let Some(chooser) = &mut dialog.chooser {
                    chooser.catalog.refresh();
                }
            }
            Err(_) if dialog.kind == Kind::Model => {
                dialog.error = Some(if dialog.target.is_default_model() {
                    "default-model-failed"
                } else {
                    "session-model-failed"
                });
                if let Some(models) = &mut dialog.models {
                    models.catalog.refresh();
                }
            }
            Err(_) => {
                dialog.error = Some("session-edit-failed");
            }
        }
    }
    pub fn abandon_management(&mut self) {
        self.abandon_removal();
        self.management.directory_pending = None;
        self.management.chooser_pending = None;
        self.management.locations_pending = None;
        self.management.models_pending = None;
        self.management.enabled_models_pending = None;
        self.management.credential_pending = None;
        let unknown = self.management.pending.take().is_some();
        if let Some(dialog) = &mut self.management.dialog {
            dialog.blocked = true;
            dialog.error = Some(if unknown || dialog.error == Some("session-edit-unknown") {
                "session-edit-unknown"
            } else if dialog.kind == Kind::Locations {
                "project-locations-disconnected"
            } else {
                "session-edit-disconnected"
            });
        }
    }
    /// Input the sheet's owner takes before the sheet: shortcuts of its
    /// sub-states (F5 retries a read, PgUp/PgDn page the project chooser,
    /// Ctrl+Enter applies it), and a focused text field gets every key but
    /// the sheet's own (Esc, Tab, Enter, quitting), pastes, and its pointer.
    pub(crate) fn management_sheet_input(
        &mut self,
        event: &Event,
    ) -> Option<(bool, Option<Action>)> {
        if self
            .management
            .dialog
            .as_ref()
            .is_some_and(|dialog| dialog.enabled_models.is_some())
        {
            return self.enabled_models_sheet_input(event);
        }
        if self
            .management
            .dialog
            .as_ref()
            .is_some_and(|dialog| dialog.kind == Kind::Oauth)
        {
            return oauth::sheet_input(self, event);
        }
        if let Event::Key(key) = event
            && key.kind != KeyEventKind::Release
            && let Some(command) = self.management.dialog.as_ref().and_then(|dialog| {
                let chooser = dialog.chooser.is_some();
                let models = dialog.models.is_some();
                let locations = dialog.locations.is_some();
                let browser = dialog.browser.is_some();
                match key.code {
                    KeyCode::F(5) if browser => {
                        Some(Command::Directory(directory::Command::Refresh))
                    }
                    KeyCode::PageUp if browser => {
                        Some(Command::Directory(directory::Command::Previous))
                    }
                    KeyCode::PageDown if browser => {
                        Some(Command::Directory(directory::Command::Next))
                    }
                    KeyCode::Backspace | KeyCode::Left if browser => {
                        Some(Command::Directory(directory::Command::Parent))
                    }
                    KeyCode::Enter if browser && key.modifiers.contains(KeyModifiers::CONTROL) => {
                        Some(Command::Save)
                    }
                    KeyCode::F(5) if locations => {
                        Some(Command::Locations(locations::Command::Refresh))
                    }
                    KeyCode::PageUp if locations => {
                        Some(Command::Locations(locations::Command::Previous))
                    }
                    KeyCode::PageDown if locations => {
                        Some(Command::Locations(locations::Command::Next))
                    }
                    KeyCode::F(5) if models => Some(Command::Models(models::Command::Refresh)),
                    KeyCode::PageUp if models => Some(Command::Models(models::Command::Previous)),
                    KeyCode::PageDown if models => Some(Command::Models(models::Command::Next)),
                    KeyCode::Enter if models && key.modifiers.contains(KeyModifiers::CONTROL) => {
                        Some(Command::Save)
                    }
                    KeyCode::F(5) if dialog.credentials.is_some() => Some(Command::CredentialRetry),
                    KeyCode::F(5) if dialog.removal.is_some() => Some(Command::RemovalQuery),
                    KeyCode::F(5) if chooser => {
                        Some(Command::ChooseProject(choose_project::Command::Refresh))
                    }
                    KeyCode::PageUp if chooser => {
                        Some(Command::ChooseProject(choose_project::Command::Previous))
                    }
                    KeyCode::PageDown if chooser => {
                        Some(Command::ChooseProject(choose_project::Command::Next))
                    }
                    KeyCode::Enter if chooser && key.modifiers.contains(KeyModifiers::CONTROL) => {
                        Some(Command::Save)
                    }
                    _ => None,
                }
            })
        {
            return Some((true, self.apply(Action::Manage(command))));
        }
        let busy = self.management.pending.is_some();
        let dialog = self.management.dialog.as_mut()?;
        if dialog.kind.edits_configuration() && dialog.reviewing && dialog.visible {
            return match event {
                Event::Key(key)
                    if key.kind != KeyEventKind::Release
                        && self.layer.focused("field")
                        && matches!(
                            key.code,
                            KeyCode::Up
                                | KeyCode::Down
                                | KeyCode::Left
                                | KeyCode::Right
                                | KeyCode::Home
                                | KeyCode::End
                        ) =>
                {
                    Some((dialog.editor.key(*key), None))
                }
                Event::Mouse(mouse) if dialog.editor.takes(mouse) => {
                    if matches!(mouse.kind, crossterm::event::MouseEventKind::Down(_)) {
                        self.layer.focus("field");
                    }
                    Some((dialog.editor.mouse(*mouse), None))
                }
                _ => None,
            };
        }
        if !dialog.kind.edits_text()
            || dialog.reviewing
            || busy
            || dialog.blocked
            || self.layer.slot("field").is_none()
        {
            return None;
        }
        let focused = self.layer.focused("field");
        match event {
            Event::Key(key) if key.kind != KeyEventKind::Release && focused => {
                let quit =
                    key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('q');
                if quit
                    || matches!(
                        key.code,
                        KeyCode::Esc | KeyCode::Tab | KeyCode::BackTab | KeyCode::Enter
                    )
                {
                    return None;
                }
                let changed = dialog.editor.key(*key);
                if changed && dialog.editor.error.is_none() {
                    dialog.error = None;
                }
                Some((changed, None))
            }
            Event::Paste(text) if focused => {
                dialog.error = None;
                if dialog.kind.edits_configuration() {
                    return Some((dialog.editor.insert(text), None));
                }
                if dialog.kind.edits_path() && text.chars().any(char::is_control) {
                    dialog.editor.error = Some("session-path-control");
                    return Some((true, None));
                }
                Some((dialog.editor.insert(&text.replace(['\n', '\r'], " ")), None))
            }
            Event::Mouse(mouse) if dialog.editor.takes(mouse) => {
                let press = matches!(mouse.kind, crossterm::event::MouseEventKind::Down(_));
                if press {
                    self.layer.focus("field");
                }
                Some((dialog.editor.mouse(*mouse) || (press && !focused), None))
            }
            _ => None,
        }
    }
}

impl Management {
    /// The confirmation sheet reports whether it is on screen; Save needs it.
    pub(crate) fn presented(&mut self, shown: bool) {
        if let Some(dialog) = &mut self.dialog {
            dialog.visible = shown;
        }
    }
    pub(crate) fn destructive(&self) -> bool {
        self.dialog.as_ref().is_some_and(|dialog| {
            matches!(
                dialog.kind,
                Kind::Remove | Kind::Connection(connection::Change::Remove)
            )
        })
    }
    pub fn invalidate_geometry(&mut self) {
        if let Some(dialog) = &mut self.dialog {
            dialog.visible = false;
            dialog.editor.invalidate_geometry();
            if let Some(models) = &mut dialog.enabled_models {
                models.invalidate_geometry();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::{Terminal, backend::TestBackend};

    #[test]
    fn pinned_management_is_modal_bounded_and_never_replays_uncertain_writes() {
        let mut app = App::new(
            "/unused".into(),
            crate::i18n::I18n::new(
                crate::LocalePreference::Explicit(crate::Locale::En),
                crate::Locale::En,
            ),
        );
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "epoch".into(),
        };
        app.apply(Action::Visit(Route::Session("A".into())));
        app.drafts.get_mut("A").unwrap().insert("untouched draft");
        let target = Target {
            root: "root".into(),
            epoch: "epoch".into(),
            name: "Before".into(),
            entity: Entity::Session {
                id: "A".into(),
                revision: 7,
                workspace: "/work".into(),
                project_bound: false,
            },
        };
        let key = |code| Event::Key(KeyEvent::new(code, KeyModifiers::NONE));
        let mut screen = Terminal::new(TestBackend::new(80, 24)).unwrap();
        app.apply(Action::Manage(Command::Open(target.clone(), Kind::Rename)));
        assert!(
            app.management_request().is_none(),
            "cannot save an unrendered dialog"
        );
        screen
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        app.input(Event::Paste("中文\nname".into()));
        app.input(Event::Key(KeyEvent::new(KeyCode::Left, KeyModifiers::ALT)));
        assert_eq!(app.navigation.current(), Route::Session("A".into()));
        assert_eq!(app.drafts["A"].text(), "untouched draft");
        app.input(Event::Resize(20, 8));
        assert!(app.input(key(KeyCode::Enter)).1.is_none());
        screen
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        let ticket = app.management_request().unwrap();
        assert_eq!(ticket.text, "中文 name");
        assert!(matches!(
            ticket.target.entity,
            Entity::Session { revision: 7, .. }
        ));
        assert!(app.management_request().is_none());
        app.management_completed(
            ticket.clone(),
            Ok(Updated::Session(SessionUpdateResult::RevisionConflict {
                expected_revision: 7,
                actual_revision: 8,
            })),
        );
        assert_eq!(
            app.management.dialog.as_ref().unwrap().editor.text(),
            "中文 name"
        );
        assert!(!app.management_enabled(&Command::Save));
        for failure in [
            RequestFailure::Unknown(maka_client::ClientError::Timeout),
            RequestFailure::Rejected(maka_client::ClientError::Rejected(
                maka_protocol::OperationError {
                    code: maka_protocol::OperationErrorCode::CommitOutcomeUnknown,
                    message: "commit outcome".into(),
                },
            )),
        ] {
            app.apply(Action::Manage(Command::Close));
            app.apply(Action::Manage(Command::Open(target.clone(), Kind::Rename)));
            screen
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap();
            let pending = app.management_request().unwrap();
            app.management_completed(pending, Err(failure));
            assert!(!app.management_enabled(&Command::Save));
            app.abandon_management();
            assert_eq!(
                app.management.dialog.as_ref().unwrap().error,
                Some("session-edit-unknown")
            );
        }
        app.apply(Action::Manage(Command::Close));
        app.apply(Action::Manage(Command::Open(
            target.clone(),
            Kind::Workspace,
        )));
        screen
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        for invalid in ["/work\n/other", "/work\tname", "/work\u{1b}[2J"] {
            app.input(Event::Paste(invalid.into()));
            assert_eq!(
                app.management.dialog.as_ref().unwrap().editor.text(),
                "/work"
            );
            assert!(
                !app.management_enabled(&Command::Save),
                "rejected paste cannot submit the previous path"
            );
        }
        let literal = "C:\\项目\\with spaces";
        app.input(Event::Paste(literal.into()));
        assert_eq!(
            app.management.dialog.as_ref().unwrap().editor.text(),
            literal,
            "a Host path must not be interpreted using the client's filesystem"
        );
        let mut tiny = Terminal::new(TestBackend::new(30, 10)).unwrap();
        tiny.draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        assert!(
            app.management_request().is_none(),
            "hidden workspace warning cannot be confirmed"
        );
        screen
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        let request = app.management_request().unwrap();
        assert_eq!(request.text, literal);
        app.management_completed(
            request,
            Err(RequestFailure::Rejected(
                maka_client::ClientError::Rejected(maka_protocol::OperationError {
                    code: maka_protocol::OperationErrorCode::SessionBusy,
                    message: "work in progress".into(),
                }),
            )),
        );
        assert_eq!(
            app.management.dialog.as_ref().unwrap().editor.text(),
            literal
        );
        assert_eq!(
            app.management.dialog.as_ref().unwrap().error,
            Some("session-edit-busy")
        );
        assert!(
            app.management.pending.is_none(),
            "busy never starts an automatic retry"
        );
        app.management.dialog.as_mut().unwrap().error = None;
        if let Entity::Session { project_bound, .. } =
            &mut app.management.dialog.as_mut().unwrap().target.entity
        {
            *project_bound = true;
        }
        for locale in crate::Locale::ALL {
            app.i18n = crate::i18n::I18n::new(
                crate::LocalePreference::Explicit(locale),
                crate::Locale::En,
            );
            let painted = screen
                .draw(|frame| crate::view::draw(frame, &mut app))
                .unwrap()
                .buffer
                .content
                .iter()
                .map(|cell| cell.symbol())
                .collect::<String>();
            let compact = |text: &str| {
                text.chars()
                    .filter(|c| !c.is_whitespace() && !"│─╭╮╰╯".contains(*c))
                    .collect::<String>()
            };
            assert!(
                compact(&painted)
                    .contains(&compact(&app.i18n.text("session-workspace-project-note"))),
                "the complete project-binding warning must fit before enabling Switch: {locale:?}\n{painted}"
            );
            assert!(app.management_enabled(&Command::Save));
        }
        app.apply(Action::Manage(Command::Close));
        app.apply(Action::Manage(Command::Open(target.clone(), Kind::Archive)));
        screen
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        app.input(key(KeyCode::Enter)); // Cancel is the default, never Archive.
        assert!(app.management.dialog.is_none());
        app.apply(Action::Manage(Command::Open(target.clone(), Kind::Archive)));
        screen
            .draw(|frame| crate::view::draw(frame, &mut app))
            .unwrap();
        let ticket = app.management_request().unwrap();
        app.input(Event::Mouse(crossterm::event::MouseEvent {
            kind: crossterm::event::MouseEventKind::Down(crossterm::event::MouseButton::Left),
            column: 0,
            row: 0,
            modifiers: KeyModifiers::NONE,
        }));
        assert!(app.management.dialog.is_none());
        assert!(!app.management_enabled(&Command::Open(target.clone(), Kind::Archive)));
        app.apply(Action::Visit(Route::Session("B".into())));
        let committed = || {
            Ok(Updated::Session(SessionUpdateResult::Committed {
                session: Box::new(crate::pages::sessions::tests::item("A")),
            }))
        };
        app.management_completed(ticket.clone(), committed());
        assert_eq!(app.navigation.current(), Route::Session("B".into()));
        app.apply(Action::Manage(Command::Open(target.clone(), Kind::Rename)));
        app.management_completed(ticket, committed()); // Duplicate/stale ack cannot close a newer dialog.
        assert!(app.management.dialog.is_some());
        app.connection = ConnectionState::Connected {
            root_id: "root".into(),
            epoch: "new epoch".into(),
        };
        assert!(!app.management_enabled(&Command::Save));
        app.abandon_management();
        assert!(app.management.dialog.as_ref().unwrap().blocked);
    }
}
