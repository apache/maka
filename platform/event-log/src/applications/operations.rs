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
use super::invalid;
use crate::{EventLog, StoreError, root::RootOwner};
use maka_capabilities::call::Identity;
use maka_plugin_core::{
    composition::InstanceId,
    contract::{Contract, Interface},
    deployment::DeploymentRef,
    operation::{
        OperationCleanup, OperationObservation, OperationOutcome, RecoveryContract,
        RecoveryProtocol, RecoveryRef,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqliteConnection};
use std::sync::Arc;
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
    pub origin: Identity,
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
struct DispatchState {
    identity: std::sync::Weak<std::sync::atomic::AtomicU64>,
    status: std::sync::Mutex<DispatchStatus>,
}
struct DispatchRetention {
    _owner: Arc<RootOwner>,
    lifetime: Option<Arc<dyn DispatchLifetime>>,
}
// Physical cleanup knowledge is independent of receipt durability. Once a
// trusted caller supplies validated cleanup, cancellation/SQL failure cannot
// turn it into unknown provider custody. Accepted SQL keeps its own owner pin.
struct SettlementCustody {
    retained: Option<DispatchRetention>,
    confirmed: bool,
}
impl Drop for SettlementCustody {
    fn drop(&mut self) {
        if let Some(DispatchRetention {
            lifetime: Some(lifetime),
            ..
        }) = self.retained.take()
        {
            if self.confirmed {
                lifetime.finish();
            } else {
                lifetime.abandon();
            }
        }
    }
}
struct DispatchStatus {
    closed: bool,
    active: usize,
    unconfirmed: bool,
    retained: Option<DispatchRetention>,
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
            status.unconfirmed = true;
            status.closed = true;
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
        if status.closed {
            return Err(invalid("original operation dispatch is closed"));
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
        // Lost original execution custody never admits a new auxiliary worker.
        let retained = {
            let mut status = self.dispatch.status.lock().unwrap();
            status.closed = true;
            status.retained.take()
        };
        if let Some(DispatchRetention {
            lifetime: Some(lifetime),
            ..
        }) = retained
        {
            lifetime.abandon();
        }
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
fn validate_settlement(
    outcome: &OperationOutcome,
    cleanup: &OperationCleanup,
) -> Result<(), StoreError> {
    if matches!(outcome, OperationOutcome::Unresolved)
        || matches!(cleanup, OperationCleanup::Unconfirmed)
    {
        return Err(invalid(
            "operation settlement must report result knowledge and real cleanup",
        ));
    }
    Ok(())
}
async fn read(
    connection: &mut SqliteConnection,
    reference: &RecoveryRef,
) -> Result<Option<Record>, StoreError> {
    let namespace = serde_json::to_string(&reference.namespace)?;
    let Some(row) = sqlx::query(
        "SELECT source_revision, contract_digest, request_json, outcome_json,
        cleanup_json
        FROM application_operations WHERE deployment=? AND namespace=? AND operation=?",
    )
    .bind(reference.source.deployment.to_string())
    .bind(namespace)
    .bind(reference.operation.to_string())
    .fetch_optional(connection)
    .await?
    else {
        return Ok(None);
    };
    let request: OperationRequest<RecoveryContract> =
        serde_json::from_str(&row.try_get::<String, _>("request_json")?)?;
    let outcome: OperationOutcome =
        serde_json::from_str(&row.try_get::<String, _>("outcome_json")?)?;
    let cleanup: OperationCleanup =
        serde_json::from_str(&row.try_get::<String, _>("cleanup_json")?)?;
    let expected = request.stored_reference()?;
    if expected != *reference
        || row.try_get::<String, _>("contract_digest")? != reference.contract.digest
        || row.try_get::<i64, _>("source_revision")? != reference.source.revision as i64
    {
        return Err(StoreError::EventConflict);
    }
    match (&outcome, &cleanup) {
        (OperationOutcome::Unresolved, OperationCleanup::Unconfirmed) => {}
        _ => validate_settlement(&outcome, &cleanup)?,
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
            identity: self.connection.owner_identity(),
            status: std::sync::Mutex::new(DispatchStatus {
                closed: false,
                active: 0,
                unconfirmed: false,
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

    /// Settles only the first committed dispatch. Repeated identical settlement
    /// is harmless; a duplicate request cannot overwrite result or cleanup.
    pub async fn finish_operation(
        &self,
        claim: &DispatchClaim,
        outcome: OperationOutcome,
        cleanup: OperationCleanup,
    ) -> Result<OperationObservation, StoreError> {
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
        validate_settlement(&outcome, &cleanup)?;
        let cleanup_confirmed = matches!(cleanup, OperationCleanup::Confirmed);
        let custody = {
            let mut status = claim.dispatch.status.lock().unwrap();
            if status.active != 0 || (status.unconfirmed && cleanup_confirmed) {
                return Err(invalid("original operation work has not drained"));
            }
            status.closed = true;
            SettlementCustody {
                retained: status.retained.take(),
                confirmed: cleanup_confirmed,
            }
        };
        let reference = claim.reference.clone();
        let result = self
            .connection
            .write(
                WriteSettlement {
                    reference,
                    outcome,
                    cleanup,
                },
                self.commits.notice(),
            )
            .await;
        drop(custody);
        result
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
            .run(move |connection| {
                Box::pin(async move {
                    read(connection, &reference)
                        .await
                        .map(|record| record.map(|record| record.observation))
                })
            })
            .await
    }
}

pub(crate) async fn require_pending(
    connection: &mut SqliteConnection,
    reference: &RecoveryRef,
) -> Result<(), StoreError> {
    let record = read(connection, reference)
        .await?
        .ok_or_else(|| invalid("original application operation missing"))?;
    if !matches!(record.observation.outcome, OperationOutcome::Unresolved) {
        return Err(invalid("original application operation is not pending"));
    }
    Ok(())
}

#[cfg(test)]
mod tests;

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
        connection: &mut SqliteConnection,
    ) -> crate::connection::BoxFuture<'_, Result<crate::writeback::Prepared<Self::Value>, StoreError>>
    {
        Box::pin(async move {
            let Self {
                request,
                reference,
                contract_json,
                request_json,
                owner,
                dispatch,
            } = self;
            if let Some(record) = read(connection, &reference).await? {
                // The original origin remains historical observation. New request
                // authorization must be checked again by the trusted embedding.
                if record.request.consumer != request.consumer
                    || record.request.input != request.input
                {
                    return Err(StoreError::EventConflict);
                }
                return Ok(crate::writeback::Prepared {
                    value: DispatchValue(PreparedDispatch::Existing(record.observation)),
                    changed: false,
                    notification: crate::writeback::Notification::None,
                });
            }
            require_source(connection, &reference.source).await?;
            sqlx::query("INSERT INTO application_operation_contracts (digest, contract_json) VALUES (?, ?) ON CONFLICT(digest) DO NOTHING")
                        .bind(&reference.contract.digest)
                        .bind(contract_json.as_ref())
                        .execute(&mut *connection)
                        .await?;
            sqlx::query("INSERT INTO application_operations (deployment, namespace, operation, source_revision, request_json, outcome_json, cleanup_json, contract_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
                        .bind(reference.source.deployment.to_string())
                        .bind(serde_json::to_string(&reference.namespace)?)
                        .bind(reference.operation.to_string())
                        .bind(reference.source.revision as i64)
                        .bind(request_json)
                        .bind(serde_json::to_string(&OperationOutcome::Unresolved)?)
                        .bind(serde_json::to_string(&OperationCleanup::Unconfirmed)?)
                        .bind(&reference.contract.digest)
                        .execute(&mut *connection)
                        .await?;

            Ok(crate::writeback::Prepared {
                value: DispatchValue(PreparedDispatch::New {
                    reference,
                    owner,
                    dispatch,
                }),
                changed: true,
                notification: crate::writeback::Notification::Metadata,
            })
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        match value.0 {
            PreparedDispatch::New {
                reference,
                owner,
                dispatch,
            } => Dispatch::New(DispatchClaim {
                reference,
                owner: Arc::downgrade(&owner),
                dispatch,
            }),
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

pub(crate) struct WriteSettlement {
    reference: RecoveryRef,
    outcome: OperationOutcome,
    cleanup: OperationCleanup,
}
impl crate::writeback::Statement for WriteSettlement {
    type Value = OperationObservation;
    type Output = OperationObservation;
    fn execute(
        self,
        connection: &mut SqliteConnection,
    ) -> crate::connection::BoxFuture<'_, Result<crate::writeback::Prepared<Self::Value>, StoreError>>
    {
        Box::pin(async move {
            let Self {
                reference,
                outcome,
                cleanup,
            } = self;
            let old = read(connection, &reference)
                .await?
                .ok_or_else(|| invalid("original dispatch missing"))?
                .observation;
            let observation = OperationObservation {
                reference: reference.clone(),
                outcome,
                cleanup,
            };
            let changed = matches!(old.outcome, OperationOutcome::Unresolved);
            if !changed {
                if old != observation {
                    return Err(StoreError::EventConflict);
                }
            } else {
                sqlx::query("UPDATE application_operations SET outcome_json=?, cleanup_json=? WHERE deployment=? AND namespace=? AND operation=?")
                    .bind(serde_json::to_string(&observation.outcome)?).bind(serde_json::to_string(&observation.cleanup)?)
                    .bind(reference.source.deployment.to_string()).bind(serde_json::to_string(&reference.namespace)?)
                    .bind(reference.operation.to_string()).execute(&mut *connection).await?;
            }

            Ok(crate::writeback::Prepared {
                value: observation,
                changed,
                notification: crate::writeback::Notification::Metadata,
            })
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        value
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(
            error,
            StoreError::EventConflict | StoreError::InvalidTransition(_)
        )
    }
}

/// Partitions resolve this name through the immutable Root control source view;
/// standalone stores use the same local source table. Keep this in the write tx.
pub(crate) async fn require_source(
    connection: &mut SqliteConnection,
    source: &DeploymentRef,
) -> Result<(), StoreError> {
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM application_sources WHERE deployment=? AND revision=?)",
    )
    .bind(source.deployment.to_string())
    .bind(source.revision as i64)
    .fetch_one(connection)
    .await?;
    if exists {
        Ok(())
    } else {
        Err(invalid("original application source missing"))
    }
}
