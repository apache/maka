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

//! One publication obligation for the original closed external task.
use crate::{Change, fold::RunView, store::invalid};
use maka_agent_facts::{durable::*, external_publication::*};
use maka_event_log::StoreError;
use maka_plugin_core::operation::{
    OperationCleanup, OperationOutcome, OperationReply, OperationResult, Receipt, RecoveryRef,
};
use maka_sandbox::workspace::PermissionBasis;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

mod sql;
pub(crate) use sql::{ReadItem, ReadPublication, load_run, persist, replay};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalPublication {
    pub id: ExternalPublicationId,
    pub task: ExternalTaskId,
    pub source: ContentRef,
    pub manifest: Option<ContentRef>,
    pub item_count: Option<u64>,
    pub admitted: u64,
    pub settled: u64,
    pub abandoned: bool,
    #[serde(default)]
    pub items: BTreeMap<u64, PublicationItem>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationItem {
    pub key: ExternalPublicationKey,
    pub basis: PermissionBasis,
    pub prevention: Option<String>,
    pub original: Option<RecoveryRef>,
    pub observation: Option<OperationReply>,
    pub outcome: Option<ExternalPublicationOutcome>,
    pub cleanup: OperationCleanup,
}
impl PublicationItem {
    pub fn known(&self) -> bool {
        self.outcome.is_some_and(ExternalPublicationOutcome::known)
    }
    pub fn settled(&self) -> bool {
        self.known() && self.cleanup == OperationCleanup::Confirmed
    }
    fn retained(&self) -> bool {
        !self.settled() || self.outcome != Some(ExternalPublicationOutcome::Applied)
    }
}
impl ExternalPublication {
    pub fn settled(&self) -> bool {
        self.abandoned || self.item_count == Some(self.settled)
    }
    pub fn quiescent(&self) -> bool {
        self.admitted == self.settled
            || self.settled.checked_add(1) == Some(self.admitted)
                && self
                    .items
                    .get(&self.settled)
                    .is_some_and(|item| item.cleanup == OperationCleanup::Confirmed)
    }
    pub fn unknown(&self) -> bool {
        self.items.values().any(|item| !item.known())
    }
    pub fn applied(&self) -> bool {
        let Some(count) = self.item_count else {
            return false;
        };
        !self.abandoned
            && self.admitted == count
            && self
                .items
                .values()
                .all(|item| item.outcome == Some(ExternalPublicationOutcome::Applied))
            && (self.settled == count
                || self.settled.checked_add(1) == Some(count)
                    && self.items.get(&self.settled).is_some_and(|item| {
                        item.outcome == Some(ExternalPublicationOutcome::Applied)
                    }))
    }
}

pub(crate) fn apply(
    view: &mut RunView,
    event: &ExternalPublicationEvent,
    at: UnixMillis,
) -> Result<(), StoreError> {
    let task = view
        .external
        .as_ref()
        .ok_or_else(|| invalid("publication has no external task"))?;
    if !task.admitted
        || task
            .closed
            .as_ref()
            .is_none_or(|closed| closed.outcome != Terminal::Completed)
    {
        return Err(invalid(
            "publication requires an original completed task closure",
        ));
    }
    if let ExternalPublicationEvent::Pending { task: id, .. } = event
        && *id != task.task
    {
        return Err(invalid("publication belongs to another external task"));
    }
    if let ExternalPublicationEvent::Admitted { basis, .. } = event {
        basis.validate().map_err(invalid)?;
        if view.stopped
            || budget_exhausted(view, at)
            || view.cancelled_by_risk
            || !matches!(view.spec.origin, RunOrigin::Local)
            || *basis != view.spec.permission_basis
            || view
                .blockers
                .values()
                .any(|b| b.decision.is_none() && b.resolved_by.is_none())
        {
            return Err(invalid(
                "external publication has no current unblocked admission frontier",
            ));
        }
    }
    if matches!(event, ExternalPublicationEvent::Abandoned { .. })
        && !view.stopped
        && !budget_exhausted(view, at)
    {
        return Err(invalid(
            "publication abandonment requires Stop or an exhausted original budget",
        ));
    }
    update(
        &mut view.external.as_mut().expect("validated task").publication,
        event,
    )
}

fn update(
    publication: &mut Option<ExternalPublication>,
    event: &ExternalPublicationEvent,
) -> Result<(), StoreError> {
    for reference in event.content_refs() {
        reference.validate().map_err(invalid)?;
    }
    if let ExternalPublicationEvent::Pending { id, task, source } = event {
        if publication.is_some() {
            return Err(StoreError::EventConflict);
        }
        *publication = Some(ExternalPublication {
            id: *id,
            task: *task,
            source: source.clone(),
            manifest: None,
            item_count: None,
            admitted: 0,
            settled: 0,
            abandoned: false,
            items: BTreeMap::new(),
        });
        return Ok(());
    }
    let publication = publication
        .as_mut()
        .ok_or_else(|| invalid("external publication was not made pending"))?;
    if publication.id != event.id() {
        return Err(invalid("event belongs to another external publication"));
    }
    match event {
        ExternalPublicationEvent::Pending { .. } => unreachable!(),
        ExternalPublicationEvent::Prepared {
            manifest,
            item_count,
            ..
        } => {
            if publication.manifest.is_some() {
                return Err(invalid(
                    "external publication already has its immutable manifest",
                ));
            }
            publication.manifest = Some(manifest.clone());
            publication.item_count = Some(*item_count);
        }
        ExternalPublicationEvent::Admitted { key, basis } => {
            if publication.abandoned
                || publication.manifest.is_none()
                || publication
                    .item_count
                    .is_none_or(|count| key.index >= count)
                || key.index != publication.settled
                || publication.admitted != publication.settled
                || publication.items.contains_key(&key.index)
            {
                return Err(invalid(
                    "publication item is not the next original unadmitted manifest index",
                ));
            }
            let admitted = publication
                .admitted
                .checked_add(1)
                .ok_or_else(|| invalid("publication admission count overflow"))?;
            publication.items.insert(
                key.index,
                PublicationItem {
                    key: *key,
                    basis: *basis,
                    prevention: None,
                    original: None,
                    observation: None,
                    outcome: None,
                    cleanup: OperationCleanup::Unconfirmed,
                },
            );
            publication.admitted = admitted;
        }
        ExternalPublicationEvent::Abandoned { .. } => {
            if publication.unknown() {
                return Err(invalid(
                    "unknown original publication effect cannot be abandoned",
                ));
            }
            publication.abandoned = true;
        }
        ExternalPublicationEvent::PreventedBeforeHostAdmission { key, .. }
        | ExternalPublicationEvent::Bound { key, .. }
        | ExternalPublicationEvent::Observed { key, .. }
        | ExternalPublicationEvent::CleanupObserved { key, .. } => {
            let item = publication
                .items
                .get_mut(&key.index)
                .ok_or_else(|| invalid("publication item has no original admission"))?;
            let was_settled = item.settled();
            match event {
                ExternalPublicationEvent::PreventedBeforeHostAdmission { diagnostic, .. } => {
                    if item.original.is_some() || item.observation.is_some() {
                        return Err(invalid(
                            "publication prevention conflicts with original Host handoff evidence",
                        ));
                    }
                    if item
                        .prevention
                        .as_ref()
                        .is_some_and(|prior| prior != diagnostic)
                    {
                        return Err(StoreError::EventConflict);
                    }
                    item.prevention = Some(diagnostic.clone());
                    item.outcome = Some(ExternalPublicationOutcome::Prevented);
                }
                ExternalPublicationEvent::Bound { original, .. } => {
                    if item.prevention.is_some() {
                        return Err(invalid(
                            "prevented publication cannot bind a Host operation",
                        ));
                    }
                    original.validate().map_err(|e| invalid(e.to_string()))?;
                    if item
                        .original
                        .as_ref()
                        .is_some_and(|prior| prior != original)
                    {
                        return Err(StoreError::EventConflict);
                    }
                    item.original = Some(original.clone());
                }
                ExternalPublicationEvent::Observed {
                    observation,
                    outcome,
                    ..
                } => {
                    if item.prevention.is_some() {
                        return Err(invalid(
                            "prevented publication cannot acquire a provider observation",
                        ));
                    }
                    if item.original.as_ref() != Some(&observation.reference) {
                        return Err(invalid(
                            "publication observation differs from its original bound operation",
                        ));
                    }
                    validate_outcome(&observation.receipt, *outcome)?;
                    if item
                        .outcome
                        .is_some_and(|prior| prior.known() && outcome.known() && prior != *outcome)
                    {
                        return Err(StoreError::EventConflict);
                    }
                    let receipt = crate::external_effects::join_receipt(
                        item.observation.as_ref().map(|o| &o.receipt),
                        &observation.receipt,
                    )?;
                    let selected = if item.outcome.is_some_and(ExternalPublicationOutcome::known) {
                        item.outcome
                    } else {
                        Some(*outcome)
                    };
                    if let Receipt::Recorded { cleanup, .. } = &receipt {
                        item.cleanup =
                            crate::external_effects::join_cleanup(&item.cleanup, cleanup);
                    }
                    item.observation = Some(OperationReply {
                        reference: observation.reference.clone(),
                        receipt,
                    });
                    item.outcome = selected;
                }
                ExternalPublicationEvent::CleanupObserved { cleanup, .. } => {
                    item.cleanup = crate::external_effects::join_cleanup(&item.cleanup, cleanup);
                }
                _ => unreachable!(),
            }
            if !was_settled && item.settled() {
                if key.index != publication.settled {
                    return Err(invalid("publication settlement is not the admitted prefix"));
                }
                publication.settled = publication
                    .settled
                    .checked_add(1)
                    .ok_or_else(|| invalid("publication settlement count overflow"))?;
            }
        }
    }
    Ok(())
}

fn validate_outcome(
    receipt: &Receipt,
    outcome: ExternalPublicationOutcome,
) -> Result<(), StoreError> {
    use ExternalPublicationOutcome as O;
    let valid = matches!(
        (receipt, outcome),
        (
            Receipt::Recorded {
                outcome: OperationOutcome::Returned {
                    result: OperationResult::Success { .. }
                },
                ..
            },
            O::Applied | O::Conflict | O::Unsupported | O::NotAttempted
        ) | (
            Receipt::Recorded {
                outcome: OperationOutcome::Returned {
                    result: OperationResult::Failure { .. }
                },
                ..
            },
            O::Failed
        ) | (
            Receipt::Recorded {
                outcome: OperationOutcome::NotExecuted { .. },
                ..
            },
            O::NotExecuted
        ) | (
            Receipt::Recorded {
                outcome: OperationOutcome::Unresolved | OperationOutcome::Unknown { .. },
                ..
            } | Receipt::NotRecorded
                | Receipt::Unavailable { .. },
            O::Unknown
        )
    );
    if !valid {
        return Err(invalid(
            "publication disposition does not match the original Host receipt knowledge",
        ));
    }
    Ok(())
}

pub(crate) fn validate_batch(view: &RunView, changes: &[Change]) -> Result<(), StoreError> {
    for change in changes {
        match &change.fact {
            Fact::ExternalTaskClosed { task, outcome, .. } => {
                let count=changes.iter().filter(|c|matches!(&c.fact,Fact::ExternalPublication{event:ExternalPublicationEvent::Pending{task:id,..}} if id==task)).count();
                let first = view.external.as_ref().is_none_or(|t| t.publication.is_none());
                let staged = view.external.as_ref().is_none_or(|task| !task.live_workspace);
                let expected = usize::from(*outcome == Terminal::Completed && first && staged);
                if count != expected {
                    return Err(invalid(
                        "only the first completed task closure must atomically retain one pending publication",
                    ));
                }
            }
            Fact::ExternalPublication {
                event: ExternalPublicationEvent::Pending { task, .. },
            }
                if !changes
                    .iter()
                    .any(|c| matches!(&c.fact,Fact::ExternalTaskClosed{task:id,outcome:Terminal::Completed,..} if id==task))
                => {
                    return Err(invalid(
                        "pending publication requires the original same-batch completed task closure",
                    ));
                }
            _ => {}
        }
    }
    Ok(())
}

pub(crate) fn quiescent(view: &RunView) -> bool {
    view.external
        .as_ref()
        .and_then(|task| task.publication.as_ref())
        .is_none_or(ExternalPublication::quiescent)
}
pub(crate) fn terminal_allowed(view: &RunView, terminal: &Terminal) -> bool {
    if view.cancelled_by_risk {
        return *terminal == Terminal::Cancelled;
    }
    if let Some(task) = &view.external
        && let Some(closed) = &task.closed
    {
        if closed.outcome != Terminal::Completed {
            return *terminal != Terminal::Completed && task.publication.is_none();
        }
        if !task.live_workspace && task.publication.is_none() {
            return false;
        }
    }
    let Some(publication) = view
        .external
        .as_ref()
        .and_then(|task| task.publication.as_ref())
    else {
        return true;
    };
    match terminal {
        Terminal::Completed => publication.applied(),
        Terminal::Cancelled => {
            publication.applied() || view.stopped && publication.abandoned && !publication.unknown()
        }
        Terminal::Failed => {
            publication.applied() || publication.settled() && !publication.unknown()
        }
    }
}

pub(crate) fn validate_unavailable(
    view: &RunView,
    id: ExternalPublicationId,
) -> Result<(), StoreError> {
    let publication = view
        .external
        .as_ref()
        .and_then(|task| task.publication.as_ref())
        .ok_or_else(|| invalid("publication blocker has no original obligation"))?;
    if publication.id != id || publication.applied() || publication.abandoned {
        return Err(invalid(
            "publication unavailable blocker does not name an open obligation",
        ));
    }
    Ok(())
}
pub(crate) fn validate_item_blocker(
    view: &RunView,
    key: &ExternalPublicationKey,
    reason: ExternalPublicationBlocker,
) -> Result<(), StoreError> {
    let publication = view
        .external
        .as_ref()
        .and_then(|task| task.publication.as_ref())
        .ok_or_else(|| invalid("publication item blocker has no original obligation"))?;
    if publication.id != key.publication {
        return Err(invalid("publication item blocker names another obligation"));
    }
    let item = publication
        .items
        .get(&key.index)
        .ok_or_else(|| invalid("publication item blocker has no admitted source"))?;
    use ExternalPublicationBlocker as B;
    use ExternalPublicationOutcome as O;
    let active = match reason {
        B::Unknown => !item.known(),
        B::Conflict => item.outcome == Some(O::Conflict),
        B::Unsupported => item.outcome == Some(O::Unsupported),
        B::Failed => matches!(
            item.outcome,
            Some(O::Failed | O::NotExecuted | O::Prevented)
        ),
        B::NotAttempted => item.outcome == Some(O::NotAttempted),
        B::CleanupUnconfirmed => item.known() && item.cleanup != OperationCleanup::Confirmed,
    };
    if !active {
        return Err(invalid(
            "publication item blocker has no matching original evidence",
        ));
    }
    Ok(())
}

pub(crate) fn resolved_blockers(
    view: &RunView,
    event: &ExternalPublicationEvent,
) -> Vec<BlockerId> {
    let Some(publication) = view
        .external
        .as_ref()
        .and_then(|task| task.publication.as_ref())
    else {
        return Vec::new();
    };
    if publication.id != event.id() {
        return Vec::new();
    }
    view.blockers
        .iter()
        .filter_map(|(id, blocker)| {
            if blocker.decision.is_some() || blocker.resolved_by.is_some() {
                return None;
            }
            let resolved = match (&blocker.reason, event) {
                (
                    BlockerKind::ExternalPublicationUnavailable {
                        publication: id, ..
                    },
                    ExternalPublicationEvent::Prepared { manifest, .. },
                ) => *id == publication.id && publication.manifest.as_ref() == Some(manifest),
                (
                    BlockerKind::ExternalPublicationItem {
                        key,
                        reason: ExternalPublicationBlocker::Unknown,
                    },
                    ExternalPublicationEvent::Observed { key: observed, .. }
                    | ExternalPublicationEvent::PreventedBeforeHostAdmission {
                        key: observed, ..
                    },
                ) => {
                    key == observed
                        && publication
                            .items
                            .get(&key.index)
                            .is_some_and(|item| item.key == *key && item.known())
                }
                (
                    BlockerKind::ExternalPublicationItem {
                        key,
                        reason: ExternalPublicationBlocker::CleanupUnconfirmed,
                    },
                    ExternalPublicationEvent::Observed { key: observed, .. }
                    | ExternalPublicationEvent::CleanupObserved { key: observed, .. },
                ) => {
                    key == observed
                        && publication.items.get(&key.index).is_some_and(|item| {
                            item.key == *key && item.cleanup == OperationCleanup::Confirmed
                        })
                }
                _ => false,
            };
            resolved.then_some(*id)
        })
        .collect()
}

fn budget_exhausted(view: &RunView, at: UnixMillis) -> bool {
    view.spec
        .budget
        .tokens
        .is_some_and(|limit| view.tokens >= limit)
        || view
            .spec
            .budget
            .deadline
            .is_some_and(|deadline| at >= deadline)
}
