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

use super::ownership::{Creator, Disposition, Lease, MarkFailure, Origin, Retention, TabMark};
use super::*;
use cua_driver_core::browser::{
    CleanupProof, ExtensionAttachmentPreparation, ExtensionBrowserProvider,
    ExtensionClaimCdpDrainProof, ExtensionClaimPreparationProof, ExtensionCreatedTab,
    ExtensionCreationReceipt, ExtensionEffectOwner, ExtensionFixedSessionReceipt,
    ExtensionGroupColor, ExtensionGroupPresentation, ExtensionHeader, ExtensionHeaderPolicyScope,
    ExtensionHostOperation, ExtensionManagedGroupReceipt, ExtensionOperation,
    ExtensionPhysicalClaim, ExtensionPopupRequest, ExtensionPreparationDocument,
    ExtensionPreparationPolicy, ExtensionProviderEvent, ExtensionRecoveredOperation,
    ExtensionSessionHeaderProof, ExtensionSessionPopupRequest, ExtensionSessionPreparation,
    ExtensionSessionRequestRegistration, ExtensionUserTabsOrder, ExtensionWireContext,
};
fn mark_to_core(mark: TabMark) -> cua_driver_core::browser::ExtensionKeepStatus {
    match mark {
        TabMark::Handoff => cua_driver_core::browser::ExtensionKeepStatus::Handoff,
        TabMark::Deliverable => cua_driver_core::browser::ExtensionKeepStatus::Deliverable,
    }
}
fn mark_from_core(mark: cua_driver_core::browser::ExtensionKeepStatus) -> TabMark {
    match mark {
        cua_driver_core::browser::ExtensionKeepStatus::Handoff => TabMark::Handoff,
        cua_driver_core::browser::ExtensionKeepStatus::Deliverable => TabMark::Deliverable,
    }
}

mod fixed_session;
mod upload;
pub(super) use fixed_session::{
    FixedCleanupPurpose, FixedPresentationScope, configure_fixed_session_ui,
};
use fixed_session::{FixedPreparation, prepare_fixed_tab};
use std::{
    collections::HashSet,
    sync::{
        Arc, Weak,
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
    },
};
use tokio_util::sync::CancellationToken;
pub(super) use upload::UploadControl;

// Add beside the existing CallScope and Host implementations in extension.rs.
struct UserContextReader<'call, 'invocation> {
    scope: CallScope,
    host: Arc<tokio::sync::Mutex<Host>>,
    document: crate::BrowserDocument,
    invocation: &'call crate::InvocationContext<'invocation>,
    cancellation: &'call CancellationToken,
}
impl UserContextReader<'_, '_> {
    async fn check(&self) -> Result<(), ToolError> {
        check_input(self.cancellation)?;
        self.host
            .lock()
            .await
            .user_context_current(&self.scope, &self.document)?;
        let authorization = self
            .invocation
            .browser_authorization()
            .ok_or_else(|| failed("Browser site access requires Host authorization"))?;
        for access in [
            crate::BrowserAccess::Metadata {
                document: self.document.clone(),
            },
            crate::BrowserAccess::Read {
                document: self.document.clone(),
            },
        ] {
            authorization
                .check(access, self.cancellation.clone())
                .await?;
        }
        self.host
            .lock()
            .await
            .user_context_current(&self.scope, &self.document)?;
        check_input(self.cancellation)
    }
}
impl super::context::UserTabReader for UserContextReader<'_, '_> {
    async fn read(
        &self,
        request: cua_driver_core::browser::BrowserUserTabRead,
    ) -> Result<Value, ToolError> {
        self.check().await?;
        let tab_id = cua_driver_core::browser::parse_browser_tab_id(&self.document.tab_id)
            .ok_or_else(|| failed("extension tab ID must convert to a positive safe integer"))?;
        let value =
            self.scope
                .dispatch(
                    self.scope
                        .control
                        .read_user_tab(tab_id, &self.document.url, request),
                )
                .await
                .map_err(|error| match error.as_ref() {
                    cua_driver_core::browser::ExtensionProviderError::ChromeRejected {
                        message,
                        ..
                    }
                    | cua_driver_core::browser::ExtensionProviderError::Refused {
                        message, ..
                    } if message == "The selected tab changed while being read" => failed(message),
                    cua_driver_core::browser::ExtensionProviderError::OutcomeUnknown {
                        details: Some(details),
                        ..
                    } if details.get("remoteMessage").and_then(Value::as_str)
                        == Some("The selected tab changed while being read") =>
                    {
                        // Preserve the source error for export fallback decisions.
                        // This does not erase the scope's logical Finish obligation.
                        failed("The selected tab changed while being read")
                    }
                    error => provider::extension_error(error),
                })?;
        self.check().await?;
        Ok(value)
    }
}
impl Host {
    fn user_context_current(
        &self,
        scope: &CallScope,
        document: &crate::BrowserDocument,
    ) -> Result<(), ToolError> {
        let extension = scope
            .provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?;
        let browser = BrowserIdentity::of(&scope.provider, &extension.identity().generation)?;
        self.known(&browser)?;
        let tab = browser.tab(&document.tab_id);
        if scope.purpose != CallPurpose::UserContext
            || scope.target.as_deref() != Some(document.tab_id.as_str())
            || extension.is_closed()
            || document.browser_id != scope.provider.id()
            || document.generation != extension.identity().generation
            || !self.visible(&tab, scope.owner)
        {
            return Err(failed(
                "user-tab context is outside its current visible provider scope",
            ));
        }
        let state = self
            .extension
            .get(&(scope.owner, browser))
            .ok_or_else(|| failed("user-tab context provider retired"))?;
        let call = state
            .calls
            .get(&scope.context.operation_id)
            .ok_or_else(|| failed("user-tab context lost its original Host operation"))?;
        if state.current_turn.as_deref() != Some(scope.context.turn_id.as_str())
            || state.retiring_turn.is_some()
            || state.headers_unknown
            || call.epoch != scope.epoch
            || call.turn != scope.context.turn_id
            || !call.purposes.contains(&CallPurpose::UserContext)
            || call.controls.is_sealed()
            || !Arc::ptr_eq(&call.issuing, &scope.issuing)
            || !Arc::ptr_eq(&call.activation, &scope.activation)
            || !Arc::ptr_eq(&call.controls, &scope.controls)
        {
            return Err(ToolError::CleanupUnconfirmed(
                "user-tab context call is no longer current".into(),
            ));
        }
        Ok(())
    }
}
impl Browsers {
    pub(super) async fn user_tab_context(
        &self,
        browser_id: &str,
        raw_id: &str,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
    ) -> Result<Value, ToolError> {
        let provider = self
            .providers(Some(browser_id))?
            .pop()
            .ok_or_else(|| failed("requested browser provider is unavailable"))?;
        let extension = provider.extension().cloned().ok_or_else(|| {
            failed("browser.user.getTabContext requires a connected extension adapter")
        })?;
        if !extension
            .capabilities()
            .map_err(provider::extension_error)?
            .user_tab_context_read
        {
            return Err(failed(
                "selected browser extension does not support browser.user.getTabContext",
            ));
        }
        let id = cua_driver_core::browser::parse_browser_tab_id(raw_id)
            .ok_or_else(|| failed("extension tab ID must convert to a positive safe integer"))?;
        // Match the selected Original security path: the authorized URL comes
        // from actual user inventory, never a model argument or a bound-tab URL.
        let rows = extension
            .list_user_tabs()
            .await
            .map_err(provider::extension_error)?;
        let browser = BrowserIdentity::of(&provider, &extension.identity().generation)?;
        let host = self.host().await;
        let url = {
            let ledger = host.lock().await;
            ledger.known(&browser)?;
            if !ledger.visible(&browser.tab(&id.to_string()), self.owner) {
                return Err(failed("selected user tab is not visible to this session"));
            }
            rows.iter()
                .find(|tab| tab.id == id)
                .and_then(|tab| tab.url.as_deref())
                .filter(|url| !url.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| failed("Missing authorized user tab URL"))?
        };
        let parsed = reqwest::Url::parse(&url)
            .map_err(|_| failed("Tab reads require an HTTP or HTTPS URL"))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(failed("Tab reads require an HTTP or HTTPS URL"));
        }
        let document = crate::BrowserDocument {
            browser_id: provider.id().to_owned(),
            generation: extension.identity().generation.clone(),
            tab_id: id.to_string(),
            url,
        };
        invocation
            .authorize_browser(
                crate::BrowserAccess::Metadata {
                    document: document.clone(),
                },
                cancellation,
            )
            .await?;
        invocation
            .authorize_browser(
                crate::BrowserAccess::Read {
                    document: document.clone(),
                },
                cancellation,
            )
            .await?;
        let scope = host.lock().await.extension_context(
            self.owner,
            &provider,
            operation(invocation)?,
            self.epoch,
            CallTarget::UserContext {
                tab: document.tab_id.clone(),
            },
            true,
        )?;
        let reader = UserContextReader {
            scope,
            host,
            document,
            invocation,
            cancellation,
        };
        reader.check().await?;
        let context = super::context::read_context(&reader, &reader.document.url).await?;
        reader.check().await?;
        let services = invocation
            .prepare_browser_services(
                crate::BrowserAccess::Read {
                    document: reader.document.clone(),
                },
                cancellation,
            )
            .await?;
        if let Some(files) = services.files {
            reader.check().await?;
            super::context::publish_document(context, files.as_ref(), cancellation).await
        } else {
            Ok(context)
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ClaimIntent {
    Implicit,
    Explicit,
}

#[derive(Clone, Default)]
enum FocusReadiness {
    #[default]
    NotAttempted,
    Pending,
    Completed,
    Unknown(String),
}

// A coupled record captured only from an actual acknowledged acquisition.
// It preserves provenance/order through physical detach, not current permission.
#[derive(Clone)]
pub(super) struct Acquisition {
    owner: uuid::Uuid,
    identity: TabIdentity,
    operation: ExtensionHostOperation,
    epoch: crate::desktop::NativeEpochId,
    sequence: u64,
}
impl Acquisition {
    pub(super) fn turn(&self) -> &str {
        &self.operation.turn_id
    }
}

#[derive(Clone, Default)]
enum ControlCleanup {
    #[default]
    NotAttempted,
    Pending,
    Confirmed,
    Unconfirmed(String),
}

#[derive(Clone, Default)]
enum UserPreparation {
    #[default]
    NotAttempted,
    Pending(ExtensionHostOperation),
    Completed,
    Unknown(String),
}

#[derive(Clone)]
struct CreatedOperation {
    operation: ExtensionHostOperation,
    epoch: crate::desktop::NativeEpochId,
}

#[derive(Clone)]
enum PreparedOperation {
    Observed,
    Acquired {
        operation: ExtensionHostOperation,
        epoch: crate::desktop::NativeEpochId,
    },
}

#[derive(Clone)]
struct PreparationAcknowledgement {
    proof: ExtensionClaimPreparationProof,
    policy: Arc<ExtensionPreparationPolicy>,
}

#[derive(Clone)]
struct PreparationAttempt {
    document: ExtensionPreparationDocument,
    policy: Arc<ExtensionPreparationPolicy>,
    wire: ExtensionWireContext,
    operation: ExtensionHostOperation,
    previous: Option<PreparationAcknowledgement>,
    effects: PreparationEffectSnapshot,
}

#[derive(Clone, Copy)]
struct PreparationEffectSnapshot {
    new_scope: bool,
    previous_headers: bool,
}

#[derive(Clone, Default)]
enum ClaimPreparation {
    #[default]
    NotAttempted,
    Pending(Arc<PreparationAttempt>),
    Acknowledged(PreparationAcknowledgement),
    Unknown {
        attempt: Arc<PreparationAttempt>,
        acknowledgement: Option<ExtensionClaimPreparationProof>,
        reason: String,
    },
}

#[derive(Clone, Default)]
struct PreparationEffects {
    scopes: Vec<ExtensionWireContext>,
    headers_may_exist: bool,
}
impl PreparationEffects {
    fn begin(&mut self, wire: &ExtensionWireContext, headers: bool) -> PreparationEffectSnapshot {
        let new_scope = !self.scopes.contains(wire);
        if new_scope {
            self.scopes.push(wire.clone());
        }
        let previous_headers = self.headers_may_exist;
        self.headers_may_exist |= headers;
        PreparationEffectSnapshot {
            new_scope,
            previous_headers,
        }
    }
    fn refused(&mut self, wire: &ExtensionWireContext, snapshot: PreparationEffectSnapshot) {
        if snapshot.new_scope {
            self.scopes.retain(|scope| scope != wire);
        }
        self.headers_may_exist &= snapshot.previous_headers;
    }
    fn fixed_cleanup(&mut self, wire: &ExtensionWireContext, confirmed: bool) {
        if confirmed {
            self.scopes.retain(|scope| scope != wire);
        } else if !self.scopes.contains(wire) {
            self.scopes.push(wire.clone());
        }
    }
    fn settled(&self) -> bool {
        self.scopes.is_empty() && !self.headers_may_exist
    }
}

#[derive(Clone, Default)]
enum ClaimRetirement {
    #[default]
    NotAttempted,
    Pending,
    Confirmed,
    Unknown(String),
}

/// One authorized replacement attempt in the existing Lease. The old Creator
/// remains authoritative until a matched acquisition acknowledgement commits it.
pub(super) struct HandoffTransfer {
    requested: Creator,
    operation: ExtensionHostOperation,
    epoch: crate::desktop::NativeEpochId,
    previous: ClaimState,
    previous_parked: bool,
    previous_retention: Retention,
    unknown: Option<String>,
    retained_completion: Option<u64>,
    preparation_phase: Arc<AtomicU8>,
    custody: Option<Box<cua_driver_core::browser::ExtensionKnownCustody>>,
}
const HANDOFF_RESERVED: u8 = 0;
const HANDOFF_ENTERED: u8 = 1;
const HANDOFF_RETIRED: u8 = 2;

fn enter_handoff_preparation(
    boundary: Option<&Arc<AtomicU8>>,
) -> Result<(), Box<cua_driver_core::browser::ExtensionProviderError>> {
    if let Some(phase) = boundary {
        phase
            .compare_exchange(
                HANDOFF_RESERVED,
                HANDOFF_ENTERED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            )
            .map_err(|_| {
                Box::new(cua_driver_core::browser::ExtensionProviderError::Refused {
                    kind: "retired_handoff_reservation".into(),
                    message:
                        "explicit handoff reservation retired before entering Core preparation"
                            .into(),
                    details: None,
                })
            })?;
    }
    Ok(())
}

impl HandoffTransfer {
    fn matches(
        &self,
        owner: uuid::Uuid,
        provider: &Provider,
        context: &ExtensionHostOperation,
        epoch: crate::desktop::NativeEpochId,
    ) -> bool {
        self.requested.owner == owner
            && self.requested.provider == *provider
            && self.operation == *context
            && self.epoch == epoch
    }
}

#[derive(Clone, Default)]
enum RetainedPresentation {
    #[default]
    NotAttempted,
    Pending,
    Acknowledged(cua_driver_core::browser::ExtensionRetentionPresentationAck),
    Failed(String),
}

#[derive(Clone, Default)]
pub(super) struct ClaimState {
    claim: Option<ExtensionPhysicalClaim>,
    physical_epoch: Option<crate::desktop::NativeEpochId>,
    creation: Option<ExtensionCreationReceipt>,
    creation_operation: Option<CreatedOperation>,
    group: Option<ExtensionManagedGroupReceipt>,
    retained_group_release: ControlCleanup,
    revoked: bool,
    headers_active: bool,
    active: bool,
    unknown: Option<String>,
    overlay: Option<OverlayScope>,
    lease_children: Option<LeaseChildScope>,
    focus_readiness: FocusReadiness,
    user_preparation: UserPreparation,
    user_prepared_operation: Option<PreparedOperation>,
    claim_preparation: ClaimPreparation,
    fixed_preparation: FixedPreparation,
    preparation_effects: PreparationEffects,
    metadata_attached: bool,
    session_prepared_operation: Option<ExtensionHostOperation>,
    cleanup_started: bool,
    cleanup_revocation: Option<String>,
    physical_cleanup: Option<CleanupProof>,
    cdp_drain: Option<ExtensionClaimCdpDrainProof>,
    cdp_effect_unknown: Option<String>,
    retirement: ClaimRetirement,
    control_cleanup: ControlCleanup,
    released: bool,
    closed: bool,
    presentation_error: Option<String>,
    retained_presentation: RetainedPresentation,
}
impl ClaimState {
    fn finish_preparation_error(
        &mut self,
        operation: Option<&ExtensionHostOperation>,
        refused: bool,
        reason: &str,
    ) {
        let (attempt, acknowledgement) = match &self.claim_preparation {
            ClaimPreparation::Pending(attempt) if operation == Some(&attempt.operation) => {
                (attempt.clone(), None)
            }
            ClaimPreparation::Unknown {
                attempt,
                acknowledgement,
                ..
            } if operation == Some(&attempt.operation) => {
                if refused {
                    return;
                }
                (attempt.clone(), acknowledgement.clone())
            }
            _ => return,
        };
        if refused && acknowledgement.is_none() {
            self.preparation_effects
                .refused(&attempt.wire, attempt.effects);
            self.claim_preparation = attempt.previous.clone().map_or(
                ClaimPreparation::NotAttempted,
                ClaimPreparation::Acknowledged,
            );
        } else {
            self.claim_preparation = ClaimPreparation::Unknown {
                attempt,
                acknowledgement,
                reason: reason.to_owned(),
            };
        }
    }
}

struct BoundExtensionCreated {
    response: Value,
    handle: String,
    identity: TabIdentity,
}

#[derive(Clone)]
struct LeaseChildScope {
    effects: Arc<dyn crate::BrowserHostEffects>,
    turn: String,
    epoch: crate::desktop::NativeEpochId,
}

#[derive(Clone)]
enum PopupSource {
    Physical(ExtensionPopupRequest),
    Fixed(ExtensionSessionPopupRequest),
}

enum PopupOpener {
    Physical(ExtensionPhysicalClaim),
    Fixed(ExtensionFixedSessionReceipt),
}

impl PopupSource {
    fn from_operation(operation: &ExtensionOperation) -> Option<Self> {
        match operation {
            ExtensionOperation::PopupRequested { request } => Some(Self::Physical(request.clone())),
            ExtensionOperation::SessionPopupRequested { request } => {
                Some(Self::Fixed(request.clone()))
            }
            _ => None,
        }
    }
    fn wire_context(&self) -> &ExtensionWireContext {
        match self {
            Self::Physical(request) => request.wire_context(),
            Self::Fixed(request) => request.wire_context(),
        }
    }
    fn tab_id(&self) -> u64 {
        match self {
            Self::Physical(request) => request.tab_id(),
            Self::Fixed(request) => request.tab_id(),
        }
    }
    fn url(&self) -> &str {
        match self {
            Self::Physical(request) => request.url(),
            Self::Fixed(request) => request.url(),
        }
    }
    fn subject(&self) -> crate::BrowserLeaseSubject {
        match self {
            Self::Physical(request) => crate::BrowserLeaseSubject::PhysicalClaim {
                claim_id: request.claim_id().into(),
            },
            Self::Fixed(request) => crate::BrowserLeaseSubject::FixedSession {
                scope_id: request.scope_id().into(),
            },
        }
    }
    fn matches_recovered(&self, recovered: &ExtensionRecoveredOperation) -> bool {
        match (self, recovered) {
            (Self::Physical(left), ExtensionRecoveredOperation::PopupRequested(right)) => {
                same_popup(left, right)
            }
            (Self::Fixed(left), ExtensionRecoveredOperation::SessionPopupRequested(right)) => {
                left.generation() == right.generation()
                    && left.owner() == right.owner()
                    && left.scope_id() == right.scope_id()
                    && left.tab_id() == right.tab_id()
                    && left.wire_context() == right.wire_context()
                    && left.url() == right.url()
                    && left.frame_id() == right.frame_id()
                    && left.document_id() == right.document_id()
                    && left.source_url() == right.source_url()
            }
            _ => false,
        }
    }
    fn preparation_target(&self) -> crate::BrowserPreparationTarget {
        match self {
            Self::Physical(_) => crate::BrowserPreparationTarget::PendingCreation,
            Self::Fixed(request) => crate::BrowserPreparationTarget::FixedSessionTab {
                tab_id: request.tab_id().to_string(),
                scope_id: request.scope_id().into(),
            },
        }
    }
    fn opener(
        &self,
        ledger: &Host,
        owner: uuid::Uuid,
        provider: &Provider,
    ) -> Result<PopupOpener, ToolError> {
        if !ledger.extension_popup_source_current(owner, provider, self) {
            return Err(failed("extension popup source lost its actual custody"));
        }
        let extension = provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?;
        let identity = BrowserIdentity::of(provider, &extension.identity().generation)?
            .tab(&self.tab_id().to_string());
        let state = ledger
            .tabs
            .get(&identity)
            .and_then(|lease| lease.extension.as_ref())
            .ok_or_else(|| failed("extension popup opener custody is unavailable"))?;
        match self {
            Self::Physical(_) => state
                .claim
                .clone()
                .map(PopupOpener::Physical)
                .ok_or_else(|| failed("extension popup opener has no actual physical claim")),
            Self::Fixed(_) => state
                .fixed_preparation
                .ready()
                .map(|prepared| PopupOpener::Fixed(prepared.receipt.clone()))
                .ok_or_else(|| failed("extension popup opener has no actual ready fixed receipt")),
        }
    }
}

#[derive(Clone)]
struct OverlayScope {
    endpoint: super::cursor::CursorEndpoint,
    authorization: Arc<dyn crate::BrowserAttachmentAuthorization>,
    effects: Arc<dyn crate::BrowserHostEffects>,
    cursor: crate::cursor::Spec,
    turn: String,
    epoch: crate::desktop::NativeEpochId,
    origin: crate::BrowserAttachmentOrigin,
    provider: Provider,
    context: ExtensionHostOperation,
}
#[derive(Default)]
struct ControlGate {
    state: std::sync::Mutex<ControlGateState>,
    changed: tokio::sync::Notify,
}
#[derive(Default)]
struct ControlGateState {
    sealed: bool,
    in_flight: usize,
}
struct ControlPermit {
    gate: Arc<ControlGate>,
}
impl ControlGate {
    fn enter(
        self: &Arc<Self>,
    ) -> Result<ControlPermit, Box<cua_driver_core::browser::ExtensionProviderError>> {
        let mut state = self
            .state
            .lock()
            .expect("extension control lifetime lock poisoned");
        if state.sealed {
            return Err(Box::new(
                cua_driver_core::browser::ExtensionProviderError::Refused {
                    kind: "retiring_scope".to_owned(),
                    message: "extension control scope retired before first poll".to_owned(),
                    details: None,
                },
            ));
        }
        state.in_flight += 1;
        Ok(ControlPermit { gate: self.clone() })
    }
    fn seal(&self) {
        self.state
            .lock()
            .expect("extension control lifetime lock poisoned")
            .sealed = true;
    }
    fn is_sealed(&self) -> bool {
        self.state
            .lock()
            .expect("extension control lifetime lock poisoned")
            .sealed
    }
    fn is_idle(&self) -> bool {
        self.state
            .lock()
            .expect("extension control lifetime lock poisoned")
            .in_flight
            == 0
    }
    async fn idle(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self.is_idle() {
                return;
            }
            changed.await;
        }
    }
}
impl Drop for ControlPermit {
    fn drop(&mut self) {
        let idle = {
            let mut state = self
                .gate
                .state
                .lock()
                .expect("extension control lifetime lock poisoned");
            state.in_flight -= 1;
            state.in_flight == 0
        };
        if idle {
            self.gate.changed.notify_waiters();
        }
    }
}

// These are the original calls' lifetime gates, not replacement futures or
// evidence that extension effects settled. Waiting never borrows the Host ledger.
struct ControlDrain {
    gates: Vec<Arc<ControlGate>>,
}
impl ControlDrain {
    async fn wait(self) -> Result<(), ToolError> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        for gate in self.gates {
            if tokio::time::timeout_at(deadline, gate.idle())
                .await
                .is_err()
            {
                return Err(ToolError::CleanupUnconfirmed(
                    "extension control futures remain active; original custody retained".to_owned(),
                ));
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
struct SessionRequestRegistration {
    registration: ExtensionSessionRequestRegistration,
    acknowledged: usize,
}
impl SessionRequestRegistration {
    fn required(&self) -> bool {
        self.registration.count() != self.acknowledged
    }
}
#[derive(Clone)]
struct CallContext {
    turn: String,
    epoch: crate::desktop::NativeEpochId,
    purposes: HashSet<CallPurpose>,
    issuing: Arc<AtomicUsize>,
    activation: Arc<AtomicBool>,
    registration: Option<SessionRequestRegistration>,
    controls: Arc<ControlGate>,
}
impl CallContext {
    fn requires_finish(&self) -> bool {
        self.activation.load(Ordering::SeqCst)
            || self
                .registration
                .as_ref()
                .is_some_and(SessionRequestRegistration::required)
    }
}
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum CallPurpose {
    Tab(Origin),
    SessionInventory,
    UserContext,
    SessionPresentation,
    SessionHistory,
    FixedConfiguration,
    Retirement,
}
enum CallTarget {
    Tab { origin: Origin, tab: Option<String> },
    SessionInventory,
    UserContext { tab: String },
    SessionPresentation,
    SessionHistory,
    FixedConfiguration { tab: String },
    Retirement,
}
struct CallScope {
    control: ExtensionBrowserProvider,
    issuing: Arc<AtomicUsize>,
    activation: Arc<AtomicBool>,
    controls: Arc<ControlGate>,
    owner: uuid::Uuid,
    provider: Provider,
    context: ExtensionHostOperation,
    epoch: crate::desktop::NativeEpochId,
    target: Option<String>,
    purpose: CallPurpose,
}
struct DispatchPermit {
    issuing: Arc<AtomicUsize>,
}
impl Drop for DispatchPermit {
    fn drop(&mut self) {
        self.issuing.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Current extension attachment preparation policy for one actual CDP call.
#[derive(Clone)]
pub(super) enum PreparationTransport {
    NotRequired,
    Unadmitted,
    Admitted(Arc<TransportPreparation>),
}

struct AgentTransportAuthorization {
    context: ExtensionHostOperation,
    request: crate::BrowserSessionPreparation,
    authorization: Arc<dyn crate::BrowserAuthorization>,
}

enum TransportAuthorization {
    Agent(Box<AgentTransportAuthorization>),
    Effect(Arc<dyn crate::BrowserEffectScope>),
}

pub(super) struct TransportPreparation {
    host: Weak<tokio::sync::Mutex<Host>>,
    owner: uuid::Uuid,
    provider: Provider,
    epoch: crate::desktop::NativeEpochId,
    claim: ExtensionPhysicalClaim,
    binding: crate::BrowserPreparationBinding,
    authorization: TransportAuthorization,
    cancellation: CancellationToken,
}

/// One live-claim permission issued before the caller enters close custody.
/// It is consumed once by that same operation's existing cleanup sequence.
pub(super) struct ExtensionCloseAdmission {
    scope: CallScope,
    claim: ExtensionPhysicalClaim,
    identity: TabIdentity,
    request: crate::BrowserSessionPreparation,
}

/// Keeps the exact extension operation reservation live until the raw call ends.
/// Dropping it never takes the Host mutex or waits for a callback.
struct AgentTransportCall {
    _scope: CallScope,
    _dispatch: DispatchPermit,
}

pub(super) struct TransportCall {
    _preparation: Arc<TransportPreparation>,
    _agent: Option<AgentTransportCall>,
}

/// Lifetime of one already admitted owned-input sequence. Holding this is not
/// a release acknowledgement; failed cleanup keeps it on the canonical lease.
pub(super) struct OwnedInputAdmission {
    _transport: Option<TransportCall>,
    _control: Option<ControlPermit>,
}

impl PreparationTransport {
    pub(super) async fn before_owned_input(&self) -> Result<OwnedInputAdmission, ToolError> {
        let transport = self.before_request().await?;
        let control = transport
            .as_ref()
            .and_then(|call| call._agent.as_ref())
            .map(|call| {
                call._scope
                    .controls
                    .enter()
                    .map_err(provider::extension_error)
            })
            .transpose()?;
        Ok(OwnedInputAdmission {
            _transport: transport,
            _control: control,
        })
    }

    pub(super) fn with_effect_scope(&self, scope: Arc<dyn crate::BrowserEffectScope>) -> Self {
        match self {
            Self::NotRequired => Self::NotRequired,
            Self::Unadmitted => Self::Unadmitted,
            Self::Admitted(preparation) => Self::Admitted(Arc::new(TransportPreparation {
                host: preparation.host.clone(),
                owner: preparation.owner,
                provider: preparation.provider.clone(),
                epoch: preparation.epoch,
                claim: preparation.claim.clone(),
                binding: preparation.binding.clone(),
                authorization: TransportAuthorization::Effect(scope),
                // The admitted Host effect owns cancellation/revocation. This
                // local API token does not inherit an expired Agent operation.
                cancellation: CancellationToken::new(),
            })),
        }
    }

    pub(super) async fn before_request(&self) -> Result<Option<TransportCall>, ToolError> {
        let preparation = match self {
            Self::NotRequired => return Ok(None),
            Self::Unadmitted => {
                return Err(failed(
                    "extension CDP requires a current admitted session preparation",
                ));
            }
            Self::Admitted(preparation) => preparation,
        };
        check_input(&preparation.cancellation)?;
        let host = preparation
            .host
            .upgrade()
            .ok_or_else(|| failed("extension CDP session owner closed"))?;
        host.lock().await.extension_transport_current(preparation)?;
        // No issuing permit is held while consulting the Host. Stop may hold
        // the extension ledger while it waits for already dispatched raw calls.
        match &preparation.authorization {
            TransportAuthorization::Agent(agent) => {
                agent
                    .authorization
                    .check_session_preparation(
                        agent.request.clone(),
                        preparation.cancellation.clone(),
                    )
                    .await?;
            }
            TransportAuthorization::Effect(scope) => {
                scope
                    .check_session_preparation(
                        preparation.binding.clone(),
                        preparation.cancellation.clone(),
                    )
                    .await?;
            }
        }
        check_input(&preparation.cancellation)?;
        let mut ledger = host.lock().await;
        check_input(&preparation.cancellation)?;
        let origin = ledger.extension_transport_current(preparation)?;
        let agent = match &preparation.authorization {
            TransportAuthorization::Agent(agent) => {
                let scope = ledger.extension_context(
                    preparation.owner,
                    &preparation.provider,
                    agent.context.clone(),
                    preparation.epoch,
                    CallTarget::Tab {
                        origin,
                        tab: Some(preparation.claim.tab_id().to_string()),
                    },
                    false,
                )?;
                ledger.extension_preparation_current(&scope, &agent.request)?;
                let dispatch = scope.enter_dispatch();
                Some(AgentTransportCall {
                    _scope: scope,
                    _dispatch: dispatch,
                })
            }
            // Service dispatch belongs to its actual Host effect ticket and
            // the existing Core claim/queued-CDP ledger, not an Agent call.
            TransportAuthorization::Effect(_) => None,
        };
        drop(ledger);
        // The caller immediately polls the original raw future, retaining the
        // exact extension claim and actual admission through terminal or Drop.
        Ok(Some(TransportCall {
            _preparation: preparation.clone(),
            _agent: agent,
        }))
    }
}

impl CallScope {
    fn enter_dispatch(&self) -> DispatchPermit {
        // Raw CDP does not pass through the typed control registration boundary.
        // Keep its existing may-call obligation; a raw fence is no cleanup proof.
        if self.provider.extension().is_some_and(|extension| {
            extension.capabilities().map_or(true, |capabilities| {
                capabilities.turn_lifecycle_owner == ExtensionEffectOwner::Provider
            })
        }) {
            self.activation.store(true, Ordering::SeqCst);
        }
        self.enter_retirement_dispatch()
    }
    fn enter_retirement_dispatch(&self) -> DispatchPermit {
        self.issuing.fetch_add(1, Ordering::SeqCst);
        DispatchPermit {
            issuing: self.issuing.clone(),
        }
    }

    async fn dispatch<T, E, F>(
        &self,
        future: F,
    ) -> Result<T, Box<cua_driver_core::browser::ExtensionProviderError>>
    where
        F: std::future::Future<Output = Result<T, E>>,
        E: Into<Box<cua_driver_core::browser::ExtensionProviderError>>,
    {
        let _control = self.controls.enter()?;
        let _dispatch = self.enter_retirement_dispatch();
        // Core records logical registration before transport admission on this
        // exact view. A completed local preflight refusal registers nothing;
        // a registered request keeps its duty regardless of its outcome.
        future.await.map_err(Into::into)
    }
    async fn dispatch_retirement<F: std::future::Future>(&self, future: F) -> F::Output {
        let _dispatch = self.enter_retirement_dispatch();
        future.await
    }

    fn transport_preparation(
        &self,
        host: &Arc<tokio::sync::Mutex<Host>>,
        invocation: &crate::InvocationContext<'_>,
        claim: &ExtensionPhysicalClaim,
        preparation: &crate::BrowserSessionPreparation,
        cancellation: &CancellationToken,
    ) -> Result<PreparationTransport, ToolError> {
        let extension = self
            .provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?;
        match extension
            .capabilities()
            .map_err(provider::extension_error)?
            .attachment_preparation
        {
            ExtensionAttachmentPreparation::MetadataOnly => {
                return Ok(PreparationTransport::NotRequired);
            }
            ExtensionAttachmentPreparation::Unknown => {
                return Err(failed(
                    "extension attachment preparation behavior has not been established",
                ));
            }
            ExtensionAttachmentPreparation::FullPreparation => {}
        }
        preparation.check_scope(
            invocation.turn(),
            invocation.operation_id().unwrap_or_default(),
        )?;
        if operation(invocation)? != self.context
            || preparation.native_owner != self.owner
            || preparation.native_epoch != self.epoch.to_string()
            || preparation.browser_id != self.provider.id()
            || preparation.generation != extension.identity().generation
            || claim.is_cleanup_only()
            || claim.generation() != preparation.generation
            || !matches!(&preparation.target, crate::BrowserPreparationTarget::ClaimedTab {
                tab_id, claim_id,
            } if tab_id == &claim.tab_id().to_string() && claim_id == claim.claim_id())
        {
            return Err(failed(
                "extension transport preparation lost its admitted claim scope",
            ));
        }
        let authorization = invocation.browser_authorization().ok_or_else(|| {
            failed("extension transport preparation requires current Host authorization")
        })?;
        Ok(PreparationTransport::Admitted(Arc::new(
            TransportPreparation {
                host: Arc::downgrade(host),
                owner: self.owner,
                provider: self.provider.clone(),
                epoch: self.epoch,
                claim: claim.clone(),
                binding: crate::BrowserPreparationBinding {
                    native_owner: self.owner,
                    native_epoch: self.epoch.to_string(),
                    browser_id: self.provider.id().to_owned(),
                    generation: preparation.generation.clone(),
                    turn_id: self.context.turn_id.clone(),
                    tab_id: claim.tab_id().to_string(),
                    subject: crate::BrowserLeaseSubject::PhysicalClaim {
                        claim_id: claim.claim_id().to_owned(),
                    },
                },
                authorization: TransportAuthorization::Agent(Box::new(
                    AgentTransportAuthorization {
                        context: self.context.clone(),
                        request: preparation.clone(),
                        authorization,
                    },
                )),
                cancellation: cancellation.clone(),
            },
        )))
    }

    async fn authorize_preparation(
        &self,
        host: &tokio::sync::Mutex<Host>,
        invocation: &crate::InvocationContext<'_>,
        target: crate::BrowserPreparationTarget,
        cancellation: &CancellationToken,
    ) -> Result<crate::BrowserSessionPreparation, ToolError> {
        let extension = self
            .provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?;
        let request = crate::BrowserSessionPreparation {
            native_owner: self.owner,
            native_epoch: self.epoch.to_string(),
            browser_id: self.provider.id().to_owned(),
            generation: extension.identity().generation.clone(),
            turn_id: self.context.turn_id.clone(),
            operation_id: self.context.operation_id.clone(),
            target,
        };
        host.lock()
            .await
            .extension_preparation_current(self, &request)?;
        invocation
            .authorize_session_preparation(&request, cancellation)
            .await?;
        check_input(cancellation)?;
        host.lock()
            .await
            .extension_preparation_current(self, &request)?;
        Ok(request)
    }

    async fn check_preparation(
        &self,
        host: &tokio::sync::Mutex<Host>,
        invocation: &crate::InvocationContext<'_>,
        request: &crate::BrowserSessionPreparation,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        host.lock()
            .await
            .extension_preparation_current(self, request)?;
        invocation
            .check_session_preparation(request, cancellation)
            .await?;
        check_input(cancellation)?;
        host.lock()
            .await
            .extension_preparation_current(self, request)
    }
}
pub(super) struct SessionMetadataCall {
    host: Arc<tokio::sync::Mutex<Host>>,
    scope: CallScope,
    request: crate::BrowserSessionPreparation,
    authorization: Arc<dyn crate::BrowserAuthorization>,
    cancellation: CancellationToken,
    history: Vec<Acquisition>,
}
impl SessionMetadataCall {
    pub(super) fn generation(&self) -> &str {
        &self.request.generation
    }
    pub(super) async fn check(&self) -> Result<(), ToolError> {
        self.host
            .lock()
            .await
            .extension_preparation_current(&self.scope, &self.request)?;
        self.authorization
            .check_session_preparation(self.request.clone(), self.cancellation.clone())
            .await?;
        check_input(&self.cancellation)?;
        self.host
            .lock()
            .await
            .extension_preparation_current(&self.scope, &self.request)
    }
    pub(super) async fn list(
        &self,
    ) -> Result<Vec<cua_driver_core::browser::ExtensionTabInfo>, ToolError> {
        self.check().await?;
        let browser = BrowserIdentity::of(&self.scope.provider, &self.request.generation)?;
        let ids = self.host.lock().await.metadata_candidates(
            self.scope.owner,
            &browser,
            &self.history,
        )?;
        // Await this original future without replay. Dropping the wrapper on
        // its caller's budget does not settle extension custody or activation.
        let result = self
            .scope
            .dispatch(self.scope.control.list_session_tabs(&ids))
            .await;
        let rows = result.map_err(provider::extension_error)?;
        // This successful scoped result proves the actual turn activated even
        // if a later Host authorization check rejects use of the observations.
        self.host.lock().await.resume_marked_handoffs(
            self.scope.owner,
            &self.scope.provider,
            &self.scope.context.turn_id,
        );
        self.check().await?;
        let ledger = self.host.lock().await;
        ledger.extension_preparation_current(&self.scope, &self.request)?;
        Ok(rows
            .into_iter()
            .filter(|row| ledger.visible(&browser.tab(&row.id.to_string()), self.scope.owner))
            .collect())
    }
    pub(super) async fn resolve(
        &self,
        raw: &str,
    ) -> Result<cua_driver_core::browser::ExtensionTabInfo, ToolError> {
        let id = cua_driver_core::browser::parse_browser_tab_id(raw)
            .ok_or_else(|| failed("extension tab ID must convert to a positive safe integer"))?;
        self.list()
            .await?
            .into_iter()
            .find(|tab| tab.id == id)
            .ok_or_else(|| {
                failed("tab_unavailable: raw tab is not in this session's visible metadata")
            })
    }
}

pub(super) async fn session_metadata_call(
    host: Arc<tokio::sync::Mutex<Host>>,
    owner: uuid::Uuid,
    provider: &Provider,
    epoch: crate::desktop::NativeEpochId,
    call: BrowserCall<'_>,
    history: Vec<Acquisition>,
) -> Result<SessionMetadataCall, ToolError> {
    let extension = provider
        .extension()
        .ok_or_else(|| failed("extension provider required"))?;
    // This exact local preflight occurs before any prospective context or
    // activation obligation. Old producers cannot silently use global inventory.
    if !extension
        .capabilities()
        .map_err(provider::extension_error)?
        .session_tab_inventory
    {
        return Err(failed(
            "selected extension adapter does not support scoped session inventory",
        ));
    }
    check_input(call.cancellation)?;
    register(&host, owner, provider).await?;
    let scope = host.lock().await.extension_context(
        owner,
        provider,
        operation(call.invocation)?,
        epoch,
        CallTarget::SessionInventory,
        true,
    )?;
    let request = scope
        .authorize_preparation(
            &host,
            call.invocation,
            crate::BrowserPreparationTarget::SessionInventory,
            call.cancellation,
        )
        .await?;
    let authorization = call
        .invocation
        .browser_authorization()
        .ok_or_else(|| failed("session metadata requires current Host authorization"))?;
    Ok(SessionMetadataCall {
        host,
        scope,
        request,
        authorization,
        cancellation: call.cancellation.clone(),
        history,
    })
}

async fn session_surface_call(
    host: Arc<tokio::sync::Mutex<Host>>,
    owner: uuid::Uuid,
    provider: &Provider,
    epoch: crate::desktop::NativeEpochId,
    call: BrowserCall<'_>,
    history: bool,
) -> Result<SessionMetadataCall, ToolError> {
    check_input(call.cancellation)?;
    register(&host, owner, provider).await?;
    let scope = host.lock().await.extension_context(
        owner,
        provider,
        operation(call.invocation)?,
        epoch,
        if history {
            CallTarget::SessionHistory
        } else {
            CallTarget::SessionPresentation
        },
        true,
    )?;
    let request = scope
        .authorize_preparation(
            &host,
            call.invocation,
            if history {
                crate::BrowserPreparationTarget::SessionHistory
            } else {
                crate::BrowserPreparationTarget::SessionPresentation
            },
            call.cancellation,
        )
        .await?;
    let authorization = call
        .invocation
        .browser_authorization()
        .ok_or_else(|| failed("browser session surface requires current Host authorization"))?;
    Ok(SessionMetadataCall {
        host,
        scope,
        request,
        authorization,
        cancellation: call.cancellation.clone(),
        history: Vec::new(),
    })
}

enum FinishPhase {
    Required,
    Pending,
    Acknowledged,
    Refused(String),
    Unknown(String),
}
pub(super) struct ProviderState {
    provider: Provider,
    pub(super) current_turn: Option<String>,
    pub(super) pending_viewport: Option<capability::viewport::Pending>,
    retiring_turn: Option<String>,
    logical_active: Option<String>,
    session_group_title: Option<String>,
    calls: HashMap<String, CallContext>,
    applied: HashSet<u64>,
    finish_phases: HashMap<String, FinishPhase>,
    session_headers: Option<ExtensionSessionHeaderProof>,
    headers_unknown: bool,
    uploads: upload::Custody,
    owner_parked: bool,
}

impl ProviderState {
    fn fold_activation(&mut self) {
        for call in self.calls.values().filter(|call| call.requires_finish()) {
            match self.finish_phases.entry(call.turn.clone()) {
                std::collections::hash_map::Entry::Vacant(entry) => {
                    entry.insert(FinishPhase::Required);
                }
                std::collections::hash_map::Entry::Occupied(mut entry)
                    if matches!(entry.get(), FinishPhase::Acknowledged) =>
                {
                    entry.insert(FinishPhase::Unknown(
                        "extension activation crossed an acknowledged turn cleanup".to_owned(),
                    ));
                }
                _ => {}
            }
        }
    }
    fn activation_turn(&self, selected: Option<&str>) -> Option<String> {
        self.finish_phases.iter().find_map(|(turn, phase)| {
            (selected.is_none_or(|selected| selected == turn)
                && !matches!(phase, FinishPhase::Acknowledged))
            .then(|| turn.clone())
        })
    }
    fn admit_turn(&mut self, turn: &str) -> Result<(), ToolError> {
        if self.retiring_turn.is_some() {
            return Err(ToolError::CleanupUnconfirmed(
                "extension turn cleanup remains active".to_owned(),
            ));
        }
        if matches!(
            self.finish_phases.get(turn),
            Some(
                FinishPhase::Pending
                    | FinishPhase::Unknown(_)
                    | FinishPhase::Refused(_)
                    | FinishPhase::Acknowledged
            )
        ) {
            return Err(ToolError::CleanupUnconfirmed(
                "extension turn has an unresolved or completed cleanup".to_owned(),
            ));
        }
        if self.current_turn.as_deref() != Some(turn) {
            // Seal old prospective scopes before inspecting their may-dispatch
            // facts. A late old operation cannot race the logical turn switch.
            for call in self.calls.values().filter(|call| call.turn != turn) {
                call.controls.seal();
            }
            self.fold_activation();
            if self
                .calls
                .values()
                .any(|call| call.turn != turn && !call.controls.is_idle())
                || self
                    .finish_phases
                    .iter()
                    .any(|(old, phase)| old != turn && !matches!(phase, FinishPhase::Acknowledged))
            {
                return Err(ToolError::CleanupUnconfirmed(
                    "previous extension turn activation must be cleaned before changing turn"
                        .to_owned(),
                ));
            }
            self.current_turn = Some(turn.to_owned());
        }
        Ok(())
    }
}

fn operation(
    invocation: &crate::InvocationContext<'_>,
) -> Result<ExtensionHostOperation, ToolError> {
    let id = invocation
        .operation_id()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            failed("extension browser mutations require the current Host operation identity")
        })?;
    Ok(ExtensionHostOperation {
        operation_id: id.to_owned(),
        turn_id: invocation.turn().to_owned(),
    })
}
fn preparation_headers(invocation: &crate::InvocationContext<'_>) -> Vec<ExtensionHeader> {
    invocation
        .browser_preparation_policy()
        .headers
        .iter()
        .map(|header| ExtensionHeader {
            name: header.name.clone(),
            value: header.value.clone(),
        })
        .collect()
}

fn fixed_cursor_spec(
    spec: &Option<Arc<std::sync::Mutex<crate::cursor::Spec>>>,
) -> Result<crate::cursor::Spec, ToolError> {
    spec.as_ref()
        .map(|spec| {
            spec.lock()
                .expect("browser cursor configuration lock poisoned")
                .clone()
        })
        .ok_or_else(|| failed("fixed extension preparation requires the Host cursor configuration"))
}

fn context_operation(turn: &str) -> ExtensionHostOperation {
    ExtensionHostOperation {
        operation_id: format!("cleanup:{}", uuid::Uuid::new_v4()),
        turn_id: turn.to_owned(),
    }
}

pub(super) fn tab_info(tab: &cua_driver_core::browser::ExtensionTabInfo) -> Value {
    let mut result = json!({"id":tab.id.to_string()});
    for (key, value) in [
        ("titleJson", tab.title.as_ref()),
        ("tabGroupJson", tab.group_title.as_ref()),
    ] {
        if let Some(value) = value {
            result[key] = json!(value);
        }
    }
    for (key, value) in [
        ("url", tab.url.as_ref()),
        ("lastOpened", tab.last_opened.as_ref()),
        ("providerTabId", tab.provider_tab_id.as_ref()),
    ] {
        if let Some(value) = value {
            result[key] = json!(value);
        }
    }
    result
}
fn managed_tab_info(tab: &cua_driver_core::browser::ExtensionTabInfo) -> Value {
    let mut result = json!({"id":tab.id.to_string()});
    if let Some(value) = &tab.title {
        result["titleJson"] = json!(value);
    }
    for (key, value) in [
        ("url", tab.url.as_ref()),
        ("providerTabId", tab.provider_tab_id.as_ref()),
    ] {
        if let Some(value) = value {
            result[key] = json!(value);
        }
    }
    result
}

pub(super) fn is_internal_url(url: &str) -> bool {
    url.starts_with("chrome://")
}

pub(super) fn is_new_tab(url: &str) -> bool {
    ["newtab/", "new-tab-page/", "new-tab-page-third-party/"]
        .iter()
        .any(|suffix| url == format!("chrome://{suffix}"))
}
fn source_time(tab: &cua_driver_core::browser::ExtensionTabInfo) -> f64 {
    tab.last_accessed
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(0.0)
}

fn ordered_user_tabs(
    mut tabs: Vec<cua_driver_core::browser::ExtensionTabInfo>,
    order: ExtensionUserTabsOrder,
) -> Vec<cua_driver_core::browser::ExtensionTabInfo> {
    tabs.retain(|tab| tab.id <= 9_007_199_254_740_991);
    if order == ExtensionUserTabsOrder::Host {
        tabs.sort_by(|left, right| {
            source_time(right)
                .total_cmp(&source_time(left))
                .then(
                    left.window_id
                        .unwrap_or(0)
                        .cmp(&right.window_id.unwrap_or(0)),
                )
                .then(left.index.unwrap_or(0).cmp(&right.index.unwrap_or(0)))
                .then(left.id.cmp(&right.id))
        });
    }
    let mut ids = HashSet::new();
    tabs.retain(|tab| ids.insert(tab.id));
    tabs.truncate(1000);
    tabs
}

impl Host {
    fn extension_transport_current(
        &self,
        preparation: &TransportPreparation,
    ) -> Result<Origin, ToolError> {
        let binding = &preparation.binding;
        binding.check_turn(&binding.turn_id)?;
        let extension = preparation
            .provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?;
        if extension.is_closed()
            || binding.native_owner != preparation.owner
            || binding.native_epoch != preparation.epoch.to_string()
            || binding.browser_id != preparation.provider.id()
            || binding.generation != extension.identity().generation
            || binding.tab_id != preparation.claim.tab_id().to_string()
            || !matches!(&binding.subject, crate::BrowserLeaseSubject::PhysicalClaim { claim_id }
                if claim_id == preparation.claim.claim_id())
            || preparation.claim.is_cleanup_only()
            || preparation.claim.generation() != binding.generation
        {
            return Err(failed("extension CDP preparation binding changed"));
        }
        let browser = BrowserIdentity::of(&preparation.provider, &binding.generation)?;
        self.known(&browser)?;
        let provider = self
            .extension
            .get(&(preparation.owner, browser.clone()))
            .ok_or_else(|| failed("extension CDP preparation owner retired"))?;
        if provider.current_turn.as_deref() != Some(binding.turn_id.as_str())
            || provider.retiring_turn.is_some()
            || provider.headers_unknown
        {
            return Err(ToolError::CleanupUnconfirmed(
                "extension CDP preparation turn is no longer current".into(),
            ));
        }
        if let TransportAuthorization::Agent(agent) = &preparation.authorization {
            agent
                .request
                .check_scope(&binding.turn_id, &agent.context.operation_id)?;
            if agent.context.turn_id != binding.turn_id
                || provider
                    .calls
                    .get(&agent.context.operation_id)
                    .is_some_and(|call| {
                        call.epoch != preparation.epoch
                            || call.turn != agent.context.turn_id
                            || call.controls.is_sealed()
                    })
            {
                return Err(failed("extension CDP preparation operation changed"));
            }
        }
        let lease = self
            .tabs
            .get(&browser.tab(&binding.tab_id))
            .ok_or_else(|| failed("extension CDP preparation lost its physical lease"))?;
        let state = lease
            .extension
            .as_ref()
            .ok_or_else(|| failed("extension CDP preparation replaced extension custody"))?;
        if lease.creator.owner != preparation.owner
            || lease.creator.provider != preparation.provider
            || lease.creator.generation != binding.generation
            || lease.creator.turn != binding.turn_id
            || !matches!(lease.disposition, Disposition::Live)
            || state.physical_epoch != Some(preparation.epoch)
            || state.revoked
            || state.cleanup_started
            || state.released
            || state.closed
            || state.unknown.is_some()
            || state.cdp_effect_unknown.is_some()
            || state.claim.as_ref().is_none_or(|claim| {
                claim.is_cleanup_only()
                    || claim.claim_id() != preparation.claim.claim_id()
                    || claim.tab_id() != preparation.claim.tab_id()
                    || claim.target_id() != preparation.claim.target_id()
                    || claim.generation() != preparation.claim.generation()
                    || claim.completion_id() != preparation.claim.completion_id()
            })
        {
            return Err(ToolError::CleanupUnconfirmed(
                "extension CDP preparation lost its exact live physical claim".into(),
            ));
        }
        Ok(lease.origin)
    }

    /// The logical session active tab; this never consults operating-system focus.
    pub(super) fn logical_active(
        &self,
        owner: uuid::Uuid,
        browser: &BrowserIdentity,
    ) -> Option<String> {
        self.extension
            .get(&(owner, browser.clone()))
            .and_then(|state| state.logical_active.clone())
    }

    fn extension_preparation_current(
        &self,
        scope: &CallScope,
        request: &crate::BrowserSessionPreparation,
    ) -> Result<(), ToolError> {
        request.check_scope(&scope.context.turn_id, &scope.context.operation_id)?;
        let extension = scope
            .provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?;
        if extension.is_closed()
            || request.native_owner != scope.owner
            || request.native_epoch != scope.epoch.to_string()
            || request.browser_id != scope.provider.id()
            || request.generation != extension.identity().generation
        {
            return Err(failed(
                "extension session preparation owner or provider changed",
            ));
        }
        let browser = BrowserIdentity::of(&scope.provider, &request.generation)?;
        self.known(&browser)?;
        let state = self
            .extension
            .get(&(scope.owner, browser.clone()))
            .ok_or_else(|| failed("extension session preparation owner retired"))?;
        let call = state
            .calls
            .get(&scope.context.operation_id)
            .ok_or_else(|| failed("extension session preparation lost its original Host call"))?;
        let configuration = scope.purpose == CallPurpose::FixedConfiguration
            && call.purposes.contains(&CallPurpose::FixedConfiguration);
        if (!configuration && state.current_turn.as_deref() != Some(scope.context.turn_id.as_str()))
            || state.retiring_turn.is_some()
            || state.headers_unknown
            || call.turn != scope.context.turn_id
            || call.epoch != scope.epoch
            || !Arc::ptr_eq(&call.issuing, &scope.issuing)
            || !Arc::ptr_eq(&call.activation, &scope.activation)
            || !Arc::ptr_eq(&call.controls, &scope.controls)
            || call.controls.is_sealed()
            || !call.purposes.contains(&scope.purpose)
        {
            return Err(ToolError::CleanupUnconfirmed(
                "extension session preparation call is no longer current".into(),
            ));
        }
        let tab_id = match &request.target {
            crate::BrowserPreparationTarget::ReservedTab { tab_id }
            | crate::BrowserPreparationTarget::ClaimedTab { tab_id, .. }
            | crate::BrowserPreparationTarget::FixedSessionTab { tab_id, .. } => Some(tab_id),
            crate::BrowserPreparationTarget::PendingCreation => {
                if !call
                    .purposes
                    .contains(&CallPurpose::Tab(Origin::AgentCreated))
                {
                    return Err(failed("extension creation has no admitted creation call"));
                }
                scope.target.as_ref()
            }
            crate::BrowserPreparationTarget::SessionInventory
            | crate::BrowserPreparationTarget::SessionPresentation
            | crate::BrowserPreparationTarget::SessionHistory => {
                let purpose = match &request.target {
                    crate::BrowserPreparationTarget::SessionInventory => {
                        CallPurpose::SessionInventory
                    }
                    crate::BrowserPreparationTarget::SessionPresentation => {
                        CallPurpose::SessionPresentation
                    }
                    crate::BrowserPreparationTarget::SessionHistory => CallPurpose::SessionHistory,
                    _ => unreachable!(),
                };
                if scope.target.is_some()
                    || scope.purpose != purpose
                    || !call.purposes.contains(&purpose)
                {
                    return Err(failed(
                        "extension session surface has no current exact-purpose call",
                    ));
                }
                None
            }
        };
        if let Some(tab_id) = tab_id {
            let lease = self
                .tabs
                .get(&browser.tab(tab_id))
                .ok_or_else(|| failed("extension session preparation lost its reserved tab"))?;
            let state = lease
                .extension
                .as_ref()
                .ok_or_else(|| failed("extension session preparation lost extension custody"))?;
            let prospective_fixed = matches!(
                request.target,
                crate::BrowserPreparationTarget::ReservedTab { .. }
            ) && extension.capabilities().is_ok_and(|caps| {
                caps.session_preparation == ExtensionSessionPreparation::ExplicitFixed
            });
            // A handed-off resource is still owned by this same Session, but
            // carries no physical claim. Only a newly authorized reservation
            // may prepare it; ClaimedTab/CDP checks keep their exact-turn rule.
            let prospective_handoff = matches!(
                request.target,
                crate::BrowserPreparationTarget::ReservedTab { .. }
            ) && matches!(lease.retention, Retention::Handoff)
                && state.claim.is_none()
                && state.physical_epoch.is_none();
            let logical_fixed = prospective_fixed
                || matches!(
                    &request.target,
                    crate::BrowserPreparationTarget::FixedSessionTab { .. }
                ) && extension.capabilities().is_ok_and(|caps| {
                    caps.session_preparation == ExtensionSessionPreparation::ExplicitFixed
                });
            let prospective_transfer =
                matches!(
                    request.target,
                    crate::BrowserPreparationTarget::ReservedTab { .. }
                ) && lease.handoff_transfer.as_ref().is_some_and(|attempt| {
                    attempt.matches(scope.owner, &scope.provider, &scope.context, scope.epoch)
                        && attempt.unknown.is_none()
                });
            if (!prospective_transfer && lease.creator.owner != scope.owner)
                || lease.creator.provider != scope.provider
                || lease.creator.generation != request.generation
                || (!configuration
                    && !prospective_fixed
                    && !prospective_handoff
                    && !prospective_transfer
                    && lease.creator.turn != scope.context.turn_id)
                || !matches!(lease.disposition, Disposition::Live)
                || (!logical_fixed && (state.revoked || state.cleanup_started || state.released))
                || state.closed
                || state.unknown.is_some()
                || state.cdp_effect_unknown.is_some()
            {
                return Err(ToolError::CleanupUnconfirmed(
                    "extension session preparation lost its live reservation".into(),
                ));
            }
            if !matches!(
                request.target,
                crate::BrowserPreparationTarget::PendingCreation
            ) && scope.target.as_deref() != Some(tab_id.as_str())
                && (state
                    .creation_operation
                    .as_ref()
                    .map(|created| &created.operation)
                    != Some(&scope.context)
                    || state.creation.as_ref().is_none_or(|creation| {
                        creation.is_cleanup_only()
                            || creation.tab_id().map(|id| id.to_string()).as_ref() != Some(tab_id)
                            || creation.generation() != request.generation
                    }))
            {
                return Err(failed(
                    "extension session preparation changed its issued target",
                ));
            }
            if configuration
                && !matches!(
                    request.target,
                    crate::BrowserPreparationTarget::FixedSessionTab { .. }
                )
            {
                return Err(failed(
                    "fixed configuration requires its exact logical receipt target",
                ));
            }
            if let crate::BrowserPreparationTarget::FixedSessionTab { scope_id, .. } =
                &request.target
            {
                let prepared = state.fixed_preparation.ready().ok_or_else(|| {
                    ToolError::CleanupUnconfirmed(
                        "fixed session is pending, unknown or cleared".into(),
                    )
                })?;
                let receipt = &prepared.receipt;
                if receipt.is_cleanup_only()
                    || receipt.scope_id() != scope_id
                    || receipt.tab_id().to_string() != *tab_id
                    || receipt.generation() != request.generation
                    || receipt.wire_context().host_session_id() != scope.owner.to_string()
                    || (!configuration
                        && receipt.wire_context().host_turn_id() != scope.context.turn_id)
                {
                    return Err(failed(
                        "fixed session preparation changed its actual sealed receipt",
                    ));
                }
            }
            if let crate::BrowserPreparationTarget::ClaimedTab { claim_id, .. } = &request.target
                && (state.physical_epoch != Some(scope.epoch)
                    || state.claim.as_ref().is_none_or(|claim| {
                        claim.is_cleanup_only()
                            || claim.claim_id() != claim_id
                            || claim.tab_id().to_string() != *tab_id
                            || claim.generation() != request.generation
                    }))
            {
                return Err(failed(
                    "extension session preparation changed its physical claim",
                ));
            }
        }
        Ok(())
    }

    fn extension_preparation_failed(
        &mut self,
        identity: &TabIdentity,
        operation: &ExtensionHostOperation,
        not_dispatched: bool,
        error: &cua_driver_core::browser::ExtensionProviderError,
    ) {
        if let Some(state) = self
            .tabs
            .get_mut(identity)
            .and_then(|lease| lease.extension.as_mut())
            && matches!(&state.user_preparation,
                UserPreparation::Pending(issued) if issued == operation)
        {
            state.user_preparation = if not_dispatched {
                UserPreparation::NotAttempted
            } else {
                UserPreparation::Unknown(error.to_string())
            };
        }
    }

    fn extension_popup_current(
        &self,
        owner: uuid::Uuid,
        provider: &Provider,
        request: &ExtensionPopupRequest,
    ) -> bool {
        let Some(extension) = provider.extension() else {
            return false;
        };
        let Ok(browser) = BrowserIdentity::of(provider, &extension.identity().generation) else {
            return false;
        };
        let wire = request.wire_context();
        if wire.host_session_id() != owner.to_string()
            || self
                .extension
                .get(&(owner, browser.clone()))
                .is_none_or(|state| {
                    state.current_turn.as_deref() != Some(wire.host_turn_id())
                        || state.retiring_turn.is_some()
                })
        {
            return false;
        }
        self.tabs
            .get(&browser.tab(&request.tab_id().to_string()))
            .is_some_and(|lease| {
                lease.creator.owner == owner
                    && lease.creator.provider == *provider
                    && lease.creator.turn == wire.host_turn_id()
                    && matches!(lease.disposition, Disposition::Live)
                    && lease.extension.as_ref().is_some_and(|state| {
                        !state.revoked
                            && !state.cleanup_started
                            && state
                                .claim
                                .as_ref()
                                .is_some_and(|claim| claim.claim_id() == request.claim_id())
                    })
            })
    }

    fn extension_popup_source_current(
        &self,
        owner: uuid::Uuid,
        provider: &Provider,
        source: &PopupSource,
    ) -> bool {
        match source {
            PopupSource::Physical(request) => {
                self.extension_popup_current(owner, provider, request)
            }
            PopupSource::Fixed(request) => {
                self.extension_fixed_popup_current(owner, provider, request)
            }
        }
    }

    fn extension_fixed_popup_current(
        &self,
        owner: uuid::Uuid,
        provider: &Provider,
        request: &ExtensionSessionPopupRequest,
    ) -> bool {
        let Some(extension) = provider.extension() else {
            return false;
        };
        if extension.is_closed()
            || request.generation() != extension.identity().generation
            || request.owner().is_empty()
            || !extension.capabilities().is_ok_and(|caps| {
                caps.session_preparation == ExtensionSessionPreparation::ExplicitFixed
            })
        {
            return false;
        }
        let Ok(browser) = BrowserIdentity::of(provider, &extension.identity().generation) else {
            return false;
        };
        let wire = request.wire_context();
        if wire.host_session_id() != owner.to_string()
            || self.known(&browser).is_err()
            || self
                .extension
                .get(&(owner, browser.clone()))
                .is_none_or(|state| {
                    state.current_turn.as_deref() != Some(wire.host_turn_id())
                        || state.retiring_turn.is_some()
                        || state.headers_unknown
                })
        {
            return false;
        }
        self.tabs
            .get(&browser.tab(&request.tab_id().to_string()))
            .is_some_and(|lease| {
                lease.creator.owner == owner
                    && lease.creator.provider == *provider
                    && lease.creator.generation == extension.identity().generation
                    && lease.creator.turn == wire.host_turn_id()
                    && matches!(lease.disposition, Disposition::Live)
                    && lease.extension.as_ref().is_some_and(|state| {
                        let Some(prepared) = state.fixed_preparation.ready() else {
                            return false;
                        };
                        let receipt = &prepared.receipt;
                        state.unknown.is_none()
                            && state.cdp_effect_unknown.is_none()
                            // The initial about:blank component observation can
                            // precede the later document's real relay installation.
                            && !receipt.is_cleanup_only()
                            && receipt.scope_id() == request.scope_id()
                            && receipt.tab_id() == request.tab_id()
                            && receipt.generation() == request.generation()
                            && receipt.wire_context() == wire
                            && prepared
                                .headers
                                .scope
                                .as_ref()
                                .is_none_or(|scope| scope.owner == request.owner())
                            && state.lease_children.as_ref().is_some_and(|scope| {
                                scope.turn == wire.host_turn_id()
                                    && scope.effects.supports_lease_children()
                            })
                    })
            })
    }

    fn apply_claim_preparation(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        context: Option<&ExtensionHostOperation>,
        proof: ExtensionClaimPreparationProof,
    ) -> Result<(), ToolError> {
        let extension = provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?;
        if proof.generation() != extension.identity().generation {
            return Err(unknown("extension preparation generation changed"));
        }
        let browser = BrowserIdentity::of(provider, &extension.identity().generation)?;
        let current = self.extension.get(&(owner, browser)).is_some_and(|state| {
            state.current_turn.as_deref() == Some(proof.wire_context().host_turn_id())
                && state.retiring_turn.is_none()
        });
        let lease = self
            .tabs
            .values_mut()
            .find(|lease| {
                lease.creator.owner == owner
                    && lease.creator.provider == *provider
                    && lease
                        .extension
                        .as_ref()
                        .and_then(|state| state.claim.as_ref())
                        .is_some_and(|claim| claim.claim_id() == proof.claim_id())
            })
            .ok_or_else(|| unknown("extension preparation lost its exact physical claim"))?;
        let state = lease
            .extension
            .as_mut()
            .expect("matched extension physical claim");
        let attempt = match &state.claim_preparation {
            ClaimPreparation::Pending(attempt) | ClaimPreparation::Unknown { attempt, .. } => {
                attempt.clone()
            }
            ClaimPreparation::Acknowledged(prior)
                if prior.proof.completion_id() == proof.completion_id() =>
            {
                return Ok(());
            }
            _ => {
                return Err(unknown(
                    "extension preparation ACK has no issued Host preparation",
                ));
            }
        };
        if context != Some(&attempt.operation)
            || proof.document() != &attempt.document
            || proof.wire_context() != &attempt.wire
            || proof.wire_context().host_session_id() != owner.to_string()
            || proof.popup_enabled() != attempt.policy.popup_enabled
            || proof.header_enabled() != attempt.policy.header_enabled
        {
            return Err(unknown(
                "extension preparation ACK changed its issued document, policy or context",
            ));
        }
        if proof.is_cleanup_only()
            || !current
            || !matches!(lease.disposition, Disposition::Live)
            || state.revoked
            || state.cleanup_started
        {
            state.claim_preparation = ClaimPreparation::Unknown {
                attempt,
                acknowledgement: Some(proof),
                reason: "extension preparation ACK is retained for cleanup only".into(),
            };
            lease.disposition = Disposition::Closing;
        } else {
            // The individual actual installation flags stay in this issued ACK.
            // This is neither a ExtensionHeaderProof nor a blanket readiness bit.
            state.claim_preparation = ClaimPreparation::Acknowledged(PreparationAcknowledgement {
                proof,
                policy: attempt.policy.clone(),
            });
        }
        Ok(())
    }

    fn logical_fixed_receipt(
        &self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
    ) -> Option<&ExtensionFixedSessionReceipt> {
        let lease = self.tabs.get(identity)?;
        let extension = lease.creator.provider.extension()?;
        let state = lease.extension.as_ref()?;
        let prepared = state.fixed_preparation.ready()?;
        let receipt = &prepared.receipt;
        (lease.creator.owner == owner
            && extension.capabilities().is_ok_and(|caps| {
                caps.session_preparation == ExtensionSessionPreparation::ExplicitFixed
            })
            && BrowserIdentity::of(&lease.creator.provider, receipt.generation())
                .ok()
                .as_ref()
                == Some(&identity.browser)
            && lease.creator.generation == receipt.generation()
            && receipt.tab_id().to_string() == identity.target
            && receipt.wire_context().host_session_id() == owner.to_string()
            && !receipt.is_cleanup_only())
        .then_some(receipt)
    }

    fn acquisition(&self, owner: uuid::Uuid, identity: &TabIdentity) -> Option<Acquisition> {
        let lease = self.tabs.get(identity)?;
        if lease.creator.owner != owner
            || !matches!(lease.disposition, Disposition::Live)
            || matches!(lease.retention, Retention::Handoff)
        {
            return None;
        }
        let state = lease.extension.as_ref()?;
        if (state.revoked && self.logical_fixed_receipt(owner, identity).is_none())
            || state.closed
            || state.unknown.is_some()
            || state.cdp_effect_unknown.is_some()
        {
            return None;
        }
        let (operation, epoch) = match state.user_prepared_operation.as_ref() {
            Some(PreparedOperation::Acquired { operation, epoch }) => (operation.clone(), *epoch),
            _ => {
                let creation = state.creation.as_ref()?;
                if creation.is_cleanup_only()
                    || creation.tab_id().map(|id| id.to_string()).as_ref() != Some(&identity.target)
                {
                    return None;
                }
                let created = state.creation_operation.as_ref()?;
                (created.operation.clone(), created.epoch)
            }
        };
        Some(Acquisition {
            owner,
            identity: identity.clone(),
            operation,
            epoch,
            sequence: lease.extension_sequence?,
        })
    }

    fn restore_acquisition_order(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        history: Option<&Acquisition>,
    ) {
        let Some(history) =
            history.filter(|record| record.owner == owner && record.identity == *identity)
        else {
            return;
        };
        if let Some(lease) = self.tabs.get_mut(identity).filter(|lease| {
            lease.creator.owner == owner && matches!(lease.disposition, Disposition::Live)
        }) && lease.extension_sequence.is_none()
        {
            lease.extension_sequence = Some(history.sequence);
        }
    }

    fn metadata_candidates(
        &self,
        owner: uuid::Uuid,
        browser: &BrowserIdentity,
        history: &[Acquisition],
    ) -> Result<Vec<u64>, ToolError> {
        self.known(browser)?;
        let mut known = history
            .iter()
            .filter(|record| {
                record.owner == owner
                    && record.identity.browser == *browser
                    && self.tabs.get(&record.identity).is_none_or(|lease| {
                        lease.creator.owner == owner
                            && matches!(lease.disposition, Disposition::Live)
                            && lease.extension.as_ref().is_none_or(|state| {
                                (!state.revoked
                                    || self
                                        .logical_fixed_receipt(owner, &record.identity)
                                        .is_some())
                                    && !state.closed
                                    && state.unknown.is_none()
                                    && state.cdp_effect_unknown.is_none()
                            })
                    })
            })
            .map(|record| (record.sequence, record.identity.target.clone()))
            .collect::<Vec<_>>();
        known.extend(
            self.tabs
                .keys()
                .filter(|identity| identity.browser == *browser)
                .filter_map(|identity| {
                    self.acquisition(owner, identity)
                        .map(|record| (record.sequence, identity.target.clone()))
                }),
        );
        // A handoff keeps logical ownership, not its old physical claim. The
        // retained real insertion sequence permits scoped metadata candidates
        // after epoch reset without inventing an acquisition or a site grant.
        known.extend(self.tabs.iter().filter_map(|(identity, lease)| {
            (identity.browser == *browser
                && lease.creator.owner == owner
                && matches!(lease.disposition, Disposition::Live)
                && lease.extension.as_ref().is_some_and(|state| {
                    !state.closed && state.unknown.is_none() && state.cdp_effect_unknown.is_none()
                }))
            .then(|| {
                lease
                    .extension_sequence
                    .map(|sequence| (sequence, identity.target.clone()))
            })
            .flatten()
        }));
        // Several wrappers can retain the same real acquisition. Use the newest
        // issued acquisition order, never raw-ID/time order or a metadata row.
        known.sort_unstable_by_key(|(sequence, _)| std::cmp::Reverse(*sequence));
        let mut ids = HashSet::new();
        known.retain(|(_, id)| ids.insert(id.clone()));
        known.sort_unstable_by_key(|(sequence, _)| *sequence);
        known
            .into_iter()
            .map(|(_, raw)| {
                cua_driver_core::browser::parse_browser_tab_id(&raw).ok_or_else(|| {
                    unknown("actual extension acquisition has an invalid Chrome tab ID")
                })
            })
            .collect()
    }

    fn allocate_extension_sequence(&mut self) -> Result<u64, ToolError> {
        self.next_extension_sequence = self
            .next_extension_sequence
            .checked_add(1)
            .ok_or_else(|| failed("extension tab insertion sequence exhausted"))?;
        Ok(self.next_extension_sequence)
    }

    async fn cleanup_extension_control(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        purpose: FixedCleanupPurpose,
    ) -> Result<(), ToolError> {
        let lease = self
            .tabs
            .get(identity)
            .filter(|lease| lease.creator.owner == owner)
            .ok_or_else(|| unknown("extension control cleanup lost its owned tab"))?;
        if lease
            .extension
            .as_ref()
            .is_some_and(|state| !matches!(state.fixed_preparation, FixedPreparation::NotAttempted))
            && self.fixed_cleanup_protected(owner, identity, &purpose)?
        {
            return Err(ToolError::CleanupUnconfirmed(
                "extension cleanup preserves a newer actual fixed UI context".into(),
            ));
        }
        let lease = self
            .tabs
            .get(identity)
            .ok_or_else(|| unknown("extension control cleanup lost its owned tab"))?;
        let phase = lease
            .extension
            .as_ref()
            .ok_or_else(|| unknown("extension control cleanup lost claim custody"))?
            .control_cleanup
            .clone();
        match phase {
            ControlCleanup::Confirmed => return Ok(()),
            ControlCleanup::Pending => {
                return Err(ToolError::CleanupUnconfirmed(
                    "extension control cleanup is still unsettled; it was not replayed".into(),
                ));
            }
            ControlCleanup::Unconfirmed(reason) => {
                return Err(ToolError::CleanupUnconfirmed(reason));
            }
            ControlCleanup::NotAttempted => {}
        }
        self.tabs
            .get_mut(identity)
            .and_then(|lease| lease.extension.as_mut())
            .ok_or_else(|| unknown("extension control cleanup lost claim custody"))?
            .control_cleanup = ControlCleanup::Pending;
        let logical = self
            .tabs
            .get(identity)
            .and_then(|lease| lease.extension.as_ref())
            .and_then(|state| {
                state
                    .fixed_preparation
                    .cleanup_receipt()
                    .zip(state.fixed_preparation.operation())
            })
            .map(|(receipt, operation)| (receipt.clone(), operation.clone()));
        let result = if let Some((receipt, operation)) = logical {
            let provider = self.tabs[identity].creator.provider.clone();
            let cleanup_control = provider
                .extension()
                .ok_or_else(|| failed("extension cleanup provider unavailable"))?
                .with_host_operation(operation)
                .with_wire_context(receipt.wire_context().clone());
            self.finalize_fixed_session_ui(owner, identity, &receipt, &cleanup_control, purpose)
                .await
        } else {
            self.finalize_extension_cursor(owner, identity, purpose)
                .await
        };
        let state = self
            .tabs
            .get_mut(identity)
            .and_then(|lease| lease.extension.as_mut())
            .ok_or_else(|| unknown("extension control cleanup result lost claim custody"))?;
        match result {
            Ok(()) => {
                state.control_cleanup = ControlCleanup::Confirmed;
                state.overlay = None;
                state.lease_children = None;
                Ok(())
            }
            Err(error) => {
                state.control_cleanup = ControlCleanup::Unconfirmed(error.to_string());
                Err(error)
            }
        }
    }

    fn extension_context(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        context: ExtensionHostOperation,
        epoch: crate::desktop::NativeEpochId,
        target: CallTarget,
        activate: bool,
    ) -> Result<CallScope, ToolError> {
        let (purpose, target) = match target {
            CallTarget::Tab { origin, tab } => (CallPurpose::Tab(origin), tab),
            CallTarget::SessionInventory => (CallPurpose::SessionInventory, None),
            CallTarget::UserContext { tab } => (CallPurpose::UserContext, Some(tab)),
            CallTarget::SessionPresentation => (CallPurpose::SessionPresentation, None),
            CallTarget::SessionHistory => (CallPurpose::SessionHistory, None),
            CallTarget::FixedConfiguration { tab } => (CallPurpose::FixedConfiguration, Some(tab)),
            CallTarget::Retirement => (CallPurpose::Retirement, None),
        };
        let extension = provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?;
        let identity = BrowserIdentity::of(provider, &extension.identity().generation)?;
        if activate {
            self.known(&identity)?;
            // A new logical turn would invalidate an older retained input's
            // actual wire context, including when claiming a sibling tab.
            // Same-turn body preparation still uses the original admission.
            for lease in self
                .tabs
                .values()
                .filter(|lease| lease.creator.owner == owner && lease.creator.provider == *provider)
            {
                if let Some(input) = &lease.input
                    && !input.belongs(Some(&context.turn_id), None)
                {
                    input.check_settled()?;
                }
            }
        }
        if activate
            && self.tabs.values().any(|lease| {
                lease.creator.owner == owner
                    && lease.creator.provider == *provider
                    && (matches!(lease.disposition, Disposition::Closing)
                        || lease.extension.as_ref().is_some_and(|state| {
                            matches!(
                                state.focus_readiness,
                                FocusReadiness::Pending | FocusReadiness::Unknown(_)
                            ) || matches!(
                                state.user_preparation,
                                UserPreparation::Pending(_) | UserPreparation::Unknown(_)
                            ) || matches!(
                                state.claim_preparation,
                                ClaimPreparation::Pending(_) | ClaimPreparation::Unknown { .. }
                            ) || (!state.fixed_preparation.settled()
                                && state.fixed_preparation.ready().is_none())
                        }))
            })
        {
            return Err(ToolError::CleanupUnconfirmed("previous extension attachment settlement must finish before this provider admits more effects".into()));
        }
        let state = self
            .extension
            .get_mut(&(owner, identity))
            .ok_or_else(|| failed("extension provider is not registered to this Session owner"))?;
        if state.owner_parked {
            return Err(failed("extension owner has permanently retired"));
        }
        if activate && state.retiring_turn.is_some() {
            return Err(ToolError::CleanupUnconfirmed(
                "extension turn cleanup must settle before this provider admits another effect"
                    .into(),
            ));
        }
        if activate && state.headers_unknown {
            return Err(ToolError::CleanupUnconfirmed(
                "extension session header state remains uncertain".into(),
            ));
        }
        if activate {
            state.admit_turn(&context.turn_id)?;
        } else if !matches!(
            purpose,
            CallPurpose::Retirement | CallPurpose::FixedConfiguration
        ) && (state.retiring_turn.is_some()
            || state.current_turn.as_deref() != Some(&context.turn_id))
        {
            return Err(ToolError::CleanupUnconfirmed(
                "extension call no longer belongs to the current live turn".to_owned(),
            ));
        }
        let control = extension
            .with_host_operation(context.clone())
            .with_wire_context(
                cua_driver_core::browser::ExtensionWireContext::new(
                    owner.to_string(),
                    context.turn_id.clone(),
                )
                .map_err(failed)?,
            );
        let issued_context = context.clone();
        let issued_turn = context.turn_id.clone();
        let call = state
            .calls
            .entry(context.operation_id)
            .or_insert(CallContext {
                turn: context.turn_id,
                epoch,
                purposes: HashSet::from([purpose]),
                issuing: Arc::new(AtomicUsize::new(0)),
                activation: Arc::new(AtomicBool::new(false)),
                registration: None,
                controls: Arc::new(ControlGate::default()),
            });
        if call.epoch != epoch || call.turn != issued_turn {
            return Err(failed(
                "extension Host operation identity was reused across an epoch or turn",
            ));
        }
        call.purposes.insert(purpose);
        // The original turn-ended handler suppresses new tracker entries while
        // its same-turn detach/cleanup runs. These calls retain their own Core
        // receipts and physical uncertainty without registering another Finish.
        let control = if purpose != CallPurpose::Retirement
            && extension.capabilities().map_or(true, |capabilities| {
                capabilities.turn_lifecycle_owner == ExtensionEffectOwner::Provider
            }) {
            match &call.registration {
                Some(observation) => control
                    .with_session_request_registration(&observation.registration)
                    .map_err(provider::extension_error)?,
                None => {
                    let (control, registration) = control.observe_session_requests();
                    call.registration = Some(SessionRequestRegistration {
                        registration,
                        acknowledged: 0,
                    });
                    control
                }
            }
        } else {
            control
        };
        Ok(CallScope {
            control,
            issuing: call.issuing.clone(),
            activation: call.activation.clone(),
            controls: call.controls.clone(),
            owner,
            provider: provider.clone(),
            context: issued_context,
            epoch,
            target,
            purpose,
        })
    }
    fn begin_handoff_transfer(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        operation: &ExtensionHostOperation,
        epoch: crate::desktop::NativeEpochId,
        target: &str,
    ) -> Result<bool, ToolError> {
        let extension = provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?;
        let browser = BrowserIdentity::of(provider, &extension.identity().generation)?;
        self.known(&browser)?;
        self.check_owned_input(&browser.tab(target))?;
        let Some(lease) = self.tabs.get_mut(&browser.tab(target)) else {
            return Ok(false);
        };
        if lease.handoff_transfer.is_some() {
            return Err(unknown(
                "explicit handoff claim remains unsettled; it was not replayed",
            ));
        }
        let same_parked =
            lease.creator.owner == owner && matches!(lease.disposition, Disposition::Parked);
        if !matches!(lease.retention, Retention::Handoff) && !same_parked {
            return Ok(false);
        }
        if lease.creator.provider != *provider
            || lease.creator.generation != extension.identity().generation
        {
            return Err(failed(
                "explicit handoff claim changed its connected provider",
            ));
        }
        let state = lease
            .extension
            .as_ref()
            .ok_or_else(|| unknown("handoff lost logical custody"))?;
        if state.claim.is_some()
            || state.physical_epoch.is_some()
            || state.physical_cleanup.is_some()
            || state.unknown.is_some()
            || state.cdp_effect_unknown.is_some()
            || !state.fixed_preparation.settled()
            || !state.preparation_effects.settled()
        {
            return Err(unknown("handoff still has physical or uncertain custody"));
        }
        lease.handoff_transfer = Some(Box::new(HandoffTransfer {
            requested: Creator {
                owner,
                turn: operation.turn_id.clone(),
                provider: provider.clone(),
                generation: extension.identity().generation.clone(),
            },
            operation: operation.clone(),
            epoch,
            previous: state.clone(),
            previous_parked: matches!(lease.disposition, Disposition::Parked),
            previous_retention: lease.retention.clone(),
            unknown: None,
            retained_completion: None,
            preparation_phase: Arc::new(AtomicU8::new(HANDOFF_RESERVED)),
            custody: None,
        }));
        lease.extension = Some(ClaimState::default());
        lease.disposition = Disposition::Live;
        Ok(true)
    }

    fn handoff_preparation_boundary(
        &self,
        scope: &CallScope,
        identity: &TabIdentity,
    ) -> Option<Arc<AtomicU8>> {
        self.tabs
            .get(identity)
            .and_then(|lease| lease.handoff_transfer.as_ref())
            .filter(|attempt| {
                attempt.matches(scope.owner, &scope.provider, &scope.context, scope.epoch)
            })
            .map(|attempt| attempt.preparation_phase.clone())
    }

    fn rollback_owner_unentered_handoffs(&mut self, owner: uuid::Uuid) {
        let calls: Vec<_> = self
            .tabs
            .values()
            .filter_map(|lease| {
                let attempt = lease.handoff_transfer.as_ref()?;
                (attempt.requested.owner == owner || lease.creator.owner == owner)
                    .then(|| (attempt.requested.owner, attempt.requested.provider.clone()))
            })
            .collect();
        for (requested, provider) in calls {
            self.rollback_unentered_handoffs(requested, &provider);
        }
    }

    fn rollback_unentered_handoffs(&mut self, owner: uuid::Uuid, provider: &Provider) {
        let candidates: Vec<_> = self
            .tabs
            .iter()
            .filter_map(|(identity, lease)| {
                let attempt = lease.handoff_transfer.as_ref()?;
                if attempt.requested.owner != owner
                    || attempt.requested.provider != *provider
                    || attempt.preparation_phase.load(Ordering::SeqCst) != HANDOFF_RESERVED
                    || attempt.retained_completion.is_some()
                    || attempt.unknown.is_some()
                    || attempt.custody.is_some()
                {
                    return None;
                }
                let call_idle = self
                    .extension
                    .get(&(owner, identity.browser.clone()))
                    .and_then(|state| state.calls.get(&attempt.operation.operation_id))
                    .is_none_or(|call| {
                        Arc::strong_count(&call.issuing) == 1
                            && call.issuing.load(Ordering::SeqCst) == 0
                            && call.controls.is_idle()
                    });
                call_idle.then(|| {
                    (
                        identity.clone(),
                        attempt.operation.clone(),
                        attempt.preparation_phase.clone(),
                        self.extension
                            .get(&(owner, identity.browser.clone()))
                            .and_then(|state| state.calls.get(&attempt.operation.operation_id))
                            .map(|call| call.controls.clone()),
                    )
                })
            })
            .collect();
        for (identity, operation, phase, controls) in candidates {
            if let Some(controls) = controls {
                controls.seal();
            }
            if phase
                .compare_exchange(
                    HANDOFF_RESERVED,
                    HANDOFF_RETIRED,
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                )
                .is_ok()
            {
                self.rollback_handoff_transfer(&identity, owner, &operation);
            }
        }
    }

    fn rollback_handoff_transfer(
        &mut self,
        identity: &TabIdentity,
        owner: uuid::Uuid,
        operation: &ExtensionHostOperation,
    ) -> bool {
        let Some(lease) = self.tabs.get_mut(identity) else {
            return false;
        };
        if !lease.handoff_transfer.as_ref().is_some_and(|attempt| {
            attempt.requested.owner == owner
                && attempt.operation == *operation
                && attempt.unknown.is_none()
                && attempt.custody.is_none()
        }) {
            return false;
        }
        let attempt = lease
            .handoff_transfer
            .take()
            .expect("matched prospective handoff");
        attempt
            .preparation_phase
            .store(HANDOFF_RETIRED, Ordering::SeqCst);
        lease.extension = Some(attempt.previous);
        lease.retention = attempt.previous_retention;
        lease.disposition = if attempt.previous_parked {
            Disposition::Parked
        } else {
            Disposition::Live
        };
        true
    }

    /// Called only with the original call gate's unentered fact or Core's
    /// opaque typed no-dispatch evidence, never a generic remote refusal.
    fn settle_undispatched_preparation(&mut self, scope: &CallScope, identity: &TabIdentity) {
        if self.rollback_handoff_transfer(identity, scope.owner, &scope.context) {
            return;
        }
        if let Some(lease) = self.tabs.get_mut(identity)
            && lease.creator.owner == scope.owner
            && lease.creator.provider == scope.provider
            && lease.handoff_transfer.is_none()
            && let Some(state) = &mut lease.extension
            && matches!(&state.user_preparation, UserPreparation::Pending(issued) if issued == &scope.context)
        {
            state.user_preparation = UserPreparation::NotAttempted;
        }
    }

    fn commit_handoff_transfer(
        &mut self,
        identity: &TabIdentity,
        owner: uuid::Uuid,
        provider: &Provider,
        context: &ExtensionHostOperation,
        epoch: crate::desktop::NativeEpochId,
    ) -> Result<(), ToolError> {
        let Some(lease) = self.tabs.get(identity) else {
            return Err(unknown("claim ACK lost its lease"));
        };
        let Some(attempt) = lease.handoff_transfer.as_ref() else {
            return Ok(());
        };
        if !attempt.matches(owner, provider, context, epoch) || attempt.unknown.is_some() {
            return Err(unknown("claim ACK changed its pending handoff operation"));
        }
        // Allocate only after the matched ACK; metadata selection never acquires.
        let sequence = self.allocate_extension_sequence()?;
        let lease = self
            .tabs
            .get_mut(identity)
            .expect("validated handoff lease");
        let attempt = lease
            .handoff_transfer
            .take()
            .expect("validated handoff attempt");
        let foreign = lease.creator.owner != owner;
        lease.creator = attempt.requested;
        if foreign {
            lease.origin = Origin::UserClaimed;
        }
        lease.extension_sequence = Some(sequence);
        lease.retention = Retention::Unmarked;
        lease.disposition = Disposition::Live;
        // The fresh preparation remains in lease.extension. Previous creation,
        // group, physical tokens and old grants are deliberately not inherited.
        Ok(())
    }

    fn extension_reserve(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        turn: &str,
        target: &str,
        origin: Origin,
    ) -> Result<(), ToolError> {
        let extension = provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?;
        let browser = BrowserIdentity::of(provider, &extension.identity().generation)?;
        self.known(&browser)?;
        let identity = browser.tab(target);
        if let Some(lease) = self.tabs.get(&identity) {
            if lease.handoff_transfer.is_some() {
                return Err(ToolError::CleanupUnconfirmed(
                    "explicit handoff claim remains unsettled; it was not replayed".into(),
                ));
            }
            if lease.creator.owner != owner {
                return Err(failed("tab_owned_by_another_session"));
            }
            if !matches!(lease.disposition, Disposition::Live) {
                return Err(ToolError::CleanupUnconfirmed(
                    "previous extension tab cleanup has not settled".into(),
                ));
            }
            if lease.extension.as_ref().is_some_and(|state| state.revoked)
                && self.logical_fixed_receipt(owner, &identity).is_none()
            {
                return Err(failed(
                    "extension browser control was revoked; explicitly claim the tab again",
                ));
            }
            return Ok(());
        }
        self.tabs.insert(
            identity,
            Lease {
                viewport: None,
                input: None,
                extension_sequence: None,
                creator: Creator {
                    owner,
                    turn: turn.into(),
                    provider: provider.clone(),
                    generation: extension.identity().generation.clone(),
                },
                origin,
                disposition: Disposition::Live,
                retention: Retention::Unmarked,
                handoff_transfer: None,
                logical_lease: None,
                extension: Some(ClaimState::default()),
            },
        );
        Ok(())
    }
    pub(super) async fn reconcile_provider(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
    ) -> Result<bool, ToolError> {
        self.rollback_unentered_handoffs(owner, provider);
        let extension = provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?;
        let browser = BrowserIdentity::of(provider, &extension.identity().generation)?;
        let pending = extension
            .pending_operations()
            .await
            .map_err(provider::extension_error)?;
        let present: HashSet<_> = pending.iter().map(|entry| entry.id).collect();
        if let Some(state) = self.extension.get_mut(&(owner, browser.clone())) {
            state.applied.retain(|id| present.contains(id));
        }
        let mut unsettled = false;
        for completion in pending {
            if completion.provider != *extension.identity() {
                return Err(unknown(
                    "extension completion belongs to another physical generation",
                ));
            }
            if completion.outcome.is_none() {
                unsettled = true;
                continue;
            }
            if let Some(source) = PopupSource::from_operation(&completion.operation) {
                if source.wire_context().host_session_id() != owner.to_string() {
                    // A shared provider's observer never consumes another
                    // Session owner's retained intent or Unknown custody.
                    continue;
                }
                let issued = self
                    .extension
                    .get(&(owner, browser.clone()))
                    .is_some_and(|state| state.applied.contains(&completion.id));
                if issued || self.extension_popup_source_current(owner, provider, &source) {
                    // Metadata stays in the original charged completion store
                    // until a fresh Host source-lease service consumes it.
                    continue;
                }
                extension
                    .acknowledge_completion(completion.id)
                    .await
                    .map_err(provider::extension_error)?;
                continue;
            }
            let already = self
                .extension
                .get(&(owner, browser.clone()))
                .is_some_and(|state| state.applied.contains(&completion.id));
            if !already {
                let recovered = extension
                    .recover_completion(completion.id)
                    .await
                    .map_err(provider::extension_error)?;
                if let Some(context) = &completion.host_operation {
                    for lease in self.tabs.values_mut() {
                        if let Some(attempt) = &mut lease.handoff_transfer
                            && attempt.requested.owner == owner
                            && attempt.requested.provider == *provider
                            && attempt.operation == *context
                        {
                            attempt.retained_completion = Some(completion.id);
                        }
                    }
                }
                let completed = cua_driver_core::browser::ExtensionOperationCompletion {
                    id: completion.id,
                    provider: completion.provider.clone(),
                    host_operation: completion.host_operation.clone(),
                    wire_context: completion.wire_context.clone(),
                    operation: completion.operation.clone(),
                    outcome: completion
                        .outcome
                        .clone()
                        .expect("completed outcome checked"),
                };
                self.apply_extension_completion(owner, provider, &completed, recovered)?;
            }
            let retained_cleanup = self.tabs.values().any(|lease| {
                lease.creator.owner == owner
                    && lease.creator.provider == *provider
                    && lease
                        .extension
                        .as_ref()
                        .and_then(|state| state.physical_cleanup.as_ref())
                        .is_some_and(|cleanup| cleanup.completion_id() == completion.id)
            });
            let retained_transfer = self.tabs.values().any(|lease| {
                lease.handoff_transfer.as_ref().is_some_and(|attempt| {
                    attempt.requested.owner == owner
                        && attempt.requested.provider == *provider
                        && attempt.retained_completion == Some(completion.id)
                })
            });
            if !retained_cleanup && !retained_transfer {
                extension
                    .acknowledge_completion(completion.id)
                    .await
                    .map_err(provider::extension_error)?;
            }
        }
        let pending_contexts: HashSet<_> = extension
            .pending_operations()
            .await
            .map_err(provider::extension_error)?
            .iter()
            .filter_map(|entry| {
                entry
                    .host_operation
                    .as_ref()
                    .map(|context| context.operation_id.clone())
            })
            .collect();
        if let Some(state) = self.extension.get_mut(&(owner, browser)) {
            state.fold_activation();
            state.calls.retain(|id, call| {
                Arc::strong_count(&call.issuing) > 1
                    || call.issuing.load(Ordering::SeqCst) > 0
                    || pending_contexts.contains(id)
            });
        }
        Ok(unsettled)
    }
    fn apply_mark_result(
        &mut self,
        identity: &TabIdentity,
        owner: uuid::Uuid,
        context: Option<&ExtensionHostOperation>,
        epoch: crate::desktop::NativeEpochId,
        expected_status: Option<TabMark>,
        result: Result<(), MarkFailure>,
    ) -> Result<(), ToolError> {
        let operation =
            context.ok_or_else(|| unknown("tab mark lost its issued Host operation"))?;
        let attempt = match &self
            .tabs
            .get(identity)
            .ok_or_else(|| unknown("tab mark lost its owned lease"))?
            .retention
        {
            Retention::Pending(attempt) | Retention::Unknown { attempt, .. } => attempt.clone(),
            _ => return Err(unknown("tab mark reply has no pending issued intent")),
        };
        if !attempt.matches(operation, epoch)
            || expected_status.is_some_and(|status| status != attempt.status())
        {
            return Err(unknown(
                "tab mark reply changed its issued turn, operation or epoch",
            ));
        }
        self.mark_result(identity, owner, &attempt, result)
    }

    fn resume_marked_handoffs(&mut self, owner: uuid::Uuid, provider: &Provider, turn: &str) {
        let mut resumed = Vec::new();
        for (identity, lease) in &mut self.tabs {
            if lease.creator.owner == owner
                && lease.creator.provider == *provider
                && lease.handoff_transfer.is_none()
                && matches!(lease.retention, Retention::Handoff)
                && lease.creator.turn != turn
            {
                lease.creator.turn = turn.to_owned();
                lease.retention = Retention::Unmarked;
                resumed.push((
                    lease.extension_sequence.unwrap_or(u64::MAX),
                    identity.target.clone(),
                    lease.extension.as_ref().is_some_and(|state| state.active),
                ));
            }
        }
        resumed.sort_unstable_by_key(|row| row.0);
        let active = resumed
            .iter()
            .find(|row| row.2)
            .or_else(|| resumed.first())
            .map(|row| row.1.clone());
        if let Some(active) = active
            && let Some(extension) = provider.extension()
            && let Ok(browser) = BrowserIdentity::of(provider, &extension.identity().generation)
            && let Some(state) = self.extension.get_mut(&(owner, browser))
        {
            state.logical_active = Some(active);
        }
    }

    fn apply_extension_cleanup(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        browser: &BrowserIdentity,
        operation: &ExtensionOperation,
        target: Option<&str>,
        proof: Option<&CleanupProof>,
    ) {
        if let ExtensionOperation::StopCreatedTab { creation, .. } = operation {
            self.uncertain_creations.retain(|_, uncertain| {
                !(uncertain.creator.owner == owner
                    && uncertain.creator.provider == *provider
                    && uncertain
                        .extension
                        .as_ref()
                        .is_some_and(|receipt| receipt.creation_id() == creation))
            });
        }
        if let Some(target) = target
            && let Some(lease) = self.tabs.get_mut(&browser.tab(target))
            && lease.creator.owner == owner
            && lease.creator.provider == *provider
            && lease.handoff_transfer.is_none()
            && let Some(state) = &mut lease.extension
        {
            match operation {
                ExtensionOperation::Detach { .. } => {
                    state.released = true;
                }
                ExtensionOperation::CloseTab { .. } | ExtensionOperation::StopCreatedTab { .. } => {
                    state.closed = true;
                    state.released = true;
                }
                _ => {}
            }
            state.headers_active = false;
            state.cleanup_started = true;
            if let Some(proof) = proof {
                state.physical_cleanup = Some(proof.clone());
            }
        }
    }

    fn begin_extension_cleanup(&mut self, identity: &TabIdentity) -> Result<(), ToolError> {
        let state = self
            .tabs
            .get_mut(identity)
            .and_then(|lease| lease.extension.as_mut())
            .ok_or_else(|| unknown("extension cleanup lost its exact claim custody"))?;
        if state.cleanup_started {
            return Err(ToolError::CleanupUnconfirmed(
                "the same extension physical cleanup remains unsettled; it was not replayed".into(),
            ));
        }
        state.cleanup_started = true;
        Ok(())
    }

    async fn retire_extension_cleanup(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        identity: &TabIdentity,
        control: &ExtensionBrowserProvider,
    ) -> Result<(), ToolError> {
        let owned = self.tabs.get(identity).is_some_and(|lease| {
            lease.creator.owner == owner
                && lease.creator.provider == *provider
                && lease.handoff_transfer.is_none()
        });
        if !owned {
            return Err(unknown(
                "old cleanup cannot retire another owner's resource",
            ));
        }
        // This folds extension-local facts only. The outer Host's original journal
        // and retained effect futures keep their own T1/T2 custody independently.
        if self.reconcile_provider(owner, provider).await? {
            return Err(ToolError::CleanupUnconfirmed(
                "extension control custody remains pending before claim retirement".into(),
            ));
        }
        let state = self
            .tabs
            .get(identity)
            .and_then(|lease| lease.extension.as_ref())
            .ok_or_else(|| unknown("extension retirement lost its exact claim custody"))?
            .clone();
        if !state.preparation_effects.settled() {
            return Err(ToolError::CleanupUnconfirmed(
                "extension fixed preparation or scoped header cleanup remains unconfirmed".into(),
            ));
        }
        if let Some(reason) = &state.cdp_effect_unknown {
            return Err(ToolError::CleanupUnconfirmed(format!(
                "underlying Chrome effect remains unknown after extension invocation/physical cleanup: {reason}"
            )));
        }
        if let Some(reason) = &state.unknown {
            return Err(ToolError::CleanupUnconfirmed(format!(
                "extension effect custody remains unknown before claim retirement: {reason}"
            )));
        }
        let Some(cleanup) = state.physical_cleanup else {
            if state.claim.is_none() {
                return Ok(());
            }
            return Err(ToolError::CleanupUnconfirmed(format!(
                "extension claim lacks its retained known physical cleanup proof{}",
                state
                    .cleanup_revocation
                    .as_deref()
                    .map(|reason| format!("; observed revocation: {reason}"))
                    .unwrap_or_default(),
            )));
        };
        if let Some(claim) = &state.claim {
            let drain = state.cdp_drain.as_ref().ok_or_else(|| {
                ToolError::CleanupUnconfirmed(
                    "extension claim lacks its exact fenced extension-invocation drain proof"
                        .into(),
                )
            })?;
            match state.retirement {
                ClaimRetirement::Confirmed => {}
                ClaimRetirement::Pending => {
                    return Err(ToolError::CleanupUnconfirmed(
                        "local extension retirement remains unsettled; it was not replayed".into(),
                    ));
                }
                ClaimRetirement::Unknown(reason) => {
                    return Err(ToolError::CleanupUnconfirmed(reason));
                }
                ClaimRetirement::NotAttempted => {
                    self.tabs
                        .get_mut(identity)
                        .and_then(|lease| lease.extension.as_mut())
                        .ok_or_else(|| unknown("extension retirement lost custody"))?
                        .retirement = ClaimRetirement::Pending;
                    let retired = control.retire_claim(claim, &cleanup, drain).await;
                    let retirement = match &retired {
                        Ok(()) => ClaimRetirement::Confirmed,
                        Err(error) if control.undispatched_control(error).is_some() => {
                            ClaimRetirement::NotAttempted
                        }
                        Err(error) => ClaimRetirement::Unknown(error.to_string()),
                    };
                    self.tabs
                        .get_mut(identity)
                        .and_then(|lease| lease.extension.as_mut())
                        .ok_or_else(|| unknown("extension retirement result lost custody"))?
                        .retirement = retirement;
                    retired.map_err(provider::extension_error)?;
                }
            }
        }
        // Only a matched local retirement permits consumption of the exact
        // physical cleanup receipt. This ACK does not claim Chrome input success.
        control
            .acknowledge_completion(cleanup.completion_id())
            .await
            .map_err(provider::extension_error)?;
        let state = self
            .tabs
            .get_mut(identity)
            .and_then(|lease| lease.extension.as_mut())
            .ok_or_else(|| unknown("extension cleanup ACK lost custody"))?;
        state.claim = None;
        state.physical_epoch = None;
        state.physical_cleanup = None;
        state.cdp_drain = None;
        if state.closed {
            state.creation = None;
            state.creation_operation = None;
            state.group = None;
        }
        Ok(())
    }

    fn apply_user_preparation(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        browser: &BrowserIdentity,
        target: Option<String>,
        receipt: PreparedOperation,
        tab: cua_driver_core::browser::ExtensionTabInfo,
    ) -> Result<(), ToolError> {
        let target =
            target.ok_or_else(|| unknown("extension preparation ACK lost its issued target"))?;
        if tab.id.to_string() != target {
            return Err(unknown(
                "extension preparation ACK changed its issued target",
            ));
        }
        let extension = provider
            .extension()
            .ok_or_else(|| unknown("preparation ACK lost its provider"))?;
        let generation = &extension.identity().generation;
        let persistent = extension
            .capabilities()
            .is_ok_and(|caps| caps.logical_lease_persistence);
        let logical_lease = if persistent { tab.logical_lease } else { None };
        let identity = browser.tab(&target);
        let acquired = match &receipt {
            PreparedOperation::Acquired { operation, epoch } => Some((operation, *epoch)),
            _ => None,
        };
        if let Some(logical) = &logical_lease {
            if logical.tab_id.to_string() != target
                || logical.host_session_id != owner.to_string()
                || acquired.is_some_and(|(operation, _)| logical.host_turn_id != operation.turn_id)
                || logical.phase != cua_driver_core::browser::ExtensionLogicalLeasePhase::Live
            {
                return Err(unknown(
                    "acquisition logical projection changed its issued scope",
                ));
            }
        } else if acquired.is_some() && persistent {
            return Err(unknown(
                "persistent acquisition omitted its logical projection",
            ));
        }
        let lease = self
            .tabs
            .get(&identity)
            .ok_or_else(|| unknown("preparation ACK lost its reserved lease"))?;
        let prospective = lease.handoff_transfer.as_ref().is_some_and(|attempt| {
            acquired.is_some_and(|(operation, epoch)| {
                attempt.matches(owner, provider, operation, epoch)
            }) && attempt.unknown.is_none()
        });
        if (!prospective && lease.creator.owner != owner)
            || lease.creator.provider != *provider
            || &lease.creator.generation != generation
            || lease.extension.is_none()
        {
            return Err(unknown(
                "preparation ACK changed its reserved owner or custody",
            ));
        }
        if let Some((operation, epoch)) = acquired {
            let current = self
                .extension
                .get(&(owner, browser.clone()))
                .is_some_and(|state| {
                    !state.owner_parked
                        && state.retiring_turn.is_none()
                        && state.current_turn.as_deref() == Some(operation.turn_id.as_str())
                        && state
                            .calls
                            .get(&operation.operation_id)
                            .is_some_and(|call| {
                                call.epoch == epoch
                                    && call.turn == operation.turn_id
                                    && !call.controls.is_sealed()
                            })
                });
            if !current {
                return Err(unknown(
                    "late acquisition ACK is retained for cleanup after its call retired",
                ));
            }
        }
        // All receipt, current-call and projection checks precede changing Creator.
        // Fixed preparation has already retained and validated its exact receipt.
        if let Some((operation, epoch)) = acquired {
            self.commit_handoff_transfer(&identity, owner, provider, operation, epoch)?;
        }
        let previous_logical = acquired.and(logical_lease.as_ref()).and_then(|logical| {
            self.tabs
                .iter()
                .find(|(old, lease)| {
                    **old != identity
                        && lease.creator.owner == owner
                        && lease.logical_lease.as_ref().is_some_and(|previous| {
                            previous.chrome_session_id == logical.chrome_session_id
                                && previous.logical_lease_id == logical.logical_lease_id
                                && previous.host_session_id == logical.host_session_id
                                && previous.tab_id == logical.tab_id
                        })
                })
                .map(|(old, lease)| ((*old).clone(), lease.extension_sequence))
        });
        let prior_sequence = self.tabs[&identity].extension_sequence.or_else(|| {
            previous_logical
                .as_ref()
                .and_then(|(_, sequence)| *sequence)
        });
        let sequence = match (&receipt, prior_sequence) {
            (_, Some(sequence)) => Some(sequence),
            (PreparedOperation::Acquired { .. }, None) => Some(self.allocate_extension_sequence()?),
            (PreparedOperation::Observed, None) => None,
        };
        if let Some((previous, _)) = previous_logical {
            let settled = self.tabs[&previous].extension.as_ref().is_none_or(|state| {
                state.claim.is_none()
                    && state.unknown.is_none()
                    && state.cdp_effect_unknown.is_none()
                    && state.fixed_preparation.settled()
                    && state.preparation_effects.settled()
            });
            if settled {
                self.tabs.remove(&previous);
            } else if let Some(old) = self.tabs.get_mut(&previous) {
                old.logical_lease = None;
                old.retention = Retention::Unmarked;
                old.disposition = Disposition::Closing;
            }
        }
        let lease = self
            .tabs
            .get_mut(&identity)
            .expect("validated reserved lease");
        lease.extension_sequence = sequence;
        if let Some(logical) = logical_lease {
            lease.origin = match logical.origin {
                cua_driver_core::browser::ExtensionLogicalLeaseOrigin::AgentCreated => {
                    Origin::AgentCreated
                }
                cua_driver_core::browser::ExtensionLogicalLeaseOrigin::UserClaimed => {
                    Origin::UserClaimed
                }
            };
            lease.retention = logical.status.map_or(Retention::Unmarked, |status| {
                Retention::Marked(mark_from_core(status))
            });
            lease.logical_lease = Some(logical);
        }
        if let PreparedOperation::Acquired { operation, .. } = &receipt {
            lease.creator.turn = operation.turn_id.clone();
        }
        let state = lease
            .extension
            .as_mut()
            .expect("validated extension custody");
        state.user_preparation = UserPreparation::Completed;
        state.user_prepared_operation = Some(receipt);
        Ok(())
    }

    fn apply_logical_commit(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        turn: &str,
        commit: Option<&cua_driver_core::browser::ExtensionLogicalLeaseCommit>,
    ) -> Result<(), ToolError> {
        if !provider.extension().is_some_and(|extension| {
            extension
                .capabilities()
                .is_ok_and(|caps| caps.logical_lease_persistence)
        }) {
            return Ok(());
        }
        let Some(commit) = commit else {
            return Ok(());
        };
        for lease in self.tabs.values_mut().filter(|lease| {
            lease.creator.owner == owner
                && lease.creator.provider == *provider
                && lease.creator.turn == turn
        }) {
            let Some(current) = &lease.logical_lease else {
                continue;
            };
            if current.chrome_session_id != commit.chrome_session_id {
                return Err(unknown("logical commit changed browser session"));
            }
            if let Some(kept) = commit
                .kept
                .iter()
                .find(|entry| entry.logical_lease_id == current.logical_lease_id)
            {
                if kept.tab_id != current.tab_id
                    || kept.origin != current.origin
                    || lease.retention.mark()? != Some(TabMark::Handoff)
                {
                    return Err(unknown(
                        "logical handoff commit changed its resource or disposition",
                    ));
                }
                lease.logical_lease = Some(kept.clone());
            } else if let Some(released) = commit
                .released
                .iter()
                .find(|entry| entry.logical_lease_id == current.logical_lease_id)
            {
                if released.tab_id != current.tab_id
                    || released.origin != current.origin
                    || released.status != lease.retention.mark()?.map(mark_to_core)
                {
                    return Err(unknown(
                        "logical release commit changed its resource or mark",
                    ));
                }
                lease.logical_lease = None;
            } else if lease.retention.mark()?.is_some()
                && !lease.extension.as_ref().is_some_and(|state| state.closed)
            {
                return Err(unknown(
                    "logical commit omitted an existing marked resource",
                ));
            }
        }
        Ok(())
    }

    fn finish_session_activation(
        &mut self,
        owner: uuid::Uuid,
        browser: &BrowserIdentity,
        turn: &str,
    ) {
        self.clear_pending_viewport(owner, browser, turn);
        if let Some(state) = self.extension.get_mut(&(owner, browser.clone())) {
            for call in state.calls.values_mut().filter(|call| call.turn == turn) {
                call.activation.store(false, Ordering::SeqCst);
                if let Some(observation) = &mut call.registration {
                    observation.acknowledged = observation.registration.count();
                }
            }
        }
    }

    fn apply_extension_completion(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        completion: &cua_driver_core::browser::ExtensionOperationCompletion,
        recovered: ExtensionRecoveredOperation,
    ) -> Result<(), ToolError> {
        let operation = &completion.operation;
        let context = completion.host_operation.as_ref();
        let extension = provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?;
        let browser = BrowserIdentity::of(provider, &extension.identity().generation)?;
        if completion.provider != *extension.identity() {
            return Err(unknown(
                "extension completion changed its actual provider generation",
            ));
        }
        if self
            .extension
            .get(&(owner, browser.clone()))
            .is_some_and(|state| state.applied.contains(&completion.id))
        {
            return Ok(());
        }
        let call = context
            .and_then(|context| {
                self.extension
                    .get(&(owner, browser.clone()))
                    .and_then(|state| state.calls.get(&context.operation_id))
            })
            .cloned();
        let event = matches!(
            &recovered,
            ExtensionRecoveredOperation::OrphanCdpCompletion { .. }
                | ExtensionRecoveredOperation::EffectsCleanup { .. }
                | ExtensionRecoveredOperation::PopupRequested(_)
                | ExtensionRecoveredOperation::SessionPopupRequested(_)
                | ExtensionRecoveredOperation::SessionPreparationCleanup(_)
        );
        if call.is_none() && !event {
            return Err(ToolError::CleanupUnconfirmed(
                "extension mutation completed without its issued Host operation context".into(),
            ));
        }
        let target = match operation {
            ExtensionOperation::BeginUpload { tab_id, .. } => Some(tab_id.to_string()),
            ExtensionOperation::WriteUploadChunk { stage, .. }
            | ExtensionOperation::RetainUploadForSelection { stage }
            | ExtensionOperation::AbandonUpload { stage } => {
                self.upload_target(owner, &browser, stage)
            }
            ExtensionOperation::MarkTab { tab_id, .. }
            | ExtensionOperation::Attach { tab_id }
            | ExtensionOperation::PrepareUserTab { tab_id }
            | ExtensionOperation::PrepareSessionTab { tab_id }
            | ExtensionOperation::PrepareFixedSessionTab { tab_id, .. } => Some(tab_id.to_string()),
            ExtensionOperation::SessionUi { receipt, .. }
            | ExtensionOperation::ClearSessionPreparation { receipt } => {
                Some(receipt.tab_id().to_string())
            }
            ExtensionOperation::Detach { claim, .. }
            | ExtensionOperation::CloseTab { claim, .. }
            | ExtensionOperation::PrepareClaim { claim, .. }
            | ExtensionOperation::SetScopedHeaders { claim }
            | ExtensionOperation::ClearScopedHeaders { claim }
            | ExtensionOperation::MoveMousePresentation { claim, .. } => self
                .tabs
                .iter()
                .find(|(_, lease)| {
                    lease.creator.owner == owner
                        && lease.creator.provider == *provider
                        && lease
                            .extension
                            .as_ref()
                            .and_then(|state| state.claim.as_ref())
                            .is_some_and(|owned| owned.claim_id() == claim)
                })
                .map(|(identity, _)| identity.target.clone()),
            ExtensionOperation::StopCreatedTab { creation, .. }
            | ExtensionOperation::MuteCreatedTab { creation }
            | ExtensionOperation::UnmuteCreatedTabIfActive { creation }
            | ExtensionOperation::EnsureCreatedTabGroup { creation }
            | ExtensionOperation::UpdateCreatedTabGroup { creation, .. }
            | ExtensionOperation::ReleaseCreatedTabGroup { creation, .. } => self
                .tabs
                .iter()
                .find(|(_, lease)| {
                    lease.creator.owner == owner
                        && lease.creator.provider == *provider
                        && lease
                            .extension
                            .as_ref()
                            .and_then(|state| state.creation.as_ref())
                            .is_some_and(|owned| owned.creation_id() == creation)
                })
                .map(|(identity, _)| identity.target.clone()),
            _ => None,
        };
        // Only known completed activating controls resume old logical handoffs.
        // No preparation claim, grant or mark survives from their previous turn.
        if !matches!(
            &recovered,
            ExtensionRecoveredOperation::Unknown { .. }
                | ExtensionRecoveredOperation::Refused { .. }
                | ExtensionRecoveredOperation::ChromeRejected { .. }
                | ExtensionRecoveredOperation::NotDispatched { .. }
        ) && matches!(
            operation,
            ExtensionOperation::SessionInventory
                | ExtensionOperation::ResolveSessionTab { .. }
                | ExtensionOperation::CommittedSessionTabUrl { .. }
                | ExtensionOperation::PrepareSessionTab { .. }
                | ExtensionOperation::PrepareFixedSessionTab { .. }
                | ExtensionOperation::Attach { .. }
                | ExtensionOperation::CreateTab { .. }
                | ExtensionOperation::CreatePopupTab { .. }
                | ExtensionOperation::CreateSessionPopupTab { .. }
                | ExtensionOperation::SetSessionHeaders { .. }
                | ExtensionOperation::ClearSessionHeaders
                | ExtensionOperation::MarkTab { .. }
                | ExtensionOperation::MoveMousePresentation { .. }
        ) && let Some(context) = context
        {
            self.resume_marked_handoffs(owner, provider, &context.turn_id);
        }
        if let (Some(target), Some(context), Some(call)) = (target.as_ref(), context, call.as_ref())
        {
            let identity = browser.tab(target);
            let pending = self
                .tabs
                .get(&identity)
                .and_then(|lease| lease.handoff_transfer.as_ref())
                .is_some_and(|attempt| attempt.matches(owner, provider, context, call.epoch));
            if pending {
                match &recovered {
                    ExtensionRecoveredOperation::NotDispatched { .. } => {
                        self.rollback_handoff_transfer(&identity, owner, context);
                        return Ok(());
                    }
                    ExtensionRecoveredOperation::Unknown {
                        reason, custody, ..
                    } => {
                        let attempt = self
                            .tabs
                            .get_mut(&identity)
                            .and_then(|lease| lease.handoff_transfer.as_mut())
                            .expect("matched pending handoff");
                        attempt.unknown = Some(reason.clone());
                        attempt.custody = Some(custody.clone());
                        return Ok(());
                    }
                    ExtensionRecoveredOperation::Refused { message, .. }
                    | ExtensionRecoveredOperation::ChromeRejected { message, .. } => {
                        self.tabs
                            .get_mut(&identity)
                            .and_then(|lease| lease.handoff_transfer.as_mut())
                            .expect("matched pending handoff")
                            .unknown = Some(message.clone());
                        return Ok(());
                    }
                    _ => {}
                }
            }
        }
        let not_dispatched = matches!(
            &recovered,
            ExtensionRecoveredOperation::NotDispatched { .. }
        );
        match recovered {
            ExtensionRecoveredOperation::UserHistory => {}
            ExtensionRecoveredOperation::SessionNamed { name } => {
                let state = self
                    .extension
                    .get_mut(&(owner, browser.clone()))
                    .ok_or_else(|| unknown("session-name owner retired"))?;
                state.session_group_title = Some(name);
            }
            upload @ (ExtensionRecoveredOperation::UploadBegun(_)
            | ExtensionRecoveredOperation::UploadChunkWritten(_)
            | ExtensionRecoveredOperation::UploadRetained(_)
            | ExtensionRecoveredOperation::UploadAbandoned(_)) => {
                self.apply_upload_completion(owner, provider, completion, upload)?
            }
            ExtensionRecoveredOperation::Marked(ack) => {
                let target = target
                    .as_ref()
                    .ok_or_else(|| unknown("tab mark ACK lost its target"))?;
                let call = call
                    .as_ref()
                    .ok_or_else(|| unknown("tab mark ACK lost its epoch"))?;
                if ack.host_session_id != owner.to_string()
                    || ack.host_turn_id != call.turn
                    || ack.generation != extension.identity().generation
                    || ack.tab_id.to_string() != *target
                    || ack.is_cleanup_only()
                {
                    return Err(unknown(
                        "tab mark ACK changed its captured owner, turn or target",
                    ));
                }
                if extension
                    .capabilities()
                    .is_ok_and(|caps| caps.logical_lease_persistence)
                    && let Some(logical) = &ack.logical_lease
                {
                    self.tabs
                        .get_mut(&browser.tab(target))
                        .ok_or_else(|| unknown("mark projection lost its lease"))?
                        .logical_lease = Some(logical.clone());
                }
                self.apply_mark_result(
                    &browser.tab(target),
                    owner,
                    context,
                    call.epoch,
                    Some(mark_from_core(ack.status)),
                    Ok(()),
                )?;
            }
            ExtensionRecoveredOperation::SessionHeaders(proof) => {
                let call = call
                    .as_ref()
                    .ok_or_else(|| unknown("session header result lost its Host context"))?;
                if proof.host_session_id != owner.to_string()
                    || proof.host_turn_id != call.turn
                    || proof.generation != extension.identity().generation
                {
                    return Err(unknown("extension session header result identity mismatch"));
                }
                let state = self
                    .extension
                    .get_mut(&(owner, browser.clone()))
                    .ok_or_else(|| unknown("extension session header owner retired"))?;
                state.headers_unknown =
                    !proof.state_confirmed || (!proof.active && !proof.cleanup_confirmed);
                state.session_headers = Some(proof);
            }
            ExtensionRecoveredOperation::FixedSessionPrepared(prepared) => {
                let prepared = *prepared;
                let tab = prepared.tab.clone();
                self.apply_fixed_preparation(owner, provider, operation, context, prepared)?;
                if let Some(state) = self
                    .tabs
                    .get_mut(&browser.tab(&tab.id.to_string()))
                    .and_then(|lease| lease.extension.as_mut())
                {
                    state.control_cleanup = ControlCleanup::NotAttempted;
                }
                let ready = self
                    .tabs
                    .get(&browser.tab(&tab.id.to_string()))
                    .and_then(|lease| lease.extension.as_ref())
                    .is_some_and(|state| state.fixed_preparation.ready().is_some());
                if ready {
                    let context = context.ok_or_else(|| {
                        unknown("fixed preparation lost its actual acquisition operation")
                    })?;
                    let epoch = call
                        .as_ref()
                        .ok_or_else(|| unknown("fixed acquisition lost its actual epoch"))?
                        .epoch;
                    self.apply_user_preparation(
                        owner,
                        provider,
                        &browser,
                        Some(tab.id.to_string()),
                        PreparedOperation::Acquired {
                            operation: context.clone(),
                            epoch,
                        },
                        tab,
                    )?;
                }
            }
            ExtensionRecoveredOperation::FixedUi(proof) => {
                self.apply_fixed_ui(owner, provider, operation, context, proof)?;
                if let ExtensionOperation::SessionUi { receipt, .. } = operation
                    && let Some(state) = self
                        .tabs
                        .get_mut(&browser.tab(&receipt.tab_id().to_string()))
                        .and_then(|lease| lease.extension.as_mut())
                {
                    state.control_cleanup = ControlCleanup::NotAttempted;
                }
            }
            ExtensionRecoveredOperation::FixedSessionCleared(proof) => {
                self.apply_fixed_clear(owner, provider, operation, context, proof)?;
            }
            ExtensionRecoveredOperation::CursorPresentation(_) => {}
            ExtensionRecoveredOperation::TurnFinished(ack) => {
                let call =
                    call.ok_or_else(|| unknown("extension logical finish lost its Host context"))?;
                if ack.host_session_id != owner.to_string() || ack.host_turn_id != call.turn {
                    return Err(unknown("extension logical finish identity mismatch"));
                }
                self.apply_logical_commit(
                    owner,
                    provider,
                    &call.turn,
                    ack.logical_lease_commit.as_ref(),
                )?;
                self.extension
                    .get_mut(&(owner, browser.clone()))
                    .ok_or_else(|| unknown("extension finish owner retired"))?
                    .finish_phases
                    .insert(call.turn.clone(), FinishPhase::Acknowledged);
                self.finish_session_activation(owner, &browser, &call.turn);
            }
            ExtensionRecoveredOperation::Created(created) => {
                let call = call.ok_or_else(|| unknown("created tab lost its Host context"))?;
                if !call
                    .purposes
                    .contains(&CallPurpose::Tab(Origin::AgentCreated))
                {
                    return Err(unknown(
                        "extension creation completed under a user-claim operation context",
                    ));
                }
                let identity = browser.tab(&created.tab.id.to_string());
                if self.tabs.contains_key(&identity) {
                    return Err(unknown(
                        "extension creation reused a leased target identity",
                    ));
                }
                let sequence = self.allocate_extension_sequence()?;
                self.tabs.insert(
                    identity,
                    Lease {
                        viewport: None,
                        input: None,
                        extension_sequence: Some(sequence),
                        creator: Creator {
                            owner,
                            turn: call.turn,
                            provider: provider.clone(),
                            generation: extension.identity().generation.clone(),
                        },
                        origin: Origin::AgentCreated,
                        disposition: Disposition::Live,
                        retention: Retention::Unmarked,
                        handoff_transfer: None,
                        logical_lease: None,
                        extension: Some(ClaimState {
                            creation: Some(created.creation_receipt().clone()),
                            creation_operation: context.cloned().map(|operation| {
                                CreatedOperation {
                                    operation,
                                    epoch: call.epoch,
                                }
                            }),
                            active: created.tab.active.unwrap_or(false),
                            ..Default::default()
                        }),
                    },
                );
            }
            ExtensionRecoveredOperation::Claim(claim) => {
                let identity = browser.tab(&claim.tab_id().to_string());
                let sequence = match self
                    .tabs
                    .get(&identity)
                    .and_then(|lease| lease.extension_sequence)
                {
                    Some(sequence) => sequence,
                    None => self.allocate_extension_sequence()?,
                };
                let lease = self.tabs.get_mut(&identity).ok_or_else(|| {
                    unknown("extension attachment completed without reserved custody")
                })?;
                if lease.creator.owner != owner {
                    return Err(unknown("extension claim owner changed before completion"));
                }
                lease.extension_sequence = Some(sequence);
                let state = lease
                    .extension
                    .as_mut()
                    .ok_or_else(|| unknown("extension claim replaced CDP custody"))?;
                if state
                    .claim
                    .as_ref()
                    .is_none_or(|previous| previous.claim_id() != claim.claim_id())
                {
                    state.focus_readiness = FocusReadiness::NotAttempted;
                    state.claim_preparation = ClaimPreparation::NotAttempted;
                    state.preparation_effects = PreparationEffects::default();
                    state.control_cleanup = ControlCleanup::NotAttempted;
                    state.overlay = None;
                    if matches!(state.fixed_preparation, FixedPreparation::NotAttempted) {
                        state.lease_children = None;
                    }
                }
                state.physical_epoch = call.as_ref().map(|call| call.epoch);
                state.claim = Some(claim);
                state.released = false;
            }
            ExtensionRecoveredOperation::Cleanup(proof) => {
                self.apply_extension_cleanup(
                    owner,
                    provider,
                    &browser,
                    operation,
                    target.as_deref(),
                    Some(&proof),
                );
            }
            ExtensionRecoveredOperation::Headers(proof) => {
                if let Some(target) = target
                    && let Some(lease) = self.tabs.get_mut(&browser.tab(&target))
                    && let Some(state) = &mut lease.extension
                {
                    state.headers_active = proof.active;
                    if !proof.active && proof.cleanup_confirmed {
                        state.preparation_effects.headers_may_exist = false;
                    }
                    if !proof.cleanup_confirmed && proof.pending_removal {
                        state.unknown = Some("extension header cleanup is pending".into());
                        lease.disposition = Disposition::Closing;
                    }
                }
            }
            ExtensionRecoveredOperation::Group(proof) => {
                if let Some(target) = target
                    && let Some(lease) = self.tabs.get_mut(&browser.tab(&target))
                    && let Some(state) = &mut lease.extension
                {
                    state.group = Some(proof.group);
                }
            }
            ExtensionRecoveredOperation::GroupReleased(_) => {
                if let Some(target) = target
                    && let Some(lease) = self.tabs.get_mut(&browser.tab(&target))
                    && let Some(state) = &mut lease.extension
                {
                    state.group = None;
                }
            }
            ExtensionRecoveredOperation::ClaimPrepared(proof) => {
                self.apply_claim_preparation(owner, provider, context, proof)?;
            }
            ExtensionRecoveredOperation::PopupRequested(_)
            | ExtensionRecoveredOperation::SessionPopupRequested(_) => {}
            ExtensionRecoveredOperation::SessionPreparationCleanup(observation) => {
                self.apply_fixed_cleanup_observation(owner, provider, observation)?;
            }
            ExtensionRecoveredOperation::Prepared(prepared) => {
                context
                    .ok_or_else(|| unknown("extension preparation ACK lost its Host operation"))?;
                self.apply_user_preparation(
                    owner,
                    provider,
                    &browser,
                    target,
                    PreparedOperation::Observed,
                    prepared.tab,
                )?;
            }
            ExtensionRecoveredOperation::SessionPrepared(prepared) => {
                let operation = context
                    .cloned()
                    .ok_or_else(|| unknown("extension session ACK lost its Host operation"))?;
                let epoch = call
                    .as_ref()
                    .ok_or_else(|| unknown("extension session ACK lost its issued epoch"))?
                    .epoch;
                self.apply_user_preparation(
                    owner,
                    provider,
                    &browser,
                    target,
                    PreparedOperation::Acquired { operation, epoch },
                    prepared.tab,
                )?;
            }
            ExtensionRecoveredOperation::Presentation(_) => {}
            ExtensionRecoveredOperation::NotDispatched { message, .. }
            | ExtensionRecoveredOperation::Refused { message, .. }
            | ExtensionRecoveredOperation::ChromeRejected { message, .. } => {
                if matches!(operation, ExtensionOperation::MarkTab { .. }) {
                    let target = target
                        .as_ref()
                        .ok_or_else(|| unknown("rejected mark lost target"))?;
                    let call = call
                        .as_ref()
                        .ok_or_else(|| unknown("rejected mark lost epoch"))?;
                    self.apply_mark_result(
                        &browser.tab(target),
                        owner,
                        context,
                        call.epoch,
                        None,
                        if not_dispatched {
                            Err(MarkFailure::NotDispatched)
                        } else {
                            Err(MarkFailure::Unknown(message.clone()))
                        },
                    )?;
                }
                if not_dispatched
                    && matches!(
                        operation,
                        ExtensionOperation::PrepareFixedSessionTab { .. }
                            | ExtensionOperation::SessionUi { .. }
                            | ExtensionOperation::ClearSessionPreparation { .. }
                    )
                {
                    self.apply_fixed_not_dispatched(owner, provider, operation, context)?;
                }
                // Only the Rust writer/admission phase proves no native frame.
                // A remote refusal can follow effects and retains cleanup custody.
                if not_dispatched
                    && matches!(
                        operation,
                        ExtensionOperation::Detach { .. }
                            | ExtensionOperation::CloseTab { .. }
                            | ExtensionOperation::StopCreatedTab { .. }
                    )
                    && let Some(target) = &target
                    && let Some(state) = self
                        .tabs
                        .get_mut(&browser.tab(target))
                        .and_then(|lease| lease.extension.as_mut())
                    && state.physical_cleanup.is_none()
                    && !state.released
                    && !state.closed
                {
                    state.cleanup_started = false;
                }
                if matches!(operation, ExtensionOperation::PrepareClaim { .. })
                    && let Some(target) = &target
                    && let Some(lease) = self.tabs.get_mut(&browser.tab(target))
                    && let Some(state) = lease.extension.as_mut()
                {
                    state.finish_preparation_error(context, not_dispatched, &message);
                    if !not_dispatched {
                        lease.disposition = Disposition::Closing;
                    }
                }
                if matches!(
                    operation,
                    ExtensionOperation::PrepareUserTab { .. }
                        | ExtensionOperation::PrepareSessionTab { .. }
                ) && let Some(target) = &target
                    && let Some(lease) = self.tabs.get_mut(&browser.tab(target))
                    && let Some(state) = lease.extension.as_mut()
                    && matches!(&state.user_preparation, UserPreparation::Pending(issued) if Some(issued) == context)
                {
                    state.user_preparation = if not_dispatched {
                        UserPreparation::NotAttempted
                    } else {
                        UserPreparation::Unknown(message.clone())
                    };
                    if !not_dispatched {
                        lease.disposition = Disposition::Closing;
                    }
                }
                if matches!(operation, ExtensionOperation::FinishTurn { .. })
                    && let Some(call) = call.as_ref()
                {
                    self.extension
                        .get_mut(&(owner, browser.clone()))
                        .ok_or_else(|| unknown("extension finish owner retired"))?
                        .finish_phases
                        .insert(
                            call.turn.clone(),
                            if not_dispatched {
                                FinishPhase::Required
                            } else {
                                FinishPhase::Refused(message)
                            },
                        );
                }
            }
            ExtensionRecoveredOperation::Unknown {
                reason, custody, ..
            } => {
                self.apply_upload_unknown(owner, provider, completion, &custody)?;
                if matches!(operation, ExtensionOperation::MarkTab { .. }) {
                    let target = target
                        .as_ref()
                        .ok_or_else(|| unknown("unknown mark lost target"))?;
                    let call = call
                        .as_ref()
                        .ok_or_else(|| unknown("unknown mark lost epoch"))?;
                    let known = custody.marked.as_ref().is_some_and(|ack| {
                        ack.host_session_id == owner.to_string()
                            && ack.host_turn_id == call.turn
                            && ack.generation == extension.identity().generation
                            && ack.tab_id.to_string() == *target
                            && (!extension
                                .capabilities()
                                .is_ok_and(|caps| caps.logical_lease_persistence)
                                || ack.logical_lease.is_some())
                    });
                    // A captured late ACK may settle the retained intent for cleanup.
                    // The originating API still reports Unknown, never delivery success.
                    self.apply_mark_result(
                        &browser.tab(target),
                        owner,
                        context,
                        call.epoch,
                        custody
                            .marked
                            .as_ref()
                            .map(|ack| mark_from_core(ack.status)),
                        if known {
                            Ok(())
                        } else {
                            Err(MarkFailure::Unknown(reason.clone()))
                        },
                    )?;
                }
                if matches!(operation, ExtensionOperation::MarkTab { .. }) {
                    return Ok(());
                }
                if let Some(proof) = custody.preparation {
                    self.apply_claim_preparation(owner, provider, context, proof)?;
                }
                if custody.cleanup.is_some() {
                    self.apply_extension_cleanup(
                        owner,
                        provider,
                        &browser,
                        operation,
                        target.as_deref(),
                        custody.cleanup.as_ref(),
                    );
                }
                if let Some(ack) = custody.turn_finished {
                    let call = call
                        .as_ref()
                        .ok_or_else(|| unknown("uncertain finish lost its Host context"))?;
                    if ack.host_session_id != owner.to_string() || ack.host_turn_id != call.turn {
                        return Err(unknown("uncertain finish identity mismatch"));
                    }
                    self.apply_logical_commit(
                        owner,
                        provider,
                        &call.turn,
                        ack.logical_lease_commit.as_ref(),
                    )?;
                    self.extension
                        .get_mut(&(owner, browser.clone()))
                        .ok_or_else(|| unknown("uncertain finish owner retired"))?
                        .finish_phases
                        .insert(call.turn.clone(), FinishPhase::Acknowledged);
                    self.finish_session_activation(owner, &browser, &call.turn);
                } else if matches!(operation, ExtensionOperation::FinishTurn { .. })
                    && let Some(call) = call.as_ref()
                {
                    self.extension
                        .get_mut(&(owner, browser.clone()))
                        .ok_or_else(|| unknown("uncertain finish owner retired"))?
                        .finish_phases
                        .insert(call.turn.clone(), FinishPhase::Unknown(reason.clone()));
                }
                if matches!(
                    operation,
                    ExtensionOperation::SetSessionHeaders { .. }
                        | ExtensionOperation::ClearSessionHeaders
                ) {
                    self.extension
                        .get_mut(&(owner, browser.clone()))
                        .ok_or_else(|| unknown("unknown session header owner retired"))?
                        .headers_unknown = true;
                }
                if let Some(proof) = custody.session_headers {
                    let call = call.as_ref().ok_or_else(|| {
                        unknown("uncertain session header result lost its Host context")
                    })?;
                    if proof.host_session_id != owner.to_string()
                        || proof.host_turn_id != call.turn
                        || proof.generation != extension.identity().generation
                    {
                        return Err(unknown(
                            "uncertain extension session header result identity mismatch",
                        ));
                    }
                    let state = self
                        .extension
                        .get_mut(&(owner, browser.clone()))
                        .ok_or_else(|| unknown("unknown session header owner retired"))?;
                    state.headers_unknown =
                        !proof.state_confirmed || (!proof.active && !proof.cleanup_confirmed);
                    state.session_headers = Some(proof);
                }
                if matches!(
                    operation,
                    ExtensionOperation::PrepareFixedSessionTab { .. }
                        | ExtensionOperation::SessionUi { .. }
                        | ExtensionOperation::ClearSessionPreparation { .. }
                ) {
                    self.apply_fixed_unknown(
                        owner,
                        provider,
                        operation,
                        context,
                        custody.fixed_session.clone(),
                        &reason,
                    )?;
                }
                let known_created = custody.created.is_some();
                if let Some(created) = custody.created {
                    let call = call
                        .clone()
                        .ok_or_else(|| unknown("unknown creation lost its context"))?;
                    let identity = browser.tab(&created.tab.id.to_string());
                    let sequence = self.allocate_extension_sequence()?;
                    self.tabs.entry(identity).or_insert(Lease {
                        viewport: None,
                        input: None,
                        extension_sequence: Some(sequence),
                        creator: Creator {
                            owner,
                            turn: call.turn,
                            provider: provider.clone(),
                            generation: extension.identity().generation.clone(),
                        },
                        origin: Origin::AgentCreated,
                        disposition: Disposition::Closing,
                        retention: Retention::Unmarked,
                        handoff_transfer: None,
                        logical_lease: None,
                        extension: Some(ClaimState {
                            creation: Some(created.creation_receipt().clone()),
                            unknown: Some(reason.clone()),
                            ..Default::default()
                        }),
                    });
                }
                let creation_operation = matches!(
                    operation,
                    ExtensionOperation::CreateTab { .. }
                        | ExtensionOperation::CreatePopupTab { .. }
                        | ExtensionOperation::CreateSessionPopupTab { .. }
                );
                if !known_created && creation_operation {
                    let call = call
                        .as_ref()
                        .ok_or_else(|| unknown("unknown creation context missing"))?;
                    self.creation_unknown(
                        browser.clone(),
                        owner,
                        &call.turn,
                        provider.clone(),
                        extension.identity().generation.clone(),
                    );
                    if let Some(uncertain) =
                        self.uncertain_creations.get_mut(&(owner, browser.clone()))
                    {
                        uncertain.extension = custody.creation.clone();
                    }
                }
                if let Some(target) = target
                    && let Some(lease) = self.tabs.get_mut(&browser.tab(&target))
                {
                    lease.disposition = Disposition::Closing;
                    let state = lease
                        .extension
                        .as_mut()
                        .ok_or_else(|| unknown("unknown extension effect has no custody"))?;
                    if custody.claim.is_some() {
                        state.claim = custody.claim;
                        state.physical_epoch = None;
                    }
                    if custody.creation.is_some() {
                        state.creation = custody.creation;
                    }
                    if custody.group.is_some() {
                        state.group = custody.group;
                    }
                    if let Some(proof) = custody.headers {
                        state.headers_active = proof.active;
                        if !proof.active && proof.cleanup_confirmed {
                            state.preparation_effects.headers_may_exist = false;
                        }
                    }
                    if matches!(operation, ExtensionOperation::PrepareClaim { .. }) {
                        state.finish_preparation_error(context, false, &reason);
                    } else {
                        state.unknown = Some(reason);
                    }
                }
            }
            ExtensionRecoveredOperation::EffectsCleanup {
                claim,
                effect,
                cleanup_confirmed,
                error,
                wire_context,
                ..
            } => {
                for lease in self.tabs.values_mut().filter(|lease| {
                    lease.creator.owner == owner && lease.creator.provider == *provider
                }) {
                    if let Some(state) = &mut lease.extension
                        && state
                            .claim
                            .as_ref()
                            .is_some_and(|owned| owned.claim_id() == claim)
                    {
                        let scoped_fixed = effect == "fixed_preparation"
                            && wire_context
                                .as_ref()
                                .is_some_and(|wire| wire.host_session_id() == owner.to_string());
                        if scoped_fixed {
                            state.preparation_effects.fixed_cleanup(
                                wire_context
                                    .as_ref()
                                    .expect("matched captured wire context"),
                                cleanup_confirmed,
                            );
                        } else if effect == "scoped_headers"
                            && !matches!(state.claim_preparation, ClaimPreparation::NotAttempted)
                        {
                            // This event need not carry a logical context. Only
                            // an exact HeaderProof can clear this liability.
                            if !cleanup_confirmed {
                                state.preparation_effects.headers_may_exist = true;
                            }
                        } else if !cleanup_confirmed {
                            let reason = error
                                .clone()
                                .unwrap_or_else(|| "extension effect cleanup unconfirmed".into());
                            if effect == "extension_cdp_effect" {
                                state.cdp_effect_unknown.get_or_insert(reason.clone());
                            }
                            state.unknown = Some(reason);
                        }
                        if !cleanup_confirmed {
                            lease.disposition = Disposition::Closing;
                        }
                    }
                }
            }
            ExtensionRecoveredOperation::OrphanCdpCompletion { claim, .. } => {
                for lease in self.tabs.values_mut().filter(|lease| {
                    lease.creator.owner == owner && lease.creator.provider == *provider
                }) {
                    if let Some(state) = &mut lease.extension
                        && state
                            .claim
                            .as_ref()
                            .is_some_and(|owned| owned.claim_id() == claim)
                    {
                        state.presentation_error = Some(
                            "late extension CDP completion retained; no replay authorized".into(),
                        );
                    }
                }
            }
        }
        // Commit the fold before any ACK await. A retained old SDK receipt may
        // still be present while a replacement intent begins; it never folds twice.
        self.extension
            .get_mut(&(owner, browser))
            .ok_or_else(|| unknown("extension completion owner retired before fold"))?
            .applied
            .insert(completion.id);
        Ok(())
    }
    fn seal_extension_controls(
        &mut self,
        owner: uuid::Uuid,
        turn: Option<&str>,
        epoch: Option<crate::desktop::NativeEpochId>,
    ) -> ControlDrain {
        let mut gates = Vec::new();
        let tabs = &self.tabs;
        let creations = &self.uncertain_creations;
        for ((current, browser), state) in &mut self.extension {
            if *current != owner {
                continue;
            }
            for call in state.calls.values().filter(|call| {
                turn.is_none_or(|turn| call.turn == turn)
                    && epoch.is_none_or(|epoch| call.epoch == epoch)
            }) {
                call.controls.seal();
                gates.push(call.controls.clone());
            }
            state.fold_activation();
            // Epoch retirement cannot retire a different VM's current turn.
            // The actual epoch/claim gates still reject its old producers.
            let preserves_fixed = turn.is_some_and(|turn| {
                tabs.values().any(|lease| {
                    lease.creator.owner == owner
                        && lease.creator.provider == state.provider
                        && lease.extension.as_ref().is_some_and(|extension| {
                            extension.fixed_preparation.protected_from_turn(turn)
                        })
                })
            });
            if epoch.is_none() && state.retiring_turn.is_none() && !preserves_fixed {
                state.retiring_turn = state
                    .activation_turn(turn)
                    .or_else(|| {
                        state
                            .current_turn
                            .clone()
                            .filter(|current| turn.is_none_or(|turn| current == turn))
                    })
                    .or_else(|| {
                        tabs.values()
                            .find(|lease| {
                                lease.creator.owner == owner
                                    && lease.creator.provider == state.provider
                                    && turn.is_none_or(|turn| lease.creator.turn == turn)
                            })
                            .map(|lease| lease.creator.turn.clone())
                    })
                    .or_else(|| {
                        creations
                            .get(&(owner, browser.clone()))
                            .filter(|creation| {
                                turn.is_none_or(|turn| creation.creator.turn == turn)
                            })
                            .map(|creation| creation.creator.turn.clone())
                    });
            }
        }
        ControlDrain { gates }
    }

    async fn release_deliverable_group(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        scope: &CallScope,
    ) -> Result<(), ToolError> {
        let state = self.tabs[identity]
            .extension
            .as_ref()
            .ok_or_else(|| unknown("marked tab lost extension custody"))?;
        if state.group.is_none() {
            return Ok(());
        }
        match &state.retained_group_release {
            ControlCleanup::NotAttempted => {}
            ControlCleanup::Confirmed => return Ok(()),
            ControlCleanup::Pending => {
                return Err(ToolError::CleanupUnconfirmed(
                    "deliverable group release is pending; it was not replayed".into(),
                ));
            }
            ControlCleanup::Unconfirmed(reason) => {
                return Err(ToolError::CleanupUnconfirmed(format!(
                    "deliverable group release remains unknown: {reason}"
                )));
            }
        }
        let creation = state
            .creation
            .clone()
            .ok_or_else(|| unknown("deliverable group lost its creation receipt"))?;
        let group = state.group.clone().expect("checked managed group");
        self.tabs
            .get_mut(identity)
            .unwrap()
            .extension
            .as_mut()
            .unwrap()
            .retained_group_release = ControlCleanup::Pending;
        let released = scope
            .dispatch_retirement(scope.control.release_created_tab_group(&creation, &group))
            .await;
        self.reconcile_provider(owner, &scope.provider).await?;
        let phase = match &released {
            Ok(_) => ControlCleanup::Confirmed,
            Err(error) if scope.control.undispatched_control(error).is_some() => {
                ControlCleanup::NotAttempted
            }
            Err(error) => ControlCleanup::Unconfirmed(error.to_string()),
        };
        self.tabs
            .get_mut(identity)
            .unwrap()
            .extension
            .as_mut()
            .unwrap()
            .retained_group_release = phase;
        released.map_err(provider::extension_error)?;
        Ok(())
    }

    /// Permanent transport-owner teardown is not turnEnded/finalizeTabs.
    /// Retire physical resources while retaining logical origin/marks in Lease.
    async fn park_extension_owner(
        &mut self,
        owner: uuid::Uuid,
    ) -> Result<Vec<TabIdentity>, ToolError> {
        self.rollback_owner_unentered_handoffs(owner);
        if self.tabs.values().any(|lease| {
            lease.handoff_transfer.as_ref().is_some_and(|attempt| {
                attempt.requested.owner == owner || lease.creator.owner == owner
            })
        }) {
            return Err(unknown(
                "explicit handoff replacement still holds cleanup custody",
            ));
        }
        let providers: Vec<_> = self
            .extension
            .iter()
            .filter(|((id, _), _)| *id == owner)
            .map(|(_, state)| state.provider.clone())
            .collect();
        for provider in providers {
            let extension = provider
                .extension()
                .ok_or_else(|| failed("extension provider required"))?;
            let browser = BrowserIdentity::of(&provider, &extension.identity().generation)?;
            let caps = extension
                .capabilities()
                .map_err(provider::extension_error)?;
            let mut events = extension.subscribe_events();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            while self.reconcile_provider(owner, &provider).await? {
                match tokio::time::timeout_at(deadline, events.recv()).await {
                    Ok(Ok(_)) | Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {}
                    _ => return Err(unknown("owner teardown retains pending extension custody")),
                }
            }
            if self
                .uncertain_creations
                .contains_key(&(owner, browser.clone()))
            {
                return Err(unknown(
                    "owner teardown retains unknown tab creation custody",
                ));
            }
            let identities: Vec<_> = self
                .tabs
                .iter()
                .filter(|(_, lease)| {
                    lease.creator.owner == owner
                        && lease.creator.provider == provider
                        && !matches!(lease.disposition, Disposition::Parked)
                })
                .map(|(identity, _)| identity.clone())
                .collect();
            let state = self
                .extension
                .get(&(owner, browser.clone()))
                .ok_or_else(|| failed("extension owner retired"))?;
            if state.owner_parked {
                continue;
            }
            if state.calls.values().any(|call| !call.controls.is_idle()) {
                return Err(unknown(
                    "owner teardown must drain original admitted control futures first",
                ));
            }
            let turn = state.current_turn.clone().or_else(|| {
                identities
                    .first()
                    .map(|identity| self.tabs[identity].creator.turn.clone())
            });
            let Some(turn) = turn else {
                if let Some(state) = self.extension.get_mut(&(owner, browser.clone())) {
                    state.owner_parked = true;
                }
                continue;
            };
            // Seal original calls before making only retirement-scoped requests.
            for call in self.extension[&(owner, browser.clone())].calls.values() {
                call.controls.seal();
            }
            let scope = self.extension_context(
                owner,
                &provider,
                context_operation(&turn),
                crate::desktop::NativeEpochId::new(),
                CallTarget::Retirement,
                false,
            )?;
            let clear_headers =
                self.extension
                    .get(&(owner, browser.clone()))
                    .is_some_and(|state| {
                        state.headers_unknown
                            || state
                                .session_headers
                                .as_ref()
                                .is_some_and(|proof| proof.active || !proof.cleanup_confirmed)
                    });
            if caps.header_scope == ExtensionHeaderPolicyScope::Session && clear_headers {
                let result = scope
                    .dispatch_retirement(scope.control.clear_session_headers())
                    .await;
                self.reconcile_provider(owner, &provider).await?;
                let proof = result.map_err(provider::extension_error)?;
                if proof.active || !proof.cleanup_confirmed {
                    return Err(unknown("owner session headers remain unconfirmed"));
                }
            }
            for identity in identities {
                let state = self.tabs[&identity]
                    .extension
                    .as_ref()
                    .ok_or_else(|| unknown("owner teardown lost physical custody"))?
                    .clone();
                if state.unknown.is_some() || state.cdp_effect_unknown.is_some() {
                    return Err(unknown("owner teardown retains unknown physical effects"));
                }
                if state.claim.is_some()
                    || !matches!(state.fixed_preparation, FixedPreparation::NotAttempted)
                {
                    self.cleanup_extension_control(owner, &identity, FixedCleanupPurpose::Owner)
                        .await?;
                }
                if let Some(claim) = &state.claim {
                    if caps.header_scope == ExtensionHeaderPolicyScope::Claim
                        && (state.headers_active || state.preparation_effects.headers_may_exist)
                    {
                        let result = scope
                            .dispatch_retirement(scope.control.clear_scoped_headers(claim))
                            .await;
                        self.reconcile_provider(owner, &provider).await?;
                        if !result.map_err(provider::extension_error)?.cleanup_confirmed {
                            return Err(unknown("owner scoped headers remain unconfirmed"));
                        }
                    }
                    let drain = scope
                        .dispatch_retirement(
                            scope
                                .control
                                .wait_claim_cdp_drained(claim, Duration::from_secs(10)),
                        )
                        .await
                        .map_err(provider::extension_error)?;
                    self.tabs
                        .get_mut(&identity)
                        .and_then(|lease| lease.extension.as_mut())
                        .ok_or_else(|| unknown("owner drain lost custody"))?
                        .cdp_drain = Some(drain);
                    self.reconcile_provider(owner, &provider).await?;
                    if !self.tabs[&identity]
                        .extension
                        .as_ref()
                        .is_some_and(|state| state.released)
                    {
                        self.begin_extension_cleanup(&identity)?;
                        let result = scope
                            .dispatch_retirement(scope.control.detach_tab(claim))
                            .await;
                        self.reconcile_provider(owner, &provider).await?;
                        result.map_err(provider::extension_error)?;
                    }
                }
                self.retire_extension_cleanup(owner, &provider, &identity, &scope.control)
                    .await?;
                let lease = self
                    .tabs
                    .get_mut(&identity)
                    .ok_or_else(|| unknown("owner retirement lost lease"))?;
                let state = lease
                    .extension
                    .as_ref()
                    .ok_or_else(|| unknown("owner retirement lost custody"))?;
                if state.claim.is_some()
                    || !state.fixed_preparation.settled()
                    || !state.preparation_effects.settled()
                {
                    return Err(unknown("owner physical retirement remains unconfirmed"));
                }
                // No old creation/group token, prepared grant or CDP route remains.
                // Keep only logical origin, mark, provider metadata and sequence.
                lease.extension = Some(ClaimState {
                    revoked: true,
                    released: true,
                    ..Default::default()
                });
                lease.disposition = Disposition::Parked;
            }
            if let Some(state) = self.extension.get_mut(&(owner, browser)) {
                for call in state.calls.values() {
                    call.controls.seal();
                }
                state.current_turn = None;
                state.retiring_turn = None;
                state.logical_active = None;
                state.owner_parked = true;
            }
        }
        Ok(Vec::new())
    }

    pub(super) async fn finish_extension(
        &mut self,
        owner: uuid::Uuid,
        turn: Option<&str>,
    ) -> Result<Vec<TabIdentity>, ToolError> {
        if turn.is_none() {
            return self.park_extension_owner(owner).await;
        }
        self.rollback_owner_unentered_handoffs(owner);
        if self.tabs.values().any(|lease| {
            lease.handoff_transfer.as_ref().is_some_and(|attempt| {
                attempt.requested.owner == owner || lease.creator.owner == owner
            })
        }) {
            return Err(unknown(
                "normal turn cleanup retains pending explicit handoff replacement",
            ));
        }
        let providers: Vec<_> = self
            .extension
            .iter()
            .filter(|((current, _), _)| *current == owner)
            .map(|(_, state)| state.provider.clone())
            .collect();
        let mut closed = Vec::new();
        for provider in providers {
            let extension = provider
                .extension()
                .ok_or_else(|| failed("extension cleanup provider missing"))?
                .clone();
            let capabilities = extension
                .capabilities()
                .map_err(provider::extension_error)?;
            let browser = BrowserIdentity::of(&provider, &extension.identity().generation)?;
            let mut events = extension.subscribe_events();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            while self.reconcile_provider(owner, &provider).await? {
                match tokio::time::timeout_at(deadline, events.recv()).await {
                    Ok(Ok(_)) | Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {}
                    _ => {
                        return Err(ToolError::CleanupUnconfirmed(
                            "extension operations remain in flight; custody retained".into(),
                        ));
                    }
                }
            }
            let candidates: Vec<_> = self
                .tabs
                .iter()
                .filter(|(_, lease)| {
                    lease.creator.owner == owner
                        && lease.creator.provider == provider
                        && !matches!(lease.retention, Retention::Handoff)
                        && turn.is_none_or(|turn| {
                            lease.creator.turn == turn
                                || lease.extension.as_ref().is_some_and(|state| {
                                    !matches!(
                                        state.fixed_preparation,
                                        FixedPreparation::NotAttempted
                                    )
                                })
                        })
                })
                .map(|(identity, _)| identity.clone())
                .collect();
            let purpose = turn
                .map(|turn| FixedCleanupPurpose::Turn {
                    turn: turn.to_owned(),
                })
                .unwrap_or(FixedCleanupPurpose::Owner);
            let mut identities = Vec::new();
            let mut preserves_fixed = false;
            for identity in candidates {
                let fixed = self.tabs[&identity]
                    .extension
                    .as_ref()
                    .is_some_and(|state| {
                        !matches!(state.fixed_preparation, FixedPreparation::NotAttempted)
                    });
                if fixed && self.fixed_cleanup_protected(owner, &identity, &purpose)? {
                    preserves_fixed = true;
                    continue;
                }
                identities.push(identity);
            }
            let uncertain = self
                .uncertain_creations
                .get(&(owner, browser.clone()))
                .filter(|uncertain| {
                    uncertain.creator.owner == owner
                        && turn.is_none_or(|turn| uncertain.creator.turn == turn)
                })
                .cloned();
            let current = self
                .extension
                .get(&(owner, browser.clone()))
                .and_then(|state| state.current_turn.clone())
                .filter(|current| turn.is_none_or(|turn| current == turn));
            let owed = self
                .extension
                .get(&(owner, browser.clone()))
                .and_then(|state| state.activation_turn(turn));
            if identities.is_empty() && uncertain.is_none() && current.is_none() && owed.is_none() {
                continue;
            }
            let cleanup_turn = turn
                .map(str::to_owned)
                .or(owed)
                .or(current)
                .or_else(|| {
                    identities
                        .first()
                        .map(|identity| self.tabs[identity].creator.turn.clone())
                })
                .or_else(|| {
                    uncertain
                        .as_ref()
                        .map(|uncertain| uncertain.creator.turn.clone())
                });
            let Some(cleanup_turn) = cleanup_turn else {
                continue;
            };
            if self
                .extension
                .get(&(owner, browser.clone()))
                .is_some_and(|state| {
                    state
                        .calls
                        .values()
                        .any(|call| call.turn == cleanup_turn && !call.controls.is_idle())
                })
            {
                return Err(ToolError::CleanupUnconfirmed(
                    "extension control futures were not drained outside the Host lock".to_owned(),
                ));
            }
            let provider_state = self
                .extension
                .get_mut(&(owner, browser.clone()))
                .ok_or_else(|| unknown("extension cleanup owner retired"))?;
            if provider_state
                .retiring_turn
                .as_deref()
                .is_some_and(|turn| turn != cleanup_turn)
            {
                return Err(ToolError::CleanupUnconfirmed(
                    "another extension turn cleanup is still unsettled".into(),
                ));
            }
            if !preserves_fixed {
                provider_state.retiring_turn = Some(cleanup_turn.clone());
            }
            let scope = self.extension_context(
                owner,
                &provider,
                context_operation(&cleanup_turn),
                crate::desktop::NativeEpochId::new(),
                CallTarget::Retirement,
                false,
            )?;
            if capabilities.header_scope == ExtensionHeaderPolicyScope::Session {
                let needs_clear =
                    self.extension
                        .get(&(owner, browser.clone()))
                        .is_some_and(|state| {
                            state.headers_unknown
                                || state
                                    .session_headers
                                    .as_ref()
                                    .is_some_and(|proof| proof.active || !proof.cleanup_confirmed)
                        });
                if needs_clear {
                    let cleared = scope.dispatch(scope.control.clear_session_headers()).await;
                    self.reconcile_provider(owner, &provider).await?;
                    let cleared = cleared.map_err(provider::extension_error)?;
                    if cleared.active || !cleared.cleanup_confirmed {
                        return Err(ToolError::CleanupUnconfirmed(
                            "extension session header cleanup is unconfirmed".into(),
                        ));
                    }
                }
            }
            // User tabs are detached with matched physical proof before the
            // provider's whole-turn lifecycle callback. Agent-created tabs are
            // closed by the party named in its actual capability contract.
            for identity in &identities {
                let lease = &self.tabs[identity];
                let origin = lease.origin;
                let mark = lease.retention.mark()?;
                let state = lease
                    .extension
                    .as_ref()
                    .ok_or_else(|| unknown("extension cleanup lost custody"))?
                    .clone();
                if capabilities.header_scope == ExtensionHeaderPolicyScope::Claim
                    && (state.headers_active || state.preparation_effects.headers_may_exist)
                {
                    let claim = state.claim.as_ref().ok_or_else(|| {
                        ToolError::CleanupUnconfirmed(
                            "active extension headers lost their owned claim".into(),
                        )
                    })?;
                    let cleared = scope
                        .dispatch(scope.control.clear_scoped_headers(claim))
                        .await;
                    self.reconcile_provider(owner, &provider).await?;
                    if !cleared
                        .map_err(provider::extension_error)?
                        .cleanup_confirmed
                    {
                        return Err(ToolError::CleanupUnconfirmed(
                            "extension scoped headers remain after Stop".into(),
                        ));
                    }
                }
                if capabilities.turn_lifecycle_owner == ExtensionEffectOwner::Host
                    && let Some(mark) = mark
                {
                    // A presentation failure is best effort, as in the reference.
                    // Existing fixed cleanup still drains the actual admitted promise.
                    self.finalize_retained_presentation(owner, identity, mark)
                        .await;
                }
                if capabilities.cursor_presentation_owner == ExtensionEffectOwner::Host
                    || !matches!(state.fixed_preparation, FixedPreparation::NotAttempted)
                {
                    self.cleanup_extension_control(owner, identity, purpose.clone())
                        .await?;
                }
                if let Some(claim) = &state.claim {
                    let drain = scope
                        .dispatch_retirement(
                            scope
                                .control
                                .wait_claim_cdp_drained(claim, Duration::from_secs(10)),
                        )
                        .await
                        .map_err(provider::extension_error)?;
                    self.tabs
                        .get_mut(identity)
                        .and_then(|lease| lease.extension.as_mut())
                        .ok_or_else(|| unknown("extension drain lost its exact claim"))?
                        .cdp_drain = Some(drain);
                    if self.reconcile_provider(owner, &provider).await? {
                        return Err(ToolError::CleanupUnconfirmed(
                            "extension CDP settled but retained operation custody is still pending"
                                .into(),
                        ));
                    }
                }
                if mark == Some(TabMark::Deliverable)
                    && capabilities.created_presentation_owner == ExtensionEffectOwner::Host
                {
                    self.release_deliverable_group(owner, identity, &scope)
                        .await?;
                }
                match origin {
                    _ if mark.is_some() && !state.released => {
                        let claim = state.claim.as_ref().ok_or_else(|| {
                            ToolError::CleanupUnconfirmed(
                                "marked tab lacks its exact physical detach custody".into(),
                            )
                        })?;
                        self.begin_extension_cleanup(identity)?;
                        let detached = scope
                            .dispatch_retirement(scope.control.detach_tab(claim))
                            .await;
                        self.reconcile_provider(owner, &provider).await?;
                        detached.map_err(provider::extension_error)?;
                    }
                    Origin::UserClaimed if !state.released => {
                        if let Some(claim) = &state.claim {
                            self.begin_extension_cleanup(identity)?;
                            let detached = scope
                                .dispatch_retirement(scope.control.detach_tab(claim))
                                .await;
                            self.reconcile_provider(owner, &provider).await?;
                            detached.map_err(provider::extension_error)?;
                        } else if state.unknown.is_some() {
                            return Err(ToolError::CleanupUnconfirmed(
                                "user attachment lacks physical cleanup proof".into(),
                            ));
                        } else {
                            // A check-only/failed provisional reservation never
                            // obtained any physical resource to release.
                            self.tabs
                                .get_mut(identity)
                                .unwrap()
                                .extension
                                .as_mut()
                                .unwrap()
                                .released = true;
                        }
                    }
                    Origin::AgentCreated
                        if capabilities.turn_lifecycle_owner == ExtensionEffectOwner::Host
                            && mark.is_none()
                            && !state.closed =>
                    {
                        let receipt = state.creation.as_ref().ok_or_else(|| {
                            ToolError::CleanupUnconfirmed("created tab lost its receipt".into())
                        })?;
                        self.begin_extension_cleanup(identity)?;
                        let stopped = scope
                            .dispatch_retirement(scope.control.stop_created_tab(receipt))
                            .await;
                        self.reconcile_provider(owner, &provider).await?;
                        stopped.map_err(provider::extension_error)?;
                    }
                    _ => {}
                }
            }
            let activation_owed =
                self.extension
                    .get(&(owner, browser.clone()))
                    .is_some_and(|state| {
                        state.activation_turn(Some(&cleanup_turn)).is_some()
                            || state
                                .calls
                                .values()
                                .any(|call| call.turn == cleanup_turn && call.requires_finish())
                    });
            if capabilities.turn_lifecycle_owner == ExtensionEffectOwner::Provider
                && activation_owed
            {
                let phase = self
                    .extension
                    .get(&(owner, browser.clone()))
                    .and_then(|state| state.finish_phases.get(&cleanup_turn));
                let acknowledged = match phase {
                    Some(FinishPhase::Acknowledged) => true,
                    Some(FinishPhase::Pending) => {
                        return Err(ToolError::CleanupUnconfirmed(
                            "logical turn finish remains unsettled; it was not replayed".into(),
                        ));
                    }
                    Some(FinishPhase::Unknown(reason) | FinishPhase::Refused(reason)) => {
                        return Err(ToolError::CleanupUnconfirmed(format!(
                            "logical turn finish cannot be repeated: {reason}"
                        )));
                    }
                    Some(FinishPhase::Required) | None => false,
                };
                if !acknowledged {
                    self.extension
                        .get_mut(&(owner, browser.clone()))
                        .ok_or_else(|| unknown("extension finish owner retired"))?
                        .finish_phases
                        .insert(cleanup_turn.clone(), FinishPhase::Pending);
                    let finish = scope
                        .dispatch_retirement(scope.control.finish_turn(None))
                        .await;
                    self.reconcile_provider(owner, &provider).await?;
                    if finish
                        .as_ref()
                        .err()
                        .is_some_and(|error| scope.control.undispatched_control(error).is_some())
                        && let Some(state) = self.extension.get_mut(&(owner, browser.clone()))
                        && matches!(
                            state.finish_phases.get(&cleanup_turn),
                            Some(FinishPhase::Pending)
                        )
                    {
                        state
                            .finish_phases
                            .insert(cleanup_turn.clone(), FinishPhase::Required);
                    }
                    finish.map_err(provider::extension_error)?;
                }
                // The logical ACK is deliberately insufficient. This operation
                // obtains the adapter's independently established tab-removal
                // proof; the ChatGPT adapter observes, without closing again.
                for identity in &identities {
                    let lease = &self.tabs[identity];
                    let state = lease.extension.as_ref().unwrap();
                    if lease.origin == Origin::AgentCreated
                        && lease.retention.mark()?.is_none()
                        && !state.closed
                    {
                        let receipt = state.creation.clone().ok_or_else(|| {
                            ToolError::CleanupUnconfirmed("created tab lost its receipt".into())
                        })?;
                        self.begin_extension_cleanup(identity)?;
                        let stopped = scope
                            .dispatch_retirement(scope.control.stop_created_tab(&receipt))
                            .await;
                        self.reconcile_provider(owner, &provider).await?;
                        stopped.map_err(provider::extension_error)?;
                    }
                }
            } else if capabilities.turn_lifecycle_owner == ExtensionEffectOwner::Unavailable {
                return Err(ToolError::CleanupUnconfirmed(
                    "extension adapter has no turn cleanup implementation".into(),
                ));
            }
            if let Some(uncertain) = uncertain {
                if let Some(receipt) = uncertain.extension {
                    let stopped = scope
                        .dispatch_retirement(scope.control.stop_created_tab(&receipt))
                        .await;
                    self.reconcile_provider(owner, &provider).await?;
                    stopped.map_err(provider::extension_error)?;
                } else {
                    return Err(ToolError::CleanupUnconfirmed("extension tab creation outcome remains unknown without a recoverable receipt; creation was not replayed".into()));
                }
            }
            let kept_inventory = if identities.iter().any(|identity| {
                self.tabs[identity]
                    .retention
                    .mark()
                    .is_ok_and(|mark| mark.is_some())
            }) {
                // Keep the original retirement scope/observer. This is a
                // cleanup existence observation, never a new acquisition.
                let tabs = scope
                    .dispatch_retirement(scope.control.list_user_tabs())
                    .await
                    .map_err(provider::extension_error)?;
                if BrowserIdentity::of(&provider, &scope.control.identity().generation)? != browser
                {
                    return Err(ToolError::CleanupUnconfirmed(
                        "marked tab provider changed before retained-resource observation".into(),
                    ));
                }
                Some(
                    tabs.into_iter()
                        .map(|tab| tab.id.to_string())
                        .collect::<HashSet<_>>(),
                )
            } else {
                None
            };
            let handoff_active = self
                .extension
                .get(&(owner, browser.clone()))
                .and_then(|state| state.logical_active.clone());
            for identity in &identities {
                self.retire_extension_cleanup(owner, &provider, identity, &scope.control)
                    .await?;
            }
            if capabilities.turn_lifecycle_owner == ExtensionEffectOwner::Host
                && capabilities.logical_lease_persistence
            {
                let phase = self
                    .extension
                    .get(&(owner, browser.clone()))
                    .and_then(|state| state.finish_phases.get(&cleanup_turn));
                match phase {
                    Some(FinishPhase::Acknowledged) => {}
                    Some(
                        FinishPhase::Pending | FinishPhase::Unknown(_) | FinishPhase::Refused(_),
                    ) => {
                        return Err(unknown(
                            "logical projection commit remains unsettled; it was not replayed",
                        ));
                    }
                    Some(FinishPhase::Required) | None => {
                        self.extension
                            .get_mut(&(owner, browser.clone()))
                            .ok_or_else(|| unknown("logical commit owner retired"))?
                            .finish_phases
                            .insert(cleanup_turn.clone(), FinishPhase::Pending);
                        let finished = scope
                            .dispatch_retirement(scope.control.finish_turn(None))
                            .await;
                        self.reconcile_provider(owner, &provider).await?;
                        finished.map_err(provider::extension_error)?;
                    }
                }
            }
            for identity in identities {
                let lease = &self.tabs[&identity];
                let state = lease.extension.as_ref().unwrap();
                let mark = lease.retention.mark()?;
                let complete = if mark.is_some() {
                    state.released
                } else {
                    match lease.origin {
                        Origin::AgentCreated => state.closed,
                        Origin::UserClaimed => state.released,
                    }
                };
                if !state.fixed_preparation.settled() {
                    return Err(ToolError::CleanupUnconfirmed(
                        "logical fixed resource cleanup or earlier uncertainty remains retained"
                            .into(),
                    ));
                }
                if !complete {
                    return Err(ToolError::CleanupUnconfirmed(
                        "extension tab lacks its physical cleanup proof".into(),
                    ));
                }
                if mark.is_some()
                    && kept_inventory
                        .as_ref()
                        .is_some_and(|tabs| !tabs.contains(&identity.target))
                {
                    // Known authoritative absence settles custody but never means
                    // that the requested deliverable was physically delivered.
                    closed.push(identity.clone());
                    self.tabs.remove(&identity);
                } else if mark == Some(TabMark::Handoff) {
                    let lease = self
                        .tabs
                        .get_mut(&identity)
                        .expect("validated handoff lease");
                    let state = lease.extension.as_mut().expect("validated handoff custody");
                    let creation = state.creation.clone();
                    let group = state.group.clone();
                    let active = handoff_active.as_deref() == Some(identity.target.as_str());
                    *state = ClaimState {
                        creation,
                        group,
                        active,
                        ..Default::default()
                    };
                    lease.retention = Retention::Handoff;
                } else {
                    if mark.is_none() && lease.origin == Origin::AgentCreated {
                        closed.push(identity.clone());
                    }
                    self.tabs.remove(&identity);
                }
            }
            if let Some(state) = self.extension.get_mut(&(owner, browser)) {
                if state.current_turn.as_deref() == Some(&cleanup_turn) {
                    state.logical_active = None;
                    state.current_turn = None;
                }
                if state.retiring_turn.as_deref() == Some(&cleanup_turn) {
                    state.retiring_turn = None;
                }
                state.finish_phases.remove(&cleanup_turn);
            }
        }
        Ok(closed)
    }
}

impl Host {
    fn retain_fixed_services(
        &mut self,
        scope: &CallScope,
        prepared: &cua_driver_core::browser::ExtensionFixedSessionPreparedTab,
        cursor: &crate::cursor::Spec,
        invocation: &crate::InvocationContext<'_>,
        request: &crate::BrowserSessionPreparation,
    ) -> Result<(), ToolError> {
        let identity = BrowserIdentity::of(&scope.provider, prepared.receipt.generation())?
            .tab(&prepared.receipt.tab_id().to_string());
        let effects = if invocation.browser_preparation_policy().effective_popup() {
            Some(
                invocation
                    .browser_host_effects()
                    .filter(|effects| effects.supports_lease_children())
                    .ok_or_else(|| {
                        failed("fixed popup preparation requires actual Host lease-child custody")
                    })?,
            )
        } else {
            None
        };
        if scope.context != operation(invocation)?
            || scope.purpose == CallPurpose::FixedConfiguration
            || !matches!(&request.target, crate::BrowserPreparationTarget::FixedSessionTab { tab_id, scope_id }
                if tab_id == &prepared.receipt.tab_id().to_string() && scope_id == prepared.receipt.scope_id())
        {
            return Err(failed(
                "fixed service retention changed its actual admitted operation",
            ));
        }
        self.extension_preparation_current(scope, request)?;
        if self
            .cursor_scopes
            .get(&(scope.owner, identity.clone()))
            .is_some_and(|endpoint| endpoint.epoch() > scope.epoch)
            || self
                .tabs
                .get(&identity)
                .and_then(|lease| lease.extension.as_ref())
                .is_some_and(|state| state.fixed_preparation.protected_from_epoch(scope.epoch))
        {
            return Err(failed("fixed endpoint belongs to a newer actual UI epoch"));
        }
        let endpoint = super::cursor::CursorEndpoint::fixed(
            scope.control.clone(),
            prepared.receipt.clone(),
            scope.provider.clone(),
            scope.epoch,
            cursor,
        )?;
        let state = self
            .tabs
            .get_mut(&identity)
            .filter(|lease| {
                lease.creator.owner == scope.owner && lease.creator.provider == scope.provider
            })
            .and_then(|lease| lease.extension.as_mut())
            .ok_or_else(|| unknown("fixed services lost actual logical custody"))?;
        if !state.fixed_preparation.ready().is_some_and(|actual| {
            actual.receipt.scope_id() == prepared.receipt.scope_id()
                && actual.completion_id() == prepared.completion_id()
        }) {
            return Err(unknown(
                "fixed services differ from the folded preparation ACK",
            ));
        }
        if let Some(effects) = effects {
            state.lease_children = Some(LeaseChildScope {
                effects,
                turn: scope.context.turn_id.clone(),
                epoch: scope.epoch,
            });
        } else {
            state.lease_children = None;
        }
        self.record_cursor(scope.owner, identity, endpoint);
        Ok(())
    }
}

fn same_popup(left: &ExtensionPopupRequest, right: &ExtensionPopupRequest) -> bool {
    left.claim_id() == right.claim_id()
        && left.tab_id() == right.tab_id()
        && left.url() == right.url()
        && left.wire_context() == right.wire_context()
        && left.frame_id() == right.frame_id()
        && left.document_id() == right.document_id()
        && left.source_url() == right.source_url()
}

fn uncertain_popup(error: &ToolError) -> bool {
    matches!(
        error,
        ToolError::Persistence(_)
            | ToolError::CleanupUnconfirmed(_)
            | ToolError::OperationCleanupUnconfirmed { .. }
            | ToolError::OperationUnknown { .. }
            | ToolError::OutcomeUnknown(_)
    )
}

async fn dispatch_extension_popups(
    host: &Arc<tokio::sync::Mutex<Host>>,
    owner: uuid::Uuid,
    provider: &Provider,
) -> Result<(), ToolError> {
    let extension = provider
        .extension()
        .ok_or_else(|| failed("extension provider required"))?;
    let browser = BrowserIdentity::of(provider, &extension.identity().generation)?;
    loop {
        let next = {
            let mut ledger = host.lock().await;
            let pending = extension
                .pending_operations()
                .await
                .map_err(provider::extension_error)?;
            let mut next = None;
            for completion in pending {
                let Some(source) = PopupSource::from_operation(&completion.operation) else {
                    continue;
                };
                if completion.provider != *extension.identity()
                    || completion.outcome.is_none()
                    || completion.host_operation.is_some()
                    || !ledger.extension_popup_source_current(owner, provider, &source)
                    || ledger
                        .extension
                        .get(&(owner, browser.clone()))
                        .is_none_or(|state| state.applied.contains(&completion.id))
                {
                    continue;
                }
                let Some(scope) = ledger
                    .tabs
                    .get(&browser.tab(&source.tab_id().to_string()))
                    .and_then(|lease| lease.extension.as_ref())
                    .and_then(|state| state.lease_children.clone())
                    .filter(|scope| {
                        scope.turn == source.wire_context().host_turn_id()
                            && scope.effects.supports_lease_children()
                    })
                else {
                    continue;
                };
                let recovered = extension
                    .recover_completion(completion.id)
                    .await
                    .map_err(provider::extension_error)?;
                if !source.matches_recovered(&recovered) {
                    return Err(unknown(
                        "extension popup metadata changed before Host admission",
                    ));
                }
                let request = crate::BrowserLeaseChildRequest {
                    browser_id: provider.id().to_owned(),
                    generation: extension.identity().generation.clone(),
                    native_owner: owner,
                    native_epoch: scope.epoch.to_string(),
                    turn_id: scope.turn,
                    completion_id: completion.id,
                    opener_subject: source.subject(),
                    opener_tab_id: source.tab_id(),
                    url: source.url().to_owned(),
                };
                // The same retained CONTROL receipt owns the intent throughout
                // service execution and any uncertainty. This marker only
                // prevents dispatching that original intent more than once.
                ledger
                    .extension
                    .get_mut(&(owner, browser.clone()))
                    .ok_or_else(|| failed("extension popup provider owner retired"))?
                    .applied
                    .insert(completion.id);
                next = Some((scope.effects, request));
                break;
            }
            next
        };
        let Some((effects, request)) = next else {
            return Ok(());
        };
        let completion_id = request.completion_id;
        let tab_id = request.opener_tab_id;
        // adopt_lease_child owns a new Host resource/T1. Wrapping it in the
        // previous invocation's spawn would give it the wrong operation owner.
        let result = effects.adopt_lease_child(request).await;
        let mut ledger = host.lock().await;
        if result.as_ref().is_err_and(uncertain_popup) {
            if let Some(state) = ledger
                .tabs
                .get_mut(&browser.tab(&tab_id.to_string()))
                .and_then(|lease| lease.extension.as_mut())
            {
                state.presentation_error = result.as_ref().err().map(ToString::to_string);
            }
            // The terminal Unknown is not a physical drain. The actual Host
            // service retains its own extension/root custody; retain this original
            // metadata and its once marker independently as well.
        } else {
            extension
                .acknowledge_completion(completion_id)
                .await
                .map_err(provider::extension_error)?;
            if let Some(state) = ledger.extension.get_mut(&(owner, browser.clone())) {
                state.applied.remove(&completion_id);
            }
        }
    }
}

// An event may arrive while this same retained dispatch holds Host across an
// await. Keep polling that original future while acquiring the event's lock.
async fn lock_for_extension_event<'host>(
    host: &'host tokio::sync::Mutex<Host>,
    dispatch: &mut Option<crate::HostEffectFuture>,
) -> tokio::sync::MutexGuard<'host, Host> {
    let lock = host.lock();
    tokio::pin!(lock);
    loop {
        match dispatch.as_mut() {
            Some(pending) => tokio::select! {
                ledger = &mut lock => return ledger,
                _ = pending => { *dispatch = None; }
            },
            None => return lock.await,
        }
    }
}

async fn register(
    host: &Arc<tokio::sync::Mutex<Host>>,
    owner: uuid::Uuid,
    provider: &Provider,
) -> Result<(), ToolError> {
    let Some(connection) = provider.extension() else {
        return Ok(());
    };
    let browser = BrowserIdentity::of(provider, &connection.identity().generation)?;
    let key = (owner, browser.clone());
    let mut ledger = host.lock().await;
    if ledger.extension.contains_key(&key) {
        return Ok(());
    }
    ledger.extension.insert(
        key,
        ProviderState {
            provider: provider.clone(),
            current_turn: None,
            pending_viewport: None,
            retiring_turn: None,
            logical_active: None,
            session_group_title: None,
            calls: HashMap::new(),
            applied: HashSet::new(),
            finish_phases: HashMap::new(),
            session_headers: None,
            headers_unknown: false,
            uploads: upload::Custody::default(),
            owner_parked: false,
        },
    );
    let mut events = connection.subscribe_events();
    let provider = provider.clone();
    let weak = Arc::downgrade(host);
    drop(ledger);
    tokio::spawn(async move {
        let mut popup_dispatch: Option<crate::HostEffectFuture> = None;
        let mut popup_dirty = false;
        loop {
            let event = match popup_dispatch.as_mut() {
                Some(dispatch) => tokio::select! {
                    event = events.recv() => event,
                    _ = dispatch => {
                        popup_dispatch = None;
                        if popup_dirty {
                            popup_dirty = false;
                            if let Some(host) = weak.upgrade() {
                                let provider = provider.clone();
                                popup_dispatch = Some(Box::pin(async move {
                                    dispatch_extension_popups(&host, owner, &provider).await
                                }));
                            }
                        }
                        continue;
                    }
                },
                None => events.recv().await,
            };
            let Some(host) = weak.upgrade() else {
                break;
            };
            let mut ledger = lock_for_extension_event(&host, &mut popup_dispatch).await;
            if popup_dispatch.is_none() && popup_dirty {
                popup_dirty = false;
                let host = host.clone();
                let provider = provider.clone();
                popup_dispatch = Some(Box::pin(async move {
                    dispatch_extension_popups(&host, owner, &provider).await
                }));
            }
            if !ledger.extension.contains_key(&(owner, browser.clone())) {
                break;
            }
            match event {
                Ok(ExtensionProviderEvent::CompletionReady { .. })
                | Ok(ExtensionProviderEvent::ClaimCdpProgress { .. })
                | Ok(ExtensionProviderEvent::PendingOperationsChanged)
                | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let _ = ledger.reconcile_provider(owner, &provider).await;
                    drop(ledger);
                    if popup_dispatch.is_none() {
                        let host = host.clone();
                        let provider = provider.clone();
                        popup_dispatch = Some(Box::pin(async move {
                            dispatch_extension_popups(&host, owner, &provider).await
                        }));
                    } else {
                        popup_dirty = true;
                    }
                }
                Ok(ExtensionProviderEvent::ClaimUnavailable { claim, reason }) => {
                    let explicit_fixed = provider.extension().is_some_and(|extension| {
                        extension.capabilities().is_ok_and(|caps| {
                            caps.session_preparation == ExtensionSessionPreparation::ExplicitFixed
                        })
                    });
                    for lease in ledger.tabs.values_mut().filter(|lease| {
                        lease.creator.owner == owner && lease.creator.provider == provider
                    }) {
                        if let Some(state) = &mut lease.extension
                            && state
                                .claim
                                .as_ref()
                                .is_some_and(|owned| owned.claim_id() == claim)
                        {
                            let logical_retained = explicit_fixed
                                && state.fixed_preparation.cleanup_receipt().is_some_and(
                                    |receipt| {
                                        receipt.wire_context().host_session_id()
                                            == owner.to_string()
                                            && receipt.generation() == lease.creator.generation
                                            && provider.extension().is_some_and(|extension| {
                                                receipt.generation()
                                                    == extension.identity().generation
                                            })
                                            && state.claim.as_ref().is_some_and(|physical| {
                                                physical.tab_id() == receipt.tab_id()
                                            })
                                    },
                                );
                            state.revoked = true;
                            if state.cleanup_started || logical_retained {
                                // This is a physical-route observation, never
                                // logical cleanup or underlying-effect proof.
                                // Core retains every actual pending CDP effect
                                // independently before broadcasting this event.
                                // Keep all previous Unknown and physical flags;
                                // only exact cleanup+drain can retire the claim.
                                state.cleanup_revocation.get_or_insert(reason.clone());
                            } else {
                                state.unknown = Some(reason.clone());
                            }
                        }
                    }
                }
                Ok(ExtensionProviderEvent::GenerationClosed { reason }) => {
                    for lease in ledger.tabs.values_mut().filter(|lease| {
                        lease.creator.owner == owner && lease.creator.provider == provider
                    }) {
                        if let Some(state) = &mut lease.extension {
                            state.unknown = Some(reason.clone());
                            lease.disposition = Disposition::Closing;
                        }
                    }
                    break;
                }
                Ok(ExtensionProviderEvent::TabStateChanged { tab_id, active, .. }) => {
                    if let Some(lease) = ledger.tabs.get_mut(&browser.tab(&tab_id.to_string()))
                        && let Some(state) = &mut lease.extension
                    {
                        state.active = active;
                    }
                    drop(ledger);
                    let _ = refresh_control(&host, owner, &browser, tab_id, active).await;
                }
                Ok(ExtensionProviderEvent::TabStateUnknown { tab_id, error, .. }) => {
                    if let Some(state) = ledger
                        .tabs
                        .get_mut(&browser.tab(&tab_id.to_string()))
                        .and_then(|lease| lease.extension.as_mut())
                    {
                        state.active = false;
                        state.presentation_error = Some(error.message);
                    }
                    drop(ledger);
                    let _ = refresh_control(&host, owner, &browser, tab_id, false).await;
                }
                Ok(
                    ExtensionProviderEvent::EffectsCleanup { .. }
                    | ExtensionProviderEvent::OrphanCdpCompletion { .. }
                    | ExtensionProviderEvent::SessionPreparationCleanup { .. },
                ) => {
                    let _ = ledger.reconcile_provider(owner, &provider).await;
                }
                Ok(
                    ExtensionProviderEvent::PopupRequested { .. }
                    | ExtensionProviderEvent::SessionPopupRequested { .. },
                ) => {
                    let _ = ledger.reconcile_provider(owner, &provider).await;
                    drop(ledger);
                    if popup_dispatch.is_none() {
                        let host = host.clone();
                        let provider = provider.clone();
                        popup_dispatch = Some(Box::pin(async move {
                            dispatch_extension_popups(&host, owner, &provider).await
                        }));
                    } else {
                        popup_dirty = true;
                    }
                }
                Ok(
                    ExtensionProviderEvent::RouteUnavailable { .. }
                    | ExtensionProviderEvent::DownloadChanged { .. },
                ) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
        // Provider retirement stops observation, never drops an admitted
        // service's still-pending original future as a substitute for drain.
        if let Some(dispatch) = popup_dispatch {
            let _ = dispatch.await;
        }
    });
    Ok(())
}

impl Browsers {
    pub(super) async fn drain_extension_controls(
        &self,
        turn: Option<&str>,
        epoch: Option<crate::desktop::NativeEpochId>,
    ) -> Result<(), ToolError> {
        let host = self.host().await;
        let drain = host
            .lock()
            .await
            .seal_extension_controls(self.owner, turn, epoch);
        // A control future may need a Host callback before it becomes ready.
        // Keep its original permit/resource and wait only after releasing Host.
        drain.wait().await
    }

    pub(super) async fn extension_has_acquisition(
        &self,
        provider: &Provider,
        generation: &str,
        raw: &str,
    ) -> Result<bool, ToolError> {
        let Some(id) = cua_driver_core::browser::parse_browser_tab_id(raw) else {
            return Ok(false);
        };
        let identity = BrowserIdentity::of(provider, generation)?.tab(&id.to_string());
        let host = self.host().await;
        let ledger = host.lock().await;
        ledger.known(&identity.browser)?;
        Ok(ledger.acquisition(self.owner, &identity).is_some()
            || self
                .targets
                .values()
                .filter_map(|tab| tab.extension_acquisition.as_ref())
                .any(|record| record.owner == self.owner && record.identity == identity))
    }
    fn acquisition_history(&self, provider: &Provider) -> Vec<Acquisition> {
        self.targets
            .values()
            .filter(|tab| tab.provider == *provider)
            .filter_map(|tab| tab.extension_acquisition.clone())
            .collect()
    }
    pub(super) async fn extension_session_metadata(
        &self,
        provider: &Provider,
        call: BrowserCall<'_>,
    ) -> Result<(String, Vec<super::TabInfo>), ToolError> {
        let generation = provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?
            .identity()
            .generation
            .clone();
        let pending = session_metadata_call(
            self.host().await,
            self.owner,
            provider,
            self.epoch,
            call,
            self.acquisition_history(provider),
        )
        .await?;
        let mut rows = pending.list().await?;
        let source_active = provider
            .extension()
            .expect("extension provider")
            .capabilities()
            .map_err(provider::extension_error)?
            .session_logical_active;
        let identity = BrowserIdentity::of(provider, &generation)?;
        let host = self.host().await;
        let mut ledger = host.lock().await;
        let state = ledger
            .extension
            .get_mut(&(self.owner, identity))
            .ok_or_else(|| failed("session metadata owner retired"))?;
        let active = if source_active {
            rows.iter()
                .find(|row| row.active == Some(true))
                .map(|row| row.id.to_string())
        } else {
            state
                .logical_active
                .as_ref()
                .filter(|active| rows.iter().any(|row| row.id.to_string() == active.as_str()))
                .cloned()
                .or_else(|| {
                    rows.iter()
                        .find(|row| row.active == Some(true))
                        .map(|row| row.id.to_string())
                })
                .or_else(|| rows.first().map(|row| row.id.to_string()))
        };
        state.logical_active = active.clone();
        if let Some(active) = active {
            for row in &mut rows {
                row.active = Some(row.id.to_string() == active);
            }
        }
        drop(ledger);
        // ChatGPT SID rows absent from Main history remain metadata only.
        // Listing never constructs a lease, acquisition, sequence or grant.
        Ok((
            generation,
            rows.into_iter()
                .filter(|tab| !tab.url.as_deref().is_some_and(is_internal_url))
                .map(provider::extension_tab)
                .collect(),
        ))
    }
    pub(super) async fn extension_exact_metadata(
        &self,
        provider: &Provider,
        raw: &str,
        call: BrowserCall<'_>,
    ) -> Result<(String, super::TabInfo), ToolError> {
        let id = cua_driver_core::browser::parse_browser_tab_id(raw)
            .ok_or_else(|| failed("extension tab ID must convert to a positive safe integer"))?;
        let (generation, rows) = self.extension_session_metadata(provider, call).await?;
        let tab = rows
            .into_iter()
            .find(|tab| tab.id == id.to_string())
            .ok_or_else(|| {
                failed("tab_unavailable: raw tab is not in this session's visible metadata")
            })?;
        Ok((generation, tab))
    }
    pub(super) async fn extension_user_history(
        &self,
        browser_id: &str,
        options: BrowserHistoryOptions,
        call: BrowserCall<'_>,
    ) -> Result<Value, ToolError> {
        let provider = self
            .providers(Some(browser_id))?
            .pop()
            .expect("selected provider");
        let extension = provider
            .extension()
            .ok_or_else(|| failed("selected browser does not support browser-wide history"))?;
        if !extension
            .capabilities()
            .map_err(provider::extension_error)?
            .user_history
        {
            return Err(failed(
                "selected browser does not support browser-wide history",
            ));
        }
        let pending = session_surface_call(
            self.host().await,
            self.owner,
            &provider,
            self.epoch,
            call,
            true,
        )
        .await?;
        pending
            .authorization
            .authorize_history(pending.request.clone(), pending.cancellation.clone())
            .await?;
        pending.check().await?;
        pending
            .authorization
            .check_history(pending.request.clone(), pending.cancellation.clone())
            .await?;
        let mut params = serde_json::to_value(options).map_err(failed)?;
        params
            .as_object_mut()
            .expect("history options object")
            .retain(|_, value| !value.is_null());
        let result = pending
            .scope
            .dispatch(pending.scope.control.user_history(params))
            .await;
        pending
            .host
            .lock()
            .await
            .reconcile_provider(self.owner, &provider)
            .await?;
        let result = result.map_err(provider::extension_error)?;
        pending.check().await?;
        pending
            .authorization
            .check_history(pending.request.clone(), pending.cancellation.clone())
            .await?;
        Ok(result)
    }

    pub(super) async fn name_session(
        &self,
        browser_id: &str,
        name: &str,
        call: BrowserCall<'_>,
    ) -> Result<Value, ToolError> {
        let name = name.trim_matches(|character| {
            matches!(character,
            '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
            '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
            '\u{205f}' | '\u{3000}' | '\u{feff}')
        });
        if name.is_empty() {
            return Err(failed("name_session requires a name"));
        }
        let provider = self
            .providers(Some(browser_id))?
            .pop()
            .expect("selected provider");
        let extension = provider
            .extension()
            .ok_or_else(|| failed("selected browser does not support sessionName"))?;
        let capabilities = extension
            .capabilities()
            .map_err(provider::extension_error)?;
        if capabilities.created_presentation_owner != ExtensionEffectOwner::Host
            && !capabilities.session_naming
        {
            return Err(failed("selected browser does not support sessionName"));
        }
        let pending = session_surface_call(
            self.host().await,
            self.owner,
            &provider,
            self.epoch,
            call,
            false,
        )
        .await?;
        pending.check().await?;
        if capabilities.created_presentation_owner == ExtensionEffectOwner::Provider {
            let result = pending
                .scope
                .dispatch(pending.scope.control.name_session(name))
                .await;
            pending
                .host
                .lock()
                .await
                .reconcile_provider(self.owner, &provider)
                .await?;
            result.map_err(provider::extension_error)?;
            pending.check().await?;
            return Ok(Value::Null);
        }
        let browser = BrowserIdentity::of(&provider, &extension.identity().generation)?;
        let groups = {
            let mut host = pending.host.lock().await;
            check_input(call.cancellation)?;
            host.extension_preparation_current(&pending.scope, &pending.request)?;
            host.extension
                .get_mut(&(self.owner, browser.clone()))
                .ok_or_else(|| failed("session presentation owner retired"))?
                .session_group_title = Some(name.to_owned());
            host.tabs
                .iter()
                .filter(|(identity, lease)| {
                    identity.browser == browser
                        && lease.creator.owner == self.owner
                        && lease.creator.provider == provider
                        && lease.origin == Origin::AgentCreated
                        && matches!(lease.disposition, Disposition::Live)
                })
                .filter_map(|(_, lease)| {
                    let state = lease.extension.as_ref()?;
                    Some((
                        lease.extension_sequence?,
                        state.creation.clone()?,
                        state.group.clone()?,
                    ))
                })
                .collect::<Vec<_>>()
        };
        // Source behavior persists the requested title before a best-effort
        // existing-group update. Lifetime/uncertain transport failures remain
        // visible to the Host rather than becoming false cleanup proof.
        let mut groups = groups;
        groups.sort_by_key(|(sequence, _, _)| *sequence);
        let mut updated = HashSet::new();
        for (_, creation, group) in groups {
            if !updated.insert(group.group_id()) {
                continue;
            }
            pending.check().await?;
            let result = pending
                .scope
                .dispatch(pending.scope.control.update_created_tab_group(
                    &creation,
                    &group,
                    &ExtensionGroupPresentation {
                        title: Some(name.to_owned()),
                        color: None,
                    },
                ))
                .await;
            pending
                .host
                .lock()
                .await
                .reconcile_provider(self.owner, &provider)
                .await?;
            match result.as_ref().map_err(|error| error.as_ref()) {
                Ok(_)
                | Err(cua_driver_core::browser::ExtensionProviderError::ChromeRejected {
                    ..
                }) => break,
                Err(cua_driver_core::browser::ExtensionProviderError::Refused { kind, .. })
                    if matches!(
                        kind.as_str(),
                        "group_unavailable" | "tab_unavailable" | "creation_unavailable"
                    ) =>
                {
                    continue;
                }
                Err(error) => return Err(provider::extension_error(error)),
            }
        }
        pending.check().await?;
        Ok(Value::Null)
    }

    pub(super) async fn managed_tabs(
        &self,
        browser_id: &str,
        call: BrowserCall<'_>,
    ) -> Result<Value, ToolError> {
        let provider = self.providers(Some(browser_id))?.pop().unwrap();
        if provider.extension().is_none() {
            let (_, tabs) = self.visible_inventory(&provider).await?;
            return Ok(json!(
                tabs.iter()
                    .map(|tab| super::tab_info(&provider, tab))
                    .collect::<Vec<_>>()
            ));
        }
        let (_, rows) = self.extension_session_metadata(&provider, call).await?;
        Ok(json!(
            rows.iter()
                .filter_map(|tab| tab.extension.as_ref())
                .map(managed_tab_info)
                .collect::<Vec<_>>()
        ))
    }
    pub(super) async fn reconcile_extension_command(
        &mut self,
        command: &Command,
    ) -> Result<(), ToolError> {
        let selected = match command {
            Command::BrowserTab { browser_id, .. }
            | Command::BrowserManagedTabs { browser_id }
            | Command::BrowserSelectedTab { browser_id }
            | Command::BrowserNameSession { browser_id, .. }
            | Command::BrowserHistory { browser_id, .. }
            | Command::BrowserViewportSet { browser_id, .. }
            | Command::BrowserViewportReset { browser_id }
            | Command::BrowserUserOpenTabs { browser_id }
            | Command::BrowserUserGetTabContext { browser_id, .. }
            | Command::BrowserUserClaimTab { browser_id, .. }
            | Command::CreateBrowserTab { browser_id, .. } => {
                self.providers(Some(browser_id))?.pop()
            }
            Command::GetTab { options, .. } | Command::ListTabs { options } => {
                match options.browser.as_deref() {
                    Some(id) => self.providers(Some(id))?.pop(),
                    None => None,
                }
            }
            Command::Observe { handle, .. }
            | Command::Action { handle, .. }
            | Command::BrowserMarkTab { handle, .. }
            | Command::BrowserScreenshot { handle, .. }
            | Command::TabMetadata { handle }
            | Command::ClipboardRead { handle }
            | Command::ClipboardReadText { handle }
            | Command::ClipboardWrite { handle, .. }
            | Command::ClipboardWriteText { handle, .. }
            | Command::GetJsDialog { handle }
            | Command::HandleJsDialog { handle, .. }
            | Command::BrowserEvaluate { handle, .. }
            | Command::BrowserRead { handle, .. }
            | Command::TabPageAssetsList { handle }
            | Command::TabPageAssetsBundle { handle, .. }
            | Command::BrowserCua { handle, .. }
            | Command::BrowserWait { handle, .. }
            | Command::BrowserMutation { handle, .. } => match handle {
                Handle::Tab(id) => self.targets.get(id).map(|tab| tab.provider.clone()),
                Handle::App(_) => None,
            },
            _ => None,
        };
        let Some(provider) = selected.filter(|provider| provider.extension().is_some()) else {
            return Ok(());
        };
        self.reconcile_extension_provider(&provider).await
    }

    async fn reconcile_extension_provider(&self, provider: &Provider) -> Result<(), ToolError> {
        let host = self.host().await;
        register(&host, self.owner, provider).await?;
        if host
            .lock()
            .await
            .reconcile_provider(self.owner, provider)
            .await?
        {
            return Err(ToolError::CleanupUnconfirmed(
                "a previous extension mutation is still in flight".into(),
            ));
        }
        Ok(())
    }
    pub(super) async fn user_tabs(&self, browser_id: &str) -> Result<Value, ToolError> {
        let provider = self.providers(Some(browser_id))?.pop().unwrap();
        let extension=provider.extension().ok_or_else(||failed("browser.user is not implemented for the configured CDP provider; select a connected extension adapter"))?;
        let tabs = extension
            .list_user_tabs()
            .await
            .map_err(provider::extension_error)?;
        let tabs = ordered_user_tabs(
            tabs,
            extension
                .capabilities()
                .map_err(provider::extension_error)?
                .user_tabs_order,
        );
        let identity = BrowserIdentity::of(&provider, &extension.identity().generation)?;
        let host = self.host().await;
        let ledger = host.lock().await;
        ledger.known(&identity)?;
        let mut result = Vec::new();
        for tab in tabs {
            if ledger.visible(&identity.tab(&tab.id.to_string()), self.owner) {
                result.push(tab_info(&tab));
            }
        }
        Ok(json!(result))
    }
    pub(super) async fn mark_tab(
        &mut self,
        handle: &str,
        status: crate::protocol::BrowserTabMark,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let host = self.host().await;
        let tab = self
            .targets
            .get_mut(handle)
            .ok_or_else(|| failed("stale_tab: bind it again"))?;
        if tab.provider.extension().is_none() {
            return Err(failed("tab retention marks are unavailable for direct CDP"));
        }
        // Like normal claim use, this runs the already-authorized session
        // preparer. Metadata-only attachment cannot stand in for a provider
        // whose real requireSessionTab performs full preparation.
        tab.prepare_extension_session(invocation, cancellation, language, ClaimIntent::Implicit)
            .await?;
        let identity = tab.identity()?;
        let claim = tab
            .extension_claim
            .clone()
            .ok_or_else(|| failed("tab mark requires its currently admitted physical claim"))?;
        let issued = operation(invocation)?;
        let scope = host.lock().await.extension_context(
            self.owner,
            &tab.provider,
            issued.clone(),
            self.epoch,
            CallTarget::Tab {
                origin: Origin::UserClaimed,
                tab: Some(tab.info.id.clone()),
            },
            true,
        )?;
        let requested = match status {
            crate::protocol::BrowserTabMark::Handoff => TabMark::Handoff,
            crate::protocol::BrowserTabMark::Deliverable => TabMark::Deliverable,
        };
        check_input(cancellation)?;
        let attempt = host
            .lock()
            .await
            .begin_mark(&identity, self.owner, &issued, self.epoch, requested)?;
        let result = scope
            .dispatch(scope.control.mark_tab(&claim, mark_to_core(requested)))
            .await;
        let no_dispatch = result
            .as_ref()
            .err()
            .is_some_and(|error| scope.control.undispatched_control(error).is_some());
        let mut ledger = host.lock().await;
        ledger.reconcile_provider(self.owner, &tab.provider).await?;
        if ledger.mark_attempt_pending(&identity, self.owner, &attempt) {
            let outcome = match &result {
                Ok(_) => {
                    return Err(unknown(
                        "tab mark ACK was not folded into its exact issued ledger",
                    ));
                }
                Err(_) if no_dispatch => Err(MarkFailure::NotDispatched),
                Err(error) => Err(MarkFailure::Unknown(error.to_string())),
            };
            ledger.mark_result(&identity, self.owner, &attempt, outcome)?;
        }
        result.map_err(provider::extension_error)?;
        tab.last_turn = invocation.turn().to_owned();
        Ok(Value::Null)
    }

    pub(super) async fn check_download_tab_lease(
        &self,
        handle: &str,
        turn: &str,
    ) -> Result<(), ToolError> {
        let tab = self
            .targets
            .get(handle)
            .ok_or_else(|| failed("stale_tab: bind it again"))?;
        let Some(acquired) = tab.extension_acquisition.as_ref().map(Acquisition::turn) else {
            return Ok(());
        };
        let selected = self
            .providers(Some(tab.provider.id()))?
            .pop()
            .ok_or_else(|| failed("extension download provider is unavailable"))?;
        if selected != tab.provider
            || selected.extension().is_none_or(|extension| {
                extension.is_closed() || extension.identity().generation != tab.generation
            })
        {
            return Err(failed(
                "extension download belongs to an old provider generation",
            ));
        }
        if tab.provider.extension().is_none() || acquired != turn {
            return Ok(());
        }
        let identity = tab.identity()?;
        let host = self.host().await;
        let ledger = host.lock().await;
        ledger.known(&identity.browser)?;
        let current = ledger
            .extension
            .get(&(self.owner, identity.browser.clone()))
            .is_some_and(|state| {
                state.current_turn.as_deref() == Some(turn) && state.retiring_turn.is_none()
            });
        let logical = ledger.tabs.get(&identity).is_some_and(|lease| {
            lease.creator.owner == self.owner
                && lease.creator.provider == tab.provider
                && lease.creator.generation == tab.generation
                && lease.creator.turn == turn
                && matches!(lease.disposition, Disposition::Live)
        });
        if !current || !logical {
            return Err(failed(
                "stale_tab: extension download has no current logical session lease",
            ));
        }
        Ok(())
    }

    pub(super) async fn claim_user_tab(
        &mut self,
        browser_id: &str,
        raw: &str,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let provider = self.providers(Some(browser_id))?.pop().unwrap();
        let extension = provider.extension().cloned().ok_or_else(|| {
            failed("browser.user.claimTab requires a connected extension adapter")
        })?;
        let id = cua_driver_core::browser::parse_browser_tab_id(raw)
            .ok_or_else(|| failed("extension tab ID must convert to a positive safe integer"))?;
        let capabilities = extension
            .capabilities()
            .map_err(provider::extension_error)?;
        match capabilities.session_preparation {
            ExtensionSessionPreparation::ProviderSession if capabilities.session_tab_resolution => {
            }
            ExtensionSessionPreparation::ExplicitFixed => {}
            _ => {
                return Err(failed(
                    "extension adapter does not implement full logical session preparation",
                ));
            }
        }
        check_input(cancellation)?;
        self.reconcile_extension_provider(&provider).await?;
        let host = self.host().await;
        let generation = extension.identity().generation.clone();
        let identity = BrowserIdentity::of(&provider, &generation)?.tab(&id.to_string());
        let history = self
            .acquisition_history(&provider)
            .into_iter()
            .filter(|record| record.identity == identity)
            .max_by_key(|record| record.sequence);
        let scope = {
            let mut ledger = host.lock().await;
            let context = operation(invocation)?;
            let scope = ledger.extension_context(
                self.owner,
                &provider,
                context.clone(),
                self.epoch,
                CallTarget::Tab {
                    origin: Origin::UserClaimed,
                    tab: Some(id.to_string()),
                },
                true,
            )?;
            if !ledger.begin_handoff_transfer(
                self.owner,
                &provider,
                &context,
                self.epoch,
                &id.to_string(),
            )? {
                ledger.extension_reserve(
                    self.owner,
                    &provider,
                    invocation.turn(),
                    &id.to_string(),
                    Origin::UserClaimed,
                )?;
                ledger.restore_acquisition_order(self.owner, &identity, history.as_ref());
            }
            scope
        };
        let preparation = match scope
            .authorize_preparation(
                &host,
                invocation,
                crate::BrowserPreparationTarget::ReservedTab {
                    tab_id: id.to_string(),
                },
                cancellation,
            )
            .await
        {
            Ok(request) => request,
            Err(error) => {
                // This boundary ran only Host authorization, before Core dispatch.
                host.lock()
                    .await
                    .rollback_handoff_transfer(&identity, self.owner, &scope.context);
                return Err(error);
            }
        };
        let _effects = invocation
            .browser_host_effects()
            .ok_or_else(|| failed("direct extension claim requires Host effect custody"))?;
        let _settlement = invocation
            .operation_settlement()
            .ok_or_else(|| failed("direct extension claim requires Host settlement custody"))?;
        let headers = preparation_headers(invocation);
        if capabilities.session_preparation == ExtensionSessionPreparation::ProviderSession
            && !headers.is_empty()
            && extension
                .capabilities()
                .map_err(provider::extension_error)?
                .header_scope
                == ExtensionHeaderPolicyScope::Session
        {
            scope
                .check_preparation(&host, invocation, &preparation, cancellation)
                .await?;
            let applied = scope
                .dispatch(scope.control.set_session_headers(&headers))
                .await;
            host.lock()
                .await
                .reconcile_provider(self.owner, &provider)
                .await?;
            applied.map_err(provider::extension_error)?;
        }
        scope
            .check_preparation(&host, invocation, &preparation, cancellation)
            .await?;
        let (prepared_tab, fixed_presentation) = if capabilities.session_preparation
            == ExtensionSessionPreparation::ExplicitFixed
        {
            let cursor = fixed_cursor_spec(&self.cursor_spec)?;
            if invocation.browser_preparation_policy().effective_popup()
                && invocation
                    .browser_host_effects()
                    .is_none_or(|effects| !effects.supports_lease_children())
            {
                return Err(failed(
                    "fixed popup relay requires actual Host lease-child support",
                ));
            }
            let prepared =
                prepare_fixed_tab(&scope, &host, invocation, cancellation, id, &cursor).await?;
            let request = scope
                .authorize_preparation(
                    &host,
                    invocation,
                    crate::BrowserPreparationTarget::FixedSessionTab {
                        tab_id: id.to_string(),
                        scope_id: prepared.receipt.scope_id().to_owned(),
                    },
                    cancellation,
                )
                .await?;
            let current =
                FixedPresentationScope::capture(&scope, request.clone(), invocation, cancellation)?;
            host.lock()
                .await
                .retain_fixed_services(&scope, &prepared, &cursor, invocation, &request)?;
            (prepared.tab, Some(current))
        } else {
            {
                let mut ledger = host.lock().await;
                check_input(cancellation)?;
                ledger.extension_preparation_current(&scope, &preparation)?;
                let state = ledger
                    .tabs
                    .get_mut(&identity)
                    .and_then(|lease| lease.extension.as_mut())
                    .ok_or_else(|| unknown("direct claim lost its prospective custody"))?;
                match &state.user_preparation {
                    UserPreparation::Pending(_) => {
                        return Err(ToolError::CleanupUnconfirmed(
                            "direct claim remains pending; it was not replayed".into(),
                        ));
                    }
                    UserPreparation::Unknown(reason) => return Err(unknown(reason)),
                    UserPreparation::NotAttempted | UserPreparation::Completed => {}
                }
                state.user_preparation = UserPreparation::Pending(scope.context.clone());
            }
            let boundary = host
                .lock()
                .await
                .handoff_preparation_boundary(&scope, &identity);
            let mut entered = false;
            let prepared = scope
                .dispatch(async {
                    enter_handoff_preparation(boundary.as_ref())?;
                    entered = true;
                    scope
                        .control
                        .prepare_session_tab(id)
                        .await
                        .map_err(Box::new)
                })
                .await;
            let preparation_not_dispatched = prepared.as_ref().err().is_some_and(|error| {
                !entered || scope.control.undispatched_control(error).is_some()
            });
            if preparation_not_dispatched {
                host.lock()
                    .await
                    .settle_undispatched_preparation(&scope, &identity);
            }
            host.lock()
                .await
                .reconcile_provider(self.owner, &provider)
                .await?;
            let prepared = match prepared {
                Ok(prepared) => prepared,
                Err(error) => {
                    host.lock().await.extension_preparation_failed(
                        &identity,
                        &scope.context,
                        !entered || scope.control.undispatched_control(&error).is_some(),
                        &error,
                    );
                    return Err(provider::extension_error(error));
                }
            };
            (prepared.tab, None)
        };
        if prepared_tab.id != id {
            return Err(unknown("direct claim ACK changed its reserved raw tab"));
        }
        scope
            .check_preparation(&host, invocation, &preparation, cancellation)
            .await?;
        let record = host
            .lock()
            .await
            .acquisition(self.owner, &identity)
            .ok_or_else(|| unknown("direct claim ACK lost its actual acquisition record"))?;
        let bound = self
            .bind(
                TabSource {
                    provider: provider.clone(),
                    generation,
                    info: provider::extension_tab(prepared_tab),
                },
                InitialState::Deferred,
                invocation,
                cancellation,
                language,
            )
            .await?;
        let Handle::Tab(handle) =
            serde_json::from_value(bound["handle"].clone()).map_err(failed)?
        else {
            unreachable!()
        };
        self.targets
            .get_mut(&handle)
            .expect("claimed tab is bound")
            .extension_acquisition = Some(record);
        self.targets
            .get_mut(&handle)
            .expect("claimed tab is bound")
            .fixed_presentation = fixed_presentation;
        // ChatGPT ClaimUserTab has already run its fixed extension preparation.
        // This API returns a lazy Tab; AX/content/attach/focus require their own
        // subsequent actual authorization. Explicit fixed providers use their
        // sealed logical receipt without a debugger attachment or Site grant.
        Ok(bound)
    }
    pub(crate) async fn adopt_extension_popup(
        &mut self,
        request: crate::BrowserLeaseChildRequest,
        invocation: &crate::InvocationContext<'_>,
        _cursor: &crate::cursor::Spec,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        check_input(cancellation)?;
        if !invocation.browser_preparation_policy().effective_popup() {
            return Err(failed(
                "extension popup handling is disabled by the current Host policy",
            ));
        }
        if request.native_owner != self.owner
            || request.native_epoch != self.epoch.to_string()
            || request.turn_id != invocation.turn()
        {
            return Err(failed(
                "extension popup belongs to another owner, epoch or turn",
            ));
        }
        let provider = self
            .providers(Some(&request.browser_id))?
            .pop()
            .ok_or_else(|| failed("extension popup browser is unavailable"))?;
        let extension = provider
            .extension()
            .ok_or_else(|| failed("extension popup requires its original extension provider"))?
            .clone();
        if extension.identity().generation != request.generation {
            return Err(failed(
                "extension popup generation changed before admission",
            ));
        }
        validate_url(&request.url)?;
        let browser = BrowserIdentity::of(&provider, &request.generation)?;
        let host = self.host().await;
        let (scope, opener, source, viewport) = {
            let mut ledger = host.lock().await;
            let completion = extension
                .pending_operations()
                .await
                .map_err(provider::extension_error)?
                .into_iter()
                .find(|entry| entry.id == request.completion_id)
                .ok_or_else(|| failed("extension popup intent is no longer retained"))?;
            let actual = PopupSource::from_operation(&completion.operation)
                .ok_or_else(|| failed("extension popup id does not name a popup intent"))?;
            if completion.provider != *extension.identity()
                || completion.outcome.is_none()
                || completion.host_operation.is_some()
                || request.opener_subject != actual.subject()
                || actual.tab_id() != request.opener_tab_id
                || actual.url() != request.url
                || actual.wire_context().host_session_id() != self.owner.to_string()
                || actual.wire_context().host_turn_id() != request.turn_id
                || !ledger.extension_popup_source_current(self.owner, &provider, &actual)
            {
                return Err(failed("extension popup lost its exact live source lease"));
            }
            let recovered = extension
                .recover_completion(request.completion_id)
                .await
                .map_err(provider::extension_error)?;
            if !actual.matches_recovered(&recovered) {
                return Err(unknown("extension popup retained metadata changed"));
            }
            let state = ledger
                .tabs
                .get(&browser.tab(&request.opener_tab_id.to_string()))
                .and_then(|lease| lease.extension.as_ref())
                .ok_or_else(|| failed("extension popup opener custody is unavailable"))?;
            if state
                .lease_children
                .as_ref()
                .is_none_or(|scope| scope.epoch != self.epoch || scope.turn != request.turn_id)
                || ledger
                    .extension
                    .get(&(self.owner, browser.clone()))
                    .is_none_or(|state| !state.applied.contains(&request.completion_id))
            {
                return Err(failed(
                    "extension popup was not issued by its prepared source lease",
                ));
            }
            let viewport = ledger
                .tabs
                .get(&browser.tab(&request.opener_tab_id.to_string()))
                .and_then(|lease| lease.viewport);
            let opener = actual.opener(&ledger, self.owner, &provider)?;
            // Only the real service InvocationContext supplies this operation;
            // the popup metadata and old preparation scope supply no cause ID.
            let scope = ledger.extension_context(
                self.owner,
                &provider,
                operation(invocation)?,
                self.epoch,
                CallTarget::Tab {
                    origin: Origin::AgentCreated,
                    tab: Some(request.opener_tab_id.to_string()),
                },
                true,
            )?;
            (scope, opener, actual.clone(), viewport)
        };
        let preparation = scope
            .authorize_preparation(&host, invocation, source.preparation_target(), cancellation)
            .await?;
        scope
            .check_preparation(&host, invocation, &preparation, cancellation)
            .await?;
        let created = match &opener {
            PopupOpener::Physical(claim) => {
                scope.dispatch(scope.control.create_popup_tab(claim)).await
            }
            PopupOpener::Fixed(receipt) => {
                scope
                    .dispatch(scope.control.create_session_popup_tab(receipt))
                    .await
            }
        };
        host.lock()
            .await
            .reconcile_provider(self.owner, &provider)
            .await?;
        // A lost creation reply is already in the existing Created/Unknown
        // ledger, including a real creation receipt without an observed tab ID.
        let created = created.map_err(provider::extension_error)?;
        let source_live = host
            .lock()
            .await
            .extension_popup_source_current(self.owner, &provider, &source);
        if !source_live || cancellation.is_cancelled() {
            let cleanup = scope
                .dispatch_retirement(scope.control.stop_created_tab(created.creation_receipt()))
                .await;
            host.lock()
                .await
                .reconcile_provider(self.owner, &provider)
                .await?;
            cleanup.map_err(provider::extension_error)?;
            return Err(failed(
                "extension popup source expired after child creation",
            ));
        }
        host.lock()
            .await
            .tabs
            .get_mut(&browser.tab(&created.tab.id.to_string()))
            .ok_or_else(|| unknown("extension popup child lost its issued lease"))?
            .viewport = viewport;
        let BoundExtensionCreated {
            response,
            handle,
            identity,
        } = self
            .bind_extension_created(
                &provider,
                &scope,
                created,
                invocation,
                cancellation,
                language,
            )
            .await?;
        {
            let child = self
                .targets
                .get_mut(&handle)
                .ok_or_else(|| unknown("extension popup child binding disappeared"))?;
            child
                .prepare_metadata(invocation, cancellation, language)
                .await?;
            let origin = child.document_origin().await?;
            if origin.document_identity().url() != "about:blank"
                || origin.origin() != crate::BrowserAttachmentOrigin::Opaque
            {
                return Err(unknown(
                    "created extension popup is not the verified opaque blank document",
                ));
            }
            origin.check_current(child).await?;
            // The Host service permits this verified opaque blank preparation
            // under current global policy. It grants no destination Site read.
            child
                .authorize(None, invocation, cancellation, language)
                .await?;
            child
                .apply_pending_viewport(BrowserCall::new(invocation, cancellation, language))
                .await?;
            origin.check_current(child).await?;
        }
        if let Some(state) = host
            .lock()
            .await
            .extension
            .get_mut(&(self.owner, identity.browser.clone()))
        {
            state.logical_active = Some(identity.target.clone());
        }
        // This exact captured page request uses the service's dedicated current
        // global/network authorization. Ordinary model Navigate is unchanged.
        self.use_tab(&identity, invocation.turn()).await?;
        let child = self
            .targets
            .get_mut(&handle)
            .ok_or_else(|| unknown("extension popup child binding disappeared"))?;
        child
            .authorize(Some(&request.url), invocation, cancellation, language)
            .await?;
        child.connect_metadata().await?;
        child.check_navigation(&request.url).await?;
        {
            let ledger = host.lock().await;
            let source_live = ledger.extension_popup_source_current(self.owner, &provider, &source);
            if !source_live
                || ledger
                    .extension
                    .get(&(self.owner, browser))
                    .is_none_or(|state| {
                        state.current_turn.as_deref() != Some(request.turn_id.as_str())
                            || state.retiring_turn.is_some()
                            || state.logical_active.as_deref() != Some(identity.target.as_str())
                    })
            {
                return Err(failed(
                    "extension popup source or logical child expired before navigation",
                ));
            }
        }
        if !invocation.browser_preparation_policy().headers.is_empty()
            && extension
                .capabilities()
                .map_err(provider::extension_error)?
                .session_preparation
                == ExtensionSessionPreparation::ExplicitFixed
        {
            let ledger = host.lock().await;
            let prepared = ledger
                .tabs
                .get(&identity)
                .and_then(|lease| lease.extension.as_ref())
                .and_then(|state| state.fixed_preparation.ready())
                .ok_or_else(|| unknown("popup child lost its actual logical header custody"))?;
            if !prepared.headers.active
                || !prepared.headers.state_confirmed
                || prepared.headers.scope.as_ref().is_none_or(|scope| {
                    scope.claim != prepared.receipt.scope_id()
                        || scope.tab_id != prepared.receipt.tab_id()
                        || scope.generation != prepared.receipt.generation()
                })
            {
                return Err(ToolError::CleanupUnconfirmed(
                    "popup child headers lack an actual scoped ACK before its first request".into(),
                ));
            }
        }
        check_input(cancellation)?;
        child.refs.clear();
        let navigated = child
            .request("Page.navigate", json!({"url":request.url}))
            .await?;
        if let Some(error) = navigated.get("errorText") {
            return Err(failed(format!(
                "extension popup navigation failed: {error}"
            )));
        }
        // Readiness/AX/content observation requires an independently admitted
        // destination read; this service only retains the navigation loader.
        child.navigation = navigated["loaderId"]
            .as_str()
            .map(|loader| Navigation::Loader(loader.into()));
        Ok(response)
    }

    async fn bind_extension_created(
        &mut self,
        provider: &Provider,
        scope: &CallScope,
        created: ExtensionCreatedTab,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<BoundExtensionCreated, ToolError> {
        let extension = provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?;
        let capabilities = extension
            .capabilities()
            .map_err(provider::extension_error)?;
        let host = self.host().await;
        let identity = BrowserIdentity::of(provider, &extension.identity().generation)?
            .tab(&created.tab.id.to_string());
        let receipt = created.creation_receipt().clone();
        let preparation = scope
            .authorize_preparation(
                &host,
                invocation,
                crate::BrowserPreparationTarget::ReservedTab {
                    tab_id: created.tab.id.to_string(),
                },
                cancellation,
            )
            .await?;
        match extension
            .capabilities()
            .map_err(provider::extension_error)?
            .created_presentation_owner
        {
            ExtensionEffectOwner::Provider => {}
            ExtensionEffectOwner::Unavailable => {
                return Err(failed(
                    "extension adapter cannot prepare created-tab presentation",
                ));
            }
            ExtensionEffectOwner::Host => {
                scope
                    .check_preparation(&host, invocation, &preparation, cancellation)
                    .await?;
                scope
                    .dispatch(scope.control.mute_created_tab(&receipt))
                    .await
                    .map_err(provider::extension_error)?;
                host.lock()
                    .await
                    .reconcile_provider(self.owner, provider)
                    .await?;
                let existing = host
                    .lock()
                    .await
                    .tabs
                    .iter()
                    .filter(|(_, lease)| {
                        lease.creator.owner == self.owner
                            && lease.creator.provider == *provider
                            && lease.origin == Origin::AgentCreated
                    })
                    .find_map(|(_, lease)| {
                        lease
                            .extension
                            .as_ref()
                            .and_then(|state| state.group.clone())
                    });
                let presentation = ExtensionGroupPresentation {
                    title: Some(
                        host.lock()
                            .await
                            .extension
                            .get(&(self.owner, identity.browser.clone()))
                            .and_then(|state| state.session_group_title.clone())
                            .unwrap_or_else(|| "Maka".into()),
                    ),
                    color: Some(ExtensionGroupColor::Blue),
                };
                scope
                    .check_preparation(&host, invocation, &preparation, cancellation)
                    .await?;
                scope
                    .dispatch(scope.control.ensure_created_tab_group(
                        &receipt,
                        existing.as_ref(),
                        &presentation,
                    ))
                    .await
                    .map_err(provider::extension_error)?;
                host.lock()
                    .await
                    .reconcile_provider(self.owner, provider)
                    .await?;
            }
        }
        let fixed_presentation = if capabilities.session_preparation
            == ExtensionSessionPreparation::ExplicitFixed
        {
            if invocation.browser_preparation_policy().effective_popup()
                && invocation
                    .browser_host_effects()
                    .is_none_or(|effects| !effects.supports_lease_children())
            {
                return Err(failed(
                    "fixed popup relay requires actual Host lease-child support",
                ));
            }
            let cursor = fixed_cursor_spec(&self.cursor_spec)?;
            let fixed = prepare_fixed_tab(
                scope,
                &host,
                invocation,
                cancellation,
                created.tab.id,
                &cursor,
            )
            .await?;
            let request = scope
                .authorize_preparation(
                    &host,
                    invocation,
                    crate::BrowserPreparationTarget::FixedSessionTab {
                        tab_id: created.tab.id.to_string(),
                        scope_id: fixed.receipt.scope_id().to_owned(),
                    },
                    cancellation,
                )
                .await?;
            let presentation =
                FixedPresentationScope::capture(scope, request.clone(), invocation, cancellation)?;
            host.lock()
                .await
                .retain_fixed_services(scope, &fixed, &cursor, invocation, &request)?;
            Some(presentation)
        } else {
            None
        };
        let info = if capabilities.created_presentation_owner == ExtensionEffectOwner::Provider {
            created.tab.clone()
        } else {
            scope
                .check_preparation(&host, invocation, &preparation, cancellation)
                .await?;
            scope
                .dispatch(
                    scope
                        .control
                        .resolve_session_tab(&created.tab.id.to_string()),
                )
                .await
                .map_err(provider::extension_error)?
        };
        let bound = self
            .bind(
                TabSource {
                    provider: provider.clone(),
                    generation: extension.identity().generation.clone(),
                    info: provider::extension_tab(info),
                },
                InitialState::Deferred,
                invocation,
                cancellation,
                language,
            )
            .await?;
        let Handle::Tab(handle) =
            serde_json::from_value(bound["handle"].clone()).map_err(failed)?
        else {
            unreachable!()
        };
        self.targets
            .get_mut(&handle)
            .expect("created tab is bound")
            .fixed_presentation = fixed_presentation;
        self.targets
            .get_mut(&handle)
            .expect("created tab is bound")
            .capture_acquisition()
            .await?;
        Ok(BoundExtensionCreated {
            response: bound,
            handle,
            identity,
        })
    }

    pub(super) async fn create_extension(
        &mut self,
        provider: Provider,
        url: Option<String>,
        initial: InitialState,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let extension = provider.extension().unwrap().clone();
        let host = self.host().await;
        register(&host, self.owner, &provider).await?;
        let scope = host.lock().await.extension_context(
            self.owner,
            &provider,
            operation(invocation)?,
            self.epoch,
            CallTarget::Tab {
                origin: Origin::AgentCreated,
                tab: None,
            },
            true,
        )?;
        let preparation = scope
            .authorize_preparation(
                &host,
                invocation,
                crate::BrowserPreparationTarget::PendingCreation,
                cancellation,
            )
            .await?;
        let capabilities = extension
            .capabilities()
            .map_err(provider::extension_error)?;
        let headers = preparation_headers(invocation);
        if capabilities.header_scope == ExtensionHeaderPolicyScope::Session && !headers.is_empty() {
            let browser = BrowserIdentity::of(&provider, &extension.identity().generation)?;
            let active = host
                .lock()
                .await
                .extension
                .get(&(self.owner, browser))
                .and_then(|state| state.session_headers.as_ref())
                .is_some_and(|proof| proof.active && proof.state_confirmed);
            if !active {
                scope
                    .check_preparation(&host, invocation, &preparation, cancellation)
                    .await?;
                let applied = scope
                    .dispatch(scope.control.set_session_headers(&headers))
                    .await;
                host.lock()
                    .await
                    .reconcile_provider(self.owner, &provider)
                    .await?;
                applied.map_err(provider::extension_error)?;
            }
        }
        let preferred = if capabilities.created_presentation_owner == ExtensionEffectOwner::Host {
            let (group_window, logical_active) = {
                let ledger = host.lock().await;
                let group = ledger
                    .tabs
                    .values()
                    .filter(|lease| {
                        lease.creator.owner == self.owner
                            && lease.creator.provider == provider
                            && lease.origin == Origin::AgentCreated
                            && matches!(lease.disposition, Disposition::Live)
                    })
                    .find_map(|lease| {
                        lease
                            .extension
                            .as_ref()
                            .and_then(|state| state.group.as_ref())
                            .map(ExtensionManagedGroupReceipt::window_id)
                    });
                let active = ledger
                    .extension
                    .get(&(
                        self.owner,
                        BrowserIdentity::of(&provider, &extension.identity().generation)?,
                    ))
                    .and_then(|state| state.logical_active.clone());
                (group, active)
            };
            match (group_window, logical_active) {
                (Some(window), _) => Some(i64::try_from(window).map_err(failed)?),
                (None, Some(tab)) => {
                    scope
                        .check_preparation(&host, invocation, &preparation, cancellation)
                        .await?;
                    scope
                        .dispatch(scope.control.resolve_session_tab(&tab))
                        .await
                        .map_err(provider::extension_error)?
                        .window_id
                }
                (None, None) => None,
            }
        } else {
            None
        };
        scope
            .check_preparation(&host, invocation, &preparation, cancellation)
            .await?;
        let created = scope.dispatch(scope.control.create_tab(preferred)).await;
        host.lock()
            .await
            .reconcile_provider(self.owner, &provider)
            .await?;
        let created = created.map_err(provider::extension_error)?;
        let BoundExtensionCreated {
            response: mut bound,
            handle,
            identity,
        } = self
            .bind_extension_created(
                &provider,
                &scope,
                created,
                invocation,
                cancellation,
                language,
            )
            .await?;
        self.targets
            .get_mut(&handle)
            .unwrap()
            .authorize(None, invocation, cancellation, language)
            .await?;
        if let Some(state) = host
            .lock()
            .await
            .extension
            .get_mut(&(self.owner, identity.browser))
        {
            state.logical_active = Some(identity.target);
        }
        if let Some(url) = url {
            self.action(
                &handle,
                Action::Navigate { url },
                invocation,
                &crate::cursor::Spec::default(),
                cancellation,
                language,
            )
            .await?;
        }
        if matches!(initial, InitialState::Observe) {
            let observed = self
                .observe(
                    &handle,
                    ObservationKind::Ax,
                    false,
                    invocation,
                    cancellation,
                    language,
                )
                .await?;
            bound["state"] = observed["state"].clone();
        }
        Ok(bound)
    }
}

impl Tab {
    async fn capture_acquisition(&mut self) -> Result<(), ToolError> {
        let identity = self.identity()?;
        let record = self
            .cursor_host
            .lock()
            .await
            .acquisition(self.cursor_owner, &identity);
        if let Some(record) = record {
            if record.epoch > self.cursor_epoch {
                return Err(unknown(
                    "extension acquisition belongs to a replacement epoch",
                ));
            }
            self.extension_acquisition = Some(record);
        }
        if self
            .extension_acquisition
            .as_ref()
            .is_none_or(|record| record.owner != self.cursor_owner || record.identity != identity)
        {
            return Err(unknown(
                "acknowledged extension acquisition lost its actual provenance",
            ));
        }
        Ok(())
    }
    pub(super) async fn session_metadata(
        &self,
        call: BrowserCall<'_>,
    ) -> Result<SessionMetadataCall, ToolError> {
        session_metadata_call(
            self.cursor_host.clone(),
            self.cursor_owner,
            &self.provider,
            self.cursor_epoch,
            call,
            self.extension_acquisition.iter().cloned().collect(),
        )
        .await
    }
    pub(super) async fn extension_control_diagnostic(&self) -> Option<String> {
        let identity = self.identity().ok()?;
        self.cursor_host
            .lock()
            .await
            .tabs
            .get(&identity)
            .and_then(|lease| lease.extension.as_ref())
            .and_then(|state| state.presentation_error.clone())
    }
    pub(super) async fn extension_cursor_presentation(
        &mut self,
        point: Option<[f64; 2]>,
        operation: &str,
    ) -> Result<Option<Value>, ToolError> {
        self.extension_cursor_presentation_with_arrival(point, operation, None)
            .await
    }
    pub(in crate::browser) async fn extension_cursor_presentation_with_arrival(
        &mut self,
        point: Option<[f64; 2]>,
        operation: &str,
        wait_for_arrival: Option<bool>,
    ) -> Result<Option<Value>, ToolError> {
        let Some(extension) = self.provider.extension().cloned() else {
            return Ok(None);
        };
        let capabilities = extension
            .capabilities()
            .map_err(provider::extension_error)?;
        match capabilities.cursor_presentation_owner {
            ExtensionEffectOwner::Host => return Ok(None),
            ExtensionEffectOwner::Unavailable => {
                return Err(failed(
                    "extension adapter does not provide cursor presentation",
                ));
            }
            ExtensionEffectOwner::Provider => {}
        }
        if operation != "update" {
            return if matches!(operation, "hide" | "remove" | "finalize") {
                Err(failed(
                    "extension provider cursor hiding has no acknowledged transport operation",
                ))
            } else {
                Ok(Some(json!({"providerManaged":true,"operation":operation})))
            };
        }
        let Some([x, y]) = point else {
            return Ok(Some(json!({"providerManaged":true,"operation":operation})));
        };
        let current = self.frame().await?;
        if self.frame.as_ref() != Some(&current) {
            return Err(failed(
                "stale_document: observe before showing the extension cursor",
            ));
        }
        let claim = self
            .extension_claim
            .clone()
            .ok_or_else(|| failed("extension cursor requires the current admitted claim"))?;
        let context = self
            .extension_host_operation
            .clone()
            .ok_or_else(|| failed("extension cursor requires its original Host operation"))?;
        let scope = self.cursor_host.lock().await.extension_context(
            self.cursor_owner,
            &self.provider,
            context,
            self.cursor_epoch,
            CallTarget::Tab {
                origin: Origin::UserClaimed,
                tab: Some(self.info.id.clone()),
            },
            false,
        )?;
        let shown = scope
            .dispatch(
                scope
                    .control
                    .move_mouse_presentation(&claim, x, y, wait_for_arrival),
            )
            .await;
        self.cursor_host
            .lock()
            .await
            .reconcile_provider(self.cursor_owner, &self.provider)
            .await?;
        let shown = shown.map_err(provider::extension_error)?;
        Ok(Some(
            json!({"providerManaged":true,"presentationAcknowledged":true,"point":[shown.requested_x,shown.requested_y]}),
        ))
    }
    /// Admit only an adapter whose existing attachment transport does not run
    /// content preparers. The caller has already obtained Host Metadata admission.
    pub(super) async fn attach_extension_metadata(
        &mut self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        let extension = self
            .provider
            .extension()
            .cloned()
            .ok_or_else(|| failed("extension provider required"))?;
        let host = self.cursor_host.clone();
        register(&host, self.cursor_owner, &self.provider).await?;
        let identity = self.identity()?;
        host.lock().await.extension_reserve(
            self.cursor_owner,
            &self.provider,
            invocation.turn(),
            &self.info.id,
            Origin::UserClaimed,
        )?;
        let existing = host
            .lock()
            .await
            .tabs
            .get(&identity)
            .and_then(|lease| lease.extension.as_ref())
            .and_then(|state| state.claim.clone());
        if existing.is_none()
            && extension
                .capabilities()
                .map_err(provider::extension_error)?
                .attachment_preparation
                != ExtensionAttachmentPreparation::MetadataOnly
        {
            return Err(failed(
                "selected extension attachment runs content preparation; a metadata-only attachment path has not been established",
            ));
        }
        let scope = host.lock().await.extension_context(
            self.cursor_owner,
            &self.provider,
            operation(invocation)?,
            self.cursor_epoch,
            CallTarget::Tab {
                origin: Origin::UserClaimed,
                tab: Some(self.info.id.clone()),
            },
            true,
        )?;
        check_input(cancellation)?;
        if existing.is_none()
            && (is_new_tab(&self.info.url)
                || self
                    .info
                    .extension
                    .as_ref()
                    .and_then(|tab| tab.pending_url.as_deref())
                    .is_some_and(is_new_tab))
        {
            // Only the source-recognized builtin new-tab interstitial needs
            // this normalizer. An already created about:blank is untouched.
            invocation
                .authorize_browser(
                    crate::BrowserAccess::Navigate {
                        document: self.document(),
                        url: "about:blank".into(),
                    },
                    cancellation,
                )
                .await?;
            let preparation = scope
                .authorize_preparation(
                    &host,
                    invocation,
                    crate::BrowserPreparationTarget::ReservedTab {
                        tab_id: self.info.id.clone(),
                    },
                    cancellation,
                )
                .await?;
            let raw_id = self.info.id.parse().map_err(failed)?;
            scope
                .check_preparation(&host, invocation, &preparation, cancellation)
                .await?;
            {
                let mut ledger = host.lock().await;
                check_input(cancellation)?;
                ledger.extension_preparation_current(&scope, &preparation)?;
                ledger
                    .tabs
                    .get_mut(&identity)
                    .and_then(|lease| lease.extension.as_mut())
                    .ok_or_else(|| unknown("new-tab normalization lost reserved custody"))?
                    .user_preparation = UserPreparation::Pending(scope.context.clone());
            }
            let mut entered = false;
            let prepared = scope
                .dispatch(async {
                    entered = true;
                    scope.control.prepare_user_tab(raw_id).await
                })
                .await;
            host.lock()
                .await
                .reconcile_provider(self.cursor_owner, &self.provider)
                .await?;
            let prepared = match prepared {
                Ok(prepared) => prepared,
                Err(error) => {
                    host.lock().await.extension_preparation_failed(
                        &identity,
                        &scope.context,
                        !entered || scope.control.undispatched_control(&error).is_some(),
                        &error,
                    );
                    return Err(provider::extension_error(error));
                }
            };
            if prepared.tab.id.to_string() != self.info.id
                || prepared.tab.url.as_deref() != Some("about:blank")
            {
                return Err(failed(
                    "new-tab document changed during metadata normalization",
                ));
            }
            self.info = provider::extension_tab(prepared.tab);
            self.origin_proof = None;
        }
        let newly_attached = existing.is_none();
        if newly_attached {
            host.lock()
                .await
                .tabs
                .get_mut(&identity)
                .and_then(|lease| lease.extension.as_mut())
                .ok_or_else(|| unknown("metadata attachment lost reserved custody"))?
                .metadata_attached = true;
        }
        let claim = match existing {
            Some(claim) => claim,
            None => {
                let attached = scope
                    .dispatch(
                        scope
                            .control
                            .attach_tab(self.info.id.parse().map_err(failed)?),
                    )
                    .await;
                host.lock()
                    .await
                    .reconcile_provider(self.cursor_owner, &self.provider)
                    .await?;
                attached.map_err(provider::extension_error)?;
                host.lock()
                    .await
                    .tabs
                    .get(&identity)
                    .and_then(|lease| lease.extension.as_ref())
                    .and_then(|state| state.claim.clone())
                    .ok_or_else(|| {
                        unknown("metadata attachment has not been committed to Host custody")
                    })?
            }
        };
        self.extension_claim = Some(claim);
        self.extension_wire = Some(
            cua_driver_core::browser::ExtensionWireContext::new(
                self.cursor_owner.to_string(),
                invocation.turn(),
            )
            .map_err(failed)?,
        );
        self.extension_host_operation = Some(operation(invocation)?);
        if let Some(socket) = &mut self.socket {
            socket.extension_context = self.extension_wire.clone();
        }
        check_input(cancellation)
    }

    async fn prepare_claim_extension(
        &mut self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        scope: &CallScope,
        claim: &ExtensionPhysicalClaim,
        budget: &mut Option<super::ReadBudget>,
    ) -> Result<(), ToolError> {
        if self.provider.extension().is_some_and(|extension| {
            extension.capabilities().is_ok_and(|caps| {
                caps.session_preparation == ExtensionSessionPreparation::ExplicitFixed
            })
        }) {
            let identity = self.identity()?;
            let host = self.cursor_host.clone();
            let receipt = super::read_step_for(
                budget,
                cancellation,
                super::ReadEffect::ExtensionPreparation,
                async {
                    let ledger = host.lock().await;
                    ledger
                        .tabs
                        .get(&identity)
                        .and_then(|lease| lease.extension.as_ref())
                        .and_then(|state| state.fixed_preparation.ready())
                        .map(|prepared| prepared.receipt.clone())
                        .ok_or_else(|| {
                            unknown("physical preparation lost its actual logical fixed scope")
                        })
                },
            )
            .await?;
            let request = scope
                .authorize_preparation(
                    &host,
                    invocation,
                    crate::BrowserPreparationTarget::FixedSessionTab {
                        tab_id: self.info.id.clone(),
                        scope_id: receipt.scope_id().to_owned(),
                    },
                    cancellation,
                )
                .await?;
            super::read_step_for(
                budget,
                cancellation,
                super::ReadEffect::ExtensionPreparation,
                scope.check_preparation(&host, invocation, &request, cancellation),
            )
            .await?;
            self.fixed_presentation = Some(FixedPresentationScope::capture(
                scope,
                request,
                invocation,
                cancellation,
            )?);
            // The acknowledged logical service already owns these fixed effects.
            // A later content attachment does not install a second UI realm.
            return Ok(());
        }

        let origin = super::read_step_for(
            budget,
            cancellation,
            super::ReadEffect::ExtensionPreparation,
            self.document_origin(),
        )
        .await?;
        invocation
            .authorize_browser(origin.access(), cancellation)
            .await?;
        super::read_step_for(
            budget,
            cancellation,
            super::ReadEffect::ExtensionPreparation,
            async {
                origin.check_current(self).await?;
                let services = invocation
                    .prepare_browser_services(origin.access(), cancellation)
                    .await?;
                origin.check_current(self).await?;
                let lease_children = if invocation.browser_preparation_policy().effective_popup() {
                    Some(
                services
                    .effects
                    .filter(|effects| effects.supports_lease_children())
                    .ok_or_else(|| {
                        failed("extension popup preparation requires fresh Host lease-child custody")
                    })?,
            )
                } else {
                    None
                };
                let identity = origin.document_identity();
                let document = ExtensionPreparationDocument {
                    frame_id: identity.frame_id().to_owned(),
                    loader_id: identity.loader_id().to_owned(),
                    url: identity.url().to_owned(),
                };
                let headers = preparation_headers(invocation);
                let policy = Arc::new(ExtensionPreparationPolicy {
                    popup_enabled: invocation.browser_preparation_policy().effective_popup(),
                    header_enabled: !headers.is_empty(),
                    headers,
                });
                let wire = ExtensionWireContext::new(self.cursor_owner.to_string(), invocation.turn())
                    .map_err(failed)?;
                let operation = operation(invocation)?;
                let identity = self.identity()?;
                let host = self.cursor_host.clone();
                let preparation = scope
                    .authorize_preparation(
                        &host,
                        invocation,
                        crate::BrowserPreparationTarget::ClaimedTab {
                            tab_id: self.info.id.clone(),
                            claim_id: claim.claim_id().to_owned(),
                        },
                        cancellation,
                    )
                    .await?;
                // Consent and all fallible metadata checks precede the Pending marker.
                // Once marked there is no await before polling the required mutation.
                origin.check_current(self).await?;
                scope
                    .check_preparation(&host, invocation, &preparation, cancellation)
                    .await?;
                check_input(cancellation)?;
                let attempt = {
                    let mut ledger = host.lock().await;
                    check_input(cancellation)?;
                    ledger.extension_preparation_current(scope, &preparation)?;
                    let lease = ledger
                        .tabs
                        .get_mut(&identity)
                        .ok_or_else(|| unknown("extension preparation lost reserved custody"))?;
                    if lease.creator.owner != self.cursor_owner
                        || !matches!(lease.disposition, Disposition::Live)
                    {
                        return Err(unknown(
                            "extension preparation lost its live Host source lease",
                        ));
                    }
                    let state = lease
                        .extension
                        .as_mut()
                        .ok_or_else(|| unknown("extension preparation lost physical custody"))?;
                    if state
                        .claim
                        .as_ref()
                        .is_none_or(|owned| owned.claim_id() != claim.claim_id())
                    {
                        return Err(unknown("extension preparation changed its physical claim"));
                    }
                    if let Some(effects) = lease_children {
                        state.lease_children = Some(LeaseChildScope {
                            effects,
                            turn: invocation.turn().to_owned(),
                            epoch: self.cursor_epoch,
                        });
                    }
                    let previous = match &state.claim_preparation {
                        ClaimPreparation::Pending(_) => {
                            return Err(unknown(
                                "same-claim preparation remains pending; it was not replayed",
                            ));
                        }
                        ClaimPreparation::Unknown { reason, .. } => {
                            return Err(unknown(reason));
                        }
                        ClaimPreparation::Acknowledged(ack)
                            if ack.proof.document() == &document
                                && ack.proof.wire_context() == &wire
                                && ack.policy.as_ref() == policy.as_ref()
                                && !ack.proof.is_cleanup_only() =>
                        {
                            return Ok(());
                        }
                        ClaimPreparation::Acknowledged(ack) => Some(ack.clone()),
                        ClaimPreparation::NotAttempted => None,
                    };
                    let effects = state
                        .preparation_effects
                        .begin(&wire, policy.header_enabled);
                    let attempt = Arc::new(PreparationAttempt {
                        document: document.clone(), policy: policy.clone(), wire,
                        operation: operation.clone(), previous, effects,
                    });
                    state.claim_preparation = ClaimPreparation::Pending(attempt.clone());
                    attempt
                };
                let mut entered = false;
                let prepared = scope.dispatch(async {
                    entered = true;
                    scope.control.prepare_claim(claim, &document, &policy).await
                }).await;
                let not_dispatched = !entered || prepared.as_ref().err()
                    .is_some_and(|error| scope.control.undispatched_control(error).is_some());
                let mut ledger = host.lock().await;
                match &prepared {
                    Ok(proof) => ledger.apply_claim_preparation(
                        self.cursor_owner,
                        &self.provider,
                        Some(&operation),
                        proof.clone(),
                    )?,
                    Err(_) if not_dispatched => {
                        if let Some(state) = ledger
                            .tabs
                            .get_mut(&identity)
                            .and_then(|lease| lease.extension.as_mut())
                            && matches!(&state.claim_preparation,
                                ClaimPreparation::Pending(current) if Arc::ptr_eq(current, &attempt))
                        {
                            state.finish_preparation_error(
                                Some(&operation),
                                true,
                                "extension preparation was not dispatched",
                            );
                        }
                    }
                    Err(_) => {}
                }
                ledger
                    .reconcile_provider(self.cursor_owner, &self.provider)
                    .await?;
                let lease = ledger
                    .tabs
                    .get_mut(&identity)
                    .ok_or_else(|| unknown("extension preparation result lost its lease"))?;
                let state = lease
                    .extension
                    .as_mut()
                    .ok_or_else(|| unknown("extension preparation result lost physical custody"))?;
                let active_ack = matches!(&state.claim_preparation,
            ClaimPreparation::Acknowledged(ack)
                if ack.proof.document() == &document
                    && ack.proof.wire_context().host_turn_id() == invocation.turn()
                    && ack.policy.as_ref() == policy.as_ref() && !ack.proof.is_cleanup_only());
                let result = if active_ack {
                    Ok(())
                } else {
                    match prepared {
                        Ok(_) => Err(unknown(
                            "extension preparation ACK is not active in Host custody",
                        )),
                        Err(error) => {
                            if !not_dispatched {
                                if matches!(&state.claim_preparation,
                                    ClaimPreparation::Pending(current)
                                    | ClaimPreparation::Unknown { attempt: current, .. }
                                        if Arc::ptr_eq(current, &attempt))
                                {
                                    state.finish_preparation_error(
                                        Some(&operation), false, &error.to_string(),
                                    );
                                    lease.disposition = Disposition::Closing;
                                }
                                Err(unknown(error))
                            } else {
                                Err(provider::extension_error(error))
                            }
                        }
                    }
                };
                drop(ledger);
                result?;
                check_input(cancellation)?;
                invocation
                    .browser_authorization()
                    .ok_or_else(|| {
                        failed("extension preparation requires the current Host authorization")
                    })?
                    .check(origin.access(), cancellation.clone())
                    .await?;
                origin.check_current(self).await?;
                check_input(cancellation)
            },
        )
        .await
    }

    pub(super) async fn authorize_extension_download_path(
        &mut self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        let extension = self
            .provider
            .extension()
            .cloned()
            .ok_or_else(|| failed("extension provider required"))?;
        if extension.is_closed() || extension.identity().generation != self.generation {
            return Err(failed(
                "extension download tab belongs to an old provider generation",
            ));
        }
        let acquired = self
            .extension_acquisition
            .as_ref()
            .map(Acquisition::turn)
            .ok_or_else(|| failed("extension download has no acknowledged acquisition"))?;
        let mut reclaim = acquired != invocation.turn();
        let capabilities = extension
            .capabilities()
            .map_err(provider::extension_error)?;
        if !capabilities.session_tab_resolution || (reclaim && !capabilities.session_committed_url)
        {
            return Err(failed(
                "extension adapter lacks purpose-bound session tab metadata",
            ));
        }
        let host = self.cursor_host.clone();
        register(&host, self.cursor_owner, &self.provider).await?;
        let identity = self.identity()?;
        let scope = {
            let mut ledger = host.lock().await;
            if ledger
                .reconcile_provider(self.cursor_owner, &self.provider)
                .await?
            {
                return Err(ToolError::CleanupUnconfirmed(
                    "extension provider has an unsettled mutation; download reclaim was not replayed"
                        .into(),
                ));
            }
            ledger.extension_reserve(
                self.cursor_owner,
                &self.provider,
                invocation.turn(),
                &self.info.id,
                Origin::UserClaimed,
            )?;
            ledger.restore_acquisition_order(
                self.cursor_owner,
                &identity,
                self.extension_acquisition.as_ref(),
            );
            ledger.extension_context(
                self.cursor_owner,
                &self.provider,
                operation(invocation)?,
                self.cursor_epoch,
                CallTarget::Tab {
                    origin: Origin::UserClaimed,
                    tab: Some(self.info.id.clone()),
                },
                true,
            )?
        };
        let preparation = scope
            .authorize_preparation(
                &host,
                invocation,
                crate::BrowserPreparationTarget::ReservedTab {
                    tab_id: self.info.id.clone(),
                },
                cancellation,
            )
            .await?;
        let recovered_acquisition = {
            let ledger = host.lock().await;
            ledger.extension_preparation_current(&scope, &preparation)?;
            ledger
                .tabs
                .get(&identity)
                .and_then(|lease| lease.extension.as_ref())
                .and_then(|state| state.user_prepared_operation.as_ref())
                .is_some_and(|receipt| {
                    matches!(receipt,
                    PreparedOperation::Acquired { operation, epoch }
                        if operation.turn_id == invocation.turn() && *epoch == self.cursor_epoch)
                })
        };
        if recovered_acquisition {
            // Adopt the actual late ACK folded by reconcile, without replaying
            // its already completed acquisition or treating metadata as proof.
            self.capture_acquisition().await?;
            reclaim = false;
        }
        if reclaim {
            // This observation may activate the extension logical session. Its
            // bounded preparation admission is not a document or Site grant.
            scope
                .check_preparation(&host, invocation, &preparation, cancellation)
                .await?;
            let url = scope
                .dispatch(scope.control.committed_session_tab_url(&self.info.id))
                .await;
            let url = self.session_path_result(&host, url).await?;
            if !is_new_tab(url.as_str()) {
                validate_url(url.as_str())?;
            }
            let raw_id = self.info.id.parse().map_err(failed)?;
            scope
                .check_preparation(&host, invocation, &preparation, cancellation)
                .await?;
            if capabilities.session_preparation == ExtensionSessionPreparation::ExplicitFixed {
                let cursor = fixed_cursor_spec(&self.cursor_spec)?;
                if invocation.browser_preparation_policy().effective_popup()
                    && invocation
                        .browser_host_effects()
                        .is_none_or(|effects| !effects.supports_lease_children())
                {
                    return Err(failed(
                        "fixed popup relay requires actual Host lease-child support",
                    ));
                }
                let prepared =
                    prepare_fixed_tab(&scope, &host, invocation, cancellation, raw_id, &cursor)
                        .await?;
                let request = scope
                    .authorize_preparation(
                        &host,
                        invocation,
                        crate::BrowserPreparationTarget::FixedSessionTab {
                            tab_id: self.info.id.clone(),
                            scope_id: prepared.receipt.scope_id().to_owned(),
                        },
                        cancellation,
                    )
                    .await?;
                self.fixed_presentation = Some(FixedPresentationScope::capture(
                    &scope,
                    request.clone(),
                    invocation,
                    cancellation,
                )?);
                host.lock()
                    .await
                    .retain_fixed_services(&scope, &prepared, &cursor, invocation, &request)?;
                self.capture_acquisition().await?;
                self.origin_proof = None;
            } else if capabilities.session_preparation
                == ExtensionSessionPreparation::ProviderSession
            {
                {
                    let mut ledger = host.lock().await;
                    check_input(cancellation)?;
                    ledger.extension_preparation_current(&scope, &preparation)?;
                    let state = ledger
                        .tabs
                        .get_mut(&identity)
                        .and_then(|lease| lease.extension.as_mut())
                        .ok_or_else(|| unknown("extension reclaim lost its reserved custody"))?;
                    match &state.user_preparation {
                        UserPreparation::Pending(_) => {
                            return Err(ToolError::CleanupUnconfirmed(
                                "extension reclaim remains unsettled; it was not replayed".into(),
                            ));
                        }
                        UserPreparation::Unknown(reason) => return Err(unknown(reason)),
                        UserPreparation::NotAttempted | UserPreparation::Completed => {}
                    }
                    state.user_preparation = UserPreparation::Pending(scope.context.clone());
                }
                let mut entered = false;
                let prepared = scope
                    .dispatch(async {
                        entered = true;
                        scope.control.prepare_session_tab(raw_id).await
                    })
                    .await;
                host.lock()
                    .await
                    .reconcile_provider(self.cursor_owner, &self.provider)
                    .await?;
                match prepared {
                    Ok(prepared) => {
                        if prepared.tab.id.to_string() != self.info.id {
                            return Err(unknown(
                                "extension reclaim ACK changed its reserved target",
                            ));
                        }
                        // The receipt is acquisition history only. Its tab snapshot
                        // may precede extension hooks; read current metadata separately.
                        self.capture_acquisition().await?;
                        self.origin_proof = None;
                        if let Some(state) = host
                            .lock()
                            .await
                            .extension
                            .get_mut(&(self.cursor_owner, identity.browser.clone()))
                        {
                            state.logical_active = Some(self.info.id.clone());
                        }
                    }
                    Err(error) => {
                        host.lock().await.extension_preparation_failed(
                            &identity,
                            &scope.context,
                            !entered || scope.control.undispatched_control(&error).is_some(),
                            &error,
                        );
                        return Err(provider::extension_error(error));
                    }
                }
            } else {
                return Err(failed(
                    "extension download reclaim requires actual logical full preparation",
                ));
            }
        }
        self.refresh_download_session(&host, &scope, &preparation, invocation, cancellation)
            .await?;
        let source = self
            .authorize_download_source(invocation, cancellation)
            .await?;
        self.refresh_download_session(&host, &scope, &preparation, invocation, cancellation)
            .await?;
        self.check_download_source(&source, invocation, cancellation)
            .await
    }

    async fn session_path_result<T>(
        &self,
        host: &Arc<tokio::sync::Mutex<Host>>,
        result: Result<T, Box<cua_driver_core::browser::ExtensionProviderError>>,
    ) -> Result<T, ToolError> {
        if let Err(cua_driver_core::browser::ExtensionProviderError::OutcomeUnknown { .. }) =
            result.as_ref().map_err(|error| error.as_ref())
            && let Some(state) = host
                .lock()
                .await
                .tabs
                .get_mut(&self.identity()?)
                .and_then(|lease| lease.extension.as_mut())
        {
            // A nonretained metadata transaction may still activate the
            // ChatGPT session. Preserve its independent sticky uncertainty.
            state.unknown =
                Some("extension session metadata activation has an unknown outcome".into());
        }
        result.map_err(provider::extension_error)
    }

    async fn refresh_download_session(
        &mut self,
        host: &Arc<tokio::sync::Mutex<Host>>,
        scope: &CallScope,
        preparation: &crate::BrowserSessionPreparation,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        scope
            .check_preparation(host, invocation, preparation, cancellation)
            .await?;
        let observed = scope
            .dispatch(scope.control.resolve_session_tab(&self.info.id))
            .await;
        let observed = self.session_path_result(host, observed).await?;
        // A filtered/missing session inventory result is not proof that the
        // physical tab closed, and never triggers a global inventory fallback.
        if observed.id.to_string() != self.info.id {
            return Err(unknown(
                "extension session metadata changed its issued target",
            ));
        }
        scope
            .check_preparation(host, invocation, preparation, cancellation)
            .await?;
        self.info = provider::extension_tab(observed);
        Ok(())
    }

    /// Acquire extension logical preparation under its bounded Host purpose.
    /// Content attachment and focus retain their separate current admission.
    pub(super) async fn prepare_extension_session(
        &mut self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
        intent: ClaimIntent,
    ) -> Result<(), ToolError> {
        let Some(extension) = self.provider.extension().cloned() else {
            return Ok(());
        };
        let host = self.cursor_host.clone();
        register(&host, self.cursor_owner, &self.provider).await?;
        let identity = self.identity()?;
        let context = operation(invocation)?;
        let scope = {
            let mut ledger = host.lock().await;
            ledger.extension_reserve(
                self.cursor_owner,
                &self.provider,
                invocation.turn(),
                &self.info.id,
                Origin::UserClaimed,
            )?;
            ledger.restore_acquisition_order(
                self.cursor_owner,
                &identity,
                self.extension_acquisition.as_ref(),
            );
            ledger.extension_context(
                self.cursor_owner,
                &self.provider,
                context.clone(),
                self.cursor_epoch,
                CallTarget::Tab {
                    origin: Origin::UserClaimed,
                    tab: Some(self.info.id.clone()),
                },
                true,
            )?
        };
        let preparation = scope
            .authorize_preparation(
                &host,
                invocation,
                crate::BrowserPreparationTarget::ReservedTab {
                    tab_id: self.info.id.clone(),
                },
                cancellation,
            )
            .await?;
        // Keep the actual operation's Host custody alive while acquiring the
        // transport. Content controllers retain their separately admitted scope.
        let _effects = invocation
            .browser_host_effects()
            .ok_or_else(|| failed("extension session preparation requires Host effect custody"))?;
        let _settlement = invocation.operation_settlement().ok_or_else(|| {
            failed("extension session preparation requires Host settlement custody")
        })?;
        let capabilities = extension
            .capabilities()
            .map_err(provider::extension_error)?;
        match capabilities.session_preparation {
            ExtensionSessionPreparation::ProviderSession => {
                self.fixed_presentation = None;
            }
            ExtensionSessionPreparation::ExplicitFixed => {
                let cursor = fixed_cursor_spec(&self.cursor_spec)?;
                let raw_id = cua_driver_core::browser::parse_browser_tab_id(&self.info.id)
                    .ok_or_else(|| failed("extension tab has an invalid raw ID"))?;
                if invocation.browser_preparation_policy().effective_popup()
                    && invocation
                        .browser_host_effects()
                        .is_none_or(|effects| !effects.supports_lease_children())
                {
                    return Err(failed(
                        "fixed popup relay requires actual Host lease-child support",
                    ));
                }
                let fixed =
                    prepare_fixed_tab(&scope, &host, invocation, cancellation, raw_id, &cursor)
                        .await?;
                let request = scope
                    .authorize_preparation(
                        &host,
                        invocation,
                        crate::BrowserPreparationTarget::FixedSessionTab {
                            tab_id: self.info.id.clone(),
                            scope_id: fixed.receipt.scope_id().to_owned(),
                        },
                        cancellation,
                    )
                    .await?;
                self.fixed_presentation = Some(FixedPresentationScope::capture(
                    &scope,
                    request.clone(),
                    invocation,
                    cancellation,
                )?);
                host.lock()
                    .await
                    .retain_fixed_services(&scope, &fixed, &cursor, invocation, &request)?;
            }
            _ => {
                return Err(failed(
                    "extension adapter does not implement full logical session preparation",
                ));
            }
        }
        let prior = host
            .lock()
            .await
            .tabs
            .get(&identity)
            .and_then(|lease| lease.extension.clone())
            .ok_or_else(|| failed("extension claim reservation missing"))?;
        let already_prepared = prior.session_prepared_operation.as_ref() == Some(&context);
        let headers = preparation_headers(invocation);
        if capabilities.session_preparation == ExtensionSessionPreparation::ProviderSession
            && !already_prepared
            && !capabilities.explicit_claim_preparation
            && capabilities.header_scope == ExtensionHeaderPolicyScope::Session
            && !headers.is_empty()
        {
            let active = host
                .lock()
                .await
                .extension
                .get(&(self.cursor_owner, identity.browser.clone()))
                .and_then(|state| state.session_headers.as_ref())
                .is_some_and(|proof| {
                    proof.active && proof.state_confirmed && proof.host_turn_id == invocation.turn()
                });
            if !active {
                scope
                    .check_preparation(&host, invocation, &preparation, cancellation)
                    .await?;
                let applied = scope
                    .dispatch(scope.control.set_session_headers(&headers))
                    .await;
                host.lock()
                    .await
                    .reconcile_provider(self.cursor_owner, &self.provider)
                    .await?;
                applied.map_err(provider::extension_error)?;
            }
        }
        let user_prepared = matches!(prior.user_prepared_operation.as_ref(),
            Some(PreparedOperation::Acquired { operation, .. }) if operation == &context);
        let acquired = matches!(
            prior.user_prepared_operation,
            Some(PreparedOperation::Acquired { .. })
        ) || prior
            .creation
            .as_ref()
            .is_some_and(|proof| !proof.is_cleanup_only());
        let needs_user_preparation =
            !already_prepared && !user_prepared && (!acquired || intent == ClaimIntent::Explicit);
        let changes_logical_active =
            prior.metadata_attached || prior.claim.is_none() || needs_user_preparation;
        if needs_user_preparation
            && capabilities.session_preparation == ExtensionSessionPreparation::ProviderSession
        {
            match &prior.user_preparation {
                UserPreparation::Pending(_) => {
                    return Err(ToolError::CleanupUnconfirmed(
                        "extension user-tab preparation remains unsettled; it was not replayed"
                            .into(),
                    ));
                }
                UserPreparation::Unknown(reason) => return Err(unknown(reason)),
                UserPreparation::NotAttempted | UserPreparation::Completed => {}
            }
            let raw_id = self.info.id.parse().map_err(failed)?;
            scope
                .check_preparation(&host, invocation, &preparation, cancellation)
                .await?;
            {
                let mut ledger = host.lock().await;
                check_input(cancellation)?;
                ledger.extension_preparation_current(&scope, &preparation)?;
                ledger
                    .tabs
                    .get_mut(&identity)
                    .and_then(|lease| lease.extension.as_mut())
                    .ok_or_else(|| unknown("extension preparation lost reserved custody"))?
                    .user_preparation = UserPreparation::Pending(scope.context.clone());
            }
            let mut entered = false;
            let prepared = scope
                .dispatch(async {
                    entered = true;
                    scope.control.prepare_session_tab(raw_id).await
                })
                .await;
            host.lock()
                .await
                .reconcile_provider(self.cursor_owner, &self.provider)
                .await?;
            match prepared {
                Ok(prepared) => {
                    if prepared.tab.id.to_string() != self.info.id {
                        return Err(unknown("extension preparation changed its reserved tab"));
                    }
                    self.info = provider::extension_tab(prepared.tab);
                    self.origin_proof = None;
                }
                Err(error) => {
                    host.lock().await.extension_preparation_failed(
                        &identity,
                        &scope.context,
                        !entered || scope.control.undispatched_control(&error).is_some(),
                        &error,
                    );
                    return Err(provider::extension_error(error));
                }
            }
        }
        let mut claim = host
            .lock()
            .await
            .tabs
            .get(&identity)
            .and_then(|lease| lease.extension.as_ref())
            .and_then(|state| state.claim.clone());
        if claim.is_none() {
            let raw_id = self.info.id.parse().map_err(failed)?;
            scope
                .check_preparation(&host, invocation, &preparation, cancellation)
                .await?;
            let attached = scope.dispatch(scope.control.attach_tab(raw_id)).await;
            host.lock()
                .await
                .reconcile_provider(self.cursor_owner, &self.provider)
                .await?;
            attached.map_err(provider::extension_error)?;
            claim = host
                .lock()
                .await
                .tabs
                .get(&identity)
                .and_then(|lease| lease.extension.as_ref())
                .and_then(|state| state.claim.clone());
        }
        let claim = claim.ok_or_else(|| {
            unknown("extension attachment has not been committed to Host custody")
        })?;
        if claim.is_cleanup_only()
            || claim.tab_id().to_string() != self.info.id
            || claim.generation() != self.generation
        {
            return Err(unknown(
                "extension attachment has no current executable claim",
            ));
        }
        let preparation = scope
            .authorize_preparation(
                &host,
                invocation,
                crate::BrowserPreparationTarget::ClaimedTab {
                    tab_id: self.info.id.clone(),
                    claim_id: claim.claim_id().to_owned(),
                },
                cancellation,
            )
            .await?;
        let transport =
            scope.transport_preparation(&host, invocation, &claim, &preparation, cancellation)?;
        self.extension_claim = Some(claim);
        self.extension_wire = Some(
            ExtensionWireContext::new(self.cursor_owner.to_string(), invocation.turn())
                .map_err(failed)?,
        );
        self.extension_host_operation = Some(context.clone());
        self.capture_acquisition().await?;
        if let Some(socket) = &mut self.socket {
            socket.extension_context = self.extension_wire.clone();
        }
        {
            let mut ledger = host.lock().await;
            ledger.extension_preparation_current(&scope, &preparation)?;
            let state = ledger
                .tabs
                .get_mut(&identity)
                .and_then(|lease| lease.extension.as_mut())
                .ok_or_else(|| unknown("extension preparation lost its known receipt"))?;
            state.session_prepared_operation = Some(context);
            if changes_logical_active
                && let Some(state) = ledger
                    .extension
                    .get_mut(&(self.cursor_owner, identity.browser))
            {
                state.logical_active = Some(self.info.id.clone());
            }
        }
        // The persistent transport does not retain a CallScope/issuing permit.
        // Each raw call captures its own permit after its current Host check.
        self.capture_acquisition().await?;
        drop(scope);
        self.refresh_info(BrowserCall::new(invocation, cancellation, language))
            .await?;
        self.connect_metadata().await?;
        self.socket
            .as_mut()
            .ok_or_else(|| failed("extension metadata channel is unavailable"))?
            .preparation = transport;
        check_input(cancellation)
    }

    pub(super) async fn prepare_extension_with_budget(
        &mut self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
        intent: ClaimIntent,
        budget: &mut Option<super::ReadBudget>,
    ) -> Result<(), ToolError> {
        super::read_step_for(
            budget,
            cancellation,
            super::ReadEffect::ExtensionPreparation,
            self.prepare_extension_session(invocation, cancellation, language, intent),
        )
        .await?;
        let Some(extension) = self.provider.extension().cloned() else {
            return Ok(());
        };
        let actual_origin = super::read_step_for(
            budget,
            cancellation,
            super::ReadEffect::ExtensionPreparation,
            self.document_origin(),
        )
        .await?;
        invocation
            .authorize_browser(actual_origin.access(), cancellation)
            .await?;
        super::read_step_for(
            budget,
            cancellation,
            super::ReadEffect::ExtensionPreparation,
            actual_origin.check_current(self),
        )
        .await?;
        let services = super::read_step_for(
            budget,
            cancellation,
            super::ReadEffect::ExtensionPreparation,
            invocation.prepare_browser_services(actual_origin.access(), cancellation),
        )
        .await?;
        super::read_step_for(
            budget,
            cancellation,
            super::ReadEffect::ExtensionPreparation,
            actual_origin.check_current(self),
        )
        .await?;
        let (host, identity, scope, claim, capabilities) = super::read_step_for(
            budget,
            cancellation,
            super::ReadEffect::ExtensionPreparation,
            async {
                self.clipboard_authorization = services.attachment;
                self.dialog_host = services.effects;
                self.attachment_settlement = services.settlement;
                if let Some(bridge) = &self.clipboard {
                    bridge.update(
                        self.clipboard_authorization.clone(),
                        self.dialog_host.clone(),
                    );
                }
                if let Some(controller) = &self.dialogs {
                    controller.host_effects(self.dialog_host.clone());
                }
                let host = self.cursor_host.clone();
                let identity = self.identity()?;
                let scope = host.lock().await.extension_context(
                    self.cursor_owner,
                    &self.provider,
                    operation(invocation)?,
                    self.cursor_epoch,
                    CallTarget::Tab {
                        origin: Origin::UserClaimed,
                        tab: Some(self.info.id.clone()),
                    },
                    true,
                )?;
                let claim = self.extension_claim.clone().ok_or_else(|| {
                    unknown("extension content preparation lost its physical claim")
                })?;
                let capabilities = extension
                    .capabilities()
                    .map_err(provider::extension_error)?;
                Ok((host, identity, scope, claim, capabilities))
            },
        )
        .await?;
        if capabilities.explicit_claim_preparation {
            self.prepare_claim_extension(invocation, cancellation, &scope, &claim, budget)
                .await?;
        }
        super::read_step_for(
            budget,
            cancellation,
            super::ReadEffect::ExtensionPreparation,
            async {
                let headers = preparation_headers(invocation);
                if !capabilities.explicit_claim_preparation
                    && capabilities.header_scope == ExtensionHeaderPolicyScope::Claim
                    && !headers.is_empty()
                {
                    let active = host
                        .lock()
                        .await
                        .tabs
                        .get(&identity)
                        .and_then(|lease| lease.extension.as_ref())
                        .is_some_and(|state| state.headers_active);
                    if !active {
                        let preparation = scope
                            .authorize_preparation(
                                &host,
                                invocation,
                                crate::BrowserPreparationTarget::ClaimedTab {
                                    tab_id: self.info.id.clone(),
                                    claim_id: claim.claim_id().to_owned(),
                                },
                                cancellation,
                            )
                            .await?;
                        scope
                            .check_preparation(&host, invocation, &preparation, cancellation)
                            .await?;
                        let applied = scope
                            .dispatch(scope.control.set_scoped_headers(
                                &claim,
                                &self.cursor_owner.to_string(),
                                Some(&headers),
                            ))
                            .await;
                        host.lock()
                            .await
                            .reconcile_provider(self.cursor_owner, &self.provider)
                            .await?;
                        applied.map_err(provider::extension_error)?;
                    }
                }
                self.verify(BrowserCall::new(invocation, cancellation, language))
                    .await?;
                actual_origin.check_current(self).await?;
                let authorization = self.clipboard_authorization.clone().ok_or_else(|| {
                    failed("extension browser lost its current attachment authorization")
                })?;
                let effects = self
                    .dialog_host
                    .clone()
                    .ok_or_else(|| failed("extension browser lost Host effect custody"))?;
                let before = self.frame().await?;
                let readiness = host
                    .lock()
                    .await
                    .tabs
                    .get(&identity)
                    .and_then(|lease| lease.extension.as_ref())
                    .ok_or_else(|| unknown("focus readiness lost custody"))?
                    .focus_readiness
                    .clone();
                match readiness {
                    FocusReadiness::Pending => {
                        return Err(ToolError::CleanupUnconfirmed(
                            "the same physical claim has an unsettled focus-readiness request"
                                .into(),
                        ));
                    }
                    FocusReadiness::Unknown(reason) => return Err(unknown(reason)),
                    FocusReadiness::Completed => {}
                    FocusReadiness::NotAttempted => {
                        // Record before polling the required call. Cancellation or a
                        // lost reply cannot cause this setter to be replayed on the
                        // same physical attachment.
                        host.lock()
                            .await
                            .tabs
                            .get_mut(&identity)
                            .and_then(|lease| lease.extension.as_mut())
                            .ok_or_else(|| unknown("focus readiness lost its claim"))?
                            .focus_readiness = FocusReadiness::Pending;
                        let focus = self
                            .request(
                                "Emulation.setFocusEmulationEnabled",
                                json!({"enabled":true}),
                            )
                            .await;
                        match focus {
                            Ok(_) => {
                                host.lock()
                                    .await
                                    .tabs
                                    .get_mut(&identity)
                                    .and_then(|lease| lease.extension.as_mut())
                                    .ok_or_else(|| unknown("focus result lost its claim"))?
                                    .focus_readiness = FocusReadiness::Completed;
                            }
                            Err(ToolError::Failed(message)) => {
                                host.lock()
                                    .await
                                    .tabs
                                    .get_mut(&identity)
                                    .and_then(|lease| lease.extension.as_mut())
                                    .ok_or_else(|| unknown("focus result lost its claim"))?
                                    .focus_readiness = FocusReadiness::Completed;
                                if message.to_ascii_lowercase().contains("deadline")
                                    || message.to_ascii_lowercase().contains("timed out")
                                {
                                    return Err(ToolError::Failed(message));
                                }
                            }
                            Err(error) => {
                                let mut ledger = host.lock().await;
                                if let Some(lease) = ledger.tabs.get_mut(&identity) {
                                    if let Some(state) = &mut lease.extension {
                                        state.focus_readiness =
                                            FocusReadiness::Unknown(error.to_string());
                                        state.unknown = Some(error.to_string());
                                    }
                                    lease.disposition = Disposition::Closing;
                                }
                                return Err(error);
                            }
                        }
                    }
                }
                if self.frame().await? != before {
                    return Err(failed(
                        "document changed while extension focus was prepared",
                    ));
                }
                check_input(cancellation)?;
                self.frame = Some(before.clone());
                host.lock()
                    .await
                    .tabs
                    .get_mut(&identity)
                    .and_then(|lease| lease.extension.as_mut())
                    .ok_or_else(|| unknown("extension content preparation lost its claim"))?
                    .metadata_attached = false;
                if capabilities.cursor_presentation_owner == ExtensionEffectOwner::Provider {
                    // The provider already owns the claim's overlay/lifecycle. Keep the
                    // Host admission and frame proof without installing another renderer.
                    return Ok(());
                }
                let cursor = self
                    .cursor_spec
                    .as_ref()
                    .map(|cursor| cursor.lock().unwrap().clone())
                    .unwrap_or_default();
                self.draw_cursor(&cursor, None, "idle", "control", language)
                    .await?;
                let tree = self.request("Page.getFrameTree", json!({})).await?;
                let frame = &tree["frameTree"]["frame"];
                let actual = format!(
                    "{}:{}",
                    frame["id"].as_str().unwrap_or_default(),
                    frame["loaderId"].as_str().unwrap_or_default()
                );
                if actual != before {
                    return Err(failed(
                        "extension overlay document changed during preparation",
                    ));
                }
                actual_origin.check_current(self).await?;
                let origin = actual_origin.origin();
                let mut ledger = host.lock().await;
                let endpoint = ledger
                    .cursor_scopes
                    .get(&(self.cursor_owner, identity.clone()))
                    .cloned()
                    .ok_or_else(|| {
                        unknown("extension overlay cleanup endpoint was not retained")
                    })?;
                let state = ledger
                    .tabs
                    .get_mut(&identity)
                    .and_then(|lease| lease.extension.as_mut())
                    .ok_or_else(|| unknown("extension custody disappeared during preparation"))?;
                if state.revoked {
                    return Err(failed(
                        "extension browser control was revoked while preparing",
                    ));
                }
                state.overlay = Some(OverlayScope {
                    endpoint,
                    authorization,
                    effects,
                    cursor,
                    turn: invocation.turn().into(),
                    epoch: self.cursor_epoch,
                    origin,
                    provider: self.provider.clone(),
                    context: operation(invocation)?,
                });
                Ok(())
            },
        )
        .await
    }
    pub(super) async fn admit_extension_close(
        &self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
    ) -> Result<Option<ExtensionCloseAdmission>, ToolError> {
        if self.provider.extension().is_none() {
            return Ok(None);
        }
        check_input(cancellation)?;
        let identity = self.identity()?;
        let claim = self
            .extension_claim
            .clone()
            .ok_or_else(|| failed("extension close requires a current owned claim"))?;
        let context = operation(invocation)?;
        if self.extension_host_operation.as_ref() != Some(&context) {
            return Err(failed(
                "extension close lacks its current admitted Host operation",
            ));
        }
        let host = self.cursor_host.clone();
        let scope = host.lock().await.extension_context(
            self.cursor_owner,
            &self.provider,
            context,
            self.cursor_epoch,
            CallTarget::Tab {
                origin: Origin::UserClaimed,
                tab: Some(self.info.id.clone()),
            },
            false,
        )?;
        let request = scope
            .authorize_preparation(
                &host,
                invocation,
                crate::BrowserPreparationTarget::ClaimedTab {
                    tab_id: self.info.id.clone(),
                    claim_id: claim.claim_id().to_owned(),
                },
                cancellation,
            )
            .await?;
        scope
            .check_preparation(&host, invocation, &request, cancellation)
            .await?;
        if host.lock().await.fixed_cleanup_protected(
            self.cursor_owner,
            &identity,
            &FixedCleanupPurpose::Turn {
                turn: invocation.turn().to_owned(),
            },
        )? {
            return Err(ToolError::CleanupUnconfirmed(
                "extension close preserves a newer actual fixed UI turn".into(),
            ));
        }
        Ok(Some(ExtensionCloseAdmission {
            scope,
            claim,
            identity,
            request,
        }))
    }

    pub(super) async fn close_extension_tab(
        &mut self,
        invocation: &crate::InvocationContext<'_>,
        admission: ExtensionCloseAdmission,
    ) -> Result<(), ToolError> {
        let ExtensionCloseAdmission {
            scope,
            claim,
            identity,
            request,
        } = admission;
        let extension = self
            .provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?
            .clone();
        if scope.context != operation(invocation)?
            || scope.owner != self.cursor_owner
            || scope.epoch != self.cursor_epoch
            || scope.provider != self.provider
            || identity != self.identity()?
            || claim.is_cleanup_only()
            || claim.generation() != self.generation
            || self.extension_claim.as_ref().is_none_or(|current| {
                current.claim_id() != claim.claim_id()
                    || current.tab_id() != claim.tab_id()
                    || current.target_id() != claim.target_id()
                    || current.completion_id() != claim.completion_id()
            })
        {
            return Err(unknown(
                "extension close changed its issued source operation or claim",
            ));
        }
        request.check_scope(invocation.turn(), &scope.context.operation_id)?;
        {
            let ledger = self.cursor_host.lock().await;
            let lease = ledger
                .tabs
                .get(&identity)
                .ok_or_else(|| unknown("extension close lost its admitted cleanup lease"))?;
            if lease.creator.owner != scope.owner
                || lease.creator.provider != scope.provider
                || lease.creator.generation != claim.generation()
                || lease.creator.turn != scope.context.turn_id
                || !matches!(lease.disposition, Disposition::Closing)
                || lease
                    .extension
                    .as_ref()
                    .and_then(|state| state.claim.as_ref())
                    .is_none_or(|current| {
                        current.claim_id() != claim.claim_id()
                            || current.target_id() != claim.target_id()
                            || current.completion_id() != claim.completion_id()
                    })
            {
                return Err(unknown(
                    "extension close lost its exact issued cleanup custody",
                ));
            }
        }
        // The caller entered Closing only after the one-use live admission.
        // This is cleanup of that issued operation, not another grant/replay.
        let header_liability = self
            .cursor_host
            .lock()
            .await
            .tabs
            .get(&identity)
            .and_then(|lease| lease.extension.as_ref())
            .is_some_and(|state| state.preparation_effects.headers_may_exist);
        if header_liability {
            // A physical close ACK is not the scoped-header cleanup receipt.
            let cleared = scope
                .dispatch(scope.control.clear_scoped_headers(&claim))
                .await;
            self.cursor_host
                .lock()
                .await
                .reconcile_provider(self.cursor_owner, &self.provider)
                .await?;
            if !cleared
                .map_err(provider::extension_error)?
                .cleanup_confirmed
            {
                return Err(ToolError::CleanupUnconfirmed(
                    "extension preparation header cleanup remains unconfirmed before close".into(),
                ));
            }
        }
        if extension
            .capabilities()
            .map_err(provider::extension_error)?
            .cursor_presentation_owner
            == ExtensionEffectOwner::Host
            || self
                .cursor_host
                .lock()
                .await
                .tabs
                .get(&identity)
                .and_then(|lease| lease.extension.as_ref())
                .is_some_and(|state| {
                    !matches!(state.fixed_preparation, FixedPreparation::NotAttempted)
                })
        {
            self.cursor_host
                .lock()
                .await
                .cleanup_extension_control(
                    self.cursor_owner,
                    &identity,
                    FixedCleanupPurpose::Turn {
                        turn: invocation.turn().to_owned(),
                    },
                )
                .await?;
        }
        let drain = scope
            .dispatch_retirement(
                scope
                    .control
                    .wait_claim_cdp_drained(&claim, Duration::from_secs(10)),
            )
            .await
            .map_err(provider::extension_error)?;
        {
            let mut ledger = self.cursor_host.lock().await;
            ledger
                .tabs
                .get_mut(&identity)
                .and_then(|lease| lease.extension.as_mut())
                .ok_or_else(|| unknown("extension close drain lost its exact claim"))?
                .cdp_drain = Some(drain);
            if ledger
                .reconcile_provider(self.cursor_owner, &self.provider)
                .await?
            {
                return Err(ToolError::CleanupUnconfirmed(
                    "extension CDP settled but retained close custody is still pending".into(),
                ));
            }
            let state = ledger
                .tabs
                .get(&identity)
                .and_then(|lease| lease.extension.as_ref())
                .ok_or_else(|| unknown("extension close lost its exact claim custody"))?;
            if !state.closed {
                ledger.begin_extension_cleanup(&identity)?;
            }
        }
        let already_closed = self
            .cursor_host
            .lock()
            .await
            .tabs
            .get(&identity)
            .and_then(|lease| lease.extension.as_ref())
            .is_some_and(|state| state.closed);
        if !already_closed {
            let closed = scope.dispatch(scope.control.close_tab(&claim)).await;
            self.cursor_host
                .lock()
                .await
                .reconcile_provider(self.cursor_owner, &self.provider)
                .await?;
            closed.map_err(provider::extension_error)?;
        }
        {
            let mut ledger = self.cursor_host.lock().await;
            ledger
                .retire_extension_cleanup(
                    self.cursor_owner,
                    &self.provider,
                    &identity,
                    &scope.control,
                )
                .await?;
            if ledger
                .tabs
                .get(&identity)
                .and_then(|lease| lease.extension.as_ref())
                .is_some_and(|state| !state.fixed_preparation.settled())
            {
                return Err(ToolError::CleanupUnconfirmed(
                    "physical close cannot erase retained logical fixed uncertainty".into(),
                ));
            }
            ledger.tabs.remove(&identity);
        }
        self.extension_claim = None;
        drop(extension);
        Ok(())
    }
}

async fn refresh_control(
    host: &Arc<tokio::sync::Mutex<Host>>,
    owner: uuid::Uuid,
    browser: &BrowserIdentity,
    tab_id: u64,
    active: bool,
) -> Result<(), ToolError> {
    let identity = browser.tab(&tab_id.to_string());
    let (overlay, creation) = {
        let ledger = host.lock().await;
        let Some(lease) = ledger.tabs.get(&identity) else {
            return Ok(());
        };
        if lease.creator.owner != owner || !matches!(lease.disposition, Disposition::Live) {
            return Ok(());
        }
        let Some(state) = &lease.extension else {
            return Ok(());
        };
        if !matches!(state.fixed_preparation, FixedPreparation::NotAttempted) {
            // The extension service owns activation/navigation UI refresh for
            // its exact logical scope; an old input view grants no new UI call.
            return Ok(());
        }
        let Some(overlay) = state.overlay.clone() else {
            return Ok(());
        };
        if state.revoked || lease.creator.turn != overlay.turn {
            return Ok(());
        }
        (overlay, state.creation.clone())
    };
    let effects = overlay.effects.clone();
    let failed_host = Arc::downgrade(host);
    let worker_host = Arc::downgrade(host);
    let failed_identity = identity.clone();
    effects.spawn_guarded(
        Box::pin(async move {
            let Some(host) = worker_host.upgrade() else {
                return Err(failed("extension overlay owner closed"));
            };
            match &overlay.origin {
                crate::BrowserAttachmentOrigin::Site(_) => {
                    overlay
                        .authorization
                        .check(overlay.origin.clone(), CancellationToken::new())
                        .await?
                }
                crate::BrowserAttachmentOrigin::Opaque => {
                    overlay
                        .authorization
                        .check_metadata(CancellationToken::new())
                        .await?
                }
            }
            {
                let ledger = host.lock().await;
                let valid = ledger.tabs.get(&identity).is_some_and(|lease| {
                    lease.creator.owner == owner
                        && lease.creator.turn == overlay.turn
                        && matches!(lease.disposition, Disposition::Live)
                        && lease
                            .extension
                            .as_ref()
                            .and_then(|state| state.overlay.as_ref())
                            .is_some_and(|current| current.epoch == overlay.epoch)
                });
                if !valid {
                    return Err(failed("extension overlay attachment expired"));
                }
            }
            let mut endpoint = overlay.endpoint;
            endpoint
                .extension_control(
                    &overlay.cursor,
                    &owner.to_string(),
                    &overlay.turn,
                    true,
                    active,
                )
                .await?;
            if active && let Some(creation) = creation {
                let scope = host.lock().await.extension_context(
                    owner,
                    &overlay.provider,
                    overlay.context.clone(),
                    overlay.epoch,
                    CallTarget::Tab {
                        origin: Origin::AgentCreated,
                        tab: Some(identity.target.clone()),
                    },
                    false,
                )?;
                scope
                    .dispatch(scope.control.unmute_created_tab_if_active(&creation))
                    .await
                    .map_err(provider::extension_error)?;
                host.lock()
                    .await
                    .reconcile_provider(owner, &overlay.provider)
                    .await?;
            }
            Ok(())
        }),
        Box::new(move |error| {
            if let Some(host) = failed_host.upgrade()
                && let Ok(mut ledger) = host.try_lock()
                && let Some(lease) = ledger.tabs.get_mut(&failed_identity)
                && let Some(state) = &mut lease.extension
            {
                state.presentation_error =
                    Some(format!("extension overlay admission refused: {error}"));
            }
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(id: u64, extra: Value) -> cua_driver_core::browser::ExtensionTabInfo {
        let mut row = json!({"id":id});
        for (key, value) in extra.as_object().unwrap() {
            row[key] = value.clone();
        }
        serde_json::from_value(row).unwrap()
    }
    #[test]
    fn managed_metadata_omits_user_inventory_only_fields() {
        let tab = row(
            17,
            json!({"title":"Observed title","url":"https://fixture.test/","providerTabId":"actual-provider-id","lastOpened":"observed-date","groupTitle":"Observed group"}),
        );
        assert_eq!(
            managed_tab_info(&tab),
            json!({"id":"17","titleJson":"\"Observed title\"","url":"https://fixture.test/","providerTabId":"actual-provider-id"})
        );
        assert_eq!(managed_tab_info(&row(18, json!({}))), json!({"id":"18"}));
        assert!(is_internal_url("chrome://settings"));
        assert!(!is_internal_url("chrome-extension://fixture/welcome.html"));
    }

    #[test]
    fn provider_projected_order_and_optional_metadata_remain_observed() {
        let rows = ordered_user_tabs(
            vec![
                row(
                    9,
                    json!({"lastOpened":"actual-provider-string","providerTabId":"actual-provider-id"}),
                ),
                row(1, json!({"lastAccessed":99999,"windowId":1,"index":0})),
            ],
            ExtensionUserTabsOrder::Provider,
        );
        assert_eq!(
            rows.iter().map(|row| row.id).collect::<Vec<_>>(),
            vec![9, 1]
        );
        assert_eq!(
            tab_info(&rows[0]),
            json!({"id":"9","lastOpened":"actual-provider-string","providerTabId":"actual-provider-id"})
        );
        assert_eq!(tab_info(&rows[1]), json!({"id":"1"}));
    }
    #[test]
    fn raw_extension_order_uses_activity_then_window_index_and_id() {
        let rows = ordered_user_tabs(
            vec![
                row(4, json!({"lastAccessed":10,"windowId":2,"index":0})),
                row(3, json!({"lastAccessed":10,"windowId":1,"index":1})),
                row(2, json!({"lastAccessed":20,"windowId":2,"index":1})),
                row(1, json!({"lastAccessed":10,"windowId":1,"index":1})),
            ],
            ExtensionUserTabsOrder::Host,
        );
        assert_eq!(
            rows.iter().map(|row| row.id).collect::<Vec<_>>(),
            vec![2, 1, 3, 4]
        );
    }
    #[test]
    fn user_inventory_deduplicates_before_cap_without_creating_timestamps() {
        let rows = (0..1003)
            .flat_map(|id| [row(id, json!({})), row(id, json!({"title":"duplicate"}))])
            .collect();
        let rows = ordered_user_tabs(rows, ExtensionUserTabsOrder::Provider);
        assert_eq!(rows.len(), 1000);
        assert_eq!(rows.last().unwrap().id, 999);
        assert!(
            rows.iter()
                .all(|row| row.title.is_none() && row.last_opened.is_none())
        );
    }
}

#[cfg(test)]
mod preparation_effect_tests {
    use super::*;

    #[test]
    fn cleanup_and_refused_retries_preserve_other_scopes_and_header_liability() {
        let old = ExtensionWireContext::new("fixture-session", "old-turn").unwrap();
        let current = ExtensionWireContext::new("fixture-session", "current-turn").unwrap();
        let mut effects = PreparationEffects::default();
        effects.begin(&old, true);
        effects.begin(&current, true);
        let retry = effects.begin(&current, true);
        effects.refused(&current, retry);
        assert_eq!(effects.scopes, [old.clone(), current.clone()]);
        effects.fixed_cleanup(&old, true);
        assert_eq!(effects.scopes.as_slice(), std::slice::from_ref(&current));
        assert!(!effects.settled());
        effects.fixed_cleanup(&current, true);
        assert!(effects.scopes.is_empty());
        assert!(
            !effects.settled(),
            "fixed cleanup does not acknowledge headers"
        );
        effects.headers_may_exist = false;
        assert!(effects.settled());
    }

    #[test]
    fn preparation_refusal_keeps_unknown_and_only_current_no_dispatch_refunds() {
        fn pending() -> (ClaimState, ExtensionHostOperation) {
            let operation = context_operation("projection-turn");
            let wire = ExtensionWireContext::new("projection-session", "projection-turn").unwrap();
            let mut state = ClaimState::default();
            let effects = state.preparation_effects.begin(&wire, true);
            state.claim_preparation = ClaimPreparation::Pending(Arc::new(PreparationAttempt {
                document: ExtensionPreparationDocument {
                    frame_id: "frame".into(),
                    loader_id: "loader".into(),
                    url: "https://fixture.invalid".into(),
                },
                policy: Arc::new(ExtensionPreparationPolicy::default()),
                wire,
                operation: operation.clone(),
                previous: None,
                effects,
            }));
            (state, operation)
        }
        let (mut state, operation) = pending();
        state.finish_preparation_error(
            Some(&operation),
            false,
            "remote refusal after actual request",
        );
        assert!(
            matches!(&state.claim_preparation, ClaimPreparation::Unknown {reason,..}
            if reason == "remote refusal after actual request")
        );
        assert!(!state.preparation_effects.settled());
        state.finish_preparation_error(Some(&operation), true, "later no-dispatch cannot wash it");
        assert!(
            matches!(&state.claim_preparation, ClaimPreparation::Unknown {reason,..}
            if reason == "remote refusal after actual request")
        );
        assert!(!state.preparation_effects.settled());
        let (mut state, operation) = pending();
        let foreign = context_operation("projection-turn");
        state.finish_preparation_error(Some(&foreign), true, "unrelated request");
        assert!(matches!(
            state.claim_preparation,
            ClaimPreparation::Pending(_)
        ));
        assert!(!state.preparation_effects.settled());
        state.finish_preparation_error(Some(&operation), true, "matching no-dispatch");
        assert!(matches!(
            state.claim_preparation,
            ClaimPreparation::NotAttempted
        ));
        assert!(state.preparation_effects.settled());
    }
}

#[cfg(test)]
mod control_lifetime_tests {
    use super::*;
    use std::{future::Future, task::Poll};

    // The provider is inert. These keepers exercise the actual Host mutex and
    // call-lifetime transitions, not extension activation or permission proofs.
    fn fixture() -> (uuid::Uuid, BrowserIdentity, ProviderState) {
        let provider = Provider::Cdp(maka_capabilities::computer::BrowserConnection {
            id: "control-lifetime".into(),
            endpoint: "http://127.0.0.1:9222".into(),
        });
        let browser = BrowserIdentity::of(
            &provider,
            "ws://127.0.0.1:9222/devtools/browser/control-lifetime",
        )
        .unwrap();
        (
            uuid::Uuid::new_v4(),
            browser,
            ProviderState {
                provider,
                current_turn: Some("old-turn".into()),
                pending_viewport: None,
                session_group_title: None,
                retiring_turn: None,
                logical_active: None,
                calls: HashMap::new(),
                applied: HashSet::new(),
                finish_phases: HashMap::new(),
                session_headers: None,
                headers_unknown: false,
                uploads: upload::Custody::default(),
                owner_parked: false,
            },
        )
    }
    fn call(epoch: crate::desktop::NativeEpochId) -> CallContext {
        CallContext {
            turn: "old-turn".into(),
            epoch,
            purposes: HashSet::from([CallPurpose::SessionInventory]),
            issuing: Arc::new(AtomicUsize::new(0)),
            activation: Arc::new(AtomicBool::new(false)),
            registration: None,
            controls: Arc::new(ControlGate::default()),
        }
    }

    #[tokio::test]
    async fn control_drain_releases_host_for_the_original_future_callback() {
        let (owner, browser, mut state) = fixture();
        let call = call(crate::desktop::NativeEpochId::new());
        let gate = call.controls.clone();
        let permit = gate.enter().unwrap();
        state.calls.insert("accepted-control".into(), call);
        let host = Arc::new(tokio::sync::Mutex::new(Host::default()));
        host.lock()
            .await
            .extension
            .insert((owner, browser.clone()), state);
        let (release, released) = tokio::sync::oneshot::channel();
        let callback_host = host.clone();
        let callback_browser = browser.clone();
        let original = tokio::spawn(async move {
            released.await.unwrap();
            callback_host
                .lock()
                .await
                .extension
                .get_mut(&(owner, callback_browser))
                .unwrap()
                .logical_active = Some("callback-ran".into());
            drop(permit);
        });
        let drain = host
            .lock()
            .await
            .seal_extension_controls(owner, Some("old-turn"), None);
        let mut drained = Box::pin(drain.wait());
        assert!(
            std::future::poll_fn(|cx| Poll::Ready(drained.as_mut().poll(cx).is_pending())).await
        );
        assert!(
            gate.enter().is_err(),
            "sealing must reject an unpolled old call"
        );
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), &mut drained)
            .await
            .unwrap()
            .unwrap();
        original.await.unwrap();
        assert_eq!(
            host.lock().await.extension[&(owner, browser)]
                .logical_active
                .as_deref(),
            Some("callback-ran")
        );
    }

    #[tokio::test]
    async fn extension_event_lock_keeps_polling_the_same_dispatch_that_holds_host() {
        let (owner, browser, state) = fixture();
        let host = Arc::new(tokio::sync::Mutex::new(Host::default()));
        host.lock()
            .await
            .extension
            .insert((owner, browser.clone()), state);
        let (release, released) = tokio::sync::oneshot::channel();
        let callback_host = host.clone();
        let callback_browser = browser.clone();
        let completed = Arc::new(AtomicUsize::new(0));
        let terminal = completed.clone();
        let mut original: Option<crate::HostEffectFuture> = Some(Box::pin(async move {
            let mut ledger = callback_host.lock().await;
            released.await.unwrap();
            ledger
                .extension
                .get_mut(&(owner, callback_browser))
                .unwrap()
                .logical_active = Some("same-original-terminal".into());
            terminal.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }));
        assert!(
            std::future::poll_fn(|cx| Poll::Ready(
                original.as_mut().unwrap().as_mut().poll(cx).is_pending()
            ))
            .await
        );
        assert!(
            host.try_lock().is_err(),
            "the actual original future owns Host"
        );
        assert_eq!(completed.load(Ordering::SeqCst), 0);
        release.send(()).unwrap();
        let ledger = tokio::time::timeout(
            Duration::from_secs(1),
            lock_for_extension_event(&host, &mut original),
        )
        .await
        .expect("event lock must continue its retained lock-owning dispatch");
        assert!(
            original.is_none(),
            "the same future reached its real terminal"
        );
        assert_eq!(completed.load(Ordering::SeqCst), 1);
        assert_eq!(
            ledger.extension[&(owner, browser)]
                .logical_active
                .as_deref(),
            Some("same-original-terminal")
        );
    }

    #[tokio::test]
    async fn control_ready_between_seal_and_wait_does_not_lose_completion() {
        let gate = Arc::new(ControlGate::default());
        let permit = gate.enter().unwrap();
        gate.seal();
        drop(permit);
        tokio::time::timeout(
            Duration::from_secs(1),
            ControlDrain {
                gates: vec![gate.clone()],
            }
            .wait(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(gate.enter().is_err(), "idle must not reopen a retired call");
    }

    #[tokio::test]
    async fn epoch_drain_does_not_seal_a_replacement_epoch_call() {
        let (owner, browser, mut state) = fixture();
        let old_epoch = crate::desktop::NativeEpochId::new();
        let new_epoch = crate::desktop::NativeEpochId::new();
        let old = call(old_epoch);
        let new = call(new_epoch);
        let old_gate = old.controls.clone();
        let new_gate = new.controls.clone();
        state.calls.insert("old".into(), old);
        state.calls.insert("new".into(), new);
        let mut host = Host::default();
        host.extension.insert((owner, browser.clone()), state);
        host.seal_extension_controls(owner, None, Some(old_epoch))
            .wait()
            .await
            .unwrap();
        assert!(old_gate.enter().is_err());
        assert!(
            new_gate.enter().is_ok(),
            "old VM retirement must not seal the replacement"
        );
        assert!(host.extension[&(owner, browser)].retiring_turn.is_none());
    }

    #[tokio::test]
    async fn late_old_turn_cleanup_does_not_poison_the_current_turn() {
        let (owner, browser, mut state) = fixture();
        state
            .finish_phases
            .insert("old-turn".into(), FinishPhase::Acknowledged);
        state.admit_turn("new-turn").unwrap();
        state.logical_active = Some("current-target".into());
        let mut host = Host::default();
        host.extension.insert((owner, browser.clone()), state);
        host.seal_extension_controls(owner, Some("old-turn"), None)
            .wait()
            .await
            .unwrap();
        let current = host.extension.get_mut(&(owner, browser)).unwrap();
        assert!(current.retiring_turn.is_none());
        assert_eq!(current.current_turn.as_deref(), Some("new-turn"));
        assert_eq!(current.logical_active.as_deref(), Some("current-target"));
        current.admit_turn("new-turn").unwrap();
    }

    #[test]
    fn issued_intent_does_not_create_finish_or_clear_another_calls_obligation() {
        let (_, _, mut state) = fixture();
        let first = call(crate::desktop::NativeEpochId::new());
        state.calls.insert("not-polled".into(), first);
        state.fold_activation();
        assert!(
            state.finish_phases.is_empty(),
            "local intent or Host refusal is not activation"
        );
        state.calls["not-polled"]
            .activation
            .store(true, Ordering::SeqCst);
        state.fold_activation();
        state.calls.insert(
            "parallel-refused".into(),
            call(crate::desktop::NativeEpochId::new()),
        );
        state.fold_activation();
        assert!(matches!(
            state.finish_phases.get("old-turn"),
            Some(FinishPhase::Required)
        ));
        assert!(state.admit_turn("new-turn").is_err());
        assert_eq!(state.current_turn.as_deref(), Some("old-turn"));
        assert!(matches!(
            state.finish_phases.get("old-turn"),
            Some(FinishPhase::Required)
        ));
        assert!(state.calls.values().all(|call| call.controls.is_sealed()));
    }

    #[test]
    fn an_accepted_control_blocks_intent_switch_before_its_activation_marker() {
        let (_, _, mut state) = fixture();
        let call = call(crate::desktop::NativeEpochId::new());
        let permit = call.controls.enter().unwrap();
        state.calls.insert("enter-won-before-seal".into(), call);
        assert!(state.admit_turn("new-turn").is_err());
        assert_eq!(state.current_turn.as_deref(), Some("old-turn"));
        state.calls["enter-won-before-seal"]
            .activation
            .store(true, Ordering::SeqCst);
        drop(permit);
        state.fold_activation();
        assert!(matches!(
            state.finish_phases.get("old-turn"),
            Some(FinishPhase::Required)
        ));
        state.finish_phases.insert(
            "old-turn".into(),
            FinishPhase::Unknown("original result unknown".into()),
        );
        assert!(state.admit_turn("new-turn").is_err());
        assert!(
            matches!(state.finish_phases.get("old-turn"), Some(FinishPhase::Unknown(reason)) if reason == "original result unknown")
        );
    }
}

#[cfg(all(test, unix))]
#[path = "extension/inventory_tests.rs"]
mod inventory_tests;

// Append in browser/extension.rs. This reuses the same metadata operation
// registration, session ownership and current Host session-preparation check.
impl Browsers {
    pub(super) async fn set_browser_viewport(
        &mut self,
        browser_id: &str,
        value: Option<crate::protocol::BrowserViewport>,
        call: BrowserCall<'_>,
    ) -> Result<Value, ToolError> {
        let value = value
            .map(crate::protocol::BrowserViewport::validate)
            .transpose()
            .map_err(failed)?;
        let provider = self
            .providers(Some(browser_id))?
            .pop()
            .expect("selected provider");
        self.extension_session_metadata(&provider, call).await?;
        let pending = session_metadata_call(
            self.host().await,
            self.owner,
            &provider,
            self.epoch,
            call,
            self.acquisition_history(&provider),
        )
        .await?;
        pending.check().await?;
        let browser = BrowserIdentity::of(&provider, pending.generation())?;
        let identity = self.host().await.lock().await.set_viewport(
            self.owner,
            &browser,
            call.invocation.turn(),
            value,
        )?;
        let Some(identity) = identity else {
            return Ok(Value::Null);
        };
        let row = pending.resolve(&identity.target).await?;
        let bound = self
            .bind(
                TabSource {
                    provider,
                    generation: pending.generation().to_owned(),
                    info: provider::extension_tab(row),
                },
                InitialState::Deferred,
                call.invocation,
                call.cancellation,
                call.language,
            )
            .await?;
        let Handle::Tab(handle) =
            serde_json::from_value(bound["handle"].clone()).map_err(failed)?
        else {
            unreachable!()
        };
        let tab = self
            .targets
            .get_mut(&handle)
            .expect("viewport active tab bound");
        tab.prepare_origin_transport(
            call.invocation,
            call.cancellation,
            call.language,
            ClaimIntent::Implicit,
        )
        .await?;
        pending.check().await?;
        super::capability::viewport::apply(tab, value).await?;
        Ok(Value::Null)
    }
}

#[cfg(test)]
mod encoded_title_tests {
    use super::*;

    #[test]
    fn title_and_group_use_only_encoded_text_until_the_facade() {
        let tab: cua_driver_core::browser::ExtensionTabInfo = serde_json::from_value(json!({
            "id":17,"titleJson":r#""\ud800""#,"groupTitleJson":r#""\udc00""#,"url":"about:blank"
        }))
        .unwrap();
        assert_eq!(
            tab_info(&tab),
            json!({"id":"17","titleJson":r#""\ud800""#,"tabGroupJson":r#""\udc00""#,"url":"about:blank"})
        );
        assert_eq!(
            managed_tab_info(&tab),
            json!({"id":"17","titleJson":r#""\ud800""#,"url":"about:blank"})
        );
    }
}
