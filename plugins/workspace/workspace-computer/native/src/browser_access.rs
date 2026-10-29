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
    BrowserAuthorization, BrowserDocument, BrowserSessionPreparation,
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
    preparation: PreparationScope,
}

#[derive(Clone)]
pub(super) struct PreparationScope {
    pub epoch: Arc<sessions::Epoch>,
    pub operation: String,
    /// Cancelled when the actual original native future becomes terminal.
    /// Retained already-written replies have separate settlement custody.
    pub active: CancellationToken,
}

impl Access {
    pub fn new(
        owner: Arc<Computer>,
        call: Scope,
        basis: PermissionBasis,
        cell: maka_code_runtime::CellContext,
        producer: CancellationToken,
        gate: Arc<admission::Gate>,
        preparation: PreparationScope,
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
            preparation,
        })
    }

    pub(super) fn popup_attachment(&self) -> Arc<Attachment> {
        self.attachment.clone()
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
    async fn session_preparation(
        &self,
        preparation: &BrowserSessionPreparation,
        cancellation: &CancellationToken,
        record: bool,
    ) -> Result<(), ToolError> {
        if self.preparation.active.is_cancelled() {
            return Err(failed("Browser session preparation operation has finished"));
        }
        if cancellation.is_cancelled() || self.producer.is_cancelled() {
            return Err(failed("Browser session preparation cancelled"));
        }
        let invocation =
            self.call.identity.agent().ok_or_else(|| {
                failed("Browser session preparation requires an Agent invocation")
            })?;
        // This is the actual per-command native/journal operation captured by
        // evaluate, distinct from the enclosing tool invocation's operation.
        let operation = self.preparation.operation.as_str();
        preparation.check_scope(&invocation.turn_id, operation)?;
        // Check the original execution/tool ceiling as well as the retained
        // attachment's current turn/global grant. Neither proves tab ownership.
        access::granted(&self.owner, &self.call, self.basis).await?;
        let (configuration, _) = access::current(&self.owner, &self.call, "cua_repl").await?;
        if configuration.permission_basis() != self.basis {
            return Err(failed("Browser permission boundary changed"));
        }
        self.attachment
            .session_preparation_current(preparation, operation, cancellation)
            .await?;
        if self.preparation.active.is_cancelled() {
            return Err(failed("Browser session preparation operation has finished"));
        }
        if record {
            // Register potential cleanup responsibility before the native
            // future is polled; this receipt is not a claim/effect-success proof.
            self.preparation.epoch.record_browser_preparation(
                self.basis,
                &invocation.turn_id,
                self.attachment.gate.clone(),
            )?;
        }
        Ok(())
    }

    async fn history_current(
        &self,
        request: &BrowserSessionPreparation,
        cancellation: &CancellationToken,
    ) -> Result<ResolvedConfiguration, ToolError> {
        if request.target != maka_computer_use::BrowserPreparationTarget::SessionHistory {
            return Err(failed(
                "Browser history requires its exact session-history purpose",
            ));
        }
        self.session_preparation(request, cancellation, false)
            .await?;
        let (configuration, _) = access::current(&self.owner, &self.call, "cua_repl").await?;
        if configuration.permission_basis() != self.basis {
            return Err(failed("Browser history permission boundary changed"));
        }
        Ok(configuration)
    }

    async fn download_targets(
        &self,
        document: &BrowserDocument,
        source_origin: &BrowserAttachmentOrigin,
        url: &str,
        cancellation: &CancellationToken,
    ) -> Result<(ResolvedConfiguration, Vec<GrantTarget>), ToolError> {
        let (configuration, page) = self
            .current(
                &BrowserAccess::ReadDocument {
                    document: document.clone(),
                    origin: source_origin.clone(),
                },
                cancellation,
            )
            .await?;
        let destination = BrowserAccess::Download {
            document: document.clone(),
            source_origin: source_origin.clone(),
            url: url.to_owned(),
        }
        .origin()?
        .ok_or_else(|| failed("Browser download requires an HTTP(S) download origin"))?;
        network_allowed(&configuration, &destination).await?;
        if cancellation.is_cancelled() || self.producer.is_cancelled() {
            return Err(failed("Browser authorization cancelled"));
        }
        let mut targets = Vec::new();
        if let Some(page) = page {
            let GrantScope::BrowserOrigin { origin } = &page.scope else {
                unreachable!("current browser authorization returns an origin target");
            };
            targets.push(download_target(origin.clone()));
            targets.insert(0, page);
        }
        if !targets.iter().any(|target| target.capability == GrantCapability::BrowserDownload
            && matches!(&target.scope, GrantScope::BrowserOrigin { origin } if origin == &destination)) {
            targets.push(download_target(destination));
        }
        Ok((configuration, targets))
    }

    async fn check_target(&self, target: &GrantTarget) -> Result<(), ToolError> {
        if access::browser_decision(&self.owner, &self.call, self.basis, target).await?
            != Some(Decision::Allow)
        {
            return Err(failed(format!(
                "{} access has not been granted",
                if target.capability == GrantCapability::BrowserDownload {
                    "Browser file download"
                } else {
                    "Browser site"
                }
            )));
        }
        Ok(())
    }

    async fn check_download(
        &self,
        document: &BrowserDocument,
        source_origin: &BrowserAttachmentOrigin,
        url: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        let (_, targets) = self
            .download_targets(document, source_origin, url, cancellation)
            .await?;
        for target in &targets {
            self.check_target(target).await?;
        }
        if cancellation.is_cancelled() || self.producer.is_cancelled() {
            return Err(failed("Browser authorization cancelled"));
        }
        Ok(())
    }

    async fn approve_download(
        &self,
        document: &BrowserDocument,
        source_origin: &BrowserAttachmentOrigin,
        url: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        let (_, targets) = self
            .download_targets(document, source_origin, url, cancellation)
            .await?;
        for (index, target) in targets.iter().enumerate() {
            let (configuration, _) = self
                .download_targets(document, source_origin, url, cancellation)
                .await?;
            for prior in &targets[..index] {
                self.check_target(prior).await?;
            }
            access::approve_target(
                &self.owner,
                &self.call,
                &configuration,
                cancellation,
                target.clone(),
                Some(&self.cell),
            )
            .await?;
        }
        // A later origin prompt can span revocation of an earlier consent.
        self.check_download(document, source_origin, url, cancellation)
            .await
    }
}

impl BrowserAuthorization for Access {
    fn authorize_session_preparation(
        &self,
        preparation: BrowserSessionPreparation,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let access = self.clone();
        Box::pin(async move {
            access
                .session_preparation(&preparation, &cancellation, true)
                .await
        })
    }

    fn check_session_preparation(
        &self,
        preparation: BrowserSessionPreparation,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let access = self.clone();
        Box::pin(async move {
            access
                .session_preparation(&preparation, &cancellation, false)
                .await
        })
    }

    fn authorize_history(
        &self,
        request: BrowserSessionPreparation,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let access = self.clone();
        Box::pin(async move {
            let child = cancellation.child_token();
            let authorization = async {
                let configuration = access.history_current(&request, &child).await?;
                access::approve_target(
                    &access.owner,
                    &access.call,
                    &configuration,
                    &child,
                    history_target(&request),
                    Some(&access.cell),
                )
                .await?;
                access.history_current(&request, &child).await?;
                access::granted_target(
                    &access.owner,
                    &access.call,
                    access.basis,
                    &history_target(&request),
                )
                .await
            };
            tokio::pin!(authorization);
            tokio::select! {
                result = &mut authorization => result,
                () = access.producer.cancelled() => { child.cancel(); authorization.await },
            }
        })
    }
    fn check_history(
        &self,
        request: BrowserSessionPreparation,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let access = self.clone();
        Box::pin(async move {
            access.history_current(&request, &cancellation).await?;
            access::granted_target(
                &access.owner,
                &access.call,
                access.basis,
                &history_target(&request),
            )
            .await
        })
    }

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
                match &browser {
                    BrowserAccess::PageAssetDownload {
                        document,
                        source_origin,
                    } => {
                        return access
                            .approve_download(document, source_origin, &document.url, &child)
                            .await;
                    }
                    BrowserAccess::PageAssetFallbackFetch {
                        document,
                        source_origin,
                        url,
                    } => {
                        return access
                            .approve_download(
                                document,
                                source_origin,
                                &asset_fallback_url(document, url)?,
                                &child,
                            )
                            .await;
                    }
                    _ => {}
                }
                if let BrowserAccess::Download {
                    document,
                    source_origin,
                    url,
                } = &browser
                {
                    return access
                        .approve_download(document, source_origin, url, &child)
                        .await;
                }
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
            match &browser {
                BrowserAccess::PageAssetDownload {
                    document,
                    source_origin,
                } => {
                    return access
                        .check_download(document, source_origin, &document.url, &cancellation)
                        .await;
                }
                BrowserAccess::PageAssetFallbackFetch {
                    document,
                    source_origin,
                    url,
                } => {
                    return access
                        .check_download(
                            document,
                            source_origin,
                            &asset_fallback_url(document, url)?,
                            &cancellation,
                        )
                        .await;
                }
                _ => {}
            }
            if let BrowserAccess::Download {
                document,
                source_origin,
                url,
            } = &browser
            {
                return access
                    .check_download(document, source_origin, url, &cancellation)
                    .await;
            }
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

async fn workspace_network(configuration: &ResolvedConfiguration) -> Result<Network, ToolError> {
    let workspace = configuration.workspace.clone();
    tokio::task::spawn_blocking(move || {
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
        Ok::<_, ToolError>(network)
    })
    .await
    .map_err(failed)?
}

pub(super) async fn network_allowed(
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
    if !workspace_network(configuration).await?.allows(&destination) {
        return Err(failed(
            "Workspace network policy does not allow this browser site",
        ));
    }
    Ok(())
}

/// A Host attachment checks canonical authority without retaining an Agent Run.
/// This is Maka admission policy, not an extra permission prompt in the original bridge.
#[derive(Clone)]
pub(super) struct Attachment {
    owner: std::sync::Weak<Computer>,
    session: String,
    turn: String,
    basis: PermissionBasis,
    gate: Arc<admission::Gate>,
}
impl Attachment {
    pub(super) fn session(&self) -> &str {
        &self.session
    }
    pub(super) fn turn(&self) -> &str {
        &self.turn
    }
    pub(super) fn basis(&self) -> PermissionBasis {
        self.basis
    }

    pub(super) fn alive(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Arc<Computer>, ToolError> {
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

    pub(super) async fn current_global(
        &self,
        owner: &Computer,
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
        Ok(configuration)
    }

    pub(super) async fn effect_preparation_current(
        &self,
        binding: &maka_computer_use::BrowserPreparationBinding,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        binding.check_turn(&self.turn)?;
        let owner = self.alive(cancellation)?;
        self.gate.check_open()?;
        let configuration = self.current_global(&owner).await?;
        if workspace_network(&configuration).await? != Network::Allowed {
            return Err(failed(
                "Workspace network policy cannot admit native session preparation",
            ));
        }
        self.alive(cancellation)?;
        self.gate.check_open()
    }

    pub(super) async fn session_preparation_current(
        &self,
        preparation: &BrowserSessionPreparation,
        operation: &str,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        preparation.check_scope(&self.turn, operation)?;
        let owner = self.alive(cancellation)?;
        self.gate.check_open()?;
        let configuration = self.current_global(&owner).await?;
        // Fixed native helpers can use the current/replacement document's
        // favicon/session network. A prior URL cannot confine those effects.
        // Keep the existing workspace identity and second network ceiling;
        // a restricted ceiling cannot admit this unbounded native helper.
        if workspace_network(&configuration).await? != Network::Allowed {
            return Err(failed(
                "Workspace network policy cannot admit native session preparation",
            ));
        }
        self.alive(cancellation)?;
        self.gate.check_open()
    }

    pub(super) async fn current(
        &self,
        owner: &Computer,
        origin: &str,
    ) -> Result<ResolvedConfiguration, ToolError> {
        let configuration = self.current_global(owner).await?;
        let store = owner
            .store
            .session(&self.session)
            .await
            .map_err(|error| ToolError::Persistence(message(error)))?;
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
    fn check_metadata(&self, cancellation: CancellationToken) -> AuthorizationFuture {
        let attachment = self.clone();
        Box::pin(async move {
            let owner = attachment.alive(&cancellation)?;
            attachment.current_global(&owner).await?;
            attachment.alive(&cancellation)?;
            Ok(())
        })
    }

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

pub(super) fn target(origin: String) -> GrantTarget {
    GrantTarget {
        capability: GrantCapability::Browser,
        scope: GrantScope::BrowserOrigin { origin },
        ..api::target()
    }
}

fn history_target(request: &BrowserSessionPreparation) -> GrantTarget {
    GrantTarget {
        capability: GrantCapability::BrowserHistory,
        scope: GrantScope::BrowserProfile {
            browser_id: request.browser_id.clone(),
            generation: request.generation.clone(),
        },
        ..api::target()
    }
}

fn download_target(origin: String) -> GrantTarget {
    GrantTarget {
        capability: GrantCapability::BrowserDownload,
        scope: GrantScope::BrowserOrigin { origin },
        ..api::target()
    }
}

// Same-origin and non-network page fetches reuse the initial page decision.
// Cross-origin HTTP(S) fallback requires its independent destination download.
fn asset_fallback_url(document: &BrowserDocument, url: &str) -> Result<String, ToolError> {
    match url::Url::parse(url).ok().as_ref().map(url::Url::scheme) {
        Some("http" | "https") => Ok(url.to_owned()),
        Some("file") => Err(failed(
            "The current Host browser policy does not allow file asset transfers",
        )),
        _ => Ok(document.url.clone()),
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
            Self::new_with_global_grant(true).await
        }

        async fn new_with_global_grant(global_grant: bool) -> Self {
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
                compaction_prompt: None,
                collaboration_mode: Default::default(),
                tools: Some(vec!["cua_repl".into()]),
                title: "Clipboard authority fixture".into(),
                title_is_manual: false,
                pinned: false,
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
                popup_provenance: None,
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
            if global_grant {
                fixture
                    .decision("broad", api::target(), Decision::Allow, 2)
                    .await;
            }
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
        let native_owner =
            maka_computer_use::SessionOwner::new(fixture.owner.sessions.driver.clone());
        let native = Arc::new(tokio::sync::Mutex::new(native_owner.new_epoch().unwrap()));
        let host =
            admission::host_effects(&fixture.owner, fixture.attachment.gate.clone(), &native);
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

    #[tokio::test]
    async fn opaque_presentation_checks_current_global_authority_without_loosening_site_or_clipboard_rules()
     {
        let fixture = Fixture::new().await;
        fixture
            .decision("site-denied", target(ORIGIN.into()), Decision::Deny, 4)
            .await;
        assert!(
            fixture.check().await.is_err(),
            "Site revocation must still reject Site presentation"
        );
        assert!(
            fixture
                .attachment
                .check(BrowserAttachmentOrigin::Opaque, CancellationToken::new())
                .await
                .is_err(),
            "opaque clipboard permission must remain refused"
        );
        fixture
            .attachment
            .check_metadata(CancellationToken::new())
            .await
            .unwrap();
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
            matches!(fixture.attachment.check_metadata(CancellationToken::new()).await,
            Err(ToolError::Failed(message)) if message == "Browser permission boundary changed")
        );
        fixture.end().await;
        assert!(
            matches!(fixture.attachment.check_metadata(CancellationToken::new()).await, Err(ToolError::Failed(message)) if message == "Browser attachment turn is no longer active")
        );
        fixture.close().await;
    }
    #[tokio::test]
    async fn natural_popup_navigation_does_not_grant_destination_content_for_none_or_deny() {
        let fixture = Fixture::new().await;
        let destination = "https://unread-destination.example";
        let document = BrowserDocument {
            browser_id: "fixture".into(),
            generation: "generation".into(),
            tab_id: "17".into(),
            url: "about:blank".into(),
        };
        let scope = super::super::browser_popup::Authorization::new(
            Arc::new(fixture.attachment.clone()),
            "fixture".into(),
            format!("{destination}/popup"),
        );
        let navigation = BrowserAccess::Navigate {
            document: document.clone(),
            url: format!("{destination}/popup"),
        };
        let read = BrowserAccess::ReadDocument {
            document: document.clone(),
            origin: BrowserAttachmentOrigin::Site(destination.into()),
        };
        assert_eq!(
            fixture
                .store
                .browser_origin_decision(
                    "session",
                    &target(destination.into()),
                    &fixture.attachment.basis
                )
                .await
                .unwrap(),
            None
        );
        scope
            .authorize(navigation.clone(), CancellationToken::new())
            .await
            .unwrap();
        assert!(
            scope
                .check(read.clone(), CancellationToken::new())
                .await
                .is_err()
        );
        assert_eq!(
            fixture
                .store
                .browser_origin_decision(
                    "session",
                    &target(destination.into()),
                    &fixture.attachment.basis
                )
                .await
                .unwrap(),
            None,
            "physical page navigation must not manufacture a Site Allow"
        );
        fixture
            .decision(
                "destination-denied",
                target(destination.into()),
                Decision::Deny,
                4,
            )
            .await;
        scope
            .authorize(navigation.clone(), CancellationToken::new())
            .await
            .unwrap();
        assert!(scope.check(read, CancellationToken::new()).await.is_err());
        assert_eq!(
            fixture
                .store
                .browser_origin_decision(
                    "session",
                    &target(destination.into()),
                    &fixture.attachment.basis
                )
                .await
                .unwrap(),
            Some(Decision::Deny)
        );
        scope
            .check(
                BrowserAccess::ReadDocument {
                    document,
                    origin: BrowserAttachmentOrigin::Opaque,
                },
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(
            scope
                .attachment()
                .unwrap()
                .check(BrowserAttachmentOrigin::Opaque, CancellationToken::new())
                .await
                .is_err(),
            "global opaque preparation does not grant clipboard access"
        );
        fixture.end().await;
        assert!(
            scope
                .authorize(navigation, CancellationToken::new())
                .await
                .is_err()
        );
        fixture.close().await;
    }

    #[tokio::test]
    async fn queued_popup_native_lock_observes_real_turn_end_or_source_scope_retirement() {
        for end_turn in [true, false] {
            let fixture = Fixture::new().await;
            let native = Arc::new(tokio::sync::Mutex::new(maka_computer_use::Session::new(
                fixture.owner.sessions.driver.clone(),
            )));
            let held = native.lock().await;
            let cancellation = CancellationToken::new();
            {
                let waiting = super::super::browser_popup::wait_native_current(
                    &fixture.owner,
                    &native,
                    &fixture.attachment,
                    &fixture.attachment.gate,
                    &cancellation,
                );
                tokio::pin!(waiting);
                assert!(futures_util::poll!(waiting.as_mut()).is_pending());
                if end_turn {
                    fixture.end().await;
                } else {
                    fixture.attachment.gate.close_admission();
                }
                let result = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
                    .await
                    .expect("canonical revocation wakes a queued service without the native lock");
                assert!(
                    result.is_err(),
                    "retired source cannot acquire the native service lock"
                );
                assert!(
                    native.try_lock().is_err(),
                    "the original lock is still held; this is not a fake drain"
                );
            }
            drop(held);
            drop(native);
            fixture.close().await;
        }
    }
    fn session_preparation_request(turn: &str) -> BrowserSessionPreparation {
        BrowserSessionPreparation {
            native_owner: uuid::Uuid::new_v4(),
            native_epoch: "native-observation".into(),
            browser_id: "native-browser".into(),
            generation: "native-generation".into(),
            turn_id: turn.into(),
            operation_id: "session-preparation-operation".into(),
            target: maka_computer_use::BrowserPreparationTarget::ReservedTab {
                tab_id: "17".into(),
            },
        }
    }

    #[tokio::test]
    async fn fixed_session_admission_never_grants_replacement_site_or_clipboard() {
        for denied in [false, true] {
            let fixture = Fixture::new().await;
            let destination = "https://replacement.example";
            if denied {
                fixture
                    .decision(
                        "replacement-denied",
                        target(destination.into()),
                        Decision::Deny,
                        4,
                    )
                    .await;
            }
            let request = session_preparation_request(&fixture.invocation.turn_id);
            let before = fixture
                .store
                .session_projection::<StoredSessionConfiguration>("session")
                .await
                .unwrap()
                .unwrap()
                .through_sequence;
            fixture
                .attachment
                .session_preparation_current(
                    &request,
                    &request.operation_id,
                    &CancellationToken::new(),
                )
                .await
                .unwrap();
            assert!(
                fixture
                    .attachment
                    .check(
                        BrowserAttachmentOrigin::Site(destination.into()),
                        CancellationToken::new()
                    )
                    .await
                    .is_err(),
                "mechanical admission must not grant replacement content"
            );
            assert!(
                fixture
                    .attachment
                    .check(BrowserAttachmentOrigin::Opaque, CancellationToken::new())
                    .await
                    .is_err(),
                "opaque mechanical admission is not clipboard permission"
            );
            let after = fixture
                .store
                .session_projection::<StoredSessionConfiguration>("session")
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                after.through_sequence, before,
                "mechanical checks add no Allow or fake T1 facts"
            );
            assert!(after.pending_interactions.is_empty());
            fixture.close().await;
        }
    }

    #[tokio::test]
    async fn fixed_session_admission_rechecks_canonical_basis_turn_and_vm_gate() {
        for changed in ["basis", "turn", "gate", "cancel"] {
            let fixture = Fixture::new().await;
            let request = session_preparation_request(&fixture.invocation.turn_id);
            let cancellation = CancellationToken::new();
            fixture
                .attachment
                .session_preparation_current(&request, &request.operation_id, &cancellation)
                .await
                .unwrap();
            match changed {
                "basis" => {
                    let revision = fixture
                        .store
                        .get_session::<StoredSessionConfiguration>("session")
                        .await
                        .unwrap()
                        .unwrap()
                        .revision;
                    let result = fixture
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
                        result,
                        maka_event_log::sessions::SessionMutation::Committed(_)
                    ));
                }
                "turn" => fixture.end().await,
                "gate" => fixture.attachment.gate.close_admission(),
                "cancel" => cancellation.cancel(),
                _ => unreachable!(),
            }
            assert!(
                fixture
                    .attachment
                    .session_preparation_current(&request, &request.operation_id, &cancellation)
                    .await
                    .is_err(),
                "{changed} must reject before further fixed preparation"
            );
            fixture.close().await;
        }
    }
    fn effect_preparation_binding(turn: &str) -> maka_computer_use::BrowserPreparationBinding {
        // Observations for permission testing only. This fixture deliberately
        // grants no native ownership: production's independent ledger must do so.
        maka_computer_use::BrowserPreparationBinding {
            native_owner: uuid::Uuid::new_v4(),
            native_epoch: "observation-epoch".into(),
            browser_id: "observation-browser".into(),
            generation: "observation-generation".into(),
            turn_id: turn.into(),
            tab_id: "17".into(),
            subject: maka_capabilities::computer::BrowserLeaseSubject::PhysicalClaim {
                claim_id: "observation-claim".into(),
            },
        }
    }

    #[tokio::test]
    async fn actual_host_service_ticket_mints_scoped_permission_until_its_real_future_ends() {
        let fixture = Fixture::new().await;
        let native_owner =
            maka_computer_use::SessionOwner::new(fixture.owner.sessions.driver.clone());
        let native = Arc::new(tokio::sync::Mutex::new(native_owner.new_epoch().unwrap()));
        let effects = admission::host_effects_with_lease_children(
            &fixture.owner,
            fixture.attachment.gate.clone(),
            &native,
            Arc::new(fixture.attachment.clone()),
        );
        let (sent, received) = tokio::sync::oneshot::channel();
        let release = CancellationToken::new();
        let worker_release = release.clone();
        let resources = fixture.owner.resources.clone();
        effects
            .spawn_scoped_guarded(
                Box::new(move |scope| {
                    assert!(
                        !resources.is_idle(),
                        "the real Host ticket starts before the factory is invoked"
                    );
                    Box::pin(async move {
                        sent.send(scope)
                            .unwrap_or_else(|_| panic!("scope observer disappeared"));
                        worker_release.cancelled().await;
                        Ok(())
                    })
                }),
                Box::new(|_| panic!("local admission unexpectedly rejected")),
            )
            .unwrap();
        let scope = received.await.unwrap();
        let binding = effect_preparation_binding(&fixture.invocation.turn_id);
        scope
            .check_session_preparation(binding.clone(), CancellationToken::new())
            .await
            .unwrap();
        assert!(
            fixture
                .attachment
                .check(
                    BrowserAttachmentOrigin::Site("https://replacement.example".into()),
                    CancellationToken::new()
                )
                .await
                .is_err(),
            "service preparation does not grant replacement content"
        );
        release.cancel();
        fixture.owner.resources.settle().await.unwrap();
        assert!(
            matches!(scope.check_session_preparation(binding, CancellationToken::new()).await,
            Err(ToolError::Failed(message)) if message == "Browser service effect has finished")
        );
        fixture.close().await;
    }

    #[tokio::test]
    async fn actual_host_service_revoke_blocks_new_checks_but_keeps_original_started_ticket_pending()
     {
        let fixture = Fixture::new().await;
        let native_owner =
            maka_computer_use::SessionOwner::new(fixture.owner.sessions.driver.clone());
        let native = Arc::new(tokio::sync::Mutex::new(native_owner.new_epoch().unwrap()));
        let effects = admission::host_effects_with_lease_children(
            &fixture.owner,
            fixture.attachment.gate.clone(),
            &native,
            Arc::new(fixture.attachment.clone()),
        );
        let (sent, received) = tokio::sync::oneshot::channel();
        let release = CancellationToken::new();
        let worker_release = release.clone();
        effects
            .spawn_scoped_guarded(
                Box::new(move |scope| {
                    Box::pin(async move {
                        sent.send(scope)
                            .unwrap_or_else(|_| panic!("scope observer disappeared"));
                        worker_release.cancelled().await;
                        Ok(())
                    })
                }),
                Box::new(|_| panic!("local admission unexpectedly rejected")),
            )
            .unwrap();
        let scope = received.await.unwrap();
        let binding = effect_preparation_binding(&fixture.invocation.turn_id);
        scope
            .check_session_preparation(binding.clone(), CancellationToken::new())
            .await
            .unwrap();
        let revision = fixture
            .store
            .get_session::<StoredSessionConfiguration>("session")
            .await
            .unwrap()
            .unwrap()
            .revision;
        assert!(matches!(
            fixture
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
                .unwrap(),
            maka_event_log::sessions::SessionMutation::Committed(_)
        ));
        assert!(
            scope
                .check_session_preparation(binding, CancellationToken::new())
                .await
                .is_err()
        );
        let mut settlement = Box::pin(fixture.owner.resources.settle());
        assert!(
            futures_util::poll!(&mut settlement).is_pending(),
            "authority revoke is not the original future terminal"
        );
        release.cancel();
        settlement.await.unwrap();
        fixture.close().await;
    }
    fn session_inventory_request(turn: &str) -> BrowserSessionPreparation {
        // These are routing observations for Host current-authority tests.
        // No actual Native owner/claim or dispatch proof is created here.
        let mut request = session_preparation_request(turn);
        request.target = maka_computer_use::BrowserPreparationTarget::SessionInventory;
        request
    }

    #[tokio::test]
    async fn session_inventory_current_host_check_preserves_site_and_interaction_state() {
        let fixture = Fixture::new().await;
        let request = session_inventory_request(&fixture.invocation.turn_id);
        let destination = "https://unread-inventory.example";
        let before = fixture
            .store
            .session_projection::<StoredSessionConfiguration>("session")
            .await
            .unwrap()
            .unwrap()
            .through_sequence;
        assert_eq!(
            fixture
                .store
                .browser_origin_decision(
                    "session",
                    &target(destination.into()),
                    &fixture.attachment.basis
                )
                .await
                .unwrap(),
            None
        );
        fixture
            .attachment
            .session_preparation_current(&request, &request.operation_id, &CancellationToken::new())
            .await
            .unwrap();
        assert!(
            fixture
                .attachment
                .check(
                    BrowserAttachmentOrigin::Site(destination.into()),
                    CancellationToken::new()
                )
                .await
                .is_err()
        );
        let after = fixture
            .store
            .session_projection::<StoredSessionConfiguration>("session")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            after.through_sequence, before,
            "a current Host check cannot change Site Allow or interaction state"
        );
        assert!(
            after.pending_interactions.is_empty(),
            "session inventory cannot request Site approval"
        );
        assert_eq!(
            fixture
                .store
                .browser_origin_decision(
                    "session",
                    &target(destination.into()),
                    &fixture.attachment.basis
                )
                .await
                .unwrap(),
            None
        );
        // Production Access records potential epoch cleanup before polling the
        // native future. This checker proves neither native admission nor T2.
        fixture.close().await;
    }

    #[tokio::test]
    async fn session_inventory_rechecks_actual_global_basis_turn_gate_and_operation() {
        for changed in ["global", "basis", "turn", "gate", "cancel", "operation"] {
            // A later Deny does not revoke an existing broad Allow. Exercise
            // genuinely absent Global authority in the same real DB fixture.
            let fixture = Fixture::new_with_global_grant(changed != "global").await;
            let request = session_inventory_request(&fixture.invocation.turn_id);
            let cancellation = CancellationToken::new();
            if changed != "global" {
                fixture
                    .attachment
                    .session_preparation_current(&request, &request.operation_id, &cancellation)
                    .await
                    .unwrap();
            } else {
                assert!(
                    fixture
                        .store
                        .client_capability_grant("session", &api::target())
                        .await
                        .unwrap()
                        .is_none()
                );
            }
            let expected = match changed {
                "global" => "Computer Use Session grant is missing or revoked",
                "basis" => {
                    let revision = fixture
                        .store
                        .get_session::<StoredSessionConfiguration>("session")
                        .await
                        .unwrap()
                        .unwrap()
                        .revision;
                    let result = fixture
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
                        result,
                        maka_event_log::sessions::SessionMutation::Committed(_)
                    ));
                    "Browser permission boundary changed"
                }
                "turn" => {
                    fixture.end().await;
                    "Browser attachment turn is no longer active"
                }
                "gate" => {
                    fixture.attachment.gate.close_admission();
                    "Computer VM has retired"
                }
                "cancel" => {
                    cancellation.cancel();
                    "Browser attachment cancelled"
                }
                "operation" => "Browser session preparation lost its captured native scope",
                _ => unreachable!(),
            };
            let operation = if changed == "operation" {
                "another-operation"
            } else {
                &request.operation_id
            };
            let error = fixture
                .attachment
                .session_preparation_current(&request, operation, &cancellation)
                .await
                .unwrap_err();
            assert!(
                matches!(error, ToolError::Failed(message) if message == expected),
                "{changed} did not reach its actual Host guard"
            );
            fixture.close().await;
        }
    }

    #[tokio::test]
    async fn non_agent_scope_and_legacy_authorizer_cannot_admit_session_inventory() {
        struct Legacy {
            ordinary_calls: Arc<AtomicUsize>,
        }
        impl BrowserAuthorization for Legacy {
            fn authorize(&self, _: BrowserAccess, _: CancellationToken) -> AuthorizationFuture {
                self.ordinary_calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    Err(failed("ordinary browser access is not session preparation"))
                })
            }
            fn check(
                &self,
                access: BrowserAccess,
                cancellation: CancellationToken,
            ) -> AuthorizationFuture {
                self.authorize(access, cancellation)
            }
        }
        let fixture = Fixture::new().await;
        let remote = maka_capabilities::call::Issuer::default()
            .issue(
                maka_capabilities::call::Identity::Remote {
                    request_id: uuid::Uuid::new_v4(),
                },
                CancellationToken::new(),
            )
            .unwrap();
        assert!(
            matches!(access::current(&fixture.owner, &remote, "cua_repl").await,
            Err(ToolError::Failed(message)) if message == "Computer Use requires an Agent invocation")
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let legacy = Legacy {
            ordinary_calls: calls.clone(),
        };
        let request = session_inventory_request(&fixture.invocation.turn_id);
        for result in [
            legacy
                .authorize_session_preparation(request.clone(), CancellationToken::new())
                .await,
            legacy
                .check_session_preparation(request, CancellationToken::new())
                .await,
        ] {
            assert!(matches!(result, Err(ToolError::Failed(message))
                if message == "Browser session preparation requires Host authorization"));
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "default session preparation cannot fall back to ordinary authorization"
        );
        remote.finish().await.unwrap();
        fixture.close().await;
    }

    fn fixed_ui_preparation_request(turn: &str) -> BrowserSessionPreparation {
        // Shape observations only: Main's separate native ledger must prove
        // that this scope names a real retained fixed-session receipt.
        let mut request = session_preparation_request(turn);
        request.target = maka_computer_use::BrowserPreparationTarget::FixedSessionTab {
            tab_id: "17".into(),
            scope_id: "observed-fixed-session-scope".into(),
        };
        request
    }

    fn fixed_ui_effect_binding(
        request: &BrowserSessionPreparation,
    ) -> maka_computer_use::BrowserPreparationBinding {
        let maka_computer_use::BrowserPreparationTarget::FixedSessionTab { tab_id, scope_id } =
            &request.target
        else {
            unreachable!("fixture requires a fixed-session target")
        };
        maka_computer_use::BrowserPreparationBinding {
            native_owner: request.native_owner,
            native_epoch: request.native_epoch.clone(),
            browser_id: request.browser_id.clone(),
            generation: request.generation.clone(),
            turn_id: request.turn_id.clone(),
            tab_id: tab_id.clone(),
            subject: maka_capabilities::computer::BrowserLeaseSubject::FixedSession {
                scope_id: scope_id.clone(),
            },
        }
    }

    #[tokio::test]
    async fn fixed_ui_current_checks_preserve_replacement_site_deny_and_actual_facts() {
        let fixture = Fixture::new().await;
        let destination = "https://fixed-ui-replacement.example";
        // This Site never had an Allow. A Deny here is not being mistaken for
        // revocation of an existing Allow; the source Site's Allow stays intact.
        fixture
            .decision(
                "fixed-ui-replacement-denied",
                target(destination.into()),
                Decision::Deny,
                4,
            )
            .await;
        let request = fixed_ui_preparation_request(&fixture.invocation.turn_id);
        let binding = fixed_ui_effect_binding(&request);
        assert_eq!(
            fixture
                .store
                .browser_origin_decision(
                    "session",
                    &target(destination.into()),
                    &fixture.attachment.basis
                )
                .await
                .unwrap(),
            Some(Decision::Deny)
        );
        let before = fixture
            .store
            .session_projection::<StoredSessionConfiguration>("session")
            .await
            .unwrap()
            .unwrap()
            .through_sequence;
        fixture
            .attachment
            .session_preparation_current(&request, &request.operation_id, &CancellationToken::new())
            .await
            .unwrap();
        fixture
            .attachment
            .effect_preparation_current(&binding, &CancellationToken::new())
            .await
            .unwrap();
        assert!(
            fixture
                .attachment
                .check(
                    BrowserAttachmentOrigin::Site(destination.into()),
                    CancellationToken::new()
                )
                .await
                .is_err(),
            "fixed UI purpose cannot authorize replacement content"
        );
        fixture.check().await.unwrap();
        assert_eq!(
            fixture
                .store
                .browser_origin_decision(
                    "session",
                    &target(destination.into()),
                    &fixture.attachment.basis
                )
                .await
                .unwrap(),
            Some(Decision::Deny)
        );
        let after = fixture
            .store
            .session_projection::<StoredSessionConfiguration>("session")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            after.through_sequence, before,
            "current checks preserve Site decisions and add no interaction"
        );
        assert!(after.pending_interactions.is_empty());
        // These are the real canonical permission checks only. A token/DTO is
        // not a native receipt, and no physical claim or Host effect is minted.
        fixture.close().await;
    }

    #[tokio::test]
    async fn fixed_ui_targets_recheck_real_global_basis_turn_gate_and_operation() {
        for changed in ["global", "basis", "turn", "gate", "cancel", "operation"] {
            let fixture = Fixture::new_with_global_grant(changed != "global").await;
            let request = fixed_ui_preparation_request(&fixture.invocation.turn_id);
            let binding = fixed_ui_effect_binding(&request);
            let cancellation = CancellationToken::new();
            if changed == "global" {
                assert!(
                    fixture
                        .store
                        .client_capability_grant("session", &api::target())
                        .await
                        .unwrap()
                        .is_none(),
                    "fixture starts without broad Allow"
                );
            } else {
                fixture
                    .attachment
                    .session_preparation_current(&request, &request.operation_id, &cancellation)
                    .await
                    .unwrap();
                fixture
                    .attachment
                    .effect_preparation_current(&binding, &cancellation)
                    .await
                    .unwrap();
            }
            let expected = match changed {
                "global" => "Computer Use Session grant is missing or revoked",
                "basis" => {
                    let revision = fixture
                        .store
                        .get_session::<StoredSessionConfiguration>("session")
                        .await
                        .unwrap()
                        .unwrap()
                        .revision;
                    let result = fixture
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
                        result,
                        maka_event_log::sessions::SessionMutation::Committed(_)
                    ));
                    "Browser permission boundary changed"
                }
                "turn" => {
                    fixture.end().await;
                    "Browser attachment turn is no longer active"
                }
                "gate" => {
                    fixture.attachment.gate.close_admission();
                    "Computer VM has retired"
                }
                "cancel" => {
                    cancellation.cancel();
                    "Browser attachment cancelled"
                }
                "operation" => "Browser session preparation lost its captured native scope",
                _ => unreachable!(),
            };
            let operation = if changed == "operation" {
                "another-operation"
            } else {
                &request.operation_id
            };
            let error = fixture
                .attachment
                .session_preparation_current(&request, operation, &cancellation)
                .await
                .unwrap_err();
            assert!(
                matches!(error, ToolError::Failed(message) if message == expected),
                "{changed} must reach the actual canonical request guard"
            );
            if changed != "operation" {
                let error = fixture
                    .attachment
                    .effect_preparation_current(&binding, &cancellation)
                    .await
                    .unwrap_err();
                assert!(
                    matches!(error, ToolError::Failed(message) if message == expected),
                    "{changed} must also reject the fixed-session effect binding"
                );
            }
            // An effect binding has no Agent operation field. Its operation
            // lifetime belongs to the existing actual Host effect scope/token;
            // this checker test cannot manufacture or prove that separate scope.
            fixture.close().await;
        }
    }
}
