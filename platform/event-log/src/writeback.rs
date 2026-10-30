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
use crate::{StoreError, connection::BoxFuture};
use sqlx::{Connection, SqliteConnection, sqlite::SqliteTransactionManager};
use sqlx_core::transaction::TransactionManager;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use tokio::sync::oneshot;

pub(crate) trait Statement: Send + Sized + 'static {
    type Value: Send + 'static;
    type Output: Send + 'static;
    fn execute(
        self,
        connection: &mut SqliteConnection,
    ) -> BoxFuture<'_, Result<Prepared<Self::Value>, StoreError>>;
    // Pure domain conversion; sealed effect tokens are constructed only here.
    fn committed(value: Self::Value) -> Self::Output;
    fn isolated_rejection(error: &StoreError) -> bool;
    // The original Run domains remain usable after a confirmed full rollback.
    // Pure observation requests retain their stricter owner-retirement policy.
    fn reusable_after_rollback(&self) -> bool {
        true
    }
}

pub(crate) enum Notification {
    None,
    Metadata,
    Sequence(u64),
    NativeApprovalSequence(u64),
}
pub(crate) struct Prepared<T> {
    pub value: T,
    pub changed: bool,
    pub notification: Notification,
}

enum State<S: Statement> {
    Waiting(S),
    Entering(S),
    Writing,
    Prepared(Prepared<S::Value>),
    Rejected { error: StoreError, isolated: bool },
}
pub(crate) struct Pending<S: Statement> {
    reusable_after_rollback: bool,
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
            reusable_after_rollback: statement.reusable_after_rollback(),
            state: State::Waiting(statement),
            commits,
            reply,
            failures,
        }
    }
    fn enter(&mut self) {
        let State::Waiting(statement) = std::mem::replace(&mut self.state, State::Writing) else {
            unreachable!("durable statement enters once")
        };
        self.state = State::Entering(statement);
    }
    async fn prepare(&mut self, connection: &mut SqliteConnection) -> Result<bool, PrepareFailure> {
        let State::Entering(statement) = std::mem::replace(&mut self.state, State::Writing) else {
            unreachable!("durable statement is prepared once")
        };
        let reusable = self.reusable_after_rollback;
        let prepared = statement
            .execute(connection)
            .await
            .map_err(|cause| PrepareFailure { cause, reusable })?;
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
                    Notification::NativeApprovalSequence(sequence) => {
                        self.commits.publish(sequence);
                        self.commits.native_approvals();
                    }
                    Notification::Sequence(sequence) => {
                        self.commits.publish(sequence);
                    }
                }
                Ok(S::committed(prepared.value))
            }
            state => Err(transaction
                .as_ref()
                .expect_err("unprepared durable receipt")
                .error(!matches!(state, State::Waiting(_)))),
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
    fn reusable_after_rollback(&self) -> bool {
        match self {
            Self::ProjectRegistration(value) => value.reusable_after_rollback,
            Self::WorkspaceAttachment(value) => value.reusable_after_rollback,
            Self::Creation(value) => value.reusable_after_rollback,
            Self::Reservation(value) => value.reusable_after_rollback,
            Self::Publication(value) => value.reusable_after_rollback,

            Self::Intent(value) => value.reusable_after_rollback,
            Self::Dispatch(value) => value.reusable_after_rollback,
            Self::Admission(value) => value.reusable_after_rollback,
            Self::Append(value) => value.reusable_after_rollback,
            Self::Settlement(value) => value.reusable_after_rollback,
        }
    }
    fn enter(&mut self) {
        match self {
            Self::ProjectRegistration(value) => value.enter(),
            Self::WorkspaceAttachment(value) => value.enter(),
            Self::Creation(value) => value.enter(),
            Self::Reservation(value) => value.enter(),
            Self::Publication(value) => value.enter(),

            Self::Intent(value) => value.enter(),
            Self::Dispatch(value) => value.enter(),
            Self::Admission(value) => value.enter(),
            Self::Append(value) => value.enter(),
            Self::Settlement(value) => value.enter(),
        }
    }
    async fn prepare(&mut self, connection: &mut SqliteConnection) -> Result<bool, PrepareFailure> {
        match self {
            Self::ProjectRegistration(value) => value.prepare(connection).await,
            Self::WorkspaceAttachment(value) => value.prepare(connection).await,
            Self::Creation(value) => value.prepare(connection).await,
            Self::Reservation(value) => value.prepare(connection).await,
            Self::Publication(value) => value.prepare(connection).await,

            Self::Intent(value) => value.prepare(connection).await,
            Self::Dispatch(value) => value.prepare(connection).await,
            Self::Admission(value) => value.prepare(connection).await,
            Self::Append(value) => value.prepare(connection).await,
            Self::Settlement(value) => value.prepare(connection).await,
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

#[derive(Debug)]
struct Failure {
    cause: StoreError,
    cleanup: Option<sqlx::Error>,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.cause.fmt(formatter)?;
        if let Some(cleanup) = &self.cleanup {
            write!(formatter, "; rollback unconfirmed: {cleanup}")?;
        }
        Ok(())
    }
}
impl std::error::Error for Failure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match &self.cause {
            StoreError::Sqlx(error) | StoreError::CommitUnknown(error) => Some(error),
            error => Some(error),
        }
    }
}
struct Aborted {
    failure: Arc<Failure>,
    unknown: bool,
    reusable: bool,
}
// Only statement-body errors may retain the original Run reuse policy. Boundary,
// authority and cleanup failures always retire the connection.
struct PrepareFailure {
    cause: StoreError,
    reusable: bool,
}
impl From<StoreError> for PrepareFailure {
    fn from(cause: StoreError) -> Self {
        Self {
            cause,
            reusable: false,
        }
    }
}
impl From<sqlx::Error> for PrepareFailure {
    fn from(cause: sqlx::Error) -> Self {
        StoreError::from(cause).into()
    }
}

/// Keep SQLite's error category and extended code when several receipts share
/// the same original failure. Callers still inspect `as_database_error()`.
#[derive(Debug)]
struct SharedDatabaseError(Arc<Failure>);

impl SharedDatabaseError {
    fn database(&self) -> &dyn sqlx::error::DatabaseError {
        let (StoreError::Sqlx(error) | StoreError::CommitUnknown(error)) = &self.0.cause else {
            unreachable!("shared database failure")
        };
        error.as_database_error().expect("original database error")
    }
}
impl std::fmt::Display for SharedDatabaseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self.database(), formatter)?;
        if let Some(cleanup) = &self.0.cleanup {
            write!(formatter, "; rollback unconfirmed: {cleanup}")?;
        }
        Ok(())
    }
}
impl std::error::Error for SharedDatabaseError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.database().as_error())
    }
}
impl sqlx::error::DatabaseError for SharedDatabaseError {
    fn message(&self) -> &str {
        self.database().message()
    }
    fn code(&self) -> Option<std::borrow::Cow<'_, str>> {
        self.database().code()
    }
    fn kind(&self) -> sqlx::error::ErrorKind {
        self.database().kind()
    }
    fn as_error(&self) -> &(dyn std::error::Error + Send + Sync + 'static) {
        self
    }
    fn as_error_mut(&mut self) -> &mut (dyn std::error::Error + Send + Sync + 'static) {
        self
    }
    fn into_error(self: Box<Self>) -> Box<dyn std::error::Error + Send + Sync + 'static> {
        self
    }
}

impl Aborted {
    fn rejected(error: StoreError) -> Self {
        Self {
            failure: Arc::new(Failure {
                cause: error,
                cleanup: None,
            }),
            unknown: false,
            reusable: false,
        }
    }
    fn error(&self, started: bool) -> StoreError {
        // Preserve the original causal chain while sharing one transaction failure.
        let error = match &self.failure.cause {
            StoreError::Sqlx(error) | StoreError::CommitUnknown(error)
                if error.as_database_error().is_some() =>
            {
                sqlx::Error::Database(Box::new(SharedDatabaseError(self.failure.clone())))
            }
            _ => sqlx::Error::Io(std::io::Error::other(self.failure.clone())),
        };
        if self.unknown && started {
            StoreError::CommitUnknown(error)
        } else if let StoreError::Io(original) = &self.failure.cause {
            StoreError::Io(std::io::Error::new(original.kind(), self.failure.clone()))
        } else {
            StoreError::Sqlx(error)
        }
    }
}

pub(crate) async fn commit(
    connection: &mut SqliteConnection,
    mut requests: Vec<Request>,
    validate: &(impl Fn() -> Result<(), StoreError> + Sync),
) -> bool {
    let result = transaction(connection, &mut requests, validate).await;
    let reusable = result
        .as_ref()
        .map_or_else(|failure| failure.reusable, |()| true);
    for request in requests {
        request.finish(&result);
    }
    reusable
}

async fn transaction(
    connection: &mut SqliteConnection,
    requests: &mut [Request],
    validate: &(impl Fn() -> Result<(), StoreError> + Sync),
) -> Result<(), Aborted> {
    validate().map_err(Aborted::rejected)?;
    let recover_commit = requests.iter().all(Request::reusable_after_rollback);
    let mut tx = connection
        .begin_with("BEGIN IMMEDIATE")
        .await
        .map_err(|error| Aborted::rejected(error.into()))?;
    match prepare(&mut tx, requests, validate).await {
        Ok(true) => match tx.commit().await {
            Ok(()) => Ok(()),
            Err(error) => {
                // A failed COMMIT still produces no token. For the original Run
                // domains, explicitly await SQLx's rollback acknowledgment after
                // the consumed transaction's queued cleanup; Drop is no receipt.
                let (cleanup, reusable) = if recover_commit {
                    match SqliteTransactionManager::rollback(connection).await {
                        Ok(()) => (None, !connection.is_in_transaction() && validate().is_ok()),
                        Err(cleanup) => (Some(cleanup), false),
                    }
                } else {
                    (None, false)
                };
                Err(Aborted {
                    failure: Arc::new(Failure {
                        cause: StoreError::CommitUnknown(error),
                        cleanup,
                    }),
                    unknown: true,
                    reusable,
                })
            }
        },
        Ok(false) => tx.rollback().await.map_err(|error| Aborted {
            failure: Arc::new(Failure {
                cause: error.into(),
                cleanup: None,
            }),
            unknown: true,
            reusable: false,
        }),
        Err(error) => {
            let rollback = tx.rollback().await;
            Err(match rollback {
                Ok(()) => {
                    let reusable = error.reusable && validate().is_ok();
                    let mut failure = Aborted::rejected(error.cause);
                    failure.reusable = reusable;
                    failure
                }
                Err(cleanup) => Aborted {
                    failure: Arc::new(Failure {
                        cause: error.cause,
                        cleanup: Some(cleanup),
                    }),
                    unknown: true,
                    reusable: false,
                },
            })
        }
    }
}

async fn prepare(
    connection: &mut SqliteConnection,
    requests: &mut [Request],
    validate: &(impl Fn() -> Result<(), StoreError> + Sync),
) -> Result<bool, PrepareFailure> {
    let mut changed = false;
    let isolate = requests.len() > 1;
    for request in requests {
        validate()?;
        request.enter();
        if isolate {
            sqlx::query("SAVEPOINT durable_request")
                .execute(&mut *connection)
                .await?;
        }
        match request.prepare(connection).await {
            Ok(written) => {
                if isolate {
                    sqlx::query("RELEASE durable_request")
                        .execute(&mut *connection)
                        .await?;
                }
                changed |= written;
            }
            Err(error) if request.isolated_rejection(&error.cause) => {
                if isolate {
                    sqlx::query("ROLLBACK TO durable_request")
                        .execute(&mut *connection)
                        .await?;
                    sqlx::query("RELEASE durable_request")
                        .execute(&mut *connection)
                        .await?;
                }
                request.reject(error.cause, isolate);
            }
            Err(error) => return Err(error),
        }
    }
    validate()?;
    Ok(changed)
}

#[cfg(test)]
mod tests;
