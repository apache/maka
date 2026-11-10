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

//! Deterministic external Host-effect projections; canonical input is agent_facts.
use crate::{fold::RunView, store::invalid};
use maka_agent_facts::{durable::*, external_effects::*};
use maka_event_log::StoreError;
use maka_plugin_core::operation::{
    OperationCleanup, OperationOutcome, OperationReply, Receipt, RecoveryRef,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

mod sql;
pub(crate) use sql::{
    ReadDescriptor, ReadEffect, load_run, native_source_pending, persist, read_descriptor,
    read_original, replay, verify_native_source,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalEffect {
    pub descriptor: ContentRef,
    pub display: Option<maka_agent_facts::durable::ToolDisplay>,
    pub admitted: bool,
    pub admission_approval: Option<ApprovalId>,
    pub rejected: Option<ExternalRejection>,
    pub reference: Option<RecoveryRef>,
    pub observation: Option<OperationReply>,
    pub returned: Option<ContentRef>,
    pub cleanup: OperationCleanup,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalRejection {
    pub kind: maka_agent_facts::tool_call::RejectionKind,
    pub diagnostic: String,
}

impl ExternalEffect {
    pub fn known(&self) -> bool {
        if self.rejected.is_some() {
            return true;
        }
        if self.reference.is_some() {
            matches!(
                self.observation.as_ref().map(|o| &o.receipt),
                Some(Receipt::Recorded {
                    outcome: OperationOutcome::Returned { .. }
                        | OperationOutcome::NotExecuted { .. },
                    ..
                })
            )
        } else {
            self.returned.is_some()
        }
    }

    pub fn pending(&self) -> bool {
        if self.rejected.is_some() {
            return false;
        }
        !self.known() || self.returned.is_none() || self.cleanup != OperationCleanup::Confirmed
    }

    fn prepared(descriptor: &ContentRef) -> Self {
        Self {
            descriptor: descriptor.clone(),
            display: None,
            admitted: false,
            admission_approval: None,
            rejected: None,
            reference: None,
            observation: None,
            returned: None,
            cleanup: OperationCleanup::Unconfirmed,
        }
    }

    fn apply(&mut self, event: &ExternalEffectEvent) -> Result<(), StoreError> {
        match event {
            ExternalEffectEvent::Prepared { descriptor, .. } => {
                if self.descriptor != *descriptor {
                    return Err(StoreError::EventConflict);
                }
            }
            ExternalEffectEvent::DisplayRecorded { display, .. } => {
                display.validate().map_err(invalid)?;
                if self
                    .display
                    .as_ref()
                    .is_some_and(|original| original != display)
                {
                    return Err(StoreError::EventConflict);
                }
                self.display = Some(display.clone());
            }
            ExternalEffectEvent::Rejected {
                rejection_kind,
                diagnostic,
                ..
            } => {
                if self.admitted {
                    return Err(invalid(
                        "admitted external effect cannot be rejected before admission",
                    ));
                }
                let rejection = ExternalRejection {
                    kind: *rejection_kind,
                    diagnostic: diagnostic.clone(),
                };
                if self.rejected.as_ref().is_some_and(|old| old != &rejection) {
                    return Err(StoreError::EventConflict);
                }
                self.rejected = Some(rejection);
            }
            ExternalEffectEvent::Admitted { approval, .. } => {
                if self.rejected.is_some() {
                    return Err(invalid("rejected external effect cannot be admitted"));
                }
                if self.admitted {
                    return Err(invalid("external Host effect is already admitted"));
                }
                self.admitted = true;
                self.admission_approval = *approval;
            }
            ExternalEffectEvent::Bound { reference, .. } => {
                self.require_admitted()?;
                reference.validate().map_err(|e| invalid(e.to_string()))?;
                if self.reference.as_ref().is_some_and(|old| old != reference) {
                    return Err(StoreError::EventConflict);
                }
                // A query's actual return cannot later become a mutation receipt.
                if self.reference.is_none() && self.returned.is_some() {
                    return Err(invalid(
                        "external Host return already has no operation reference",
                    ));
                }
                self.reference = Some(reference.clone());
            }
            ExternalEffectEvent::Observed { observation, .. } => {
                self.require_admitted()?;
                if self.reference.as_ref() != Some(&observation.reference) {
                    return Err(invalid(
                        "external observation differs from the bound original operation",
                    ));
                }
                let receipt = join_receipt(
                    self.observation.as_ref().map(|o| &o.receipt),
                    &observation.receipt,
                )?;
                if let Receipt::Recorded { cleanup, .. } = &receipt {
                    self.cleanup = join_cleanup(&self.cleanup, cleanup);
                }
                self.observation = Some(OperationReply {
                    reference: observation.reference.clone(),
                    receipt,
                });
            }
            ExternalEffectEvent::Returned { output, .. } => {
                self.require_admitted()?;
                if self.cleanup != OperationCleanup::Confirmed {
                    return Err(invalid(
                        "external Host return requires confirmed physical cleanup",
                    ));
                }
                if self.reference.is_some() && !self.known() {
                    return Err(invalid(
                        "unknown original operation cannot become a local failure return",
                    ));
                }
                if self.returned.as_ref().is_some_and(|old| old != output) {
                    return Err(StoreError::EventConflict);
                }
                self.returned = Some(output.clone());
            }
            ExternalEffectEvent::CleanupObserved { cleanup, .. } => {
                self.require_admitted()?;
                self.cleanup = join_cleanup(&self.cleanup, cleanup);
            }
        }
        Ok(())
    }

    fn require_admitted(&self) -> Result<(), StoreError> {
        if !self.admitted {
            return Err(invalid("external Host evidence has no original admission"));
        }
        Ok(())
    }
}

pub(crate) fn apply(view: &mut RunView, event: &ExternalEffectEvent) -> Result<(), StoreError> {
    let key = event.key();
    let task = view
        .external
        .as_ref()
        .ok_or_else(|| invalid("external Host effect has no task"))?;
    if task.task != key.task || !task.admitted {
        return Err(invalid(
            "external Host effect belongs to no original admitted task",
        ));
    }
    if event.is_admission() {
        if task.closed.is_some() {
            return Err(invalid("closed external task cannot admit Host work"));
        }
        if view
            .blockers
            .values()
            .any(|b| b.decision.is_none() && b.resolved_by.is_none())
        {
            return Err(invalid("external task has an active blocker"));
        }
    }
    fold(
        &mut view.external.as_mut().expect("validated task").effects,
        event,
    )
}

fn fold(
    effects: &mut BTreeMap<Uuid, ExternalEffect>,
    event: &ExternalEffectEvent,
) -> Result<(), StoreError> {
    if event.key().operation.is_nil() {
        return Err(invalid("nil external Host operation identity"));
    }
    for reference in event.content_refs() {
        reference.validate().map_err(invalid)?;
    }
    let operation = event.key().operation;
    if let ExternalEffectEvent::Prepared { descriptor, .. } = event {
        if let Some(current) = effects.get(&operation) {
            if current.descriptor != *descriptor {
                return Err(StoreError::EventConflict);
            }
        } else {
            effects.insert(operation, ExternalEffect::prepared(descriptor));
        }
    } else {
        effects
            .get_mut(&operation)
            .ok_or_else(|| invalid("external Host effect has not been prepared"))?
            .apply(event)?;
    }
    Ok(())
}

fn known(outcome: &OperationOutcome) -> bool {
    matches!(
        outcome,
        OperationOutcome::Returned { .. } | OperationOutcome::NotExecuted { .. }
    )
}

pub(crate) fn join_cleanup(old: &OperationCleanup, new: &OperationCleanup) -> OperationCleanup {
    match (old, new) {
        (OperationCleanup::Confirmed, _) | (_, OperationCleanup::Confirmed) => {
            OperationCleanup::Confirmed
        }
        (OperationCleanup::Failed { .. }, _) => old.clone(),
        (_, OperationCleanup::Failed { .. }) => new.clone(),
        _ => OperationCleanup::Unconfirmed,
    }
}

pub(crate) fn join_receipt(old: Option<&Receipt>, new: &Receipt) -> Result<Receipt, StoreError> {
    let Some(old) = old else {
        return Ok(new.clone());
    };
    match (old, new) {
        (
            Receipt::Recorded {
                outcome: old_outcome,
                cleanup: old_cleanup,
            },
            Receipt::Recorded {
                outcome: new_outcome,
                cleanup: new_cleanup,
            },
        ) => {
            if known(old_outcome) && known(new_outcome) && old_outcome != new_outcome {
                return Err(StoreError::EventConflict);
            }
            let outcome = if known(old_outcome)
                || matches!(new_outcome, OperationOutcome::Unresolved)
                || matches!(
                    (old_outcome, new_outcome),
                    (
                        OperationOutcome::Unknown { .. },
                        OperationOutcome::Unknown { .. }
                    )
                ) {
                old_outcome.clone()
            } else {
                new_outcome.clone()
            };
            Ok(Receipt::Recorded {
                outcome,
                cleanup: join_cleanup(old_cleanup, new_cleanup),
            })
        }
        (Receipt::Recorded { .. }, _) | (Receipt::NotRecorded, Receipt::Unavailable { .. }) => {
            Ok(old.clone())
        }
        (_, Receipt::Recorded { .. } | Receipt::NotRecorded) => Ok(new.clone()),
        (Receipt::Unavailable { .. }, Receipt::Unavailable { .. }) => Ok(old.clone()),
    }
}
