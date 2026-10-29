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

use maka_agent_facts::tools::ToolError;
use serde::{Deserialize, Serialize};
use std::{future::Future, pin::Pin, sync::Arc};
use tokio_util::sync::CancellationToken;

pub type AuthorizationFuture = Pin<Box<dyn Future<Output = Result<(), ToolError>> + Send>>;

/// The remainder of an already dispatched request whose physical result has
/// been independently confirmed. Completion observes that same request's reply.
pub type SettlementFuture = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;
/// The original required request remainder, including a failure to settle it.
pub type CheckedSettlementFuture =
    Pin<Box<dyn Future<Output = Result<(), ToolError>> + Send + 'static>>;
/// Notification that an admitted Host effect no longer has confirmed custody.
pub type HostUncertaintyFuture = Pin<Box<dyn Future<Output = ToolError> + Send + 'static>>;

/// Per-call custody supplied by the original Host invocation. A rejection must
/// return the future intact so the caller can drain it before returning.
pub trait OperationSettlement: Send + Sync {
    fn retain(&self, pending: SettlementFuture) -> Result<(), (ToolError, SettlementFuture)>;
    /// Retain the same required request with its checked settlement result.
    /// A refusal returns that original future for the caller to drain.
    fn retain_checked(
        &self,
        pending: CheckedSettlementFuture,
    ) -> Result<(), (ToolError, CheckedSettlementFuture)> {
        Err((
            ToolError::Failed("checked remote settlement is unavailable".into()),
            pending,
        ))
    }
}

pub type HostEffectFuture = Pin<Box<dyn Future<Output = Result<(), ToolError>> + Send + 'static>>;

/// The security origin reported by the bound browser execution context. An
/// about:blank frame can inherit a site origin; its URL cannot substitute here.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum BrowserAttachmentOrigin {
    Site(String),
    Opaque,
}

/// Check-only authority for an actual attached page between Agent calls. This
/// capability follows the logical Turn and VM attachment, never a saved Run.
pub trait BrowserAttachmentAuthorization: Send + Sync {
    /// Check the captured Host turn for fixed browser metadata or presentation
    /// on an independently verified opaque document. This grants no site read
    /// and does not replace clipboard origin admission.
    fn check_metadata(&self, _cancellation: CancellationToken) -> AuthorizationFuture {
        Box::pin(async {
            Err(ToolError::Failed(
                "browser metadata attachment authority is unavailable".into(),
            ))
        })
    }

    fn check(
        &self,
        origin: BrowserAttachmentOrigin,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture;
}

/// Actual native lease metadata submitted by the provider observer. This is
/// never a grant or an Agent invocation; execution rechecks the retained source
/// completion and the existing live parent lease in the selected native epoch.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserLeaseChildRequest {
    pub browser_id: String,
    pub generation: String,
    pub native_owner: uuid::Uuid,
    pub native_epoch: String,
    pub turn_id: String,
    pub completion_id: u64,
    pub opener_subject: crate::BrowserLeaseSubject,
    pub opener_tab_id: u64,
    pub url: String,
}

/// Existing Host-service admission for automatic attached-browser effects.
/// The future must be unpolled: rejection cannot leave a dispatched request.
/// This capability never grants site access or fabricates an Agent invocation.
pub trait BrowserHostEffects: Send + Sync {
    fn spawn(&self, unpolled: HostEffectFuture) -> Result<(), ToolError>;

    /// Whether this actual Host binding owns fresh lease-child service work.
    fn supports_lease_children(&self) -> bool {
        false
    }

    /// Execute one retained popup intent under a new Host-service journal fact.
    /// The original input operation is not reused as its cause or resource owner.
    fn adopt_lease_child(&self, _request: BrowserLeaseChildRequest) -> HostEffectFuture {
        Box::pin(async {
            Err(ToolError::Failed(
                "Host lease-child service is unavailable".into(),
            ))
        })
    }

    /// A remote custodian can accept an unpolled future before its parent admits it.
    /// Delayed refusal invokes this metadata-only callback; immediate errors are
    /// returned to the caller, which still performs its normal rejection cleanup.
    fn spawn_guarded(
        &self,
        unpolled: HostEffectFuture,
        _rejected: Box<dyn FnOnce(ToolError) + Send>,
    ) -> Result<(), ToolError> {
        self.spawn(unpolled)
    }
    /// Construct work only after this exact Host service effect is admitted.
    /// The supplied scope authorizes only fixed session preparation, and ends
    /// with this actual future; it cannot borrow a completed Agent operation.
    fn spawn_scoped_guarded(
        &self,
        _factory: HostEffectFactory,
        _rejected: Box<dyn FnOnce(ToolError) + Send>,
    ) -> Result<(), ToolError> {
        Err(ToolError::Failed(
            "scoped browser Host effects are unavailable".into(),
        ))
    }
    /// The same scoped service admission with an independent early uncertainty
    /// signal. Uncertainty seals new RPCs while the original future is drained.
    fn spawn_scoped_custodied(
        &self,
        _factory: HostEffectFactory,
        _uncertainty: HostUncertaintyFuture,
        _rejected: Box<dyn FnOnce(ToolError) + Send>,
    ) -> Result<(), ToolError> {
        Err(ToolError::Failed(
            "scoped browser Host effect custody is unavailable".into(),
        ))
    }
    /// Keep effect execution and uncertainty attached to the same Host admission.
    fn spawn_custodied(
        &self,
        _unpolled: HostEffectFuture,
        _uncertainty: HostUncertaintyFuture,
        _rejected: Box<dyn FnOnce(ToolError) + Send>,
    ) -> Result<(), ToolError> {
        Err(ToolError::Failed(
            "remote Host effect custody is unavailable".into(),
        ))
    }
}

#[cfg(any(feature = "native-desktop", test))]
#[derive(Clone)]
pub(crate) struct BrowserServices {
    #[cfg(feature = "native-desktop")]
    pub files: Option<Arc<dyn crate::BrowserAssetFiles>>,
    pub attachment: Option<Arc<dyn BrowserAttachmentAuthorization>>,
    pub effects: Option<Arc<dyn BrowserHostEffects>>,
    pub settlement: Option<Arc<dyn OperationSettlement>>,
}
#[cfg(feature = "native-desktop")]
pub(crate) type BrowserServicesFuture =
    Pin<Box<dyn Future<Output = Result<BrowserServices, ToolError>> + Send>>;
#[cfg(feature = "native-desktop")]
pub(crate) trait BrowserServicesProvider: Send + Sync {
    fn prepare(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> BrowserServicesFuture;
}

/// Exact native routing observed by an already admitted attached-service
/// effect. It has no Agent operation ID and is not a lease or site grant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserPreparationBinding {
    pub native_owner: uuid::Uuid,
    pub native_epoch: String,
    pub browser_id: String,
    pub generation: String,
    pub turn_id: String,
    pub tab_id: String,
    pub subject: crate::BrowserLeaseSubject,
}
impl BrowserPreparationBinding {
    pub fn check_turn(&self, turn: &str) -> Result<(), ToolError> {
        if self.native_owner.is_nil()
            || self.native_epoch.is_empty()
            || self.browser_id.is_empty()
            || self.generation.is_empty()
            || self.turn_id.is_empty()
            || self.turn_id != turn
            || self.tab_id.is_empty()
            || self.subject.routing_id().is_empty()
        {
            return Err(ToolError::Failed(
                "Browser effect preparation lost its native binding".into(),
            ));
        }
        Ok(())
    }
}

/// The actual Host effect owner implements this narrow capability and passes
/// it only after admitting its resource ticket. It grants no content or input.
/// An authorization clone, an old Agent operation and a native lease alone do
/// not construct one. It expires when this exact effect becomes terminal.
pub trait BrowserEffectScope: Send + Sync {
    fn check_session_preparation(
        &self,
        binding: BrowserPreparationBinding,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture;
}

pub type HostEffectFactory =
    Box<dyn FnOnce(Arc<dyn BrowserEffectScope>) -> HostEffectFuture + Send + 'static>;

/// Trusted Host feature policy for fixed native session preparation.
/// This is an explicit Maka policy, not an observation of another adapter's defaults.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserPreparationPolicy {
    pub popup_enabled: bool,
    pub headers: Vec<BrowserPreparationHeader>,
}

impl BrowserPreparationPolicy {
    /// Headers also need the popup relay to inherit them before the first
    /// child request. This is the source-audited effective preparation policy.
    #[must_use]
    pub fn effective_popup(&self) -> bool {
        self.popup_enabled || !self.headers.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserPreparationHeader {
    pub name: String,
    pub value: String,
}

/// Routing for a reservation already validated by the native ownership ledger.
/// These values are neither ownership proofs nor document/origin evidence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserPreparationTarget {
    ReservedTab {
        tab_id: String,
    },
    ClaimedTab {
        tab_id: String,
        claim_id: String,
    },
    /// Exact logical scope backed by an SDK-issued fixed preparation receipt.
    FixedSessionTab {
        tab_id: String,
        scope_id: String,
    },
    PendingCreation,
    /// Scoped session inventory and exact metadata lookup, without a tab grant.
    SessionInventory,
    /// Change only this logical session's managed browser-group presentation.
    SessionPresentation,
    /// Browser-wide history transport; a separate history grant is also required.
    SessionHistory,
}

/// A bounded request for source-audited native session machinery, including
/// scoped inventory/metadata lookup or preparation on an owned/reserved tab.
/// It never authorizes Agent content, input, arbitrary scripts, or a site read.
/// The caller must validate the actual native ledger before and after admission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserSessionPreparation {
    pub native_owner: uuid::Uuid,
    pub native_epoch: String,
    pub browser_id: String,
    pub generation: String,
    pub turn_id: String,
    pub operation_id: String,
    pub target: BrowserPreparationTarget,
}

impl BrowserSessionPreparation {
    /// Validate routing shape and its captured invocation. This does not prove
    /// that the native tab/claim is owned; the backend checks that ledger.
    pub fn check_scope(&self, turn: &str, operation: &str) -> Result<(), ToolError> {
        let target_valid = match &self.target {
            BrowserPreparationTarget::ReservedTab { tab_id } => !tab_id.is_empty(),
            BrowserPreparationTarget::ClaimedTab { tab_id, claim_id } => {
                !tab_id.is_empty() && !claim_id.is_empty()
            }
            BrowserPreparationTarget::FixedSessionTab { tab_id, scope_id } => {
                !tab_id.is_empty() && !scope_id.is_empty()
            }
            BrowserPreparationTarget::PendingCreation
            | BrowserPreparationTarget::SessionInventory
            | BrowserPreparationTarget::SessionPresentation
            | BrowserPreparationTarget::SessionHistory => true,
        };
        if self.native_owner.is_nil()
            || self.native_epoch.is_empty()
            || self.browser_id.is_empty()
            || self.generation.is_empty()
            || self.turn_id.is_empty()
            || self.operation_id.is_empty()
            || self.turn_id != turn
            || self.operation_id != operation
            || !target_valid
        {
            return Err(ToolError::Failed(
                "Browser session preparation lost its captured native scope".into(),
            ));
        }
        Ok(())
    }
}

/// The selected browser's current document, resolved by the platform backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserDocument {
    pub browser_id: String,
    pub generation: String,
    pub tab_id: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum BrowserAccess {
    /// Admission for fixed browser metadata and attachment transport only.
    /// This never authorizes content preparation or a site read.
    Metadata {
        document: BrowserDocument,
    },
    /// Read the runtime-verified effective origin of this bound document.
    ReadDocument {
        document: BrowserDocument,
        origin: BrowserAttachmentOrigin,
    },
    Read {
        document: BrowserDocument,
    },
    Navigate {
        document: BrowserDocument,
        url: String,
    },
    PageAssetDownload {
        document: BrowserDocument,
        source_origin: BrowserAttachmentOrigin,
    },
    PageAssetFallbackFetch {
        document: BrowserDocument,
        source_origin: BrowserAttachmentOrigin,
        url: String,
    },
    Download {
        document: BrowserDocument,
        source_origin: BrowserAttachmentOrigin,
        url: String,
    },
}

impl BrowserAccess {
    pub fn document(&self) -> &BrowserDocument {
        match self {
            Self::ReadDocument { document, .. }
            | Self::Metadata { document }
            | Self::Read { document }
            | Self::Navigate { document, .. }
            | Self::Download { document, .. }
            | Self::PageAssetDownload { document, .. }
            | Self::PageAssetFallbackFetch { document, .. } => document,
        }
    }

    pub fn url(&self) -> &str {
        match self {
            Self::ReadDocument { document, .. }
            | Self::Metadata { document }
            | Self::Read { document }
            | Self::PageAssetDownload { document, .. } => &document.url,
            Self::Navigate { url, .. }
            | Self::Download { url, .. }
            | Self::PageAssetFallbackFetch { url, .. } => url,
        }
    }

    pub fn origin(&self) -> Result<Option<String>, ToolError> {
        if matches!(self, Self::Metadata { .. }) {
            return Ok(None);
        }
        if let Self::PageAssetDownload {
            document,
            source_origin,
        }
        | Self::PageAssetFallbackFetch {
            document,
            source_origin,
            ..
        } = self
        {
            if let Self::PageAssetFallbackFetch { url, .. } = self
                && let Ok(url) = reqwest::Url::parse(url)
                && matches!(url.scheme(), "http" | "https")
            {
                return Ok(Some(url.origin().ascii_serialization()));
            }
            return Self::ReadDocument {
                document: document.clone(),
                origin: source_origin.clone(),
            }
            .origin();
        }
        if let Self::ReadDocument { origin, .. } = self {
            return match origin {
                BrowserAttachmentOrigin::Opaque => Ok(None),
                BrowserAttachmentOrigin::Site(origin) => {
                    let url = reqwest::Url::parse(origin).map_err(|error| {
                        ToolError::Failed(format!("invalid browser document origin: {error}"))
                    })?;
                    if !matches!(url.scheme(), "http" | "https")
                        || url.origin().ascii_serialization() != *origin
                    {
                        return Err(ToolError::Failed(
                            "browser document origin must be a canonical HTTP(S) origin".into(),
                        ));
                    }
                    Ok(Some(origin.clone()))
                }
            };
        }
        if matches!(self, Self::Navigate { url, .. } if url == "about:blank") {
            return Ok(None);
        }
        let url = reqwest::Url::parse(self.url())
            .map_err(|error| ToolError::Failed(format!("invalid browser URL: {error}")))?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(ToolError::Failed(
                "browser document access requires a verified origin; navigation supports HTTP(S) and about:blank".into(),
            ));
        }
        Ok(Some(url.origin().ascii_serialization()))
    }
}

/// Implemented by the embedding Host using its actual invocation and grants.
/// `check` never requests a new grant, including for asynchronous page events.
pub trait BrowserAuthorization: Send + Sync {
    fn authorize(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture;
    fn check(&self, access: BrowserAccess, cancellation: CancellationToken) -> AuthorizationFuture;
    /// Admit only the audited fixed session machinery. Missing Host support
    /// refuses before dispatch; it cannot fall back to Metadata or site consent.
    fn authorize_session_preparation(
        &self,
        _preparation: BrowserSessionPreparation,
        _cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        Box::pin(async {
            Err(ToolError::Failed(
                "Browser session preparation requires Host authorization".into(),
            ))
        })
    }
    /// Recheck current authority without requesting a new grant.
    fn check_session_preparation(
        &self,
        _preparation: BrowserSessionPreparation,
        _cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        Box::pin(async {
            Err(ToolError::Failed(
                "Browser session preparation requires Host authorization".into(),
            ))
        })
    }
    /// Browser-wide history is independent of page/site and download consent.
    /// Implementations must bind the current native operation and permission basis.
    fn authorize_history(
        &self,
        _request: BrowserSessionPreparation,
        _cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        Box::pin(async {
            Err(ToolError::Failed(
                "Browser history requires Host authorization".into(),
            ))
        })
    }
    /// Recheck history consent without prompting or replaying its original query.
    fn check_history(
        &self,
        _request: BrowserSessionPreparation,
        _cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        Box::pin(async {
            Err(ToolError::Failed(
                "Browser history requires Host authorization".into(),
            ))
        })
    }
    fn attachment(&self) -> Option<Arc<dyn BrowserAttachmentAuthorization>> {
        None
    }
}

enum CompletionOutcome {
    Ready(serde_json::Value),
    Pending(Pin<Box<dyn Future<Output = Result<serde_json::Value, ToolError>> + Send + 'static>>),
}

/// An already admitted operation whose remaining observation owns no Session borrow.
#[must_use]
pub struct InvocationCompletion {
    outcome: CompletionOutcome,
}

impl std::fmt::Debug for InvocationCompletion {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("InvocationCompletion")
            .field("pending", &self.is_pending())
            .finish()
    }
}

impl InvocationCompletion {
    pub(crate) fn ready(value: serde_json::Value) -> Self {
        Self {
            outcome: CompletionOutcome::Ready(value),
        }
    }

    pub(crate) fn pending(
        future: impl Future<Output = Result<serde_json::Value, ToolError>> + Send + 'static,
    ) -> Self {
        Self {
            outcome: CompletionOutcome::Pending(Box::pin(future)),
        }
    }

    /// Whether this completion still observes an admitted asynchronous operation.
    pub fn is_pending(&self) -> bool {
        matches!(self.outcome, CompletionOutcome::Pending(_))
    }

    /// Observe the same operation after releasing the embedding Session lock.
    ///
    /// # Errors
    /// Returns the operation's original failure or unconfirmed settlement.
    pub async fn wait(self) -> Result<serde_json::Value, ToolError> {
        match self.outcome {
            CompletionOutcome::Ready(value) => Ok(value),
            CompletionOutcome::Pending(future) => future.await,
        }
    }
}

/// Trusted Host context. It is never deserialized from a model command.
#[derive(Clone)]
pub struct InvocationContext<'a> {
    session: &'a str,
    turn: &'a str,
    operation_id: Option<String>,
    native_interruption_observer: Option<Arc<dyn crate::NativeInterruptionObserver>>,
    browser_authorization: Option<Arc<dyn BrowserAuthorization>>,
    operation_settlement: Option<Arc<dyn OperationSettlement>>,
    browser_host_effects: Option<Arc<dyn BrowserHostEffects>>,
    browser_asset_files: Option<Arc<dyn crate::BrowserAssetFiles>>,
    app_target: Option<crate::ComputerAppTarget>,
    #[cfg(feature = "native-desktop")]
    browser_services: Option<Arc<dyn BrowserServicesProvider>>,
    browser_preparation_policy: BrowserPreparationPolicy,
}

/// Owned inputs of the same admitted invocation while a deferred observation runs.
/// No grant, target or operation is created by this capture.
#[cfg(feature = "native-desktop")]
pub(crate) struct OwnedInvocationContext {
    session: String,
    turn: String,
    operation_id: Option<String>,
    native_interruption_observer: Option<Arc<dyn crate::NativeInterruptionObserver>>,
    browser_authorization: Option<Arc<dyn BrowserAuthorization>>,
    operation_settlement: Option<Arc<dyn OperationSettlement>>,
    browser_host_effects: Option<Arc<dyn BrowserHostEffects>>,
    browser_asset_files: Option<Arc<dyn crate::BrowserAssetFiles>>,
    app_target: Option<crate::ComputerAppTarget>,
    #[cfg(feature = "native-desktop")]
    browser_services: Option<Arc<dyn BrowserServicesProvider>>,
    browser_preparation_policy: BrowserPreparationPolicy,
}
#[cfg(feature = "native-desktop")]
impl OwnedInvocationContext {
    pub(crate) fn borrow(&self) -> InvocationContext<'_> {
        InvocationContext {
            session: &self.session,
            turn: &self.turn,
            operation_id: self.operation_id.clone(),
            native_interruption_observer: self.native_interruption_observer.clone(),
            browser_authorization: self.browser_authorization.clone(),
            operation_settlement: self.operation_settlement.clone(),
            browser_host_effects: self.browser_host_effects.clone(),
            browser_asset_files: self.browser_asset_files.clone(),
            app_target: self.app_target.clone(),
            #[cfg(feature = "native-desktop")]
            browser_services: self.browser_services.clone(),
            browser_preparation_policy: self.browser_preparation_policy.clone(),
        }
    }
}

impl<'a> InvocationContext<'a> {
    #[cfg(feature = "native-desktop")]
    pub(crate) fn capture(&self) -> OwnedInvocationContext {
        OwnedInvocationContext {
            session: self.session.to_owned(),
            turn: self.turn.to_owned(),
            operation_id: self.operation_id.clone(),
            native_interruption_observer: self.native_interruption_observer.clone(),
            browser_authorization: self.browser_authorization.clone(),
            operation_settlement: self.operation_settlement.clone(),
            browser_host_effects: self.browser_host_effects.clone(),
            browser_asset_files: self.browser_asset_files.clone(),
            app_target: self.app_target.clone(),
            #[cfg(feature = "native-desktop")]
            browser_services: self.browser_services.clone(),
            browser_preparation_policy: self.browser_preparation_policy.clone(),
        }
    }

    pub fn new(session: &'a str, turn: &'a str) -> Self {
        Self {
            session,
            turn,
            operation_id: None,
            native_interruption_observer: None,
            browser_authorization: None,
            operation_settlement: None,
            browser_host_effects: None,
            browser_asset_files: None,
            app_target: None,
            #[cfg(feature = "native-desktop")]
            browser_services: None,
            browser_preparation_policy: BrowserPreparationPolicy::default(),
        }
    }

    #[cfg(feature = "native-desktop")]
    pub(crate) fn with_browser_services(
        mut self,
        services: Arc<dyn BrowserServicesProvider>,
    ) -> Self {
        self.browser_services = Some(services);
        self
    }
    #[cfg(feature = "native-desktop")]
    pub(crate) async fn prepare_browser_services(
        &self,
        access: BrowserAccess,
        cancellation: &CancellationToken,
    ) -> Result<BrowserServices, ToolError> {
        match &self.browser_services {
            Some(services) => services.prepare(access, cancellation.clone()).await,
            None => Ok(BrowserServices {
                files: self.browser_asset_files.clone(),
                attachment: self
                    .browser_authorization
                    .as_ref()
                    .and_then(|authorization| authorization.attachment()),
                effects: self.browser_host_effects.clone(),
                settlement: self.operation_settlement.clone(),
            }),
        }
    }

    /// Explicit settings from the embedding Host, never model command fields.
    pub fn with_browser_preparation_policy(mut self, policy: BrowserPreparationPolicy) -> Self {
        self.browser_preparation_policy = policy;
        self
    }

    pub(crate) fn browser_preparation_policy(&self) -> &BrowserPreparationPolicy {
        &self.browser_preparation_policy
    }

    #[cfg(feature = "native-desktop")]
    pub(crate) async fn authorize_session_preparation(
        &self,
        preparation: &BrowserSessionPreparation,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        self.session_preparation(preparation, cancellation, false)
            .await
    }

    #[cfg(feature = "native-desktop")]
    pub(crate) async fn check_session_preparation(
        &self,
        preparation: &BrowserSessionPreparation,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        self.session_preparation(preparation, cancellation, true)
            .await
    }

    #[cfg(feature = "native-desktop")]
    async fn session_preparation(
        &self,
        preparation: &BrowserSessionPreparation,
        cancellation: &CancellationToken,
        check: bool,
    ) -> Result<(), ToolError> {
        let operation = self.operation_id().ok_or_else(|| {
            ToolError::Failed(
                "Browser session preparation requires an original Host operation".into(),
            )
        })?;
        preparation.check_scope(self.turn(), operation)?;
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Browser session preparation cancelled".into(),
            ));
        }
        let authorization = self.browser_authorization.as_ref().ok_or_else(|| {
            ToolError::Failed("Browser session preparation requires Host authorization".into())
        })?;
        if check {
            authorization
                .check_session_preparation(preparation.clone(), cancellation.clone())
                .await?;
        } else {
            authorization
                .authorize_session_preparation(preparation.clone(), cancellation.clone())
                .await?;
        }
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed(
                "Browser session preparation cancelled".into(),
            ));
        }
        Ok(())
    }

    pub fn with_browser_authorization(
        mut self,
        authorization: Arc<dyn BrowserAuthorization>,
    ) -> Self {
        self.browser_authorization = Some(authorization);
        self
    }

    /// Bind the existing Host journal operation; never supplied by a tool payload.
    pub fn with_operation_id(mut self, operation_id: String) -> Self {
        self.operation_id = Some(operation_id);
        self
    }

    /// Bind the native-only interruption writer from this actual Host scope.
    /// This observer grants no native action and never comes from tool args.
    pub fn with_native_interruption_observer(
        mut self,
        observer: Arc<dyn crate::NativeInterruptionObserver>,
    ) -> Self {
        self.native_interruption_observer = Some(observer);
        self
    }

    pub(crate) fn native_interruption_observer(
        &self,
    ) -> Option<Arc<dyn crate::NativeInterruptionObserver>> {
        self.native_interruption_observer.clone()
    }

    pub(crate) fn operation_id(&self) -> Option<&str> {
        self.operation_id.as_deref()
    }

    pub fn session(&self) -> &str {
        self.session
    }

    pub fn with_operation_settlement(mut self, settlement: Arc<dyn OperationSettlement>) -> Self {
        self.operation_settlement = Some(settlement);
        self
    }

    pub fn with_browser_asset_files(mut self, files: Arc<dyn crate::BrowserAssetFiles>) -> Self {
        self.browser_asset_files = Some(files);
        self
    }
    pub(crate) fn browser_asset_files(&self) -> Option<Arc<dyn crate::BrowserAssetFiles>> {
        self.browser_asset_files.clone()
    }
    pub fn with_browser_host_effects(mut self, effects: Arc<dyn BrowserHostEffects>) -> Self {
        self.browser_host_effects = Some(effects);
        self
    }

    pub(crate) fn operation_settlement(&self) -> Option<Arc<dyn OperationSettlement>> {
        self.operation_settlement.clone()
    }

    pub(crate) fn browser_host_effects(&self) -> Option<Arc<dyn BrowserHostEffects>> {
        self.browser_host_effects.clone()
    }

    /// Freeze the native subject for this invocation. Approval remains Host-owned.
    pub fn with_app_target(mut self, target: crate::ComputerAppTarget) -> Self {
        self.app_target = Some(target);
        self
    }

    pub fn app_target(&self) -> Option<&crate::ComputerAppTarget> {
        self.app_target.as_ref()
    }

    pub fn turn(&self) -> &str {
        self.turn
    }

    pub(crate) fn browser_authorization(&self) -> Option<Arc<dyn BrowserAuthorization>> {
        self.browser_authorization.clone()
    }

    #[cfg(feature = "native-desktop")]
    pub(crate) async fn authorize_browser(
        &self,
        access: BrowserAccess,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed("Browser authorization cancelled".into()));
        }
        // A verified opaque document has no site grant, but still requires the
        // original Host's current Computer Use, Session and policy admission.
        if access.origin()?.is_none()
            && !matches!(
                access,
                BrowserAccess::Metadata { .. }
                    | BrowserAccess::ReadDocument { .. }
                    | BrowserAccess::Download { .. }
                    | BrowserAccess::PageAssetDownload { .. }
                    | BrowserAccess::PageAssetFallbackFetch { .. }
            )
        {
            return Ok(());
        }
        let authorization = self.browser_authorization.as_ref().ok_or_else(|| {
            ToolError::Failed("Browser site access requires Host authorization".into())
        })?;
        authorization
            .authorize(access, cancellation.clone())
            .await?;
        if cancellation.is_cancelled() {
            return Err(ToolError::Failed("Browser authorization cancelled".into()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod origin_tests {
    use super::*;

    fn document(url: &str) -> BrowserDocument {
        BrowserDocument {
            browser_id: "native-test".into(),
            generation: "generation-A".into(),
            tab_id: "41".into(),
            url: url.into(),
        }
    }

    fn read_document(url: &str, origin: BrowserAttachmentOrigin) -> BrowserAccess {
        BrowserAccess::ReadDocument {
            document: document(url),
            origin,
        }
    }

    #[test]
    fn inherited_document_uses_verified_origin_instead_of_display_url() {
        for url in ["about:blank", "about:blank?x#y", "about:srcdoc"] {
            let access = read_document(
                url,
                BrowserAttachmentOrigin::Site("https://inherited.example".into()),
            );
            assert_eq!(
                access.origin().expect("canonical observed origin"),
                Some("https://inherited.example".into()),
                "display URL {url} must not replace observed origin"
            );
            assert_eq!(access.url(), url, "display URL remains metadata");
        }
    }

    #[test]
    fn typed_site_requires_canonical_http_origin() {
        for origin in [
            "null",
            "://",
            "file:///tmp/page",
            "https://example.test/path",
            "https://example.test/",
            "https://user@example.test",
            "https://example.test?grant=true",
            "https://example.test#grant",
            "https://EXAMPLE.test",
            "https://example.test:443",
        ] {
            let access = read_document("about:blank", BrowserAttachmentOrigin::Site(origin.into()));
            assert!(access.origin().is_err(), "invalid origin {origin:?}");
        }
        for origin in [
            "https://example.test",
            "http://127.0.0.1:41297",
            "https://[::1]:8443",
        ] {
            assert_eq!(
                read_document("about:blank", BrowserAttachmentOrigin::Site(origin.into()))
                    .origin()
                    .expect("canonical observed origin"),
                Some(origin.into()),
                "canonical origin {origin:?}"
            );
        }
    }

    #[test]
    fn verified_opaque_is_distinct_from_unverified_legacy_blank() {
        assert_eq!(
            read_document("about:blank", BrowserAttachmentOrigin::Opaque)
                .origin()
                .expect("verified opaque serialization"),
            None
        );
        for url in [
            "about:blank",
            "about:blank?x#y",
            "about:srcdoc",
            "chrome://newtab/",
        ] {
            assert!(
                BrowserAccess::Read {
                    document: document(url)
                }
                .origin()
                .is_err(),
                "legacy read must not infer an opaque origin from {url}"
            );
        }
    }

    #[test]
    fn navigation_authorizes_destination_without_relabeling_source_document() {
        let access = BrowserAccess::Navigate {
            document: document("https://source.example/private"),
            url: "https://destination.example/path".into(),
        };
        assert_eq!(
            access.origin().expect("valid destination"),
            Some("https://destination.example".into())
        );
        assert_eq!(access.document().url, "https://source.example/private");
        let services = read_document(
            &access.document().url,
            BrowserAttachmentOrigin::Site("https://source.example".into()),
        );
        assert_eq!(
            services.origin().expect("valid current-document origin"),
            Some("https://source.example".into())
        );
    }

    #[test]
    fn read_document_wire_roundtrip_preserves_source_identity_and_origin() {
        let access = read_document(
            "about:blank",
            BrowserAttachmentOrigin::Site("https://inherited.example".into()),
        );
        let wire = serde_json::to_value(&access).expect("serialize access");
        assert_eq!(wire["kind"], "read_document");
        assert_eq!(
            wire["origin"],
            serde_json::json!({
                "kind":"site", "value":"https://inherited.example"
            })
        );
        assert_eq!(
            serde_json::from_value::<BrowserAccess>(wire).expect("deserialize access"),
            access
        );
    }

    #[test]
    fn read_document_wire_rejects_missing_or_extra_origin_evidence() {
        let doc = serde_json::to_value(document("about:blank")).expect("serialize document");
        for origin in [
            serde_json::Value::Null,
            serde_json::json!({"kind":"site"}),
            serde_json::json!({"kind":"site","value":"https://example.test","fromPage":true}),
            serde_json::json!({"kind":"unknown"}),
        ] {
            assert!(
                serde_json::from_value::<BrowserAccess>(serde_json::json!({
                    "kind":"read_document", "document":doc.clone(), "origin":origin
                }))
                .is_err(),
                "malformed or unverified origin must not become a ReadDocument"
            );
        }
    }

    #[cfg(feature = "native-desktop")]
    #[tokio::test]
    async fn verified_opaque_and_new_metadata_still_run_host_admission() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct RefusingHost(Arc<AtomicUsize>);
        impl BrowserAuthorization for RefusingHost {
            fn authorize(
                &self,
                access: BrowserAccess,
                _: CancellationToken,
            ) -> AuthorizationFuture {
                self.0.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    assert_eq!(
                        access.origin()?,
                        None,
                        "Host receives verified opaque access"
                    );
                    Err(ToolError::Failed("current Host grant refused".into()))
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
        let calls = Arc::new(AtomicUsize::new(0));
        let invocation = InvocationContext::new("session-A", "turn-A")
            .with_browser_authorization(Arc::new(RefusingHost(calls.clone())));
        for access in [
            read_document("about:blank", BrowserAttachmentOrigin::Opaque),
            BrowserAccess::Metadata {
                document: document("https://denied.example/private"),
            },
        ] {
            assert!(
                invocation
                    .authorize_browser(access.clone(), &CancellationToken::new())
                    .await
                    .is_err()
            );
            assert!(
                InvocationContext::new("session-A", "turn-A")
                    .authorize_browser(access, &CancellationToken::new())
                    .await
                    .is_err(),
                "new metadata and verified opaque scopes require the Host capability"
            );
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "new no-site scopes must run current Host admission"
        );
    }

    #[cfg(feature = "native-desktop")]
    #[tokio::test]
    async fn ordinary_blank_navigation_keeps_its_existing_no_site_behavior() {
        InvocationContext::new("session-A", "turn-A")
            .authorize_browser(
                BrowserAccess::Navigate {
                    document: document("https://source.example/private"),
                    url: "about:blank".into(),
                },
                &CancellationToken::new(),
            )
            .await
            .unwrap();
    }
}

#[cfg(all(test, feature = "native-desktop"))]
mod session_preparation_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn request() -> BrowserSessionPreparation {
        BrowserSessionPreparation {
            native_owner: uuid::Uuid::new_v4(),
            native_epoch: "epoch-1".into(),
            browser_id: "owned-native".into(),
            generation: "generation-1".into(),
            turn_id: "turn-1".into(),
            operation_id: "operation-1".into(),
            target: BrowserPreparationTarget::ReservedTab {
                tab_id: "17".into(),
            },
        }
    }

    struct ExistingSiteAuthorization;
    impl BrowserAuthorization for ExistingSiteAuthorization {
        fn authorize(&self, _: BrowserAccess, _: CancellationToken) -> AuthorizationFuture {
            Box::pin(async { Ok(()) })
        }
        fn check(&self, _: BrowserAccess, _: CancellationToken) -> AuthorizationFuture {
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn ordinary_browser_host_and_standalone_cannot_admit_session_preparation() {
        let invocation =
            InvocationContext::new("session-1", "turn-1").with_operation_id("operation-1".into());
        let request = request();
        assert!(
            matches!(invocation.authorize_session_preparation(&request, &CancellationToken::new()).await,
            Err(ToolError::Failed(message)) if message.contains("requires Host authorization"))
        );
        let invocation = invocation.with_browser_authorization(Arc::new(ExistingSiteAuthorization));
        let admitted = invocation
            .authorize_session_preparation(&request, &CancellationToken::new())
            .await;
        assert!(
            admitted.is_err(),
            "ordinary BrowserAuthorization does not implement this distinct purpose"
        );
    }

    struct CountingAuthorization(Arc<AtomicUsize>);
    impl BrowserAuthorization for CountingAuthorization {
        fn authorize(&self, _: BrowserAccess, _: CancellationToken) -> AuthorizationFuture {
            Box::pin(async { Ok(()) })
        }
        fn check(&self, _: BrowserAccess, _: CancellationToken) -> AuthorizationFuture {
            Box::pin(async { Ok(()) })
        }
        fn authorize_session_preparation(
            &self,
            _: BrowserSessionPreparation,
            _: CancellationToken,
        ) -> AuthorizationFuture {
            self.0.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
    }

    #[tokio::test]
    async fn changed_capture_or_cancel_refuses_before_the_host_callback() {
        let calls = Arc::new(AtomicUsize::new(0));
        let invocation = InvocationContext::new("session-1", "turn-1")
            .with_operation_id("operation-1".into())
            .with_browser_authorization(Arc::new(CountingAuthorization(calls.clone())));
        let mut changed = request();
        changed.turn_id = "ended-turn".into();
        assert!(
            invocation
                .authorize_session_preparation(&changed, &CancellationToken::new())
                .await
                .is_err()
        );
        changed = request();
        changed.operation_id = "old-operation".into();
        assert!(
            invocation
                .authorize_session_preparation(&changed, &CancellationToken::new())
                .await
                .is_err()
        );
        let cancellation = CancellationToken::new();
        cancellation.cancel();
        assert!(
            invocation
                .authorize_session_preparation(&request(), &cancellation)
                .await
                .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn effective_popup_keeps_all_four_requested_policy_combinations() {
        for (popup, headers, expected) in [
            (false, false, false),
            (true, false, true),
            (false, true, true),
            (true, true, true),
        ] {
            let policy = BrowserPreparationPolicy {
                popup_enabled: popup,
                headers: if headers {
                    vec![BrowserPreparationHeader {
                        name: "x-own-profile".into(),
                        value: "fixture".into(),
                    }]
                } else {
                    vec![]
                },
            };
            assert_eq!(policy.effective_popup(), expected);
        }
    }
}

#[cfg(test)]
mod browser_subject_wire_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lease_child_requires_the_new_typed_opener_and_rejects_old_scalar_layout() {
        let mut old = json!({
            "browserId":"browser","generation":"generation",
            "nativeOwner":uuid::Uuid::new_v4(),"nativeEpoch":"1",
            "turnId":"turn","completionId":1,
            "openerClaimId":"old-scalar","openerTabId":7,"url":"https://fixture.invalid/"
        });
        assert!(serde_json::from_value::<BrowserLeaseChildRequest>(old.clone()).is_err());
        old.as_object_mut().unwrap().remove("openerClaimId");
        old["openerSubject"] = json!({"kind":"fixed_session","scopeId":"observed-scope"});
        let request = serde_json::from_value::<BrowserLeaseChildRequest>(old).unwrap();
        assert!(matches!(
            request.opener_subject,
            crate::BrowserLeaseSubject::FixedSession { .. }
        ));
        // A successful decode is routing only, never an SDK-issued receipt.
        assert_eq!(request.opener_tab_id, 7);
    }
}

#[cfg(test)]
mod browser_history_authorization_tests {
    use super::*;

    struct PageOnly;
    impl BrowserAuthorization for PageOnly {
        fn authorize(&self, _: BrowserAccess, _: CancellationToken) -> AuthorizationFuture {
            Box::pin(async { Ok(()) })
        }
        fn check(&self, _: BrowserAccess, _: CancellationToken) -> AuthorizationFuture {
            Box::pin(async { Ok(()) })
        }
    }
    fn request() -> BrowserSessionPreparation {
        BrowserSessionPreparation {
            native_owner: uuid::Uuid::new_v4(),
            native_epoch: "epoch".to_owned(),
            browser_id: "maka:exact-instance".to_owned(),
            generation: "generation".to_owned(),
            turn_id: "turn".to_owned(),
            operation_id: "operation".to_owned(),
            target: BrowserPreparationTarget::SessionHistory,
        }
    }
    #[tokio::test]
    async fn page_authorization_never_grants_history_by_default() {
        assert!(
            matches!(PageOnly.authorize_history(request(), CancellationToken::new()).await,
            Err(ToolError::Failed(message)) if message == "Browser history requires Host authorization")
        );
        assert!(
            matches!(PageOnly.check_history(request(), CancellationToken::new()).await,
            Err(ToolError::Failed(message)) if message == "Browser history requires Host authorization")
        );
    }
}
