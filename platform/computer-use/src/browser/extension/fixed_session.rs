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

//! Exact logical fixed preparation in the existing extension Host ledger.
//! SDK receipts and UI outcomes never become debugger claims or Site grants.

use super::*;
use crate::cursor::{Color, RenderState, Spec};
use cua_driver_core::browser::{
    ExtensionFixedSessionCleanupProof, ExtensionFixedSessionPreparedTab,
    ExtensionFixedSessionReceipt, ExtensionFixedUiAck, ExtensionFixedUiAction,
    ExtensionFixedUiColor, ExtensionFixedUiCursor, ExtensionFixedUiOperation,
    ExtensionFixedUiProof, ExtensionFixedUiRequest, ExtensionSessionCleanupObservation,
    ExtensionSessionPreparation,
};
use std::sync::atomic::AtomicU8;

#[derive(Clone)]
pub(in crate::browser) struct FixedAttempt {
    operation: ExtensionHostOperation,
    epoch: crate::desktop::NativeEpochId,
    policy: ExtensionPreparationPolicy,
    ui: ExtensionFixedUiRequest,
    dispatch: Arc<AtomicU8>,
}

#[derive(Clone)]
enum FixedPhase {
    Ready,
    Unknown,
    Clearing,
    Cleared {
        proof: ExtensionFixedSessionCleanupProof,
    },
}

const UI_RESERVED: u8 = 0;
const UI_MAY_DISPATCH: u8 = 1;
const UI_RETIRED: u8 = 2;

#[derive(Clone)]
struct FixedUiAttempt {
    operation: ExtensionHostOperation,
    epoch: crate::desktop::NativeEpochId,
    request: ExtensionFixedUiRequest,
    dispatch: Arc<AtomicU8>,
}

#[derive(Clone)]
struct FixedClearAttempt {
    operation: Option<ExtensionHostOperation>,
    dispatch: Arc<AtomicU8>,
}

#[derive(Clone)]
struct FixedUiRecord {
    operation: ExtensionHostOperation,
    epoch: crate::desktop::NativeEpochId,
    completion_id: u64,
    dispatch: Arc<AtomicU8>,
}

// Borrowed only by the original caller's immediate commit; never cached authority.
struct FixedUiCompletion<'a> {
    scope: &'a CallScope,
    request: &'a ExtensionFixedUiRequest,
    proof: &'a ExtensionFixedUiProof,
    dispatch: &'a Arc<AtomicU8>,
}

#[derive(Clone)]
pub(in crate::browser) struct FixedResource {
    attempt: FixedAttempt,
    receipt: Option<ExtensionFixedSessionReceipt>,
    acknowledged: Option<ExtensionFixedSessionPreparedTab>,
    last_ui: Option<FixedUiRecord>,
    current_ui: ExtensionFixedUiRequest,
    pending_ui: Option<FixedUiAttempt>,
    clear_attempt: Option<FixedClearAttempt>,
    phase: FixedPhase,
    // Clearing the exact resource never erases uncertainty in its earlier effect.
    uncertainty: Option<String>,
}

#[derive(Clone, Default)]
pub(in crate::browser) enum FixedPreparation {
    #[default]
    NotAttempted,
    Pending(FixedAttempt),
    Retained(Box<FixedResource>),
}

impl FixedPreparation {
    pub(super) fn ready(&self) -> Option<&ExtensionFixedSessionPreparedTab> {
        match self {
            Self::Retained(resource)
                if matches!(resource.phase, FixedPhase::Ready)
                    && resource.uncertainty.is_none() =>
            {
                resource.acknowledged.as_ref()
            }
            _ => None,
        }
    }
    pub(super) fn cleanup_receipt(&self) -> Option<&ExtensionFixedSessionReceipt> {
        match self {
            Self::Retained(resource) => resource.receipt.as_ref(),
            _ => None,
        }
    }
    pub(super) fn operation(&self) -> Option<&ExtensionHostOperation> {
        self.attempt().map(|attempt| &attempt.operation)
    }
    pub(super) fn settled(&self) -> bool {
        matches!(self, Self::NotAttempted)
            || matches!(self, Self::Retained(resource)
                if matches!(resource.phase, FixedPhase::Cleared { .. })
                    && resource.uncertainty.is_none())
    }
    pub(super) fn cleanup_confirmed(&self) -> bool {
        matches!(self, Self::Retained(resource)
            if matches!(resource.phase, FixedPhase::Cleared { .. }))
    }
    fn matches_attempt(&self, expected: &FixedAttempt) -> bool {
        self.attempt().is_some_and(|current| {
            current.operation == expected.operation
                && current.epoch == expected.epoch
                && Arc::ptr_eq(&current.dispatch, &expected.dispatch)
        })
    }
    fn attempt(&self) -> Option<&FixedAttempt> {
        match self {
            Self::Pending(attempt) => Some(attempt),
            Self::Retained(resource) => Some(&resource.attempt),
            Self::NotAttempted => None,
        }
    }
}

#[derive(Clone)]
pub(in crate::browser) struct FixedPresentationScope {
    operation: ExtensionHostOperation,
    epoch: crate::desktop::NativeEpochId,
    request: crate::BrowserSessionPreparation,
    authorization: Arc<dyn crate::BrowserAuthorization>,
    cancellation: CancellationToken,
}
impl FixedPresentationScope {
    pub(super) fn capture(
        scope: &CallScope,
        request: crate::BrowserSessionPreparation,
        invocation: &crate::InvocationContext<'_>,
        cancellation: &CancellationToken,
    ) -> Result<Self, ToolError> {
        request.check_scope(invocation.turn(), &operation(invocation)?.operation_id)?;
        if request.native_owner != scope.owner
            || request.native_epoch != scope.epoch.to_string()
            || request.browser_id != scope.provider.id()
            || request.turn_id != scope.context.turn_id
            || request.operation_id != scope.context.operation_id
            || scope.purpose == CallPurpose::FixedConfiguration
            || !matches!(
                &request.target,
                crate::BrowserPreparationTarget::FixedSessionTab { .. }
            )
        {
            return Err(unknown(
                "fixed UI capture changed its actual issued Host scope",
            ));
        }
        Ok(Self {
            operation: scope.context.clone(),
            epoch: scope.epoch,
            request,
            authorization: invocation
                .browser_authorization()
                .ok_or_else(|| failed("fixed UI requires current Host authorization"))?,
            cancellation: cancellation.clone(),
        })
    }
}

fn ui_request(
    cursor: &Spec,
    epoch: crate::desktop::NativeEpochId,
    point: Option<[f64; 2]>,
    action: &str,
    operation: ExtensionFixedUiOperation,
) -> Result<ExtensionFixedUiRequest, ToolError> {
    let action = match action {
        "idle" => ExtensionFixedUiAction::Idle,
        "click" => ExtensionFixedUiAction::Click,
        "key" => ExtensionFixedUiAction::Key,
        "scroll" => ExtensionFixedUiAction::Scroll,
        "drag" => ExtensionFixedUiAction::Drag,
        "observe" => ExtensionFixedUiAction::Observe,
        _ => return Err(failed("unsupported fixed UI action")),
    };
    if point.is_some_and(|point| point.iter().any(|value| !value.is_finite())) {
        return Err(failed("fixed UI point must be finite"));
    }
    Ok(ExtensionFixedUiRequest {
        operation,
        cursor: ExtensionFixedUiCursor {
            id: cursor.id.clone(),
            label: cursor.label.clone(),
            color: match cursor.color {
                Color::Blue => ExtensionFixedUiColor::Blue,
                Color::Mint => ExtensionFixedUiColor::Mint,
                Color::Violet => ExtensionFixedUiColor::Violet,
                Color::Amber => ExtensionFixedUiColor::Amber,
                Color::Rose => ExtensionFixedUiColor::Rose,
                Color::Cyan => ExtensionFixedUiColor::Cyan,
            },
            enabled: cursor.enabled,
            reduced_motion: cursor.reduced_motion,
        },
        owner_epoch: epoch.to_string(),
        point,
        action,
    })
}

fn render(ack: &ExtensionFixedUiAck) -> Result<RenderState, ToolError> {
    Ok(match ack {
        ExtensionFixedUiAck::Attempted {
            acknowledged: true,
            state: Some(state),
            ..
        } => serde_json::from_value(json!({"status":"ready","visible":state.visible,
                "requestedPosition":state.requested_position}))
        .map_err(failed)?,
        ExtensionFixedUiAck::NotAttempted => RenderState::unavailable("fixed UI was not attempted"),
        ExtensionFixedUiAck::Unknown => return Err(unknown("fixed UI outcome remains unknown")),
        ExtensionFixedUiAck::Attempted { .. } => {
            RenderState::unavailable("fixed UI renderer did not acknowledge its state")
        }
    })
}

fn same_receipt(left: &ExtensionFixedSessionReceipt, right: &ExtensionFixedSessionReceipt) -> bool {
    left.scope_id() == right.scope_id()
        && left.tab_id() == right.tab_id()
        && left.generation() == right.generation()
        && left.wire_context() == right.wire_context()
        && left.completion_id() == right.completion_id()
}

impl Host {
    fn fixed_state(
        &self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
    ) -> Result<&ClaimState, ToolError> {
        let lease = self
            .tabs
            .get(identity)
            .ok_or_else(|| unknown("fixed session lost its actual lease"))?;
        let expected_owner = lease
            .handoff_transfer
            .as_ref()
            .map_or(lease.creator.owner, |attempt| attempt.requested.owner);
        if expected_owner != owner || lease.creator.provider.extension().is_none() {
            return Err(unknown("fixed session changed its actual owner/provider"));
        }
        lease
            .extension
            .as_ref()
            .ok_or_else(|| unknown("fixed session lost extension custody"))
    }
    fn fixed_state_mut(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
    ) -> Result<&mut ClaimState, ToolError> {
        self.fixed_state(owner, identity)?;
        self.tabs
            .get_mut(identity)
            .and_then(|lease| lease.extension.as_mut())
            .ok_or_else(|| unknown("fixed session lost extension custody"))
    }
    fn fixed_identity(
        &self,
        owner: uuid::Uuid,
        provider: &Provider,
        tab_id: u64,
    ) -> Result<TabIdentity, ToolError> {
        let extension = provider
            .extension()
            .ok_or_else(|| failed("fixed session requires a extension provider"))?;
        let identity = BrowserIdentity::of(provider, &extension.identity().generation)?
            .tab(&tab_id.to_string());
        self.fixed_state(owner, &identity)?;
        if self.tabs[&identity].creator.provider != *provider {
            return Err(unknown(
                "fixed session resource belongs to a different provider",
            ));
        }
        Ok(identity)
    }
    fn fixed_attempt_for(
        &self,
        owner: uuid::Uuid,
        provider: &Provider,
        operation: &ExtensionOperation,
        context: Option<&ExtensionHostOperation>,
    ) -> Result<(TabIdentity, FixedAttempt), ToolError> {
        let ExtensionOperation::PrepareFixedSessionTab {
            tab_id,
            popup_enabled,
            header_enabled,
            ui,
            ..
        } = operation
        else {
            return Err(unknown(
                "fixed preparation result has another issued operation",
            ));
        };
        let identity = self.fixed_identity(owner, provider, *tab_id)?;
        let context =
            context.ok_or_else(|| unknown("fixed preparation lost its issued Host operation"))?;
        let call = self
            .extension
            .get(&(owner, identity.browser.clone()))
            .and_then(|state| state.calls.get(&context.operation_id))
            .ok_or_else(|| unknown("fixed preparation lost its issued CallContext"))?;
        let attempt = self
            .fixed_state(owner, &identity)?
            .fixed_preparation
            .attempt()
            .ok_or_else(|| unknown("fixed preparation was never admitted by Main"))?;
        if &attempt.operation != context
            || attempt.epoch != call.epoch
            || call.turn != context.turn_id
            || *popup_enabled != attempt.policy.popup_enabled
            || *header_enabled != attempt.policy.header_enabled
            || ui.cursor_id() != attempt.ui.cursor.id
            || ui.owner_epoch() != attempt.ui.owner_epoch
            || ui.operation() != attempt.ui.operation
        {
            return Err(unknown(
                "fixed preparation changed its actual issued policy/UI/context",
            ));
        }
        Ok((identity, attempt.clone()))
    }
    fn validate_fixed_receipt(
        &self,
        owner: uuid::Uuid,
        provider: &Provider,
        operation: &ExtensionOperation,
        attempt: &FixedAttempt,
        receipt: &ExtensionFixedSessionReceipt,
    ) -> Result<(), ToolError> {
        let ExtensionOperation::PrepareFixedSessionTab {
            tab_id, scope_id, ..
        } = operation
        else {
            return Err(unknown("fixed receipt has another issued operation"));
        };
        if receipt.tab_id() != *tab_id
            || receipt.scope_id() != scope_id
            || receipt.generation()
                != provider
                    .extension()
                    .ok_or_else(|| failed("extension provider required"))?
                    .identity()
                    .generation
            || receipt.wire_context().host_session_id() != owner.to_string()
            || receipt.wire_context().host_turn_id() != attempt.operation.turn_id
            || receipt.ui_identity().cursor_id() != attempt.ui.cursor.id
            || receipt.ui_identity().owner_epoch() != attempt.ui.owner_epoch
            || receipt.ui_identity().operation() != attempt.ui.operation
        {
            return Err(unknown(
                "fixed receipt differs from its actual issued operation",
            ));
        }
        Ok(())
    }
    pub(super) fn begin_fixed_preparation(
        &mut self,
        scope: &CallScope,
        identity: &TabIdentity,
        policy: ExtensionPreparationPolicy,
        ui: ExtensionFixedUiRequest,
    ) -> Result<(), ToolError> {
        let state = self.fixed_state_mut(scope.owner, identity)?;
        match &state.fixed_preparation {
            FixedPreparation::NotAttempted => {}
            FixedPreparation::Retained(resource)
                if matches!(resource.phase, FixedPhase::Cleared { .. })
                    && resource.uncertainty.is_none() => {}
            _ => {
                return Err(ToolError::CleanupUnconfirmed(
                    "fixed preparation is retained; it was not replayed".into(),
                ));
            }
        }
        state.fixed_preparation = FixedPreparation::Pending(FixedAttempt {
            operation: scope.context.clone(),
            epoch: scope.epoch,
            policy,
            ui,
            dispatch: Arc::new(AtomicU8::new(UI_RESERVED)),
        });
        Ok(())
    }
    pub(super) fn apply_fixed_preparation(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        operation: &ExtensionOperation,
        context: Option<&ExtensionHostOperation>,
        prepared: ExtensionFixedSessionPreparedTab,
    ) -> Result<(), ToolError> {
        let (identity, attempt) = self.fixed_attempt_for(owner, provider, operation, context)?;
        self.validate_fixed_receipt(owner, provider, operation, &attempt, &prepared.receipt)?;
        if prepared.receipt.is_cleanup_only() || prepared.tab.id != prepared.receipt.tab_id() {
            return Err(unknown(
                "fixed preparation ACK is cleanup-only or changed its target",
            ));
        }
        let lease = &self.tabs[&identity];
        let current = matches!(lease.disposition, Disposition::Live)
            && self
                .extension
                .get(&(owner, identity.browser.clone()))
                .is_some_and(|state| {
                    state.current_turn.as_deref() == Some(attempt.operation.turn_id.as_str())
                        && state.retiring_turn.is_none()
                        && state
                            .calls
                            .get(&attempt.operation.operation_id)
                            .is_some_and(|call| {
                                call.turn == attempt.operation.turn_id
                                    && call.epoch == attempt.epoch
                                    && !call.controls.is_sealed()
                            })
                })
            && lease.extension.as_ref().is_some_and(|state| {
                !state.closed && state.unknown.is_none() && state.cdp_effect_unknown.is_none()
            });
        let state = self.fixed_state_mut(owner, &identity)?;
        let mut uncertainty = match &state.fixed_preparation {
            FixedPreparation::Retained(resource) => resource.uncertainty.clone(),
            _ => None,
        };
        if !current {
            uncertainty.get_or_insert_with(|| {
                "fixed ACK retained for cleanup only after owner/turn retirement".into()
            });
        }
        state.fixed_preparation = FixedPreparation::Retained(Box::new(FixedResource {
            current_ui: attempt.ui.clone(),
            pending_ui: None,
            attempt,
            receipt: Some(prepared.receipt.clone()),
            acknowledged: Some(prepared),
            last_ui: None,
            clear_attempt: None,
            phase: if uncertainty.is_some() {
                FixedPhase::Unknown
            } else {
                FixedPhase::Ready
            },
            uncertainty,
        }));
        Ok(())
    }
    pub(super) fn apply_fixed_unknown(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        operation: &ExtensionOperation,
        context: Option<&ExtensionHostOperation>,
        receipt: Option<ExtensionFixedSessionReceipt>,
        reason: &str,
    ) -> Result<(), ToolError> {
        if matches!(operation, ExtensionOperation::PrepareFixedSessionTab { .. }) {
            let (identity, attempt) =
                self.fixed_attempt_for(owner, provider, operation, context)?;
            if let Some(receipt) = &receipt {
                self.validate_fixed_receipt(owner, provider, operation, &attempt, receipt)?;
            }
            let state = self.fixed_state_mut(owner, &identity)?;
            let prior = match &state.fixed_preparation {
                FixedPreparation::Retained(resource) => Some(resource.clone()),
                _ => None,
            };
            state.fixed_preparation = FixedPreparation::Retained(Box::new(FixedResource {
                current_ui: prior.as_ref().map_or_else(
                    || attempt.ui.clone(),
                    |resource| resource.current_ui.clone(),
                ),
                pending_ui: prior
                    .as_ref()
                    .and_then(|resource| resource.pending_ui.clone()),
                attempt,
                receipt: receipt
                    .or_else(|| prior.as_ref().and_then(|resource| resource.receipt.clone())),
                acknowledged: prior
                    .as_ref()
                    .and_then(|resource| resource.acknowledged.clone()),
                clear_attempt: prior
                    .as_ref()
                    .and_then(|resource| resource.clear_attempt.clone()),
                last_ui: prior.and_then(|resource| resource.last_ui),
                phase: FixedPhase::Unknown,
                uncertainty: Some(reason.to_owned()),
            }));
            return Ok(());
        }
        let old = match operation {
            ExtensionOperation::SessionUi { receipt, .. }
            | ExtensionOperation::ClearSessionPreparation { receipt } => receipt,
            _ => return Err(unknown("unknown fixed result has another issued operation")),
        };
        let identity = self.fixed_identity(owner, provider, old.tab_id())?;
        let state = self.fixed_state_mut(owner, &identity)?;
        let FixedPreparation::Retained(resource) = &mut state.fixed_preparation else {
            return Err(unknown("unknown fixed result lost its actual resource"));
        };
        if !resource
            .receipt
            .as_ref()
            .is_some_and(|receipt| same_receipt(receipt, old))
        {
            return Err(unknown("unknown fixed result changed its actual scope"));
        }
        if matches!(
            operation,
            ExtensionOperation::ClearSessionPreparation { .. }
        ) && let Some(context) = context
        {
            if resource.clear_attempt.as_ref().is_some_and(|issued| {
                issued
                    .operation
                    .as_ref()
                    .is_some_and(|operation| operation != context)
            }) {
                return Err(unknown("fixed unknown Clear changed its issued operation"));
            }
            if let Some(clear) = &mut resource.clear_attempt {
                clear.operation = Some(context.clone());
            } else {
                resource.clear_attempt = Some(FixedClearAttempt {
                    operation: Some(context.clone()),
                    dispatch: Arc::new(AtomicU8::new(UI_MAY_DISPATCH)),
                });
            }
        }
        if matches!(operation, ExtensionOperation::SessionUi { ui, .. }
            if matches!(ui.operation(), ExtensionFixedUiOperation::FinalizeDeliverable | ExtensionFixedUiOperation::FinalizeHandoff))
        {
            // Clear's actual acknowledgement must still drain this issued scope.
            // The failed presentation does not turn a known page action into Unknown.
            return Ok(());
        }
        resource
            .uncertainty
            .get_or_insert_with(|| reason.to_owned());
        resource.phase = FixedPhase::Unknown;
        Ok(())
    }
    pub(super) fn apply_fixed_ui(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        operation: &ExtensionOperation,
        context: Option<&ExtensionHostOperation>,
        proof: ExtensionFixedUiProof,
    ) -> Result<(), ToolError> {
        let ExtensionOperation::SessionUi { receipt, ui } = operation else {
            return Err(unknown("fixed UI proof has another issued operation"));
        };
        let identity = self.fixed_identity(owner, provider, receipt.tab_id())?;
        let context =
            context.ok_or_else(|| unknown("fixed UI proof lost its actual Host operation"))?;
        let call = self
            .extension
            .get(&(owner, identity.browser.clone()))
            .and_then(|state| state.calls.get(&context.operation_id))
            .ok_or_else(|| unknown("fixed UI proof lost its CallContext"))?;
        if call.turn != context.turn_id
            || ui.owner_epoch() != call.epoch.to_string()
            || ui.cursor_id() != receipt.ui_identity().cursor_id()
        {
            return Err(unknown(
                "fixed UI proof changed its actual epoch/cursor/context",
            ));
        }
        let epoch = call.epoch;
        let state = self.fixed_state_mut(owner, &identity)?;
        let FixedPreparation::Retained(resource) = &mut state.fixed_preparation else {
            return Err(unknown("fixed UI proof lost its actual resource"));
        };
        if !resource
            .receipt
            .as_ref()
            .is_some_and(|old| same_receipt(old, receipt))
        {
            return Err(unknown("fixed UI proof changed its actual logical scope"));
        }
        let same_pending = resource.matches_ui_ack(
            context,
            epoch,
            ui.operation(),
            ui.cursor_id(),
            ui.owner_epoch(),
        );
        if matches!(proof.ui, ExtensionFixedUiAck::Unknown)
            && !matches!(
                ui.operation(),
                ExtensionFixedUiOperation::FinalizeDeliverable
                    | ExtensionFixedUiOperation::FinalizeHandoff
            )
        {
            resource
                .uncertainty
                .get_or_insert_with(|| "actual fixed UI outcome remains unknown".into());
            resource.phase = FixedPhase::Unknown;
        }
        if same_pending
            && resource
                .last_ui
                .as_ref()
                .is_none_or(|last| last.epoch <= epoch)
        {
            let dispatch = resource
                .pending_ui
                .as_ref()
                .ok_or_else(|| unknown("fixed UI ACK lost its actual pending attempt"))?
                .dispatch
                .clone();
            if !matches!(proof.ui, ExtensionFixedUiAck::Unknown) {
                resource.pending_ui = None;
            }
            resource.last_ui = Some(FixedUiRecord {
                operation: context.clone(),
                epoch,
                completion_id: proof.completion_id(),
                dispatch,
            });
            state.presentation_error = match proof.ui {
                ExtensionFixedUiAck::Attempted {
                    acknowledged: true,
                    state: Some(_),
                    ..
                } => None,
                ExtensionFixedUiAck::NotAttempted => Some("fixed UI was not attempted".into()),
                ExtensionFixedUiAck::Unknown => Some("fixed UI outcome remains unknown".into()),
                ExtensionFixedUiAck::Attempted { .. } => {
                    Some("fixed UI was not acknowledged".into())
                }
            };
        }
        Ok(())
    }
    pub(super) fn apply_fixed_clear(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        operation: &ExtensionOperation,
        context: Option<&ExtensionHostOperation>,
        proof: ExtensionFixedSessionCleanupProof,
    ) -> Result<(), ToolError> {
        let ExtensionOperation::ClearSessionPreparation { receipt } = operation else {
            return Err(unknown("fixed clear proof has another issued operation"));
        };
        let identity = self.fixed_identity(owner, provider, receipt.tab_id())?;
        let context =
            context.ok_or_else(|| unknown("fixed clear lost its actual cleanup operation"))?;
        if !self
            .extension
            .get(&(owner, identity.browser.clone()))
            .is_some_and(|state| state.calls.contains_key(&context.operation_id))
        {
            return Err(unknown("fixed clear lost its issued cleanup CallContext"));
        }
        let state = self.fixed_state_mut(owner, &identity)?;
        let FixedPreparation::Retained(resource) = &mut state.fixed_preparation else {
            return Err(unknown("fixed clear lost retained custody"));
        };
        if !resource
            .receipt
            .as_ref()
            .is_some_and(|old| same_receipt(old, receipt))
            || proof.scope_id() != receipt.scope_id()
            || proof.tab_id() != receipt.tab_id()
        {
            return Err(unknown("fixed clear proof changed its actual scope"));
        }
        if resource.clear_attempt.as_ref().is_some_and(|issued| {
            issued
                .operation
                .as_ref()
                .is_some_and(|operation| operation != context)
        }) {
            return Err(unknown(
                "fixed clear ACK changed its reserved cleanup operation",
            ));
        }
        if resource.clear_attempt.is_none() && !matches!(resource.phase, FixedPhase::Clearing) {
            return Err(unknown("fixed clear ACK has no actual pending cleanup"));
        }
        if let Some(clear) = &mut resource.clear_attempt {
            clear.operation = Some(context.clone());
        } else {
            resource.clear_attempt = Some(FixedClearAttempt {
                operation: Some(context.clone()),
                dispatch: Arc::new(AtomicU8::new(UI_MAY_DISPATCH)),
            });
        }
        resource.phase = FixedPhase::Cleared { proof };
        // This actual matching Clear ACK drains the issued logical scope, including
        // later UI within it. The caller may already have dropped its observer.
        if self
            .cursor_scopes
            .get(&(owner, identity.clone()))
            .is_some_and(|endpoint| endpoint.fixed_scope_id() == Some(receipt.scope_id()))
        {
            self.cursor_scopes.remove(&(owner, identity));
        }
        Ok(())
    }
}

impl Host {
    fn current_fixed(
        &self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        receipt: &ExtensionFixedSessionReceipt,
    ) -> Result<ExtensionFixedSessionPreparedTab, ToolError> {
        self.known(&identity.browser)?;
        let state = self.fixed_state(owner, identity)?;
        let lease = &self.tabs[identity];
        if !matches!(lease.disposition, Disposition::Live)
            || state.closed
            || state.unknown.is_some()
            || state.cdp_effect_unknown.is_some()
        {
            return Err(ToolError::CleanupUnconfirmed(
                "fixed resource is not live/current".into(),
            ));
        }
        let prepared = state.fixed_preparation.ready().ok_or_else(|| {
            ToolError::CleanupUnconfirmed(
                "fixed resource remains pending, unknown or cleared".into(),
            )
        })?;
        if receipt.is_cleanup_only() || !same_receipt(&prepared.receipt, receipt) {
            return Err(unknown("fixed UI differs from its actual retained receipt"));
        }
        Ok(prepared.clone())
    }
    fn begin_fixed_clear(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        receipt: &ExtensionFixedSessionReceipt,
        context: Option<&ExtensionHostOperation>,
    ) -> Result<bool, ToolError> {
        self.fixed_state_mut(owner, identity)?
            .fixed_preparation
            .retire_unpolled_ui();
        let state = self.fixed_state_mut(owner, identity)?;
        let FixedPreparation::Retained(resource) = &mut state.fixed_preparation else {
            return Err(ToolError::CleanupUnconfirmed(
                "fixed cleanup lost its retained resource".into(),
            ));
        };
        if !resource
            .receipt
            .as_ref()
            .is_some_and(|old| same_receipt(old, receipt))
        {
            return Err(unknown("fixed cleanup changed its actual scope"));
        }
        if matches!(resource.phase, FixedPhase::Clearing | FixedPhase::Unknown)
            && let Some(clear) = &resource.clear_attempt
        {
            let _ = clear.dispatch.compare_exchange(
                UI_RESERVED,
                UI_RETIRED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            if clear.dispatch.load(Ordering::SeqCst) == UI_RETIRED {
                // The original clear future owns this exact cell and can no
                // longer enter the SDK. Independent earlier uncertainty stays.
                resource.clear_attempt = None;
                resource.phase = if resource.uncertainty.is_some() {
                    FixedPhase::Unknown
                } else {
                    FixedPhase::Ready
                };
            }
        }
        match &resource.phase {
            FixedPhase::Cleared { proof }
                if proof.scope_id() == receipt.scope_id() && proof.tab_id() == receipt.tab_id() =>
            {
                return Ok(false);
            }
            FixedPhase::Clearing => {
                return Err(ToolError::CleanupUnconfirmed(
                    "fixed cleanup remains pending; not replayed".into(),
                ));
            }
            FixedPhase::Unknown if resource.clear_attempt.is_some() => {
                return Err(ToolError::CleanupUnconfirmed(
                    "fixed cleanup outcome remains unknown; not replayed".into(),
                ));
            }
            _ => {}
        }
        resource.clear_attempt = Some(FixedClearAttempt {
            operation: context.cloned(),
            dispatch: Arc::new(AtomicU8::new(UI_RESERVED)),
        });
        resource.phase = FixedPhase::Clearing;
        Ok(true)
    }
    pub(super) fn apply_fixed_not_dispatched(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        operation: &ExtensionOperation,
        context: Option<&ExtensionHostOperation>,
    ) -> Result<(), ToolError> {
        if matches!(operation, ExtensionOperation::PrepareFixedSessionTab { .. }) {
            let (identity, expected) =
                self.fixed_attempt_for(owner, provider, operation, context)?;
            let state = self.fixed_state_mut(owner, &identity)?;
            if let FixedPreparation::Pending(attempt) = &state.fixed_preparation
                && Arc::ptr_eq(&attempt.dispatch, &expected.dispatch)
                && attempt.dispatch.load(Ordering::SeqCst) == UI_MAY_DISPATCH
            {
                attempt.dispatch.store(UI_RETIRED, Ordering::SeqCst);
                state.fixed_preparation = FixedPreparation::NotAttempted;
            }
            return Ok(());
        }
        let (receipt, ui) = match operation {
            ExtensionOperation::SessionUi { receipt, ui } => (receipt, Some(ui)),
            ExtensionOperation::ClearSessionPreparation { receipt } => (receipt, None),
            _ => {
                return Err(unknown(
                    "no-dispatch fixed result has another issued operation",
                ));
            }
        };
        let identity = self.fixed_identity(owner, provider, receipt.tab_id())?;
        let context =
            context.ok_or_else(|| unknown("fixed no-dispatch lost its actual Host operation"))?;
        let call = self
            .extension
            .get(&(owner, identity.browser.clone()))
            .and_then(|state| state.calls.get(&context.operation_id))
            .ok_or_else(|| unknown("fixed no-dispatch lost its actual CallContext"))?;
        if call.turn != context.turn_id {
            return Err(unknown("fixed no-dispatch changed its issued turn"));
        }
        let epoch = call.epoch;
        let state = self.fixed_state_mut(owner, &identity)?;
        let FixedPreparation::Retained(resource) = &mut state.fixed_preparation else {
            return Ok(());
        };
        if !resource
            .receipt
            .as_ref()
            .is_some_and(|old| same_receipt(old, receipt))
        {
            return Err(unknown("fixed no-dispatch changed its actual SDK scope"));
        }
        if let Some(ui) = ui {
            if ui.owner_epoch() != epoch.to_string()
                || ui.cursor_id() != receipt.ui_identity().cursor_id()
            {
                return Err(unknown(
                    "fixed no-dispatch UI changed its actual epoch/cursor",
                ));
            }
            if resource.matches_ui_ack(
                context,
                epoch,
                ui.operation(),
                ui.cursor_id(),
                ui.owner_epoch(),
            ) && let Some(pending) = &resource.pending_ui
                && pending.dispatch.load(Ordering::SeqCst) == UI_MAY_DISPATCH
            {
                pending.dispatch.store(UI_RETIRED, Ordering::SeqCst);
                resource.pending_ui = None;
            }
        } else if let Some(clear) = &resource.clear_attempt
            && clear
                .operation
                .as_ref()
                .is_none_or(|issued| issued == context)
            && clear.dispatch.load(Ordering::SeqCst) == UI_MAY_DISPATCH
        {
            clear.dispatch.store(UI_RETIRED, Ordering::SeqCst);
            resource.clear_attempt = None;
            resource.phase = if resource.uncertainty.is_some() {
                FixedPhase::Unknown
            } else {
                FixedPhase::Ready
            };
        }
        Ok(())
    }
    fn finish_fixed_clear_error(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        expected: &FixedClearAttempt,
        not_dispatched: bool,
        reason: &str,
    ) {
        let Ok(state) = self.fixed_state_mut(owner, identity) else {
            return;
        };
        let FixedPreparation::Retained(resource) = &mut state.fixed_preparation else {
            return;
        };
        if !resource
            .clear_attempt
            .as_ref()
            .is_some_and(|clear| Arc::ptr_eq(&clear.dispatch, &expected.dispatch))
            || matches!(resource.phase, FixedPhase::Cleared { .. })
        {
            return;
        }
        if not_dispatched {
            expected.dispatch.store(UI_RETIRED, Ordering::SeqCst);
            resource.clear_attempt = None;
            resource.phase = if resource.uncertainty.is_some() {
                FixedPhase::Unknown
            } else {
                FixedPhase::Ready
            };
        } else {
            resource
                .uncertainty
                .get_or_insert_with(|| reason.to_owned());
            resource.phase = FixedPhase::Unknown;
        }
    }
    fn fixed_undispatched_error(
        &mut self,
        scope: &CallScope,
        identity: &TabIdentity,
        expected: &FixedAttempt,
        error: &cua_driver_core::browser::ExtensionProviderError,
    ) -> bool {
        if scope
            .control
            .undispatched_control(error)
            .is_none_or(|proof| proof.method() != "prepareSessionTab")
        {
            return false;
        }
        let Ok(state) = self.fixed_state_mut(scope.owner, identity) else {
            return false;
        };
        if !state.fixed_preparation.matches_attempt(expected) {
            return false;
        }
        // Only this exact still-prospective attempt is discharged. A retained
        // receipt or an earlier Unknown keeps its independent cleanup custody.
        let FixedPreparation::Pending(attempt) = &state.fixed_preparation else {
            return false;
        };
        attempt.dispatch.store(UI_RETIRED, Ordering::SeqCst);
        state.fixed_preparation = FixedPreparation::NotAttempted;
        true
    }
    fn fixed_caller_error(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        expected: &FixedAttempt,
        error: &str,
    ) {
        let Ok(state) = self.fixed_state_mut(owner, identity) else {
            return;
        };
        if !state.fixed_preparation.matches_attempt(expected) {
            return;
        }
        match &mut state.fixed_preparation {
            // A caller-side error after actual reconcile cannot overwrite ACK.
            FixedPreparation::Retained(resource)
                if matches!(
                    resource.phase,
                    FixedPhase::Ready | FixedPhase::Cleared { .. }
                ) => {}
            FixedPreparation::Retained(resource) => {
                resource.uncertainty.get_or_insert_with(|| error.into());
                resource.phase = FixedPhase::Unknown;
            }
            FixedPreparation::Pending(attempt)
                if {
                    // This handler runs only after the same dispatch future ended.
                    // Reserved therefore proves the SDK inner firstpoll was never
                    // crossed. Retire by exact cell CAS, not error kind/message.
                    let _ = attempt.dispatch.compare_exchange(
                        UI_RESERVED,
                        UI_RETIRED,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    );
                    attempt.dispatch.load(Ordering::SeqCst) == UI_RETIRED
                } =>
            {
                // The exact original future lost our local firstpoll CAS before
                // SDK polling. No generic Refused/message or earlier Unknown is
                // used as no-dispatch evidence; begin admitted no prior Unknown.
                state.fixed_preparation = FixedPreparation::NotAttempted;
            }
            FixedPreparation::Pending(attempt) => {
                state.fixed_preparation = FixedPreparation::Retained(Box::new(FixedResource {
                    current_ui: attempt.ui.clone(),
                    pending_ui: None,
                    attempt: attempt.clone(),
                    receipt: None,
                    acknowledged: None,
                    last_ui: None,
                    clear_attempt: None,
                    phase: FixedPhase::Unknown,
                    uncertainty: Some(error.into()),
                }));
            }
            FixedPreparation::NotAttempted => {}
        }
    }
}

async fn retain_prepare_error(
    scope: &CallScope,
    host: &Arc<tokio::sync::Mutex<Host>>,
    identity: &TabIdentity,
    expected: &FixedAttempt,
    error: &str,
) {
    {
        let ledger = host.lock().await;
        let Ok(state) = ledger.fixed_state(scope.owner, identity) else {
            return;
        };
        if !state.fixed_preparation.matches_attempt(expected)
            || state.fixed_preparation.ready().is_some()
        {
            return;
        }
    }
    // Recovery reads only the SDK's already issued operation ledger. It never
    // asks the extension to prepare again or invents a guessed cleanup address.
    if let Ok(pending) = scope.control.pending_operations().await {
        for entry in pending.into_iter().filter(|entry| {
            entry.host_operation.as_ref() == Some(&scope.context)
                && matches!(&entry.operation, ExtensionOperation::PrepareFixedSessionTab { tab_id, .. }
                    if tab_id.to_string() == identity.target)
        }) {
            if let Ok(receipt) = scope.control.recover_fixed_session_cleanup(entry.id).await {
                let mut ledger = host.lock().await;
                let Ok(state) = ledger.fixed_state(scope.owner, identity) else {
                    return;
                };
                // The async SDK observation may have raced local retirement and
                // replacement, including the same operation/epoch/arguments.
                if !state.fixed_preparation.matches_attempt(expected)
                    || state.fixed_preparation.ready().is_some()
                {
                    return;
                }
                let _ = ledger.apply_fixed_unknown(
                    scope.owner,
                    &scope.provider,
                    &entry.operation,
                    entry.host_operation.as_ref(),
                    Some(receipt),
                    error,
                );
            }
        }
    }
    host.lock()
        .await
        .fixed_caller_error(scope.owner, identity, expected, error);
}

async fn clear_for_replacement(
    scope: &CallScope,
    host: &Arc<tokio::sync::Mutex<Host>>,
    invocation: &crate::InvocationContext<'_>,
    cancellation: &CancellationToken,
    request: &crate::BrowserSessionPreparation,
    receipt: &ExtensionFixedSessionReceipt,
) -> Result<(), ToolError> {
    scope
        .check_preparation(host, invocation, request, cancellation)
        .await?;
    let identity = BrowserIdentity::of(&scope.provider, receipt.generation())?
        .tab(&receipt.tab_id().to_string());
    let expected = {
        let mut ledger = host.lock().await;
        check_input(cancellation)?;
        ledger.extension_preparation_current(scope, request)?;
        if !ledger.begin_fixed_clear(scope.owner, &identity, receipt, Some(&scope.context))? {
            return Ok(());
        }
        match &ledger
            .fixed_state(scope.owner, &identity)?
            .fixed_preparation
        {
            FixedPreparation::Retained(resource) => resource
                .clear_attempt
                .clone()
                .ok_or_else(|| unknown("fixed clear lost its actual attempt"))?,
            _ => return Err(unknown("fixed clear lost its actual resource")),
        }
    };
    let result = scope
        .dispatch(async {
            enter_fixed_ui(&expected.dispatch).map_err(|error| *error)?;
            scope.control.clear_session_preparation(receipt).await
        })
        .await;
    let reconciled = host
        .lock()
        .await
        .reconcile_provider(scope.owner, &scope.provider)
        .await;
    if let Err(error) = &result {
        host.lock().await.finish_fixed_clear_error(
            scope.owner,
            &identity,
            &expected,
            reconciled.is_ok()
                && (expected.dispatch.load(Ordering::SeqCst) != UI_MAY_DISPATCH
                    || scope.control.undispatched_control(error).is_some()),
            &error.to_string(),
        );
    }
    reconciled?;
    result.map_err(provider::extension_error)?;
    if !host
        .lock()
        .await
        .fixed_state(scope.owner, &identity)?
        .fixed_preparation
        .cleanup_confirmed()
    {
        return Err(ToolError::CleanupUnconfirmed(
            "fixed replacement lacks actual clear proof".into(),
        ));
    }
    scope
        .check_preparation(host, invocation, request, cancellation)
        .await
}

pub(super) async fn prepare_fixed_tab(
    scope: &CallScope,
    host: &Arc<tokio::sync::Mutex<Host>>,
    invocation: &crate::InvocationContext<'_>,
    cancellation: &CancellationToken,
    tab_id: u64,
    cursor: &Spec,
) -> Result<ExtensionFixedSessionPreparedTab, ToolError> {
    if scope
        .control
        .capabilities()
        .map_err(provider::extension_error)?
        .session_preparation
        != ExtensionSessionPreparation::ExplicitFixed
    {
        return Err(failed(
            "selected provider has no explicit fixed session service",
        ));
    }
    let identity = BrowserIdentity::of(&scope.provider, &scope.control.identity().generation)?
        .tab(&tab_id.to_string());
    let request = scope
        .authorize_preparation(
            host,
            invocation,
            crate::BrowserPreparationTarget::ReservedTab {
                tab_id: tab_id.to_string(),
            },
            cancellation,
        )
        .await?;
    let headers = preparation_headers(invocation);
    let policy = ExtensionPreparationPolicy {
        popup_enabled: invocation.browser_preparation_policy().effective_popup(),
        header_enabled: !headers.is_empty(),
        headers,
    };
    let ui = ui_request(
        cursor,
        scope.epoch,
        None,
        "idle",
        ExtensionFixedUiOperation::Control,
    )?;
    let prior = {
        let ledger = host.lock().await;
        ledger.extension_preparation_current(scope, &request)?;
        ledger
            .fixed_state(scope.owner, &identity)?
            .fixed_preparation
            .clone()
    };
    if let Some(prepared) = prior.ready() {
        let compatible = matches!(&prior, FixedPreparation::Retained(resource)
            if resource.attempt.policy == policy && resource.current_ui.cursor == ui.cursor
                && resource.current_ui.owner_epoch == ui.owner_epoch)
            && prepared.receipt.wire_context().host_session_id() == scope.owner.to_string()
            && prepared.receipt.wire_context().host_turn_id() == scope.context.turn_id;
        if compatible {
            scope
                .check_preparation(host, invocation, &request, cancellation)
                .await?;
            // Return the original ACK and its original operation/sequence.
            return Ok(prepared.clone());
        }
        clear_for_replacement(
            scope,
            host,
            invocation,
            cancellation,
            &request,
            &prepared.receipt,
        )
        .await?;
    } else if !prior.settled() {
        return Err(ToolError::CleanupUnconfirmed(
            "fixed preparation is pending/unknown; not replayed".into(),
        ));
    }
    scope
        .check_preparation(host, invocation, &request, cancellation)
        .await?;
    let expected = {
        let mut ledger = host.lock().await;
        check_input(cancellation)?;
        ledger.extension_preparation_current(scope, &request)?;
        ledger.begin_fixed_preparation(scope, &identity, policy.clone(), ui.clone())?;
        ledger
            .fixed_state(scope.owner, &identity)?
            .fixed_preparation
            .attempt()
            .ok_or_else(|| unknown("fixed prepare lost pending attempt"))?
            .clone()
    };
    let dispatch = expected.dispatch.clone();
    let handoff_boundary = host
        .lock()
        .await
        .handoff_preparation_boundary(scope, &identity);
    let result = scope
        .dispatch(async {
            enter_handoff_preparation(handoff_boundary.as_ref())?;
            enter_fixed_ui(&dispatch)?;
            scope
                .control
                .prepare_fixed_session_tab(tab_id, &policy, &ui)
                .await
                .map_err(Box::new)
        })
        .await;
    let reconciled = host
        .lock()
        .await
        .reconcile_provider(scope.owner, &scope.provider)
        .await;
    if let Err(error) = &result {
        let not_dispatched = reconciled.is_ok()
            && host
                .lock()
                .await
                .fixed_undispatched_error(scope, &identity, &expected, error);
        if not_dispatched {
            host.lock()
                .await
                .rollback_handoff_transfer(&identity, scope.owner, &scope.context);
        } else {
            retain_prepare_error(scope, host, &identity, &expected, &error.to_string()).await;
        }
    } else if let Err(error) = &reconciled {
        retain_prepare_error(scope, host, &identity, &expected, &error.to_string()).await;
    }
    reconciled?;
    let prepared = result.map_err(provider::extension_error)?;
    {
        let ledger = host.lock().await;
        let actual = ledger.current_fixed(scope.owner, &identity, &prepared.receipt)?;
        if actual.completion_id() != prepared.completion_id() {
            return Err(unknown(
                "fixed preparation result differs from folded actual ACK",
            ));
        }
    }
    scope
        .check_preparation(host, invocation, &request, cancellation)
        .await?;
    Ok(prepared)
}

impl Host {
    fn fixed_ui_tail_current(
        &self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        completion: &FixedUiCompletion<'_>,
    ) -> Result<(), ToolError> {
        let scope = completion.scope;
        let provider = self
            .extension
            .get(&(owner, identity.browser.clone()))
            .ok_or_else(|| unknown("fixed UI tail lost its actual provider"))?;
        let call = provider
            .calls
            .get(&scope.context.operation_id)
            .ok_or_else(|| unknown("fixed UI tail lost its actual call"))?;
        if scope.owner != owner
            || scope.target.as_deref() != Some(identity.target.as_str())
            || provider.provider != scope.provider
            || provider.retiring_turn.is_some()
            || provider.headers_unknown
            || (scope.purpose != CallPurpose::FixedConfiguration
                && provider.current_turn.as_deref() != Some(scope.context.turn_id.as_str()))
            || call.turn != scope.context.turn_id
            || call.epoch != scope.epoch
            || !call.purposes.contains(&scope.purpose)
            || !Arc::ptr_eq(&call.controls, &scope.controls)
            || !Arc::ptr_eq(&call.issuing, &scope.issuing)
            || !Arc::ptr_eq(&call.activation, &scope.activation)
            || call.controls.is_sealed()
        {
            return Err(ToolError::CleanupUnconfirmed(
                "fixed UI tail is no longer current".into(),
            ));
        }
        let state = self.fixed_state(owner, identity)?;
        let prepared = state
            .fixed_preparation
            .ready()
            .ok_or_else(|| unknown("fixed UI tail lost its ready actual receipt"))?;
        self.current_fixed(owner, identity, &prepared.receipt)?;
        let FixedPreparation::Retained(resource) = &state.fixed_preparation else {
            return Err(unknown("fixed UI tail lost its actual resource"));
        };
        if !resource.last_ui.as_ref().is_some_and(|last| {
            last.operation == scope.context
                && last.epoch == scope.epoch
                && last.completion_id == completion.proof.completion_id()
                && Arc::ptr_eq(&last.dispatch, completion.dispatch)
        }) || resource
            .pending_ui
            .as_ref()
            .is_some_and(|pending| !Arc::ptr_eq(&pending.dispatch, completion.dispatch))
            || completion.dispatch.load(Ordering::SeqCst) != UI_MAY_DISPATCH
            || completion.request.owner_epoch != scope.epoch.to_string()
            || self
                .cursor_scopes
                .get(&(owner, identity.clone()))
                .is_some_and(|endpoint| {
                    endpoint.epoch() > scope.epoch
                        || endpoint.fixed_scope_id() != Some(prepared.receipt.scope_id())
                })
        {
            return Err(unknown(
                "fixed UI tail differs from its latest actual ACK/attempt",
            ));
        }
        Ok(())
    }
    fn record_fixed_ui_request(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        scope: &CallScope,
        request: &ExtensionFixedUiRequest,
        proof: &ExtensionFixedUiProof,
        dispatch: &Arc<AtomicU8>,
    ) -> Result<(), ToolError> {
        self.fixed_ui_tail_current(
            owner,
            identity,
            &FixedUiCompletion {
                scope,
                request,
                proof,
                dispatch,
            },
        )?;
        let state = self.fixed_state_mut(owner, identity)?;
        let FixedPreparation::Retained(resource) = &mut state.fixed_preparation else {
            return Err(unknown("fixed UI request lost its actual resource"));
        };
        resource.current_ui = request.clone();
        Ok(())
    }
    fn commit_fixed_configuration(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        cursor: &Spec,
        invocation: &crate::InvocationContext<'_>,
        admission: &crate::BrowserSessionPreparation,
        completion: &FixedUiCompletion<'_>,
    ) -> Result<(), ToolError> {
        let scope = completion.scope;
        if scope.purpose != CallPurpose::FixedConfiguration
            || completion.request.operation != ExtensionFixedUiOperation::Configure
            || scope.context != operation(invocation)?
        {
            return Err(failed(
                "fixed configuration commit changed its admitted call",
            ));
        }
        self.extension_preparation_current(scope, admission)?;
        self.fixed_ui_tail_current(owner, identity, completion)?;
        let state = self.fixed_state(owner, identity)?;
        let FixedPreparation::Retained(resource) = &state.fixed_preparation else {
            return Err(unknown("fixed configuration lost its actual resource"));
        };
        let prepared = resource
            .acknowledged
            .as_ref()
            .ok_or_else(|| unknown("fixed configuration has no actual preparation ACK"))?;
        let headers = preparation_headers(invocation);
        let policy = ExtensionPreparationPolicy {
            popup_enabled: invocation.browser_preparation_policy().effective_popup(),
            header_enabled: !headers.is_empty(),
            headers,
        };
        let same_turn = prepared.receipt.wire_context().host_turn_id() == scope.context.turn_id
            && self
                .extension
                .get(&(owner, identity.browser.clone()))
                .is_some_and(|provider| {
                    provider.current_turn.as_deref() == Some(scope.context.turn_id.as_str())
                });
        let renew = matches!(
            completion.proof.ui,
            ExtensionFixedUiAck::Attempted {
                acknowledged: true,
                ..
            }
        ) && same_turn
            && resource.attempt.policy == policy
            && policy.popup_enabled;
        let replacement = if renew {
            let original = state.lease_children.as_ref().ok_or_else(|| {
                failed("fixed popup route renewal has no original service; prepare explicitly")
            })?;
            if original.turn != scope.context.turn_id
                || original.turn != prepared.receipt.wire_context().host_turn_id()
                || !original.effects.supports_lease_children()
            {
                return Err(failed(
                    "fixed popup route renewal lost its original compatible service; prepare explicitly",
                ));
            }
            // The original epoch may be older: this renews the same issued
            // service into the current VM, without minting one from a UI ACK.
            // Obtain THIS invocation's factory after its real Global admission.
            // The old retained factory is never cloned into the new VM route.
            let effects = invocation.browser_host_effects()
                .filter(|effects| effects.supports_lease_children())
                .ok_or_else(|| failed("fixed popup route renewal needs this current Host service binding; prepare explicitly"))?;
            Some(LeaseChildScope {
                effects,
                turn: scope.context.turn_id.clone(),
                epoch: scope.epoch,
            })
        } else {
            // Cross-turn or changed policy needs an explicit new preparation.
            // Diagnostic false/not-attempted ACKs leave the prior route intact.
            None
        };
        let endpoint = super::super::cursor::CursorEndpoint::fixed(
            scope.control.clone(),
            prepared.receipt.clone(),
            scope.provider.clone(),
            scope.epoch,
            cursor,
        )?;
        // Every fallible check/constructor precedes these same-lock mutations.
        let state = self.fixed_state_mut(owner, identity)?;
        let FixedPreparation::Retained(resource) = &mut state.fixed_preparation else {
            return Err(unknown("fixed configuration lost its actual resource"));
        };
        resource.current_ui = completion.request.clone();
        if let Some(replacement) = replacement {
            state.lease_children = Some(replacement);
        }
        self.record_cursor(owner, identity.clone(), endpoint);
        Ok(())
    }
    fn fixed_ui_scope(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        identity: &TabIdentity,
        receipt: &ExtensionFixedSessionReceipt,
        presentation: &FixedPresentationScope,
    ) -> Result<CallScope, ToolError> {
        self.current_fixed(owner, identity, receipt)?;
        if self
            .cursor_scopes
            .get(&(owner, identity.clone()))
            .is_some_and(|endpoint| endpoint.epoch() > presentation.epoch)
        {
            return Err(failed("fixed UI belongs to a replacement VM epoch"));
        }
        let scope = self.extension_context(
            owner,
            provider,
            presentation.operation.clone(),
            presentation.epoch,
            CallTarget::Tab {
                origin: Origin::UserClaimed,
                tab: Some(identity.target.clone()),
            },
            false,
        )?;
        self.extension_preparation_current(&scope, &presentation.request)?;
        Ok(scope)
    }
}

async fn checked_ui_scope(
    host: &Arc<tokio::sync::Mutex<Host>>,
    owner: uuid::Uuid,
    provider: &Provider,
    identity: &TabIdentity,
    receipt: &ExtensionFixedSessionReceipt,
    presentation: &FixedPresentationScope,
) -> Result<CallScope, ToolError> {
    check_input(&presentation.cancellation)?;
    {
        let mut ledger = host.lock().await;
        ledger.fixed_ui_scope(owner, provider, identity, receipt, presentation)?;
    }
    presentation
        .authorization
        .check_session_preparation(
            presentation.request.clone(),
            presentation.cancellation.clone(),
        )
        .await?;
    check_input(&presentation.cancellation)?;
    host.lock()
        .await
        .fixed_ui_scope(owner, provider, identity, receipt, presentation)
}

impl Tab {
    pub(in crate::browser) async fn extension_fixed_ui_presentation(
        &mut self,
        cursor: &Spec,
        point: Option<[f64; 2]>,
        action: &str,
        operation: &str,
    ) -> Result<Option<Value>, ToolError> {
        let Some(extension) = self.provider.extension() else {
            return Ok(None);
        };
        if extension
            .capabilities()
            .map_err(provider::extension_error)?
            .session_preparation
            != ExtensionSessionPreparation::ExplicitFixed
        {
            return Ok(None);
        }
        let presentation = self
            .fixed_presentation
            .clone()
            .ok_or_else(|| failed("fixed UI requires the current actual Host invocation"))?;
        let identity = self.identity()?;
        let receipt = self
            .cursor_host
            .lock()
            .await
            .fixed_state(self.cursor_owner, &identity)?
            .fixed_preparation
            .ready()
            .map(|prepared| prepared.receipt.clone())
            .ok_or_else(|| {
                ToolError::CleanupUnconfirmed("fixed UI has no acknowledged live session".into())
            })?;
        let operation = match operation {
            "state" => ExtensionFixedUiOperation::State,
            "update" => ExtensionFixedUiOperation::Update,
            "control" => ExtensionFixedUiOperation::Control,
            "controlStop" => ExtensionFixedUiOperation::ControlStop,
            "hide" => ExtensionFixedUiOperation::Hide,
            "remove" => ExtensionFixedUiOperation::Remove,
            "finalize" => ExtensionFixedUiOperation::Finalize,
            _ => return Err(failed("unsupported ordinary fixed UI operation")),
        };
        let ui = ui_request(cursor, presentation.epoch, point, action, operation)?;
        let host = self.cursor_host.clone();
        let scope = checked_ui_scope(
            &host,
            self.cursor_owner,
            &self.provider,
            &identity,
            &receipt,
            &presentation,
        )
        .await?;
        let dispatch =
            host.lock()
                .await
                .begin_fixed_ui(self.cursor_owner, &identity, &scope, &ui)?;
        let result = scope
            .dispatch(async {
                enter_fixed_ui(&dispatch).map_err(|error| *error)?;
                scope.control.session_ui(&receipt, &ui).await
            })
            .await;
        let reconciled = host
            .lock()
            .await
            .reconcile_provider(self.cursor_owner, &self.provider)
            .await;
        reconciled?;
        let proof = result.map_err(provider::extension_error)?;
        if matches!(proof.ui, ExtensionFixedUiAck::Unknown) {
            return Err(unknown("actual fixed UI outcome remains unknown"));
        }
        let rendered = render(&proof.ui)?;
        checked_ui_scope(
            &host,
            self.cursor_owner,
            &self.provider,
            &identity,
            &receipt,
            &presentation,
        )
        .await?;
        {
            let mut ledger = host.lock().await;
            let endpoint = super::super::cursor::CursorEndpoint::fixed(
                scope.control.clone(),
                receipt,
                self.provider.clone(),
                presentation.epoch,
                cursor,
            )?;
            ledger.record_fixed_ui_request(
                self.cursor_owner,
                &identity,
                &scope,
                &ui,
                &proof,
                &dispatch,
            )?;
            ledger.record_cursor(self.cursor_owner, identity, endpoint);
        }
        Ok(Some(json!(rendered)))
    }
}

pub(in crate::browser) async fn configure_fixed_session_ui(
    host: &Arc<tokio::sync::Mutex<Host>>,
    owner: uuid::Uuid,
    identity: &TabIdentity,
    receipt: &ExtensionFixedSessionReceipt,
    epoch: crate::desktop::NativeEpochId,
    cursor: &Spec,
    invocation: &crate::InvocationContext<'_>,
) -> Result<Option<RenderState>, ToolError> {
    let provider = {
        let ledger = host.lock().await;
        ledger.current_fixed(owner, identity, receipt)?;
        ledger.tabs[identity].creator.provider.clone()
    };
    if provider
        .extension()
        .ok_or_else(|| failed("extension provider required"))?
        .capabilities()
        .map_err(provider::extension_error)?
        .session_preparation
        != ExtensionSessionPreparation::ExplicitFixed
    {
        return Err(failed(
            "fixed UI configuration requires the explicit fixed service",
        ));
    }
    let cancellation = CancellationToken::new();
    let scope = host.lock().await.extension_context(
        owner,
        &provider,
        operation(invocation)?,
        epoch,
        CallTarget::FixedConfiguration {
            tab: identity.target.clone(),
        },
        false,
    )?;
    let request = scope
        .authorize_preparation(
            host,
            invocation,
            crate::BrowserPreparationTarget::FixedSessionTab {
                tab_id: identity.target.clone(),
                scope_id: receipt.scope_id().into(),
            },
            &cancellation,
        )
        .await?;
    let ui = ui_request(
        cursor,
        epoch,
        None,
        "idle",
        ExtensionFixedUiOperation::Configure,
    )?;
    scope
        .check_preparation(host, invocation, &request, &cancellation)
        .await?;
    host.lock().await.current_fixed(owner, identity, receipt)?;
    let dispatch = host
        .lock()
        .await
        .begin_fixed_ui(owner, identity, &scope, &ui)?;
    let result = scope
        .dispatch(async {
            enter_fixed_ui(&dispatch).map_err(|error| *error)?;
            scope.control.session_ui(receipt, &ui).await
        })
        .await;
    let reconciled = host.lock().await.reconcile_provider(owner, &provider).await;
    reconciled?;
    let proof = result.map_err(provider::extension_error)?;
    if matches!(proof.ui, ExtensionFixedUiAck::Unknown) {
        return Err(unknown(
            "actual fixed UI configuration outcome remains unknown",
        ));
    }
    let rendered = render(&proof.ui)?;
    scope
        .check_preparation(host, invocation, &request, &cancellation)
        .await?;
    {
        let mut ledger = host.lock().await;
        ledger.current_fixed(owner, identity, receipt)?;
        ledger.commit_fixed_configuration(
            owner,
            identity,
            cursor,
            invocation,
            &request,
            &FixedUiCompletion {
                scope: &scope,
                request: &ui,
                proof: &proof,
                dispatch: &dispatch,
            },
        )?;
    }
    Ok(Some(rendered))
}

fn enter_fixed_ui(
    dispatch: &AtomicU8,
) -> Result<(), Box<cua_driver_core::browser::ExtensionProviderError>> {
    dispatch
        .compare_exchange(
            UI_RESERVED,
            UI_MAY_DISPATCH,
            Ordering::SeqCst,
            Ordering::SeqCst,
        )
        .map(|_| ())
        .map_err(|_| {
            Box::new(cua_driver_core::browser::ExtensionProviderError::Refused {
                kind: "retired_fixed_ui".into(),
                message: "fixed UI retired before SDK first poll".into(),
                details: None,
            })
        })
}

#[derive(Clone)]
pub(in crate::browser) enum FixedCleanupPurpose {
    Epoch {
        through: crate::desktop::NativeEpochId,
    },
    Turn {
        turn: String,
    },
    Owner,
}

impl FixedPreparation {
    pub(in crate::browser) fn protected_from_turn(&self, turn: &str) -> bool {
        match self {
            Self::Pending(attempt) => {
                attempt.dispatch.load(Ordering::SeqCst) == UI_MAY_DISPATCH
                    && attempt.operation.turn_id != turn
            }
            Self::Retained(resource) if !matches!(resource.phase, FixedPhase::Cleared { .. }) => {
                resource.latest_ui_owner().0.turn_id != turn
            }
            _ => false,
        }
    }
    pub(in crate::browser) fn protected_from_epoch(
        &self,
        through: crate::desktop::NativeEpochId,
    ) -> bool {
        match self {
            Self::Pending(attempt) => {
                attempt.dispatch.load(Ordering::SeqCst) == UI_MAY_DISPATCH
                    && attempt.epoch > through
            }
            Self::Retained(resource) if !matches!(resource.phase, FixedPhase::Cleared { .. }) => {
                resource.latest_ui_owner().1 > through
            }
            _ => false,
        }
    }
    fn retire_unpolled_ui(&mut self) {
        if let Self::Pending(attempt) = self {
            let _ = attempt.dispatch.compare_exchange(
                UI_RESERVED,
                UI_RETIRED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            if attempt.dispatch.load(Ordering::SeqCst) == UI_RETIRED {
                // The exact captured SDK future can no longer cross its firstpoll
                // fence. No receipt exists, and retained Unknown is a separate arm.
                *self = Self::NotAttempted;
            }
            return;
        }
        if let Some(attempt) = self.attempt() {
            let _ = attempt.dispatch.compare_exchange(
                UI_RESERVED,
                UI_RETIRED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
        }
        if let Self::Retained(resource) = self
            && let Some(ui) = &resource.pending_ui
        {
            let _ = ui.dispatch.compare_exchange(
                UI_RESERVED,
                UI_RETIRED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
        }
    }
}

impl FixedResource {
    fn latest_ui_owner(&self) -> (&ExtensionHostOperation, crate::desktop::NativeEpochId) {
        let known = self
            .last_ui
            .as_ref()
            .map(|ui| (&ui.operation, ui.epoch))
            .unwrap_or((&self.attempt.operation, self.attempt.epoch));
        if let Some(pending) = &self.pending_ui
            && pending.dispatch.load(Ordering::SeqCst) == UI_MAY_DISPATCH
            && pending.epoch >= known.1
        {
            return (&pending.operation, pending.epoch);
        }
        known
    }
    fn matches_ui_ack(
        &self,
        context: &ExtensionHostOperation,
        epoch: crate::desktop::NativeEpochId,
        operation: ExtensionFixedUiOperation,
        cursor_id: &str,
        owner_epoch: &str,
    ) -> bool {
        self.pending_ui.as_ref().is_some_and(|pending| {
            pending.operation == *context
                && pending.epoch == epoch
                && pending.request.operation == operation
                && pending.request.cursor.id == cursor_id
                && pending.request.owner_epoch == owner_epoch
        })
    }
}

impl Host {
    fn begin_fixed_ui(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        scope: &CallScope,
        request: &ExtensionFixedUiRequest,
    ) -> Result<Arc<AtomicU8>, ToolError> {
        let state = self.fixed_state_mut(owner, identity)?;
        let FixedPreparation::Retained(resource) = &mut state.fixed_preparation else {
            return Err(unknown("fixed UI lost its actual resource"));
        };
        if !matches!(resource.phase, FixedPhase::Ready) || resource.uncertainty.is_some() {
            return Err(ToolError::CleanupUnconfirmed(
                "fixed UI resource remains unsettled".into(),
            ));
        }
        if let Some(ui) = &resource.pending_ui {
            let _ = ui.dispatch.compare_exchange(
                UI_RESERVED,
                UI_RETIRED,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
            if ui.dispatch.load(Ordering::SeqCst) != UI_RETIRED {
                return Err(ToolError::CleanupUnconfirmed(
                    "fixed UI has an admitted pending call; not replayed".into(),
                ));
            }
        }
        let dispatch = Arc::new(AtomicU8::new(UI_RESERVED));
        resource.pending_ui = Some(FixedUiAttempt {
            operation: scope.context.clone(),
            epoch: scope.epoch,
            request: request.clone(),
            dispatch: dispatch.clone(),
        });
        Ok(dispatch)
    }
    pub(in crate::browser) fn fixed_cleanup_protected(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        purpose: &FixedCleanupPurpose,
    ) -> Result<bool, ToolError> {
        self.fixed_state_mut(owner, identity)?
            .fixed_preparation
            .retire_unpolled_ui();
        let state = self.fixed_state(owner, identity)?;
        Ok(match purpose {
            FixedCleanupPurpose::Epoch { through } => {
                state.fixed_preparation.protected_from_epoch(*through)
                    || self
                        .cursor_scopes
                        .get(&(owner, identity.clone()))
                        .is_some_and(|endpoint| endpoint.epoch() > *through)
            }
            FixedCleanupPurpose::Turn { turn } => state.fixed_preparation.protected_from_turn(turn),
            FixedCleanupPurpose::Owner => false,
        })
    }
    pub(super) async fn finalize_retained_presentation(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        mark: TabMark,
    ) {
        let result = self
            .finalize_retained_presentation_once(owner, identity, mark)
            .await;
        if let Err(error) = result
            && let Some(lease) = self.tabs.get_mut(identity)
            && lease.creator.owner == owner
            && let Some(state) = &mut lease.extension
        {
            state.retained_presentation = RetainedPresentation::Failed(error.to_string());
            state.presentation_error = Some(error.to_string());
        }
    }

    async fn finalize_retained_presentation_once(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        mark: TabMark,
    ) -> Result<(), ToolError> {
        let lease = self
            .tabs
            .get(identity)
            .filter(|lease| lease.creator.owner == owner && lease.handoff_transfer.is_none())
            .ok_or_else(|| unknown("retained presentation lost its owner"))?;
        let provider = lease.creator.provider.clone();
        let state = lease
            .extension
            .as_ref()
            .ok_or_else(|| unknown("retained presentation lost its physical resource"))?;
        match &state.retained_presentation {
            RetainedPresentation::NotAttempted => {}
            RetainedPresentation::Pending => return Ok(()),
            RetainedPresentation::Acknowledged(ack) => {
                if ack.tab_id.to_string() != identity.target {
                    return Err(unknown(
                        "retained presentation acknowledgement changed resource",
                    ));
                }
                return Ok(());
            }
            RetainedPresentation::Failed(reason) => return Err(unknown(reason)),
        }
        if !provider.extension().is_some_and(|extension| {
            extension
                .capabilities()
                .is_ok_and(|caps| caps.retained_tab_presentation)
        }) {
            return Err(failed(
                "selected provider has no retained tab presentation service",
            ));
        }
        let FixedPreparation::Retained(resource) = &state.fixed_preparation else {
            return Err(failed(
                "retained presentation requires an existing fixed UI resource",
            ));
        };
        let prepared = resource
            .acknowledged
            .as_ref()
            .ok_or_else(|| unknown("retained presentation has no matched preparation"))?;
        let receipt = prepared.receipt.clone();
        self.current_fixed(owner, identity, &receipt)?;
        let (operation, epoch) = resource
            .last_ui
            .as_ref()
            .map(|last| (last.operation.clone(), last.epoch))
            .unwrap_or_else(|| (resource.attempt.operation.clone(), resource.attempt.epoch));
        let mut ui = resource.current_ui.clone();
        ui.operation = match mark {
            TabMark::Deliverable => ExtensionFixedUiOperation::FinalizeDeliverable,
            TabMark::Handoff => ExtensionFixedUiOperation::FinalizeHandoff,
        };
        ui.owner_epoch = epoch.to_string();
        ui.point = None;
        ui.action = ExtensionFixedUiAction::Idle;
        let scope = self.extension_context(
            owner,
            &provider,
            operation,
            epoch,
            CallTarget::Retirement,
            false,
        )?;
        let dispatch = self.begin_fixed_ui(owner, identity, &scope, &ui)?;
        self.fixed_state_mut(owner, identity)?.retained_presentation =
            RetainedPresentation::Pending;
        let result = scope
            .dispatch_retirement(async {
                enter_fixed_ui(&dispatch).map_err(|error| *error)?;
                scope.control.session_ui(&receipt, &ui).await
            })
            .await;
        self.reconcile_provider(owner, &provider).await?;
        let proof = result.map_err(provider::extension_error)?;
        let ExtensionFixedUiAck::Attempted {
            retention: Some(ack),
            ..
        } = proof.ui
        else {
            return Err(unknown(
                "retained presentation has no actual matched acknowledgement",
            ));
        };
        let expected = match mark {
            TabMark::Deliverable => {
                cua_driver_core::browser::ExtensionRetentionPresentationStatus::Deliverable
            }
            TabMark::Handoff => {
                cua_driver_core::browser::ExtensionRetentionPresentationStatus::Handoff
            }
        };
        if ack.tab_id.to_string() != identity.target
            || ack.status != expected
            || !ack.intent_persisted
        {
            return Err(unknown(
                "retained presentation acknowledgement changed its requested intent",
            ));
        }
        let state = self.fixed_state_mut(owner, identity)?;
        if !ack.renderer_acknowledged || (!ack.observed && !ack.badge_applied) {
            state.presentation_error =
                Some("retained intent persisted but favicon rendering was not confirmed".into());
        }
        state.retained_presentation = RetainedPresentation::Acknowledged(ack);
        Ok(())
    }

    pub(in crate::browser) async fn finalize_fixed_session_ui(
        &mut self,
        owner: uuid::Uuid,
        identity: &TabIdentity,
        receipt: &ExtensionFixedSessionReceipt,
        cleanup_control: &ExtensionBrowserProvider,
        purpose: FixedCleanupPurpose,
    ) -> Result<(), ToolError> {
        let provider = self
            .tabs
            .get(identity)
            .ok_or_else(|| unknown("fixed cleanup lost its actual lease"))?
            .creator
            .provider
            .clone();
        if self.fixed_identity(owner, &provider, receipt.tab_id())? != *identity {
            return Err(unknown(
                "fixed cleanup changed its actual owner/provider/generation",
            ));
        }
        if self.fixed_cleanup_protected(owner, identity, &purpose)? {
            // Actual outer callers skip before retirement/Closing/removal.
            return Err(ToolError::CleanupUnconfirmed(
                "fixed cleanup protects newer actual/possible UI ownership".into(),
            ));
        }
        let state = self.fixed_state(owner, identity)?;

        if self
            .cursor_scopes
            .get(&(owner, identity.clone()))
            .is_some_and(|endpoint| endpoint.fixed_scope_id() != Some(receipt.scope_id()))
        {
            return Err(ToolError::CleanupUnconfirmed(
                "fixed cleanup cannot remove a replacement scope".into(),
            ));
        }
        let (initial_operation, initial_epoch, operation, epoch) = match &state.fixed_preparation {
            FixedPreparation::Retained(resource) => {
                let (operation, epoch) = resource
                    .last_ui
                    .as_ref()
                    .map(|ui| (ui.operation.clone(), ui.epoch))
                    .unwrap_or_else(|| {
                        (resource.attempt.operation.clone(), resource.attempt.epoch)
                    });
                (
                    resource.attempt.operation.clone(),
                    resource.attempt.epoch,
                    operation,
                    epoch,
                )
            }
            _ => return Err(unknown("fixed cleanup lost its actual issued operation")),
        };
        // Either stored endpoint view can have survived CallContext GC. Register
        // only these actual issued identities for retirement, never a new UUID
        // or an envelope rewritten to a guessed/terminal replacement turn.
        self.extension_context(
            owner,
            &provider,
            initial_operation,
            initial_epoch,
            CallTarget::Retirement,
            false,
        )?;
        let scope = self.extension_context(
            owner,
            &provider,
            operation,
            epoch,
            CallTarget::Retirement,
            false,
        )?;
        if !self.begin_fixed_clear(owner, identity, receipt, None)? {
            return Ok(());
        }
        let expected = match &self.fixed_state(owner, identity)?.fixed_preparation {
            FixedPreparation::Retained(resource) => resource
                .clear_attempt
                .clone()
                .ok_or_else(|| unknown("fixed cleanup lost its actual clear attempt"))?,
            _ => return Err(unknown("fixed cleanup lost its actual resource")),
        };
        let result = scope
            .dispatch_retirement(async {
                enter_fixed_ui(&expected.dispatch).map_err(|error| *error)?;
                cleanup_control.clear_session_preparation(receipt).await
            })
            .await;
        let reconciled = self.reconcile_provider(owner, &provider).await;
        if let Err(error) = &result {
            self.finish_fixed_clear_error(
                owner,
                identity,
                &expected,
                reconciled.is_ok()
                    && (expected.dispatch.load(Ordering::SeqCst) != UI_MAY_DISPATCH
                        || cleanup_control.undispatched_control(error).is_some()),
                &error.to_string(),
            );
        }
        reconciled?;
        result.map_err(provider::extension_error)?;
        if !self
            .fixed_state(owner, identity)?
            .fixed_preparation
            .cleanup_confirmed()
        {
            return Err(ToolError::CleanupUnconfirmed(
                "fixed cleanup lacks an actual matching Clear ACK".into(),
            ));
        }
        Ok(())
    }
}

impl Host {
    pub(super) fn apply_fixed_cleanup_observation(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        observation: ExtensionSessionCleanupObservation,
    ) -> Result<(), ToolError> {
        let extension = provider
            .extension()
            .ok_or_else(|| failed("extension provider required"))?;
        if observation.generation() != extension.identity().generation
            || observation.wire_context().host_session_id() != owner.to_string()
            || observation.owner().is_empty()
        {
            return Ok(());
        }
        let identity = BrowserIdentity::of(provider, observation.generation())?
            .tab(&observation.tab_id().to_string());
        let Some(lease) = self
            .tabs
            .get_mut(&identity)
            .filter(|lease| lease.creator.owner == owner && lease.creator.provider == *provider)
        else {
            return Ok(());
        };
        let Some(state) = lease.extension.as_mut() else {
            return Ok(());
        };
        let FixedPreparation::Retained(resource) = &mut state.fixed_preparation else {
            return Ok(());
        };
        let Some(receipt) = &resource.receipt else {
            return Ok(());
        };
        if receipt.scope_id() != observation.scope_id()
            || receipt.tab_id() != observation.tab_id()
            || receipt.generation() != observation.generation()
            || receipt.wire_context() != observation.wire_context()
            || resource
                .acknowledged
                .as_ref()
                .and_then(|prepared| prepared.headers.scope.as_ref())
                .is_some_and(|scope| scope.owner != observation.owner())
        {
            return Ok(());
        }
        if !observation.cleanup_confirmed() {
            resource
                .uncertainty
                .get_or_insert_with(|| "actual fixed cleanup observation is unconfirmed".into());
            resource.phase = FixedPhase::Unknown;
        }
        // True metadata cannot manufacture an SDK Clear ACK, discharge Unknown,
        // or prove independent physical/Header/CDP/Host T2 cleanup.
        Ok(())
    }
}

#[cfg(test)]
impl FixedPreparation {
    fn unknown(&self) -> Option<&str> {
        match self {
            Self::Retained(resource) => resource.uncertainty.as_deref(),
            _ => None,
        }
    }
}

#[cfg(all(test, unix))]
mod actual_call_scope_tests {
    use super::*;
    use cua_driver_core::browser::{ExtensionProviderError, ValidatedExtensionEndpoint};
    use std::{fs::Permissions, future::Future, os::unix::fs::PermissionsExt};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{UnixListener, UnixStream},
    };

    async fn bounded<F: Future>(future: F) -> F::Output {
        tokio::time::timeout(Duration::from_secs(5), future)
            .await
            .expect("private extension fixture boundary must finish")
    }

    async fn read_frame(server: &mut UnixStream) -> Value {
        let mut header = [0_u8; 4];
        server.read_exact(&mut header).await.unwrap();
        let length = u32::from_ne_bytes(header) as usize;
        assert!((1..=65_536).contains(&length), "fixture frame byte budget");
        let mut payload = vec![0; length];
        server.read_exact(&mut payload).await.unwrap();
        serde_json::from_slice(&payload).unwrap()
    }

    async fn write_frame(server: &mut UnixStream, frame: Value) {
        let payload = serde_json::to_vec(&frame).unwrap();
        let length = u32::try_from(payload.len()).unwrap();
        server.write_all(&length.to_ne_bytes()).await.unwrap();
        server.write_all(&payload).await.unwrap();
        server.flush().await.unwrap();
    }

    struct Fixture {
        extension: ExtensionBrowserProvider,
        server: UnixStream,
        // Retain the actual private descriptor/socket directory through the call.
        _directory: tempfile::TempDir,
    }

    impl Fixture {
        async fn open_with_lifecycle(lifecycle: &str) -> Self {
            // Canonical /tmp remains short on supported Unix hosts and avoids a
            // symlink component (notably /tmp -> /private/tmp on macOS).
            let directory = tempfile::Builder::new()
                .prefix("mcu-")
                .tempdir_in("/tmp")
                .unwrap();
            let private = std::fs::canonicalize(directory.path()).unwrap();
            std::fs::set_permissions(&private, Permissions::from_mode(0o700)).unwrap();
            let generation = uuid::Uuid::new_v4().to_string();
            let socket = private.join(format!("{generation}.sock"));
            let listener = UnixListener::bind(&socket).unwrap();
            std::fs::set_permissions(&socket, Permissions::from_mode(0o600)).unwrap();
            let adapter = "org.apache.maka.inventory_fixture";
            let identity = json!({
                "adapter":adapter,
                "extensionId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "instanceId":"main-inventory-fixture",
                "generation":generation,
                "hostPid":std::process::id(),
                "capabilities":{
                    "attachmentPreparation":"metadata_only",
                    "userTabsOrder":"provider",
                    "headerScope":"session",
                    "createdPresentationOwner":"provider",
                    "cursorPresentationOwner":"provider",
                    "cursorHideOwner":"unavailable",
                    "turnLifecycleOwner":lifecycle,
                    "sessionTabInventory":true,"sessionPreparation":"explicit_fixed"
                }
            });
            let capability = "0".repeat(64);
            let descriptor = private.join(format!("{generation}.json"));
            std::fs::write(
                &descriptor,
                serde_json::to_vec(&json!({
                    "protocol":1,"identity":identity,
                    "endpoint":{"kind":"unix","address":socket},
                    "capability":capability
                }))
                .unwrap(),
            )
            .unwrap();
            std::fs::set_permissions(&descriptor, Permissions::from_mode(0o600)).unwrap();
            let endpoint = ValidatedExtensionEndpoint::load(&descriptor, adapter).unwrap();
            let accept = async {
                let (mut server, _) = listener.accept().await.unwrap();
                let hello = read_frame(&mut server).await;
                assert_eq!(
                    hello,
                    json!({
                        "kind":"hello","protocol":1,
                        "generation":generation,"capability":capability
                    })
                );
                write_frame(
                    &mut server,
                    json!({
                        "kind":"welcome","protocol":1,
                        "generation":generation,"identity":identity
                    }),
                )
                .await;
                server
            };
            let (extension, server) = bounded(async {
                tokio::join!(ExtensionBrowserProvider::connect(endpoint), accept)
            })
            .await;
            Self {
                extension: extension.unwrap(),
                server,
                _directory: directory,
            }
        }

        fn provider(&self) -> Provider {
            Provider::Extension {
                id: "extension-inventory-fixture".into(),
                connection: Arc::new(self.extension.clone()),
            }
        }

        async fn assert_no_frame_and_close(&mut self) {
            // Reach the actual actor FIFO barrier, then close only this fixture's
            // public transport. EOF after draining the server proves that no extra
            // bytes were queued; a timed WouldBlock observation would not do so.
            assert!(
                bounded(self.extension.pending_operations())
                    .await
                    .unwrap()
                    .is_empty()
            );
            bounded(self.extension.close()).await;
            let mut byte = [0_u8];
            assert_eq!(
                bounded(self.server.read(&mut byte)).await.unwrap(),
                0,
                "the fixture transport must close without another IPC frame"
            );
            // Transport EOF is deliberately not used as extension cleanup proof.
        }
    }

    struct PendingScope {
        host: Arc<tokio::sync::Mutex<Host>>,
        owner: uuid::Uuid,
        identity: TabIdentity,
        scope: CallScope,
        policy: ExtensionPreparationPolicy,
        ui: ExtensionFixedUiRequest,
        cursor: Spec,
        attempt: FixedAttempt,
    }
    impl PendingScope {
        async fn new(fixture: &Fixture) -> Self {
            Self::new_with_policy(fixture, ExtensionPreparationPolicy::default()).await
        }
        async fn new_with_policy(fixture: &Fixture, policy: ExtensionPreparationPolicy) -> Self {
            let provider = fixture.provider();
            let owner = uuid::Uuid::new_v4();
            let host = Arc::new(tokio::sync::Mutex::new(Host::default()));
            bounded(register(&host, owner, &provider)).await.unwrap();
            let identity = BrowserIdentity::of(&provider, &fixture.extension.identity().generation)
                .unwrap()
                .tab("17");
            let scope = {
                let mut ledger = host.lock().await;
                ledger
                    .extension_reserve(owner, &provider, "gate-turn", "17", Origin::UserClaimed)
                    .unwrap();
                ledger
                    .extension_context(
                        owner,
                        &provider,
                        context_operation("gate-turn"),
                        crate::desktop::NativeEpochId::new(),
                        CallTarget::Tab {
                            origin: Origin::UserClaimed,
                            tab: Some("17".into()),
                        },
                        true,
                    )
                    .unwrap()
            };
            let cursor = Spec::default();
            let ui = ui_request(
                &cursor,
                scope.epoch,
                None,
                "idle",
                ExtensionFixedUiOperation::Control,
            )
            .unwrap();
            let attempt = {
                let mut ledger = host.lock().await;
                ledger
                    .begin_fixed_preparation(&scope, &identity, policy.clone(), ui.clone())
                    .unwrap();
                ledger
                    .fixed_state(owner, &identity)
                    .unwrap()
                    .fixed_preparation
                    .attempt()
                    .unwrap()
                    .clone()
            };
            Self {
                host,
                owner,
                identity,
                scope,
                policy,
                ui,
                cursor,
                attempt,
            }
        }
        async fn reject_at_actual_call_gate(&self) -> ExtensionProviderError {
            // Build the SAME real SDK future before sealing the actual scope.
            let original = self.scope.dispatch(async {
                enter_fixed_ui(&self.attempt.dispatch).map_err(|error| *error)?;
                self.scope
                    .control
                    .prepare_fixed_session_tab(17, &self.policy, &self.ui)
                    .await
            });
            self.scope.controls.seal();
            *bounded(original).await.unwrap_err()
        }
    }

    #[tokio::test]
    async fn actual_call_gate_refusal_before_inner_sdk_poll_retires_exact_pending() {
        let mut fixture = Fixture::open_with_lifecycle("host").await;
        let pending = PendingScope::new(&fixture).await;
        let error = pending.reject_at_actual_call_gate().await;
        assert!(matches!(error, ExtensionProviderError::Refused { .. }));
        assert_eq!(
            pending.attempt.dispatch.load(Ordering::SeqCst),
            UI_RESERVED,
            "the exact inner SDK firstpoll was not crossed"
        );
        {
            let mut ledger = pending.host.lock().await;
            ledger.fixed_caller_error(
                pending.owner,
                &pending.identity,
                &pending.attempt,
                &error.to_string(),
            );
            assert!(matches!(
                ledger
                    .fixed_state(pending.owner, &pending.identity)
                    .unwrap()
                    .fixed_preparation,
                FixedPreparation::NotAttempted
            ));
            assert_eq!(pending.attempt.dispatch.load(Ordering::SeqCst), UI_RETIRED);
        }
        fixture.assert_no_frame_and_close().await;
        // This proves actual local gate/IPC lifetime only, not Host authorization
        // or a successful extension fixed preparation/Chrome operation.
    }

    async fn retained_completion(
        control: &ExtensionBrowserProvider,
        id: u64,
    ) -> cua_driver_core::browser::ExtensionOperationCompletion {
        bounded(async {
            loop {
                if let Some(completion) = control
                    .pending_completions()
                    .await
                    .unwrap()
                    .into_iter()
                    .find(|completion| completion.id == id)
                {
                    return completion;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
    }
    async fn reply_not_dispatched(server: &mut UnixStream, id: u64) {
        write_frame(server, json!({"kind":"controlEvent", "event":{"kind":"reply","data":{
            "id":id, "outcome":{"kind":"notDispatched","data":{
                "kind":"not_dispatched", "message":"trusted Rust phase before native frame", "details":null
            }}
        }}})).await;
    }

    #[tokio::test]
    async fn retained_no_dispatch_without_caller_folds_before_ack_and_cannot_retire_replacement() {
        let mut fixture = Fixture::open_with_lifecycle("host").await;
        let PendingScope {
            host,
            owner,
            identity,
            scope,
            policy,
            ui,
            attempt,
            ..
        } = PendingScope::new(&fixture).await;
        let provider = scope.provider.clone();
        let context = scope.context.clone();
        let epoch = scope.epoch;
        let control = scope.control.clone();
        let mut original = Box::pin(scope.dispatch(async {
            enter_fixed_ui(&attempt.dispatch).map_err(|error| *error)?;
            scope
                .control
                .prepare_fixed_session_tab(17, &policy, &ui)
                .await
        }));
        let frame = bounded(async {
            tokio::select! {
                result = &mut original => panic!("original waits for same retained reply: {result:?}"),
                frame = read_frame(&mut fixture.server) => frame,
            }
        }).await;
        let old_id = frame["request"]["id"].as_u64().unwrap();
        drop(original);
        drop(scope);
        // Block the automatic observer; exercise the production synchronous fold
        // exactly before its ACK await, while the actual Core row stays retained.
        let mut ledger = host.lock().await;
        reply_not_dispatched(&mut fixture.server, old_id).await;
        let old = retained_completion(&control, old_id).await;
        let recovered = control.recover_completion(old_id).await.unwrap();
        ledger
            .apply_extension_completion(owner, &provider, &old, recovered)
            .unwrap();
        assert!(matches!(
            ledger
                .fixed_state(owner, &identity)
                .unwrap()
                .fixed_preparation,
            FixedPreparation::NotAttempted
        ));
        assert_eq!(attempt.dispatch.load(Ordering::SeqCst), UI_RETIRED);
        assert!(
            ledger.extension[&(owner, identity.browser.clone())]
                .applied
                .contains(&old_id)
        );
        assert!(
            control
                .pending_completions()
                .await
                .unwrap()
                .iter()
                .any(|entry| entry.id == old_id),
            "the original SDK ACK has deliberately not been sent or consumed"
        );
        let replacement = ledger
            .extension_context(
                owner,
                &provider,
                context,
                epoch,
                CallTarget::Tab {
                    origin: Origin::UserClaimed,
                    tab: Some("17".into()),
                },
                true,
            )
            .unwrap();
        ledger
            .begin_fixed_preparation(&replacement, &identity, policy.clone(), ui.clone())
            .unwrap();
        let next = ledger
            .fixed_state(owner, &identity)
            .unwrap()
            .fixed_preparation
            .attempt()
            .unwrap()
            .clone();
        let mut next_future = Box::pin(replacement.dispatch(async {
            enter_fixed_ui(&next.dispatch).map_err(|error| *error)?;
            replacement
                .control
                .prepare_fixed_session_tab(17, &policy, &ui)
                .await
        }));
        let next_frame = bounded(async {
            tokio::select! {
                result = &mut next_future => panic!("replacement waits for its own reply: {result:?}"),
                frame = read_frame(&mut fixture.server) => frame,
            }
        }).await;
        assert_ne!(
            frame["request"]["scopeId"],
            next_frame["request"]["scopeId"]
        );
        assert_eq!(next.dispatch.load(Ordering::SeqCst), UI_MAY_DISPATCH);
        // Re-read the SAME real old completion while B has identical Host
        // operation/epoch/UI and has actually crossed its own SDK firstpoll.
        let recovered = control.recover_completion(old_id).await.unwrap();
        ledger
            .apply_extension_completion(owner, &provider, &old, recovered)
            .unwrap();
        assert!(
            ledger
                .fixed_state(owner, &identity)
                .unwrap()
                .fixed_preparation
                .matches_attempt(&next)
        );
        assert_eq!(next.dispatch.load(Ordering::SeqCst), UI_MAY_DISPATCH);
        drop(next_future);
        drop(replacement);
        let next_id = next_frame["request"]["id"].as_u64().unwrap();
        reply_not_dispatched(&mut fixture.server, next_id).await;
        let next_completion = retained_completion(&control, next_id).await;
        let recovered = control.recover_completion(next_id).await.unwrap();
        ledger
            .apply_extension_completion(owner, &provider, &next_completion, recovered)
            .unwrap();
        assert!(matches!(
            ledger
                .fixed_state(owner, &identity)
                .unwrap()
                .fixed_preparation,
            FixedPreparation::NotAttempted
        ));
        control.acknowledge_completion(old_id).await.unwrap();
        control.acknowledge_completion(next_id).await.unwrap();
        assert!(control.pending_operations().await.unwrap().is_empty());
        drop(ledger);
        fixture.assert_no_frame_and_close().await;
        // Real public Core/Unix actor + Main fold ordering only. The independent
        // Core broker writer keeper proves the zero-write producer; this peer is
        // a trusted-phase consumer fixture, not actual Chrome or Host T1/T2.
    }

    #[tokio::test]
    async fn late_old_error_cannot_change_replacement_pending_or_actual_new_unknown() {
        let mut fixture = Fixture::open_with_lifecycle("host").await;
        let old = PendingScope::new(&fixture).await;
        let error = old.reject_at_actual_call_gate().await;
        let (new_scope, new_attempt, ui) = {
            let mut ledger = old.host.lock().await;
            ledger.fixed_caller_error(old.owner, &old.identity, &old.attempt, &error.to_string());
            let scope = ledger
                .extension_context(
                    old.owner,
                    &old.scope.provider,
                    context_operation("gate-turn"),
                    crate::desktop::NativeEpochId::new(),
                    CallTarget::Tab {
                        origin: Origin::UserClaimed,
                        tab: Some("17".into()),
                    },
                    true,
                )
                .unwrap();
            let ui = ui_request(
                &Spec::default(),
                scope.epoch,
                None,
                "idle",
                ExtensionFixedUiOperation::Control,
            )
            .unwrap();
            ledger
                .begin_fixed_preparation(&scope, &old.identity, old.policy.clone(), ui.clone())
                .unwrap();
            let attempt = ledger
                .fixed_state(old.owner, &old.identity)
                .unwrap()
                .fixed_preparation
                .attempt()
                .unwrap()
                .clone();
            // A late handler for the completed old future must not touch this
            // replacement, even though the same owner/tab/turn is reused.
            ledger.fixed_caller_error(old.owner, &old.identity, &old.attempt, &error.to_string());
            let actual = ledger
                .fixed_state(old.owner, &old.identity)
                .unwrap()
                .fixed_preparation
                .attempt()
                .unwrap();
            assert_eq!(actual.operation, attempt.operation);
            assert_eq!(actual.epoch, attempt.epoch);
            assert!(Arc::ptr_eq(&actual.dispatch, &attempt.dispatch));
            assert!(matches!(
                ledger
                    .fixed_state(old.owner, &old.identity)
                    .unwrap()
                    .fixed_preparation,
                FixedPreparation::Pending(_)
            ));
            (scope, attempt, ui)
        };
        let reply = async {
            let frame = read_frame(&mut fixture.server).await;
            assert_eq!(frame["request"]["method"], "prepareSessionTab");
            write_frame(
                &mut fixture.server,
                json!({"kind":"controlEvent","event":{"kind":"reply","data":{
                    "id":frame["request"]["id"],"outcome":{"kind":"unknown","data":{
                        "reason":"actual-new-prepare-unknown"
                    }}
                }}}),
            )
            .await;
        };
        let result = new_scope.dispatch(async {
            enter_fixed_ui(&new_attempt.dispatch).map_err(|error| *error)?;
            new_scope
                .control
                .prepare_fixed_session_tab(17, &old.policy, &ui)
                .await
        });
        let (result, ()) = bounded(async { tokio::join!(result, reply) }).await;
        assert!(matches!(
            result.map_err(|error| *error),
            Err(ExtensionProviderError::OutcomeUnknown { .. })
        ));
        {
            let mut ledger = old.host.lock().await;
            bounded(ledger.reconcile_provider(old.owner, &old.scope.provider))
                .await
                .unwrap();
            let state = &ledger
                .fixed_state(old.owner, &old.identity)
                .unwrap()
                .fixed_preparation;
            let cause = state
                .unknown()
                .expect("actual matched SDK Unknown is retained")
                .to_owned();
            assert!(
                state.cleanup_receipt().is_some(),
                "actual SDK issued cleanup-only address"
            );
            ledger.fixed_caller_error(old.owner, &old.identity, &old.attempt, &error.to_string());
            let state = &ledger
                .fixed_state(old.owner, &old.identity)
                .unwrap()
                .fixed_preparation;
            assert_eq!(state.unknown(), Some(cause.as_str()));
            let actual = state.attempt().unwrap();
            assert_eq!(actual.operation, new_attempt.operation);
            assert_eq!(actual.epoch, new_attempt.epoch);
            assert!(Arc::ptr_eq(&actual.dispatch, &new_attempt.dispatch));
        }
        // Unknown stays retained. Closing the task-owned IPC fixture is not
        // claimed as extension cleanup, Host permission or T2 settlement.
        bounded(fixture.extension.close()).await;
        let mut byte = [0_u8];
        assert_eq!(bounded(fixture.server.read(&mut byte)).await.unwrap(), 0);
    }

    fn known_preparation_result(frame: &Value) -> Value {
        json!({"tab":{"id":frame["request"]["tabId"]},"sessionOnly":true,"preparation":{
            "scopeId":frame["request"]["scopeId"],
            "foreignInstalled":false,"popupInstalled":false,
            "headers":{"stateConfirmed":true,"cleanupConfirmed":true,"active":false,"pendingRemoval":false},
            "ui":{"status":"notAttempted"}
        }})
    }

    #[tokio::test]
    async fn actual_preparation_ack_after_same_call_seal_is_cleanup_only_in_host() {
        let mut fixture = Fixture::open_with_lifecycle("host").await;
        let pending = PendingScope::new(&fixture).await;
        let reply = async {
            let frame = read_frame(&mut fixture.server).await;
            assert_eq!(frame["request"]["method"], "prepareSessionTab");
            {
                let ledger = pending.host.lock().await;
                let provider = ledger
                    .extension
                    .get(&(pending.owner, pending.identity.browser.clone()))
                    .unwrap();
                assert!(
                    provider.retiring_turn.is_none(),
                    "old epoch drain need not retire the turn"
                );
                let call = provider
                    .calls
                    .get(&pending.attempt.operation.operation_id)
                    .unwrap();
                assert_eq!(call.epoch, pending.attempt.epoch);
                call.controls.seal();
            }
            write_frame(&mut fixture.server, json!({"kind":"controlEvent","event":{"kind":"reply","data":{
                "id":frame["request"]["id"],"outcome":{"kind":"result","data":known_preparation_result(&frame)}
            }}})).await;
        };
        let original = pending.scope.dispatch(async {
            enter_fixed_ui(&pending.attempt.dispatch).map_err(|error| *error)?;
            pending
                .scope
                .control
                .prepare_fixed_session_tab(17, &pending.policy, &pending.ui)
                .await
        });
        let (prepared, ()) = bounded(async { tokio::join!(original, reply) }).await;
        let prepared = prepared.unwrap();
        {
            let mut ledger = pending.host.lock().await;
            bounded(ledger.reconcile_provider(pending.owner, &pending.scope.provider))
                .await
                .unwrap();
            let state = ledger
                .fixed_state(pending.owner, &pending.identity)
                .unwrap();
            assert!(state.fixed_preparation.ready().is_none());
            let retained = state.fixed_preparation.cleanup_receipt().unwrap();
            assert!(same_receipt(retained, &prepared.receipt));
            assert!(state.fixed_preparation.unknown().is_some());
            assert!(
                state.user_prepared_operation.is_none(),
                "late ACK must not mint an acquisition"
            );
            assert!(
                ledger
                    .acquisition(pending.owner, &pending.identity)
                    .is_none()
            );
        }
        // The actual known receipt remains retained; transport close is no Clear/T2 proof.
        fixture.assert_no_frame_and_close().await;
    }

    struct RetentionIdentityOnly;
    impl crate::BrowserHostEffects for RetentionIdentityOnly {
        fn spawn(&self, unpolled: crate::HostEffectFuture) -> Result<(), ToolError> {
            drop(unpolled);
            Err(failed(
                "identity-only keeper cannot execute any Host effect",
            ))
        }
        fn supports_lease_children(&self) -> bool {
            // This marker is retained solely for Arc identity. No callback is
            // invoked and it supplies no actual Host admission or DB authority.
            true
        }
    }

    fn actual_retention_request(
        scope: &CallScope,
        receipt: &ExtensionFixedSessionReceipt,
    ) -> crate::BrowserSessionPreparation {
        crate::BrowserSessionPreparation {
            native_owner: scope.owner,
            native_epoch: scope.epoch.to_string(),
            browser_id: scope.provider.id().into(),
            generation: receipt.generation().into(),
            turn_id: scope.context.turn_id.clone(),
            operation_id: scope.context.operation_id.clone(),
            target: crate::BrowserPreparationTarget::FixedSessionTab {
                tab_id: receipt.tab_id().to_string(),
                scope_id: receipt.scope_id().into(),
            },
        }
    }

    #[tokio::test]
    async fn actual_configure_ack_renews_only_current_compatible_factory_and_ui_attempt() {
        for case in [
            "renew",
            "cross_turn",
            "policy_changed",
            "new_pending_same_context",
            "new_ack_same_context",
        ] {
            let mut fixture = Fixture::open_with_lifecycle("host").await;
            let initial = PendingScope::new_with_policy(
                &fixture,
                ExtensionPreparationPolicy {
                    popup_enabled: true,
                    ..Default::default()
                },
            )
            .await;
            let reply = async {
                let frame = read_frame(&mut fixture.server).await;
                let mut result = known_preparation_result(&frame);
                result["preparation"]["popupInstalled"] = json!(true);
                write_frame(
                    &mut fixture.server,
                    json!({"kind":"controlEvent","event":{"kind":"reply","data":{
                        "id":frame["request"]["id"],"outcome":{"kind":"result","data":result}
                    }}}),
                )
                .await;
            };
            let prepare = initial.scope.dispatch(async {
                enter_fixed_ui(&initial.attempt.dispatch).map_err(|error| *error)?;
                initial
                    .scope
                    .control
                    .prepare_fixed_session_tab(17, &initial.policy, &initial.ui)
                    .await
            });
            let (prepared, ()) = bounded(async { tokio::join!(prepare, reply) }).await;
            let prepared = prepared.unwrap();
            let owner_text = initial.owner.to_string();
            let old_factory: Arc<dyn crate::BrowserHostEffects> = Arc::new(RetentionIdentityOnly);
            let old_invocation =
                crate::InvocationContext::new(&owner_text, &initial.scope.context.turn_id)
                    .with_operation_id(initial.scope.context.operation_id.clone())
                    .with_browser_preparation_policy(crate::BrowserPreparationPolicy {
                        popup_enabled: true,
                        ..Default::default()
                    })
                    .with_browser_host_effects(old_factory.clone());
            let old_request = actual_retention_request(&initial.scope, &prepared.receipt);
            let (scope, ui, dispatch, initial_sequence, acquisition, creator_turn) = {
                let mut ledger = initial.host.lock().await;
                bounded(ledger.reconcile_provider(initial.owner, &initial.scope.provider))
                    .await
                    .unwrap();
                ledger
                    .retain_fixed_services(
                        &initial.scope,
                        &prepared,
                        &initial.cursor,
                        &old_invocation,
                        &old_request,
                    )
                    .unwrap();
                let sequence = ledger.tabs[&initial.identity].extension_sequence;
                let acquisition = ledger
                    .fixed_state(initial.owner, &initial.identity)
                    .unwrap()
                    .user_prepared_operation
                    .clone();
                let creator = ledger.tabs[&initial.identity].creator.turn.clone();
                let turn = if case == "cross_turn" {
                    "next-turn"
                } else {
                    "gate-turn"
                };
                let scope = ledger
                    .extension_context(
                        initial.owner,
                        &initial.scope.provider,
                        context_operation(turn),
                        crate::desktop::NativeEpochId::new(),
                        CallTarget::FixedConfiguration { tab: "17".into() },
                        false,
                    )
                    .unwrap();
                let ui = ui_request(
                    &initial.cursor,
                    scope.epoch,
                    None,
                    "idle",
                    ExtensionFixedUiOperation::Configure,
                )
                .unwrap();
                let dispatch = ledger
                    .begin_fixed_ui(initial.owner, &initial.identity, &scope, &ui)
                    .unwrap();
                (scope, ui, dispatch, sequence, acquisition, creator)
            };
            let fresh_factory: Arc<dyn crate::BrowserHostEffects> = Arc::new(RetentionIdentityOnly);
            let invocation = crate::InvocationContext::new(&owner_text, &scope.context.turn_id)
                .with_operation_id(scope.context.operation_id.clone())
                .with_browser_preparation_policy(crate::BrowserPreparationPolicy {
                    popup_enabled: case != "policy_changed",
                    ..Default::default()
                });
            let invocation = invocation.with_browser_host_effects(fresh_factory.clone());
            let admission = actual_retention_request(&scope, &prepared.receipt);
            let reply = async {
                let frame = read_frame(&mut fixture.server).await;
                assert_eq!(frame["request"]["method"], "sessionUi");
                assert_eq!(frame["request"]["scopeId"], prepared.receipt.scope_id());
                let ack = json!({"status":"attempted","acknowledged":true,"state":{"status":"ready","visible":false,"requestedPosition":null}});
                write_frame(
                    &mut fixture.server,
                    json!({"kind":"controlEvent","event":{"kind":"reply","data":{
                        "id":frame["request"]["id"],"outcome":{"kind":"result","data":{
                            "tabId":17,"scopeId":prepared.receipt.scope_id(),"ui":ack
                        }}
                    }}}),
                )
                .await;
            };
            let configure = scope.dispatch(async {
                enter_fixed_ui(&dispatch).map_err(|error| *error)?;
                scope.control.session_ui(&prepared.receipt, &ui).await
            });
            let (proof, ()) = bounded(async { tokio::join!(configure, reply) }).await;
            let proof = proof.unwrap();
            bounded(
                initial
                    .host
                    .lock()
                    .await
                    .reconcile_provider(initial.owner, &initial.scope.provider),
            )
            .await
            .unwrap();
            let replacement_attempt =
                if matches!(case, "new_pending_same_context" | "new_ack_same_context") {
                    Some(
                        initial
                            .host
                            .lock()
                            .await
                            .begin_fixed_ui(initial.owner, &initial.identity, &scope, &ui)
                            .unwrap(),
                    )
                } else {
                    None
                };
            if case == "new_ack_same_context" {
                let next = replacement_attempt.as_ref().unwrap();
                let reply = async {
                    let frame = read_frame(&mut fixture.server).await;
                    write_frame(&mut fixture.server, json!({"kind":"controlEvent","event":{"kind":"reply","data":{
                        "id":frame["request"]["id"],"outcome":{"kind":"result","data":{
                            "tabId":17,"scopeId":prepared.receipt.scope_id(),
                            "ui":{"status":"attempted","acknowledged":true,"state":{"status":"ready","visible":false,"requestedPosition":null}}
                        }}
                    }}})).await;
                };
                let newer = scope.dispatch(async {
                    enter_fixed_ui(next).map_err(|error| *error)?;
                    scope.control.session_ui(&prepared.receipt, &ui).await
                });
                let (newer, ()) = bounded(async { tokio::join!(newer, reply) }).await;
                newer.unwrap();
                bounded(
                    initial
                        .host
                        .lock()
                        .await
                        .reconcile_provider(initial.owner, &initial.scope.provider),
                )
                .await
                .unwrap();
            }
            {
                let mut ledger = initial.host.lock().await;
                let outcome = ledger.commit_fixed_configuration(
                    initial.owner,
                    &initial.identity,
                    &initial.cursor,
                    &invocation,
                    &admission,
                    &FixedUiCompletion {
                        scope: &scope,
                        request: &ui,
                        proof: &proof,
                        dispatch: &dispatch,
                    },
                );
                let refused = matches!(case, "new_pending_same_context" | "new_ack_same_context");
                assert_eq!(outcome.is_err(), refused, "case {case}: {outcome:?}");
                let state = ledger
                    .fixed_state(initial.owner, &initial.identity)
                    .unwrap();
                let child = state.lease_children.as_ref().unwrap();
                if case == "renew" {
                    assert!(Arc::ptr_eq(&child.effects, &fresh_factory));
                    assert!(!Arc::ptr_eq(&child.effects, &old_factory));
                    assert_eq!(child.epoch, scope.epoch);
                    assert_eq!(child.turn, scope.context.turn_id);
                } else {
                    assert!(Arc::ptr_eq(&child.effects, &old_factory), "case {case}");
                    assert_eq!(child.epoch, initial.scope.epoch);
                    assert_eq!(child.turn, initial.scope.context.turn_id);
                }
                let endpoint = &ledger.cursor_scopes[&(initial.owner, initial.identity.clone())];
                assert_eq!(
                    endpoint.epoch(),
                    if refused {
                        initial.scope.epoch
                    } else {
                        scope.epoch
                    },
                    "case {case}"
                );
                let FixedPreparation::Retained(resource) = &state.fixed_preparation else {
                    unreachable!()
                };
                assert_eq!(
                    resource.current_ui.owner_epoch,
                    if refused {
                        initial.ui.owner_epoch.clone()
                    } else {
                        ui.owner_epoch.clone()
                    },
                    "case {case}"
                );
                assert!(same_receipt(
                    resource.receipt.as_ref().unwrap(),
                    &prepared.receipt
                ));
                assert_eq!(
                    ledger.tabs[&initial.identity].extension_sequence,
                    initial_sequence
                );
                assert_eq!(ledger.tabs[&initial.identity].creator.turn, creator_turn);
                let (
                    Some(PreparedOperation::Acquired {
                        operation: current_operation,
                        epoch: current_epoch,
                    }),
                    Some(PreparedOperation::Acquired {
                        operation: original_operation,
                        epoch: original_epoch,
                    }),
                ) = (state.user_prepared_operation.as_ref(), acquisition.as_ref())
                else {
                    panic!("actual initial SDK preparation must remain the acquisition");
                };
                assert_eq!(current_operation, original_operation);
                assert_eq!(current_epoch, original_epoch);
                if case == "new_pending_same_context" {
                    let pending = resource.pending_ui.as_ref().unwrap();
                    assert!(Arc::ptr_eq(
                        &pending.dispatch,
                        replacement_attempt.as_ref().unwrap()
                    ));
                    assert!(!Arc::ptr_eq(&pending.dispatch, &dispatch));
                }
            }
            // The positive/negative cases preserve actual original acquisition;
            // identity-only factories do not prove canonical Host grants/effects.
            bounded(fixture.extension.close()).await;
        }
    }
}
