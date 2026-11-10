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

//! Original operation facts. Receipts never authorize a callback or a replay.
#[cfg(test)]
mod tests;

use super::invalid;
use crate::{EventLog, StoreError, root::RootOwner};
use maka_plugin_core::{
    composition::InstanceId,
    contract::{Contract, Interface},
    deployment::DeploymentRef,
    operation::{
        NotExecutedProof, OperationCleanup, OperationObservation, OperationOutcome,
        OperationResult, RecoveryContract, RecoveryProtocol, RecoveryRef,
    },
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, Weak},
};
use uuid::Uuid;

/// Trusted embedding supplies these facts after its private admission check.
/// This data is not an execution grant and contains no serialized evidence.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationRequest<C = Contract> {
    pub source: DeploymentRef,
    pub namespace: InstanceId,
    pub consumer: InstanceId,
    pub export: String,
    pub method: String,
    pub contract: C,
    pub operation: Uuid,
    pub input: Value,
    /// Identity of the original private resource bundle; never a lookup grant.
    #[serde(deserialize_with = "required_capture")]
    pub capture: Option<Uuid>,
    pub origin: serde_json::Value,
}
/// Immutable checked method facts retained by an executor's service instance.
/// This template is not an execution grant; dispatch still requires Host admission.
pub struct OperationTemplate {
    method: String,
    contract: RecoveryContract,
    contract_json: Arc<str>,
    resources: bool,
    required_resources: bool,
}
impl OperationTemplate {
    pub fn for_contract(
        contract: &Contract,
    ) -> Result<std::collections::BTreeMap<String, Self>, StoreError> {
        contract.validate().map_err(|e| invalid(e.to_string()))?;
        let Interface::Service { methods } = &contract.interface else {
            return Err(invalid("operation requires a service contract"));
        };
        let Some((mutation, _)) = methods
            .iter()
            .find(|(_, method)| method.mode == maka_plugin_core::contract::MethodMode::Mutation)
        else {
            return Ok(Default::default());
        };
        let contract_json: Arc<str> = serde_json::to_string(contract)?.into();
        let recovery =
            RecoveryContract::for_method(contract, mutation).map_err(|e| invalid(e.to_string()))?;
        methods
            .iter()
            .filter(|(_, method)| method.mode == maka_plugin_core::contract::MethodMode::Mutation)
            .map(|(name, declared)| {
                Ok((
                    name.clone(),
                    Self {
                        method: name.clone(),
                        contract: recovery.clone(),
                        contract_json: contract_json.clone(),
                        resources: !declared.resources.is_empty(),
                        required_resources: declared.resources.values().any(|slot| !slot.optional),
                    },
                ))
            })
            .collect()
    }
    pub fn prepare(&self, request: OperationRequest<()>) -> Result<PreparedOperation, StoreError> {
        if request.method != self.method {
            return Err(invalid("operation template method mismatch"));
        }
        if request.capture.is_some_and(|id| id.is_nil())
            || (request.capture.is_some() && !self.resources)
            || (request.capture.is_none() && self.required_resources)
        {
            return Err(invalid(
                "operation capture does not match declared resources",
            ));
        }
        let journal = OperationRequest {
            source: request.source,
            namespace: request.namespace,
            consumer: request.consumer,
            export: request.export,
            method: request.method,
            contract: self.contract.clone(),
            operation: request.operation,
            input: request.input,
            capture: request.capture,
            origin: request.origin,
        };
        let reference = journal.stored_reference()?;
        Ok(PreparedOperation {
            journal,
            reference,
            contract_json: self.contract_json.clone(),
        })
    }
}

/// Checked original operation facts; callers cannot edit the prepared journal.
pub struct PreparedOperation {
    journal: OperationRequest<RecoveryContract>,
    reference: RecoveryRef,
    contract_json: Arc<str>,
}
impl PreparedOperation {
    pub fn reference(&self) -> &RecoveryRef {
        &self.reference
    }
    pub fn consumer(&self) -> &InstanceId {
        &self.journal.consumer
    }
}

fn required_capture<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Uuid>, D::Error> {
    Option::<Uuid>::deserialize(deserializer)
}
impl OperationRequest {
    pub fn reference(&self) -> Result<RecoveryRef, StoreError> {
        self.journal()?.stored_reference()
    }

    fn journal(&self) -> Result<OperationRequest<RecoveryContract>, StoreError> {
        let Interface::Service { methods } = &self.contract.interface else {
            return Err(invalid("operation requires a service contract"));
        };
        let method = methods
            .get(&self.method)
            .ok_or_else(|| invalid("undeclared operation method"))?;
        self.contract
            .validate()
            .map_err(|e| invalid(e.to_string()))?;
        if method.mode != maka_plugin_core::contract::MethodMode::Mutation {
            return Err(invalid("operation requires a declared mutation method"));
        }
        if self.capture.is_some_and(|id| id.is_nil())
            || (self.capture.is_some() && method.resources.is_empty())
            || (self.capture.is_none() && method.resources.values().any(|slot| !slot.optional))
        {
            return Err(invalid(
                "operation capture does not match declared resources",
            ));
        }
        Ok(OperationRequest {
            source: self.source.clone(),
            namespace: self.namespace.clone(),
            consumer: self.consumer.clone(),
            export: self.export.clone(),
            method: self.method.clone(),
            contract: RecoveryContract::for_method(&self.contract, &self.method)
                .map_err(|e| invalid(e.to_string()))?,
            operation: self.operation,
            input: self.input.clone(),
            capture: self.capture,
            origin: self.origin.clone(),
        })
    }
}

impl OperationRequest<RecoveryContract> {
    fn stored_reference(&self) -> Result<RecoveryRef, StoreError> {
        self.consumer
            .validate()
            .map_err(|error| invalid(error.to_string()))?;
        if self.capture.is_some_and(|id| id.is_nil()) {
            return Err(invalid("invalid operation capture"));
        }
        let mut canonical = serde_json::to_value(self)?;
        canonical
            .as_object_mut()
            .expect("request object")
            .remove("origin");
        canonical.sort_all_objects();
        let fingerprint = format!(
            "sha256-{}",
            hex::encode(Sha256::digest(
                serde_json::to_string(&canonical)?.as_bytes()
            ))
        );
        let reference = RecoveryRef {
            source: self.source.clone(),
            namespace: self.namespace.clone(),
            export: self.export.clone(),
            method: self.method.clone(),
            operation: self.operation,
            fingerprint,
            contract: self.contract.clone(),
            recovery: RecoveryProtocol::JournalV1,
        };
        reference.validate().map_err(|e| invalid(e.to_string()))?;
        Ok(reference)
    }
}

/// Only a successful first commit constructs this private execution claim.
/// Holding a claim also retains its original Root owner; it cannot be restored
/// from a receipt, copied, or used against another Root owner's connection.
pub struct DispatchClaim {
    reference: RecoveryRef,
    owner: std::sync::Weak<RootOwner>,
    dispatch: Arc<DispatchState>,
}
pub(crate) trait DispatchLifetime: Send + Sync {
    fn finish(&self);
    fn abandon(self: Arc<Self>);
}
type OperationKey = (Uuid, InstanceId, Uuid);
fn operation_key(reference: &RecoveryRef) -> OperationKey {
    (
        reference.source.deployment,
        reference.namespace.clone(),
        reference.operation,
    )
}

/// One Root's live custody index, shared by every scoped SQL handle.
#[derive(Default)]
pub(crate) struct LiveOperations(Mutex<BTreeMap<OperationKey, LiveEntry>>);
enum LiveEntry {
    Active(Weak<DispatchState>),
    Abandoned { started: bool },
}
impl LiveOperations {
    fn register(&self, state: &Arc<DispatchState>) -> Result<(), StoreError> {
        let mut entries = self.0.lock().unwrap();
        if entries.contains_key(&state.key) {
            return Err(invalid("original operation custody is already tracked"));
        }
        entries.insert(state.key.clone(), LiveEntry::Active(Arc::downgrade(state)));
        Ok(())
    }
    fn returned(
        &self,
        reference: &RecoveryRef,
        old: &OperationOutcome,
    ) -> Result<Option<Arc<DispatchState>>, StoreError> {
        let state = {
            let entries = self.0.lock().unwrap();
            match entries.get(&operation_key(reference)) {
                None | Some(LiveEntry::Abandoned { started: true }) => return Ok(None),
                Some(LiveEntry::Abandoned { started: false }) => {
                    return Err(invalid("original operation handler never started"));
                }
                Some(LiveEntry::Active(state)) => state
                    .upgrade()
                    .ok_or_else(|| invalid("original operation custody is being abandoned"))?,
            }
        };
        {
            let mut status = state.status.lock().unwrap();
            if status.handler != HandlerStart::Started {
                return Err(invalid("original operation handler has not started"));
            }
            if matches!(old, OperationOutcome::Unresolved) {
                // The original callback may still owe its atomic state+receipt
                // commit. A provider fact cannot consume that live preview.
                return Err(invalid(
                    "live unresolved operation requires original completion",
                ));
            }
            status.admission.close();
        }
        Ok(Some(state))
    }
    fn cleanup(&self, reference: &RecoveryRef, confirmed: bool) -> Result<(), StoreError> {
        let entries = self.0.lock().unwrap();
        match entries.get(&operation_key(reference)) {
            None => Ok(()),
            Some(LiveEntry::Abandoned { .. }) if !confirmed => Ok(()),
            Some(_) => Err(invalid(
                "original operation cleanup requires its original custody owner",
            )),
        }
    }
}

struct DispatchState {
    live: Arc<LiveOperations>,
    key: OperationKey,
    identity: std::sync::Weak<std::sync::atomic::AtomicU64>,
    status: std::sync::Mutex<DispatchStatus>,
}
struct DispatchRetention {
    _owner: Arc<RootOwner>,
    lifetime: Option<Arc<dyn DispatchLifetime>>,
}
// Cleanup confirmation is physical knowledge, independent of SQL success.
// A queued confirmation owns its pin even if the observing future is dropped.
struct CleanupCustody(Option<DispatchRetention>);
impl Drop for CleanupCustody {
    fn drop(&mut self) {
        if let Some(DispatchRetention {
            lifetime: Some(lifetime),
            ..
        }) = self.0.take()
        {
            lifetime.finish();
        }
    }
}
impl Drop for DispatchState {
    fn drop(&mut self) {
        let identity = self as *const Self;
        let status = self.status.get_mut().unwrap();
        {
            let mut entries = self.live.0.lock().unwrap();
            if matches!(entries.get(&self.key), Some(LiveEntry::Active(entry)) if std::ptr::eq(entry.as_ptr(), identity))
            {
                if status.handler == HandlerStart::AwaitingCommit || status.retained.is_none() {
                    entries.remove(&self.key);
                } else {
                    entries.insert(
                        self.key.clone(),
                        LiveEntry::Abandoned {
                            started: status.handler == HandlerStart::Started,
                        },
                    );
                }
            }
        }
        if status.handler != HandlerStart::AwaitingCommit
            && let Some(DispatchRetention {
                lifetime: Some(lifetime),
                ..
            }) = status.retained.take()
        {
            lifetime.abandon();
        }
    }
}
struct DispatchStatus {
    admission: DispatchAdmission,
    handler: HandlerStart,
    active: usize,
    retained: Option<DispatchRetention>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum DispatchAdmission {
    Open,
    Closed,
    Quarantined,
}
impl DispatchAdmission {
    fn close(&mut self) {
        if *self == Self::Open {
            *self = Self::Closed;
        }
    }
}

// This fence belongs to the original claim, never to a serialized receipt.
#[derive(Clone, Copy, PartialEq, Eq)]
enum HandlerStart {
    AwaitingCommit,
    Pending,
    Started,
    Prevented,
}

/// Private first-commit evidence. A receipt cannot construct this scope.
#[derive(Clone)]
pub struct OperationDispatchScope {
    reference: RecoveryRef,
    dispatch: Arc<DispatchState>,
}
pub(crate) struct DispatchWork {
    dispatch: Arc<DispatchState>,
    released: std::sync::atomic::AtomicBool,
}
impl DispatchWork {
    pub(crate) fn quarantine(&self) {
        if !self
            .released
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            let mut status = self.dispatch.status.lock().unwrap();
            status.active -= 1;
            status.admission = DispatchAdmission::Quarantined;
        }
    }
    pub(crate) fn finish(&self) {
        if !self
            .released
            .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            self.dispatch.status.lock().unwrap().active -= 1;
        }
    }
}
impl Drop for DispatchWork {
    fn drop(&mut self) {
        self.finish();
    }
}
impl OperationDispatchScope {
    pub fn reference(&self) -> &RecoveryRef {
        &self.reference
    }
    pub(crate) fn acquire(
        &self,
        log: &EventLog,
        reference: &RecoveryRef,
    ) -> Result<Arc<DispatchWork>, StoreError> {
        if reference != &self.reference
            || !std::sync::Weak::ptr_eq(&log.connection.owner_identity(), &self.dispatch.identity)
        {
            return Err(invalid("foreign original operation custody"));
        }
        let mut status = self.dispatch.status.lock().unwrap();
        if status.admission != DispatchAdmission::Open || status.handler != HandlerStart::Started {
            return Err(invalid("original operation dispatch is not running"));
        }
        status.active = status
            .active
            .checked_add(1)
            .ok_or_else(|| invalid("operation work count exhausted"))?;
        Ok(Arc::new(DispatchWork {
            dispatch: self.dispatch.clone(),
            released: std::sync::atomic::AtomicBool::new(false),
        }))
    }
}
impl Drop for DispatchClaim {
    fn drop(&mut self) {
        // Keep custody in the shared state while original work/SQL still owns it.
        self.dispatch.status.lock().unwrap().admission.close();
    }
}
impl DispatchClaim {
    pub fn auxiliary_scope(&self) -> OperationDispatchScope {
        OperationDispatchScope {
            reference: self.reference.clone(),
            dispatch: self.dispatch.clone(),
        }
    }
    pub fn reference(&self) -> &RecoveryRef {
        &self.reference
    }
}
pub enum Dispatch {
    New(DispatchClaim),
    Existing(OperationObservation),
}

struct Record {
    request: OperationRequest<RecoveryContract>,
    observation: OperationObservation,
}
fn read(connection: &Connection, reference: &RecoveryRef) -> Result<Option<Record>, StoreError> {
    let namespace = serde_json::to_string(&reference.namespace)?;
    let row = connection.query_row(
        "SELECT source_revision, contract_digest, request_json, outcome_json, cleanup_json,c.payload AS outcome_value
        FROM application_operations o LEFT JOIN contents c ON c.id=o.outcome_content_id WHERE deployment=? AND namespace=? AND operation=?",
        params![reference.source.deployment.to_string(), namespace, reference.operation.to_string()],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<Vec<u8>>>(5)?)),
    ).optional()?;
    let Some((
        source_revision,
        contract_digest,
        request_json,
        outcome_json,
        cleanup_json,
        outcome_value,
    )) = row
    else {
        return Ok(None);
    };
    let request: OperationRequest<RecoveryContract> = serde_json::from_str(&request_json)?;
    let outcome = match serde_json::from_str::<StoredOutcome>(&outcome_json)? {
        StoredOutcome::Unresolved => OperationOutcome::Unresolved,
        StoredOutcome::Unknown { diagnostic } => OperationOutcome::Unknown { diagnostic },
        StoredOutcome::NotExecuted { proof } => OperationOutcome::NotExecuted { proof },
        StoredOutcome::Returned {
            result_version: RESULT_CODEC_VERSION,
        } => OperationOutcome::Returned {
            result: serde_json::from_slice(&outcome_value.ok_or(
                rusqlite::Error::InvalidColumnType(
                    5,
                    "outcome_value".into(),
                    rusqlite::types::Type::Null,
                ),
            )?)?,
        },
        StoredOutcome::Returned { result_version } => {
            return Err(invalid(format!(
                "unsupported operation result codec version: {result_version}"
            )));
        }
    };
    let cleanup: OperationCleanup = serde_json::from_str(&cleanup_json)?;
    let expected = request.stored_reference()?;
    if expected != *reference
        || contract_digest != reference.contract.digest
        || source_revision != reference.source.revision as i64
    {
        return Err(StoreError::EventConflict);
    }
    Ok(Some(Record {
        request,
        observation: OperationObservation {
            reference: reference.clone(),
            outcome,
            cleanup,
        },
    }))
}
impl EventLog {
    pub(crate) fn operation_domain(&self, reference: &RecoveryRef) -> Result<(), StoreError> {
        reference.validate().map_err(|e| invalid(e.to_string()))?;
        if reference.source.state_domain != self.application_domain()? {
            return Err(invalid("foreign operation state domain"));
        }
        Ok(())
    }
    /// Commit before calling the handler. An uncertain commit returns no claim;
    /// the caller may only read its original receipt, never dispatch again.
    pub async fn dispatch_operation(
        &self,
        request: OperationRequest,
    ) -> Result<Dispatch, StoreError> {
        self.dispatch_operation_with_lifetime(request, None).await
    }
    pub(crate) async fn dispatch_operation_with_lifetime(
        &self,
        request: OperationRequest,
        lifetime: Option<Arc<dyn DispatchLifetime>>,
    ) -> Result<Dispatch, StoreError> {
        let contract_json = serde_json::to_string(&request.contract)?;
        let request = request.journal()?;
        let reference = request.stored_reference()?;
        self.dispatch_prepared_with_lifetime(
            PreparedOperation {
                journal: request,
                reference,
                contract_json: contract_json.into(),
            },
            lifetime,
        )
        .await
    }

    pub async fn dispatch_prepared_operation(
        &self,
        prepared: PreparedOperation,
    ) -> Result<Dispatch, StoreError> {
        self.dispatch_prepared_with_lifetime(prepared, None).await
    }
    pub(crate) async fn dispatch_prepared_with_lifetime(
        &self,
        prepared: PreparedOperation,
        lifetime: Option<Arc<dyn DispatchLifetime>>,
    ) -> Result<Dispatch, StoreError> {
        let PreparedOperation {
            journal: request,
            reference,
            contract_json,
        } = prepared;
        self.operation_domain(&reference)?;
        let owner = self.root_owner.as_ref().expect("owned Root").clone();
        let request_json = serde_json::to_string(&request)?;
        let dispatch = Arc::new(DispatchState {
            live: self.operation_live.clone(),
            key: operation_key(&reference),
            identity: self.connection.owner_identity(),
            status: std::sync::Mutex::new(DispatchStatus {
                admission: DispatchAdmission::Open,
                handler: HandlerStart::AwaitingCommit,
                active: 0,
                retained: Some(DispatchRetention {
                    _owner: owner.clone(),
                    lifetime,
                }),
            }),
        });
        self.connection
            .write(
                WriteDispatch {
                    request,
                    reference,
                    contract_json,
                    request_json,
                    owner,
                    dispatch,
                },
                self.commits.notice(),
            )
            .await
    }

    fn check_operation_claim(&self, claim: &DispatchClaim) -> Result<(), StoreError> {
        self.operation_domain(&claim.reference)?;
        if !std::sync::Weak::ptr_eq(
            &Arc::downgrade(self.root_owner.as_ref().expect("owned Root")),
            &claim.owner,
        ) {
            return Err(invalid("foreign operation dispatch claim"));
        }
        if !std::sync::Weak::ptr_eq(&self.connection.owner_identity(), &claim.dispatch.identity) {
            return Err(invalid("foreign operation partition claim"));
        }
        Ok(())
    }

    /// Linearize handler entry against prevention. The trusted Host must call
    /// this immediately before invoking the handler, once per original claim.
    pub fn start_operation(&self, claim: &DispatchClaim) -> Result<(), StoreError> {
        self.check_operation_claim(claim)?;
        let mut status = claim.dispatch.status.lock().unwrap();
        if status.handler != HandlerStart::Pending || status.admission != DispatchAdmission::Open {
            return Err(invalid("original operation cannot start"));
        }
        status.handler = HandlerStart::Started;
        Ok(())
    }

    /// Establish the provider's no-start fence before recording non-execution.
    /// The committed original row also prevents a later request obtaining a claim.
    /// A failed/uncertain write leaves the in-memory fence closed and is retryable
    /// only through this original claim, never by reconstructing a receipt.
    pub async fn prevent_operation_before_start(
        &self,
        claim: &DispatchClaim,
    ) -> Result<OperationObservation, StoreError> {
        self.check_operation_claim(claim)?;
        {
            let mut status = claim.dispatch.status.lock().unwrap();
            if status.handler == HandlerStart::Started || status.active != 0 {
                return Err(invalid("original operation may already have executed"));
            }
            status.handler = HandlerStart::Prevented;
            status.admission.close();
        }
        self.record_operation_outcome(
            claim,
            OperationOutcome::NotExecuted {
                proof: NotExecutedProof::ProviderPreventedBeforeStart,
            },
        )
        .await
    }

    /// Prepare outside the SQL transaction; execute composes with other pure
    /// state statements in the same Root/partition transaction. No result write
    /// releases the original physical custody, even when the result is known.
    pub(crate) fn prepare_operation_outcome(
        &self,
        claim: &DispatchClaim,
        outcome: OperationOutcome,
    ) -> Result<WriteOutcome, StoreError> {
        self.check_operation_claim(claim)?;
        {
            let mut status = claim.dispatch.status.lock().unwrap();
            match &outcome {
                OperationOutcome::Unresolved => {
                    return Err(invalid("outcome update must add knowledge"));
                }
                OperationOutcome::Returned { .. } if status.handler != HandlerStart::Started => {
                    return Err(invalid("original operation handler has not started"));
                }
                OperationOutcome::NotExecuted { .. }
                    if status.handler != HandlerStart::Prevented =>
                {
                    return Err(invalid(
                        "original operation lacks a provider no-start fence",
                    ));
                }
                _ => {}
            }
            status.admission.close();
        }
        Ok(WriteOutcome {
            reference: claim.reference.clone(),
            outcome,
            authority: OutcomeAuthority::Claim(claim.dispatch.clone()),
        })
    }

    pub(crate) fn prepare_statement_completion(
        &self,
        claim: &DispatchClaim,
    ) -> Result<StatementCompletion, StoreError> {
        self.check_operation_claim(claim)?;
        let mut status = claim.dispatch.status.lock().unwrap();
        if status.handler != HandlerStart::Started {
            return Err(invalid("original operation handler has not started"));
        }
        status.admission.close();
        Ok(StatementCompletion {
            reference: claim.reference.clone(),
            dispatch: claim.dispatch.clone(),
        })
    }

    /// Accepts late original evidence even after dispatch has been closed.
    pub async fn record_operation_outcome(
        &self,
        claim: &DispatchClaim,
        outcome: OperationOutcome,
    ) -> Result<OperationObservation, StoreError> {
        let statement = self.prepare_operation_outcome(claim, outcome)?;
        self.connection
            .write(statement, self.commits.notice())
            .await
    }

    /// Only explicit physical confirmation releases custody. Failed cleanup
    /// keeps the operation isolated; a later trusted confirmation may advance it.
    pub async fn record_operation_cleanup(
        &self,
        claim: &DispatchClaim,
        cleanup: OperationCleanup,
    ) -> Result<OperationObservation, StoreError> {
        self.check_operation_claim(claim)?;
        if matches!(cleanup, OperationCleanup::Unconfirmed) {
            return Err(invalid("cleanup update must add knowledge"));
        }
        let custody = {
            let mut status = claim.dispatch.status.lock().unwrap();
            let confirmed = matches!(cleanup, OperationCleanup::Confirmed);
            if confirmed
                && (status.active != 0 || status.admission == DispatchAdmission::Quarantined)
            {
                return Err(invalid("original operation work has not drained"));
            }
            status.admission.close();
            CleanupCustody(if confirmed {
                status.retained.take()
            } else {
                None
            })
        };
        self.connection
            .write(
                WriteCleanup {
                    reference: claim.reference.clone(),
                    cleanup,
                    authority: CleanupAuthority::Claim {
                        custody,
                        dispatch: claim.dispatch.clone(),
                    },
                },
                self.commits.notice(),
            )
            .await
    }

    /// Provider-only original facts. These entrypoints are crate-private; the
    /// public capability is minted by RootStore for a checked provider source.
    pub(crate) async fn record_provider_returned(
        &self,
        reference: &RecoveryRef,
        result: OperationResult,
    ) -> Result<OperationObservation, StoreError> {
        self.operation_domain(reference)?;
        self.connection
            .write(
                WriteOutcome {
                    reference: reference.clone(),
                    outcome: OperationOutcome::Returned { result },
                    authority: OutcomeAuthority::Provider(self.operation_live.clone()),
                },
                self.commits.notice(),
            )
            .await
    }

    pub(crate) async fn record_provider_cleanup(
        &self,
        reference: &RecoveryRef,
        cleanup: OperationCleanup,
    ) -> Result<OperationObservation, StoreError> {
        self.operation_domain(reference)?;
        if matches!(cleanup, OperationCleanup::Unconfirmed) {
            return Err(invalid("cleanup update must add knowledge"));
        }
        self.connection
            .write(
                WriteCleanup {
                    reference: reference.clone(),
                    cleanup,
                    authority: CleanupAuthority::Provider(self.operation_live.clone()),
                },
                self.commits.notice(),
            )
            .await
    }

    /// Reads one fixed original namespace. This lookup performs no effect and
    /// cannot issue a claim. Its embedding must independently authorize recovery.
    pub async fn operation_observation(
        &self,
        reference: &RecoveryRef,
    ) -> Result<Option<OperationObservation>, StoreError> {
        self.operation_domain(reference)?;
        let reference = reference.clone();
        self.connection
            .read(move |connection| {
                read(connection, &reference).map(|record| record.map(|record| record.observation))
            })
            .await
    }
}

pub(crate) struct WriteDispatch {
    request: OperationRequest<RecoveryContract>,
    reference: RecoveryRef,
    contract_json: Arc<str>,
    request_json: String,
    owner: Arc<RootOwner>,
    dispatch: Arc<DispatchState>,
}
pub(crate) struct DispatchValue(PreparedDispatch);
enum PreparedDispatch {
    New {
        reference: RecoveryRef,
        owner: Arc<RootOwner>,
        dispatch: Arc<DispatchState>,
    },
    Existing(OperationObservation),
}
impl crate::writeback::Statement for WriteDispatch {
    type Value = DispatchValue;
    type Output = Dispatch;
    fn execute(
        self,
        connection: &Connection,
    ) -> Result<crate::writeback::Prepared<Self::Value>, StoreError> {
        let Self {
            request,
            reference,
            contract_json,
            request_json,
            owner,
            dispatch,
        } = self;
        if let Some(record) = read(connection, &reference)? {
            // The original origin remains historical observation. New request
            // authorization must be checked again by the trusted embedding.
            if record.request.consumer != request.consumer || record.request.input != request.input
            {
                return Err(StoreError::EventConflict);
            }
            return Ok(crate::writeback::Prepared {
                value: DispatchValue(PreparedDispatch::Existing(record.observation)),
                changed: false,
                notification: crate::writeback::Notification::NONE,
            });
        }
        require_source(connection, &reference.source)?;
        connection.execute("INSERT INTO application_operation_contracts (digest, contract_json) VALUES (?, ?) ON CONFLICT(digest) DO NOTHING", params![&reference.contract.digest, contract_json.as_ref()])?;
        connection.execute("INSERT INTO application_operations (deployment, namespace, operation, source_revision, request_json, outcome_json, cleanup_json, contract_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", params![reference.source.deployment.to_string(), serde_json::to_string(&reference.namespace)?, reference.operation.to_string(), reference.source.revision as i64, request_json, serde_json::to_string(&OperationOutcome::Unresolved)?, serde_json::to_string(&OperationCleanup::Unconfirmed)?, &reference.contract.digest])?;

        // Reserve before COMMIT becomes visible to independent readers. Only
        // committed() issues a claim; an unissued rollback removes this entry.
        dispatch.live.register(&dispatch)?;
        Ok(crate::writeback::Prepared {
            value: DispatchValue(PreparedDispatch::New {
                reference,
                owner,
                dispatch,
            }),
            changed: true,
            notification: crate::writeback::Notification::METADATA,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        match value.0 {
            PreparedDispatch::New {
                reference,
                owner,
                dispatch,
            } => {
                dispatch.status.lock().unwrap().handler = HandlerStart::Pending;
                Dispatch::New(DispatchClaim {
                    reference,
                    owner: Arc::downgrade(&owner),
                    dispatch,
                })
            }
            PreparedDispatch::Existing(observation) => Dispatch::Existing(observation),
        }
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::EventConflict | StoreError::InvalidTransition(_)
        )
    }
}

/// The original claim's completion fence, before its SQL result is known.
pub(crate) struct StatementCompletion {
    reference: RecoveryRef,
    dispatch: Arc<DispatchState>,
}
impl StatementCompletion {
    pub(crate) fn existing(
        &self,
        connection: &Connection,
        expected: Option<&OperationResult>,
    ) -> Result<Option<crate::writeback::Prepared<OutcomeValue>>, StoreError> {
        let observation = read(connection, &self.reference)?
            .ok_or_else(|| invalid("original dispatch missing"))?
            .observation;
        match &observation.outcome {
            OperationOutcome::Returned { result } => {
                if expected.is_some_and(|expected| expected != result) {
                    return Err(StoreError::EventConflict);
                }
                Ok(Some(crate::writeback::Prepared {
                    value: OutcomeValue {
                        observation,
                        _dispatch: Some(self.dispatch.clone()),
                    },
                    changed: false,
                    notification: crate::writeback::Notification::NONE,
                }))
            }
            OperationOutcome::Unresolved => Ok(None),
            OperationOutcome::Unknown { .. } if expected.is_some() => Ok(None),
            OperationOutcome::Unknown { .. } | OperationOutcome::NotExecuted { .. } => {
                Err(StoreError::EventConflict)
            }
        }
    }
    pub(crate) fn returned(self, result: OperationResult) -> WriteOutcome {
        WriteOutcome {
            reference: self.reference,
            outcome: OperationOutcome::Returned { result },
            authority: OutcomeAuthority::Claim(self.dispatch),
        }
    }
}

/// Original completion or independently authorized provider evidence. Only
/// original completion may publish a live Unresolved preview with state changes.
pub(crate) struct WriteOutcome {
    reference: RecoveryRef,
    outcome: OperationOutcome,
    authority: OutcomeAuthority,
}
enum OutcomeAuthority {
    Claim(Arc<DispatchState>),
    Provider(Arc<LiveOperations>),
}
pub(crate) struct OutcomeValue {
    observation: OperationObservation,
    _dispatch: Option<Arc<DispatchState>>,
}
impl crate::writeback::Statement for WriteOutcome {
    type Value = OutcomeValue;
    type Output = OperationObservation;
    fn execute(
        self,
        connection: &Connection,
    ) -> Result<crate::writeback::Prepared<Self::Value>, StoreError> {
        let mut observation = read(connection, &self.reference)?
            .ok_or_else(|| invalid("original dispatch missing"))?
            .observation;
        let changed = advance_outcome(&observation.outcome, &self.outcome)?;
        let dispatch = match self.authority {
            OutcomeAuthority::Claim(dispatch) => Some(dispatch),
            OutcomeAuthority::Provider(live) => {
                live.returned(&self.reference, &observation.outcome)?
            }
        };
        if changed {
            let (stored, value) = match &self.outcome {
                OperationOutcome::Unresolved => unreachable!("checked update"),
                OperationOutcome::Unknown { diagnostic } => (
                    StoredOutcome::Unknown {
                        diagnostic: diagnostic.clone(),
                    },
                    None,
                ),
                OperationOutcome::NotExecuted { proof } => (
                    StoredOutcome::NotExecuted {
                        proof: proof.clone(),
                    },
                    None,
                ),
                OperationOutcome::Returned { result } => {
                    let bytes = serde_json::to_vec(result)?;
                    let digest = {
                        use sha2::Digest;
                        format!("sha256:{}", hex::encode(sha2::Sha256::digest(&bytes)))
                    };
                    (
                        StoredOutcome::Returned {
                            result_version: RESULT_CODEC_VERSION,
                        },
                        Some(crate::content::put(connection, &digest, &bytes)?),
                    )
                }
            };
            connection.execute("UPDATE application_operations SET outcome_json=?, outcome_content_id=? WHERE deployment=? AND namespace=? AND operation=?", params![serde_json::to_string(&stored)?, value, self.reference.source.deployment.to_string(), serde_json::to_string(&self.reference.namespace)?, self.reference.operation.to_string()])?;
            observation.outcome = self.outcome;
        }
        Ok(crate::writeback::Prepared {
            value: OutcomeValue {
                observation,
                _dispatch: dispatch,
            },
            changed,
            notification: crate::writeback::Notification::METADATA,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value.observation
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::EventConflict | StoreError::InvalidTransition(_)
        )
    }
}

fn advance_outcome(old: &OperationOutcome, new: &OperationOutcome) -> Result<bool, StoreError> {
    if old == new {
        return Ok(false);
    }
    match (old, new) {
        (
            OperationOutcome::Unresolved,
            OperationOutcome::Unknown { .. }
            | OperationOutcome::Returned { .. }
            | OperationOutcome::NotExecuted { .. },
        )
        | (
            OperationOutcome::Unknown { .. },
            OperationOutcome::Returned { .. } | OperationOutcome::NotExecuted { .. },
        ) => Ok(true),
        (
            OperationOutcome::Unknown { .. }
            | OperationOutcome::Returned { .. }
            | OperationOutcome::NotExecuted { .. },
            OperationOutcome::Unknown { .. },
        ) => Ok(false),
        _ => Err(StoreError::EventConflict),
    }
}

pub(crate) struct WriteCleanup {
    reference: RecoveryRef,
    cleanup: OperationCleanup,
    authority: CleanupAuthority,
}
enum CleanupAuthority {
    Claim {
        custody: CleanupCustody,
        dispatch: Arc<DispatchState>,
    },
    Provider(Arc<LiveOperations>),
}
pub(crate) struct CleanupValue {
    observation: OperationObservation,
    _custody: CleanupCustody,
    _dispatch: Option<Arc<DispatchState>>,
}
impl crate::writeback::Statement for WriteCleanup {
    type Value = CleanupValue;
    type Output = OperationObservation;
    fn execute(
        self,
        connection: &Connection,
    ) -> Result<crate::writeback::Prepared<Self::Value>, StoreError> {
        let mut observation = read(connection, &self.reference)?
            .ok_or_else(|| invalid("original dispatch missing"))?
            .observation;
        let changed = advance_cleanup(&observation.cleanup, &self.cleanup)?;
        let (custody, dispatch) = match self.authority {
            CleanupAuthority::Claim { custody, dispatch } => (custody, Some(dispatch)),
            CleanupAuthority::Provider(live) => {
                live.cleanup(
                    &self.reference,
                    matches!(self.cleanup, OperationCleanup::Confirmed),
                )?;
                (CleanupCustody(None), None)
            }
        };
        if changed {
            connection.execute("UPDATE application_operations SET cleanup_json=? WHERE deployment=? AND namespace=? AND operation=?", params![serde_json::to_string(&self.cleanup)?, self.reference.source.deployment.to_string(), serde_json::to_string(&self.reference.namespace)?, self.reference.operation.to_string()])?;
            observation.cleanup = self.cleanup;
        }
        Ok(crate::writeback::Prepared {
            value: CleanupValue {
                observation,
                _custody: custody,
                _dispatch: dispatch,
            },
            changed,
            notification: crate::writeback::Notification::METADATA,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value.observation
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::EventConflict | StoreError::InvalidTransition(_)
        )
    }
}

fn advance_cleanup(old: &OperationCleanup, new: &OperationCleanup) -> Result<bool, StoreError> {
    if old == new {
        return Ok(false);
    }
    match (old, new) {
        (
            OperationCleanup::Unconfirmed,
            OperationCleanup::Failed { .. } | OperationCleanup::Confirmed,
        )
        | (OperationCleanup::Failed { .. }, OperationCleanup::Confirmed) => Ok(true),
        (
            OperationCleanup::Failed { .. } | OperationCleanup::Confirmed,
            OperationCleanup::Failed { .. },
        ) => Ok(false),
        _ => Err(StoreError::EventConflict),
    }
}

/// Partitions resolve this name through the immutable Root control source view;
/// standalone stores use the same local source table. Keep this in the write tx.
pub(crate) fn require_source(
    connection: &Connection,
    source: &DeploymentRef,
) -> Result<(), StoreError> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM application_sources WHERE deployment=? AND revision=?)",
        params![source.deployment.to_string(), source.revision as i64],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(invalid("original application source missing"))
    }
}

const RESULT_CODEC_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum StoredOutcome {
    Unresolved,
    Returned {
        #[serde(rename = "resultVersion")]
        result_version: u32,
    },
    NotExecuted {
        proof: NotExecutedProof,
    },
    Unknown {
        diagnostic: String,
    },
}
