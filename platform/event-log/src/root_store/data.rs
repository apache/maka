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

//! Typed native domain SQL on the original Root's physical actors.
use super::*;
use crate::{
    applications::operations::{DispatchClaim, StatementCompletion, WriteOutcome},
    connection::{BoxFuture, Query},
    writeback::{Prepared, Statement},
};
use maka_plugin_core::operation::{OperationObservation, OperationResult};

/// A trusted native domain's data ingress, never a new connection.
/// Fresh handles own no idle lease; a prepared writer retains its original work.
/// Session and Run policy belongs to the domain's Query and Statement types.
#[derive(Clone)]
pub struct DataWriter {
    owner: Weak<crate::root::RootOwner>,
    log: Weak<EventLog>,
    ingress: Ingress,
}
#[derive(Clone)]
enum Ingress {
    Fresh {
        closed: Arc<AtomicBool>,
        gates: Arc<gates::Gates>,
    },
    Accepted(SessionStore),
    Prepared(Arc<EventLog>),
}

struct Work {
    _owner: Arc<EventLog>,
    gates: Arc<gates::Gates>,
}
impl Drop for Work {
    fn drop(&mut self) {
        self.gates.finish_work();
    }
}

impl RootStore {
    /// Validate the original live owner without admitting new Root work.
    pub fn validate_data_writer(&self, writer: &DataWriter) -> Result<(), StoreError> {
        let owner = self.log.owned_root()?;
        if !writer.matches_owner(&owner) {
            return Err(StoreError::InvalidTransition(
                "foreign Root data writer".into(),
            ));
        }
        Ok(())
    }
    /// Validate a borrowed transaction against its original physical writer.
    pub fn validate_data_writer_in_transaction(
        &self,
        writer: &DataWriter,
        connection: &SqliteConnection,
    ) -> Result<(), StoreError> {
        self.validate_data_writer(writer)?;
        let log = writer.log.upgrade().ok_or(StoreError::ConnectionClosed)?;
        log.connection.require_same_writer(connection)
    }

    /// Capture this exact Root's SQL ingress. Closing it never redirects a handle
    /// to a replacement Root, and an idle handle cannot keep SQL alive.
    pub fn data_writer(&self) -> Result<DataWriter, StoreError> {
        self.require_open()?;
        Ok(DataWriter {
            owner: Arc::downgrade(self.log.root_owner.as_ref().expect("owned Root")),
            log: Arc::downgrade(&self.log),
            ingress: Ingress::Fresh {
                closed: self.closed.clone(),
                gates: self.gates.clone(),
            },
        })
    }
}
impl RootStore {
    /// Continue only the original selected work. A second opening may validate
    /// the same live owner, but never substitutes its gates or work lifetime.
    pub fn data_writer_for_work(
        &self,
        custody: &dyn maka_plugin_core::work::WorkCustody,
        session: &str,
    ) -> Result<DataWriter, StoreError> {
        let selected = self.session_for_work(custody, session)?;
        let owner = selected.owner()?;
        Ok(DataWriter {
            owner: Arc::downgrade(&owner.owned_root()?),
            log: Arc::downgrade(&owner),
            ingress: Ingress::Accepted(selected),
        })
    }
}
impl DataWriter {
    pub(in crate::root_store) fn matches_owner(&self, owner: &Arc<crate::root::RootOwner>) -> bool {
        Weak::ptr_eq(&self.owner, &Arc::downgrade(owner)) && self.owner.upgrade().is_some()
    }
    pub fn root_id(&self) -> Result<String, StoreError> {
        let owner = self.owner.upgrade().ok_or(StoreError::ConnectionClosed)?;
        owner.validate_current()?;
        Ok(owner.root_id().to_owned())
    }
    /// In-process Root affinity, including independent connections sharing the
    /// same owner. A reopened Root with the same serialized id is not this owner.
    pub fn same_root(&self, other: &Self) -> bool {
        Weak::ptr_eq(&self.owner, &other.owner) && self.owner.strong_count() != 0
    }
    pub(in crate::root_store) fn scoped(&self) -> Result<EventLog, StoreError> {
        match &self.ingress {
            Ingress::Prepared(owner) => Ok(owner.scoped(owner.clone())),
            Ingress::Fresh { closed, gates } => {
                if closed.load(Ordering::Acquire) {
                    return Err(StoreError::ConnectionClosed);
                }
                let owner = self.log.upgrade().ok_or(StoreError::ConnectionClosed)?;
                owner.validate_root()?;
                gates.start_work()?;
                let work = Arc::new(Work {
                    _owner: owner.clone(),
                    gates: gates.clone(),
                });
                Ok(owner.scoped(work))
            }
            Ingress::Accepted(selected) => {
                let owner = selected.owner()?;
                owner.validate_root()?;
                let pins = selected.work.as_ref().ok_or_else(|| {
                    StoreError::InvalidTransition(
                        "selected data ingress has no accepted work".into(),
                    )
                })?;
                Ok(owner
                    .scoped(pins.custody()?)
                    .bind_session(selected.id.clone()))
            }
        }
    }
    /// A coalescible committed-write hint. Subscribe before reading a level;
    /// the receiver owns no SQL lease or execution authority.
    pub fn subscribe_changes(&self) -> Result<tokio::sync::watch::Receiver<()>, StoreError> {
        Ok(self.scoped()?.connection.subscribe_changes())
    }
    /// Use the Root's bounded read lanes. Once enqueued, the actual SQL job owns
    /// its Root work pin even if this observing future disappears.
    pub async fn query<Q: Query>(&self, query: Q) -> Result<Q::Output, StoreError> {
        self.scoped()?
            .connection
            .read(move |connection| {
                let snapshot = connection.unchecked_transaction()?;
                let output = query.execute(&snapshot)?;
                snapshot.commit()?;
                Ok(output)
            })
            .await
    }
    /// Observe after previously accepted jobs settle on this original writer FIFO.
    pub async fn query_barrier<Q: Query>(&self, query: Q) -> Result<Q::Output, StoreError> {
        self.scoped()?
            .connection
            .run(move |connection| {
                let snapshot = connection.unchecked_transaction()?;
                let output = query.execute(&snapshot)?;
                snapshot.commit()?;
                Ok(output)
            })
            .await
    }
    /// Join the existing bounded writer FIFO and its IMMEDIATE/FULL commit.
    /// Only the committed output escapes; no script or callback is replayed.
    pub async fn write<S: Statement>(&self, statement: S) -> Result<S::Output, StoreError> {
        let log = self.scoped()?;
        log.connection.write(statement, log.commits.notice()).await
    }
}

/// A pure statement bound to its original physical Root. This is neither
/// serializable nor permission to execute; commit requires the original claim.
pub struct DataChange {
    log: Weak<EventLog>,
    statement: Box<dyn DeferredStatement>,
}
type OutputValidator = Box<dyn Fn(&serde_json::Value) -> Result<(), StoreError> + Send>;
enum Completion {
    Fixed(OperationResult),
    Computed(OutputValidator),
}
trait DeferredStatement: Send {
    fn commit<'a>(
        self: Box<Self>,
        log: EventLog,
        claim: &'a DispatchClaim,
        completion: Completion,
    ) -> BoxFuture<'a, Result<OperationObservation, StoreError>>;
}
struct FixedStatement<S>(S);
struct ResultStatement<S>(S);
impl<S: Statement> DeferredStatement for FixedStatement<S> {
    fn commit<'a>(
        self: Box<Self>,
        log: EventLog,
        claim: &'a DispatchClaim,
        completion: Completion,
    ) -> BoxFuture<'a, Result<OperationObservation, StoreError>> {
        Box::pin(async move {
            let Completion::Fixed(result) = completion else {
                return Err(StoreError::InvalidTransition(
                    "fixed statement requires its original result".into(),
                ));
            };
            log.commit_statement(claim, self.0, result).await
        })
    }
}
impl<S: Statement<Value = serde_json::Value>> DeferredStatement for ResultStatement<S> {
    fn commit<'a>(
        self: Box<Self>,
        log: EventLog,
        claim: &'a DispatchClaim,
        completion: Completion,
    ) -> BoxFuture<'a, Result<OperationObservation, StoreError>> {
        Box::pin(async move {
            let Completion::Computed(validate) = completion else {
                return Err(StoreError::InvalidTransition(
                    "computed statement requires output validation".into(),
                ));
            };
            log.commit_completion(claim, self.0, ComputedResult(validate))
                .await
        })
    }
}
impl DataWriter {
    /// Pure description only: no Root upgrade, work pin, statement preparation,
    /// or SQL. Final completion uses the original admitted operation's custody.
    pub fn prepare<S: Statement>(&self, statement: S) -> DataChange {
        DataChange {
            log: self.log.clone(),
            statement: Box::new(FixedStatement(statement)),
        }
    }

    /// Bind a pure SQL result to this exact accepted writer. The builder runs
    /// once before SQL; its writer keeps the original custody through settlement.
    /// It constructs the statement only, without executing domain work.
    pub fn prepare_result<S: Statement<Value = serde_json::Value>>(
        &self,
        build: impl FnOnce(DataWriter) -> Result<S, StoreError>,
    ) -> Result<DataChange, StoreError> {
        let custody = Arc::new(self.scoped()?);
        let selected = DataWriter {
            owner: self.owner.clone(),
            log: self.log.clone(),
            ingress: Ingress::Prepared(custody.clone()),
        };
        let statement = ScopedResult {
            statement: build(selected)?,
            custody,
        };
        Ok(DataChange {
            log: self.log.clone(),
            statement: Box::new(ResultStatement(statement)),
        })
    }
}
struct ScopedResult<S> {
    statement: S,
    custody: Arc<EventLog>,
}
impl<S: Statement> Statement for ScopedResult<S> {
    type Value = S::Value;
    type Output = S::Output;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut retained = self.statement.retain();
        retained.push(self.custody.clone());
        retained
    }
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.statement = self.statement.prepare()?;
        Ok(self)
    }
    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<Self::Value>, StoreError> {
        self.custody.connection.require_same_writer(connection)?;
        self.custody.owned_root()?;
        self.statement.execute(connection)
    }
    fn committed(value: Self::Value) -> Self::Output {
        S::committed(value)
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error)
    }
}
impl DataChange {
    pub async fn commit(
        self,
        claim: &DispatchClaim,
        result: OperationResult,
    ) -> Result<OperationObservation, StoreError> {
        self.commit_completion(claim, Completion::Fixed(result))
            .await
    }
    /// Validate the actual SQL result before the same transaction writes Returned.
    pub async fn commit_result(
        self,
        claim: &DispatchClaim,
        validate: impl Fn(&serde_json::Value) -> Result<(), StoreError> + Send + 'static,
    ) -> Result<OperationObservation, StoreError> {
        self.commit_completion(claim, Completion::Computed(Box::new(validate)))
            .await
    }
    async fn commit_completion(
        self,
        claim: &DispatchClaim,
        completion: Completion,
    ) -> Result<OperationObservation, StoreError> {
        let owner = self.log.upgrade().ok_or(StoreError::ConnectionClosed)?;
        owner.validate_root()?;
        self.statement
            .commit(owner.scoped(owner.clone()), claim, completion)
            .await
    }
}
trait CompletionResult<T>: Send + 'static {
    fn expected(&self) -> Option<&OperationResult>;
    fn result(self, value: &T) -> Result<OperationResult, StoreError>;
}
struct FixedResult(OperationResult);
impl<T> CompletionResult<T> for FixedResult {
    fn expected(&self) -> Option<&OperationResult> {
        Some(&self.0)
    }
    fn result(self, _: &T) -> Result<OperationResult, StoreError> {
        Ok(self.0)
    }
}
struct ComputedResult(OutputValidator);
impl CompletionResult<serde_json::Value> for ComputedResult {
    fn expected(&self) -> Option<&OperationResult> {
        None
    }
    fn result(self, value: &serde_json::Value) -> Result<OperationResult, StoreError> {
        (self.0)(value)?;
        Ok(OperationResult::Success {
            value: value.clone(),
        })
    }
}
struct WithOutcome<S, R> {
    statement: S,
    completion: StatementCompletion,
    result: R,
}
struct CombinedValue<T> {
    outcome: <WriteOutcome as Statement>::Value,
    state: Option<T>,
}
impl<S: Statement, R: CompletionResult<S::Value>> Statement for WithOutcome<S, R> {
    type Value = CombinedValue<S::Value>;
    type Output = OperationObservation;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD || WriteOutcome::PREPARE_OFF_THREAD;
    fn prepare(self) -> Result<Self, StoreError> {
        Ok(Self {
            statement: self.statement.prepare()?,
            completion: self.completion,
            result: self.result,
        })
    }
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        self.statement.retain()
    }
    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<Self::Value>, StoreError> {
        if let Some(original) = self
            .completion
            .existing(connection, self.result.expected())?
        {
            return Ok(Prepared {
                value: CombinedValue {
                    outcome: original.value,
                    state: None,
                },
                changed: false,
                notification: original.notification,
            });
        }
        let state = self.statement.execute(connection)?;
        let result = self.result.result(&state.value)?;
        let outcome = self.completion.returned(result).execute(connection)?;
        Ok(Prepared {
            value: CombinedValue {
                outcome: outcome.value,
                state: Some(state.value),
            },
            changed: outcome.changed || state.changed,
            notification: outcome.notification.combine(state.notification),
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        let state = value.state.map(S::committed);
        let observation = WriteOutcome::committed(value.outcome);
        drop(state);
        observation
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        matches!(error.underlying(), StoreError::StatementRejected { .. })
            || S::isolated_rejection(error)
            || WriteOutcome::isolated_rejection(error)
    }
}
impl EventLog {
    pub(crate) async fn commit_statement<S: Statement>(
        &self,
        claim: &DispatchClaim,
        statement: S,
        result: OperationResult,
    ) -> Result<OperationObservation, StoreError> {
        self.commit_completion(claim, statement, FixedResult(result))
            .await
    }
    async fn commit_completion<S: Statement, R: CompletionResult<S::Value>>(
        &self,
        claim: &DispatchClaim,
        statement: S,
        result: R,
    ) -> Result<OperationObservation, StoreError> {
        let completion = self.prepare_statement_completion(claim)?;
        self.connection
            .write(
                WithOutcome {
                    statement,
                    completion,
                    result,
                },
                self.commits.notice(),
            )
            .await
    }
}
