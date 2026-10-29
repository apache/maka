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

//! Actual native-host upload receipts, retained by the existing provider owner.
//! These objects prove resource custody only, never page or file permission.
use super::*;
use cua_driver_core::browser::{
    ExtensionRetainedUpload, ExtensionUploadAbandonAck, ExtensionUploadStage,
};

#[derive(Default)]
pub(super) struct Custody {
    entries: HashMap<uuid::Uuid, Entry>,
}
enum Entry {
    Staged(ExtensionUploadStage),
    RetainedBacking(ExtensionUploadStage),
    Retained(ExtensionRetainedUpload),
}
fn same_staged(left: &ExtensionUploadStage, right: &ExtensionUploadStage) -> bool {
    left.stage_id() == right.stage_id()
        && left.claim_id() == right.claim_id()
        && left.tab_id() == right.tab_id()
        && left.target_id() == right.target_id()
        && left.wire_context() == right.wire_context()
}
impl Entry {
    fn tab_id(&self) -> u64 {
        match self {
            Self::Staged(s) | Self::RetainedBacking(s) => s.tab_id(),
            Self::Retained(s) => s.tab_id(),
        }
    }
    fn same_stage(&self, stage: &ExtensionUploadStage) -> bool {
        match self {
            Self::Staged(known) | Self::RetainedBacking(known) => {
                known.stage_id() == stage.stage_id()
                    && known.claim_id() == stage.claim_id()
                    && known.tab_id() == stage.tab_id()
                    && known.target_id() == stage.target_id()
                    && known.wire_context() == stage.wire_context()
            }
            Self::Retained(known) => {
                known.stage_id() == stage.stage_id()
                    && known.claim_id() == stage.claim_id()
                    && known.tab_id() == stage.tab_id()
                    && known.target_id() == stage.target_id()
                    && known.wire_context() == stage.wire_context()
            }
        }
    }
    fn wire(&self) -> &ExtensionWireContext {
        match self {
            Self::Staged(s) | Self::RetainedBacking(s) => s.wire_context(),
            Self::Retained(s) => s.wire_context(),
        }
    }
}
impl Host {
    pub(super) fn upload_target(
        &self,
        owner: uuid::Uuid,
        browser: &BrowserIdentity,
        stage: &ExtensionUploadStage,
    ) -> Option<String> {
        self.extension
            .get(&(owner, browser.clone()))?
            .uploads
            .entries
            .get(&stage.stage_id())
            .filter(|entry| entry.same_stage(stage))
            .map(|entry| entry.tab_id().to_string())
    }
    fn upload_receipt_scope(
        &self,
        owner: uuid::Uuid,
        completion: &cua_driver_core::browser::ExtensionOperationCompletion,
    ) -> Result<ExtensionWireContext, ToolError> {
        let context = completion
            .host_operation
            .as_ref()
            .ok_or_else(|| unknown("Upload receipt lost its actual Host operation"))?;
        let wire = completion
            .wire_context
            .as_ref()
            .ok_or_else(|| unknown("Upload receipt lost its captured extension context"))?;
        if wire.host_session_id() != owner.to_string() || wire.host_turn_id() != context.turn_id {
            return Err(unknown(
                "Upload receipt does not belong to its captured Host owner/turn",
            ));
        }
        Ok(wire.clone())
    }
    fn record_upload_stage(
        &mut self,
        owner: uuid::Uuid,
        browser: &BrowserIdentity,
        completion: &cua_driver_core::browser::ExtensionOperationCompletion,
        stage: ExtensionUploadStage,
    ) -> Result<(), ToolError> {
        let wire = self.upload_receipt_scope(owner, completion)?;
        if stage.wire_context() != &wire {
            return Err(unknown("Upload stage context changed before the Host fold"));
        }
        let state = self
            .extension
            .get_mut(&(owner, browser.clone()))
            .ok_or_else(|| unknown("Upload resource owner retired before its receipt"))?;
        match &completion.operation {
            ExtensionOperation::BeginUpload {
                claim,
                tab_id,
                target_id,
                ..
            } if stage.claim_id() == claim
                && stage.tab_id() == *tab_id
                && stage.target_id() == target_id => {}
            ExtensionOperation::WriteUploadChunk { stage: id, .. }
            | ExtensionOperation::RetainUploadForSelection { stage: id }
            | ExtensionOperation::AbandonUpload { stage: id }
                if stage.stage_id() == id.stage_id()
                    && state
                        .uploads
                        .entries
                        .get(&id.stage_id())
                        .is_some_and(|entry| entry.same_stage(&stage) && entry.same_stage(id)) => {}
            _ => {
                return Err(unknown(
                    "Upload stage does not match its actual issued control",
                ));
            }
        }
        match state.uploads.entries.entry(stage.stage_id()) {
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(Entry::Staged(stage));
            }
            std::collections::hash_map::Entry::Occupied(entry)
                if entry.get().same_stage(&stage) => {}
            _ => {
                return Err(unknown(
                    "Upload stage address was reused across actual bindings",
                ));
            }
        }
        Ok(())
    }
    fn record_upload_retained(
        &mut self,
        owner: uuid::Uuid,
        browser: &BrowserIdentity,
        completion: &cua_driver_core::browser::ExtensionOperationCompletion,
        retained: ExtensionRetainedUpload,
    ) -> Result<(), ToolError> {
        let wire = self.upload_receipt_scope(owner, completion)?;
        let ExtensionOperation::RetainUploadForSelection { stage } = &completion.operation else {
            return Err(unknown("Upload retain receipt came from another operation"));
        };
        if retained.stage_id() != stage.stage_id() || retained.wire_context() != &wire {
            return Err(unknown("Upload retain receipt scope mismatch"));
        }
        let state = self
            .extension
            .get_mut(&(owner, browser.clone()))
            .ok_or_else(|| unknown("Upload resource owner retired before retain"))?;
        let Some(known) = state.uploads.entries.get(&stage.stage_id()) else {
            return Err(unknown(
                "Upload retain receipt has no original stage custody",
            ));
        };
        if !known.same_stage(stage) {
            return Err(unknown("Upload retain operation changed its issued stage"));
        }
        let agrees = match known {
            Entry::Staged(known) | Entry::RetainedBacking(known) => {
                retained.claim_id() == known.claim_id()
                    && retained.tab_id() == known.tab_id()
                    && retained.target_id() == known.target_id()
                    && retained.wire_context() == known.wire_context()
            }
            Entry::Retained(known) => {
                retained.claim_id() == known.claim_id()
                    && retained.tab_id() == known.tab_id()
                    && retained.target_id() == known.target_id()
                    && retained.wire_context() == known.wire_context()
                    && retained.paths() == known.paths()
            }
        };
        if !agrees {
            return Err(unknown(
                "Upload retained backing changed its actual tab/target binding",
            ));
        }
        state
            .uploads
            .entries
            .insert(stage.stage_id(), Entry::Retained(retained));
        Ok(())
    }
    fn record_upload_retained_backing(
        &mut self,
        owner: uuid::Uuid,
        browser: &BrowserIdentity,
        completion: &cua_driver_core::browser::ExtensionOperationCompletion,
        backing: ExtensionUploadStage,
    ) -> Result<(), ToolError> {
        let wire = self.upload_receipt_scope(owner, completion)?;
        let ExtensionOperation::RetainUploadForSelection { stage } = &completion.operation else {
            return Err(unknown(
                "Upload retained backing came from another operation",
            ));
        };
        if backing.wire_context() != &wire || !same_staged(stage, &backing) {
            return Err(unknown("Upload retained backing scope mismatch"));
        }
        let entry = self
            .extension
            .get_mut(&(owner, browser.clone()))
            .and_then(|state| state.uploads.entries.get_mut(&stage.stage_id()))
            .ok_or_else(|| unknown("Upload retained backing has no original stage custody"))?;
        if entry.wire() != &wire || !entry.same_stage(stage) {
            return Err(unknown("Upload retained backing changed its issued stage"));
        }
        if !matches!(entry, Entry::Retained(_)) {
            *entry = Entry::RetainedBacking(backing);
        }
        Ok(())
    }
    fn record_upload_abandoned(
        &mut self,
        owner: uuid::Uuid,
        browser: &BrowserIdentity,
        completion: &cua_driver_core::browser::ExtensionOperationCompletion,
        ack: ExtensionUploadAbandonAck,
    ) -> Result<(), ToolError> {
        let wire = self.upload_receipt_scope(owner, completion)?;
        let ExtensionOperation::AbandonUpload { stage } = &completion.operation else {
            return Err(unknown(
                "Upload abandon receipt came from another operation",
            ));
        };
        if ack.stage_id() != stage.stage_id() {
            return Err(unknown(
                "Upload abandon receipt changed its resource address",
            ));
        }
        let state = self
            .extension
            .get_mut(&(owner, browser.clone()))
            .ok_or_else(|| unknown("Upload resource owner retired before abandon"))?;
        if !matches!(state.uploads.entries.get(&stage.stage_id()),Some(Entry::Staged(known)) if known.wire_context()==&wire && same_staged(known,stage))
        {
            return Err(unknown(
                "Upload abandon cannot remove retained or foreign backing",
            ));
        }
        state.uploads.entries.remove(&stage.stage_id());
        Ok(())
    }
    pub(super) fn apply_upload_completion(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        completion: &cua_driver_core::browser::ExtensionOperationCompletion,
        recovered: ExtensionRecoveredOperation,
    ) -> Result<(), ToolError> {
        let browser = BrowserIdentity::of(provider, &completion.provider.generation)?;
        match recovered {
            ExtensionRecoveredOperation::UploadBegun(stage) => {
                if stage.completion_id() != completion.id {
                    return Err(unknown("Upload stage completion address mismatch"));
                }
                self.record_upload_stage(owner, &browser, completion, stage)
            }
            ExtensionRecoveredOperation::UploadChunkWritten(ack) => {
                let wire = self.upload_receipt_scope(owner, completion)?;
                let ExtensionOperation::WriteUploadChunk { stage, .. } = &completion.operation
                else {
                    return Err(unknown("Upload chunk receipt came from another operation"));
                };
                let known = self
                    .extension
                    .get(&(owner, browser.clone()))
                    .and_then(|state| state.uploads.entries.get(&stage.stage_id()));
                if ack.completion_id() != completion.id
                    || ack.stage_id() != stage.stage_id()
                    || !matches!(known, Some(Entry::Staged(_)))
                    || known.is_none_or(|known| known.wire() != &wire || !known.same_stage(stage))
                {
                    return Err(unknown(
                        "Upload chunk receipt lost its original stage custody",
                    ));
                }
                Ok(())
            }
            ExtensionRecoveredOperation::UploadRetained(retained) => {
                if retained.completion_id() != completion.id {
                    return Err(unknown("Upload retained completion address mismatch"));
                }
                self.record_upload_retained(owner, &browser, completion, retained)
            }
            ExtensionRecoveredOperation::UploadAbandoned(ack) => {
                if ack.completion_id() != completion.id {
                    return Err(unknown("Upload abandon completion address mismatch"));
                }
                self.record_upload_abandoned(owner, &browser, completion, ack)
            }
            _ => Err(unknown(
                "Non-upload result reached upload resource bookkeeping",
            )),
        }
    }
    pub(super) fn apply_upload_unknown(
        &mut self,
        owner: uuid::Uuid,
        provider: &Provider,
        completion: &cua_driver_core::browser::ExtensionOperationCompletion,
        custody: &cua_driver_core::browser::ExtensionKnownCustody,
    ) -> Result<(), ToolError> {
        let browser = BrowserIdentity::of(provider, &completion.provider.generation)?;
        // Positive capabilities inside Unknown are cleanup custody only. Nothing
        // here executes DOM, clears the original Unknown, or retries selection.
        if let Some(stage) = custody.upload_stage.clone() {
            self.record_upload_stage(owner, &browser, completion, stage)?;
        }
        if let Some(retained) = custody.upload_retained.clone() {
            self.record_upload_retained(owner, &browser, completion, retained)?;
        }
        if let Some(backing) = custody.upload_retained_backing.clone() {
            self.record_upload_retained_backing(owner, &browser, completion, backing)?;
        }
        if let Some(abandoned) = custody.upload_abandoned.clone() {
            self.record_upload_abandoned(owner, &browser, completion, abandoned)?;
        }
        Ok(())
    }
}

/// The original issued CallScope, held for this upload's whole observer. Typed
/// resource controls do not use raw CDP's logical-activation marker.
pub(in crate::browser) struct UploadControl {
    scope: CallScope,
}
impl UploadControl {
    pub(in crate::browser) async fn begin_upload(
        &self,
        claim: &ExtensionPhysicalClaim,
        files: &[cua_driver_core::browser::ExtensionUploadFile],
    ) -> Result<ExtensionUploadStage, cua_driver_core::browser::ExtensionProviderError> {
        self.scope
            .dispatch(self.scope.control.begin_upload(claim, files))
            .await
            .map_err(|error| *error)
    }
    pub(in crate::browser) async fn write_upload_chunk(
        &self,
        stage: &ExtensionUploadStage,
        index: u32,
        offset: u64,
        bytes: &[u8],
    ) -> Result<
        cua_driver_core::browser::ExtensionUploadChunkAck,
        cua_driver_core::browser::ExtensionProviderError,
    > {
        self.scope
            .dispatch(
                self.scope
                    .control
                    .write_upload_chunk(stage, index, offset, bytes),
            )
            .await
            .map_err(|error| *error)
    }
    pub(in crate::browser) async fn retain_upload_for_selection(
        &self,
        stage: &ExtensionUploadStage,
    ) -> Result<ExtensionRetainedUpload, cua_driver_core::browser::ExtensionProviderError> {
        self.scope
            .dispatch(self.scope.control.retain_upload_for_selection(stage))
            .await
            .map_err(|error| *error)
    }
    pub(in crate::browser) async fn abandon_upload(
        &self,
        stage: &ExtensionUploadStage,
    ) -> Result<ExtensionUploadAbandonAck, cua_driver_core::browser::ExtensionProviderError> {
        // Only the server's exact unexposed stage can be abandoned. This is
        // original cleanup custody, not admission for another effect or grant.
        self.scope
            .dispatch_retirement(self.scope.control.abandon_upload(stage))
            .await
    }
}
impl Tab {
    pub(in crate::browser) async fn upload_control(
        &self,
        invocation: &crate::InvocationContext<'_>,
    ) -> Result<UploadControl, ToolError> {
        let identity = self.identity()?;
        let claim = self
            .extension_claim
            .as_ref()
            .ok_or_else(|| failed("Upload requires its actual physical claim"))?;
        let mut ledger = self.cursor_host.lock().await;
        let lease = ledger
            .tabs
            .get(&identity)
            .ok_or_else(|| failed("Upload tab has no issued Host lease"))?;
        if lease.creator.owner != self.cursor_owner
            || matches!(lease.disposition, Disposition::Closing)
            || lease
                .extension
                .as_ref()
                .and_then(|state| state.claim.as_ref())
                .is_none_or(|known| {
                    known.claim_id() != claim.claim_id() || known.target_id() != claim.target_id()
                })
        {
            return Err(failed(
                "Upload tab no longer matches its actual live Host claim",
            ));
        }
        let origin = lease.origin;
        let scope = ledger.extension_context(
            self.cursor_owner,
            &self.provider,
            operation(invocation)?,
            self.cursor_epoch,
            CallTarget::Tab {
                origin,
                tab: Some(self.info.id.clone()),
            },
            false,
        )?;
        Ok(UploadControl { scope })
    }
}
