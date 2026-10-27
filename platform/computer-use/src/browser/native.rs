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

use super::ownership::{Creator, Disposition, Lease, Origin};
use super::*;
use cua_driver_core::browser::{
    CleanupProof, NativeAttachmentPreparation, NativeBrowserProvider, NativeClaimCdpDrainProof,
    NativeClaimPreparationProof, NativeCreatedTab, NativeCreationReceipt, NativeEffectOwner,
    NativeGroupColor, NativeGroupPresentation, NativeHeader, NativeHeaderPolicyScope,
    NativeHostOperation, NativeManagedGroupReceipt, NativeOperation, NativePhysicalClaim,
    NativePopupRequest, NativePreparationDocument, NativePreparationPolicy, NativeProviderEvent,
    NativeRecoveredOperation, NativeSessionHeaderProof, NativeUserTabsOrder, NativeWireContext,
};
use std::{
    collections::HashSet,
    sync::{
        Arc, Weak,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio_util::sync::CancellationToken;

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
    Pending,
    Completed,
    Unknown(String),
}

#[derive(Clone)]
struct PreparationAcknowledgement {
    proof: NativeClaimPreparationProof,
    policy: Arc<NativePreparationPolicy>,
}

#[derive(Clone)]
struct PreparationAttempt {
    document: NativePreparationDocument,
    policy: Arc<NativePreparationPolicy>,
    wire: NativeWireContext,
    operation: NativeHostOperation,
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
        acknowledgement: Option<NativeClaimPreparationProof>,
        reason: String,
    },
}

#[derive(Clone, Default)]
struct PreparationEffects {
    scopes: Vec<NativeWireContext>,
    headers_may_exist: bool,
}
impl PreparationEffects {
    fn begin(&mut self, wire: &NativeWireContext, headers: bool) -> PreparationEffectSnapshot {
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
    fn refused(&mut self, wire: &NativeWireContext, snapshot: PreparationEffectSnapshot) {
        if snapshot.new_scope {
            self.scopes.retain(|scope| scope != wire);
        }
        self.headers_may_exist &= snapshot.previous_headers;
    }
    fn fixed_cleanup(&mut self, wire: &NativeWireContext, confirmed: bool) {
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

#[derive(Clone, Default)]
pub(super) struct ClaimState {
    claim: Option<NativePhysicalClaim>,
    physical_epoch: Option<crate::desktop::NativeEpochId>,
    creation: Option<NativeCreationReceipt>,
    creation_operation: Option<NativeHostOperation>,
    group: Option<NativeManagedGroupReceipt>,
    revoked: bool,
    headers_active: bool,
    active: bool,
    unknown: Option<String>,
    overlay: Option<OverlayScope>,
    lease_children: Option<LeaseChildScope>,
    focus_readiness: FocusReadiness,
    user_preparation: UserPreparation,
    user_prepared_operation: Option<NativeHostOperation>,
    claim_preparation: ClaimPreparation,
    preparation_effects: PreparationEffects,
    metadata_attached: bool,
    session_prepared_operation: Option<NativeHostOperation>,
    cleanup_started: bool,
    cleanup_revocation: Option<String>,
    physical_cleanup: Option<CleanupProof>,
    cdp_drain: Option<NativeClaimCdpDrainProof>,
    cdp_effect_unknown: Option<String>,
    retirement: ClaimRetirement,
    control_cleanup: ControlCleanup,
    released: bool,
    closed: bool,
    presentation_error: Option<String>,
}
impl ClaimState {
    fn finish_preparation_error(
        &mut self,
        operation: Option<&NativeHostOperation>,
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

struct BoundNativeCreated {
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
struct OverlayScope {
    endpoint: super::cursor::CursorEndpoint,
    authorization: Arc<dyn crate::BrowserAttachmentAuthorization>,
    effects: Arc<dyn crate::BrowserHostEffects>,
    cursor: crate::cursor::Spec,
    turn: String,
    epoch: crate::desktop::NativeEpochId,
    origin: crate::BrowserAttachmentOrigin,
    provider: Provider,
    context: NativeHostOperation,
}
#[derive(Clone)]
struct CallContext {
    turn: String,
    epoch: crate::desktop::NativeEpochId,
    origins: HashSet<Origin>,
    issuing: Arc<AtomicUsize>,
}
struct CallScope {
    control: NativeBrowserProvider,
    issuing: Arc<AtomicUsize>,
    owner: uuid::Uuid,
    provider: Provider,
    context: NativeHostOperation,
    epoch: crate::desktop::NativeEpochId,
    target: Option<String>,
}
struct DispatchPermit {
    issuing: Arc<AtomicUsize>,
}
impl Drop for DispatchPermit {
    fn drop(&mut self) {
        self.issuing.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Current native attachment preparation policy for one actual CDP call.
#[derive(Clone)]
pub(super) enum PreparationTransport {
    NotRequired,
    Unadmitted,
    Admitted(Arc<TransportPreparation>),
}

struct AgentTransportAuthorization {
    context: NativeHostOperation,
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
    claim: NativePhysicalClaim,
    binding: crate::BrowserPreparationBinding,
    authorization: TransportAuthorization,
    cancellation: CancellationToken,
}

/// One live-claim permission issued before the caller enters close custody.
/// It is consumed once by that same operation's existing cleanup sequence.
pub(super) struct NativeCloseAdmission {
    scope: CallScope,
    claim: NativePhysicalClaim,
    identity: TabIdentity,
    request: crate::BrowserSessionPreparation,
}

/// Keeps the exact native operation reservation live until the raw call ends.
/// Dropping it never takes the Host mutex or waits for a callback.
struct AgentTransportCall {
    _scope: CallScope,
    _dispatch: DispatchPermit,
}

pub(super) struct TransportCall {
    _preparation: Arc<TransportPreparation>,
    _agent: Option<AgentTransportCall>,
}

impl PreparationTransport {
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
                    "native CDP requires a current admitted session preparation",
                ));
            }
            Self::Admitted(preparation) => preparation,
        };
        check_input(&preparation.cancellation)?;
        let host = preparation
            .host
            .upgrade()
            .ok_or_else(|| failed("native CDP session owner closed"))?;
        host.lock().await.native_transport_current(preparation)?;
        // No issuing permit is held while consulting the Host. Stop may hold
        // the native ledger while it waits for already dispatched raw calls.
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
        let origin = ledger.native_transport_current(preparation)?;
        let agent = match &preparation.authorization {
            TransportAuthorization::Agent(agent) => {
                let scope = ledger.native_context(
                    preparation.owner,
                    &preparation.provider,
                    agent.context.clone(),
                    preparation.epoch,
                    origin,
                    Some(preparation.claim.tab_id().to_string()),
                    false,
                )?;
                ledger.native_preparation_current(&scope, &agent.request)?;
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
        // exact native claim and actual admission through terminal or Drop.
        Ok(Some(TransportCall {
            _preparation: preparation.clone(),
            _agent: agent,
        }))
    }
}

impl CallScope {
    fn enter_dispatch(&self) -> DispatchPermit {
        self.issuing.fetch_add(1, Ordering::SeqCst);
        DispatchPermit {
            issuing: self.issuing.clone(),
        }
    }

    async fn dispatch<F: std::future::Future>(&self, future: F) -> F::Output {
        let _dispatch = self.enter_dispatch();
        future.await
    }

    fn transport_preparation(
        &self,
        host: &Arc<tokio::sync::Mutex<Host>>,
        invocation: &crate::InvocationContext<'_>,
        claim: &NativePhysicalClaim,
        preparation: &crate::BrowserSessionPreparation,
        cancellation: &CancellationToken,
    ) -> Result<PreparationTransport, ToolError> {
        let native = self
            .provider
            .native()
            .ok_or_else(|| failed("native provider required"))?;
        match native
            .capabilities()
            .map_err(provider::native_error)?
            .attachment_preparation
        {
            NativeAttachmentPreparation::MetadataOnly => {
                return Ok(PreparationTransport::NotRequired);
            }
            NativeAttachmentPreparation::Unknown => {
                return Err(failed(
                    "native attachment preparation behavior has not been established",
                ));
            }
            NativeAttachmentPreparation::FullPreparation => {}
        }
        preparation.check_scope(
            invocation.turn(),
            invocation.operation_id().unwrap_or_default(),
        )?;
        if operation(invocation)? != self.context
            || preparation.native_owner != self.owner
            || preparation.native_epoch != self.epoch.to_string()
            || preparation.browser_id != self.provider.id()
            || preparation.generation != native.identity().generation
            || claim.is_cleanup_only()
            || claim.generation() != preparation.generation
            || !matches!(&preparation.target, crate::BrowserPreparationTarget::ClaimedTab {
                tab_id, claim_id,
            } if tab_id == &claim.tab_id().to_string() && claim_id == claim.claim_id())
        {
            return Err(failed(
                "native transport preparation lost its admitted claim scope",
            ));
        }
        let authorization = invocation.browser_authorization().ok_or_else(|| {
            failed("native transport preparation requires current Host authorization")
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
                    claim_id: claim.claim_id().to_owned(),
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
        let native = self
            .provider
            .native()
            .ok_or_else(|| failed("native provider required"))?;
        let request = crate::BrowserSessionPreparation {
            native_owner: self.owner,
            native_epoch: self.epoch.to_string(),
            browser_id: self.provider.id().to_owned(),
            generation: native.identity().generation.clone(),
            turn_id: self.context.turn_id.clone(),
            operation_id: self.context.operation_id.clone(),
            target,
        };
        host.lock()
            .await
            .native_preparation_current(self, &request)?;
        invocation
            .authorize_session_preparation(&request, cancellation)
            .await?;
        check_input(cancellation)?;
        host.lock()
            .await
            .native_preparation_current(self, &request)?;
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
            .native_preparation_current(self, request)?;
        invocation
            .check_session_preparation(request, cancellation)
            .await?;
        check_input(cancellation)?;
        host.lock().await.native_preparation_current(self, request)
    }
}
enum FinishPhase {
    Pending,
    Acknowledged,
    Refused(String),
    Unknown(String),
}
pub(super) struct ProviderState {
    provider: Provider,
    current_turn: Option<String>,
    retiring_turn: Option<String>,
    logical_active: Option<String>,
    calls: HashMap<String, CallContext>,
    applied: HashSet<u64>,
    finish_phases: HashMap<String, FinishPhase>,
    session_headers: Option<NativeSessionHeaderProof>,
    headers_unknown: bool,
}

fn operation(invocation: &crate::InvocationContext<'_>) -> Result<NativeHostOperation, ToolError> {
    let id = invocation
        .operation_id()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            failed("native browser mutations require the current Host operation identity")
        })?;
    Ok(NativeHostOperation {
        operation_id: id.to_owned(),
        turn_id: invocation.turn().to_owned(),
    })
}
fn preparation_headers(invocation: &crate::InvocationContext<'_>) -> Vec<NativeHeader> {
    invocation
        .browser_preparation_policy()
        .headers
        .iter()
        .map(|header| NativeHeader {
            name: header.name.clone(),
            value: header.value.clone(),
        })
        .collect()
}

fn context_operation(turn: &str) -> NativeHostOperation {
    NativeHostOperation {
        operation_id: format!("cleanup:{}", uuid::Uuid::new_v4()),
        turn_id: turn.to_owned(),
    }
}

pub(super) fn tab_info(tab: &cua_driver_core::browser::NativeTabInfo) -> Value {
    let mut result = json!({"id":tab.id.to_string()});
    for (key, value) in [
        ("title", tab.title.as_ref()),
        ("url", tab.url.as_ref()),
        ("tabGroup", tab.group_title.as_ref()),
    ] {
        if let Some(value) = value {
            result[key] = json!(value);
        }
    }
    if let Some(value) = &tab.last_opened {
        result["lastOpened"] = json!(value);
    }
    if let Some(value) = &tab.provider_tab_id {
        result["providerTabId"] = json!(value);
    }
    result
}
fn managed_tab_info(tab: &cua_driver_core::browser::NativeTabInfo) -> Value {
    let mut result = json!({"id":tab.id.to_string()});
    for (key, value) in [
        ("title", tab.title.as_ref()),
        ("url", tab.url.as_ref()),
        ("providerTabId", tab.provider_tab_id.as_ref()),
    ] {
        if let Some(value) = value {
            result[key] = json!(value);
        }
    }
    result
}

fn is_internal_url(url: &str) -> bool {
    url.starts_with("chrome://")
}

pub(super) fn is_new_tab(url: &str) -> bool {
    ["newtab/", "new-tab-page/", "new-tab-page-third-party/"]
        .iter()
        .any(|suffix| url == format!("chrome://{suffix}"))
}
fn source_time(tab: &cua_driver_core::browser::NativeTabInfo) -> f64 {
    tab.last_accessed
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(0.0)
}

fn ordered_user_tabs(
    mut tabs: Vec<cua_driver_core::browser::NativeTabInfo>,
    order: NativeUserTabsOrder,
) -> Vec<cua_driver_core::browser::NativeTabInfo> {
    tabs.retain(|tab| tab.id <= 9_007_199_254_740_991);
    if order == NativeUserTabsOrder::Host {
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
    fn native_transport_current(
        &self,
        preparation: &TransportPreparation,
    ) -> Result<Origin, ToolError> {
        let binding = &preparation.binding;
        binding.check_turn(&binding.turn_id)?;
        let native = preparation
            .provider
            .native()
            .ok_or_else(|| failed("native provider required"))?;
        if native.is_closed()
            || binding.native_owner != preparation.owner
            || binding.native_epoch != preparation.epoch.to_string()
            || binding.browser_id != preparation.provider.id()
            || binding.generation != native.identity().generation
            || binding.tab_id != preparation.claim.tab_id().to_string()
            || binding.claim_id != preparation.claim.claim_id()
            || preparation.claim.is_cleanup_only()
            || preparation.claim.generation() != binding.generation
        {
            return Err(failed("native CDP preparation binding changed"));
        }
        let browser = BrowserIdentity::of(&preparation.provider, &binding.generation)?;
        self.known(&browser)?;
        let provider = self
            .native
            .get(&(preparation.owner, browser.clone()))
            .ok_or_else(|| failed("native CDP preparation owner retired"))?;
        if provider.current_turn.as_deref() != Some(binding.turn_id.as_str())
            || provider.retiring_turn.is_some()
            || provider.headers_unknown
        {
            return Err(ToolError::CleanupUnconfirmed(
                "native CDP preparation turn is no longer current".into(),
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
                        call.epoch != preparation.epoch || call.turn != agent.context.turn_id
                    })
            {
                return Err(failed("native CDP preparation operation changed"));
            }
        }
        let lease = self
            .tabs
            .get(&browser.tab(&binding.tab_id))
            .ok_or_else(|| failed("native CDP preparation lost its physical lease"))?;
        let state = lease
            .native
            .as_ref()
            .ok_or_else(|| failed("native CDP preparation replaced native custody"))?;
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
                "native CDP preparation lost its exact live physical claim".into(),
            ));
        }
        Ok(lease.origin)
    }

    fn native_preparation_current(
        &self,
        scope: &CallScope,
        request: &crate::BrowserSessionPreparation,
    ) -> Result<(), ToolError> {
        request.check_scope(&scope.context.turn_id, &scope.context.operation_id)?;
        let native = scope
            .provider
            .native()
            .ok_or_else(|| failed("native provider required"))?;
        if native.is_closed()
            || request.native_owner != scope.owner
            || request.native_epoch != scope.epoch.to_string()
            || request.browser_id != scope.provider.id()
            || request.generation != native.identity().generation
        {
            return Err(failed(
                "native session preparation owner or provider changed",
            ));
        }
        let browser = BrowserIdentity::of(&scope.provider, &request.generation)?;
        self.known(&browser)?;
        let state = self
            .native
            .get(&(scope.owner, browser.clone()))
            .ok_or_else(|| failed("native session preparation owner retired"))?;
        let call = state
            .calls
            .get(&scope.context.operation_id)
            .ok_or_else(|| failed("native session preparation lost its original Host call"))?;
        if state.current_turn.as_deref() != Some(scope.context.turn_id.as_str())
            || state.retiring_turn.is_some()
            || state.headers_unknown
            || call.turn != scope.context.turn_id
            || call.epoch != scope.epoch
            || !Arc::ptr_eq(&call.issuing, &scope.issuing)
        {
            return Err(ToolError::CleanupUnconfirmed(
                "native session preparation call is no longer current".into(),
            ));
        }
        let tab_id = match &request.target {
            crate::BrowserPreparationTarget::ReservedTab { tab_id }
            | crate::BrowserPreparationTarget::ClaimedTab { tab_id, .. } => Some(tab_id),
            crate::BrowserPreparationTarget::PendingCreation => {
                if !call.origins.contains(&Origin::AgentCreated) {
                    return Err(failed("native creation has no admitted creation call"));
                }
                scope.target.as_ref()
            }
        };
        if let Some(tab_id) = tab_id {
            let lease = self
                .tabs
                .get(&browser.tab(tab_id))
                .ok_or_else(|| failed("native session preparation lost its reserved tab"))?;
            let state = lease
                .native
                .as_ref()
                .ok_or_else(|| failed("native session preparation lost native custody"))?;
            if lease.creator.owner != scope.owner
                || lease.creator.provider != scope.provider
                || lease.creator.generation != request.generation
                || lease.creator.turn != scope.context.turn_id
                || !matches!(lease.disposition, Disposition::Live)
                || state.revoked
                || state.cleanup_started
                || state.released
                || state.closed
                || state.unknown.is_some()
                || state.cdp_effect_unknown.is_some()
            {
                return Err(ToolError::CleanupUnconfirmed(
                    "native session preparation lost its live reservation".into(),
                ));
            }
            if !matches!(
                request.target,
                crate::BrowserPreparationTarget::PendingCreation
            ) && scope.target.as_deref() != Some(tab_id.as_str())
                && (state.creation_operation.as_ref() != Some(&scope.context)
                    || state.creation.as_ref().is_none_or(|creation| {
                        creation.is_cleanup_only()
                            || creation.tab_id().map(|id| id.to_string()).as_ref() != Some(tab_id)
                            || creation.generation() != request.generation
                    }))
            {
                return Err(failed(
                    "native session preparation changed its issued target",
                ));
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
                    "native session preparation changed its physical claim",
                ));
            }
        }
        Ok(())
    }

    fn native_preparation_failed(
        &mut self,
        identity: &TabIdentity,
        error: &cua_driver_core::browser::NativeProviderError,
    ) {
        if let Some(state) = self
            .tabs
            .get_mut(identity)
            .and_then(|lease| lease.native.as_mut())
            && !matches!(state.user_preparation, UserPreparation::Completed)
        {
            state.user_preparation = match error {
                cua_driver_core::browser::NativeProviderError::Refused { .. }
                | cua_driver_core::browser::NativeProviderError::ChromeRejected { .. } => {
                    UserPreparation::NotAttempted
                }
                _ => UserPreparation::Unknown(error.to_string()),
            };
        }
    }

    fn native_popup_current(
        &self,
        owner: uuid::Uuid,
        provider: &Provider,
        request: &NativePopupRequest,
    ) -> bool {
        let Some(native) = provider.native() else {
            return false;
        };
        let Ok(browser) = BrowserIdentity::of(provider, &native.identity().generation) else {
            return false;
        };
        let wire = request.wire_context();
        if wire.host_session_id() != owner.to_string()
            || self
                .native
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
                    && lease.native.as_ref().is_some_and(|state| {
                        !state.revoked
                            && !state.cleanup_started
                            && state
                                .claim
                                .as_ref()
                                .is_some_and(|claim| claim.claim_id() == request.claim_id())
                    })
            })
    }

    fn apply_claim_preparation(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        context: Option<&NativeHostOperation>,
        proof: NativeClaimPreparationProof,
    ) -> Result<(), ToolError> {
        let native = provider
            .native()
            .ok_or_else(|| failed("native provider required"))?;
        if proof.generation() != native.identity().generation {
            return Err(unknown("native preparation generation changed"));
        }
        let browser = BrowserIdentity::of(provider, &native.identity().generation)?;
        let current = self.native.get(&(owner, browser)).is_some_and(|state| {
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
                        .native
                        .as_ref()
                        .and_then(|state| state.claim.as_ref())
                        .is_some_and(|claim| claim.claim_id() == proof.claim_id())
            })
            .ok_or_else(|| unknown("native preparation lost its exact physical claim"))?;
        let state = lease
            .native
            .as_mut()
            .expect("matched native physical claim");
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
                    "native preparation ACK has no issued Host preparation",
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
                "native preparation ACK changed its issued document, policy or context",
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
                reason: "native preparation ACK is retained for cleanup only".into(),
            };
            lease.disposition = Disposition::Closing;
        } else {
            // The individual actual installation flags stay in this issued ACK.
            // This is neither a NativeHeaderProof nor a blanket readiness bit.
            state.claim_preparation = ClaimPreparation::Acknowledged(PreparationAcknowledgement {
                proof,
                policy: attempt.policy.clone(),
            });
        }
        Ok(())
    }

    fn allocate_native_sequence(&mut self) -> Result<u64, ToolError> {
        self.next_native_sequence = self
            .next_native_sequence
            .checked_add(1)
            .ok_or_else(|| failed("native tab insertion sequence exhausted"))?;
        Ok(self.next_native_sequence)
    }

    async fn cleanup_native_control(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
    ) -> Result<(), ToolError> {
        let lease = self
            .tabs
            .get(identity)
            .filter(|lease| lease.creator.owner == owner)
            .ok_or_else(|| unknown("native control cleanup lost its owned tab"))?;
        let phase = lease
            .native
            .as_ref()
            .ok_or_else(|| unknown("native control cleanup lost claim custody"))?
            .control_cleanup
            .clone();
        match phase {
            ControlCleanup::Confirmed => return Ok(()),
            ControlCleanup::Pending => {
                return Err(ToolError::CleanupUnconfirmed(
                    "native control cleanup is still unsettled; it was not replayed".into(),
                ));
            }
            ControlCleanup::Unconfirmed(reason) => {
                return Err(ToolError::CleanupUnconfirmed(reason));
            }
            ControlCleanup::NotAttempted => {}
        }
        self.tabs
            .get_mut(identity)
            .and_then(|lease| lease.native.as_mut())
            .ok_or_else(|| unknown("native control cleanup lost claim custody"))?
            .control_cleanup = ControlCleanup::Pending;
        let result = self.finalize_native_cursor(owner, identity).await;
        let state = self
            .tabs
            .get_mut(identity)
            .and_then(|lease| lease.native.as_mut())
            .ok_or_else(|| unknown("native control cleanup result lost claim custody"))?;
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

    fn native_context(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        context: NativeHostOperation,
        epoch: crate::desktop::NativeEpochId,
        origin: Origin,
        target: Option<String>,
        activate: bool,
    ) -> Result<CallScope, ToolError> {
        let native = provider
            .native()
            .ok_or_else(|| failed("native provider required"))?;
        let identity = BrowserIdentity::of(provider, &native.identity().generation)?;
        if activate {
            self.known(&identity)?;
        }
        if activate
            && self.tabs.values().any(|lease| {
                lease.creator.owner == owner
                    && lease.creator.provider == *provider
                    && (matches!(lease.disposition, Disposition::Closing)
                        || lease.native.as_ref().is_some_and(|state| {
                            matches!(
                                state.focus_readiness,
                                FocusReadiness::Pending | FocusReadiness::Unknown(_)
                            ) || matches!(
                                state.user_preparation,
                                UserPreparation::Pending | UserPreparation::Unknown(_)
                            ) || matches!(
                                state.claim_preparation,
                                ClaimPreparation::Pending(_) | ClaimPreparation::Unknown { .. }
                            )
                        }))
            })
        {
            return Err(ToolError::CleanupUnconfirmed("previous native attachment settlement must finish before this provider admits more effects".into()));
        }
        let state = self
            .native
            .get_mut(&(owner, identity))
            .ok_or_else(|| failed("native provider is not registered to this Session owner"))?;
        if activate && state.retiring_turn.is_some() {
            return Err(ToolError::CleanupUnconfirmed(
                "native turn cleanup must settle before this provider admits another effect".into(),
            ));
        }
        if activate && state.headers_unknown {
            return Err(ToolError::CleanupUnconfirmed(
                "native session header state remains uncertain".into(),
            ));
        }
        if activate && state.current_turn.as_deref() != Some(&context.turn_id) {
            state.finish_phases.remove(&context.turn_id);
            for (identity, lease) in &mut self.tabs {
                if lease.creator.owner == owner
                    && lease.creator.provider == *provider
                    && matches!(lease.disposition, Disposition::Live)
                {
                    if identity.browser
                        != BrowserIdentity::of(provider, &native.identity().generation)?
                    {
                        continue;
                    }
                    lease.creator.turn = context.turn_id.clone();
                }
            }
            state.current_turn = Some(context.turn_id.clone());
        }
        let control = native
            .with_host_operation(context.clone())
            .with_wire_context(
                cua_driver_core::browser::NativeWireContext::new(
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
                origins: HashSet::from([origin]),
                issuing: Arc::new(AtomicUsize::new(0)),
            });
        if call.epoch != epoch || call.turn != issued_turn {
            return Err(failed(
                "native Host operation identity was reused across an epoch or turn",
            ));
        }
        call.origins.insert(origin);
        Ok(CallScope {
            control,
            issuing: call.issuing.clone(),
            owner,
            provider: provider.clone(),
            context: issued_context,
            epoch,
            target,
        })
    }
    fn native_reserve(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        turn: &str,
        target: &str,
        origin: Origin,
    ) -> Result<(), ToolError> {
        let native = provider
            .native()
            .ok_or_else(|| failed("native provider required"))?;
        let browser = BrowserIdentity::of(provider, &native.identity().generation)?;
        self.known(&browser)?;
        let identity = browser.tab(target);
        if let Some(lease) = self.tabs.get(&identity) {
            if lease.creator.owner != owner {
                return Err(failed("tab_owned_by_another_session"));
            }
            if !matches!(lease.disposition, Disposition::Live) {
                return Err(ToolError::CleanupUnconfirmed(
                    "previous native tab cleanup has not settled".into(),
                ));
            }
            if lease.native.as_ref().is_some_and(|state| state.revoked) {
                return Err(failed(
                    "native browser control was revoked; explicitly claim the tab again",
                ));
            }
            return Ok(());
        }
        self.tabs.insert(
            identity,
            Lease {
                native_sequence: None,
                creator: Creator {
                    owner,
                    turn: turn.into(),
                    provider: provider.clone(),
                    generation: native.identity().generation.clone(),
                },
                origin,
                disposition: Disposition::Live,
                native: Some(ClaimState::default()),
            },
        );
        Ok(())
    }
    async fn reconcile_provider(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
    ) -> Result<bool, ToolError> {
        let native = provider
            .native()
            .ok_or_else(|| failed("native provider required"))?;
        let browser = BrowserIdentity::of(provider, &native.identity().generation)?;
        let pending = native
            .pending_operations()
            .await
            .map_err(provider::native_error)?;
        let present: HashSet<_> = pending.iter().map(|entry| entry.id).collect();
        if let Some(state) = self.native.get_mut(&(owner, browser.clone())) {
            state.applied.retain(|id| present.contains(id));
        }
        let mut unsettled = false;
        for completion in pending {
            if completion.provider != *native.identity() {
                return Err(unknown(
                    "native completion belongs to another physical generation",
                ));
            }
            if completion.outcome.is_none() {
                unsettled = true;
                continue;
            }
            if let NativeOperation::PopupRequested { request } = &completion.operation {
                if request.wire_context().host_session_id() != owner.to_string() {
                    // A shared provider's observer never consumes another
                    // Session owner's retained intent or Unknown custody.
                    continue;
                }
                let issued = self
                    .native
                    .get(&(owner, browser.clone()))
                    .is_some_and(|state| state.applied.contains(&completion.id));
                if issued || self.native_popup_current(owner, provider, request) {
                    // Metadata stays in the original charged completion store
                    // until a fresh Host source-lease service consumes it.
                    continue;
                }
                native
                    .acknowledge_completion(completion.id)
                    .await
                    .map_err(provider::native_error)?;
                continue;
            }
            let already = self
                .native
                .get(&(owner, browser.clone()))
                .is_some_and(|state| state.applied.contains(&completion.id));
            if !already {
                let recovered = native
                    .recover_completion(completion.id)
                    .await
                    .map_err(provider::native_error)?;
                self.apply_native_completion(
                    owner,
                    provider,
                    &completion.operation,
                    completion.host_operation.as_ref(),
                    recovered,
                )?;
                self.native
                    .get_mut(&(owner, browser.clone()))
                    .ok_or_else(|| failed("native provider owner retired"))?
                    .applied
                    .insert(completion.id);
            }
            let retained_cleanup = self.tabs.values().any(|lease| {
                lease.creator.owner == owner
                    && lease.creator.provider == *provider
                    && lease
                        .native
                        .as_ref()
                        .and_then(|state| state.physical_cleanup.as_ref())
                        .is_some_and(|cleanup| cleanup.completion_id() == completion.id)
            });
            if !retained_cleanup {
                native
                    .acknowledge_completion(completion.id)
                    .await
                    .map_err(provider::native_error)?;
            }
        }
        let pending_contexts: HashSet<_> = native
            .pending_operations()
            .await
            .map_err(provider::native_error)?
            .iter()
            .filter_map(|entry| {
                entry
                    .host_operation
                    .as_ref()
                    .map(|context| context.operation_id.clone())
            })
            .collect();
        if let Some(state) = self.native.get_mut(&(owner, browser)) {
            state.calls.retain(|id, call| {
                Arc::strong_count(&call.issuing) > 1
                    || call.issuing.load(Ordering::SeqCst) > 0
                    || pending_contexts.contains(id)
            });
        }
        Ok(unsettled)
    }
    fn apply_native_cleanup(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        browser: &BrowserIdentity,
        operation: &NativeOperation,
        target: Option<&str>,
        proof: Option<&CleanupProof>,
    ) {
        if let NativeOperation::StopCreatedTab { creation, .. } = operation {
            self.uncertain_creations.retain(|_, uncertain| {
                !(uncertain.creator.owner == owner
                    && uncertain.creator.provider == *provider
                    && uncertain
                        .native
                        .as_ref()
                        .is_some_and(|receipt| receipt.creation_id() == creation))
            });
        }
        if let Some(target) = target
            && let Some(lease) = self.tabs.get_mut(&browser.tab(target))
            && let Some(state) = &mut lease.native
        {
            match operation {
                NativeOperation::Detach { .. } => {
                    state.released = true;
                }
                NativeOperation::CloseTab { .. } | NativeOperation::StopCreatedTab { .. } => {
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

    fn begin_native_cleanup(&mut self, identity: &TabIdentity) -> Result<(), ToolError> {
        let state = self
            .tabs
            .get_mut(identity)
            .and_then(|lease| lease.native.as_mut())
            .ok_or_else(|| unknown("native cleanup lost its exact claim custody"))?;
        if state.cleanup_started {
            return Err(ToolError::CleanupUnconfirmed(
                "the same native physical cleanup remains unsettled; it was not replayed".into(),
            ));
        }
        state.cleanup_started = true;
        Ok(())
    }

    async fn retire_native_cleanup(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        identity: &TabIdentity,
        control: &NativeBrowserProvider,
    ) -> Result<(), ToolError> {
        // This folds native-local facts only. The outer Host's original journal
        // and retained effect futures keep their own T1/T2 custody independently.
        if self.reconcile_provider(owner, provider).await? {
            return Err(ToolError::CleanupUnconfirmed(
                "native control custody remains pending before claim retirement".into(),
            ));
        }
        let state = self
            .tabs
            .get(identity)
            .and_then(|lease| lease.native.as_ref())
            .ok_or_else(|| unknown("native retirement lost its exact claim custody"))?
            .clone();
        if !state.preparation_effects.settled() {
            return Err(ToolError::CleanupUnconfirmed(
                "native fixed preparation or scoped header cleanup remains unconfirmed".into(),
            ));
        }
        if let Some(reason) = &state.cdp_effect_unknown {
            return Err(ToolError::CleanupUnconfirmed(format!(
                "underlying Chrome effect remains unknown after native invocation/physical cleanup: {reason}"
            )));
        }
        if let Some(reason) = &state.unknown {
            return Err(ToolError::CleanupUnconfirmed(format!(
                "native effect custody remains unknown before claim retirement: {reason}"
            )));
        }
        let Some(cleanup) = state.physical_cleanup else {
            if state.claim.is_none() {
                return Ok(());
            }
            return Err(ToolError::CleanupUnconfirmed(format!(
                "native claim lacks its retained known physical cleanup proof{}",
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
                    "native claim lacks its exact fenced native-invocation drain proof".into(),
                )
            })?;
            match state.retirement {
                ClaimRetirement::Confirmed => {}
                ClaimRetirement::Pending => {
                    return Err(ToolError::CleanupUnconfirmed(
                        "local native retirement remains unsettled; it was not replayed".into(),
                    ));
                }
                ClaimRetirement::Unknown(reason) => {
                    return Err(ToolError::CleanupUnconfirmed(reason));
                }
                ClaimRetirement::NotAttempted => {
                    self.tabs
                        .get_mut(identity)
                        .and_then(|lease| lease.native.as_mut())
                        .ok_or_else(|| unknown("native retirement lost custody"))?
                        .retirement = ClaimRetirement::Pending;
                    let retired = control.retire_claim(claim, &cleanup, drain).await;
                    let retirement = match &retired {
                        Ok(()) => ClaimRetirement::Confirmed,
                        Err(cua_driver_core::browser::NativeProviderError::Refused { .. }) => {
                            ClaimRetirement::NotAttempted
                        }
                        Err(error) => ClaimRetirement::Unknown(error.to_string()),
                    };
                    self.tabs
                        .get_mut(identity)
                        .and_then(|lease| lease.native.as_mut())
                        .ok_or_else(|| unknown("native retirement result lost custody"))?
                        .retirement = retirement;
                    retired.map_err(provider::native_error)?;
                }
            }
        }
        // Only a matched local retirement permits consumption of the exact
        // physical cleanup receipt. This ACK does not claim Chrome input success.
        control
            .acknowledge_completion(cleanup.completion_id())
            .await
            .map_err(provider::native_error)?;
        let state = self
            .tabs
            .get_mut(identity)
            .and_then(|lease| lease.native.as_mut())
            .ok_or_else(|| unknown("native cleanup ACK lost custody"))?;
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

    fn apply_native_completion(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        operation: &NativeOperation,
        context: Option<&NativeHostOperation>,
        recovered: NativeRecoveredOperation,
    ) -> Result<(), ToolError> {
        let native = provider
            .native()
            .ok_or_else(|| failed("native provider required"))?;
        let browser = BrowserIdentity::of(provider, &native.identity().generation)?;
        let call = context
            .and_then(|context| {
                self.native
                    .get(&(owner, browser.clone()))
                    .and_then(|state| state.calls.get(&context.operation_id))
            })
            .cloned();
        let event = matches!(
            &recovered,
            NativeRecoveredOperation::OrphanCdpCompletion { .. }
                | NativeRecoveredOperation::EffectsCleanup { .. }
                | NativeRecoveredOperation::PopupRequested(_)
        );
        if call.is_none() && !event {
            return Err(ToolError::CleanupUnconfirmed(
                "native mutation completed without its issued Host operation context".into(),
            ));
        }
        let target = match operation {
            NativeOperation::Attach { tab_id } | NativeOperation::PrepareUserTab { tab_id } => {
                Some(tab_id.to_string())
            }
            NativeOperation::Detach { claim, .. }
            | NativeOperation::CloseTab { claim, .. }
            | NativeOperation::PrepareClaim { claim, .. }
            | NativeOperation::SetScopedHeaders { claim }
            | NativeOperation::ClearScopedHeaders { claim }
            | NativeOperation::MoveMousePresentation { claim, .. } => self
                .tabs
                .iter()
                .find(|(_, lease)| {
                    lease.creator.owner == owner
                        && lease.creator.provider == *provider
                        && lease
                            .native
                            .as_ref()
                            .and_then(|state| state.claim.as_ref())
                            .is_some_and(|owned| owned.claim_id() == claim)
                })
                .map(|(identity, _)| identity.target.clone()),
            NativeOperation::StopCreatedTab { creation, .. }
            | NativeOperation::MuteCreatedTab { creation }
            | NativeOperation::UnmuteCreatedTabIfActive { creation }
            | NativeOperation::EnsureCreatedTabGroup { creation }
            | NativeOperation::UpdateCreatedTabGroup { creation, .. }
            | NativeOperation::ReleaseCreatedTabGroup { creation, .. } => self
                .tabs
                .iter()
                .find(|(_, lease)| {
                    lease.creator.owner == owner
                        && lease.creator.provider == *provider
                        && lease
                            .native
                            .as_ref()
                            .and_then(|state| state.creation.as_ref())
                            .is_some_and(|owned| owned.creation_id() == creation)
                })
                .map(|(identity, _)| identity.target.clone()),
            _ => None,
        };
        let connector_refused = matches!(&recovered, NativeRecoveredOperation::Refused { .. });
        match recovered {
            NativeRecoveredOperation::SessionHeaders(proof) => {
                let call = call
                    .as_ref()
                    .ok_or_else(|| unknown("session header result lost its Host context"))?;
                if proof.host_session_id != owner.to_string()
                    || proof.host_turn_id != call.turn
                    || proof.generation != native.identity().generation
                {
                    return Err(unknown("native session header result identity mismatch"));
                }
                let state = self
                    .native
                    .get_mut(&(owner, browser.clone()))
                    .ok_or_else(|| unknown("native session header owner retired"))?;
                state.headers_unknown =
                    !proof.state_confirmed || (!proof.active && !proof.cleanup_confirmed);
                state.session_headers = Some(proof);
            }
            NativeRecoveredOperation::CursorPresentation(_) => {}
            NativeRecoveredOperation::TurnFinished(ack) => {
                let call =
                    call.ok_or_else(|| unknown("native logical finish lost its Host context"))?;
                if ack.host_session_id != owner.to_string() || ack.host_turn_id != call.turn {
                    return Err(unknown("native logical finish identity mismatch"));
                }
                self.native
                    .get_mut(&(owner, browser.clone()))
                    .ok_or_else(|| unknown("native finish owner retired"))?
                    .finish_phases
                    .insert(call.turn, FinishPhase::Acknowledged);
            }
            NativeRecoveredOperation::Created(created) => {
                let call = call.ok_or_else(|| unknown("created tab lost its Host context"))?;
                if !call.origins.contains(&Origin::AgentCreated) {
                    return Err(unknown(
                        "native creation completed under a user-claim operation context",
                    ));
                }
                let identity = browser.tab(&created.tab.id.to_string());
                if self.tabs.contains_key(&identity) {
                    return Err(unknown("native creation reused a leased target identity"));
                }
                let sequence = self.allocate_native_sequence()?;
                self.tabs.insert(
                    identity,
                    Lease {
                        native_sequence: Some(sequence),
                        creator: Creator {
                            owner,
                            turn: call.turn,
                            provider: provider.clone(),
                            generation: native.identity().generation.clone(),
                        },
                        origin: Origin::AgentCreated,
                        disposition: Disposition::Live,
                        native: Some(ClaimState {
                            creation: Some(created.creation_receipt().clone()),
                            creation_operation: context.cloned(),
                            active: created.tab.active.unwrap_or(false),
                            ..Default::default()
                        }),
                    },
                );
            }
            NativeRecoveredOperation::Claim(claim) => {
                let identity = browser.tab(&claim.tab_id().to_string());
                let sequence = match self
                    .tabs
                    .get(&identity)
                    .and_then(|lease| lease.native_sequence)
                {
                    Some(sequence) => sequence,
                    None => self.allocate_native_sequence()?,
                };
                let lease = self.tabs.get_mut(&identity).ok_or_else(|| {
                    unknown("native attachment completed without reserved custody")
                })?;
                if lease.creator.owner != owner {
                    return Err(unknown("native claim owner changed before completion"));
                }
                lease.native_sequence = Some(sequence);
                let state = lease
                    .native
                    .as_mut()
                    .ok_or_else(|| unknown("native claim replaced CDP custody"))?;
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
                    state.lease_children = None;
                }
                state.physical_epoch = call.as_ref().map(|call| call.epoch);
                state.claim = Some(claim);
                state.released = false;
            }
            NativeRecoveredOperation::Cleanup(proof) => {
                self.apply_native_cleanup(
                    owner,
                    provider,
                    &browser,
                    operation,
                    target.as_deref(),
                    Some(&proof),
                );
            }
            NativeRecoveredOperation::Headers(proof) => {
                if let Some(target) = target
                    && let Some(lease) = self.tabs.get_mut(&browser.tab(&target))
                    && let Some(state) = &mut lease.native
                {
                    state.headers_active = proof.active;
                    if !proof.active && proof.cleanup_confirmed {
                        state.preparation_effects.headers_may_exist = false;
                    }
                    if !proof.cleanup_confirmed && proof.pending_removal {
                        state.unknown = Some("native header cleanup is pending".into());
                        lease.disposition = Disposition::Closing;
                    }
                }
            }
            NativeRecoveredOperation::Group(proof) => {
                if let Some(target) = target
                    && let Some(lease) = self.tabs.get_mut(&browser.tab(&target))
                    && let Some(state) = &mut lease.native
                {
                    state.group = Some(proof.group);
                }
            }
            NativeRecoveredOperation::GroupReleased(_) => {
                if let Some(target) = target
                    && let Some(lease) = self.tabs.get_mut(&browser.tab(&target))
                    && let Some(state) = &mut lease.native
                {
                    state.group = None;
                }
            }
            NativeRecoveredOperation::ClaimPrepared(proof) => {
                self.apply_claim_preparation(owner, provider, context, proof)?;
            }
            NativeRecoveredOperation::PopupRequested(_) => {}
            NativeRecoveredOperation::Prepared(prepared) => {
                let target = target
                    .ok_or_else(|| unknown("native preparation ACK lost its issued target"))?;
                if prepared.tab.id.to_string() != target {
                    // Leave the original completion retained and its current
                    // Pending/Unknown custody untouched; this is not an ACK.
                    return Err(unknown("native preparation ACK changed its issued target"));
                }
                let lease = self
                    .tabs
                    .get_mut(&browser.tab(&target))
                    .ok_or_else(|| unknown("native preparation ACK lost its reserved lease"))?;
                if lease.creator.owner != owner
                    || lease.creator.provider != *provider
                    || lease.creator.generation != native.identity().generation
                {
                    return Err(unknown("native preparation ACK changed its reserved owner"));
                }
                let state = lease
                    .native
                    .as_mut()
                    .ok_or_else(|| unknown("native preparation ACK replaced native custody"))?;
                state.user_preparation = UserPreparation::Completed;
                state.user_prepared_operation = context.cloned();
            }
            NativeRecoveredOperation::Presentation(_) => {}
            NativeRecoveredOperation::Refused { message, .. }
            | NativeRecoveredOperation::ChromeRejected { message, .. } => {
                // Connector refusal is an explicit no-dispatch result. Native
                // Chrome errors may follow timeouts and are never replayed here.
                if connector_refused
                    && matches!(
                        operation,
                        NativeOperation::Detach { .. }
                            | NativeOperation::CloseTab { .. }
                            | NativeOperation::StopCreatedTab { .. }
                    )
                    && let Some(target) = &target
                    && let Some(state) = self
                        .tabs
                        .get_mut(&browser.tab(target))
                        .and_then(|lease| lease.native.as_mut())
                    && state.physical_cleanup.is_none()
                    && !state.released
                    && !state.closed
                {
                    state.cleanup_started = false;
                }
                if matches!(operation, NativeOperation::PrepareClaim { .. })
                    && let Some(target) = &target
                    && let Some(lease) = self.tabs.get_mut(&browser.tab(target))
                    && let Some(state) = lease.native.as_mut()
                {
                    state.finish_preparation_error(context, connector_refused, &message);
                    if !connector_refused {
                        lease.disposition = Disposition::Closing;
                    }
                }
                if matches!(operation, NativeOperation::FinishTurn { .. }) {
                    if let Some(call) = call.as_ref() {
                        self.native
                            .get_mut(&(owner, browser.clone()))
                            .ok_or_else(|| unknown("native finish owner retired"))?
                            .finish_phases
                            .insert(call.turn.clone(), FinishPhase::Refused(message));
                    }
                }
            }
            NativeRecoveredOperation::Unknown {
                reason, custody, ..
            } => {
                if let Some(proof) = custody.preparation {
                    self.apply_claim_preparation(owner, provider, context, proof)?;
                }
                if custody.cleanup.is_some() {
                    self.apply_native_cleanup(
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
                    self.native
                        .get_mut(&(owner, browser.clone()))
                        .ok_or_else(|| unknown("uncertain finish owner retired"))?
                        .finish_phases
                        .insert(call.turn.clone(), FinishPhase::Acknowledged);
                } else if matches!(operation, NativeOperation::FinishTurn { .. }) {
                    if let Some(call) = call.as_ref() {
                        self.native
                            .get_mut(&(owner, browser.clone()))
                            .ok_or_else(|| unknown("uncertain finish owner retired"))?
                            .finish_phases
                            .insert(call.turn.clone(), FinishPhase::Unknown(reason.clone()));
                    }
                }
                if matches!(
                    operation,
                    NativeOperation::SetSessionHeaders { .. }
                        | NativeOperation::ClearSessionHeaders
                ) {
                    self.native
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
                        || proof.generation != native.identity().generation
                    {
                        return Err(unknown(
                            "uncertain native session header result identity mismatch",
                        ));
                    }
                    let state = self
                        .native
                        .get_mut(&(owner, browser.clone()))
                        .ok_or_else(|| unknown("unknown session header owner retired"))?;
                    state.headers_unknown =
                        !proof.state_confirmed || (!proof.active && !proof.cleanup_confirmed);
                    state.session_headers = Some(proof);
                }
                let known_created = custody.created.is_some();
                if let Some(created) = custody.created {
                    let call = call
                        .clone()
                        .ok_or_else(|| unknown("unknown creation lost its context"))?;
                    let identity = browser.tab(&created.tab.id.to_string());
                    let sequence = self.allocate_native_sequence()?;
                    self.tabs.entry(identity).or_insert(Lease {
                        native_sequence: Some(sequence),
                        creator: Creator {
                            owner,
                            turn: call.turn,
                            provider: provider.clone(),
                            generation: native.identity().generation.clone(),
                        },
                        origin: Origin::AgentCreated,
                        disposition: Disposition::Closing,
                        native: Some(ClaimState {
                            creation: Some(created.creation_receipt().clone()),
                            unknown: Some(reason.clone()),
                            ..Default::default()
                        }),
                    });
                }
                let creation_operation = matches!(
                    operation,
                    NativeOperation::CreateTab { .. } | NativeOperation::CreatePopupTab { .. }
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
                        native.identity().generation.clone(),
                    );
                    if let Some(uncertain) =
                        self.uncertain_creations.get_mut(&(owner, browser.clone()))
                    {
                        uncertain.native = custody.creation.clone();
                    }
                }
                if let Some(target) = target
                    && let Some(lease) = self.tabs.get_mut(&browser.tab(&target))
                {
                    lease.disposition = Disposition::Closing;
                    let state = lease
                        .native
                        .as_mut()
                        .ok_or_else(|| unknown("unknown native effect has no custody"))?;
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
                    if matches!(operation, NativeOperation::PrepareClaim { .. }) {
                        state.finish_preparation_error(context, false, &reason);
                    } else {
                        state.unknown = Some(reason);
                    }
                }
            }
            NativeRecoveredOperation::EffectsCleanup {
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
                    if let Some(state) = &mut lease.native
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
                                .unwrap_or_else(|| "native effect cleanup unconfirmed".into());
                            if effect == "native_cdp_effect" {
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
            NativeRecoveredOperation::OrphanCdpCompletion { claim, .. } => {
                for lease in self.tabs.values_mut().filter(|lease| {
                    lease.creator.owner == owner && lease.creator.provider == *provider
                }) {
                    if let Some(state) = &mut lease.native
                        && state
                            .claim
                            .as_ref()
                            .is_some_and(|owned| owned.claim_id() == claim)
                    {
                        state.presentation_error = Some(
                            "late native CDP completion retained; no replay authorized".into(),
                        );
                    }
                }
            }
        }
        Ok(())
    }
    pub(super) async fn finish_native(
        &mut self,
        owner: uuid::Uuid,
        turn: Option<&str>,
    ) -> Result<Vec<TabIdentity>, ToolError> {
        let providers: Vec<_> = self
            .native
            .iter()
            .filter(|((current, _), _)| *current == owner)
            .map(|(_, state)| state.provider.clone())
            .collect();
        let mut closed = Vec::new();
        for provider in providers {
            let native = provider
                .native()
                .ok_or_else(|| failed("native cleanup provider missing"))?
                .clone();
            let capabilities = native.capabilities().map_err(provider::native_error)?;
            let browser = BrowserIdentity::of(&provider, &native.identity().generation)?;
            let mut events = native.subscribe_events();
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            while self.reconcile_provider(owner, &provider).await? {
                match tokio::time::timeout_at(deadline, events.recv()).await {
                    Ok(Ok(_)) | Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {}
                    _ => {
                        return Err(ToolError::CleanupUnconfirmed(
                            "native operations remain in flight; custody retained".into(),
                        ));
                    }
                }
            }
            let identities: Vec<_> = self
                .tabs
                .iter()
                .filter(|(_, lease)| {
                    lease.creator.owner == owner
                        && lease.creator.provider == provider
                        && turn.is_none_or(|turn| lease.creator.turn == turn)
                })
                .map(|(identity, _)| identity.clone())
                .collect();
            let uncertain = self
                .uncertain_creations
                .get(&(owner, browser.clone()))
                .filter(|uncertain| {
                    uncertain.creator.owner == owner
                        && turn.is_none_or(|turn| uncertain.creator.turn == turn)
                })
                .cloned();
            let current = self
                .native
                .get(&(owner, browser.clone()))
                .and_then(|state| state.current_turn.clone())
                .filter(|current| turn.is_none_or(|turn| current == turn));
            if identities.is_empty() && uncertain.is_none() && current.is_none() {
                continue;
            }
            let cleanup_turn = turn
                .map(str::to_owned)
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
            let provider_state = self
                .native
                .get_mut(&(owner, browser.clone()))
                .ok_or_else(|| unknown("native cleanup owner retired"))?;
            if provider_state
                .retiring_turn
                .as_deref()
                .is_some_and(|turn| turn != cleanup_turn)
            {
                return Err(ToolError::CleanupUnconfirmed(
                    "another native turn cleanup is still unsettled".into(),
                ));
            }
            provider_state.retiring_turn = Some(cleanup_turn.clone());
            let scope = self.native_context(
                owner,
                &provider,
                context_operation(&cleanup_turn),
                crate::desktop::NativeEpochId::new(),
                Origin::UserClaimed,
                None,
                false,
            )?;
            if capabilities.header_scope == NativeHeaderPolicyScope::Session {
                let needs_clear = self
                    .native
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
                    let cleared = cleared.map_err(provider::native_error)?;
                    if cleared.active || !cleared.cleanup_confirmed {
                        return Err(ToolError::CleanupUnconfirmed(
                            "native session header cleanup is unconfirmed".into(),
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
                let state = lease
                    .native
                    .as_ref()
                    .ok_or_else(|| unknown("native cleanup lost custody"))?
                    .clone();
                if capabilities.header_scope == NativeHeaderPolicyScope::Claim
                    && (state.headers_active || state.preparation_effects.headers_may_exist)
                {
                    let claim = state.claim.as_ref().ok_or_else(|| {
                        ToolError::CleanupUnconfirmed(
                            "active native headers lost their owned claim".into(),
                        )
                    })?;
                    let cleared = scope
                        .dispatch(scope.control.clear_scoped_headers(claim))
                        .await;
                    self.reconcile_provider(owner, &provider).await?;
                    if !cleared.map_err(provider::native_error)?.cleanup_confirmed {
                        return Err(ToolError::CleanupUnconfirmed(
                            "native scoped headers remain after Stop".into(),
                        ));
                    }
                }
                if capabilities.cursor_presentation_owner == NativeEffectOwner::Host {
                    self.cleanup_native_control(owner, identity).await?;
                }
                if let Some(claim) = &state.claim {
                    let drain = scope
                        .dispatch(
                            scope
                                .control
                                .wait_claim_cdp_drained(claim, Duration::from_secs(10)),
                        )
                        .await
                        .map_err(provider::native_error)?;
                    self.tabs
                        .get_mut(identity)
                        .and_then(|lease| lease.native.as_mut())
                        .ok_or_else(|| unknown("native drain lost its exact claim"))?
                        .cdp_drain = Some(drain);
                    if self.reconcile_provider(owner, &provider).await? {
                        return Err(ToolError::CleanupUnconfirmed(
                            "native CDP settled but retained operation custody is still pending"
                                .into(),
                        ));
                    }
                }
                match origin {
                    Origin::UserClaimed if !state.released => {
                        if let Some(claim) = &state.claim {
                            self.begin_native_cleanup(identity)?;
                            let detached = scope.dispatch(scope.control.detach_tab(claim)).await;
                            self.reconcile_provider(owner, &provider).await?;
                            detached.map_err(provider::native_error)?;
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
                                .native
                                .as_mut()
                                .unwrap()
                                .released = true;
                        }
                    }
                    Origin::AgentCreated
                        if capabilities.turn_lifecycle_owner == NativeEffectOwner::Host
                            && !state.closed =>
                    {
                        let receipt = state.creation.as_ref().ok_or_else(|| {
                            ToolError::CleanupUnconfirmed("created tab lost its receipt".into())
                        })?;
                        self.begin_native_cleanup(identity)?;
                        let stopped = scope
                            .dispatch(scope.control.stop_created_tab(receipt))
                            .await;
                        self.reconcile_provider(owner, &provider).await?;
                        stopped.map_err(provider::native_error)?;
                    }
                    _ => {}
                }
            }
            if capabilities.turn_lifecycle_owner == NativeEffectOwner::Provider {
                let phase = self
                    .native
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
                    None => false,
                };
                if !acknowledged {
                    self.native
                        .get_mut(&(owner, browser.clone()))
                        .ok_or_else(|| unknown("native finish owner retired"))?
                        .finish_phases
                        .insert(cleanup_turn.clone(), FinishPhase::Pending);
                    let finish = scope.dispatch(scope.control.finish_turn(None)).await;
                    self.reconcile_provider(owner, &provider).await?;
                    finish.map_err(provider::native_error)?;
                }
                // The logical ACK is deliberately insufficient. This operation
                // obtains the adapter's independently established tab-removal
                // proof; the Original adapter observes, without closing again.
                for identity in &identities {
                    let lease = &self.tabs[identity];
                    let state = lease.native.as_ref().unwrap();
                    if lease.origin == Origin::AgentCreated && !state.closed {
                        let receipt = state.creation.clone().ok_or_else(|| {
                            ToolError::CleanupUnconfirmed("created tab lost its receipt".into())
                        })?;
                        self.begin_native_cleanup(identity)?;
                        let stopped = scope
                            .dispatch(scope.control.stop_created_tab(&receipt))
                            .await;
                        self.reconcile_provider(owner, &provider).await?;
                        stopped.map_err(provider::native_error)?;
                    }
                }
            } else if capabilities.turn_lifecycle_owner == NativeEffectOwner::Unavailable {
                return Err(ToolError::CleanupUnconfirmed(
                    "native adapter has no turn cleanup implementation".into(),
                ));
            }
            if let Some(uncertain) = uncertain {
                if let Some(receipt) = uncertain.native {
                    let stopped = scope
                        .dispatch(scope.control.stop_created_tab(&receipt))
                        .await;
                    self.reconcile_provider(owner, &provider).await?;
                    stopped.map_err(provider::native_error)?;
                } else {
                    return Err(ToolError::CleanupUnconfirmed("native tab creation outcome remains unknown without a recoverable receipt; creation was not replayed".into()));
                }
            }
            for identity in identities {
                self.retire_native_cleanup(owner, &provider, &identity, &scope.control)
                    .await?;
                let lease = &self.tabs[&identity];
                let state = lease.native.as_ref().unwrap();
                let complete = match lease.origin {
                    Origin::AgentCreated => state.closed,
                    Origin::UserClaimed => state.released,
                };
                if !complete {
                    return Err(ToolError::CleanupUnconfirmed(
                        "native tab lacks its physical cleanup proof".into(),
                    ));
                }
                if lease.origin == Origin::AgentCreated {
                    closed.push(identity.clone());
                }
                self.tabs.remove(&identity);
            }
            if let Some(state) = self.native.get_mut(&(owner, browser))
                && state.current_turn.as_deref() == Some(&cleanup_turn)
            {
                state.logical_active = None;
                state.current_turn = None;
                state.retiring_turn = None;
                state.finish_phases.remove(&cleanup_turn);
            }
        }
        Ok(closed)
    }
}

fn same_popup(left: &NativePopupRequest, right: &NativePopupRequest) -> bool {
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

async fn dispatch_native_popups(
    host: &Arc<tokio::sync::Mutex<Host>>,
    owner: uuid::Uuid,
    provider: &Provider,
) -> Result<(), ToolError> {
    let native = provider
        .native()
        .ok_or_else(|| failed("native provider required"))?;
    let browser = BrowserIdentity::of(provider, &native.identity().generation)?;
    loop {
        let next = {
            let mut ledger = host.lock().await;
            let pending = native
                .pending_operations()
                .await
                .map_err(provider::native_error)?;
            let mut next = None;
            for completion in pending {
                let NativeOperation::PopupRequested { request } = &completion.operation else {
                    continue;
                };
                if completion.provider != *native.identity()
                    || completion.outcome.is_none()
                    || completion.host_operation.is_some()
                    || !ledger.native_popup_current(owner, provider, request)
                    || ledger
                        .native
                        .get(&(owner, browser.clone()))
                        .is_none_or(|state| state.applied.contains(&completion.id))
                {
                    continue;
                }
                let Some(scope) = ledger
                    .tabs
                    .get(&browser.tab(&request.tab_id().to_string()))
                    .and_then(|lease| lease.native.as_ref())
                    .and_then(|state| state.lease_children.clone())
                    .filter(|scope| {
                        scope.turn == request.wire_context().host_turn_id()
                            && scope.effects.supports_lease_children()
                    })
                else {
                    continue;
                };
                let recovered = native
                    .recover_completion(completion.id)
                    .await
                    .map_err(provider::native_error)?;
                if !matches!(recovered, NativeRecoveredOperation::PopupRequested(ref actual)
                    if same_popup(request, actual))
                {
                    return Err(unknown(
                        "native popup metadata changed before Host admission",
                    ));
                }
                let request = crate::BrowserLeaseChildRequest {
                    browser_id: provider.id().to_owned(),
                    generation: native.identity().generation.clone(),
                    native_owner: owner,
                    native_epoch: scope.epoch.to_string(),
                    turn_id: scope.turn,
                    completion_id: completion.id,
                    opener_claim_id: request.claim_id().to_owned(),
                    opener_tab_id: request.tab_id(),
                    url: request.url().to_owned(),
                };
                // The same retained CONTROL receipt owns the intent throughout
                // service execution and any uncertainty. This marker only
                // prevents dispatching that original intent more than once.
                ledger
                    .native
                    .get_mut(&(owner, browser.clone()))
                    .ok_or_else(|| failed("native popup provider owner retired"))?
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
                .and_then(|lease| lease.native.as_mut())
            {
                state.presentation_error = result.as_ref().err().map(ToString::to_string);
            }
            // The terminal Unknown is not a physical drain. The actual Host
            // service retains its own native/root custody; retain this original
            // metadata and its once marker independently as well.
        } else {
            native
                .acknowledge_completion(completion_id)
                .await
                .map_err(provider::native_error)?;
            if let Some(state) = ledger.native.get_mut(&(owner, browser.clone())) {
                state.applied.remove(&completion_id);
            }
        }
    }
}

async fn register(
    host: &Arc<tokio::sync::Mutex<Host>>,
    owner: uuid::Uuid,
    provider: &Provider,
) -> Result<(), ToolError> {
    let Some(connection) = provider.native() else {
        return Ok(());
    };
    let browser = BrowserIdentity::of(provider, &connection.identity().generation)?;
    let key = (owner, browser.clone());
    let mut ledger = host.lock().await;
    if ledger.native.contains_key(&key) {
        return Ok(());
    }
    ledger.native.insert(
        key,
        ProviderState {
            provider: provider.clone(),
            current_turn: None,
            retiring_turn: None,
            logical_active: None,
            calls: HashMap::new(),
            applied: HashSet::new(),
            finish_phases: HashMap::new(),
            session_headers: None,
            headers_unknown: false,
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
                                    dispatch_native_popups(&host, owner, &provider).await
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
            let mut ledger = host.lock().await;
            if !ledger.native.contains_key(&(owner, browser.clone())) {
                break;
            }
            match event {
                Ok(NativeProviderEvent::CompletionReady { .. })
                | Ok(NativeProviderEvent::ClaimCdpProgress { .. })
                | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let _ = ledger.reconcile_provider(owner, &provider).await;
                    drop(ledger);
                    if popup_dispatch.is_none() {
                        let host = host.clone();
                        let provider = provider.clone();
                        popup_dispatch = Some(Box::pin(async move {
                            dispatch_native_popups(&host, owner, &provider).await
                        }));
                    } else {
                        popup_dirty = true;
                    }
                }
                Ok(NativeProviderEvent::ClaimUnavailable { claim, reason }) => {
                    for lease in ledger.tabs.values_mut().filter(|lease| {
                        lease.creator.owner == owner && lease.creator.provider == provider
                    }) {
                        if let Some(state) = &mut lease.native
                            && state
                                .claim
                                .as_ref()
                                .is_some_and(|owned| owned.claim_id() == claim)
                        {
                            state.revoked = true;
                            if state.cleanup_started {
                                // A started cleanup is not evidence that this
                                // revocation was expected. Keep the observation;
                                // only canonical exact cleanup+drain proofs can
                                // establish physical retirement below.
                                state.cleanup_revocation.get_or_insert(reason.clone());
                            } else {
                                state.unknown = Some(reason.clone());
                            }
                        }
                    }
                }
                Ok(NativeProviderEvent::GenerationClosed { reason }) => {
                    for lease in ledger.tabs.values_mut().filter(|lease| {
                        lease.creator.owner == owner && lease.creator.provider == provider
                    }) {
                        if let Some(state) = &mut lease.native {
                            state.unknown = Some(reason.clone());
                            lease.disposition = Disposition::Closing;
                        }
                    }
                    break;
                }
                Ok(NativeProviderEvent::TabStateChanged { tab_id, active, .. }) => {
                    if let Some(lease) = ledger.tabs.get_mut(&browser.tab(&tab_id.to_string()))
                        && let Some(state) = &mut lease.native
                    {
                        state.active = active;
                    }
                    drop(ledger);
                    let _ = refresh_control(&host, owner, &browser, tab_id, active).await;
                }
                Ok(NativeProviderEvent::TabStateUnknown { tab_id, error, .. }) => {
                    if let Some(state) = ledger
                        .tabs
                        .get_mut(&browser.tab(&tab_id.to_string()))
                        .and_then(|lease| lease.native.as_mut())
                    {
                        state.active = false;
                        state.presentation_error = Some(error.message);
                    }
                    drop(ledger);
                    let _ = refresh_control(&host, owner, &browser, tab_id, false).await;
                }
                Ok(
                    NativeProviderEvent::EffectsCleanup { .. }
                    | NativeProviderEvent::OrphanCdpCompletion { .. },
                ) => {
                    let _ = ledger.reconcile_provider(owner, &provider).await;
                }
                Ok(NativeProviderEvent::PopupRequested { .. }) => {
                    let _ = ledger.reconcile_provider(owner, &provider).await;
                    drop(ledger);
                    if popup_dispatch.is_none() {
                        let host = host.clone();
                        let provider = provider.clone();
                        popup_dispatch = Some(Box::pin(async move {
                            dispatch_native_popups(&host, owner, &provider).await
                        }));
                    } else {
                        popup_dirty = true;
                    }
                }
                Ok(
                    NativeProviderEvent::RouteUnavailable { .. }
                    | NativeProviderEvent::DownloadChanged { .. },
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
    pub(super) async fn native_managed(
        &self,
        provider: &Provider,
        generation: &str,
        target: &str,
    ) -> Result<bool, ToolError> {
        let identity = BrowserIdentity::of(provider, generation)?.tab(target);
        let host = self.host().await;
        let ledger = host.lock().await;
        ledger.known(&identity.browser)?;
        Ok(ledger.tabs.get(&identity).is_some_and(|lease| {
            lease.creator.owner == self.owner
                && matches!(lease.disposition, Disposition::Live)
                && (lease.origin == Origin::AgentCreated
                    || lease.native.as_ref().is_some_and(|state| {
                        !state.revoked
                            && state
                                .claim
                                .as_ref()
                                .is_some_and(|claim| !claim.is_cleanup_only())
                    }))
        }))
    }
    pub(super) async fn managed_tabs(&self, browser_id: &str) -> Result<Value, ToolError> {
        let provider = self.providers(Some(browser_id))?.pop().unwrap();
        let Some(native) = provider.native() else {
            let (_, tabs) = self.visible_inventory(&provider).await?;
            return Ok(json!(
                tabs.iter()
                    .map(|tab| super::tab_info(&provider, tab))
                    .collect::<Vec<_>>()
            ));
        };
        let generation = native.identity().generation.clone();
        let browser = BrowserIdentity::of(&provider, &generation)?;
        let host = self.host().await;
        let mut leased = {
            let ledger = host.lock().await;
            ledger.known(&browser)?;
            ledger
                .tabs
                .iter()
                .filter_map(|(identity, lease)| {
                    (identity.browser == browser
                        && lease.creator.owner == self.owner
                        && matches!(lease.disposition, Disposition::Live))
                    .then(|| {
                        lease
                            .native_sequence
                            .map(|sequence| (sequence, identity.target.clone()))
                    })
                    .flatten()
                })
                .collect::<Vec<_>>()
        };
        leased.sort_unstable_by_key(|(sequence, _)| *sequence);
        let mut managed = Vec::new();
        for (_, id) in leased {
            let tab = native
                .resolve_user_tab(&id)
                .await
                .map_err(provider::native_error)?;
            if native.is_closed() || native.identity().generation != generation {
                return Err(failed("native managed-tab generation changed"));
            }
            if !tab.url.as_deref().is_some_and(is_internal_url) {
                managed.push(managed_tab_info(&tab));
            }
        }
        Ok(json!(managed))
    }
    pub(super) async fn reconcile_native_command(
        &mut self,
        command: &Command,
    ) -> Result<(), ToolError> {
        let selected = match command {
            Command::BrowserTab { browser_id, .. }
            | Command::BrowserManagedTabs { browser_id }
            | Command::BrowserUserOpenTabs { browser_id }
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
            | Command::TabMetadata { handle }
            | Command::ClipboardRead { handle }
            | Command::ClipboardReadText { handle }
            | Command::ClipboardWrite { handle, .. }
            | Command::ClipboardWriteText { handle, .. }
            | Command::GetJsDialog { handle }
            | Command::HandleJsDialog { handle, .. }
            | Command::BrowserRead { handle, .. }
            | Command::BrowserMutation { handle, .. } => match handle {
                Handle::Tab(id) => self.targets.get(id).map(|tab| tab.provider.clone()),
                Handle::App(_) => None,
            },
            _ => None,
        };
        let Some(provider) = selected.filter(|provider| provider.native().is_some()) else {
            return Ok(());
        };
        self.reconcile_native_provider(&provider).await
    }

    async fn reconcile_native_provider(&self, provider: &Provider) -> Result<(), ToolError> {
        let host = self.host().await;
        register(&host, self.owner, provider).await?;
        if host
            .lock()
            .await
            .reconcile_provider(self.owner, provider)
            .await?
        {
            return Err(ToolError::CleanupUnconfirmed(
                "a previous native mutation is still in flight".into(),
            ));
        }
        Ok(())
    }
    pub(super) async fn user_tabs(&self, browser_id: &str) -> Result<Value, ToolError> {
        let provider = self.providers(Some(browser_id))?.pop().unwrap();
        let native=provider.native().ok_or_else(||failed("browser.user is not implemented for the configured CDP provider; select a connected native adapter"))?;
        let tabs = native
            .list_user_tabs()
            .await
            .map_err(provider::native_error)?;
        let tabs = ordered_user_tabs(
            tabs,
            native
                .capabilities()
                .map_err(provider::native_error)?
                .user_tabs_order,
        );
        let identity = BrowserIdentity::of(&provider, &native.identity().generation)?;
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
    pub(super) async fn claim_user_tab(
        &mut self,
        browser_id: &str,
        raw: &str,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let provider = self.providers(Some(browser_id))?.pop().unwrap();
        let native = provider
            .native()
            .ok_or_else(|| failed("browser.user.claimTab requires a connected native adapter"))?;
        check_input(cancellation)?;
        self.reconcile_native_provider(&provider).await?;
        let info = native
            .resolve_user_tab(raw)
            .await
            .map_err(provider::native_error)?;
        let mut bound = self
            .bind(
                TabSource {
                    provider: provider.clone(),
                    generation: native.identity().generation.clone(),
                    info: provider::native_tab(info),
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
        let tab = self.targets.get_mut(&handle).unwrap();
        tab.authorize_with_intent(
            None,
            invocation,
            cancellation,
            language,
            ClaimIntent::Explicit,
        )
        .await?;
        bound["id"] = json!(tab.info.id);
        Ok(bound)
    }
    pub(crate) async fn adopt_native_popup(
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
                "native popup handling is disabled by the current Host policy",
            ));
        }
        if request.native_owner != self.owner
            || request.native_epoch != self.epoch.to_string()
            || request.turn_id != invocation.turn()
        {
            return Err(failed(
                "native popup belongs to another owner, epoch or turn",
            ));
        }
        let provider = self
            .providers(Some(&request.browser_id))?
            .pop()
            .ok_or_else(|| failed("native popup browser is unavailable"))?;
        let native = provider
            .native()
            .ok_or_else(|| failed("native popup requires its original native provider"))?
            .clone();
        if native.identity().generation != request.generation {
            return Err(failed("native popup generation changed before admission"));
        }
        validate_url(&request.url)?;
        let browser = BrowserIdentity::of(&provider, &request.generation)?;
        let host = self.host().await;
        let (scope, opener, source) = {
            let mut ledger = host.lock().await;
            let completion = native
                .pending_operations()
                .await
                .map_err(provider::native_error)?
                .into_iter()
                .find(|entry| entry.id == request.completion_id)
                .ok_or_else(|| failed("native popup intent is no longer retained"))?;
            let NativeOperation::PopupRequested { request: actual } = &completion.operation else {
                return Err(failed("native popup id does not name a popup intent"));
            };
            if completion.provider != *native.identity()
                || completion.outcome.is_none()
                || completion.host_operation.is_some()
                || actual.claim_id() != request.opener_claim_id
                || actual.tab_id() != request.opener_tab_id
                || actual.url() != request.url
                || actual.wire_context().host_session_id() != self.owner.to_string()
                || actual.wire_context().host_turn_id() != request.turn_id
                || !ledger.native_popup_current(self.owner, &provider, actual)
            {
                return Err(failed("native popup lost its exact live source lease"));
            }
            let recovered = native
                .recover_completion(request.completion_id)
                .await
                .map_err(provider::native_error)?;
            if !matches!(recovered, NativeRecoveredOperation::PopupRequested(ref retained)
                if same_popup(actual, retained))
            {
                return Err(unknown("native popup retained metadata changed"));
            }
            let state = ledger
                .tabs
                .get(&browser.tab(&request.opener_tab_id.to_string()))
                .and_then(|lease| lease.native.as_ref())
                .ok_or_else(|| failed("native popup opener custody is unavailable"))?;
            if state
                .lease_children
                .as_ref()
                .is_none_or(|scope| scope.epoch != self.epoch || scope.turn != request.turn_id)
                || ledger
                    .native
                    .get(&(self.owner, browser.clone()))
                    .is_none_or(|state| !state.applied.contains(&request.completion_id))
            {
                return Err(failed(
                    "native popup was not issued by its prepared source lease",
                ));
            }
            let opener = state
                .claim
                .clone()
                .ok_or_else(|| failed("native popup opener has no physical claim"))?;
            // Only the real service InvocationContext supplies this operation;
            // the popup metadata and old preparation scope supply no cause ID.
            let scope = ledger.native_context(
                self.owner,
                &provider,
                operation(invocation)?,
                self.epoch,
                Origin::AgentCreated,
                Some(request.opener_tab_id.to_string()),
                true,
            )?;
            (scope, opener, actual.clone())
        };
        let preparation = scope
            .authorize_preparation(
                &host,
                invocation,
                crate::BrowserPreparationTarget::PendingCreation,
                cancellation,
            )
            .await?;
        scope
            .check_preparation(&host, invocation, &preparation, cancellation)
            .await?;
        let created = scope
            .dispatch(scope.control.create_popup_tab(&opener))
            .await;
        host.lock()
            .await
            .reconcile_provider(self.owner, &provider)
            .await?;
        // A lost creation reply is already in the existing Created/Unknown
        // ledger, including a real creation receipt without an observed tab ID.
        let created = created.map_err(provider::native_error)?;
        let source_live = host
            .lock()
            .await
            .native_popup_current(self.owner, &provider, &source);
        if !source_live || cancellation.is_cancelled() {
            let cleanup = scope
                .dispatch(scope.control.stop_created_tab(created.creation_receipt()))
                .await;
            host.lock()
                .await
                .reconcile_provider(self.owner, &provider)
                .await?;
            cleanup.map_err(provider::native_error)?;
            return Err(failed("native popup source expired after child creation"));
        }
        let BoundNativeCreated {
            response,
            handle,
            identity,
        } = self
            .bind_native_created(
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
                .ok_or_else(|| unknown("native popup child binding disappeared"))?;
            child
                .prepare_metadata(invocation, cancellation, language)
                .await?;
            let origin = child.document_origin().await?;
            if origin.document_identity().url() != "about:blank"
                || origin.origin() != crate::BrowserAttachmentOrigin::Opaque
            {
                return Err(unknown(
                    "created native popup is not the verified opaque blank document",
                ));
            }
            origin.check_current(child).await?;
            // The Host service permits this verified opaque blank preparation
            // under current global policy. It grants no destination Site read.
            child
                .authorize(None, invocation, cancellation, language)
                .await?;
            origin.check_current(child).await?;
        }
        if let Some(state) = host
            .lock()
            .await
            .native
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
            .ok_or_else(|| unknown("native popup child binding disappeared"))?;
        child
            .authorize(Some(&request.url), invocation, cancellation, language)
            .await?;
        child.connect_metadata().await?;
        child.check_navigation(&request.url).await?;
        {
            let ledger = host.lock().await;
            let source_live = ledger.native_popup_current(self.owner, &provider, &source);
            if !source_live
                || ledger
                    .native
                    .get(&(self.owner, browser))
                    .is_none_or(|state| {
                        state.current_turn.as_deref() != Some(request.turn_id.as_str())
                            || state.retiring_turn.is_some()
                            || state.logical_active.as_deref() != Some(identity.target.as_str())
                    })
            {
                return Err(failed(
                    "native popup source or logical child expired before navigation",
                ));
            }
        }
        check_input(cancellation)?;
        child.refs.clear();
        let navigated = child
            .request("Page.navigate", json!({"url":request.url}))
            .await?;
        if let Some(error) = navigated.get("errorText") {
            return Err(failed(format!("native popup navigation failed: {error}")));
        }
        // Readiness/AX/content observation requires an independently admitted
        // destination read; this service only retains the navigation loader.
        child.navigation = navigated["loaderId"]
            .as_str()
            .map(|loader| Navigation::Loader(loader.into()));
        Ok(response)
    }

    async fn bind_native_created(
        &mut self,
        provider: &Provider,
        scope: &CallScope,
        created: NativeCreatedTab,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<BoundNativeCreated, ToolError> {
        let native = provider
            .native()
            .ok_or_else(|| failed("native provider required"))?;
        let capabilities = native.capabilities().map_err(provider::native_error)?;
        let host = self.host().await;
        let identity = BrowserIdentity::of(provider, &native.identity().generation)?
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
        match native
            .capabilities()
            .map_err(provider::native_error)?
            .created_presentation_owner
        {
            NativeEffectOwner::Provider => {}
            NativeEffectOwner::Unavailable => {
                return Err(failed(
                    "native adapter cannot prepare created-tab presentation",
                ));
            }
            NativeEffectOwner::Host => {
                scope
                    .check_preparation(&host, invocation, &preparation, cancellation)
                    .await?;
                scope
                    .dispatch(scope.control.mute_created_tab(&receipt))
                    .await
                    .map_err(provider::native_error)?;
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
                        lease.native.as_ref().and_then(|state| state.group.clone())
                    });
                let presentation = NativeGroupPresentation {
                    title: Some("Maka".into()),
                    color: Some(NativeGroupColor::Blue),
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
                    .map_err(provider::native_error)?;
                host.lock()
                    .await
                    .reconcile_provider(self.owner, provider)
                    .await?;
            }
        }
        let info = if capabilities.created_presentation_owner == NativeEffectOwner::Provider {
            created.tab.clone()
        } else {
            scope
                .check_preparation(&host, invocation, &preparation, cancellation)
                .await?;
            scope
                .dispatch(scope.control.resolve_user_tab(&created.tab.id.to_string()))
                .await
                .map_err(provider::native_error)?
        };
        let bound = self
            .bind(
                TabSource {
                    provider: provider.clone(),
                    generation: native.identity().generation.clone(),
                    info: provider::native_tab(info),
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
        Ok(BoundNativeCreated {
            response: bound,
            handle,
            identity,
        })
    }

    pub(super) async fn create_native(
        &mut self,
        provider: Provider,
        url: Option<String>,
        initial: InitialState,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
    ) -> Result<Value, ToolError> {
        let native = provider.native().unwrap().clone();
        let host = self.host().await;
        register(&host, self.owner, &provider).await?;
        let scope = host.lock().await.native_context(
            self.owner,
            &provider,
            operation(invocation)?,
            self.epoch,
            Origin::AgentCreated,
            None,
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
        let capabilities = native.capabilities().map_err(provider::native_error)?;
        let headers = preparation_headers(invocation);
        if capabilities.header_scope == NativeHeaderPolicyScope::Session && !headers.is_empty() {
            let browser = BrowserIdentity::of(&provider, &native.identity().generation)?;
            let active = host
                .lock()
                .await
                .native
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
                applied.map_err(provider::native_error)?;
            }
        }
        let preferred = if capabilities.created_presentation_owner == NativeEffectOwner::Host {
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
                            .native
                            .as_ref()
                            .and_then(|state| state.group.as_ref())
                            .map(NativeManagedGroupReceipt::window_id)
                    });
                let active = ledger
                    .native
                    .get(&(
                        self.owner,
                        BrowserIdentity::of(&provider, &native.identity().generation)?,
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
                        .dispatch(scope.control.resolve_user_tab(&tab))
                        .await
                        .map_err(provider::native_error)?
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
        let created = created.map_err(provider::native_error)?;
        let BoundNativeCreated {
            response: mut bound,
            handle,
            identity,
        } = self
            .bind_native_created(
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
            .native
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
    pub(super) async fn native_control_diagnostic(&self) -> Option<String> {
        let identity = self.identity().ok()?;
        self.cursor_host
            .lock()
            .await
            .tabs
            .get(&identity)
            .and_then(|lease| lease.native.as_ref())
            .and_then(|state| state.presentation_error.clone())
    }
    pub(super) async fn native_cursor_presentation(
        &mut self,
        point: Option<[f64; 2]>,
        operation: &str,
    ) -> Result<Option<Value>, ToolError> {
        let Some(native) = self.provider.native().cloned() else {
            return Ok(None);
        };
        let capabilities = native.capabilities().map_err(provider::native_error)?;
        match capabilities.cursor_presentation_owner {
            NativeEffectOwner::Host => return Ok(None),
            NativeEffectOwner::Unavailable => {
                return Err(failed(
                    "native adapter does not provide cursor presentation",
                ));
            }
            NativeEffectOwner::Provider => {}
        }
        if operation != "update" {
            return if matches!(operation, "hide" | "remove" | "finalize") {
                Err(failed(
                    "native provider cursor hiding has no acknowledged transport operation",
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
                "stale_document: observe before showing the native cursor",
            ));
        }
        let claim = self
            .native_claim
            .clone()
            .ok_or_else(|| failed("native cursor requires the current admitted claim"))?;
        let context = self
            .native_host_operation
            .clone()
            .ok_or_else(|| failed("native cursor requires its original Host operation"))?;
        let scope = self.cursor_host.lock().await.native_context(
            self.cursor_owner,
            &self.provider,
            context,
            self.cursor_epoch,
            Origin::UserClaimed,
            Some(self.info.id.clone()),
            false,
        )?;
        let shown = scope
            .dispatch(scope.control.move_mouse_presentation(&claim, x, y, None))
            .await;
        self.cursor_host
            .lock()
            .await
            .reconcile_provider(self.cursor_owner, &self.provider)
            .await?;
        let shown = shown.map_err(provider::native_error)?;
        Ok(Some(
            json!({"providerManaged":true,"presentationAcknowledged":true,"point":[shown.requested_x,shown.requested_y]}),
        ))
    }
    /// Admit only an adapter whose existing attachment transport does not run
    /// content preparers. The caller has already obtained Host Metadata admission.
    pub(super) async fn attach_native_metadata(
        &mut self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
    ) -> Result<(), ToolError> {
        let native = self
            .provider
            .native()
            .cloned()
            .ok_or_else(|| failed("native provider required"))?;
        let host = self.cursor_host.clone();
        register(&host, self.cursor_owner, &self.provider).await?;
        let identity = self.identity()?;
        host.lock().await.native_reserve(
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
            .and_then(|lease| lease.native.as_ref())
            .and_then(|state| state.claim.clone());
        if existing.is_none()
            && native
                .capabilities()
                .map_err(provider::native_error)?
                .attachment_preparation
                != NativeAttachmentPreparation::MetadataOnly
        {
            return Err(failed(
                "selected native attachment runs content preparation; a metadata-only attachment path has not been established",
            ));
        }
        let scope = host.lock().await.native_context(
            self.cursor_owner,
            &self.provider,
            operation(invocation)?,
            self.cursor_epoch,
            Origin::UserClaimed,
            Some(self.info.id.clone()),
            true,
        )?;
        check_input(cancellation)?;
        if existing.is_none()
            && (is_new_tab(&self.info.url)
                || self
                    .info
                    .native
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
                ledger.native_preparation_current(&scope, &preparation)?;
                ledger
                    .tabs
                    .get_mut(&identity)
                    .and_then(|lease| lease.native.as_mut())
                    .ok_or_else(|| unknown("new-tab normalization lost reserved custody"))?
                    .user_preparation = UserPreparation::Pending;
            }
            let prepared = scope.dispatch(scope.control.prepare_user_tab(raw_id)).await;
            host.lock()
                .await
                .reconcile_provider(self.cursor_owner, &self.provider)
                .await?;
            let prepared = match prepared {
                Ok(prepared) => prepared,
                Err(error) => {
                    host.lock()
                        .await
                        .native_preparation_failed(&identity, &error);
                    return Err(provider::native_error(error));
                }
            };
            if prepared.tab.id.to_string() != self.info.id
                || prepared.tab.url.as_deref() != Some("about:blank")
            {
                return Err(failed(
                    "new-tab document changed during metadata normalization",
                ));
            }
            self.info = provider::native_tab(prepared.tab);
            self.origin_proof = None;
        }
        let newly_attached = existing.is_none();
        if newly_attached {
            host.lock()
                .await
                .tabs
                .get_mut(&identity)
                .and_then(|lease| lease.native.as_mut())
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
                attached.map_err(provider::native_error)?;
                host.lock()
                    .await
                    .tabs
                    .get(&identity)
                    .and_then(|lease| lease.native.as_ref())
                    .and_then(|state| state.claim.clone())
                    .ok_or_else(|| {
                        unknown("metadata attachment has not been committed to Host custody")
                    })?
            }
        };
        self.native_claim = Some(claim);
        self.native_wire = Some(
            cua_driver_core::browser::NativeWireContext::new(
                self.cursor_owner.to_string(),
                invocation.turn(),
            )
            .map_err(failed)?,
        );
        self.native_host_operation = Some(operation(invocation)?);
        self.native_acquired = true;
        if let Some(socket) = &mut self.socket {
            socket.native_context = self.native_wire.clone();
        }
        check_input(cancellation)
    }

    async fn prepare_claim_native(
        &mut self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        scope: &CallScope,
        claim: &NativePhysicalClaim,
    ) -> Result<(), ToolError> {
        let origin = self.document_origin().await?;
        invocation
            .authorize_browser(origin.access(), cancellation)
            .await?;
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
                        failed("native popup preparation requires fresh Host lease-child custody")
                    })?,
            )
        } else {
            None
        };
        let identity = origin.document_identity();
        let document = NativePreparationDocument {
            frame_id: identity.frame_id().to_owned(),
            loader_id: identity.loader_id().to_owned(),
            url: identity.url().to_owned(),
        };
        let headers = preparation_headers(invocation);
        let policy = Arc::new(NativePreparationPolicy {
            popup_enabled: invocation.browser_preparation_policy().effective_popup(),
            header_enabled: !headers.is_empty(),
            headers,
        });
        let wire = NativeWireContext::new(self.cursor_owner.to_string(), invocation.turn())
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
        {
            let mut ledger = host.lock().await;
            check_input(cancellation)?;
            ledger.native_preparation_current(scope, &preparation)?;
            let lease = ledger
                .tabs
                .get_mut(&identity)
                .ok_or_else(|| unknown("native preparation lost reserved custody"))?;
            if lease.creator.owner != self.cursor_owner
                || !matches!(lease.disposition, Disposition::Live)
            {
                return Err(unknown(
                    "native preparation lost its live Host source lease",
                ));
            }
            let state = lease
                .native
                .as_mut()
                .ok_or_else(|| unknown("native preparation lost physical custody"))?;
            if state
                .claim
                .as_ref()
                .is_none_or(|owned| owned.claim_id() != claim.claim_id())
            {
                return Err(unknown("native preparation changed its physical claim"));
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
                ClaimPreparation::Unknown { reason, .. } => return Err(unknown(reason)),
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
            state.claim_preparation = ClaimPreparation::Pending(Arc::new(PreparationAttempt {
                document: document.clone(),
                policy: policy.clone(),
                wire,
                operation: operation.clone(),
                previous,
                effects,
            }));
        }
        let prepared = scope
            .dispatch(scope.control.prepare_claim(claim, &document, &policy))
            .await;
        let mut ledger = host.lock().await;
        match &prepared {
            Ok(proof) => ledger.apply_claim_preparation(
                self.cursor_owner,
                &self.provider,
                Some(&operation),
                proof.clone(),
            )?,
            Err(cua_driver_core::browser::NativeProviderError::Refused { .. }) => {
                if let Some(state) = ledger
                    .tabs
                    .get_mut(&identity)
                    .and_then(|lease| lease.native.as_mut())
                {
                    state.finish_preparation_error(
                        Some(&operation),
                        true,
                        "native preparation was not dispatched",
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
            .ok_or_else(|| unknown("native preparation result lost its lease"))?;
        let state = lease
            .native
            .as_mut()
            .ok_or_else(|| unknown("native preparation result lost physical custody"))?;
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
                    "native preparation ACK is not active in Host custody",
                )),
                Err(error) => {
                    if !matches!(
                        &error,
                        cua_driver_core::browser::NativeProviderError::Refused { .. }
                    ) {
                        state.finish_preparation_error(Some(&operation), false, &error.to_string());
                        lease.disposition = Disposition::Closing;
                    }
                    Err(provider::native_error(error))
                }
            }
        };
        drop(ledger);
        result?;
        check_input(cancellation)?;
        invocation
            .browser_authorization()
            .ok_or_else(|| failed("native preparation requires the current Host authorization"))?
            .check(origin.access(), cancellation.clone())
            .await?;
        origin.check_current(self).await?;
        check_input(cancellation)
    }

    /// Acquire the existing native session transport under its bounded Host
    /// purpose. This installs no Host content attachment or focus/overlay.
    pub(super) async fn prepare_native_session(
        &mut self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
        intent: ClaimIntent,
    ) -> Result<(), ToolError> {
        let Some(native) = self.provider.native().cloned() else {
            return Ok(());
        };
        let host = self.cursor_host.clone();
        register(&host, self.cursor_owner, &self.provider).await?;
        let identity = self.identity()?;
        let context = operation(invocation)?;
        let scope = {
            let mut ledger = host.lock().await;
            ledger.native_reserve(
                self.cursor_owner,
                &self.provider,
                invocation.turn(),
                &self.info.id,
                Origin::UserClaimed,
            )?;
            ledger.native_context(
                self.cursor_owner,
                &self.provider,
                context.clone(),
                self.cursor_epoch,
                Origin::UserClaimed,
                Some(self.info.id.clone()),
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
            .ok_or_else(|| failed("native session preparation requires Host effect custody"))?;
        let _settlement = invocation
            .operation_settlement()
            .ok_or_else(|| failed("native session preparation requires Host settlement custody"))?;
        let capabilities = native.capabilities().map_err(provider::native_error)?;
        let prior = host
            .lock()
            .await
            .tabs
            .get(&identity)
            .and_then(|lease| lease.native.clone())
            .ok_or_else(|| failed("native claim reservation missing"))?;
        let already_prepared = prior.session_prepared_operation.as_ref() == Some(&context);
        let headers = preparation_headers(invocation);
        if !already_prepared
            && !capabilities.explicit_claim_preparation
            && capabilities.header_scope == NativeHeaderPolicyScope::Session
            && !headers.is_empty()
        {
            let active = host
                .lock()
                .await
                .native
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
                applied.map_err(provider::native_error)?;
            }
        }
        let user_prepared = prior.user_prepared_operation.as_ref() == Some(&context);
        let needs_user_preparation = !already_prepared
            && !user_prepared
            && (!matches!(prior.user_preparation, UserPreparation::Completed)
                || intent == ClaimIntent::Explicit);
        let changes_logical_active =
            prior.metadata_attached || prior.claim.is_none() || needs_user_preparation;
        if needs_user_preparation {
            match &prior.user_preparation {
                UserPreparation::Pending => {
                    return Err(ToolError::CleanupUnconfirmed(
                        "native user-tab preparation remains unsettled; it was not replayed".into(),
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
                ledger.native_preparation_current(&scope, &preparation)?;
                ledger
                    .tabs
                    .get_mut(&identity)
                    .and_then(|lease| lease.native.as_mut())
                    .ok_or_else(|| unknown("native preparation lost reserved custody"))?
                    .user_preparation = UserPreparation::Pending;
            }
            let prepared = scope.dispatch(scope.control.prepare_user_tab(raw_id)).await;
            host.lock()
                .await
                .reconcile_provider(self.cursor_owner, &self.provider)
                .await?;
            match prepared {
                Ok(prepared) => {
                    if prepared.tab.id.to_string() != self.info.id {
                        return Err(unknown("native preparation changed its reserved tab"));
                    }
                    self.info = provider::native_tab(prepared.tab);
                    self.origin_proof = None;
                }
                Err(error) => {
                    host.lock()
                        .await
                        .native_preparation_failed(&identity, &error);
                    return Err(provider::native_error(error));
                }
            }
        }
        let mut claim = host
            .lock()
            .await
            .tabs
            .get(&identity)
            .and_then(|lease| lease.native.as_ref())
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
            attached.map_err(provider::native_error)?;
            claim = host
                .lock()
                .await
                .tabs
                .get(&identity)
                .and_then(|lease| lease.native.as_ref())
                .and_then(|state| state.claim.clone());
        }
        let claim = claim
            .ok_or_else(|| unknown("native attachment has not been committed to Host custody"))?;
        if claim.is_cleanup_only()
            || claim.tab_id().to_string() != self.info.id
            || claim.generation() != self.generation
        {
            return Err(unknown("native attachment has no current executable claim"));
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
        self.native_claim = Some(claim);
        self.native_wire = Some(
            NativeWireContext::new(self.cursor_owner.to_string(), invocation.turn())
                .map_err(failed)?,
        );
        self.native_host_operation = Some(context.clone());
        self.native_acquired = true;
        if let Some(socket) = &mut self.socket {
            socket.native_context = self.native_wire.clone();
        }
        {
            let mut ledger = host.lock().await;
            ledger.native_preparation_current(&scope, &preparation)?;
            let state = ledger
                .tabs
                .get_mut(&identity)
                .and_then(|lease| lease.native.as_mut())
                .ok_or_else(|| unknown("native preparation lost its known receipt"))?;
            state.session_prepared_operation = Some(context);
            if changes_logical_active
                && let Some(state) = ledger
                    .native
                    .get_mut(&(self.cursor_owner, identity.browser))
            {
                state.logical_active = Some(self.info.id.clone());
            }
        }
        // The persistent transport does not retain a CallScope/issuing permit.
        // Each raw call captures its own permit after its current Host check.
        drop(scope);
        self.refresh_info(language).await?;
        self.connect_metadata().await?;
        self.socket
            .as_mut()
            .ok_or_else(|| failed("native metadata channel is unavailable"))?
            .preparation = transport;
        check_input(cancellation)
    }

    pub(super) async fn prepare_native(
        &mut self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
        language: Language,
        intent: ClaimIntent,
    ) -> Result<(), ToolError> {
        self.prepare_native_session(invocation, cancellation, language, intent)
            .await?;
        let Some(native) = self.provider.native().cloned() else {
            return Ok(());
        };
        let actual_origin = self.document_origin().await?;
        invocation
            .authorize_browser(actual_origin.access(), cancellation)
            .await?;
        actual_origin.check_current(self).await?;
        let services = invocation
            .prepare_browser_services(actual_origin.access(), cancellation)
            .await?;
        actual_origin.check_current(self).await?;
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
        let scope = host.lock().await.native_context(
            self.cursor_owner,
            &self.provider,
            operation(invocation)?,
            self.cursor_epoch,
            Origin::UserClaimed,
            Some(self.info.id.clone()),
            true,
        )?;
        let claim = self
            .native_claim
            .clone()
            .ok_or_else(|| unknown("native content preparation lost its physical claim"))?;
        let capabilities = native.capabilities().map_err(provider::native_error)?;
        if capabilities.explicit_claim_preparation {
            self.prepare_claim_native(invocation, cancellation, &scope, &claim)
                .await?;
        }
        let headers = preparation_headers(invocation);
        if !capabilities.explicit_claim_preparation
            && capabilities.header_scope == NativeHeaderPolicyScope::Claim
            && !headers.is_empty()
        {
            let active = host
                .lock()
                .await
                .tabs
                .get(&identity)
                .and_then(|lease| lease.native.as_ref())
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
                applied.map_err(provider::native_error)?;
            }
        }
        self.verify(language).await?;
        actual_origin.check_current(self).await?;
        let authorization = self
            .clipboard_authorization
            .clone()
            .ok_or_else(|| failed("native browser lost its current attachment authorization"))?;
        let effects = self
            .dialog_host
            .clone()
            .ok_or_else(|| failed("native browser lost Host effect custody"))?;
        let before = self.frame().await?;
        let readiness = host
            .lock()
            .await
            .tabs
            .get(&identity)
            .and_then(|lease| lease.native.as_ref())
            .ok_or_else(|| unknown("focus readiness lost custody"))?
            .focus_readiness
            .clone();
        match readiness {
            FocusReadiness::Pending => {
                return Err(ToolError::CleanupUnconfirmed(
                    "the same physical claim has an unsettled focus-readiness request".into(),
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
                    .and_then(|lease| lease.native.as_mut())
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
                            .and_then(|lease| lease.native.as_mut())
                            .ok_or_else(|| unknown("focus result lost its claim"))?
                            .focus_readiness = FocusReadiness::Completed;
                    }
                    Err(ToolError::Failed(message)) => {
                        host.lock()
                            .await
                            .tabs
                            .get_mut(&identity)
                            .and_then(|lease| lease.native.as_mut())
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
                            if let Some(state) = &mut lease.native {
                                state.focus_readiness = FocusReadiness::Unknown(error.to_string());
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
            return Err(failed("document changed while native focus was prepared"));
        }
        check_input(cancellation)?;
        self.frame = Some(before.clone());
        host.lock()
            .await
            .tabs
            .get_mut(&identity)
            .and_then(|lease| lease.native.as_mut())
            .ok_or_else(|| unknown("native content preparation lost its claim"))?
            .metadata_attached = false;
        if capabilities.cursor_presentation_owner == NativeEffectOwner::Provider {
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
            return Err(failed("native overlay document changed during preparation"));
        }
        actual_origin.check_current(self).await?;
        let origin = actual_origin.origin();
        let mut ledger = host.lock().await;
        let endpoint = ledger
            .cursor_scopes
            .get(&(self.cursor_owner, identity.clone()))
            .cloned()
            .ok_or_else(|| unknown("native overlay cleanup endpoint was not retained"))?;
        let state = ledger
            .tabs
            .get_mut(&identity)
            .and_then(|lease| lease.native.as_mut())
            .ok_or_else(|| unknown("native custody disappeared during preparation"))?;
        if state.revoked {
            return Err(failed("native browser control was revoked while preparing"));
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
    }
    pub(super) async fn admit_native_close(
        &self,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
    ) -> Result<Option<NativeCloseAdmission>, ToolError> {
        if self.provider.native().is_none() {
            return Ok(None);
        }
        check_input(cancellation)?;
        let identity = self.identity()?;
        let claim = self
            .native_claim
            .clone()
            .ok_or_else(|| failed("native close requires a current owned claim"))?;
        let context = operation(invocation)?;
        if self.native_host_operation.as_ref() != Some(&context) {
            return Err(failed(
                "native close lacks its current admitted Host operation",
            ));
        }
        let host = self.cursor_host.clone();
        let scope = host.lock().await.native_context(
            self.cursor_owner,
            &self.provider,
            context,
            self.cursor_epoch,
            Origin::UserClaimed,
            Some(self.info.id.clone()),
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
        Ok(Some(NativeCloseAdmission {
            scope,
            claim,
            identity,
            request,
        }))
    }

    pub(super) async fn close_native_tab(
        &mut self,
        invocation: &crate::InvocationContext<'_>,
        admission: NativeCloseAdmission,
    ) -> Result<(), ToolError> {
        let NativeCloseAdmission {
            scope,
            claim,
            identity,
            request,
        } = admission;
        let native = self
            .provider
            .native()
            .ok_or_else(|| failed("native provider required"))?
            .clone();
        if scope.context != operation(invocation)?
            || scope.owner != self.cursor_owner
            || scope.epoch != self.cursor_epoch
            || scope.provider != self.provider
            || identity != self.identity()?
            || claim.is_cleanup_only()
            || claim.generation() != self.generation
            || self.native_claim.as_ref().is_none_or(|current| {
                current.claim_id() != claim.claim_id()
                    || current.tab_id() != claim.tab_id()
                    || current.target_id() != claim.target_id()
                    || current.completion_id() != claim.completion_id()
            })
        {
            return Err(unknown(
                "native close changed its issued source operation or claim",
            ));
        }
        request.check_scope(invocation.turn(), &scope.context.operation_id)?;
        {
            let ledger = self.cursor_host.lock().await;
            let lease = ledger
                .tabs
                .get(&identity)
                .ok_or_else(|| unknown("native close lost its admitted cleanup lease"))?;
            if lease.creator.owner != scope.owner
                || lease.creator.provider != scope.provider
                || lease.creator.generation != claim.generation()
                || lease.creator.turn != scope.context.turn_id
                || !matches!(lease.disposition, Disposition::Closing)
                || lease
                    .native
                    .as_ref()
                    .and_then(|state| state.claim.as_ref())
                    .is_none_or(|current| {
                        current.claim_id() != claim.claim_id()
                            || current.target_id() != claim.target_id()
                            || current.completion_id() != claim.completion_id()
                    })
            {
                return Err(unknown(
                    "native close lost its exact issued cleanup custody",
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
            .and_then(|lease| lease.native.as_ref())
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
            if !cleared.map_err(provider::native_error)?.cleanup_confirmed {
                return Err(ToolError::CleanupUnconfirmed(
                    "native preparation header cleanup remains unconfirmed before close".into(),
                ));
            }
        }
        if native
            .capabilities()
            .map_err(provider::native_error)?
            .cursor_presentation_owner
            == NativeEffectOwner::Host
        {
            self.cursor_host
                .lock()
                .await
                .cleanup_native_control(self.cursor_owner, &identity)
                .await?;
        }
        let drain = scope
            .dispatch(
                scope
                    .control
                    .wait_claim_cdp_drained(&claim, Duration::from_secs(10)),
            )
            .await
            .map_err(provider::native_error)?;
        {
            let mut ledger = self.cursor_host.lock().await;
            ledger
                .tabs
                .get_mut(&identity)
                .and_then(|lease| lease.native.as_mut())
                .ok_or_else(|| unknown("native close drain lost its exact claim"))?
                .cdp_drain = Some(drain);
            if ledger
                .reconcile_provider(self.cursor_owner, &self.provider)
                .await?
            {
                return Err(ToolError::CleanupUnconfirmed(
                    "native CDP settled but retained close custody is still pending".into(),
                ));
            }
            let state = ledger
                .tabs
                .get(&identity)
                .and_then(|lease| lease.native.as_ref())
                .ok_or_else(|| unknown("native close lost its exact claim custody"))?;
            if !state.closed {
                ledger.begin_native_cleanup(&identity)?;
            }
        }
        let already_closed = self
            .cursor_host
            .lock()
            .await
            .tabs
            .get(&identity)
            .and_then(|lease| lease.native.as_ref())
            .is_some_and(|state| state.closed);
        if !already_closed {
            let closed = scope.dispatch(scope.control.close_tab(&claim)).await;
            self.cursor_host
                .lock()
                .await
                .reconcile_provider(self.cursor_owner, &self.provider)
                .await?;
            closed.map_err(provider::native_error)?;
        }
        {
            let mut ledger = self.cursor_host.lock().await;
            ledger
                .retire_native_cleanup(self.cursor_owner, &self.provider, &identity, &scope.control)
                .await?;
            ledger.tabs.remove(&identity);
        }
        self.native_claim = None;
        drop(native);
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
        let Some(state) = &lease.native else {
            return Ok(());
        };
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
                return Err(failed("native overlay owner closed"));
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
                            .native
                            .as_ref()
                            .and_then(|state| state.overlay.as_ref())
                            .is_some_and(|current| current.epoch == overlay.epoch)
                });
                if !valid {
                    return Err(failed("native overlay attachment expired"));
                }
            }
            let mut endpoint = overlay.endpoint;
            endpoint
                .native_control(
                    &overlay.cursor,
                    &owner.to_string(),
                    &overlay.turn,
                    true,
                    active,
                )
                .await?;
            if active && let Some(creation) = creation {
                let scope = host.lock().await.native_context(
                    owner,
                    &overlay.provider,
                    overlay.context.clone(),
                    overlay.epoch,
                    Origin::AgentCreated,
                    Some(identity.target.clone()),
                    false,
                )?;
                scope
                    .dispatch(scope.control.unmute_created_tab_if_active(&creation))
                    .await
                    .map_err(provider::native_error)?;
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
                && let Some(state) = &mut lease.native
            {
                state.presentation_error =
                    Some(format!("native overlay admission refused: {error}"));
            }
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn row(id: u64, extra: Value) -> cua_driver_core::browser::NativeTabInfo {
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
            json!({"id":"17","title":"Observed title","url":"https://fixture.test/","providerTabId":"actual-provider-id"})
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
            NativeUserTabsOrder::Provider,
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
    fn raw_native_order_uses_activity_then_window_index_and_id() {
        let rows = ordered_user_tabs(
            vec![
                row(4, json!({"lastAccessed":10,"windowId":2,"index":0})),
                row(3, json!({"lastAccessed":10,"windowId":1,"index":1})),
                row(2, json!({"lastAccessed":20,"windowId":2,"index":1})),
                row(1, json!({"lastAccessed":10,"windowId":1,"index":1})),
            ],
            NativeUserTabsOrder::Host,
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
        let rows = ordered_user_tabs(rows, NativeUserTabsOrder::Provider);
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
    fn old_scope_cleanup_does_not_release_new_scope_or_header_liability() {
        let old = NativeWireContext::new("fixture-session", "old-turn").unwrap();
        let current = NativeWireContext::new("fixture-session", "current-turn").unwrap();
        let mut effects = PreparationEffects::default();
        effects.begin(&old, true);
        effects.begin(&current, true);
        effects.fixed_cleanup(&old, true);
        assert_eq!(effects.scopes, [current.clone()]);
        assert!(
            !effects.settled(),
            "old logical cleanup cannot clear current preparation"
        );
        effects.fixed_cleanup(&current, true);
        assert!(
            !effects.settled(),
            "fixed hooks are separate from scoped headers"
        );
        effects.headers_may_exist = false;
        assert!(effects.settled());
    }

    #[test]
    fn known_undispatched_refusal_preserves_prior_scope_and_creates_no_new_debt() {
        let wire = NativeWireContext::new("fixture-session", "current-turn").unwrap();
        let mut effects = PreparationEffects::default();
        let first = effects.begin(&wire, true);
        effects.refused(&wire, first);
        assert!(
            effects.settled(),
            "an undispatched attempt created no fixed or header effect"
        );
        effects.begin(&wire, true);
        let next = effects.begin(&wire, true);
        effects.refused(&wire, next);
        assert_eq!(effects.scopes, [wire]);
        assert!(
            !effects.settled(),
            "no-dispatch for a new attempt is not cleanup of prior effects"
        );
    }
}
