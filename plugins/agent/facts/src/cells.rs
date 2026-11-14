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

//! Durable Cell evidence; no value here represents interpreter or Host custody.
use crate::durable::{
    AgentStepLink, ApprovalId, ContentRef, FactId, ResourceRecovery, StepId, Terminal,
};
use crate::operation::{
    RecordedOperationReply, RecordedOperationResult, result_reference, same_outcome,
};
use crate::tool_call::{RejectionKind, ToolSettlement};
use crate::tools::ToolSemantics;
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, Receipt, RecoveryRef};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CellTransitionError {
    #[error("{0}")]
    Invalid(&'static str),
    #[error("{0}")]
    Conflict(&'static str),
}
impl From<&'static str> for CellTransitionError {
    fn from(reason: &'static str) -> Self {
        Self::Invalid(reason)
    }
}
impl From<CellTransitionError> for String {
    fn from(error: CellTransitionError) -> Self {
        error.to_string()
    }
}

#[derive(
    Clone,
    Copy,
    Debug,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    Hash,
    Serialize,
    Deserialize,
    schemars::JsonSchema,
)]
#[serde(try_from = "Uuid", into = "Uuid")]
pub struct CellId(Uuid);
impl CellId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
    pub fn for_agent(link: AgentStepLink, call: &str) -> Self {
        let mut input = Vec::with_capacity(56 + call.len());
        input.extend_from_slice(link.run.as_uuid().as_bytes());
        input.extend_from_slice(link.step.as_uuid().as_bytes());
        input.extend_from_slice(link.attempt.as_uuid().as_bytes());
        input.extend_from_slice(
            &u64::try_from(call.len())
                .expect("call length fits u64")
                .to_be_bytes(),
        );
        input.extend_from_slice(call.as_bytes());
        Self(cell_uuid(b"maka.agent.cell.parent.v1\0", &input))
    }
    pub fn for_external(
        run: crate::durable::RunId,
        key: crate::external_effects::ExternalEffectKey,
    ) -> Self {
        let mut input = [0; 48];
        input[..16].copy_from_slice(run.as_uuid().as_bytes());
        input[16..32].copy_from_slice(key.task.as_uuid().as_bytes());
        input[32..].copy_from_slice(key.operation.as_bytes());
        Self(cell_uuid(b"maka.external.cell.parent.v1\0", &input))
    }
    pub fn started_fact_id(self) -> FactId {
        FactId::try_from(cell_uuid(b"maka.cell.started.v1\0", self.0.as_bytes()))
            .expect("UUIDv8 is non-nil")
    }
    pub fn as_uuid(self) -> Uuid {
        self.0
    }
}
fn cell_uuid(domain: &[u8], value: &[u8]) -> Uuid {
    let mut bytes = domain.to_vec();
    bytes.extend_from_slice(value);
    let digest = crate::artifact::content_digest(&bytes);
    let mut id = u128::from_str_radix(&digest["sha256:".len()..][..32], 16)
        .expect("SHA256 hexadecimal digest")
        .to_be_bytes();
    id[6] = (id[6] & 0x0f) | 0x80;
    id[8] = (id[8] & 0x3f) | 0x80;
    Uuid::from_bytes(id)
}
impl Default for CellId {
    fn default() -> Self {
        Self::new()
    }
}
impl TryFrom<Uuid> for CellId {
    type Error = &'static str;
    fn try_from(id: Uuid) -> Result<Self, Self::Error> {
        if id.is_nil() {
            Err("nil Cell identity")
        } else {
            Ok(Self(id))
        }
    }
}
impl From<CellId> for Uuid {
    fn from(id: CellId) -> Self {
        id.0
    }
}
impl std::fmt::Display for CellId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CellOwner {
    Agent {
        link: AgentStepLink,
        call: String,
    },
    External {
        run: crate::durable::RunId,
        key: crate::external_effects::ExternalEffectKey,
    },
    Standalone {
        session: String,
    },
}
impl CellOwner {
    pub fn run(&self) -> Option<crate::durable::RunId> {
        match self {
            Self::Agent { link, .. } => Some(link.run),
            Self::External { run, .. } => Some(*run),
            Self::Standalone { .. } => None,
        }
    }
    pub fn cell_id(&self) -> Option<CellId> {
        match self {
            Self::Agent { link, call } => Some(CellId::for_agent(*link, call)),
            Self::External { run, key } => Some(CellId::for_external(*run, *key)),
            Self::Standalone { .. } => None,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionPublication {
    pub values: BTreeMap<String, ContentRef>,
    pub loaded_tools: Option<BTreeSet<String>>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CellEvent {
    VmCleanupUnconfirmed {
        cell: CellId,
        binding: Option<CellVmBinding>,
        diagnostic: String,
    },
    VmBound {
        cell: CellId,
        binding: CellVmBinding,
    },
    Started {
        cell: CellId,
        owner: CellOwner,
        source: ContentRef,
    },
    ChildPrepared {
        cell: CellId,
        operation: Uuid,
        name: String,
        semantics: ToolSemantics,
        input: ContentRef,
        resources: Vec<ResourceRecovery>,
    },
    ChildDisplayRecorded {
        cell: CellId,
        operation: Uuid,
        display: crate::durable::ToolDisplay,
    },
    ChildRejected {
        cell: CellId,
        operation: Uuid,
        reason: RejectionKind,
        diagnostic: String,
    },
    ChildApprovalRecorded {
        cell: CellId,
        operation: Uuid,
        approval: ApprovalId,
        input: ContentRef,
        resources: Vec<ResourceRecovery>,
    },
    ChildApprovalConsumed {
        cell: CellId,
        operation: Uuid,
        approval: ApprovalId,
    },
    ChildAdmitted {
        cell: CellId,
        operation: Uuid,
    },
    ChildBound {
        cell: CellId,
        operation: Uuid,
        reference: RecoveryRef,
    },
    ChildResultRecorded {
        cell: CellId,
        operation: Uuid,
        result: ContentRef,
        is_error: bool,
    },
    LocalChildReturned {
        cell: CellId,
        operation: Uuid,
        result: ContentRef,
        is_error: bool,
        settlement: ToolSettlement,
    },
    ChildObserved {
        cell: CellId,
        operation: Uuid,
        reply: RecordedOperationReply,
    },
    /// Original worker output and private draft evidence, not session publication.
    Completed {
        cell: CellId,
        result: ContentRef,
        publication: SessionPublication,
    },
    Interrupted {
        cell: CellId,
        report: ContentRef,
    },
    /// Explicit Run final-result acceptance; publications require this exact batch.
    ResultAccepted {
        cell: CellId,
    },
    SessionValuePublished {
        cell: CellId,
        key: String,
        value: ContentRef,
    },
    LoadedToolsPublished {
        cell: CellId,
        names: BTreeSet<String>,
    },
    FinalNotificationQueued {
        cell: CellId,
        notification: FactId,
        content: ContentRef,
    },
    NotificationQueued {
        cell: CellId,
        notification: FactId,
        content: ContentRef,
    },
    NotificationConsumed {
        cell: CellId,
        notification: FactId,
        step: StepId,
    },
}
impl CellEvent {
    pub fn cell(&self) -> CellId {
        match self {
            Self::Started { cell, .. }
            | Self::VmCleanupUnconfirmed { cell, .. }
            | Self::VmBound { cell, .. }
            | Self::ChildDisplayRecorded { cell, .. }
            | Self::ChildRejected { cell, .. }
            | Self::ChildPrepared { cell, .. }
            | Self::ChildApprovalRecorded { cell, .. }
            | Self::ChildApprovalConsumed { cell, .. }
            | Self::ChildAdmitted { cell, .. }
            | Self::ChildBound { cell, .. }
            | Self::ChildObserved { cell, .. }
            | Self::ChildResultRecorded { cell, .. }
            | Self::LocalChildReturned { cell, .. }
            | Self::Completed { cell, .. }
            | Self::Interrupted { cell, .. }
            | Self::ResultAccepted { cell }
            | Self::SessionValuePublished { cell, .. }
            | Self::LoadedToolsPublished { cell, .. }
            | Self::FinalNotificationQueued { cell, .. }
            | Self::NotificationQueued { cell, .. }
            | Self::NotificationConsumed { cell, .. } => *cell,
        }
    }
    pub fn is_admission(&self) -> bool {
        matches!(
            self,
            Self::Started { .. }
                | Self::VmBound { .. }
                | Self::ChildPrepared { .. }
                | Self::ChildAdmitted { .. }
                | Self::ChildApprovalConsumed { .. }
        )
    }
    pub fn is_late(&self) -> bool {
        matches!(
            self,
            Self::ChildDisplayRecorded { .. }
                | Self::VmCleanupUnconfirmed { .. }
                | Self::ChildRejected { .. }
                | Self::ChildApprovalRecorded { .. }
                | Self::ChildBound { .. }
                | Self::ChildObserved { .. }
                | Self::ChildResultRecorded { .. }
                | Self::LocalChildReturned { .. }
                | Self::Completed { .. }
                | Self::Interrupted { .. }
                | Self::NotificationQueued { .. }
        )
    }
    pub fn content_refs(&self) -> Vec<&ContentRef> {
        match self {
            Self::VmBound { binding, .. } => vec![&binding.descriptor],
            Self::VmCleanupUnconfirmed { binding, .. } => binding
                .as_ref()
                .map(|b| vec![&b.descriptor])
                .unwrap_or_default(),
            Self::Started { source, .. } => vec![source],
            Self::ChildPrepared {
                input, resources, ..
            }
            | Self::ChildApprovalRecorded {
                input, resources, ..
            } => {
                let mut refs = vec![input];
                refs.extend(resources.iter().filter_map(|r| match r {
                    ResourceRecovery::Reference { descriptor } => Some(descriptor),
                    _ => None,
                }));
                refs
            }
            Self::Completed {
                result,
                publication,
                ..
            } => {
                let mut refs = vec![result];
                refs.extend(publication.values.values());
                refs
            }
            Self::LocalChildReturned { result, .. } | Self::ChildResultRecorded { result, .. } => {
                vec![result]
            }
            Self::ChildObserved { reply, .. } => result_reference(reply).into_iter().collect(),
            Self::Interrupted { report, .. } => vec![report],
            Self::SessionValuePublished { value, .. } => vec![value],
            Self::NotificationQueued { content, .. }
            | Self::FinalNotificationQueued { content, .. } => vec![content],
            _ => vec![],
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CellChild {
    pub name: String,
    pub display: Option<crate::durable::ToolDisplay>,
    pub semantics: ToolSemantics,
    pub input: ContentRef,
    pub resources: Vec<ResourceRecovery>,
    pub reference: Option<RecoveryRef>,
    pub reply: Option<RecordedOperationReply>,
    pub local_result: Option<LocalCellResult>,
    pub provider_result: Option<LocalCellResult>,
    pub approvals: BTreeMap<ApprovalId, bool>,
    pub admitted: bool,
    pub rejected: Option<CellRejection>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CellStatus {
    Running,
    Completed {
        result: ContentRef,
        publication: SessionPublication,
        accepted: bool,
    },
    Interrupted {
        report: ContentRef,
    },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CellVmBinding {
    pub runtime: String,
    pub version: u32,
    pub descriptor: ContentRef,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CellRejection {
    pub reason: RejectionKind,
    pub diagnostic: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CellView {
    pub id: CellId,
    pub owner: CellOwner,
    pub source: ContentRef,
    pub vm: Option<CellVmBinding>,
    pub vm_uncertainty: Option<String>,
    pub status: CellStatus,
    pub children: BTreeMap<Uuid, CellChild>,
    pub notifications: BTreeSet<FactId>,
    pub final_notification: Option<FactId>,
}
impl CellView {
    pub fn started(event: &CellEvent) -> Result<Self, CellTransitionError> {
        let CellEvent::Started {
            cell,
            owner,
            source,
        } = event
        else {
            return Err("CellStarted required".into());
        };
        if owner.cell_id().is_some_and(|id| *cell != id) {
            return Err(CellTransitionError::Conflict(
                "Cell identity differs from its original parent",
            ));
        }
        Ok(Self {
            id: *cell,
            owner: owner.clone(),
            source: source.clone(),
            vm: None,
            vm_uncertainty: None,
            status: CellStatus::Running,
            children: BTreeMap::new(),
            notifications: BTreeSet::new(),
            final_notification: None,
        })
    }
    pub fn finish_requested(&self) -> bool {
        self.children
            .values()
            .any(|child| child.semantics == ToolSemantics::FinishTurn && child.known_success())
    }
    /// Uncertainty is not the ordinary interval between prepare and return.
    pub fn blocks_effect_admission(&self) -> bool {
        if self.vm_uncertainty.is_some() {
            return true;
        }
        self.children.values().any(|child| {
            if child
                .local_result
                .as_ref()
                .is_some_and(|result| result.settlement == ToolSettlement::Unknown)
            {
                return true;
            }
            match child.reply.as_ref().map(|reply| &reply.receipt) {
                Some(Receipt::NotRecorded | Receipt::Unavailable { .. }) => true,
                Some(Receipt::Recorded {
                    outcome: OperationOutcome::Unknown { .. },
                    ..
                }) => true,
                Some(Receipt::Recorded {
                    cleanup: OperationCleanup::Failed { .. },
                    ..
                }) => true,
                Some(Receipt::Recorded {
                    outcome:
                        OperationOutcome::Returned { .. } | OperationOutcome::NotExecuted { .. },
                    cleanup,
                }) => !matches!(cleanup, OperationCleanup::Confirmed),
                _ => matches!(self.status, CellStatus::Interrupted { .. }) && !child.known(),
            }
        })
    }
    pub fn physical_cleanup_confirmed(&self) -> bool {
        !matches!(self.status, CellStatus::Running)
            && self.vm_uncertainty.is_none()
            && self
                .children
                .values()
                .all(CellChild::physical_cleanup_confirmed)
    }
    pub fn has_unsettled_effects(&self) -> bool {
        !self.physical_cleanup_confirmed()
            || self.children.values().any(|child| !child.known())
            || self.blocks_effect_admission()
    }
    pub fn blocks_session_retirement(&self, terminal: Option<&Terminal>) -> bool {
        if self.owner.run().is_none() {
            return self.pending();
        }
        match terminal {
            Some(Terminal::Completed) => self.settlement_pending(),
            Some(Terminal::Cancelled | Terminal::Failed) => self.has_unsettled_effects(),
            None => self.pending(),
        }
    }
    pub fn settlement_pending(&self) -> bool {
        matches!(
            self.status,
            CellStatus::Running
                | CellStatus::Completed {
                    accepted: false,
                    ..
                }
        ) || self.children.values().any(|child| !child.known())
            || self.blocks_effect_admission()
    }
    pub fn pending(&self) -> bool {
        self.settlement_pending()
            || (matches!(self.owner, CellOwner::Agent { .. })
                && (!self.notifications.is_empty()
                    || (matches!(self.status, CellStatus::Interrupted { .. })
                        && self.final_notification.is_none())))
    }
    pub fn apply(&mut self, event: &CellEvent) -> Result<(), CellTransitionError> {
        if self.id != event.cell() {
            return Err("Cell identity mismatch".into());
        }
        match event {
            CellEvent::VmCleanupUnconfirmed {
                binding,
                diagnostic,
                ..
            } => {
                if self.vm.as_ref() != binding.as_ref() {
                    return Err(CellTransitionError::Conflict(
                        "VM uncertainty belongs to another original binding",
                    ));
                }
                if matches!(self.status, CellStatus::Running) {
                    self.vm_uncertainty = Some(diagnostic.clone());
                }
            }
            CellEvent::VmBound { binding, .. } => {
                if !matches!(self.status, CellStatus::Running) || !self.children.is_empty() {
                    return Err("VM binding must precede every script effect".into());
                }
                if self.vm.as_ref().is_some_and(|prior| prior != binding) {
                    return Err(CellTransitionError::Conflict(
                        "original Cell VM binding changed",
                    ));
                }
                self.vm = Some(binding.clone());
            }
            CellEvent::Started { .. } => return Err("Cell already started".into()),
            CellEvent::ChildPrepared {
                operation,
                name,
                semantics,
                input,
                resources,
                ..
            } => {
                if !matches!(self.status, CellStatus::Running)
                    || self.children.contains_key(operation)
                {
                    return Err("Cell child admission conflict".into());
                }
                self.children.insert(
                    *operation,
                    CellChild {
                        name: name.clone(),
                        display: None,
                        semantics: *semantics,
                        input: input.clone(),
                        resources: resources.clone(),
                        reference: None,
                        reply: None,
                        local_result: None,
                        provider_result: None,
                        approvals: BTreeMap::new(),
                        admitted: false,
                        rejected: None,
                    },
                );
            }
            CellEvent::ChildDisplayRecorded {
                operation, display, ..
            } => {
                display.validate().map_err(CellTransitionError::from)?;
                let child = self
                    .children
                    .get_mut(operation)
                    .ok_or("Cell child not prepared")?;
                if child
                    .display
                    .as_ref()
                    .is_some_and(|original| original != display)
                {
                    return Err(CellTransitionError::Conflict("Cell child display changed"));
                }
                child.display = Some(display.clone());
            }
            CellEvent::ChildRejected {
                operation,
                reason,
                diagnostic,
                ..
            } => {
                let child = self
                    .children
                    .get_mut(operation)
                    .ok_or("Cell child not prepared")?;
                if child.admitted || child.reference.is_some() || child.local_result.is_some() {
                    return Err("admitted Cell child cannot become a pre-admission refusal".into());
                }
                let rejection = CellRejection {
                    reason: *reason,
                    diagnostic: diagnostic.clone(),
                };
                if child
                    .rejected
                    .as_ref()
                    .is_some_and(|prior| prior != &rejection)
                {
                    return Err(CellTransitionError::Conflict("Cell child refusal changed"));
                }
                child.rejected = Some(rejection);
            }
            CellEvent::ChildApprovalRecorded {
                operation,
                approval,
                input,
                resources,
                ..
            } => {
                let child = self
                    .children
                    .get_mut(operation)
                    .ok_or("Cell child not prepared")?;
                if child.known()
                    || child.admitted
                    || child.approvals.contains_key(approval)
                    || child.input != *input
                    || child.resources != *resources
                {
                    return Err("Cell approval does not match original child obligation".into());
                }
                child.approvals.insert(*approval, false);
            }
            CellEvent::ChildApprovalConsumed {
                operation,
                approval,
                ..
            } => {
                let child = self
                    .children
                    .get_mut(operation)
                    .ok_or("Cell child not prepared")?;
                if child.admitted || child.known() {
                    return Err("Cell approval not available for original child admission".into());
                }
                let consumed = child
                    .approvals
                    .get_mut(approval)
                    .ok_or("Cell approval not recorded")?;
                if *consumed {
                    return Err("Cell approval already consumed".into());
                }
                *consumed = true;
            }
            CellEvent::ChildAdmitted { operation, .. } => {
                if self.finish_requested() {
                    return Err("Cell finish outcome prevents fresh child admission".into());
                }
                let child = self
                    .children
                    .get_mut(operation)
                    .ok_or("Cell child not prepared")?;
                if !matches!(self.status, CellStatus::Running)
                    || child.admitted
                    || child.known()
                    || child.approvals.values().any(|consumed| !consumed)
                {
                    return Err("Cell child cannot be admitted".into());
                }
                child.admitted = true;
            }
            CellEvent::ChildResultRecorded {
                operation,
                result,
                is_error,
                ..
            } => {
                let child = self
                    .children
                    .get_mut(operation)
                    .ok_or("Cell child not prepared")?;
                if child.reference.is_none() || !child.known() {
                    return Err("Cell Host result has no known original provider outcome".into());
                }
                let evidence = LocalCellResult {
                    result: result.clone(),
                    is_error: *is_error,
                    settlement: match child.reply.as_ref().map(|r| &r.receipt) {
                        Some(Receipt::Recorded {
                            outcome: OperationOutcome::NotExecuted { .. },
                            ..
                        }) => ToolSettlement::Rejected,
                        Some(Receipt::Recorded {
                            outcome: OperationOutcome::Returned { result },
                            ..
                        }) => {
                            if result.is_error() {
                                ToolSettlement::Failed
                            } else {
                                ToolSettlement::Returned
                            }
                        }
                        _ => return Err("Cell Host result has no known original outcome".into()),
                    },
                };
                if child
                    .provider_result
                    .as_ref()
                    .is_some_and(|prior| prior != &evidence)
                {
                    return Err(CellTransitionError::Conflict(
                        "Cell known Host result changed",
                    ));
                }
                child.provider_result = Some(evidence);
            }
            CellEvent::LocalChildReturned {
                operation,
                result,
                is_error,
                settlement,
                ..
            } => {
                let child = self
                    .children
                    .get_mut(operation)
                    .ok_or("Cell child not prepared")?;
                if !child.admitted {
                    return Err("local Cell child not admitted".into());
                }
                if child.reference.is_some() {
                    return Err("Host operation cannot be replaced with local evidence".into());
                }
                let evidence = LocalCellResult {
                    result: result.clone(),
                    is_error: *is_error,
                    settlement: *settlement,
                };
                if let Some(prior) = &child.local_result
                    && prior.settlement != ToolSettlement::Unknown
                {
                    if evidence.settlement == ToolSettlement::Unknown {
                        return Ok(());
                    }
                    if prior != &evidence {
                        return Err(CellTransitionError::Conflict(
                            "known local Cell result changed",
                        ));
                    }
                }
                child.local_result = Some(evidence);
            }
            CellEvent::ChildBound {
                operation,
                reference,
                ..
            } => {
                let child = self
                    .children
                    .get_mut(operation)
                    .ok_or("Cell child not prepared")?;
                if child.local_result.is_some() || child.rejected.is_some() {
                    return Err("local Cell result cannot become Host operation".into());
                }
                if child.reference.as_ref().is_some_and(|r| r != reference) {
                    return Err(CellTransitionError::Conflict(
                        "original Cell RecoveryRef changed",
                    ));
                }
                child.reference = Some(reference.clone());
            }
            CellEvent::ChildObserved {
                operation, reply, ..
            } => {
                let child = self
                    .children
                    .get_mut(operation)
                    .ok_or("Cell child not prepared")?;
                if child.reference.as_ref() != Some(&reply.reference) {
                    return Err("Cell child reply differs from original RecoveryRef".into());
                }
                child.reply = Some(match &child.reply {
                    Some(prior) => join_reply(prior, reply)?,
                    None => reply.clone(),
                });
            }
            CellEvent::Completed {
                result,
                publication,
                ..
            } => {
                if !matches!(self.status, CellStatus::Running) || self.vm.is_none() {
                    return Err("Cell already terminal".into());
                }
                if self.children.values().any(|child| !child.known())
                    || self.blocks_effect_admission()
                {
                    return Err("Cell has unresolved child effects".into());
                }
                self.status = CellStatus::Completed {
                    result: result.clone(),
                    publication: publication.clone(),
                    accepted: false,
                };
            }
            CellEvent::Interrupted { report, .. } => {
                if !matches!(self.status, CellStatus::Running) {
                    return Err("Cell already terminal".into());
                }
                self.status = CellStatus::Interrupted {
                    report: report.clone(),
                };
                self.vm_uncertainty = None;
            }
            CellEvent::ResultAccepted { .. } => {
                let CellStatus::Completed { accepted, .. } = &mut self.status else {
                    return Err("only normal Cell completion can publish data".into());
                };
                if *accepted {
                    return Err("Cell final result already accepted".into());
                }
                *accepted = true;
            }
            CellEvent::SessionValuePublished { key, value, .. } => {
                let CellStatus::Completed {
                    publication,
                    accepted: true,
                    ..
                } = &self.status
                else {
                    return Err("Cell final result not accepted".into());
                };
                if publication.values.get(key) != Some(value) {
                    return Err("Cell value differs from original completion draft".into());
                }
            }
            CellEvent::LoadedToolsPublished { names, .. } => {
                let CellStatus::Completed {
                    publication,
                    accepted: true,
                    ..
                } = &self.status
                else {
                    return Err("Cell final result not accepted".into());
                };
                if publication.loaded_tools.as_ref() != Some(names) {
                    return Err("Cell loaded tools differ from original completion draft".into());
                }
            }
            CellEvent::FinalNotificationQueued { notification, .. } => {
                if self.final_notification.is_some() {
                    return Err(CellTransitionError::Conflict(
                        "Cell final notification already queued",
                    ));
                }
                if !matches!(self.owner, CellOwner::Agent { .. })
                    || self.children.values().any(|child| !child.known())
                    || self.blocks_effect_admission()
                    || !matches!(
                        self.status,
                        CellStatus::Completed { accepted: true, .. }
                            | CellStatus::Interrupted { .. }
                    )
                {
                    return Err("Cell final notification requires accepted completion or known interruption".into());
                }
                if !self.notifications.insert(*notification) {
                    return Err(CellTransitionError::Conflict(
                        "Cell notification identity reused",
                    ));
                }
                self.final_notification = Some(*notification);
            }
            CellEvent::NotificationQueued { notification, .. } => {
                if !self.notifications.insert(*notification) {
                    return Err("Cell notification already queued".into());
                }
            }
            CellEvent::NotificationConsumed { notification, .. } => {
                if !self.notifications.remove(notification) {
                    return Err("Cell notification absent or already consumed".into());
                }
            }
        }
        Ok(())
    }
}
pub const CELL_NOTIFICATION_SCHEMA_VERSION: u32 = 1;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CellNotification {
    pub schema_version: u32,
    pub body: CellNotificationBody,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CellNotificationBody {
    Text { text: String },
    Completed { result: ContentRef },
    Interrupted { report: ContentRef },
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CellPriorOutput {
    pub content: Vec<CellOutput>,
}
/// The interpreter heap and bindings do not exist in this report and cannot be restored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CellInterruption {
    pub cell: CellId,
    pub diagnostic: String,
    pub children: BTreeMap<Uuid, CellChild>,
    pub prior_output: Option<CellPriorOutput>,
}

impl CellChild {
    pub fn known_success(&self) -> bool {
        self.rejected.is_none()
            && self
                .local_result
                .as_ref()
                .or(self.provider_result.as_ref())
                .is_some_and(|result| {
                    result.settlement == ToolSettlement::Returned && !result.is_error
                })
    }
    pub fn physical_cleanup_confirmed(&self) -> bool {
        self.rejected.is_some()
            || self
                .local_result
                .as_ref()
                .is_some_and(|result| result.settlement != ToolSettlement::Unknown)
            || matches!(
                self.reply.as_ref().map(|reply| &reply.receipt),
                Some(Receipt::Recorded {
                    cleanup: OperationCleanup::Confirmed,
                    ..
                })
            )
    }
    pub fn known(&self) -> bool {
        self.rejected.is_some()
            || self
                .local_result
                .as_ref()
                .is_some_and(|result| result.settlement != ToolSettlement::Unknown)
            || matches!(
                self.reply.as_ref().map(|r| &r.receipt),
                Some(Receipt::Recorded {
                    outcome: OperationOutcome::Returned { .. }
                        | OperationOutcome::NotExecuted { .. },
                    ..
                })
            )
    }
}
fn join_reply(
    prior: &RecordedOperationReply,
    next: &RecordedOperationReply,
) -> Result<RecordedOperationReply, CellTransitionError> {
    if prior.reference != next.reference {
        return Err("Cell original operation reference changed".into());
    }
    let Receipt::Recorded {
        outcome: old,
        cleanup: old_cleanup,
    } = &prior.receipt
    else {
        return Ok(next.clone());
    };
    let Receipt::Recorded {
        outcome: new,
        cleanup: new_cleanup,
    } = &next.receipt
    else {
        return Ok(prior.clone());
    };
    let old_known = matches!(
        old,
        OperationOutcome::Returned { .. } | OperationOutcome::NotExecuted { .. }
    );
    let new_known = matches!(
        new,
        OperationOutcome::Returned { .. } | OperationOutcome::NotExecuted { .. }
    );
    if old_known
        && new_known
        && !same_outcome(old, new)
            .map_err(|_| CellTransitionError::Invalid("Cell operation result cannot be compared"))?
    {
        return Err(CellTransitionError::Conflict(
            "Cell known provider outcome changed",
        ));
    }
    let next_uses_reference = matches!(
        new,
        OperationOutcome::Returned {
            result: RecordedOperationResult::Referenced { .. },
        }
    );
    let outcome = if old_known && !next_uses_reference
        || matches!(old, OperationOutcome::Unknown { .. }) && !new_known
    {
        old.clone()
    } else {
        new.clone()
    };
    let cleanup = match (old_cleanup, new_cleanup) {
        (OperationCleanup::Confirmed, _) => old_cleanup.clone(),
        (
            OperationCleanup::Failed { .. },
            OperationCleanup::Unconfirmed | OperationCleanup::Failed { .. },
        ) => old_cleanup.clone(),
        _ => new_cleanup.clone(),
    };
    Ok(RecordedOperationReply {
        reference: prior.reference.clone(),
        receipt: Receipt::Recorded { outcome, cleanup },
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LocalCellResult {
    pub result: ContentRef,
    pub is_error: bool,
    pub settlement: ToolSettlement,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CellReply {
    pub cell: CellId,
    pub state: CellReplyState,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub observation: serde_json::Value,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CellReplyState {
    Running,
    Completed { result: ContentRef },
    Interrupted { report: ContentRef },
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum CellOutput {
    Text {
        text: String,
    },
    Image {
        image: crate::tool_output::ImageOutput,
    },
    Media {
        content: crate::capability::ContentBlock,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<crate::tool_output::ImageDetail>,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum CellObservation {
    Running {
        cell_id: CellId,
        content: Vec<CellOutput>,
    },
    Completed {
        cell_id: CellId,
        content: Vec<CellOutput>,
        result: Value,
    },
    Interrupted {
        cell_id: CellId,
        report: Value,
    },
}

/// Shared Cell child result body. The surrounding ToolReturn owns exact media
/// manifests; standalone plain tools may omit a model projection entirely.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CellReturnedResult {
    pub output: crate::tool_output::ToolOutput,
    pub projection: Option<crate::tool_output::DurableToolProjection>,
    pub is_error: bool,
}

/// Local and historical Cell returns use the original body. Host returns can
/// share the same stored operation envelope as ordinary Agent tools.
#[derive(Serialize, Deserialize)]
#[serde(untagged)]
pub enum StoredCellReturn {
    Operation(Box<crate::tool_output::StoredOperationReturn>),
    Inline(CellReturnedResult),
}

impl StoredCellReturn {
    pub fn is_error(&self) -> bool {
        match self {
            Self::Operation(body) => body.is_error,
            Self::Inline(body) => body.is_error,
        }
    }
}
