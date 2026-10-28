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
use maka_agent_api::{
    contract::WorkspaceAccess,
    session::{ResolvedConfiguration, StoredSessionConfiguration},
};
use maka_agent_facts::{
    interaction::{Decision, GrantCapability, GrantScope, GrantTarget},
    workspace::PermissionBasis,
};
use maka_capabilities::call::Scope;
use maka_computer_use::{
    AuthorizationFuture, BrowserAccess, BrowserAttachmentAuthorization, BrowserAttachmentOrigin,
    BrowserAuthorization,
};
use maka_sandbox::{Destination, Network, Sandbox};

/// Origin consent belongs to the captured Agent Session, shared across its
/// browser connections. It cannot be supplied by a model or borrowed by a
/// later invocation through a retained desktop transport callback.
#[derive(Clone)]
pub(super) struct Access {
    owner: Arc<Computer>,
    call: Scope,
    basis: PermissionBasis,
    cell: maka_code_runtime::CellContext,
    producer: CancellationToken,
    attachment: Arc<Attachment>,
}

impl Access {
    pub fn new(
        owner: Arc<Computer>,
        call: Scope,
        basis: PermissionBasis,
        cell: maka_code_runtime::CellContext,
        producer: CancellationToken,
        gate: Arc<admission::Gate>,
    ) -> Arc<Self> {
        let invocation = call.identity.agent().expect("checked Agent");
        let attachment = Arc::new(Attachment {
            owner: Arc::downgrade(&owner),
            session: invocation.session_id.clone(),
            turn: invocation.turn_id.clone(),
            basis,
            gate,
        });
        Arc::new(Self {
            owner,
            call,
            basis,
            cell,
            producer,
            attachment,
        })
    }

    async fn current(
        &self,
        access: &BrowserAccess,
        cancellation: &CancellationToken,
    ) -> Result<(ResolvedConfiguration, Option<GrantTarget>), ToolError> {
        if cancellation.is_cancelled() || self.producer.is_cancelled() {
            return Err(failed("Browser authorization cancelled"));
        }
        access::granted(&self.owner, &self.call, self.basis).await?;
        let (configuration, _) = access::current(&self.owner, &self.call, "cua_repl").await?;
        if configuration.permission_basis() != self.basis {
            return Err(failed("Browser permission boundary changed"));
        }
        let Some(origin) = access.origin()? else {
            return Ok((configuration, None));
        };
        network_allowed(&configuration, &origin).await?;
        if cancellation.is_cancelled() || self.producer.is_cancelled() {
            return Err(failed("Browser authorization cancelled"));
        }
        Ok((configuration, Some(target(origin))))
    }
}

impl BrowserAuthorization for Access {
    fn attachment(&self) -> Option<Arc<dyn BrowserAttachmentAuthorization>> {
        Some(self.attachment.clone())
    }

    fn authorize(
        &self,
        browser: BrowserAccess,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let access = self.clone();
        Box::pin(async move {
            let child = cancellation.child_token();
            let authorization = async {
                let (configuration, target) = access.current(&browser, &child).await?;
                if let Some(target) = target {
                    access::approve_target(
                        &access.owner,
                        &access.call,
                        &configuration,
                        &child,
                        target,
                        Some(&access.cell),
                    )
                    .await?;
                    // A prompt can span a workspace-policy edit or permission CAS.
                    let (_, target) = access.current(&browser, &child).await?;
                    if access::browser_decision(
                        &access.owner,
                        &access.call,
                        access.basis,
                        &target.expect("HTTP origin remains the same captured request"),
                    )
                    .await?
                        != Some(Decision::Allow)
                    {
                        return Err(failed("Browser site approval is no longer current"));
                    }
                }
                Ok(())
            };
            tokio::pin!(authorization);
            tokio::select! {
                result = &mut authorization => result,
                () = access.producer.cancelled() => {
                    child.cancel();
                    // The canonical request must be withdrawn before its old
                    // VM's accepted operation can settle. Keep the same future.
                    authorization.await
                },
            }
        })
    }

    fn check(
        &self,
        browser: BrowserAccess,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let access = self.clone();
        Box::pin(async move {
            let (_, target) = access.current(&browser, &cancellation).await?;
            if let Some(target) = target
                && access::browser_decision(&access.owner, &access.call, access.basis, &target)
                    .await?
                    != Some(Decision::Allow)
            {
                return Err(failed("Browser site access has not been granted"));
            }
            Ok(())
        })
    }
}

async fn network_allowed(
    configuration: &ResolvedConfiguration,
    origin: &str,
) -> Result<(), ToolError> {
    let url = url::Url::parse(origin).map_err(failed)?;
    let destination = Destination::new(
        url.host_str()
            .ok_or_else(|| failed("Browser URL has no host"))?,
        url.port_or_known_default()
            .ok_or_else(|| failed("Browser URL has no network port"))?,
    )
    .map_err(failed)?;
    let workspace = configuration.workspace.clone();
    let allowed = tokio::task::spawn_blocking(move || {
        let path = std::path::PathBuf::from(&workspace.path);
        let directory =
            maka_fs_tools::directory::open(&path, &workspace.directory_identity).map_err(failed)?;
        if maka_fs_tools::workspace::read_directory_identity(path.clone(), directory)
            .map_err(failed)?
            != workspace.identity
        {
            return Err(failed("Browser workspace identity changed"));
        }
        let (_, policy) =
            maka_fs_tools::workspace::permissions::resolve(maka_sandbox::Mode::ReadOnly, &path)
                .map_err(failed)?;
        let network = match policy {
            Sandbox::Managed { network, .. } | Sandbox::External { network } => network,
            Sandbox::Disabled => Network::Allowed,
        };
        Ok::<_, ToolError>(network.allows(&destination))
    })
    .await
    .map_err(failed)??;
    if !allowed {
        return Err(failed(
            "Workspace network policy does not allow this browser site",
        ));
    }
    Ok(())
}

/// A Host attachment checks canonical authority without retaining an Agent Run.
/// This is Maka admission policy, not an extra permission prompt in the original bridge.
#[derive(Clone)]
struct Attachment {
    owner: std::sync::Weak<Computer>,
    session: String,
    turn: String,
    basis: PermissionBasis,
    gate: Arc<admission::Gate>,
}
impl Attachment {
    fn alive(&self, cancellation: &CancellationToken) -> Result<Arc<Computer>, ToolError> {
        self.gate.check_open()?;
        let owner = self
            .owner
            .upgrade()
            .ok_or_else(|| failed("Computer Host service is closed"))?;
        if owner.stopping.is_cancelled() || cancellation.is_cancelled() {
            return Err(failed("Browser attachment cancelled"));
        }
        Ok(owner)
    }

    async fn current(
        &self,
        owner: &Computer,
        origin: &str,
    ) -> Result<ResolvedConfiguration, ToolError> {
        let store = owner
            .store
            .session(&self.session)
            .await
            .map_err(|error| ToolError::Persistence(message(error)))?;
        let projection = store
            .session_projection::<StoredSessionConfiguration>(&self.session)
            .await
            .map_err(|error| ToolError::Persistence(message(error)))?
            .filter(|projection| {
                !projection.session.archived
                    && projection.root_turn.as_ref().is_some_and(|turn| {
                        turn.invocation.turn_id == self.turn
                            && turn.state.terminal_outcome().is_none()
                    })
            })
            .ok_or_else(|| failed("Browser attachment turn is no longer active"))?;
        let configuration = maka_agent_authority::permissions::resolve_session(projection.session)
            .map_err(|error| ToolError::Persistence(message(error)))?
            .configuration;
        if configuration.permission_basis() != self.basis {
            return Err(failed("Browser permission boundary changed"));
        }
        if configuration.permissions.access == WorkspaceAccess::ReadOnly {
            return Err(failed("Explore mode does not allow Computer Use"));
        }
        if configuration
            .tools
            .as_ref()
            .is_some_and(|tools| !tools.iter().any(|tool| tool == "cua_repl"))
        {
            return Err(failed(
                "Computer Use tool is outside the current Session ceiling",
            ));
        }
        let grant = store
            .client_capability_grant(&self.session, &api::target())
            .await
            .map_err(|error| ToolError::Persistence(message(error)))?;
        if grant.is_none_or(|grant| grant.basis != Some(self.basis)) {
            return Err(failed("Computer Use Session grant is missing or revoked"));
        }
        if store
            .browser_origin_decision(&self.session, &target(origin.to_owned()), &self.basis)
            .await
            .map_err(|error| ToolError::Persistence(message(error)))?
            != Some(Decision::Allow)
        {
            return Err(failed("Browser site access has not been granted"));
        }
        Ok(configuration)
    }
}
impl BrowserAttachmentAuthorization for Attachment {
    fn check(
        &self,
        origin: BrowserAttachmentOrigin,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let attachment = self.clone();
        Box::pin(async move {
            let owner = attachment.alive(&cancellation)?;
            let BrowserAttachmentOrigin::Site(origin) = origin else {
                return Err(failed(
                    "Browser clipboard requires a non-opaque HTTP(S) origin",
                ));
            };
            let url = url::Url::parse(&origin).map_err(failed)?;
            if !matches!(url.scheme(), "http" | "https") {
                return Err(failed("Browser clipboard requires an HTTP(S) origin"));
            }
            let origin = url.origin().ascii_serialization();
            let configuration = attachment.current(&owner, &origin).await?;
            network_allowed(&configuration, &origin).await?;
            // Filesystem policy observation can await. Re-read the actual Turn,
            // binding and grants before the bridge's final document fence.
            attachment.current(&owner, &origin).await?;
            attachment.alive(&cancellation)?;
            Ok(())
        })
    }
}

fn target(origin: String) -> GrantTarget {
    GrantTarget {
        capability: GrantCapability::Browser,
        scope: GrantScope::BrowserOrigin { origin },
        ..api::target()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_api::contract::{Workspace, WorkspacePermissions};
    use maka_agent_facts::{
        event::{EventWrite, Fact, Invocation, InvocationInput, InvocationOutcome, RuntimeEvent},
        interaction::{InteractionOutcome, InteractionRecord, InteractionRequest},
        workspace::BindingStamp,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    const ORIGIN: &str = "https://clipboard.example";

    struct Fixture {
        _directory: tempfile::TempDir,
        owner: Arc<Computer>,
        store: maka_event_log::SessionStore,
        invocation: Invocation,
        attachment: Attachment,
    }
    impl Fixture {
        async fn new() -> Self {
            let directory = tempfile::tempdir().unwrap();
            let workspace_path = directory.path().join("workspace");
            std::fs::create_dir(&workspace_path).unwrap();
            let private = directory.path().join("root");
            let control = directory.path().join("control");
            let root_owner = maka_event_log::root::RootOwner::create(
                &private,
                &maka_event_log::root::RootNamespaces {
                    ownership: directory.path().join("ownership"),
                    control: control.clone(),
                },
            )
            .unwrap();
            let root = Arc::new(
                maka_event_log::RootStore::open(Arc::new(root_owner))
                    .await
                    .unwrap(),
            );
            let (path, directory_identity) =
                maka_fs_tools::directory::capture(&workspace_path).unwrap();
            let opened = maka_fs_tools::directory::open(&path, &directory_identity).unwrap();
            let identity = maka_fs_tools::workspace::ensure_directory_identity(
                path.clone(),
                opened,
                private,
                control,
                None,
            )
            .await
            .unwrap();
            let workspace = Workspace {
                worktree: None,
                project_id: None,
                path: path.to_string_lossy().into_owned(),
                directory_identity,
                identity,
            };
            let reference = root
                .attach_workspace("fixture", &serde_json::to_value(workspace).unwrap())
                .await
                .unwrap();
            let basis = PermissionBasis {
                boundary_revision: 0,
                binding: BindingStamp {
                    id: reference.id,
                    permission_epoch: reference.permission_epoch_at_attach,
                },
            };
            let configuration = StoredSessionConfiguration {
                backend: None,
                collaboration_mode: Default::default(),
                tools: Some(vec!["cua_repl".into()]),
                title: "Clipboard authority fixture".into(),
                title_is_manual: false,
                labels: vec![],
                workspace: reference,
                permissions: WorkspacePermissions {
                    access: WorkspaceAccess::WorkspaceWrite,
                    request_permissions: false,
                },
                boundary_revision: 0,
            };
            let store = root
                .create_session("session", "fixture", &configuration, 1)
                .await
                .unwrap();
            let invocation = Invocation {
                session_id: "session".into(),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            };
            store
                .append(
                    &EventWrite::plain(RuntimeEvent::new(
                        invocation.clone(),
                        Fact::InvocationOpened {
                            configuration: None,
                            input: InvocationInput::Message {
                                source_messages: vec![],
                                content: "Fixture turn".into(),
                                request_fingerprint: None,
                            },
                        },
                    ))
                    .unwrap(),
                )
                .await
                .unwrap();
            let tasks = tokio_util::task::TaskTracker::new();
            let owner = Arc::new(Computer {
                store: root,
                configuration: Default::default(),
                sessions: sessions::Sessions::with_audio(false, tasks.clone()),
                resources: Arc::default(),
                stopping: CancellationToken::new(),
                tasks,
                origin: ToolOrigin::HostSdk {
                    package_id: "fixture".into(),
                    entry_id: "computer".into(),
                    activation: "fixture".into(),
                    parent: None,
                },
            });
            let attachment = Attachment {
                owner: Arc::downgrade(&owner),
                session: invocation.session_id.clone(),
                turn: invocation.turn_id.clone(),
                basis,
                gate: Arc::default(),
            };
            let fixture = Self {
                _directory: directory,
                owner,
                store,
                invocation,
                attachment,
            };
            fixture
                .decision("broad", api::target(), Decision::Allow, 2)
                .await;
            fixture
                .decision("site", target(ORIGIN.into()), Decision::Allow, 3)
                .await;
            fixture
        }

        async fn decision(&self, id: &str, target: GrantTarget, decision: Decision, time: u64) {
            let record = InteractionRecord {
                session_id: self.invocation.session_id.clone(),
                turn_id: self.invocation.turn_id.clone(),
                run_id: self.invocation.run_id.clone(),
                request_id: id.into(),
                created_at: time,
                request: InteractionRequest::ClientCapability {
                    tool_use_id: "fixture".into(),
                    target,
                    basis: Some(self.attachment.basis),
                },
                outcome: None,
            };
            self.store
                .establish_run_interaction(&self.invocation, &record)
                .await
                .unwrap();
            assert!(
                self.store
                    .commit_interaction_outcome(
                        id,
                        InteractionOutcome::ClientCapabilityDecision {
                            decision,
                            committed_at: time
                        }
                    )
                    .await
                    .unwrap()
                    .matches
            );
        }

        async fn check(&self) -> Result<(), ToolError> {
            self.attachment
                .check(
                    BrowserAttachmentOrigin::Site(ORIGIN.into()),
                    CancellationToken::new(),
                )
                .await
        }

        async fn end(&self) {
            self.store
                .append(
                    &EventWrite::plain(RuntimeEvent::new(
                        self.invocation.clone(),
                        Fact::InvocationEnded {
                            outcome: InvocationOutcome::Cancelled {
                                source: "fixture-stop".into(),
                            },
                        },
                    ))
                    .unwrap(),
                )
                .await
                .unwrap();
        }

        async fn close(self) {
            self.owner.stopping.cancel();
            self.owner.tasks.close();
            self.owner.tasks.wait().await;
            self.owner.resources.settle().await.unwrap();
            self.owner.sessions.close().await.unwrap();
            self.owner.store.shutdown().await.unwrap();
        }
    }

    #[tokio::test]
    async fn attachment_uses_current_session_grants_without_retaining_a_cell() {
        let fixture = Fixture::new().await;
        let through = fixture
            .store
            .session_projection::<StoredSessionConfiguration>("session")
            .await
            .unwrap()
            .unwrap()
            .through_sequence;
        fixture.check().await.unwrap();
        // A second cell in this logical Turn uses the same attachment; there is
        // no original Scope, CellContext or execution lease in the checker.
        fixture.check().await.unwrap();
        let after = fixture
            .store
            .session_projection::<StoredSessionConfiguration>("session")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            after.through_sequence, through,
            "checks cannot add Agent T1 facts"
        );
        assert!(
            after.pending_interactions.is_empty(),
            "checks cannot elicit permission"
        );
        let denied = fixture
            .attachment
            .check(
                BrowserAttachmentOrigin::Site("https://other.example".into()),
                CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(
            matches!(denied, ToolError::Failed(message) if message == "Browser site access has not been granted")
        );
        fixture
            .decision("site-denied", target(ORIGIN.into()), Decision::Deny, 4)
            .await;
        assert!(
            matches!(fixture.check().await, Err(ToolError::Failed(message)) if message == "Browser site access has not been granted")
        );
        fixture.close().await;
    }

    #[tokio::test]
    async fn attachment_rejects_opaque_origins_and_observed_permission_basis_changes() {
        let fixture = Fixture::new().await;
        assert!(
            matches!(fixture.attachment.check(BrowserAttachmentOrigin::Opaque, CancellationToken::new()).await,
            Err(ToolError::Failed(message)) if message == "Browser clipboard requires a non-opaque HTTP(S) origin")
        );
        let revision = fixture
            .store
            .get_session::<StoredSessionConfiguration>("session")
            .await
            .unwrap()
            .unwrap()
            .revision;
        let changed = fixture
            .store
            .update_session_permissions::<StoredSessionConfiguration, _>(
                "session",
                revision,
                5,
                |configuration| {
                    configuration.boundary_revision += 1;
                    Ok(())
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            changed,
            maka_event_log::sessions::SessionMutation::Committed(_)
        ));
        assert!(
            matches!(fixture.check().await, Err(ToolError::Failed(message)) if message == "Browser permission boundary changed")
        );
        fixture.close().await;
    }

    #[tokio::test]
    async fn stop_and_reset_close_new_attachment_work_but_drain_the_accepted_reply() {
        let fixture = Fixture::new().await;
        fixture.check().await.unwrap();
        let host = admission::host_effects(&fixture.owner, fixture.attachment.gate.clone());
        let started = CancellationToken::new();
        let release = CancellationToken::new();
        let replies = Arc::new(AtomicUsize::new(0));
        host.spawn(Box::pin({
            let started = started.clone();
            let release = release.clone();
            let replies = replies.clone();
            async move {
                started.cancel();
                release.cancelled().await;
                replies.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }))
        .unwrap();
        started.cancelled().await;
        fixture.end().await;
        assert!(
            matches!(fixture.check().await, Err(ToolError::Failed(message)) if message == "Browser attachment turn is no longer active")
        );
        fixture.attachment.gate.close_admission();
        assert!(
            matches!(fixture.check().await, Err(ToolError::Failed(message)) if message == "Computer VM has retired")
        );
        let refused_polls = Arc::new(AtomicUsize::new(0));
        let refused = refused_polls.clone();
        assert!(matches!(host.spawn(Box::pin(async move {
            refused.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })), Err(ToolError::Failed(message)) if message == "Computer VM has retired"));
        assert_eq!(refused_polls.load(Ordering::SeqCst), 0);
        assert!(!fixture.owner.resources.is_idle());
        assert_eq!(replies.load(Ordering::SeqCst), 0);
        release.cancel();
        fixture.owner.resources.settle().await.unwrap();
        assert_eq!(replies.load(Ordering::SeqCst), 1);

        let replacement = Invocation {
            turn_id: "replacement-turn".into(),
            run_id: "replacement-run".into(),
            invocation_id: "replacement-invocation".into(),
            ..fixture.invocation.clone()
        };
        fixture
            .store
            .append(
                &EventWrite::plain(RuntimeEvent::new(
                    replacement.clone(),
                    Fact::InvocationOpened {
                        configuration: None,
                        input: InvocationInput::Message {
                            source_messages: vec![],
                            content: "Replacement turn".into(),
                            request_fingerprint: None,
                        },
                    },
                ))
                .unwrap(),
            )
            .await
            .unwrap();
        let old_turn = Attachment {
            gate: Arc::default(),
            ..fixture.attachment.clone()
        };
        assert!(
            matches!(old_turn.check(BrowserAttachmentOrigin::Site(ORIGIN.into()), CancellationToken::new()).await,
            Err(ToolError::Failed(message)) if message == "Browser attachment turn is no longer active")
        );
        let current = Attachment {
            turn: replacement.turn_id,
            gate: Arc::default(),
            ..fixture.attachment.clone()
        };
        current
            .check(
                BrowserAttachmentOrigin::Site(ORIGIN.into()),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        fixture.close().await;
    }
}
