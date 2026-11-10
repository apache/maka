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

//! One writer FIFO shares FULL commits across independent, typed durable statements.
//! Domain SQL stays with its owner; no effect token or notification escapes before commit.
use crate::StoreError;
use rusqlite::Connection;
use std::collections::BTreeSet;
use std::panic::{self, AssertUnwindSafe};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use tokio::sync::{oneshot, watch};

/// Synchronous domain SQL executed inside the Root writer's transaction.
/// Implementations must not start or finish transactions, perform external
/// effects, or publish effects before `committed` runs after a confirmed commit.
/// On this dedicated blocking lane, immutable input bytes may be streamed from
/// an already-owned prepared backing into SQL. This does not permit opening or
/// mutating user files, network/provider I/O, or re-entering the writer.
pub trait Statement: Send + Sized + 'static {
    type Value: Send + 'static;
    type Output: Send + 'static;
    const PREPARE_OFF_THREAD: bool = false;
    /// Drop-only owners of prepared inputs, retained through writer settlement.
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        Vec::new()
    }
    fn prepare(self) -> Result<Self, StoreError> {
        Ok(self)
    }
    fn execute(self, connection: &Connection) -> Result<Prepared<Self::Value>, StoreError>;
    // Pure domain conversion; sealed effect tokens are constructed only here.
    fn committed(value: Self::Value) -> Self::Output;
    fn isolated_rejection(error: &StoreError) -> bool;
}

/// Commit-time invalidations discovered by the statement, not a second ledger.
/// Session routes are data and are published only after the shared SQL commit.
#[derive(Default)]
pub struct Notification {
    sequence: Option<u64>,
    metadata: bool,
    activation: bool,
    material_released: bool,
    sessions: BTreeSet<String>,
    metadata_scopes: BTreeSet<String>,
}
impl Notification {
    pub const NONE: Self = Self {
        sequence: None,
        metadata: false,
        activation: false,
        material_released: false,
        sessions: BTreeSet::new(),
        metadata_scopes: BTreeSet::new(),
    };
    pub const METADATA: Self = Self {
        sequence: None,
        metadata: true,
        activation: false,
        material_released: false,
        sessions: BTreeSet::new(),
        metadata_scopes: BTreeSet::new(),
    };
    pub const MATERIAL_RELEASED: Self = Self {
        sequence: None,
        metadata: false,
        activation: false,
        material_released: true,
        sessions: BTreeSet::new(),
        metadata_scopes: BTreeSet::new(),
    };
    pub fn sequence(sequence: u64) -> Self {
        Self {
            sequence: Some(sequence),
            ..Self::NONE
        }
    }
    pub fn activation_sequence(sequence: u64) -> Self {
        Self {
            activation: true,
            ..Self::sequence(sequence)
        }
    }
    pub fn metadata_scope(scope: String) -> Self {
        Self {
            metadata_scopes: BTreeSet::from([scope]),
            ..Self::NONE
        }
    }
    pub fn with_activation(mut self, activation: bool) -> Self {
        self.activation |= activation;
        self
    }
    pub fn with_sessions(mut self, sessions: impl IntoIterator<Item = String>) -> Self {
        self.sessions.extend(sessions);
        self
    }
    /// Union every invalidation channel when pure statements share one receipt.
    pub fn combine(mut self, other: Self) -> Self {
        self.sequence = self.sequence.max(other.sequence);
        self.metadata |= other.metadata;
        self.activation |= other.activation;
        self.material_released |= other.material_released;
        self.sessions.extend(other.sessions);
        self.metadata_scopes.extend(other.metadata_scopes);
        self
    }
    fn publish(self, notice: &crate::commits::CommitNotice) {
        let has_sessions = !self.sessions.is_empty();
        let notice = notice.with_sessions(self.sessions);
        if let Some(sequence) = self.sequence {
            notice.publish(sequence);
        } else if self.metadata || has_sessions {
            notice.metadata();
        }
        for scope in self.metadata_scopes {
            notice.metadata_scope(&scope);
        }
        if self.activation {
            notice.activations();
        }
        if self.material_released {
            notice.material_released();
        }
    }
}
pub struct Prepared<T> {
    pub value: T,
    /// True when this statement wrote new durable state. False is only for an
    /// already durable or read-only result; an unchanged group is rolled back.
    pub changed: bool,
    pub notification: Notification,
}

enum State<S: Statement> {
    Waiting(S),
    Writing,
    Prepared(Prepared<S::Value>),
    Rejected { error: StoreError, isolated: bool },
}
pub(crate) struct Pending<S: Statement> {
    state: State<S>,
    commits: crate::commits::CommitNotice,
    reply: oneshot::Sender<Result<S::Output, StoreError>>,
    failures: Arc<AtomicU64>,
    retained: Vec<Arc<dyn Send + Sync>>,
}
impl<S: Statement> Pending<S> {
    pub(crate) fn new(
        statement: S,
        commits: crate::commits::CommitNotice,
        reply: oneshot::Sender<Result<S::Output, StoreError>>,
        failures: Arc<AtomicU64>,
    ) -> Self {
        let retained = statement.retain();
        Self {
            state: State::Waiting(statement),
            commits,
            reply,
            failures,
            retained,
        }
    }
    pub(crate) fn prepare(mut self) -> Self {
        let State::Waiting(statement) = std::mem::replace(&mut self.state, State::Writing) else {
            unreachable!("durable input is prepared once")
        };
        let result = panic::catch_unwind(AssertUnwindSafe(|| statement.prepare()))
            .unwrap_or_else(|_| {
                Err(StoreError::InvalidTransition(
                    "statement input preparation panicked before SQL execution; see original panic diagnostic".into(),
                ))
            });
        self.state = match result {
            Ok(statement) => State::Waiting(statement),
            Err(error) => State::Rejected {
                error,
                isolated: true,
            },
        };
        self
    }
    pub(crate) fn into_request(self) -> Request {
        Request(Box::new(self))
    }
}
impl<S: Statement> ErasedRequest for Pending<S> {
    fn prepare(&mut self, connection: &Connection) -> Result<bool, StoreError> {
        if matches!(self.state, State::Rejected { .. }) {
            return Ok(false);
        }
        let State::Waiting(statement) = std::mem::replace(&mut self.state, State::Writing) else {
            unreachable!("durable statement is prepared once")
        };
        let prepared = statement.execute(connection)?;
        let changed = prepared.changed;
        self.state = State::Prepared(prepared);
        Ok(changed)
    }
    fn isolated_rejection(&self, error: &StoreError) -> bool {
        S::isolated_rejection(error)
    }
    fn reject(&mut self, error: StoreError, isolated: bool) {
        self.state = State::Rejected { error, isolated };
    }
    fn finish(self: Box<Self>, transaction: &Result<(), Aborted>) {
        let result = match self.state {
            State::Rejected { error, isolated }
                if isolated
                    || transaction.is_ok()
                    || transaction.as_ref().is_err_and(|failure| !failure.unknown) =>
            {
                Err(error)
            }
            State::Prepared(prepared) if transaction.is_ok() => {
                prepared.notification.publish(&self.commits);
                Ok(S::committed(prepared.value))
            }
            _ => Err(transaction
                .as_ref()
                .expect_err("unprepared durable receipt")
                .error()),
        };
        if result.is_err() {
            self.failures.fetch_add(1, Ordering::AcqRel);
        }
        drop(self.retained);
        let _ = self.reply.send(result);
    }
}

// Only typed Pending values enter this erased queue; SQL and committed outputs
// remain owned by their original statement through the transaction boundary.
pub(crate) struct Request(Box<dyn ErasedRequest>);
trait ErasedRequest: Send {
    fn prepare(&mut self, connection: &Connection) -> Result<bool, StoreError>;
    fn isolated_rejection(&self, error: &StoreError) -> bool;
    fn reject(&mut self, error: StoreError, isolated: bool);
    fn finish(self: Box<Self>, transaction: &Result<(), Aborted>);
}
impl Request {
    fn prepare(&mut self, connection: &Connection) -> Result<bool, StoreError> {
        self.0.prepare(connection)
    }
    fn isolated_rejection(&self, error: &StoreError) -> bool {
        self.0.isolated_rejection(error)
    }
    fn reject(&mut self, error: StoreError, isolated: bool) {
        self.0.reject(error, isolated);
    }
    fn finish(self, transaction: &Result<(), Aborted>) {
        self.0.finish(transaction);
    }
}

struct Aborted {
    cause: Arc<StoreError>,
    unknown: bool,
    reusable: bool,
}
impl Aborted {
    fn rejected(cause: StoreError) -> Self {
        Self {
            cause: Arc::new(cause),
            unknown: false,
            reusable: false,
        }
    }
    fn error(&self) -> StoreError {
        StoreError::Shared(self.cause.clone())
    }
}
pub(crate) fn commit(
    connection: &mut Connection,
    mut requests: Vec<Request>,
    validate: &(impl Fn() -> Result<(), StoreError> + Sync),
    changed: &watch::Sender<()>,
) -> (bool, impl FnOnce() + Send + 'static) {
    let result = transaction(connection, &mut requests, validate);
    let reusable = result
        .as_ref()
        .map_or_else(|failure| failure.reusable, |_| true);
    if matches!(result, Ok(true)) {
        changed.send_replace(());
    }
    let result = result.map(|_| ());
    (reusable, move || {
        for request in requests {
            request.finish(&result);
        }
    })
}

fn transaction(
    connection: &Connection,
    requests: &mut [Request],
    validate: &(impl Fn() -> Result<(), StoreError> + Sync),
) -> Result<bool, Aborted> {
    validate().map_err(Aborted::rejected)?;
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| Aborted {
            cause: Arc::new(error.into()),
            unknown: false,
            reusable: connection.is_autocommit() && validate().is_ok(),
        })?;
    let prepared =
        panic::catch_unwind(AssertUnwindSafe(|| prepare(connection, requests, validate)));
    match prepared {
        Ok(Ok(true)) => match connection.execute_batch("COMMIT") {
            Ok(()) => Ok(true),
            Err(error) => Err(abort(
                connection,
                StoreError::CommitUnknown(error),
                true,
                validate,
            )),
        },
        Ok(Ok(false)) => {
            // Replay receipts refer to already durable results. A rejected single
            // statement may still have speculative SQL, so never commit this path.
            rollback(connection)
                .map(|()| false)
                .map_err(|error| Aborted {
                    cause: Arc::new(error.into()),
                    unknown: true,
                    reusable: false,
                })
        }
        Ok(Err(error)) => Err(abort(connection, error, false, validate)),
        Err(_) => Err(abort(
            connection,
            StoreError::OperationUnknown,
            true,
            validate,
        )),
    }
}

fn rollback(connection: &Connection) -> Result<(), rusqlite::Error> {
    if !connection.is_autocommit() {
        connection.execute_batch("ROLLBACK")?;
    }
    Ok(())
}

fn abort(
    connection: &Connection,
    cause: StoreError,
    unknown: bool,
    validate: &(impl Fn() -> Result<(), StoreError> + Sync),
) -> Aborted {
    match rollback(connection) {
        Ok(()) => Aborted {
            cause: Arc::new(cause),
            unknown,
            reusable: connection.is_autocommit() && validate().is_ok(),
        },
        Err(cleanup) => Aborted {
            cause: Arc::new(StoreError::RollbackFailed {
                cause: Arc::new(cause),
                cleanup,
            }),
            unknown: true,
            reusable: false,
        },
    }
}

fn prepare(
    connection: &Connection,
    requests: &mut [Request],
    validate: &(impl Fn() -> Result<(), StoreError> + Sync),
) -> Result<bool, StoreError> {
    let mut changed = false;
    let isolate = requests.len() > 1;
    for request in requests {
        if isolate {
            connection.execute_batch("SAVEPOINT durable_request")?;
        }
        match request.prepare(connection) {
            Ok(written) => {
                if isolate {
                    connection.execute_batch("RELEASE durable_request")?;
                }
                changed |= written;
            }
            Err(error) if request.isolated_rejection(&error) => {
                if isolate {
                    connection
                        .execute_batch("ROLLBACK TO durable_request; RELEASE durable_request")?;
                }
                request.reject(error, isolate);
            }
            Err(cause) => return Err(cause),
        }
    }
    validate()?;
    Ok(changed)
}
