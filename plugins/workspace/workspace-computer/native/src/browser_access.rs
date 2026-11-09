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

#[cfg(test)]
#[path = "../../../../agent/engine/tests/integration/support/native.rs"]
mod native_fixture;

#[cfg(test)]
pub(crate) mod tests {
    use super::native_fixture::{FixtureService, NativeFixture};
    use super::*;
    use maka_agent_api::contract::{BackendPreference, SendResult, WorkspacePermissions};
    use maka_agent_facts::{
        durable::ExecutionIdentity,
        interaction::{InteractionRecord, InteractionRequest},
    };
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    const ORIGIN: &str = "https://clipboard.example";
    pub(crate) const ISOLATION: &str = "IsolationUnavailable: desktop and browser resources cannot prove compatibility with the caller's sandbox floor";
    static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    static CAPTURE: Mutex<Option<Capture>> = Mutex::new(None);

    struct Capture {
        root: std::sync::Weak<maka_event_log::RootStore>,
        session: String,
        sender: tokio::sync::oneshot::Sender<(Arc<Computer>, Call)>,
        release: CancellationToken,
        response: Arc<Mutex<Option<(Value, maka_event_log::root_store::DataChange)>>>,
    }

    pub(crate) async fn capture(
        owner: &Arc<Computer>,
        call: &Call,
    ) -> Option<(Value, maka_event_log::root_store::DataChange)> {
        let capture = {
            let mut slot = CAPTURE.lock().unwrap();
            if call.operation.is_none()
                || !slot.as_ref().is_some_and(|capture| {
                    capture
                        .root
                        .upgrade()
                        .is_some_and(|root| Arc::ptr_eq(&root, &owner.store))
                        && capture.session == call.authority.call().execution.session_id
                })
            {
                return None;
            }
            slot.take().expect("matched actual Computer capture")
        };
        if capture.sender.send((owner.clone(), call.clone())).is_ok() {
            tokio::select! {
                () = capture.release.cancelled() => {},
                () = call.scope.cancellation.cancelled() => {},
            }
        }
        let response = capture.response.lock().unwrap().take();
        response
    }

    async fn request(socket: &mut TcpStream) -> Value {
        let mut bytes = Vec::new();
        let end = loop {
            let byte = socket.read_u8().await.expect("model request header");
            bytes.push(byte);
            if bytes.ends_with(b"\r\n\r\n") {
                break bytes.len();
            }
        };
        let headers = String::from_utf8(bytes).unwrap();
        let size: usize = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse().unwrap())
            })
            .expect("bounded model request Content-Length");
        let mut body = vec![0; size];
        socket.read_exact(&mut body).await.unwrap();
        assert!(end > 0);
        serde_json::from_slice(&body).unwrap()
    }

    async fn model_response(socket: &mut TcpStream, code: Option<String>) {
        let tool = code.is_some();
        let delta = if let Some(code) = code {
            serde_json::json!({"tool_calls":[{"index":0,"id":"actual-computer-call","type":"function","function":{
                "name":"cua_repl","arguments":serde_json::json!({"code":code}).to_string()
            }}]})
        } else {
            serde_json::json!({"content":"Computer fixture finished"})
        };
        let start = serde_json::json!({"id":"computer-fixture","object":"chat.completion.chunk","created":1,"model":"gpt-4.1",
            "choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        let end = serde_json::json!({"id":"computer-fixture","object":"chat.completion.chunk","created":1,"model":"gpt-4.1",
            "choices":[{"index":0,"delta":{},"finish_reason":if tool {"tool_calls"} else {"stop"}}],
            "usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}});
        let body = format!("data: {start}\n\ndata: {end}\n\ndata: [DONE]\n\n");
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
        socket.write_all(body.as_bytes()).await.unwrap();
    }

    pub(crate) struct Fixture {
        _directory: tempfile::TempDir,
        _serial: tokio::sync::MutexGuard<'static, ()>,
        pub(crate) host: NativeFixture,
        pub(crate) owner: Arc<Computer>,
        pub(crate) store: maka_event_log::SessionStore,
        pub(crate) execution: ExecutionIdentity,
        pub(crate) call: Call,
        pub(crate) entry: Arc<sessions::Interaction>,
        pub(crate) epoch: Arc<sessions::Epoch>,
        pub(crate) gate: Arc<admission::Gate>,
        pub(crate) basis: PermissionBasis,
        pub(crate) attachment: Attachment,
        release: CancellationToken,
        pub(crate) response: Arc<Mutex<Option<(Value, maka_event_log::root_store::DataChange)>>>,
        model_stop: CancellationToken,
        model: tokio::task::JoinHandle<()>,
        codes: tokio::sync::mpsc::Sender<String>,
        _release_on_drop: tokio_util::sync::DropGuard,
        _stop_model_on_drop: tokio_util::sync::DropGuard,
    }
    struct NativeSources(maka_agent_facts::durable::RunId);
    impl maka_event_log::connection::Query for NativeSources {
        type Output = u64;
        fn execute(
            self,
            connection: &rusqlite::Connection,
        ) -> Result<u64, maka_event_log::StoreError> {
            let count: i64 = connection.query_row(
                "SELECT count(*) FROM agent_computer_native_bindings WHERE run=?",
                [self.0.to_string()],
                |row| row.get(0),
            )?;
            u64::try_from(count)
                .map_err(|error| maka_event_log::StoreError::InvalidTransition(error.to_string()))
        }
    }
    impl Fixture {
        pub(crate) async fn native_sources(&self) -> u64 {
            self.host
                .root
                .data_writer()
                .unwrap()
                .query(NativeSources(self.execution.run_id))
                .await
                .unwrap()
        }
        pub(crate) async fn run(
            permissions: WorkspacePermissions,
            body: impl for<'a> FnOnce(&'a Self) -> futures_util::future::LocalBoxFuture<'a, ()>,
        ) {
            let fixture = Self::with_permissions(permissions).await;
            let result = std::panic::AssertUnwindSafe(body(&fixture))
                .catch_unwind()
                .await;
            fixture.close().await;
            if let Err(panic) = result {
                std::panic::resume_unwind(panic);
            }
        }

        pub(crate) async fn with_permissions(permissions: WorkspacePermissions) -> Self {
            Self::with_code(permissions, "1").await
        }

        pub(crate) async fn browser_handoff(code: &str) -> Self {
            Self::with_code(
                WorkspacePermissions {
                    access: WorkspaceAccess::DangerFullAccess,
                    request_permissions: false,
                },
                code,
            )
            .await
        }

        pub(crate) async fn with_code(permissions: WorkspacePermissions, code: &str) -> Self {
            let serial = SERIAL.lock().await;
            let directory = tempfile::tempdir().unwrap();
            let workspace = directory.path().join("workspace");
            std::fs::create_dir(&workspace).unwrap();
            let configuration = serde_json::from_value(serde_json::json!({
                "locale":"en", "workspaceRoots":[{"label":"Computer fixture","path":workspace}],
                "permissions":permissions,
                "tools":[{"name":"cua_repl","description":"Evaluate in the actual Computer service",
                    "method":"evaluate","target":{"kind":"import","name":"fixture"},
                    "result":"computer","confirmation":"preapproved"}]
            }))
            .unwrap();
            let host = NativeFixture::open_with_service(
                directory.path(),
                configuration,
                FixtureService::from_provider(
                    api::contract(),
                    api::IMPLEMENTATION,
                    api::EXPORT,
                    crate::provide,
                ),
            )
            .await
            .expect("actual Agent and Computer native providers");
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let selection = host
                .configure_model(
                    &format!("http://{}/v1", listener.local_addr().unwrap()),
                    "gpt-4.1",
                    "computer-fixture-key",
                )
                .await
                .unwrap();
            let backend = BackendPreference::Model {
                connection_id: selection.connection_id,
                model_id: selection.model_id,
                thinking_level: None,
            };
            let session = host
                .create("Actual Computer scope", &workspace, Some(backend.clone()))
                .await
                .unwrap();
            let release = CancellationToken::new();
            let release_on_drop = release.clone().drop_guard();
            let (sender, received) = tokio::sync::oneshot::channel();
            let response = Arc::new(Mutex::new(None));
            *CAPTURE.lock().unwrap() = Some(Capture {
                root: Arc::downgrade(&host.root),
                session: session.clone(),
                sender,
                release: release.clone(),
                response: response.clone(),
            });
            let model_stop = CancellationToken::new();
            let stop_model_on_drop = model_stop.clone().drop_guard();
            let stopped = model_stop.clone();
            let (codes, mut pending_code) = tokio::sync::mpsc::channel::<String>(1);
            codes.send(code.to_owned()).await.unwrap();
            let model = tokio::spawn(async move {
                loop {
                    let accepted = tokio::select! {
                        () = stopped.cancelled() => return,
                        accepted = listener.accept() => accepted.unwrap(),
                    };
                    let (mut socket, _) = accepted;
                    let input = tokio::select! {
                        () = stopped.cancelled() => return,
                        input = request(&mut socket) => input,
                    };
                    let after_tool = input["messages"]
                        .as_array()
                        .unwrap()
                        .last()
                        .is_some_and(|message| message["role"] == "tool");
                    let code = if after_tool {
                        None
                    } else {
                        assert!(
                            input["tools"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .any(|tool| tool["function"]["name"] == "cua_repl")
                        );
                        Some(tokio::select! {
                            () = stopped.cancelled() => return,
                            code = pending_code.recv() => code.expect("actual next model tool input"),
                        })
                    };
                    model_response(&mut socket, code).await;
                }
            });
            let send = host
                .send(
                    &session,
                    "Evaluate 1 using the actual Computer tool",
                    Some(backend),
                )
                .await
                .unwrap();
            let (owner, call) = received
                .await
                .expect("real NativeCallContext after Agent T0/T1");
            let execution = call.authority.call().execution.clone();
            assert_eq!(execution.session_id, session);
            match send {
                SendResult::Started { run_id, .. } => assert_eq!(run_id, execution.run_id),
                SendResult::Queued { message_id, .. } => assert!(
                    matches!(host.state.queue().resolve_message(session.clone(), message_id).await.unwrap(),maka_agent_state::queue::MessageResolution::Delivered { run, .. } if run == execution.run_id)
                ),
                _ => panic!("actual Computer fixture send was not admitted"),
            }
            assert_eq!(call.scope.identity.agent(), Some(&execution));
            assert!(call.operation.is_some());
            assert!(Arc::ptr_eq(&owner.store, &host.root));
            let view = host.state.frontier(execution.run_id).await.unwrap();
            let maka_agent_facts::durable::AuthorizationObligation::Tool { tool: key } =
                call.authority.target()
            else {
                panic!("fixture requires its actual Direct model tool obligation");
            };
            let tool = view
                .tools
                .get(&format!("{}:{}", key.attempt, key.call))
                .expect("original canonical model tool");
            assert_eq!(&tool.key, key);
            assert_eq!(tool.call.id, call.authority.call().call.tool_call_id);
            assert!(tool.admitted && tool.accepted.is_none());
            assert_eq!(tool.original.as_ref(), call.operation.as_ref());
            assert_eq!(
                tool.call.input.as_json().expect("actual JSON tool input")["code"],
                code
            );
            let basis = call.authority.current().await.unwrap().permission_basis();
            let store = host.root.session(&session).await.unwrap();
            let entry = owner.sessions.get(&session).unwrap();
            sessions::watch_turn(&owner, &entry, &call, call.authority.language())
                .await
                .unwrap();
            let (epoch, gate) = {
                let mut kernel = entry.kernel.lock().await;
                if kernel.is_none() {
                    *kernel = Some(entry.fresh_kernel().unwrap());
                }
                let kernel = kernel.as_ref().unwrap();
                (kernel.epoch.clone(), kernel.admission.clone())
            };
            let attachment = Attachment {
                floor: call.scope.sandbox_floor().clone(),
                authority: call.authority.clone(),
                owner: Arc::downgrade(&owner),
                session,
                turn: execution.turn_id.clone(),
                basis,
                gate: gate.clone(),
            };
            Self {
                _directory: directory,
                _serial: serial,
                host,
                owner,
                store,
                execution,
                call,
                entry,
                epoch,
                gate,
                basis,
                attachment,
                release,
                response,
                model_stop,
                model,
                codes,
                _release_on_drop: release_on_drop,
                _stop_model_on_drop: stop_model_on_drop,
            }
        }

        pub(crate) fn basis(&self) -> PermissionBasis {
            self.basis
        }

        pub(crate) async fn decision(
            &self,
            id: &str,
            target: GrantTarget,
            decision: Decision,
            time: u64,
        ) {
            let current = self.call.authority.current().await.unwrap();
            assert!(
                current.permissions.request_permissions,
                "fixture consent must use the actual enabled request policy"
            );
            let record = InteractionRecord {
                execution: self.execution.clone(),
                request_id: format!("fixture_{id}_{}", self.execution.run_id),
                created_at: time,
                request: InteractionRequest::ClientCapability {
                    tool_use_id: self.call.authority.call().tool_use_id(),
                    target,
                    basis: Some(self.basis),
                },
                outcome: None,
            };
            self.call.authority.establish(&record).await.unwrap();
            let result = self
                .host
                .mutation_value(
                    "respond",
                    serde_json::json!({
                        "sessionId":self.execution.session_id,"requestId":record.request_id,
                        "answer":{"kind":"client_capability","decision":decision}
                    }),
                )
                .await
                .unwrap();
            assert_eq!(result["kind"], "recorded");
        }

        pub(crate) async fn check(&self) -> Result<(), ToolError> {
            self.attachment
                .check(
                    BrowserAttachmentOrigin::Site(ORIGIN.into()),
                    CancellationToken::new(),
                )
                .await
        }

        pub(crate) async fn next_call(&mut self, code: &str) {
            self.run_call().await;
            self.host
                .wait_terminal(self.execution.run_id)
                .await
                .unwrap();
            let release = CancellationToken::new();
            let release_on_drop = release.clone().drop_guard();
            let (sender, received) = tokio::sync::oneshot::channel();
            let response = Arc::new(Mutex::new(None));
            *CAPTURE.lock().unwrap() = Some(Capture {
                root: Arc::downgrade(&self.host.root),
                session: self.execution.session_id.clone(),
                sender,
                release: release.clone(),
                response: response.clone(),
            });
            self.codes.send(code.to_owned()).await.unwrap();
            self.host
                .send(
                    &self.execution.session_id,
                    "Evaluate the next actual Computer program",
                    None,
                )
                .await
                .unwrap();
            let (owner, call) = received.await.expect("next real T0/T1 Computer context");
            assert!(Arc::ptr_eq(&owner, &self.owner));
            let execution = call.authority.call().execution.clone();
            assert_ne!(execution.run_id, self.execution.run_id);
            assert_eq!(execution.session_id, self.execution.session_id);
            let view = self.host.state.frontier(execution.run_id).await.unwrap();
            let maka_agent_facts::durable::AuthorizationObligation::Tool { tool: key } =
                call.authority.target()
            else {
                panic!("fixture requires its actual Direct model tool obligation");
            };
            let tool = view
                .tools
                .get(&format!("{}:{}", key.attempt, key.call))
                .expect("original canonical model tool");
            assert_eq!(&tool.key, key);
            assert_eq!(tool.call.id, call.authority.call().call.tool_call_id);
            assert!(tool.admitted && tool.accepted.is_none());
            assert_eq!(tool.original.as_ref(), call.operation.as_ref());
            assert_eq!(
                tool.call.input.as_json().expect("actual JSON tool input")["code"],
                code
            );
            self.basis = call.authority.current().await.unwrap().permission_basis();
            sessions::watch_turn(&owner, &self.entry, &call, call.authority.language())
                .await
                .unwrap();
            let (epoch, gate) = {
                let mut kernel = self.entry.kernel.lock().await;
                if kernel.is_none() {
                    *kernel = Some(self.entry.fresh_kernel().unwrap());
                }
                let kernel = kernel.as_ref().unwrap();
                (kernel.epoch.clone(), kernel.admission.clone())
            };
            self.attachment = Attachment {
                floor: call.scope.sandbox_floor().clone(),
                authority: call.authority.clone(),
                owner: Arc::downgrade(&owner),
                session: execution.session_id.clone(),
                turn: execution.turn_id.clone(),
                basis: self.basis,
                gate: gate.clone(),
            };
            self.execution = execution;
            self.call = call;
            self.epoch = epoch;
            self.gate = gate;
            self.release = release;
            self.response = response;
            self._release_on_drop = release_on_drop;
        }

        pub(crate) async fn run_call(&self) -> api::ResultValue {
            use maka_plugin_core::operation::{
                OperationCleanup, OperationOutcome, OperationResult,
            };
            let reference = self
                .call
                .operation
                .as_ref()
                .expect("original actual SDK operation");
            let operation = self.host.root.operation(reference).unwrap();
            let mut changes = self
                .host
                .root
                .data_writer()
                .unwrap()
                .subscribe_changes()
                .unwrap();
            self.release.cancel();
            loop {
                changes.borrow_and_update();
                if let Some(observed) = operation.operation_observation().await.unwrap() {
                    match (observed.outcome, observed.cleanup) {
                        (
                            OperationOutcome::Returned {
                                result: OperationResult::Success { value },
                            },
                            OperationCleanup::Confirmed,
                        ) => return serde_json::from_value(value).unwrap(),
                        (
                            OperationOutcome::Returned {
                                result: OperationResult::Failure { diagnostic },
                            },
                            OperationCleanup::Confirmed,
                        ) => panic!("actual Computer SDK call failed: {diagnostic}"),
                        _ => {}
                    }
                }
                changes.changed().await.unwrap();
            }
        }

        pub(crate) async fn end(&self) {
            self.release.cancel();
            self.host.mutation_value("stop",serde_json::json!({"sessionId":self.execution.session_id,"runId":self.execution.run_id})).await.unwrap();
            self.host
                .wait_terminal(self.execution.run_id)
                .await
                .unwrap();
        }

        pub(crate) async fn set_permissions(
            &self,
            permissions: WorkspacePermissions,
            revoke: bool,
        ) {
            let session = self
                .host
                .query(
                    "observe",
                    serde_json::json!({"sessionId":self.execution.session_id}),
                )
                .await
                .unwrap()["session"]
                .clone();
            let result = self.host.mutation_value("metadata",serde_json::json!({
                "sessionId":self.execution.session_id,"expectedRevision":session["revision"],
                "title":session["title"],"labels":session["labels"],
                "permissions":{"settings":permissions,"revokeGrants":revoke}
            })).await.unwrap();
            assert_eq!(result["kind"], "committed");
        }

        pub(crate) async fn revoke_basis(&self) {
            let current = self
                .store
                .get::<maka_agent_api::session::StoredSessionConfiguration>()
                .await
                .unwrap()
                .unwrap();
            self.set_permissions(current.configuration.permissions, true)
                .await;
        }

        pub(crate) async fn close(self) {
            self.close_with_cleanup(false).await;
        }

        pub(crate) async fn close_with_cleanup(self, unconfirmed: bool) {
            self.call.scope.cancellation.cancel();
            self.release.cancel();
            self.host.mutation_value("stop",serde_json::json!({"sessionId":self.execution.session_id,"runId":self.execution.run_id})).await.unwrap();
            self.host
                .wait_terminal(self.execution.run_id)
                .await
                .unwrap();
            self.owner.sessions.close().await.unwrap();
            assert_eq!(self.owner.resources.settle().await.is_err(), unconfirmed);
            self.model_stop.cancel();
            self.model.await.expect("actual fixture model worker");
            let application = self.host.app.shutdown().await;
            self.host.config.shutdown().await.unwrap();
            assert_eq!(self.host.root.shutdown().await.is_err(), unconfirmed);
            if unconfirmed {
                let _ = self._directory.keep();
            } else {
                application.expect("actual App shutdown after original workers");
            }
        }
    }

    fn permissions(access: WorkspaceAccess) -> WorkspacePermissions {
        WorkspacePermissions {
            access,
            request_permissions: matches!(access, WorkspaceAccess::WorkspaceWrite),
        }
    }
    fn isolation(error: ToolError) {
        assert!(matches!(error, ToolError::Failed(message) if message == ISOLATION));
    }

    #[tokio::test]
    async fn sandbox_off_admits_computer_scopes_without_prompts_and_restricting_it_revokes_access()
    {
        use maka_agent_facts::interaction::{
            ComputerAppDisplay, ComputerAppIdentity, ComputerAppPlatform, ComputerAppRisk,
        };
        for request_permissions in [false, true] {
            Fixture::run(WorkspacePermissions { access:WorkspaceAccess::DangerFullAccess,request_permissions },|fixture| Box::pin(async move {
                let (configuration,_) = access::current(&fixture.owner,&fixture.call,"cua_repl").await.unwrap();
                let cell = maka_code_runtime::CellContext::new(maka_code_runtime::CellStore::temporary().unwrap(),vec![]).unwrap();
                for capability in [GrantCapability::ComputerUse,GrantCapability::ComputerAudio,GrantCapability::Browser,GrantCapability::BrowserHistory,GrantCapability::BrowserDownload,GrantCapability::BrowserUpload] {
                    let scope = match capability {
                        GrantCapability::Browser|GrantCapability::BrowserDownload|GrantCapability::BrowserUpload => GrantScope::BrowserOrigin { origin:ORIGIN.into() },
                        GrantCapability::BrowserHistory => GrantScope::BrowserProfile { browser_id:"observation-browser".into(),generation:"observation-generation".into() },
                        _ => GrantScope::Capability {},
                    };
                    let target = GrantTarget { capability,scope,..api::target() };
                    tokio::time::timeout(std::time::Duration::from_secs(2),access::approve_target(&fixture.owner,&fixture.call,&configuration,&fixture.call.scope.cancellation,target.clone(),Some(&cell))).await.expect("sandbox off must not wait for a decision").unwrap();
                    access::granted_target(&fixture.owner,&fixture.call,fixture.basis,&target).await.unwrap();
                    assert!(fixture.host.state.interactions().client_capability_grant(&fixture.execution.session_id,&target).await.unwrap().is_none(),"full access must not manufacture consent for {:?}",target.capability);
                }
                for platform in [ComputerAppPlatform::Macos,ComputerAppPlatform::Windows] {
                    let subject = maka_computer_use::ComputerAppTarget {
                        identity:ComputerAppIdentity { platform,application_id:match platform { ComputerAppPlatform::Macos=>"fixture.application",ComputerAppPlatform::Windows=>r"C:\Fixture\application.exe" }.into() },
                        display:ComputerAppDisplay { name:"Fixture application".into(),app_path:match platform { ComputerAppPlatform::Macos=>"/Applications/Fixture.app",ComputerAppPlatform::Windows=>r"C:\Fixture\application.exe" }.into(),risk:Some(ComputerAppRisk::High),warning:None },
                        allow_always:false,binding:None,
                    };
                    tokio::time::timeout(std::time::Duration::from_secs(2),app_access::approve(&fixture.owner,&fixture.call,fixture.basis,&subject,match platform { ComputerAppPlatform::Macos=>"policy-observation-macos",ComputerAppPlatform::Windows=>"policy-observation-windows" },serde_json::json!({"application":subject.identity.application_id}),&fixture.call.scope.cancellation,&cell)).await.expect("full-access applications must not wait for a decision").unwrap();
                }
                fixture.attachment.check(BrowserAttachmentOrigin::Site("https://new.example".into()),CancellationToken::new()).await.unwrap();
                assert!(fixture.host.state.interactions().pending(&fixture.execution.session_id).await.unwrap().records.is_empty());
                fixture.set_permissions(permissions(WorkspaceAccess::WorkspaceWrite),false).await;
                assert!(access::granted(&fixture.owner,&fixture.call,fixture.basis).await.is_err());
                assert!(fixture.check().await.is_err());
            })).await;
        }
    }

    #[tokio::test]
    async fn attachment_uses_current_session_grants_without_retaining_a_cell() {
        Fixture::run(permissions(WorkspaceAccess::WorkspaceWrite),|fixture| Box::pin(async move {
            fixture.decision("broad",api::target(),Decision::Allow,2).await;
            fixture.decision("site",target(ORIGIN.into()),Decision::Allow,3).await;
            assert!(fixture.host.state.interactions().client_capability_grant(&fixture.execution.session_id,&target(ORIGIN.into())).await.unwrap().is_some());
            let before=fixture.host.state.frontier(fixture.execution.run_id).await.unwrap().revision;
            isolation(fixture.check().await.unwrap_err());
            isolation(fixture.check().await.unwrap_err());
            assert_eq!(fixture.host.state.frontier(fixture.execution.run_id).await.unwrap().revision,before,"checks cannot add Agent T1 facts");
            assert!(fixture.host.state.interactions().pending(&fixture.execution.session_id).await.unwrap().records.is_empty(),"checks cannot elicit permission");
            isolation(fixture.attachment.check(BrowserAttachmentOrigin::Site("https://other.example".into()),CancellationToken::new()).await.unwrap_err());
            fixture.decision("site-denied",target(ORIGIN.into()),Decision::Deny,4).await;
            let denied=fixture.host.state.interactions().read(&fixture.execution.session_id,&format!("fixture_site-denied_{}",fixture.execution.run_id)).await.unwrap().unwrap();
            assert!(matches!(denied.outcome,Some(maka_agent_facts::interaction::InteractionOutcome::ClientCapabilityDecision { decision:Decision::Deny,.. })));
            isolation(fixture.check().await.unwrap_err());
            assert!(matches!(fixture.run_call().await,api::ResultValue::Failed { message,.. } if message==ISOLATION));
            assert_eq!(fixture.native_sources().await,0,"constrained provider must not bind any native effect source");
        })).await;
    }

    #[tokio::test]
    async fn natural_popup_navigation_does_not_grant_destination_content_for_none_or_deny() {
        Fixture::run(permissions(WorkspaceAccess::WorkspaceWrite),|fixture| Box::pin(async move {
            fixture.decision("broad",api::target(),Decision::Allow,2).await;
            fixture.decision("site",target(ORIGIN.into()),Decision::Allow,3).await;
            let destination="https://unread-destination.example";
            let document=BrowserDocument { browser_id:"policy-observation".into(),generation:"policy-observation".into(),tab_id:"17".into(),url:"about:blank".into() };
            let scope=super::super::browser_popup::Authorization::new(Arc::new(fixture.attachment.clone()),"policy-observation".into(),format!("{destination}/popup"));
            let navigation=BrowserAccess::Navigate { document:document.clone(),url:format!("{destination}/popup") };
            let read=BrowserAccess::ReadDocument { document:document.clone(),origin:BrowserAttachmentOrigin::Site(destination.into()) };
            assert!(fixture.host.state.interactions().client_capability_grant(&fixture.execution.session_id,&target(destination.into())).await.unwrap().is_none());
            isolation(scope.authorize(navigation.clone(),CancellationToken::new()).await.unwrap_err());
            isolation(scope.check(read.clone(),CancellationToken::new()).await.unwrap_err());
            assert!(fixture.host.state.interactions().client_capability_grant(&fixture.execution.session_id,&target(destination.into())).await.unwrap().is_none(),"navigation must not manufacture a Site Allow");
            fixture.decision("destination-denied",target(destination.into()),Decision::Deny,4).await;
            let denied=fixture.host.state.interactions().read(&fixture.execution.session_id,&format!("fixture_destination-denied_{}",fixture.execution.run_id)).await.unwrap().unwrap();
            assert!(matches!(denied.outcome,Some(maka_agent_facts::interaction::InteractionOutcome::ClientCapabilityDecision { decision:Decision::Deny,.. })));
            isolation(scope.authorize(navigation.clone(),CancellationToken::new()).await.unwrap_err());
            isolation(scope.check(read,CancellationToken::new()).await.unwrap_err());
            assert!(fixture.host.state.interactions().client_capability_grant(&fixture.execution.session_id,&target(destination.into())).await.unwrap().is_none());
            isolation(scope.check(BrowserAccess::ReadDocument { document,origin:BrowserAttachmentOrigin::Opaque },CancellationToken::new()).await.unwrap_err());
            isolation(scope.attachment().unwrap().check(BrowserAttachmentOrigin::Opaque,CancellationToken::new()).await.unwrap_err());
            let result=fixture.run_call().await;
            assert!(matches!(result,api::ResultValue::Failed { message,.. } if message==ISOLATION),"the actual provider must reject its inherited floor before native work");
            fixture.end().await;
            assert!(scope.authorize(navigation,CancellationToken::new()).await.is_err());
        })).await;
    }

    // These DTOs exercise the policy checker, not SDK tab ownership or native proof.
    fn session_preparation_request(fixture: &Fixture) -> BrowserSessionPreparation {
        BrowserSessionPreparation {
            native_owner: uuid::Uuid::from_u128(1),
            native_epoch: fixture.epoch.id.clone(),
            browser_id: "policy-observation".into(),
            generation: "policy-observation".into(),
            turn_id: fixture.execution.turn_id.clone(),
            execution: fixture.attachment.execution_correlation(),
            operation_id: fixture.call.authority.call().operation_id.clone(),
            target: maka_computer_use::BrowserPreparationTarget::FixedSessionTab {
                tab_id: "17".into(),
                scope_id: "policy-observation".into(),
            },
        }
    }
    fn effect_preparation_binding(
        request: &BrowserSessionPreparation,
    ) -> maka_computer_use::BrowserPreparationBinding {
        maka_computer_use::BrowserPreparationBinding {
            native_owner: request.native_owner,
            native_epoch: request.native_epoch.clone(),
            browser_id: request.browser_id.clone(),
            generation: request.generation.clone(),
            turn_id: request.turn_id.clone(),
            execution: request.execution.clone(),
            tab_id: "17".into(),
            subject: maka_plugin_core::computer::BrowserLeaseSubject::FixedSession {
                scope_id: "policy-observation".into(),
            },
        }
    }

    #[tokio::test]
    async fn actual_host_service_revoke_blocks_new_checks_but_keeps_original_started_ticket_pending()
     {
        Fixture::run(permissions(WorkspaceAccess::WorkspaceWrite),|fixture| Box::pin(async move {
            assert!(matches!(fixture.run_call().await,api::ResultValue::Failed { message,.. } if message==ISOLATION));
            assert_eq!(fixture.native_sources().await,0);
        })).await;
        Fixture::run(permissions(WorkspaceAccess::DangerFullAccess), |fixture| {
            Box::pin(async move {
                let native = fixture.epoch.native.clone();
                let effects = admission::host_effects_with_lease_children(
                    &fixture.owner,
                    fixture.gate.clone(),
                    &native,
                    Arc::new(fixture.attachment.clone()),
                );
                let (sent, received) = tokio::sync::oneshot::channel();
                let release = CancellationToken::new();
                let _release_on_panic = release.clone().drop_guard();
                let worker_release = release.clone();
                let (completed, mut completion) = tokio::sync::oneshot::channel();
                effects
                    .spawn_scoped_guarded(
                        Box::new(move |scope| {
                            Box::pin(async move {
                                sent.send(scope)
                                    .unwrap_or_else(|_| panic!("scope observer disappeared"));
                                worker_release.cancelled().await;
                                completed
                                    .send(())
                                    .expect("original future completion observer");
                                Ok(())
                            })
                        }),
                        Box::new(|_| panic!("local admission unexpectedly rejected")),
                    )
                    .unwrap();
                let scope = received.await.unwrap();
                let binding = effect_preparation_binding(&session_preparation_request(fixture));
                scope
                    .check_session_preparation(binding.clone(), CancellationToken::new())
                    .await
                    .unwrap();
                fixture.revoke_basis().await;
                assert!(
                    scope
                        .check_session_preparation(binding, CancellationToken::new())
                        .await
                        .is_err()
                );
                let mut settlement = Box::pin(fixture.owner.resources.settle());
                assert!(
                    futures_util::poll!(&mut settlement).is_pending(),
                    "authority revoke is not original future terminal"
                );
                assert!(
                    futures_util::poll!(&mut completion).is_pending(),
                    "the actual original worker is still held"
                );
                release.cancel();
                completion
                    .await
                    .expect("original future reached EOF before ending the Run");
                fixture.end().await;
                settlement.await.unwrap();
            })
        })
        .await;
    }

    #[tokio::test]
    async fn fixed_ui_targets_recheck_real_global_basis_turn_gate_and_operation() {
        for changed in [
            "global",
            "basis",
            "turn",
            "gate",
            "cancel",
            "operation",
            "execution",
        ] {
            let policy = if changed == "global" {
                WorkspaceAccess::WorkspaceWrite
            } else {
                WorkspaceAccess::DangerFullAccess
            };
            Fixture::run(permissions(policy), move |fixture| {
                Box::pin(async move {
                    let mut request = session_preparation_request(fixture);
                    let binding = effect_preparation_binding(&request);
                    let cancellation = CancellationToken::new();
                    if changed == "global" {
                        assert!(
                            fixture
                                .host
                                .state
                                .interactions()
                                .client_capability_grant(
                                    &fixture.execution.session_id,
                                    &api::target()
                                )
                                .await
                                .unwrap()
                                .is_none()
                        );
                        isolation(
                            fixture
                                .attachment
                                .session_preparation_current(
                                    &request,
                                    &request.operation_id,
                                    &cancellation,
                                )
                                .await
                                .unwrap_err(),
                        );
                        isolation(
                            fixture
                                .attachment
                                .effect_preparation_current(&binding, &cancellation)
                                .await
                                .unwrap_err(),
                        );
                        return;
                    }
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
                    match changed {
                        "basis" => fixture.revoke_basis().await,
                        "turn" => fixture.end().await,
                        "gate" => fixture.gate.close_admission(),
                        "cancel" => cancellation.cancel(),
                        "execution" => {
                            request.execution =
                                maka_computer_use::ExecutionCorrelation::new("another-execution")
                                    .unwrap()
                        }
                        _ => {}
                    }
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
                    let message = match error {
                        ToolError::Failed(message) => message,
                        error => panic!("unexpected guard error {error}"),
                    };
                    match changed {
                        "basis" => assert_eq!(message, "Browser permission boundary changed"),
                        "gate" => assert_eq!(message, "Computer VM has retired"),
                        "cancel" => assert_eq!(message, "Browser attachment cancelled"),
                        "turn" => assert!(fixture.call.authority.current().await.is_err()),
                        "operation" | "execution" => assert!(message.contains("scope")),
                        _ => unreachable!(),
                    }
                    if changed != "operation" && changed != "execution" {
                        assert!(
                            fixture
                                .attachment
                                .effect_preparation_current(&binding, &cancellation)
                                .await
                                .is_err(),
                            "{changed} must also reject fixed-session effect policy"
                        );
                    }
                })
            })
            .await;
        }
    }
}
