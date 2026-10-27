/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Metadata callbacks over the existing desktop worker frames.
//!
//! The owner must call `disconnect` on wire loss and retain these objects while
//! `has_unsettled` is true. No callback creates an authorization or an executor.
//! A wire sender only enqueues a frame, without inline callbacks or reentry;
//! its error means that frame was not queued locally. Short metadata critical
//! sections order Prepared/Seal/Released; no Host method is called under them.

use super::{AuthorizationMode, Failure};
use crate::invocation::{
    AuthorizationFuture, BrowserAccess, BrowserAttachmentAuthorization, BrowserAttachmentOrigin,
    BrowserAuthorization, BrowserEffectScope, BrowserHostEffects, BrowserPreparationBinding,
    BrowserServices, BrowserServicesFuture, BrowserServicesProvider, CheckedSettlementFuture,
    HostEffectFactory, HostEffectFuture, HostUncertaintyFuture, OperationSettlement,
    SettlementFuture,
};
use futures_util::FutureExt;
use maka_agent_facts::tools::ToolError;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    panic::AssertUnwindSafe,
    pin::Pin,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    task::{Context, Poll, Waker},
};
use tokio::sync::{Notify, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

static NEXT_SCOPE: AtomicU64 = AtomicU64::new(0);
type Rejected = Box<dyn FnOnce(ToolError) + Send>;
pub(super) type ParentSender = Arc<dyn Fn(ParentMessage) -> Result<(), ToolError> + Send + Sync>;
pub(super) type WorkerSender = Arc<dyn Fn(WorkerMessage) -> Result<(), ToolError> + Send + Sync>;

fn failed(message: impl Into<String>) -> ToolError {
    ToolError::Failed(message.into())
}
fn uncertain(message: impl Into<String>) -> ToolError {
    ToolError::CleanupUnconfirmed(message.into())
}
fn allocate(counter: &AtomicU64) -> Result<u64, ToolError> {
    counter
        .try_update(Ordering::SeqCst, Ordering::SeqCst, |id| id.checked_add(1))
        .map(|id| id + 1)
        .map_err(|_| failed("Browser callback identity exhausted"))
}
fn outcome_unknown(error: &ToolError) -> bool {
    matches!(
        error,
        ToolError::OutcomeUnknown(_)
            | ToolError::OperationUnknown { .. }
            | ToolError::CleanupUnconfirmed(_)
            | ToolError::OperationCleanupUnconfirmed { .. }
            | ToolError::Persistence(_)
    )
}

#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ScopeIdentity {
    pub owner: String,
    pub epoch: String,
    pub session: String,
    pub turn: String,
    pub operation_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ScopeKey {
    pub identity: ScopeIdentity,
    pub access: BrowserAccess,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ScopeToken {
    pub id: u64,
    pub key: ScopeKey,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ScopeGrant {
    token: ScopeToken,
    attachment: bool,
    effects: bool,
    #[serde(default)]
    lease_children: bool,
    settlement: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "value",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub(super) enum AttachmentOrigin {
    Site(String),
    Opaque,
}
impl From<BrowserAttachmentOrigin> for AttachmentOrigin {
    fn from(origin: BrowserAttachmentOrigin) -> Self {
        match origin {
            BrowserAttachmentOrigin::Site(site) => Self::Site(site),
            BrowserAttachmentOrigin::Opaque => Self::Opaque,
        }
    }
}
impl From<AttachmentOrigin> for BrowserAttachmentOrigin {
    fn from(origin: AttachmentOrigin) -> Self {
        match origin {
            AttachmentOrigin::Site(site) => Self::Site(site),
            AttachmentOrigin::Opaque => Self::Opaque,
        }
    }
}
enum AttachmentCheck {
    Origin(BrowserAttachmentOrigin),
    Metadata,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum WorkerMessage {
    Prepare {
        invocation_id: u64,
        request_id: u64,
        key: ScopeKey,
    },
    Check {
        token: ScopeToken,
        id: u64,
        origin: AttachmentOrigin,
    },
    CheckMetadata {
        token: ScopeToken,
        id: u64,
    },
    LeaseChild {
        token: ScopeToken,
        id: u64,
        request: crate::BrowserLeaseChildRequest,
    },
    CancelCheck {
        token: ScopeToken,
        id: u64,
    },
    Effect {
        token: ScopeToken,
        id: u64,
    },
    EffectScoped {
        token: ScopeToken,
        id: u64,
    },
    CheckEffectPreparation {
        token: ScopeToken,
        id: u64,
        effect_id: u64,
        binding: BrowserPreparationBinding,
    },
    EffectFinished {
        token: ScopeToken,
        id: u64,
        result: Result<(), Failure>,
    },
    EffectDeclined {
        token: ScopeToken,
        id: u64,
        error: Failure,
    },
    EffectUncertain {
        token: ScopeToken,
        id: u64,
        error: Failure,
    },
    Retain {
        token: ScopeToken,
        id: u64,
    },
    RetainedFinished {
        token: ScopeToken,
        id: u64,
    },
    RetainedUncertain {
        token: ScopeToken,
        id: u64,
        error: Failure,
    },
    Release {
        token: ScopeToken,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum ParentMessage {
    Prepared {
        request_id: u64,
        key: ScopeKey,
        result: Box<Result<ScopeGrant, Failure>>,
    },
    Checked {
        token: ScopeToken,
        id: u64,
        result: Result<(), Failure>,
    },
    Admit {
        token: ScopeToken,
        id: u64,
    },
    Rejected {
        token: ScopeToken,
        id: u64,
        error: Failure,
    },
    Retained {
        token: ScopeToken,
        id: u64,
        result: Result<(), Failure>,
    },
    Sealed {
        token: ScopeToken,
    },
    Released {
        token: ScopeToken,
    },
}

#[derive(Clone, Default)]
pub(super) struct ParentCapabilities {
    pub authorization: Option<Arc<dyn BrowserAuthorization>>,
    pub attachment: Option<Arc<dyn BrowserAttachmentAuthorization>>,
    pub effects: Option<Arc<dyn BrowserHostEffects>>,
    pub settlement: Option<Arc<dyn OperationSettlement>>,
}
impl ParentCapabilities {
    pub(super) fn session_preparation_decision(
        &self,
        expected: Option<&ScopeIdentity>,
        observed: ScopeIdentity,
        preparation: crate::BrowserSessionPreparation,
        mode: AuthorizationMode,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        // Parent transport identities are distinct from the child's native
        // owner/epoch. Only the actual backend ledger can prove that ownership.
        let routing = expected
            .filter(|expected| *expected == &observed)
            .ok_or_else(|| failed("Browser session preparation invocation identity mismatch"))
            .and_then(|expected| preparation.check_scope(&expected.turn, &expected.operation_id));
        let authorization = self.authorization.clone();
        Box::pin(async move {
            routing?;
            if cancellation.is_cancelled() {
                return Err(failed("Browser authorization cancelled"));
            }
            let authorization = authorization.ok_or_else(|| {
                failed("Browser session preparation requires current Host authorization")
            })?;
            match mode {
                AuthorizationMode::Authorize => {
                    authorization
                        .authorize_session_preparation(preparation, cancellation)
                        .await
                }
                AuthorizationMode::Check => {
                    authorization
                        .check_session_preparation(preparation, cancellation)
                        .await
                }
            }
        })
    }
}

#[derive(Default)]
struct SignalState {
    admitted: bool,
    result: Option<Result<(), ToolError>>,
    uncertainty: Option<ToolError>,
    result_waker: Option<Waker>,
    uncertainty_waker: Option<Waker>,
    effect_scope: Option<Arc<dyn BrowserEffectScope>>,
    scope_cancellation: CancellationToken,
}
#[derive(Default)]
struct Signal(Mutex<SignalState>);
impl Signal {
    fn finish(&self, result: Result<(), ToolError>) -> bool {
        let wake = {
            let mut state = self.0.lock().unwrap();
            if state.result.is_some() {
                return false;
            }
            state.scope_cancellation.cancel();
            state.effect_scope.take();
            state.result = Some(result);
            // A received early loss stays observable even if the physical
            // future becomes terminal before its Host observer is polled.
            state.result_waker.take()
        };
        if let Some(wake) = wake {
            wake.wake();
        }
        true
    }
    fn fail(&self, error: ToolError) {
        let wakes = {
            let mut state = self.0.lock().unwrap();
            if state.result.is_some() {
                return;
            }
            state.scope_cancellation.cancel();
            state.effect_scope.take();
            state.uncertainty.get_or_insert(error);
            (state.result_waker.take(), state.uncertainty_waker.take())
        };
        for wake in [wakes.0, wakes.1].into_iter().flatten() {
            wake.wake();
        }
    }
    fn close_effect_scope(&self) {
        let mut state = self.0.lock().unwrap();
        state.scope_cancellation.cancel();
        state.effect_scope.take();
    }
    fn done(&self) -> bool {
        self.0.lock().unwrap().result.is_some()
    }
}
struct SignalResult {
    signal: Arc<Signal>,
    checked: bool,
}
impl Future for SignalResult {
    type Output = Result<(), ToolError>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut state = self.signal.0.lock().unwrap();
        if self.checked
            && let Some(error) = &state.uncertainty
        {
            return Poll::Ready(Err(error.clone()));
        }
        if let Some(result) = &state.result {
            return Poll::Ready(result.clone());
        }
        state.result_waker = Some(cx.waker().clone());
        Poll::Pending
    }
}
struct SignalUncertainty(Arc<Signal>);
impl Future for SignalUncertainty {
    type Output = ToolError;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<ToolError> {
        let mut state = self.0.0.lock().unwrap();
        if let Some(error) = &state.uncertainty {
            return Poll::Ready(error.clone());
        }
        state.uncertainty_waker = Some(cx.waker().clone());
        Poll::Pending
    }
}
type Job = (u64, u64);
struct ParentScope {
    token: ScopeToken,
    capabilities: ParentCapabilities,
    sealed: bool,
    released: bool,
    last_request: u64,
}
#[derive(Default)]
struct ParentState {
    scopes: HashMap<u64, ParentScope>,
    preparing: HashMap<u64, (ScopeIdentity, CancellationToken)>,
    effects: HashMap<Job, Arc<Signal>>,
    retained: HashMap<Job, Arc<Signal>>,
    checks: HashMap<Job, CancellationToken>,
    rejected_custody: Vec<CheckedSettlementFuture>,
    closed: Option<ToolError>,
    authority_cleanup: Option<ToolError>,
}
struct ParentInner {
    send: ParentSender,
    fault: mpsc::UnboundedSender<ToolError>,
    state: Mutex<ParentState>,
}
#[derive(Clone)]
pub(super) struct ParentCallbacks(Arc<ParentInner>);
impl ParentCallbacks {
    pub fn new(send: ParentSender, fault: mpsc::UnboundedSender<ToolError>) -> Self {
        Self(Arc::new(ParentInner {
            send,
            fault,
            state: Mutex::new(ParentState::default()),
        }))
    }

    pub fn report_protocol_fault(&self, error: ToolError) {
        let _ = self.0.fault.send(error);
    }

    /// Only this entry borrows the live original invocation. Later messages use
    /// its captured capabilities, never whichever invocation is currently active.
    pub async fn prepare(
        &self,
        request_id: u64,
        key: ScopeKey,
        expected: &ScopeIdentity,
        mut capabilities: ParentCapabilities,
        cancellation: CancellationToken,
    ) -> Result<(), ToolError> {
        if &key.identity != expected || cancellation.is_cancelled() {
            return (self.0.send)(ParentMessage::Prepared {
                request_id,
                key,
                result: Box::new(Err(failed("Browser callback invocation expired").into())),
            });
        }
        let cancellation = cancellation.child_token();
        {
            let mut state = self.0.state.lock().unwrap();
            if state.closed.is_some() || state.preparing.contains_key(&request_id) {
                return Err(failed("Browser preparation state or identity mismatch"));
            }
            state
                .preparing
                .insert(request_id, (expected.clone(), cancellation.clone()));
        }
        let result = async {
            {
                let state = self.0.state.lock().unwrap();
                if state.closed.is_some() {
                    return Err(failed("Browser callback scope is closed"));
                }
            }
            let authorization = capabilities.authorization.as_ref().ok_or_else(|| {
                failed("Browser services require the original Host authorization")
            })?;
            authorization
                .check(key.access.clone(), cancellation.clone())
                .await?;
            if cancellation.is_cancelled() {
                return Err(failed("Browser callback preparation cancelled"));
            }
            if capabilities.attachment.is_none() {
                capabilities.attachment = authorization.attachment();
            }
            let token = ScopeToken {
                id: allocate(&NEXT_SCOPE)?,
                key: key.clone(),
            };
            let grant = ScopeGrant {
                token: token.clone(),
                attachment: capabilities.attachment.is_some(),
                effects: capabilities.effects.is_some(),
                lease_children: capabilities
                    .effects
                    .as_ref()
                    .is_some_and(|effects| effects.supports_lease_children()),
                settlement: capabilities.settlement.is_some(),
            };
            Ok((grant, capabilities))
        }
        .await;
        let mut state = self.0.state.lock().unwrap();
        state.preparing.remove(&request_id);
        let result = result.and_then(|prepared| {
            if state.closed.is_some() || cancellation.is_cancelled() {
                Err(failed("Browser callback scope closed during preparation"))
            } else {
                Ok(prepared)
            }
        });
        match result {
            Ok((grant, capabilities)) => {
                (self.0.send)(ParentMessage::Prepared {
                    request_id,
                    key,
                    result: Box::new(Ok(grant.clone())),
                })?;
                state.scopes.insert(
                    grant.token.id,
                    ParentScope {
                        token: grant.token,
                        capabilities,
                        sealed: false,
                        released: false,
                        last_request: 0,
                    },
                );
                Ok(())
            }
            Err(error) => {
                let cleanup = super::authorization_cleanup(Err(error.clone()));
                (self.0.send)(ParentMessage::Prepared {
                    request_id,
                    key,
                    result: Box::new(Err(error.into())),
                })?;
                cleanup.map_or(Ok(()), Err)
            }
        }
    }

    fn check_attachment(
        &self,
        token: ScopeToken,
        id: u64,
        intent: AttachmentCheck,
    ) -> Result<(), ToolError> {
        let prepared = {
            let mut state = self.0.state.lock().unwrap();
            let scope = checked_scope(&state, &token, true)?;
            let attachment = scope.capabilities.attachment.clone();
            if matches!(intent, AttachmentCheck::Metadata)
                && !matches!(
                    scope.token.key.access,
                    BrowserAccess::ReadDocument {
                        origin: BrowserAttachmentOrigin::Opaque,
                        ..
                    }
                )
            {
                Err(failed(
                    "opaque presentation check requires its verified opaque document scope",
                ))
            } else if state.closed.is_some() || scope.sealed || attachment.is_none() {
                Err(failed("Browser attachment scope is sealed or unavailable"))
            } else {
                if state.checks.contains_key(&(token.id, id)) {
                    return Err(failed("Browser attachment callback identity mismatch"));
                }
                let cancellation = CancellationToken::new();
                state.checks.insert((token.id, id), cancellation.clone());
                Ok((attachment.unwrap(), cancellation))
            }
        };
        let (attachment, cancellation) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                return (self.0.send)(ParentMessage::Checked {
                    token,
                    id,
                    result: Err(error.into()),
                });
            }
        };
        let parent = self.clone();
        tokio::spawn(async move {
            let result = match intent {
                AttachmentCheck::Origin(origin) => {
                    attachment.check(origin, cancellation.clone()).await
                }
                AttachmentCheck::Metadata => attachment.check_metadata(cancellation.clone()).await,
            };
            let cleanup = super::authorization_cleanup(result.clone());
            let result = if let Some(error) = &cleanup {
                Err(error.clone())
            } else if cancellation.is_cancelled() {
                Err(failed("Browser attachment scope closed"))
            } else {
                result
            };
            {
                let mut state = parent.0.state.lock().unwrap();
                if let Some(error) = &cleanup {
                    state.authority_cleanup.get_or_insert(error.clone());
                }
                let _ = (parent.0.send)(ParentMessage::Checked {
                    token: token.clone(),
                    id,
                    result: result.map_err(Failure::from),
                });
                state.checks.remove(&(token.id, id));
            }
            if let Some(error) = cleanup {
                parent.disconnect("Browser attachment authorization cleanup was not confirmed");
                let _ = parent.0.fault.send(error);
            }
            parent.prune(token.id);
        });
        Ok(())
    }

    fn check_effect_preparation(
        &self,
        token: ScopeToken,
        id: u64,
        effect_id: u64,
        binding: BrowserPreparationBinding,
    ) -> Result<(), ToolError> {
        let prepared = {
            let mut state = self.0.state.lock().unwrap();
            let prepared = binding
                .check_turn(&token.key.identity.turn)
                .and_then(|()| effect_preparation_scope(&state, &token, effect_id));
            match prepared {
                Ok((scope, lifetime)) => {
                    if state.checks.contains_key(&(token.id, id)) {
                        return Err(failed(
                            "Browser effect preparation callback identity mismatch",
                        ));
                    }
                    let cancellation = lifetime.child_token();
                    state.checks.insert((token.id, id), cancellation.clone());
                    Ok((scope, cancellation))
                }
                Err(error) => Err(error),
            }
        };
        let (scope, cancellation) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                return (self.0.send)(ParentMessage::Checked {
                    token,
                    id,
                    result: Err(error.into()),
                });
            }
        };
        let parent = self.clone();
        tokio::spawn(async move {
            let result = scope
                .check_session_preparation(binding, cancellation.clone())
                .await;
            let cleanup = super::authorization_cleanup(result.clone());
            {
                let mut state = parent.0.state.lock().unwrap();
                let result = if let Some(error) = &cleanup {
                    state.authority_cleanup.get_or_insert(error.clone());
                    Err(error.clone())
                } else if cancellation.is_cancelled()
                    || effect_preparation_scope(&state, &token, effect_id).is_err()
                {
                    Err(failed("Browser Host effect preparation scope closed"))
                } else {
                    result
                };
                let _ = (parent.0.send)(ParentMessage::Checked {
                    token: token.clone(),
                    id,
                    result: result.map_err(Failure::from),
                });
                state.checks.remove(&(token.id, id));
            }
            if let Some(error) = cleanup {
                parent.disconnect("Browser Host effect preparation cleanup was not confirmed");
                let _ = parent.0.fault.send(error);
            }
            parent.prune(token.id);
        });
        Ok(())
    }

    fn lease_child(
        &self,
        token: ScopeToken,
        id: u64,
        request: crate::BrowserLeaseChildRequest,
    ) -> Result<(), ToolError> {
        let prepared = {
            let mut state = self.0.state.lock().unwrap();
            let scope = checked_scope(&state, &token, true)?;
            let document = token.key.access.document();
            let host = scope.capabilities.effects.clone();
            if state.closed.is_some()
                || scope.sealed
                || request.turn_id != token.key.identity.turn
                || request.browser_id != document.browser_id
                || request.generation != document.generation
                || request.opener_tab_id.to_string() != document.tab_id
                || host
                    .as_ref()
                    .is_none_or(|host| !host.supports_lease_children())
            {
                Err(failed(
                    "Browser lease-child service changed its captured source scope",
                ))
            } else {
                let std::collections::hash_map::Entry::Vacant(check) =
                    state.checks.entry((token.id, id))
                else {
                    return Err(failed("Browser lease-child callback identity mismatch"));
                };
                // This tracks the existing callback observation. The original
                // Host service independently admits and owns its physical work.
                check.insert(CancellationToken::new());
                Ok(host.expect("validated lease-child Host capability"))
            }
        };
        let host = match prepared {
            Ok(host) => host,
            Err(error) => {
                return (self.0.send)(ParentMessage::Checked {
                    token,
                    id,
                    result: Err(error.into()),
                });
            }
        };
        let parent = self.clone();
        tokio::spawn(async move {
            let result = host.adopt_lease_child(request).await;
            // Source-scope cancellation is not a claim that this independent
            // service effect failed before dispatch. Report its actual result.
            let cleanup = super::authorization_cleanup(result.clone());
            {
                let mut state = parent.0.state.lock().unwrap();
                if let Some(error) = &cleanup {
                    state.authority_cleanup.get_or_insert(error.clone());
                }
                let _ = (parent.0.send)(ParentMessage::Checked {
                    token: token.clone(),
                    id,
                    result: result.map_err(Failure::from),
                });
                state.checks.remove(&(token.id, id));
            }
            if let Some(error) = cleanup {
                parent.disconnect("Browser lease-child service cleanup was not confirmed");
                let _ = parent.0.fault.send(error);
            }
            parent.prune(token.id);
        });
        Ok(())
    }

    pub fn handle(&self, message: WorkerMessage) -> Result<(), ToolError> {
        if let WorkerMessage::Check { token, id, .. }
        | WorkerMessage::CheckMetadata { token, id }
        | WorkerMessage::LeaseChild { token, id, .. }
        | WorkerMessage::Effect { token, id }
        | WorkerMessage::EffectScoped { token, id }
        | WorkerMessage::CheckEffectPreparation { token, id, .. }
        | WorkerMessage::Retain { token, id } = &message
        {
            let mut state = self.0.state.lock().unwrap();
            checked_scope(&state, token, true)?;
            let scope = state.scopes.get_mut(&token.id).unwrap();
            if *id == 0 || *id <= scope.last_request {
                return Err(failed(
                    "Browser callback request nonce was reused or reordered",
                ));
            }
            scope.last_request = *id;
        }
        match message {
            WorkerMessage::Prepare { .. } => {
                return Err(failed(
                    "Browser preparation requires its original live invocation",
                ));
            }
            WorkerMessage::Check { token, id, origin } => {
                return self.check_attachment(token, id, AttachmentCheck::Origin(origin.into()));
            }
            WorkerMessage::CheckMetadata { token, id } => {
                return self.check_attachment(token, id, AttachmentCheck::Metadata);
            }
            WorkerMessage::LeaseChild { token, id, request } => {
                return self.lease_child(token, id, request);
            }
            WorkerMessage::CheckEffectPreparation {
                token,
                id,
                effect_id,
                binding,
            } => {
                return self.check_effect_preparation(token, id, effect_id, binding);
            }
            WorkerMessage::CancelCheck { token, id } => {
                let state = self.0.state.lock().unwrap();
                checked_scope(&state, &token, true)?;
                if let Some(cancellation) = state.checks.get(&(token.id, id)) {
                    cancellation.cancel();
                }
            }
            effect @ (WorkerMessage::Effect { .. } | WorkerMessage::EffectScoped { .. }) => {
                let (token, id, scoped) = match effect {
                    WorkerMessage::Effect { token, id } => (token, id, false),
                    WorkerMessage::EffectScoped { token, id } => (token, id, true),
                    _ => unreachable!("effect variants were matched above"),
                };
                let prepared = {
                    let mut state = self.0.state.lock().unwrap();
                    let scope = checked_scope(&state, &token, true)?;
                    let host = scope.capabilities.effects.clone();
                    if state.closed.is_some() || scope.sealed {
                        Err(failed("Browser Host effect scope is sealed or unavailable"))
                    } else if let Some(host) = host {
                        if state.effects.contains_key(&(token.id, id)) {
                            return Err(failed("Browser effect callback identity mismatch"));
                        }
                        let signal = Arc::new(Signal::default());
                        state.effects.insert((token.id, id), signal.clone());
                        Ok((host, signal))
                    } else {
                        Err(failed("Browser Host effect scope is sealed or unavailable"))
                    }
                };
                let (host, signal) = match prepared {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        return (self.0.send)(ParentMessage::Rejected {
                            token,
                            id,
                            error: error.into(),
                        });
                    }
                };
                let parent = self.clone();
                let bridge_token = token.clone();
                let bridge_signal = signal.clone();
                let bridge = move |effect_scope| -> HostEffectFuture {
                    Box::pin(EffectBridge {
                        parent,
                        token: bridge_token,
                        id,
                        signal: bridge_signal,
                        effect_scope,
                        started: false,
                    })
                };
                let observation: HostUncertaintyFuture = Box::pin(SignalUncertainty(signal));
                let parent = self.clone();
                let rejected_token = token.clone();
                let rejected: Rejected =
                    Box::new(move |error| parent.reject_effect(&rejected_token, id, error));
                let admitted = if scoped {
                    host.spawn_scoped_custodied(
                        Box::new(move |scope| bridge(Some(scope))),
                        observation,
                        rejected,
                    )
                } else {
                    host.spawn_custodied(bridge(None), observation, rejected)
                };
                if let Err(error) = admitted {
                    self.reject_effect(&token, id, error);
                }
            }
            WorkerMessage::EffectFinished { token, id, result } => {
                let signal = self.effect_signal(&token, id)?;
                if !signal.0.lock().unwrap().admitted {
                    return Err(failed("Unadmitted browser effect reported completion"));
                }
                let result = result.map_err(ToolError::from);
                // Finished reports that the original worker future is terminal,
                // including an Unknown error. Its physical custody remains the
                // real Host's independent native owner, never a fake pending RPC.
                if !signal.finish(result) {
                    return Err(failed("Browser effect completed more than once"));
                }
                self.0.state.lock().unwrap().effects.remove(&(token.id, id));
                self.prune(token.id);
            }
            WorkerMessage::EffectDeclined { token, id, error } => {
                {
                    let mut state = self.0.state.lock().unwrap();
                    let scope = checked_scope(&state, &token, true)?;
                    match state.effects.get(&(token.id, id)) {
                        Some(signal) => {
                            signal.finish(Err(error.into()));
                        }
                        None if scope.sealed => {} // Seal can overtake a request refused before T1.
                        None => return Err(failed("Browser declined effect identity mismatch")),
                    }
                    state.effects.remove(&(token.id, id));
                }
                self.prune(token.id);
            }
            WorkerMessage::EffectUncertain { token, id, error } => {
                self.effect_signal(&token, id)?.fail(uncertain(format!(
                    "Browser effect custody is uncertain: {}",
                    ToolError::from(error)
                )));
            }
            WorkerMessage::Retain { token, id } => {
                let (settlement, signal) = {
                    let mut state = self.0.state.lock().unwrap();
                    let scope = checked_scope(&state, &token, true)?;
                    let settlement =
                        scope.capabilities.settlement.clone().ok_or_else(|| {
                            failed("Original operation settlement is unavailable")
                        })?;
                    if state.retained.contains_key(&(token.id, id)) {
                        return Err(failed("Browser retention callback identity mismatch"));
                    }
                    let signal = Arc::new(Signal::default());
                    state.retained.insert((token.id, id), signal.clone());
                    (settlement, signal)
                };
                let pending: CheckedSettlementFuture = Box::pin(SignalResult {
                    signal,
                    checked: true,
                });
                let result = match settlement.retain_checked(pending) {
                    Ok(()) => Ok(()),
                    Err((error, mut pending)) => {
                        let parent = self.clone();
                        tokio::spawn(async move {
                            let result = AssertUnwindSafe(pending.as_mut()).catch_unwind().await;
                            if !matches!(result, Ok(Ok(()))) {
                                parent
                                    .0
                                    .state
                                    .lock()
                                    .unwrap()
                                    .rejected_custody
                                    .push(pending);
                            }
                        });
                        Err(Failure::from(error))
                    }
                };
                (self.0.send)(ParentMessage::Retained { token, id, result })?;
            }
            WorkerMessage::RetainedFinished { token, id } => {
                {
                    let state = self.0.state.lock().unwrap();
                    checked_scope(&state, &token, true)?;
                    let signal = state
                        .retained
                        .get(&(token.id, id))
                        .ok_or_else(|| failed("Browser retention completion identity mismatch"))?;
                    if !signal.finish(Ok(())) {
                        return Err(failed("Browser retention completed more than once"));
                    }
                }
                self.0
                    .state
                    .lock()
                    .unwrap()
                    .retained
                    .remove(&(token.id, id));
                self.prune(token.id);
            }
            WorkerMessage::RetainedUncertain { token, id, error } => {
                let state = self.0.state.lock().unwrap();
                checked_scope(&state, &token, true)?;
                state
                    .retained
                    .get(&(token.id, id))
                    .ok_or_else(|| failed("Browser retention uncertainty identity mismatch"))?
                    .fail(uncertain(format!(
                        "Browser RPC custody is uncertain: {}",
                        ToolError::from(error)
                    )));
            }
            WorkerMessage::Release { token } => {
                {
                    let mut state = self.0.state.lock().unwrap();
                    checked_scope(&state, &token, true)?;
                    let scope = state.scopes.get_mut(&token.id).unwrap();
                    scope.sealed = true;
                    scope.released = true;
                }
                self.prune(token.id);
            }
        }
        Ok(())
    }

    fn effect_signal(&self, token: &ScopeToken, id: u64) -> Result<Arc<Signal>, ToolError> {
        let state = self.0.state.lock().unwrap();
        checked_scope(&state, token, true)?;
        state
            .effects
            .get(&(token.id, id))
            .cloned()
            .ok_or_else(|| failed("Browser effect completion identity mismatch"))
    }
    fn prune(&self, id: u64) {
        let mut state = self.0.state.lock().unwrap();
        let released = prune_parent(&mut state, id);
        if let Some(token) = released {
            let _ = (self.0.send)(ParentMessage::Released { token });
        }
    }
    fn reject_effect(&self, token: &ScopeToken, id: u64, error: ToolError) {
        let state = self.0.state.lock().unwrap();
        let Some(signal) = state.effects.get(&(token.id, id)) else {
            return;
        };
        if signal.0.lock().unwrap().admitted {
            signal.fail(uncertain(format!(
                "Host refusal followed browser admission: {error}"
            )));
            return;
        }
        if signal.finish(Err(error.clone())) {
            let _ = (self.0.send)(ParentMessage::Rejected {
                token: token.clone(),
                id,
                error: error.into(),
            });
        }
    }
    pub fn seal(&self, identity: &ScopeIdentity) {
        {
            let mut state = self.0.state.lock().unwrap();
            for (preparing, cancel) in state.preparing.values() {
                if preparing == identity {
                    cancel.cancel();
                }
            }
            let tokens = state
                .scopes
                .values_mut()
                .filter(|scope| &scope.token.key.identity == identity)
                .map(|scope| {
                    scope.sealed = true;
                    scope.token.clone()
                })
                .collect::<Vec<_>>();
            for token in &tokens {
                for ((scope, _), cancel) in &state.checks {
                    if *scope == token.id {
                        cancel.cancel();
                    }
                }
            }
            for token in tokens {
                let _ = (self.0.send)(ParentMessage::Sealed { token });
            }
        }
    }
    pub fn seal_matching(&self, owner: &str, epoch: Option<&str>, turn: Option<&str>) {
        let identities = {
            let state = self.0.state.lock().unwrap();
            state
                .scopes
                .values()
                .map(|scope| scope.token.key.identity.clone())
                .chain(
                    state
                        .preparing
                        .values()
                        .map(|(identity, _)| identity.clone()),
                )
                .filter(|identity| matches_identity(identity, owner, epoch, turn))
                .collect::<HashSet<_>>()
        };
        for identity in identities {
            self.seal(&identity);
        }
    }
    pub fn disconnect(&self, reason: &str) {
        let mut state = self.0.state.lock().unwrap();
        let error = uncertain(format!("Browser callback transport lost: {reason}"));
        state.closed.get_or_insert(error.clone());
        for (_, cancel) in state.preparing.values() {
            cancel.cancel();
        }
        for cancel in state.checks.values() {
            cancel.cancel();
        }
        for signal in state.effects.values() {
            if signal.0.lock().unwrap().admitted {
                signal.fail(error.clone());
            } else {
                signal.finish(Err(failed(
                    "Browser effect was not admitted before transport closed",
                )));
            }
        }
        for signal in state.retained.values() {
            signal.fail(error.clone());
        }
    }
    pub fn has_unsettled(&self) -> bool {
        let state = self.0.state.lock().unwrap();
        !state.preparing.is_empty()
            || !state.checks.is_empty()
            || state.authority_cleanup.is_some()
            || !state.rejected_custody.is_empty()
            || state.effects.values().any(|signal| !signal.done())
            || state.retained.values().any(|signal| !signal.done())
    }
}
fn checked_scope<'a>(
    state: &'a ParentState,
    token: &ScopeToken,
    allow_sealed: bool,
) -> Result<&'a ParentScope, ToolError> {
    let scope = state
        .scopes
        .get(&token.id)
        .filter(|scope| scope.token == *token)
        .ok_or_else(|| failed("Browser callback scope identity mismatch"))?;
    if !allow_sealed && (state.closed.is_some() || scope.sealed) {
        return Err(failed("Browser callback scope is sealed"));
    }
    Ok(scope)
}
fn effect_preparation_scope(
    state: &ParentState,
    token: &ScopeToken,
    id: u64,
) -> Result<(Arc<dyn BrowserEffectScope>, CancellationToken), ToolError> {
    checked_scope(state, token, false)?;
    let signal = state
        .effects
        .get(&(token.id, id))
        .ok_or_else(|| failed("Browser Host effect preparation identity expired"))?;
    let signal = signal.0.lock().unwrap();
    if !signal.admitted
        || signal.scope_cancellation.is_cancelled()
        || signal.result.is_some()
        || signal.uncertainty.is_some()
    {
        return Err(failed("Browser Host effect preparation lifetime is closed"));
    }
    let scope = signal
        .effect_scope
        .clone()
        .ok_or_else(|| failed("Browser Host effect has no actual preparation scope"))?;
    Ok((scope, signal.scope_cancellation.clone()))
}
fn prune_parent(state: &mut ParentState, scope: u64) -> Option<ScopeToken> {
    if state.scopes.get(&scope).is_some_and(|scope| scope.released)
        && !state.checks.keys().any(|(id, _)| *id == scope)
        && state
            .effects
            .iter()
            .filter(|((id, _), _)| *id == scope)
            .all(|(_, signal)| signal.done())
        && state
            .retained
            .iter()
            .filter(|((id, _), _)| *id == scope)
            .all(|(_, signal)| signal.done())
    {
        let token = state.scopes.remove(&scope).map(|scope| scope.token);
        state.effects.retain(|(id, _), _| *id != scope);
        state.retained.retain(|(id, _), _| *id != scope);
        return token;
    }
    None
}
struct EffectBridge {
    parent: ParentCallbacks,
    token: ScopeToken,
    id: u64,
    signal: Arc<Signal>,
    effect_scope: Option<Arc<dyn BrowserEffectScope>>,
    started: bool,
}
impl Future for EffectBridge {
    type Output = Result<(), ToolError>;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        if !self.started && !self.signal.done() {
            let effect_scope = self.effect_scope.take();
            let admitted = {
                let state = self.parent.0.state.lock().unwrap();
                if checked_scope(&state, &self.token, false).is_ok() {
                    {
                        let mut signal = self.signal.0.lock().unwrap();
                        if !signal.scope_cancellation.is_cancelled() {
                            signal.effect_scope = effect_scope;
                        }
                        signal.admitted = true;
                    }
                    if let Err(error) = (self.parent.0.send)(ParentMessage::Admit {
                        token: self.token.clone(),
                        id: self.id,
                    }) {
                        self.signal.fail(uncertain(format!(
                            "Browser effect admission delivery lost: {error}"
                        )));
                    }
                    true
                } else {
                    false
                }
            };
            self.started = true;
            if !admitted {
                self.parent.reject_effect(
                    &self.token,
                    self.id,
                    failed("Browser scope sealed before Host effect admission"),
                );
            }
        }
        Pin::new(&mut SignalResult {
            signal: self.signal.clone(),
            checked: false,
        })
        .poll(cx)
    }
}

impl Drop for EffectBridge {
    fn drop(&mut self) {
        self.signal.close_effect_scope();
    }
}

struct PreparedServices {
    grant: ScopeGrant,
    scope: Arc<RemoteScope>,
}
struct PendingPrepare {
    invocation_id: u64,
    key: ScopeKey,
    reply: oneshot::Sender<Result<PreparedServices, ToolError>>,
}
struct WorkerScope {
    token: ScopeToken,
    scope: Weak<RemoteScope>,
}
enum PendingEffectWork {
    Future(HostEffectFuture),
    Scoped(HostEffectFactory),
}
struct PendingEffect {
    scope: Arc<RemoteScope>,
    pending: Option<PendingEffectWork>,
    rejected: Option<Rejected>,
    admitted: bool,
    uncertain: bool,
}
enum RetentionAck {
    Pending,
    Accepted,
    Rejected(ToolError),
}
enum RetentionFuture {
    Known(SettlementFuture),
    Checked(CheckedSettlementFuture),
}
impl Future for RetentionFuture {
    type Output = Result<(), ToolError>;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match self.get_mut() {
            Self::Known(pending) => pending.as_mut().poll(cx).map(Ok),
            Self::Checked(pending) => pending.as_mut().poll(cx),
        }
    }
}
struct PendingRetention {
    scope: Arc<RemoteScope>,
    pending: Option<RetentionFuture>,
    ack: RetentionAck,
    done: bool,
    uncertain: Option<ToolError>,
}
#[derive(Default)]
struct WorkerState {
    prepares: HashMap<u64, PendingPrepare>,
    checks: HashMap<Job, oneshot::Sender<Result<(), ToolError>>>,
    scopes: HashMap<u64, WorkerScope>,
    declined: HashSet<Job>,
    effects: HashMap<Job, PendingEffect>,
    retained: HashMap<Job, PendingRetention>,
    closed: Option<ToolError>,
}
struct WorkerInner {
    send: WorkerSender,
    state: Mutex<WorkerState>,
    next: AtomicU64,
    changed: Notify,
    emission: Mutex<()>,
}
#[derive(Clone)]
pub(super) struct WorkerCallbacks(Arc<WorkerInner>);
impl WorkerCallbacks {
    pub fn new(send: WorkerSender) -> Self {
        Self(Arc::new(WorkerInner {
            send,
            state: Mutex::new(WorkerState::default()),
            next: AtomicU64::new(0),
            changed: Notify::new(),
            emission: Mutex::new(()),
        }))
    }
    pub fn scope(
        &self,
        identity: ScopeIdentity,
        invocation_id: u64,
    ) -> Arc<dyn BrowserServicesProvider> {
        Arc::new(RemoteServices {
            worker: self.clone(),
            identity,
            invocation_id,
        })
    }
    async fn prepare(
        &self,
        invocation_id: u64,
        key: ScopeKey,
        cancellation: CancellationToken,
    ) -> Result<BrowserServices, ToolError> {
        let response = {
            let _emission = self.0.emission.lock().unwrap();
            let id = allocate(&self.0.next)?;
            let (reply, response) = oneshot::channel();
            {
                let mut state = self.0.state.lock().unwrap();
                if state.closed.is_some() || cancellation.is_cancelled() {
                    return Err(failed("Browser services preparation is closed"));
                }
                state.prepares.insert(
                    id,
                    PendingPrepare {
                        invocation_id,
                        key: key.clone(),
                        reply,
                    },
                );
            }
            if let Err(error) = (self.0.send)(WorkerMessage::Prepare {
                invocation_id,
                request_id: id,
                key: key.clone(),
            }) {
                self.0.state.lock().unwrap().prepares.remove(&id);
                return Err(error);
            }
            response
        };
        let PreparedServices { grant, scope } = tokio::select! { biased; _ = cancellation.cancelled() => return Err(failed("Browser services preparation cancelled")), result = response => result.map_err(|_| failed("Browser services preparation expired"))?? };
        if grant.token.key != key {
            return Err(failed(
                "Browser services preparation changed scope identity",
            ));
        }
        if scope.sealed.load(Ordering::SeqCst) || cancellation.is_cancelled() {
            return Err(failed("Browser services scope closed before delivery"));
        }
        Ok(BrowserServices {
            attachment: grant
                .attachment
                .then(|| scope.clone() as Arc<dyn BrowserAttachmentAuthorization>),
            effects: grant
                .effects
                .then(|| scope.clone() as Arc<dyn BrowserHostEffects>),
            settlement: grant
                .settlement
                .then_some(scope as Arc<dyn OperationSettlement>),
        })
    }
    pub fn handle(&self, message: ParentMessage) -> Result<(), ToolError> {
        match message {
            ParentMessage::Prepared {
                request_id,
                key,
                result,
            } => {
                let pending = self
                    .0
                    .state
                    .lock()
                    .unwrap()
                    .prepares
                    .remove(&request_id)
                    .ok_or_else(|| failed("Browser prepared response identity mismatch"))?;
                if pending.key != key {
                    return Err(failed("Browser prepared response changed access intent"));
                }
                let result = match *result {
                    Ok(grant) => {
                        if grant.token.key != key || grant.token.id == 0 {
                            return Err(failed("Browser prepared token identity mismatch"));
                        }
                        let scope = Arc::new(RemoteScope {
                            token: grant.token.clone(),
                            invocation_id: pending.invocation_id,
                            lease_children: grant.lease_children,
                            worker: self.clone(),
                            sealed: AtomicBool::new(false),
                        });
                        {
                            let mut state = self.0.state.lock().unwrap();
                            if state.scopes.contains_key(&grant.token.id) {
                                return Err(failed("Browser prepared token was reused"));
                            }
                            state.scopes.insert(
                                scope.token.id,
                                WorkerScope {
                                    token: scope.token.clone(),
                                    scope: Arc::downgrade(&scope),
                                },
                            );
                        }
                        Ok(PreparedServices { grant, scope })
                    }
                    Err(error) => Err(error.into()),
                };
                let _ = pending.reply.send(result);
            }
            ParentMessage::Checked { token, id, result } => {
                let mut state = self.0.state.lock().unwrap();
                known_worker_scope(&state, &token)?;
                let reply = state
                    .checks
                    .remove(&(token.id, id))
                    .ok_or_else(|| failed("Browser attachment reply identity mismatch"))?;
                let _ = reply.send(result.map_err(ToolError::from));
            }
            ParentMessage::Admit { token, id } => {
                let pending = {
                    let mut state = self.0.state.lock().unwrap();
                    known_worker_scope(&state, &token)?;
                    if state.declined.contains(&(token.id, id)) {
                        return Ok(());
                    }
                    let entry = state
                        .effects
                        .get_mut(&(token.id, id))
                        .ok_or_else(|| failed("Browser effect admission identity mismatch"))?;
                    if entry.admitted {
                        return Err(failed("Browser effect admitted twice"));
                    }
                    if entry.scope.sealed.load(Ordering::SeqCst) {
                        None
                    } else {
                        entry.admitted = true;
                        entry.rejected.take();
                        entry.pending.take()
                    }
                };
                if let Some(pending) = pending {
                    let worker = self.clone();
                    tokio::spawn(async move {
                        let pending: HostEffectFuture = match pending {
                            PendingEffectWork::Future(pending) => pending,
                            PendingEffectWork::Scoped(factory) => {
                                let scope = Arc::new(RemoteEffectScope {
                                    worker: worker.clone(),
                                    token: token.clone(),
                                    effect_id: id,
                                });
                                Box::pin(async move { factory(scope).await })
                            }
                        };
                        EffectCustody::new(worker, token, id, pending).run().await;
                    });
                } else {
                    self.decline(
                        &token,
                        id,
                        failed("Browser effect scope closed before admission"),
                        true,
                    )?;
                }
            }
            ParentMessage::Rejected { token, id, error } => {
                self.decline(&token, id, error.into(), true)?;
            }
            ParentMessage::Retained { token, id, result } => {
                let retired = {
                    let mut state = self.0.state.lock().unwrap();
                    worker_scope(&state, &token)?;
                    let entry = state
                        .retained
                        .get_mut(&(token.id, id))
                        .ok_or_else(|| failed("Browser retention reply identity mismatch"))?;
                    if !matches!(entry.ack, RetentionAck::Pending) {
                        return Err(failed("Browser retention acknowledged twice"));
                    }
                    entry.ack = match result {
                        Ok(()) => RetentionAck::Accepted,
                        Err(error) => RetentionAck::Rejected(error.into()),
                    };
                    if entry.done && matches!(entry.ack, RetentionAck::Accepted) {
                        state.retained.remove(&(token.id, id))
                    } else {
                        None
                    }
                };
                drop(retired);
            }
            ParentMessage::Sealed { token } => {
                self.seal_token(&token)?;
            }
            ParentMessage::Released { token } => {
                let mut state = self.0.state.lock().unwrap();
                known_worker_scope(&state, &token)?;
                if state
                    .scopes
                    .get(&token.id)
                    .is_some_and(|entry| entry.scope.upgrade().is_some())
                {
                    return Err(failed(
                        "Browser scope released while capability is still live",
                    ));
                }
                state.scopes.remove(&token.id);
                state.declined.retain(|(id, _)| *id != token.id);
            }
        }
        self.0.changed.notify_waiters();
        Ok(())
    }
    fn decline(
        &self,
        token: &ScopeToken,
        id: u64,
        error: ToolError,
        notify: bool,
    ) -> Result<(), ToolError> {
        let entry = {
            let mut state = self.0.state.lock().unwrap();
            known_worker_scope(&state, token)?;
            if state.declined.contains(&(token.id, id)) {
                return Ok(());
            }
            let Some(entry) = state.effects.get(&(token.id, id)) else {
                return Err(failed("Browser effect refusal identity mismatch"));
            };
            if entry.admitted {
                return Err(uncertain(
                    "Host refusal arrived after browser effect admission",
                ));
            }
            let entry = state.effects.remove(&(token.id, id)).unwrap();
            state.declined.insert((token.id, id));
            entry
        };
        if let Some(rejected) = entry.rejected {
            rejected(error.clone());
        }
        drop(entry.pending); // Unpolled: the Parent never admitted this future.
        if notify {
            (self.0.send)(WorkerMessage::EffectDeclined {
                token: token.clone(),
                id,
                error: error.into(),
            })?;
        }
        Ok(())
    }
    fn seal_token(&self, token: &ScopeToken) -> Result<(), ToolError> {
        let ids = {
            let state = self.0.state.lock().unwrap();
            known_worker_scope(&state, token)?;
            if let Some(scope) = state
                .scopes
                .get(&token.id)
                .and_then(|entry| entry.scope.upgrade())
            {
                scope.sealed.store(true, Ordering::SeqCst);
            }
            state
                .effects
                .iter()
                .filter(|((scope, _), entry)| *scope == token.id && !entry.admitted)
                .map(|((_, id), _)| *id)
                .collect::<Vec<_>>()
        };
        for id in ids {
            self.decline(token, id, failed("Browser callback scope sealed"), true)?;
        }
        self.0.changed.notify_waiters();
        Ok(())
    }
    pub fn seal(&self, identity: &ScopeIdentity) {
        let tokens = self
            .0
            .state
            .lock()
            .unwrap()
            .scopes
            .values()
            .filter(|scope| &scope.token.key.identity == identity)
            .map(|scope| scope.token.clone())
            .collect::<Vec<_>>();
        for token in tokens {
            let _ = self.seal_token(&token);
        }
    }
    pub fn seal_matching(&self, owner: &str, epoch: Option<&str>, turn: Option<&str>) {
        let identities = self
            .0
            .state
            .lock()
            .unwrap()
            .scopes
            .values()
            .map(|scope| scope.token.key.identity.clone())
            .filter(|identity| matches_identity(identity, owner, epoch, turn))
            .collect::<HashSet<_>>();
        for identity in identities {
            self.seal(&identity);
        }
    }
    pub fn disconnect(&self, reason: &str) {
        let (prepares, checks, queued) = {
            let mut state = self.0.state.lock().unwrap();
            let error = uncertain(format!("Browser callback transport lost: {reason}"));
            state.closed.get_or_insert(error.clone());
            for entry in state.retained.values_mut() {
                entry.uncertain.get_or_insert(error.clone());
            }
            for entry in state.effects.values_mut().filter(|entry| entry.admitted) {
                entry.uncertain = true;
            }
            let queued = state
                .effects
                .iter()
                .filter(|(_, entry)| !entry.admitted)
                .map(|(key, _)| *key)
                .collect::<Vec<_>>();
            let queued = queued
                .into_iter()
                .filter_map(|key| state.effects.remove(&key))
                .collect::<Vec<_>>();
            (
                std::mem::take(&mut state.prepares),
                std::mem::take(&mut state.checks),
                queued,
            )
        };
        for pending in prepares.into_values() {
            let _ = pending.reply.send(Err(uncertain(reason)));
        }
        for reply in checks.into_values() {
            let _ = reply.send(Err(uncertain(reason)));
        }
        for entry in queued {
            if let Some(rejected) = entry.rejected {
                rejected(failed(
                    "Browser effect was not admitted before transport closed",
                ));
            }
        }
        self.0.changed.notify_waiters();
    }
    /// Public response waits for Parent custody acceptance, not the original RPC.
    /// A refusal waits for that same RPC to drain before returning its failure.
    pub async fn barrier(
        &self,
        identity: &ScopeIdentity,
        invocation_id: u64,
    ) -> Result<(), ToolError> {
        loop {
            let notified = self.0.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let ready = {
                let mut state = self.0.state.lock().unwrap();
                let mut waiting = false;
                let mut failure = None;
                for entry in state.retained.values().filter(|entry| {
                    &entry.scope.token.key.identity == identity
                        && entry.scope.invocation_id == invocation_id
                }) {
                    if let Some(error) = &entry.uncertain {
                        return Err(error.clone());
                    }
                    match &entry.ack {
                        RetentionAck::Pending => waiting = true,
                        RetentionAck::Accepted => {}
                        RetentionAck::Rejected(error) if entry.done => {
                            failure.get_or_insert(error.clone());
                        }
                        RetentionAck::Rejected(_) => waiting = true,
                    }
                }
                if let Some(error) = &state.closed {
                    return Err(error.clone());
                }
                if !waiting {
                    let keys = state
                        .retained
                        .iter()
                        .filter(|(_, entry)| {
                            &entry.scope.token.key.identity == identity
                                && entry.scope.invocation_id == invocation_id
                                && entry.done
                        })
                        .map(|(key, _)| *key)
                        .collect::<Vec<_>>();
                    let retired = keys
                        .into_iter()
                        .filter_map(|key| state.retained.remove(&key))
                        .collect::<Vec<_>>();
                    Some((failure, retired))
                } else {
                    None
                }
            };
            if let Some((result, retired)) = ready {
                drop(retired);
                return result.map_or(Ok(()), Err);
            }
            notified.await;
        }
    }
    pub fn has_unsettled(&self) -> bool {
        let state = self.0.state.lock().unwrap();
        !state.prepares.is_empty()
            || !state.checks.is_empty()
            || !state.effects.is_empty()
            || state
                .retained
                .values()
                .any(|entry| !entry.done || matches!(entry.ack, RetentionAck::Pending))
    }
}
fn worker_scope(state: &WorkerState, token: &ScopeToken) -> Result<Arc<RemoteScope>, ToolError> {
    known_worker_scope(state, token)?;
    state
        .scopes
        .get(&token.id)
        .and_then(|entry| entry.scope.upgrade())
        .ok_or_else(|| failed("Remote browser scope capability expired"))
}
fn known_worker_scope(state: &WorkerState, token: &ScopeToken) -> Result<(), ToolError> {
    if state
        .scopes
        .get(&token.id)
        .is_some_and(|scope| scope.token == *token)
    {
        Ok(())
    } else {
        Err(failed("Remote browser scope identity mismatch"))
    }
}
fn matches_identity(
    identity: &ScopeIdentity,
    owner: &str,
    epoch: Option<&str>,
    turn: Option<&str>,
) -> bool {
    identity.owner == owner
        && epoch.is_none_or(|epoch| identity.epoch == epoch)
        && turn.is_none_or(|turn| identity.turn == turn)
}
struct RemoteServices {
    worker: WorkerCallbacks,
    identity: ScopeIdentity,
    invocation_id: u64,
}
impl BrowserServicesProvider for RemoteServices {
    fn prepare(
        &self,
        access: BrowserAccess,
        cancellation: CancellationToken,
    ) -> BrowserServicesFuture {
        let worker = self.worker.clone();
        let key = ScopeKey {
            identity: self.identity.clone(),
            access,
        };
        let invocation_id = self.invocation_id;
        Box::pin(async move { worker.prepare(invocation_id, key, cancellation).await })
    }
}
struct RemoteScope {
    token: ScopeToken,
    invocation_id: u64,
    lease_children: bool,
    worker: WorkerCallbacks,
    sealed: AtomicBool,
}
impl Drop for RemoteScope {
    fn drop(&mut self) {
        let _ = (self.worker.0.send)(WorkerMessage::Release {
            token: self.token.clone(),
        });
    }
}
impl RemoteScope {
    fn check_attachment(
        &self,
        intent: AttachmentCheck,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let worker = self.worker.clone();
        let token = self.token.clone();
        let scope = worker_scope(&worker.0.state.lock().unwrap(), &token);
        Box::pin(async move {
            let _scope = scope?;
            let (id, response) = {
                let _emission = worker.0.emission.lock().unwrap();
                let id = allocate(&worker.0.next)?;
                let (reply, response) = oneshot::channel();
                {
                    let mut state = worker.0.state.lock().unwrap();
                    let scope = worker_scope(&state, &token)?;
                    if scope.sealed.load(Ordering::SeqCst)
                        || state.closed.is_some()
                        || cancellation.is_cancelled()
                    {
                        return Err(failed("Browser attachment check is closed"));
                    }
                    state.checks.insert((token.id, id), reply);
                }
                let message = match intent {
                    AttachmentCheck::Origin(origin) => WorkerMessage::Check {
                        token: token.clone(),
                        id,
                        origin: origin.into(),
                    },
                    AttachmentCheck::Metadata => WorkerMessage::CheckMetadata {
                        token: token.clone(),
                        id,
                    },
                };
                if let Err(error) = (worker.0.send)(message) {
                    worker
                        .0
                        .state
                        .lock()
                        .unwrap()
                        .checks
                        .remove(&(token.id, id));
                    return Err(error);
                }
                (id, response)
            };
            tokio::select! { biased; _ = cancellation.cancelled() => { let _ = (worker.0.send)(WorkerMessage::CancelCheck { token, id }); Err(failed("Browser attachment check cancelled")) }, result = response => result.map_err(|_| failed("Browser attachment check expired"))? }
        })
    }
}
impl BrowserAttachmentAuthorization for RemoteScope {
    fn check(
        &self,
        origin: BrowserAttachmentOrigin,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        self.check_attachment(AttachmentCheck::Origin(origin), cancellation)
    }
    fn check_metadata(&self, cancellation: CancellationToken) -> AuthorizationFuture {
        self.check_attachment(AttachmentCheck::Metadata, cancellation)
    }
}
impl BrowserHostEffects for RemoteScope {
    fn supports_lease_children(&self) -> bool {
        self.lease_children && !self.sealed.load(Ordering::SeqCst)
    }

    fn adopt_lease_child(&self, request: crate::BrowserLeaseChildRequest) -> HostEffectFuture {
        let worker = self.worker.clone();
        let token = self.token.clone();
        let supported = self.supports_lease_children();
        let scope = worker_scope(&worker.0.state.lock().unwrap(), &token);
        Box::pin(async move {
            let _scope = scope?;
            if !supported {
                return Err(failed("Remote lease-child Host service is unavailable"));
            }
            let response = {
                let _emission = worker.0.emission.lock().unwrap();
                let id = allocate(&worker.0.next)?;
                let (reply, response) = oneshot::channel();
                {
                    let mut state = worker.0.state.lock().unwrap();
                    let scope = worker_scope(&state, &token)?;
                    if scope.sealed.load(Ordering::SeqCst) || state.closed.is_some() {
                        return Err(failed("Remote lease-child source scope is closed"));
                    }
                    state.checks.insert((token.id, id), reply);
                }
                if let Err(error) = (worker.0.send)(WorkerMessage::LeaseChild {
                    token: token.clone(),
                    id,
                    request,
                }) {
                    worker
                        .0
                        .state
                        .lock()
                        .unwrap()
                        .checks
                        .remove(&(token.id, id));
                    return Err(error);
                }
                response
            };
            response.await.map_err(|_| {
                uncertain("Remote lease-child terminal observation was lost; do not replay")
            })?
        })
    }

    fn spawn(&self, _unpolled: HostEffectFuture) -> Result<(), ToolError> {
        Err(failed(
            "Remote Host effects require metadata rejection handling",
        ))
    }
    fn spawn_guarded(
        &self,
        unpolled: HostEffectFuture,
        rejected: Rejected,
    ) -> Result<(), ToolError> {
        self.enqueue_effect(PendingEffectWork::Future(unpolled), rejected)
    }
    fn spawn_scoped_guarded(
        &self,
        factory: HostEffectFactory,
        rejected: Rejected,
    ) -> Result<(), ToolError> {
        self.enqueue_effect(PendingEffectWork::Scoped(factory), rejected)
    }
}
impl RemoteScope {
    fn enqueue_effect(&self, work: PendingEffectWork, rejected: Rejected) -> Result<(), ToolError> {
        let scoped = matches!(&work, PendingEffectWork::Scoped(_));
        let _emission = self.worker.0.emission.lock().unwrap();
        let id = allocate(&self.worker.0.next)?;
        {
            let mut state = self.worker.0.state.lock().unwrap();
            let scope = worker_scope(&state, &self.token)?;
            if self.sealed.load(Ordering::SeqCst) || state.closed.is_some() {
                return Err(failed("Browser Host effect scope is closed"));
            }
            state.effects.insert(
                (self.token.id, id),
                PendingEffect {
                    scope,
                    pending: Some(work),
                    rejected: Some(rejected),
                    admitted: false,
                    uncertain: false,
                },
            );
        }
        let message = if scoped {
            WorkerMessage::EffectScoped {
                token: self.token.clone(),
                id,
            }
        } else {
            WorkerMessage::Effect {
                token: self.token.clone(),
                id,
            }
        };
        if let Err(error) = (self.worker.0.send)(message) {
            self.worker
                .0
                .state
                .lock()
                .unwrap()
                .effects
                .remove(&(self.token.id, id));
            return Err(error);
        }
        Ok(())
    }
}
impl RemoteScope {
    fn retain_rpc(&self, pending: RetentionFuture) -> Result<(), (ToolError, RetentionFuture)> {
        let _emission = self.worker.0.emission.lock().unwrap();
        let id = match allocate(&self.worker.0.next) {
            Ok(id) => id,
            Err(error) => return Err((error, pending)),
        };
        {
            let mut state = self.worker.0.state.lock().unwrap();
            let scope = match worker_scope(&state, &self.token) {
                Ok(scope) => scope,
                Err(error) => return Err((error, pending)),
            };
            if state.closed.is_some() {
                return Err((failed("Browser RPC custody is closed"), pending));
            }
            state.retained.insert(
                (self.token.id, id),
                PendingRetention {
                    scope,
                    pending: Some(pending),
                    ack: RetentionAck::Pending,
                    done: false,
                    uncertain: None,
                },
            );
        }
        if let Err(error) = (self.worker.0.send)(WorkerMessage::Retain {
            token: self.token.clone(),
            id,
        }) {
            let pending = self
                .worker
                .0
                .state
                .lock()
                .unwrap()
                .retained
                .remove(&(self.token.id, id))
                .unwrap()
                .pending
                .unwrap();
            return Err((error, pending));
        }
        let pending = self
            .worker
            .0
            .state
            .lock()
            .unwrap()
            .retained
            .get_mut(&(self.token.id, id))
            .unwrap()
            .pending
            .take()
            .unwrap();
        let worker = self.worker.clone();
        let token = self.token.clone();
        tokio::spawn(async move {
            RetentionCustody {
                worker,
                token,
                id,
                pending: Some(pending),
                failure: None,
            }
            .run()
            .await;
        });
        Ok(())
    }
}
struct RemoteEffectScope {
    worker: WorkerCallbacks,
    token: ScopeToken,
    effect_id: u64,
}
fn current_worker_effect(
    state: &WorkerState,
    token: &ScopeToken,
    effect_id: u64,
) -> Result<(), ToolError> {
    let scope = worker_scope(state, token)?;
    if state.closed.is_some()
        || scope.sealed.load(Ordering::SeqCst)
        || !state
            .effects
            .get(&(token.id, effect_id))
            .is_some_and(|effect| {
                effect.admitted && !effect.uncertain && effect.scope.token == *token
            })
    {
        return Err(failed("Remote Host effect preparation lifetime is closed"));
    }
    Ok(())
}
impl BrowserEffectScope for RemoteEffectScope {
    fn check_session_preparation(
        &self,
        binding: BrowserPreparationBinding,
        cancellation: CancellationToken,
    ) -> AuthorizationFuture {
        let worker = self.worker.clone();
        let token = self.token.clone();
        let effect_id = self.effect_id;
        Box::pin(async move {
            binding.check_turn(&token.key.identity.turn)?;
            let (id, response) = {
                let _emission = worker.0.emission.lock().unwrap();
                let id = allocate(&worker.0.next)?;
                let (reply, response) = oneshot::channel();
                {
                    let mut state = worker.0.state.lock().unwrap();
                    current_worker_effect(&state, &token, effect_id)?;
                    if cancellation.is_cancelled() {
                        return Err(failed("Remote Host effect preparation check cancelled"));
                    }
                    state.checks.insert((token.id, id), reply);
                }
                if let Err(error) = (worker.0.send)(WorkerMessage::CheckEffectPreparation {
                    token: token.clone(),
                    id,
                    effect_id,
                    binding,
                }) {
                    worker
                        .0
                        .state
                        .lock()
                        .unwrap()
                        .checks
                        .remove(&(token.id, id));
                    return Err(error);
                }
                (id, response)
            };
            let result = tokio::select! {
                biased;
                () = cancellation.cancelled() => {
                    let _ = (worker.0.send)(WorkerMessage::CancelCheck { token: token.clone(), id });
                    Err(failed("Remote Host effect preparation check cancelled"))
                }
                result = response => result.map_err(|_| failed("Remote Host effect preparation reply expired"))?,
            };
            // Never replace an uncertain real check with a local lifetime refusal.
            if result.as_ref().is_err_and(outcome_unknown) {
                return result;
            }
            current_worker_effect(&worker.0.state.lock().unwrap(), &token, effect_id)?;
            result
        })
    }
}

impl OperationSettlement for RemoteScope {
    fn retain(&self, pending: SettlementFuture) -> Result<(), (ToolError, SettlementFuture)> {
        match self.retain_rpc(RetentionFuture::Known(pending)) {
            Ok(()) => Ok(()),
            Err((error, RetentionFuture::Known(pending))) => Err((error, pending)),
            Err((_, RetentionFuture::Checked(_))) => {
                unreachable!("retention refusal preserves the supplied future variant")
            }
        }
    }

    fn retain_checked(
        &self,
        pending: CheckedSettlementFuture,
    ) -> Result<(), (ToolError, CheckedSettlementFuture)> {
        match self.retain_rpc(RetentionFuture::Checked(pending)) {
            Ok(()) => Ok(()),
            Err((error, RetentionFuture::Checked(pending))) => Err((error, pending)),
            Err((_, RetentionFuture::Known(_))) => {
                unreachable!("retention refusal preserves the supplied future variant")
            }
        }
    }
}
struct EffectCustody {
    worker: WorkerCallbacks,
    token: ScopeToken,
    id: u64,
    pending: Option<HostEffectFuture>,
}
impl EffectCustody {
    fn new(worker: WorkerCallbacks, token: ScopeToken, id: u64, pending: HostEffectFuture) -> Self {
        Self {
            worker,
            token,
            id,
            pending: Some(pending),
        }
    }
    async fn run(mut self) {
        let result = AssertUnwindSafe(self.pending.as_mut().unwrap().as_mut())
            .catch_unwind()
            .await;
        // Panicked polling retains its exact box in Drop.
        if let Ok(result) = result {
            self.pending.take(); // Terminal: never store this box as physical drain.
            {
                let mut state = self.worker.0.state.lock().unwrap();
                if result.as_ref().is_err_and(outcome_unknown) {
                    if let Some(entry) = state.effects.get_mut(&(self.token.id, self.id)) {
                        // Keep scope quarantine; actual native Session/Driver
                        // controllers retain physical custody independently.
                        entry.uncertain = true;
                    }
                } else {
                    state.effects.remove(&(self.token.id, self.id));
                }
            }
            let _ = (self.worker.0.send)(WorkerMessage::EffectFinished {
                token: self.token.clone(),
                id: self.id,
                result: result.map_err(Failure::from),
            });
            self.worker.0.changed.notify_waiters();
        }
    }
}
impl Drop for EffectCustody {
    fn drop(&mut self) {
        if let Some(pending) = self.pending.take() {
            if let Some(entry) = self
                .worker
                .0
                .state
                .lock()
                .unwrap()
                .effects
                .get_mut(&(self.token.id, self.id))
            {
                entry.pending = Some(PendingEffectWork::Future(pending));
                entry.uncertain = true;
            }
            let _ = (self.worker.0.send)(WorkerMessage::EffectUncertain {
                token: self.token.clone(),
                id: self.id,
                error: Failure::CleanupUnconfirmed(
                    "Original browser effect did not yield confirmed completion".into(),
                ),
            });
            self.worker.0.changed.notify_waiters();
        }
    }
}
struct RetentionCustody {
    worker: WorkerCallbacks,
    token: ScopeToken,
    id: u64,
    pending: Option<RetentionFuture>,
    failure: Option<ToolError>,
}
impl RetentionCustody {
    async fn run(mut self) {
        let outcome = AssertUnwindSafe(self.pending.as_mut().unwrap())
            .catch_unwind()
            .await;
        if matches!(&outcome, Ok(Ok(()))) {
            self.pending.take();
            let retired = {
                let mut state = self.worker.0.state.lock().unwrap();
                if let Some(entry) = state.retained.get_mut(&(self.token.id, self.id)) {
                    entry.done = true;
                    if matches!(entry.ack, RetentionAck::Accepted) {
                        state.retained.remove(&(self.token.id, self.id))
                    } else {
                        None
                    }
                } else {
                    None
                }
            };
            let _ = (self.worker.0.send)(WorkerMessage::RetainedFinished {
                token: self.token.clone(),
                id: self.id,
            });
            drop(retired);
            self.worker.0.changed.notify_waiters();
        } else {
            self.failure = Some(match outcome {
                Ok(Err(error)) => error,
                Err(_) => uncertain("Original browser RPC settlement worker panicked"),
                Ok(Ok(())) => unreachable!("confirmed settlement returned above"),
            });
        }
    }
}
impl Drop for RetentionCustody {
    fn drop(&mut self) {
        if let Some(pending) = self.pending.take() {
            let error = self
                .failure
                .take()
                .unwrap_or_else(|| uncertain("Original browser RPC settlement did not complete"));
            if let Some(entry) = self
                .worker
                .0
                .state
                .lock()
                .unwrap()
                .retained
                .get_mut(&(self.token.id, self.id))
            {
                entry.pending = Some(pending);
                entry.uncertain = Some(error.clone());
            }
            let _ = (self.worker.0.send)(WorkerMessage::RetainedUncertain {
                token: self.token.clone(),
                id: self.id,
                error: error.into(),
            });
            self.worker.0.changed.notify_waiters();
        }
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod scoped_effect_tests {
    use super::*;
    use futures_util::poll;
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

    #[derive(Default)]
    struct ServicesAuthority(AtomicUsize);
    impl BrowserAuthorization for ServicesAuthority {
        fn authorize(&self, _: BrowserAccess, _: CancellationToken) -> AuthorizationFuture {
            panic!("callback service preparation cannot request content permission");
        }
        fn check(&self, _: BrowserAccess, _: CancellationToken) -> AuthorizationFuture {
            self.0.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(()) })
        }
    }
    #[derive(Default)]
    struct ActualEffectScope {
        bindings: Mutex<Vec<BrowserPreparationBinding>>,
        started: Notify,
        wait_for_cancel: bool,
        failure: Option<ToolError>,
    }
    impl BrowserEffectScope for ActualEffectScope {
        fn check_session_preparation(
            &self,
            binding: BrowserPreparationBinding,
            cancellation: CancellationToken,
        ) -> AuthorizationFuture {
            self.bindings.lock().unwrap().push(binding);
            self.started.notify_one();
            let wait = self.wait_for_cancel;
            let failure = self.failure.clone();
            Box::pin(async move {
                if wait {
                    cancellation.cancelled().await;
                }
                failure.map_or(Ok(()), Err)
            })
        }
    }
    struct QueuedScopedEffect {
        factory: HostEffectFactory,
        uncertainty: HostUncertaintyFuture,
    }
    #[derive(Default)]
    struct ScopedHost(Mutex<Vec<QueuedScopedEffect>>);
    impl BrowserHostEffects for ScopedHost {
        fn spawn(&self, _: HostEffectFuture) -> Result<(), ToolError> {
            panic!("scoped work cannot fall back to unguarded effects");
        }
        fn spawn_custodied(
            &self,
            _: HostEffectFuture,
            _: HostUncertaintyFuture,
            _: Rejected,
        ) -> Result<(), ToolError> {
            panic!("scoped work requires its actual effect scope");
        }
        fn spawn_scoped_custodied(
            &self,
            factory: HostEffectFactory,
            uncertainty: HostUncertaintyFuture,
            _: Rejected,
        ) -> Result<(), ToolError> {
            // The fixture controls this admission boundary. It does not model
            // the real Host resource ledger or claim a native lease is valid.
            self.0.lock().unwrap().push(QueuedScopedEffect {
                factory,
                uncertainty,
            });
            Ok(())
        }
    }
    struct Fixture {
        parent: ParentCallbacks,
        worker: WorkerCallbacks,
        parent_messages: mpsc::UnboundedReceiver<ParentMessage>,
        worker_messages: mpsc::UnboundedReceiver<WorkerMessage>,
        faults: mpsc::UnboundedReceiver<ToolError>,
    }
    fn identity() -> ScopeIdentity {
        ScopeIdentity {
            owner: "transport-owner".into(),
            epoch: "transport-epoch".into(),
            session: "session".into(),
            turn: "turn".into(),
            operation_id: "completed-input-operation".into(),
        }
    }
    fn key() -> ScopeKey {
        ScopeKey {
            identity: identity(),
            access: BrowserAccess::Read {
                document: crate::BrowserDocument {
                    browser_id: "browser".into(),
                    generation: "generation".into(),
                    tab_id: "opener".into(),
                    url: "https://fixture.test/".into(),
                },
            },
        }
    }
    fn binding() -> BrowserPreparationBinding {
        BrowserPreparationBinding {
            native_owner: uuid::Uuid::from_u128(37),
            native_epoch: "actual-native-epoch".into(),
            browser_id: "browser".into(),
            generation: "generation".into(),
            turn_id: "turn".into(),
            tab_id: "actual-retained-tab".into(),
            claim_id: "actual-retained-claim".into(),
        }
    }
    impl Fixture {
        fn new() -> Self {
            let (parent_sender, parent_messages) = mpsc::unbounded_channel();
            let (worker_sender, worker_messages) = mpsc::unbounded_channel();
            let (fault, faults) = mpsc::unbounded_channel();
            Self {
                parent: ParentCallbacks::new(
                    Arc::new(move |message| {
                        // Exercise the actual closed DTOs, never serialize a future.
                        let bytes = serde_json::to_vec(&message).unwrap();
                        parent_sender
                            .send(serde_json::from_slice(&bytes).unwrap())
                            .map_err(|_| failed("fixture parent closed"))
                    }),
                    fault,
                ),
                worker: WorkerCallbacks::new(Arc::new(move |message| {
                    let bytes = serde_json::to_vec(&message).unwrap();
                    worker_sender
                        .send(serde_json::from_slice(&bytes).unwrap())
                        .map_err(|_| failed("fixture worker closed"))
                })),
                parent_messages,
                worker_messages,
                faults,
            }
        }
        async fn worker_message(&mut self) -> WorkerMessage {
            tokio::time::timeout(Duration::from_secs(2), self.worker_messages.recv())
                .await
                .unwrap()
                .unwrap()
        }
        async fn parent_message(&mut self) -> ParentMessage {
            tokio::time::timeout(Duration::from_secs(2), self.parent_messages.recv())
                .await
                .unwrap()
                .unwrap()
        }
        async fn prepare(
            &mut self,
            host: Arc<dyn BrowserHostEffects>,
        ) -> (BrowserServices, Arc<ServicesAuthority>) {
            let worker = self.worker.clone();
            let waiting =
                tokio::spawn(
                    async move { worker.prepare(11, key(), CancellationToken::new()).await },
                );
            let WorkerMessage::Prepare {
                request_id, key, ..
            } = self.worker_message().await
            else {
                panic!("expected existing service preparation");
            };
            let authority = Arc::new(ServicesAuthority::default());
            self.parent
                .prepare(
                    request_id,
                    key,
                    &identity(),
                    ParentCapabilities {
                        authorization: Some(authority.clone()),
                        effects: Some(host),
                        ..Default::default()
                    },
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            let prepared = self.parent_message().await;
            self.worker.handle(prepared).unwrap();
            (waiting.await.unwrap().unwrap(), authority)
        }
        async fn start(
            &mut self,
            services: &BrowserServices,
            host: &ScopedHost,
            actual: Arc<ActualEffectScope>,
        ) -> (
            ScopeToken,
            u64,
            HostEffectFuture,
            HostUncertaintyFuture,
            Arc<dyn BrowserEffectScope>,
            oneshot::Sender<Result<(), ToolError>>,
        ) {
            let (scope_sender, scope_receiver) = oneshot::channel();
            let (finish, finished) = oneshot::channel();
            services
                .effects
                .as_ref()
                .unwrap()
                .spawn_scoped_guarded(
                    Box::new(move |scope| {
                        scope_sender.send(scope).ok().unwrap();
                        Box::pin(async move { finished.await.unwrap() })
                    }),
                    Box::new(|error| panic!("unexpected fixture refusal: {error}")),
                )
                .unwrap();
            let frame = self.worker_message().await;
            let WorkerMessage::EffectScoped { token, id } = frame.clone() else {
                panic!("expected a distinct scoped effect request");
            };
            self.parent.handle(frame).unwrap();
            assert!(
                effect_preparation_scope(&self.parent.0.state.lock().unwrap(), &token, id).is_err()
            );
            let queued = host.0.lock().unwrap().pop().unwrap();
            let mut pending = (queued.factory)(actual);
            assert!(poll!(pending.as_mut()).is_pending());
            let admit = self.parent_message().await;
            assert!(
                matches!(&admit, ParentMessage::Admit { token: actual, id: effect } if actual == &token && *effect == id)
            );
            self.worker.handle(admit).unwrap();
            let scope = tokio::time::timeout(Duration::from_secs(2), scope_receiver)
                .await
                .unwrap()
                .unwrap();
            (token, id, pending, queued.uncertainty, scope, finish)
        }
    }

    #[tokio::test]
    async fn real_callback_bridge_mints_proxy_only_after_host_admission_and_retires_at_terminal() {
        let mut fixture = Fixture::new();
        let host = Arc::new(ScopedHost::default());
        let (services, authority) = fixture.prepare(host.clone()).await;
        let called = Arc::new(AtomicUsize::new(0));
        let observed = called.clone();
        let (scope_sender, scope_receiver) = oneshot::channel();
        let (finish, finished) = oneshot::channel();
        services
            .effects
            .as_ref()
            .unwrap()
            .spawn_scoped_guarded(
                Box::new(move |scope| {
                    observed.fetch_add(1, Ordering::SeqCst);
                    scope_sender.send(scope).ok().unwrap();
                    Box::pin(async move {
                        finished.await.unwrap();
                        Ok(())
                    })
                }),
                Box::new(|error| panic!("unexpected fixture refusal: {error}")),
            )
            .unwrap();
        assert_eq!(called.load(Ordering::SeqCst), 0);
        let frame = fixture.worker_message().await;
        let WorkerMessage::EffectScoped { token, id } = frame.clone() else {
            panic!("expected scoped request");
        };
        fixture.parent.handle(frame).unwrap();
        assert_eq!(called.load(Ordering::SeqCst), 0);
        let actual = Arc::new(ActualEffectScope::default());
        let queued = host.0.lock().unwrap().pop().unwrap();
        let mut pending = (queued.factory)(actual.clone());
        assert_eq!(called.load(Ordering::SeqCst), 0);
        assert!(poll!(pending.as_mut()).is_pending());
        let admitted = fixture.parent_message().await;
        fixture.worker.handle(admitted).unwrap();
        let scope = tokio::time::timeout(Duration::from_secs(2), scope_receiver)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(called.load(Ordering::SeqCst), 1);
        let requested = binding();
        let mut checking =
            scope.check_session_preparation(requested.clone(), CancellationToken::new());
        assert!(poll!(checking.as_mut()).is_pending());
        let check = fixture.worker_message().await;
        assert!(
            matches!(&check, WorkerMessage::CheckEffectPreparation { effect_id, binding, .. } if *effect_id == id && binding == &requested)
        );
        fixture.parent.handle(check).unwrap();
        let checked = fixture.parent_message().await;
        fixture.worker.handle(checked).unwrap();
        checking.await.unwrap();
        assert_eq!(*actual.bindings.lock().unwrap(), vec![requested]);
        assert_eq!(
            authority.0.load(Ordering::SeqCst),
            1,
            "only initial services use ordinary content checks"
        );
        finish.send(()).unwrap();
        let terminal = fixture.worker_message().await;
        assert!(matches!(
            &terminal,
            WorkerMessage::EffectFinished { result: Ok(()), .. }
        ));
        assert!(
            scope
                .check_session_preparation(binding(), CancellationToken::new())
                .await
                .is_err(),
            "local capability closes before terminal frame is observed by parent"
        );
        fixture.parent.handle(terminal).unwrap();
        pending.await.unwrap();
        assert!(
            effect_preparation_scope(&fixture.parent.0.state.lock().unwrap(), &token, id).is_err()
        );
        assert!(fixture.worker_messages.try_recv().is_err());
        assert!(fixture.faults.try_recv().is_err());
    }

    #[tokio::test]
    async fn real_callback_bridge_refuses_foreign_old_and_sealed_effect_scope_without_host_check() {
        let mut fixture = Fixture::new();
        let host = Arc::new(ScopedHost::default());
        let (services, _) = fixture.prepare(host.clone()).await;
        let actual = Arc::new(ActualEffectScope::default());
        let (token, effect_id, pending, _, scope, finish) =
            fixture.start(&services, &host, actual.clone()).await;
        let mut foreign = token.clone();
        foreign.key.identity.epoch = "old-epoch".into();
        assert!(
            fixture
                .parent
                .handle(WorkerMessage::CheckEffectPreparation {
                    token: foreign,
                    id: 900,
                    effect_id,
                    binding: binding(),
                })
                .is_err()
        );
        for (id, wrong_effect, requested) in [
            (901, effect_id + 1, binding()),
            (902, effect_id, {
                let mut wrong = binding();
                wrong.turn_id = "old-turn".into();
                wrong
            }),
        ] {
            fixture
                .parent
                .handle(WorkerMessage::CheckEffectPreparation {
                    token: token.clone(),
                    id,
                    effect_id: wrong_effect,
                    binding: requested,
                })
                .unwrap();
            assert!(matches!(
                fixture.parent_message().await,
                ParentMessage::Checked {
                    result: Err(Failure::Failed(_)),
                    ..
                }
            ));
        }
        fixture.parent.seal(&identity());
        let sealed = fixture.parent_message().await;
        fixture.worker.handle(sealed).unwrap();
        assert!(
            scope
                .check_session_preparation(binding(), CancellationToken::new())
                .await
                .is_err()
        );
        assert!(actual.bindings.lock().unwrap().is_empty());
        assert!(fixture.worker_messages.try_recv().is_err());
        finish.send(Ok(())).unwrap();
        let terminal = fixture.worker_message().await;
        fixture.parent.handle(terminal).unwrap();
        pending.await.unwrap();
        assert!(fixture.faults.try_recv().is_err());
    }

    #[tokio::test]
    async fn cancelled_scope_check_preserves_actual_cleanup_uncertainty_and_physical_tail() {
        let mut fixture = Fixture::new();
        let host = Arc::new(ScopedHost::default());
        let (services, _) = fixture.prepare(host.clone()).await;
        let actual_error = uncertain("actual scoped check cleanup");
        let ToolError::CleanupUnconfirmed(expected_cleanup) =
            super::super::authorization_cleanup(Err(actual_error.clone())).unwrap()
        else {
            panic!("existing authorization classifier must preserve cleanup uncertainty");
        };
        let actual = Arc::new(ActualEffectScope {
            wait_for_cancel: true,
            failure: Some(actual_error),
            ..Default::default()
        });
        let (_, _, mut pending, mut uncertainty, scope, finish) =
            fixture.start(&services, &host, actual.clone()).await;
        let cancellation = CancellationToken::new();
        let mut checking = scope.check_session_preparation(binding(), cancellation.clone());
        assert!(poll!(checking.as_mut()).is_pending());
        let check = fixture.worker_message().await;
        fixture.parent.handle(check).unwrap();
        tokio::time::timeout(Duration::from_secs(2), actual.started.notified())
            .await
            .unwrap();
        cancellation.cancel();
        assert!(matches!(checking.await, Err(ToolError::Failed(_))));
        let cancel = fixture.worker_message().await;
        assert!(matches!(&cancel, WorkerMessage::CancelCheck { .. }));
        fixture.parent.handle(cancel).unwrap();
        let checked = fixture.parent_message().await;
        assert!(
            matches!(&checked, ParentMessage::Checked { result: Err(Failure::CleanupUnconfirmed(message)), .. } if message == &expected_cleanup)
        );
        fixture.worker.handle(checked).unwrap();
        let fault = tokio::time::timeout(Duration::from_secs(2), fixture.faults.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(fault, ToolError::CleanupUnconfirmed(message) if message == expected_cleanup)
        );
        assert!(matches!(
            poll!(uncertainty.as_mut()),
            Poll::Ready(ToolError::CleanupUnconfirmed(_))
        ));
        assert!(
            poll!(pending.as_mut()).is_pending(),
            "uncertainty does not fabricate the physical terminal"
        );
        assert!(fixture.parent.has_unsettled());
        let mut closed_check = scope.check_session_preparation(binding(), CancellationToken::new());
        assert!(poll!(closed_check.as_mut()).is_pending());
        let check = fixture.worker_message().await;
        fixture.parent.handle(check).unwrap();
        let checked = fixture.parent_message().await;
        fixture.worker.handle(checked).unwrap();
        assert!(closed_check.await.is_err());
        finish.send(Ok(())).unwrap();
        let terminal = fixture.worker_message().await;
        fixture.parent.handle(terminal).unwrap();
        pending.await.unwrap();
        assert!(
            fixture.parent.has_unsettled(),
            "unconfirmed authority cleanup remains retained"
        );
    }

    #[tokio::test]
    async fn scoped_terminal_unknown_closes_proxy_and_keeps_original_uncertain_effect_record() {
        let mut fixture = Fixture::new();
        let host = Arc::new(ScopedHost::default());
        let (services, _) = fixture.prepare(host.clone()).await;
        let actual = Arc::new(ActualEffectScope::default());
        let (token, id, pending, _, scope, finish) =
            fixture.start(&services, &host, actual.clone()).await;
        finish
            .send(Err(ToolError::OutcomeUnknown(
                "actual native result unknown".into(),
            )))
            .unwrap();
        let terminal = fixture.worker_message().await;
        assert!(
            matches!(&terminal, WorkerMessage::EffectFinished { result: Err(Failure::OutcomeUnknown(message)), .. } if message == "actual native result unknown")
        );
        assert!(
            scope
                .check_session_preparation(binding(), CancellationToken::new())
                .await
                .is_err()
        );
        assert!(
            fixture
                .worker
                .0
                .state
                .lock()
                .unwrap()
                .effects
                .get(&(token.id, id))
                .unwrap()
                .uncertain
        );
        fixture.parent.handle(terminal).unwrap();
        assert!(
            matches!(pending.await, Err(ToolError::OutcomeUnknown(message)) if message == "actual native result unknown")
        );
        assert!(
            fixture.worker.has_unsettled(),
            "native uncertainty is not fake RPC cleanup"
        );
        assert!(actual.bindings.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn dropping_actual_bridge_closes_narrow_scope_without_faking_effect_completion() {
        let mut fixture = Fixture::new();
        let host = Arc::new(ScopedHost::default());
        let (services, _) = fixture.prepare(host.clone()).await;
        let actual = Arc::new(ActualEffectScope::default());
        let (token, id, pending, _, scope, finish) =
            fixture.start(&services, &host, actual.clone()).await;
        drop(pending);
        assert!(
            effect_preparation_scope(&fixture.parent.0.state.lock().unwrap(), &token, id).is_err()
        );
        let mut checking = scope.check_session_preparation(binding(), CancellationToken::new());
        assert!(poll!(checking.as_mut()).is_pending());
        let check = fixture.worker_message().await;
        fixture.parent.handle(check).unwrap();
        let checked = fixture.parent_message().await;
        fixture.worker.handle(checked).unwrap();
        assert!(checking.await.is_err());
        assert!(actual.bindings.lock().unwrap().is_empty());
        assert!(fixture.parent.has_unsettled());
        finish.send(Ok(())).unwrap();
        let terminal = fixture.worker_message().await;
        fixture.parent.handle(terminal).unwrap();
        assert!(!fixture.parent.has_unsettled());
    }

    struct LegacyHost;
    impl BrowserHostEffects for LegacyHost {
        fn spawn(&self, _: HostEffectFuture) -> Result<(), ToolError> {
            panic!("scoped effects cannot fall back to an ordinary Host implementation");
        }
    }
    #[tokio::test]
    async fn legacy_host_default_refuses_scoped_effect_without_calling_child_factory() {
        let mut fixture = Fixture::new();
        let (services, _) = fixture.prepare(Arc::new(LegacyHost)).await;
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let (rejected, rejection) = oneshot::channel();
        services
            .effects
            .as_ref()
            .unwrap()
            .spawn_scoped_guarded(
                Box::new(move |_| {
                    observed.fetch_add(1, Ordering::SeqCst);
                    Box::pin(async { Ok(()) })
                }),
                Box::new(move |error| {
                    rejected.send(error).ok().unwrap();
                }),
            )
            .unwrap();
        let effect = fixture.worker_message().await;
        assert!(matches!(&effect, WorkerMessage::EffectScoped { .. }));
        fixture.parent.handle(effect).unwrap();
        let refused = fixture.parent_message().await;
        assert!(matches!(
            &refused,
            ParentMessage::Rejected {
                error: Failure::Failed(_),
                ..
            }
        ));
        fixture.worker.handle(refused).unwrap();
        assert!(matches!(rejection.await.unwrap(), ToolError::Failed(_)));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let declined = fixture.worker_message().await;
        assert!(matches!(&declined, WorkerMessage::EffectDeclined { .. }));
        fixture.parent.handle(declined).unwrap();
        assert!(!fixture.parent.has_unsettled());
        assert!(!fixture.worker.has_unsettled());
        assert!(fixture.faults.try_recv().is_err());
    }
}
