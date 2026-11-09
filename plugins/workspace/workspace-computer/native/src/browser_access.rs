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

mod upload;
use maka_agent_api::{contract::WorkspaceAccess, session::ResolvedConfiguration};
use maka_agent_facts::interaction::{Decision, GrantCapability, GrantScope, GrantTarget};
use maka_computer_use::{
    AuthorizationFuture, BrowserAccess, BrowserAttachmentAuthorization, BrowserAttachmentOrigin,
    BrowserAuthorization, BrowserDocument, BrowserSessionPreparation,
};
use maka_sandbox::workspace::PermissionBasis;
use maka_sandbox::{Destination, Network, Sandbox};

/// Origin consent belongs to the captured Agent Session, shared across its
/// browser connections. It cannot be supplied by a model or borrowed by a
/// later invocation through a retained desktop transport callback.
#[derive(Clone)]
pub(super) struct Access {
    owner: Arc<Computer>,
    call: Call,
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
    /// Actual parent Host resource budgets and original Scope, not a read grant.
    pub input_resources: Option<maka_host_runtime::application::ResourceCapturer>,
}

impl Access {
    pub fn new(
        owner: Arc<Computer>,
        call: Call,
        basis: PermissionBasis,
        cell: maka_code_runtime::CellContext,
        producer: CancellationToken,
        gate: Arc<admission::Gate>,
        preparation: PreparationScope,
    ) -> Arc<Self> {
        let invocation = &call.authority.call().execution;
        let attachment = Arc::new(Attachment {
            owner: Arc::downgrade(&owner),
            session: invocation.session_id.clone(),
            turn: invocation.turn_id.clone(),
            basis,
            gate,
            authority: call.authority.clone(),
            floor: call.scope.sandbox_floor().clone(),
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
        self.attachment.resource_boundary()?;
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
        let invocation = &self.call.authority.call().execution;
        // This is the actual per-command native/journal operation captured by
        // evaluate, distinct from the enclosing tool invocation's operation.
        let operation = self.preparation.operation.as_str();
        preparation.check_scope(
            &invocation.turn_id,
            &maka_computer_use::ExecutionCorrelation::new(invocation.run_id.to_string())
                .map_err(failed)?,
            operation,
        )?;
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
                &invocation,
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
    fn prepare_upload(
        &self,
        request: maka_computer_use::BrowserUploadRequest,
        cancellation: CancellationToken,
    ) -> maka_computer_use::BrowserUploadFuture {
        self.prepare_upload_request(request, cancellation)
    }
    fn check_upload(
        &self,
        request: maka_computer_use::BrowserUploadRequest,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        self.check_upload_request(request, cancellation)
    }

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
    if configuration.permissions.access == WorkspaceAccess::DangerFullAccess {
        return Ok(Network::Allowed);
    }
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
    floor: Sandbox,
    pub(super) authority: Arc<dyn maka_agent_authority::computer::ComputerAccess>,
    owner: std::sync::Weak<Computer>,
    session: String,
    turn: String,
    basis: PermissionBasis,
    gate: Arc<admission::Gate>,
}
impl Attachment {
    pub(super) fn resource_boundary(&self) -> Result<(), ToolError> {
        access::resource_boundary(&self.floor)
    }
    pub(super) fn session(&self) -> &str {
        &self.session
    }
    pub(super) fn turn(&self) -> &str {
        &self.turn
    }
    pub(super) fn execution_correlation(&self) -> maka_computer_use::ExecutionCorrelation {
        maka_computer_use::ExecutionCorrelation::new(
            self.authority.call().execution.run_id.to_string(),
        )
        .expect("nonempty actual Run identity")
    }
    pub(super) fn basis(&self) -> PermissionBasis {
        self.basis
    }

    pub(super) fn alive(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Arc<Computer>, ToolError> {
        self.resource_boundary()?;
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
        self.resource_boundary()?;
        if owner.stopping.is_cancelled() {
            return Err(failed("Computer Host service is closed"));
        }
        let configuration = self.authority.current().await?;
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
        if configuration.permissions.access == WorkspaceAccess::DangerFullAccess {
            return Ok(configuration);
        }
        let grant = self.authority.client_grant(&api::target()).await?;
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
        binding.check_scope(&self.turn, &self.execution_correlation())?;
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
        preparation.check_scope(&self.turn, &self.execution_correlation(), operation)?;
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
        if configuration.permissions.access == WorkspaceAccess::DangerFullAccess {
            return Ok(configuration);
        }
        if self
            .authority
            .client_grant(&target(origin.to_owned()))
            .await?
            .is_none_or(|grant| grant.basis != Some(self.basis))
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
