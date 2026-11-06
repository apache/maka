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
use std::panic::{self, AssertUnwindSafe};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use tokio::sync::oneshot;

pub(crate) trait Statement: Send + Sized + 'static {
    type Value: Send + 'static;
    type Output: Send + 'static;
    const PREPARE_OFF_THREAD: bool = false;
    fn prepare(self) -> Result<Self, StoreError> {
        Ok(self)
    }
    fn execute(self, connection: &Connection) -> Result<Prepared<Self::Value>, StoreError>;
    // Pure domain conversion; sealed effect tokens are constructed only here.
    fn committed(value: Self::Value) -> Self::Output;
    fn isolated_rejection(error: &StoreError) -> bool;
}

pub(crate) enum Notification {
    None,
    Metadata,
    Sequence(u64),
    ActivationSequence(u64),
}
pub(crate) struct Prepared<T> {
    pub value: T,
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
}
impl<S: Statement> Pending<S> {
    pub(crate) fn new(
        statement: S,
        commits: crate::commits::CommitNotice,
        reply: oneshot::Sender<Result<S::Output, StoreError>>,
        failures: Arc<AtomicU64>,
    ) -> Self {
        Self {
            state: State::Waiting(statement),
            commits,
            reply,
            failures,
        }
    }
    fn prepare(&mut self, connection: &Connection) -> Result<bool, StoreError> {
        let State::Waiting(statement) = std::mem::replace(&mut self.state, State::Writing) else {
            unreachable!("durable statement is prepared once")
        };
        let prepared = statement.execute(connection)?;
        let changed = prepared.changed;
        self.state = State::Prepared(prepared);
        Ok(changed)
    }
    fn reject(&mut self, error: StoreError, isolated: bool) {
        self.state = State::Rejected { error, isolated };
    }
    fn finish(self, transaction: &Result<(), Aborted>) {
        let result = match self.state {
            State::Rejected { error, isolated }
                if isolated
                    || transaction.is_ok()
                    || transaction.as_ref().is_err_and(|failure| !failure.unknown) =>
            {
                Err(error)
            }
            State::Prepared(prepared) if transaction.is_ok() => {
                match prepared.notification {
                    Notification::None => {}
                    Notification::Metadata => self.commits.metadata(),
                    Notification::ActivationSequence(sequence) => {
                        self.commits.publish(sequence);
                        self.commits.activations();
                    }
                    Notification::Sequence(sequence) => {
                        self.commits.publish(sequence);
                    }
                }
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
        let _ = self.reply.send(result);
    }
}

// This closed family is the admission contract. Arbitrary Run closures never join it.
pub(crate) enum Request {
    ProjectRegistration(Box<Pending<crate::projects::WriteRegistration>>),
    WorkspaceAttachment(Box<Pending<crate::workspace_bindings::WriteAttachment>>),
    Creation(Box<Pending<crate::root_store::creation::WriteCreation>>),
    Reservation(Box<Pending<crate::root_store::creation::WriteReservation>>),
    Publication(Box<Pending<crate::root_store::creation::WritePublication>>),

    Intent(Box<Pending<crate::applications::intents::WriteIntent>>),
    Dispatch(Box<Pending<crate::applications::operations::WriteDispatch>>),
    Admission(Box<Pending<crate::message_admissions::WriteAdmission>>),
    Append(Box<Pending<crate::append::write::WriteAppend>>),
    Settlement(Box<Pending<crate::applications::operations::WriteSettlement>>),
}
impl Request {
    fn prepare(&mut self, connection: &Connection) -> Result<bool, StoreError> {
        match self {
            Self::ProjectRegistration(value) => value.prepare(connection),
            Self::WorkspaceAttachment(value) => value.prepare(connection),
            Self::Creation(value) => value.prepare(connection),
            Self::Reservation(value) => value.prepare(connection),
            Self::Publication(value) => value.prepare(connection),

            Self::Intent(value) => value.prepare(connection),
            Self::Dispatch(value) => value.prepare(connection),
            Self::Admission(value) => value.prepare(connection),
            Self::Append(value) => value.prepare(connection),
            Self::Settlement(value) => value.prepare(connection),
        }
    }
    fn isolated_rejection(&self, error: &StoreError) -> bool {
        match self {
            Self::ProjectRegistration(_) => {
                crate::projects::WriteRegistration::isolated_rejection(error)
            }
            Self::WorkspaceAttachment(_) => {
                crate::workspace_bindings::WriteAttachment::isolated_rejection(error)
            }
            Self::Creation(_) => {
                crate::root_store::creation::WriteCreation::isolated_rejection(error)
            }
            Self::Reservation(_) => {
                crate::root_store::creation::WriteReservation::isolated_rejection(error)
            }
            Self::Publication(_) => {
                crate::root_store::creation::WritePublication::isolated_rejection(error)
            }

            Self::Intent(_) => crate::applications::intents::WriteIntent::isolated_rejection(error),
            Self::Dispatch(_) => {
                crate::applications::operations::WriteDispatch::isolated_rejection(error)
            }
            Self::Admission(_) => {
                crate::message_admissions::WriteAdmission::isolated_rejection(error)
            }
            Self::Append(_) => crate::append::write::WriteAppend::isolated_rejection(error),
            Self::Settlement(_) => {
                crate::applications::operations::WriteSettlement::isolated_rejection(error)
            }
        }
    }
    fn reject(&mut self, error: StoreError, isolated: bool) {
        match self {
            Self::ProjectRegistration(value) => value.reject(error, isolated),
            Self::WorkspaceAttachment(value) => value.reject(error, isolated),
            Self::Creation(value) => value.reject(error, isolated),
            Self::Reservation(value) => value.reject(error, isolated),
            Self::Publication(value) => value.reject(error, isolated),

            Self::Intent(value) => value.reject(error, isolated),
            Self::Dispatch(value) => value.reject(error, isolated),
            Self::Admission(value) => value.reject(error, isolated),
            Self::Append(value) => value.reject(error, isolated),
            Self::Settlement(value) => value.reject(error, isolated),
        }
    }
    fn finish(self, result: &Result<(), Aborted>) {
        match self {
            Self::ProjectRegistration(value) => value.finish(result),
            Self::WorkspaceAttachment(value) => value.finish(result),
            Self::Creation(value) => value.finish(result),
            Self::Reservation(value) => value.finish(result),
            Self::Publication(value) => value.finish(result),

            Self::Intent(value) => value.finish(result),
            Self::Dispatch(value) => value.finish(result),
            Self::Admission(value) => value.finish(result),
            Self::Append(value) => value.finish(result),
            Self::Settlement(value) => value.finish(result),
        }
    }
}
impl From<Pending<crate::projects::WriteRegistration>> for Request {
    fn from(value: Pending<crate::projects::WriteRegistration>) -> Self {
        Self::ProjectRegistration(Box::new(value))
    }
}
impl From<Pending<crate::workspace_bindings::WriteAttachment>> for Request {
    fn from(value: Pending<crate::workspace_bindings::WriteAttachment>) -> Self {
        Self::WorkspaceAttachment(Box::new(value))
    }
}
impl From<Pending<crate::root_store::creation::WriteCreation>> for Request {
    fn from(value: Pending<crate::root_store::creation::WriteCreation>) -> Self {
        Self::Creation(Box::new(value))
    }
}
impl From<Pending<crate::root_store::creation::WriteReservation>> for Request {
    fn from(value: Pending<crate::root_store::creation::WriteReservation>) -> Self {
        Self::Reservation(Box::new(value))
    }
}
impl From<Pending<crate::root_store::creation::WritePublication>> for Request {
    fn from(value: Pending<crate::root_store::creation::WritePublication>) -> Self {
        Self::Publication(Box::new(value))
    }
}
impl From<Pending<crate::applications::intents::WriteIntent>> for Request {
    fn from(value: Pending<crate::applications::intents::WriteIntent>) -> Self {
        Self::Intent(Box::new(value))
    }
}
impl From<Pending<crate::applications::operations::WriteDispatch>> for Request {
    fn from(value: Pending<crate::applications::operations::WriteDispatch>) -> Self {
        Self::Dispatch(Box::new(value))
    }
}
impl From<Pending<crate::message_admissions::WriteAdmission>> for Request {
    fn from(value: Pending<crate::message_admissions::WriteAdmission>) -> Self {
        Self::Admission(Box::new(value))
    }
}
impl From<Pending<crate::append::write::WriteAppend>> for Request {
    fn from(value: Pending<crate::append::write::WriteAppend>) -> Self {
        Self::Append(Box::new(value))
    }
}
impl From<Pending<crate::applications::operations::WriteSettlement>> for Request {
    fn from(value: Pending<crate::applications::operations::WriteSettlement>) -> Self {
        Self::Settlement(Box::new(value))
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
) -> bool {
    let result = transaction(connection, &mut requests, validate);
    let reusable = result
        .as_ref()
        .map_or_else(|failure| failure.reusable, |()| true);
    for request in requests {
        request.finish(&result);
    }
    reusable
}

fn transaction(
    connection: &Connection,
    requests: &mut [Request],
    validate: &(impl Fn() -> Result<(), StoreError> + Sync),
) -> Result<(), Aborted> {
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
            Ok(()) => Ok(()),
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
            rollback(connection).map_err(|error| Aborted {
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

#[cfg(test)]
mod tests;
