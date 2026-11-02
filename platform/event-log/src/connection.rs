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

use std::{
    future::Future,
    panic::AssertUnwindSafe,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};

mod authority;
mod stats;
pub use stats::{ConnectionResourceStats, SqliteResourceStats};
pub(crate) mod control;
pub(crate) mod custody;
use control::ReadOnlyControl;
use custody::{Custody, Retained};
#[cfg(test)]
mod cancellation;
#[cfg(test)]
mod worker_callback;
pub use authority::ConnectionAuthority;

use futures_util::{FutureExt, future::Shared};
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use tokio::sync::{Semaphore, mpsc, oneshot, watch};

use crate::StoreError;
use tokio_util::sync::CancellationToken;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Execute only immediately-ready SQLx queries and CPU work on the original
/// SQLite worker. Transaction lifetime stays with the enclosing owner job.
/// Polling once makes accidental external asynchronous work fail closed rather
/// than blocking the worker on itself or introducing a second executor runtime.
pub(crate) async fn worker_query<T: Send + 'static>(
    connection: &mut SqliteConnection,
    operation: impl for<'a, 'b> FnOnce(
        &'a mut sqlx::sqlite::SqliteWorkerConnection<'b>,
    ) -> BoxFuture<'a, Result<T, StoreError>>
    + Send
    + 'static,
) -> Result<T, StoreError> {
    connection
        .run_with_connection(move |worker| {
            operation(worker)
                .now_or_never()
                .expect("SQLite worker query unexpectedly yielded")
        })
        .await?
}

type Job = Box<
    dyn for<'c> FnOnce(&'c mut SqliteConnection, Result<(), StoreError>) -> BoxFuture<'c, ()>
        + Send,
>;
// Returns whether the connection remains reusable after this accepted job.
type ExecuteRead = Box<
    dyn for<'c> FnOnce(Result<&'c mut SqliteConnection, StoreError>) -> BoxFuture<'c, bool> + Send,
>;
type ObserveRead = Box<
    dyn for<'c> FnOnce(
            usize,
            Result<Option<&'c mut SqliteConnection>, StoreError>,
        ) -> BoxFuture<'c, bool>
        + Send,
>;
#[derive(Clone, Copy)]
enum ReaderRole {
    Read,
    Observation,
}

enum ReadJob {
    Execute(ExecuteRead),
    Observe(ObserveRead),
}
struct ReadEnvelope {
    job: ReadJob,
    custody: Option<Custody>,
}

enum Command {
    Pinned(Box<Command>, Custody),
    Run(Job),
    Write(crate::writeback::Request),
    Shutdown,
}

impl Command {
    fn pinned(self, custody: &Option<Custody>) -> Self {
        match custody {
            Some(custody) => Self::Pinned(Box::new(self), custody.clone()),
            None => self,
        }
    }
    fn is_write(&self) -> bool {
        match self {
            Self::Pinned(command, _) => command.is_write(),
            Self::Write(_) => true,
            _ => false,
        }
    }
    fn retain(self, retained: &Retained) -> Self {
        match self {
            Self::Pinned(command, custody) => {
                retained.hold(0, custody);
                command.retain(retained)
            }
            command => command,
        }
    }
}

/// Ingress is bounded; accepted work and the database lease belong to a dedicated
/// thread, independent of the caller's executor. Dropping ingress drains work.
pub struct OwnedConnection {
    failures: Arc<AtomicU64>,
    jobs: mpsc::Sender<Command>,
    read_jobs: mpsc::Sender<ReadEnvelope>,
    observation_jobs: mpsc::Sender<ReadEnvelope>,
    writer_stop: CancellationToken,
    closed: Shared<BoxFuture<'static, Result<(), String>>>,
    readers: Arc<Semaphore>,
    observations: Arc<Semaphore>,
    changes: watch::Receiver<()>,
    custody: Option<Custody>,
}

/// Short writer observations can be sent from a reader without retaining a
/// second database owner or its reader/shutdown authority.
#[derive(Clone)]
pub(crate) struct WriterIngress {
    jobs: mpsc::Sender<Command>,
    failures: Arc<AtomicU64>,
    custody: Option<Custody>,
}

/// Already accepted lifecycle work retains cleanup admission through shutdown.
/// This ingress cannot read arbitrary state or retain the owner's close authority.
pub(crate) struct ObservationIngress {
    jobs: mpsc::Sender<ReadEnvelope>,
    custody: Option<Custody>,
}

impl ObservationIngress {
    pub(crate) async fn purge_session(&self, session: String) -> Result<(), StoreError> {
        let (reply, result) = oneshot::channel();
        self.jobs
            .send(ReadEnvelope {
                custody: self.custody.clone(),
                job: ReadJob::Observe(Box::new(move |_, connection| {
                    Box::pin(async move {
                        let purged = AssertUnwindSafe(async {
                            match connection {
                                Ok(Some(connection)) => {
                                    crate::transcript::purge_cache(connection, &session).await
                                }
                                Ok(None) => Ok(()),
                                Err(error) => Err(error),
                            }
                        })
                        .catch_unwind()
                        .await;
                        let reusable = !matches!(
                            &purged,
                            Err(_) | Ok(Err(StoreError::Sqlx(sqlx::Error::WorkerCrashed)))
                        );
                        let _ = reply.send(purged.unwrap_or(Err(StoreError::OperationUnknown)));
                        reusable
                    })
                })),
            })
            .await
            .map_err(|_| StoreError::ConnectionClosed)?;
        result.await.map_err(|_| StoreError::OperationUnknown)?
    }
}

impl WriterIngress {
    pub(crate) async fn write<S: crate::writeback::Statement>(
        &self,
        statement: S,
        commits: crate::commits::CommitNotice,
    ) -> Result<S::Output, StoreError>
    where
        crate::writeback::Request: From<crate::writeback::Pending<S>>,
    {
        let (reply, result) = oneshot::channel();
        self.jobs
            .send(
                Command::Write(
                    crate::writeback::Pending::new(
                        statement,
                        commits,
                        reply,
                        self.failures.clone(),
                    )
                    .into(),
                )
                .pinned(&self.custody),
            )
            .await
            .map_err(|_| StoreError::ConnectionClosed)?;
        result.await.map_err(|_| StoreError::OperationUnknown)?
    }

    #[cfg(test)]
    pub(crate) fn failures(&self) -> u64 {
        self.failures.load(Ordering::Acquire)
    }

    pub(crate) async fn run<T: Send + 'static>(
        &self,
        operation: impl for<'c> FnOnce(&'c mut SqliteConnection) -> BoxFuture<'c, Result<T, StoreError>>
        + Send
        + 'static,
    ) -> Result<T, StoreError> {
        let (reply, result) = oneshot::channel();
        let failures = self.failures.clone();
        self.jobs
            .send(
                Command::Run(Box::new(move |connection, valid| {
                    Box::pin(async move {
                        let result = match valid {
                            Ok(()) => operation(connection).await,
                            Err(error) => Err(error),
                        };
                        if result.is_err() {
                            failures.fetch_add(1, Ordering::AcqRel);
                        }
                        let _ = reply.send(result);
                    })
                }))
                .pinned(&self.custody),
            )
            .await
            .map_err(|_| StoreError::ConnectionClosed)?;
        result.await.map_err(|_| StoreError::OperationUnknown)?
    }
}

impl OwnedConnection {
    /// Weak identity never keeps an idle physical owner or its Root lease alive.
    pub(crate) fn owner_identity(&self) -> std::sync::Weak<AtomicU64> {
        Arc::downgrade(&self.failures)
    }

    /// Internal scoped ingress to the same physical owner, never a new owner.
    pub(crate) fn cloned(&self) -> Self {
        Self {
            failures: self.failures.clone(),
            jobs: self.jobs.clone(),
            read_jobs: self.read_jobs.clone(),
            observation_jobs: self.observation_jobs.clone(),
            writer_stop: self.writer_stop.clone(),
            closed: self.closed.clone(),
            readers: self.readers.clone(),
            observations: self.observations.clone(),
            changes: self.changes.clone(),
            custody: self.custody.clone(),
        }
    }

    pub(crate) fn scoped(&self, custody: Custody) -> Self {
        let mut connection = self.cloned();
        connection.custody = Some(custody::combine(&self.custody, custody));
        connection
    }

    pub(crate) fn observations(&self) -> ObservationIngress {
        ObservationIngress {
            jobs: self.observation_jobs.clone(),
            custody: self.custody.clone(),
        }
    }

    pub(crate) fn writer(&self) -> WriterIngress {
        WriterIngress {
            jobs: self.jobs.clone(),
            failures: self.failures.clone(),
            custody: self.custody.clone(),
        }
    }

    pub(crate) async fn write<S: crate::writeback::Statement>(
        &self,
        statement: S,
        commits: crate::commits::CommitNotice,
    ) -> Result<S::Output, StoreError>
    where
        crate::writeback::Request: From<crate::writeback::Pending<S>>,
    {
        self.writer().write(statement, commits).await
    }

    /// Disposable write hints. Re-read canonical state after each wakeup;
    /// rolled-back work may also notify. Only the original worker owns ingress.
    pub fn subscribe_changes(&self) -> watch::Receiver<()> {
        self.changes.clone()
    }

    /// Observe the original worker's actual terminal result without closing ingress.
    pub(crate) fn close_receipt(&self) -> Shared<BoxFuture<'static, Result<(), String>>> {
        self.closed.clone()
    }

    pub async fn open(
        options: SqliteConnectOptions,
        authority: ConnectionAuthority,
        initialize: for<'c> fn(&'c mut SqliteConnection) -> BoxFuture<'c, Result<(), StoreError>>,
    ) -> Result<Self, StoreError> {
        Self::open_with_control(options, authority, initialize, None).await
    }

    pub(crate) async fn open_with_control(
        options: SqliteConnectOptions,
        authority: ConnectionAuthority,
        initialize: impl for<'c> FnOnce(
            &'c mut SqliteConnection,
        ) -> BoxFuture<'c, Result<(), StoreError>>
        + Send
        + 'static,
        control: Option<ReadOnlyControl>,
    ) -> Result<Self, StoreError> {
        Self::open_registered(options, authority, initialize, control, None).await
    }

    pub(crate) async fn open_tracked(
        options: SqliteConnectOptions,
        authority: ConnectionAuthority,
        initialize: impl for<'c> FnOnce(
            &'c mut SqliteConnection,
        ) -> BoxFuture<'c, Result<(), StoreError>>
        + Send
        + 'static,
        registration: crate::root_store::StageRegistration,
    ) -> Result<Self, StoreError> {
        Self::open_registered(options, authority, initialize, None, Some(registration)).await
    }

    async fn open_registered(
        options: SqliteConnectOptions,
        authority: ConnectionAuthority,
        initialize: impl for<'c> FnOnce(
            &'c mut SqliteConnection,
        ) -> BoxFuture<'c, Result<(), StoreError>>
        + Send
        + 'static,
        control: Option<ReadOnlyControl>,
        mut registration: Option<crate::root_store::StageRegistration>,
    ) -> Result<Self, StoreError> {
        let (jobs, mut receiver) = mpsc::channel::<Command>(32);
        let (read_jobs, read_receiver) = mpsc::channel::<ReadEnvelope>(1);
        let (observation_jobs, observation_receiver) = mpsc::channel::<ReadEnvelope>(1);
        let reader_stop = CancellationToken::new();
        let writer_stop = CancellationToken::new();
        let owner_stop = writer_stop.clone();
        let authority = Arc::new(authority);
        let (ready, startup) = oneshot::channel();
        let (completion, closed) = oneshot::channel();
        let (changed, changes) = watch::channel(());
        std::thread::Builder::new()
            .name("runtime-store-owner".into())
            .spawn(move || {
                if let Some(registration) = &mut registration {
                    registration.started();
                }
                let retained = Arc::new(Retained::default());
                let mut queued_drop_panicked = false;
                let mut result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()?;
                    let validate = || authority.validate();
                    validate()?;
                    let mut connection = runtime.block_on(connect_owned(&options))?;
                    let read_options = options.clone().create_if_missing(false).read_only(true);
                    let reader_owner = runtime.spawn(run_readers(
                        read_receiver,
                        observation_receiver,
                        reader_stop.clone(),
                        ReaderOptions {
                            connection: read_options,
                            control: control.clone(),
                        },
                        authority.clone(),
                        retained.clone(),
                        owner_stop.clone(),
                    ));
                    let mut last_changes = 0_i64;
                    let initialized = std::panic::catch_unwind(AssertUnwindSafe(|| {
                        runtime.block_on(async {
                            initialize(&mut connection).await?;
                            // Later initialization must not discard the TEMP view and
                            // silently expose the standalone main bindings table.
                            if let Some(control) = &control {
                                control.validate(&mut connection).await?;
                            }
                            last_changes = sqlx::query_scalar("SELECT total_changes()")
                                .fetch_one(&mut connection)
                                .await?;
                            validate()
                        })
                    }))
                    .unwrap_or(Err(StoreError::OperationUnknown));
                    let success = initialized.is_ok();
                    // If open's waiter disappeared, close without accepting work.
                    let mut pending = None;
                    let mut closing = false;
                    if ready.send(initialized).is_ok() && success {
                        while let Some(command) = pending.take().or_else(|| {
                            runtime.block_on(async {
                                if closing {
                                    return receiver.recv().await;
                                }
                                // Stop admission without needing queue capacity or the
                                // caller's runtime. Accepted work still drains below.
                                tokio::select! {
                                    biased;
                                    () = owner_stop.cancelled() => Some(Command::Shutdown),
                                    command = receiver.recv() => command,
                                }
                            })
                        }) {
                            let command = command.retain(&retained);
                            let executed =
                                std::panic::catch_unwind(AssertUnwindSafe(|| match command {
                                    Command::Pinned(..) => {
                                        unreachable!("custody moved into actor slot")
                                    }
                                    Command::Run(job) => {
                                        runtime.block_on(job(&mut connection, validate()));
                                        true
                                    }
                                    Command::Write(first) => {
                                        // Only the already queued adjacent prefix shares a commit.
                                        // Keep a control boundary locally, ahead of later ingress.
                                        let mut group = vec![first];
                                        while group.len() < 32 {
                                            match receiver.try_recv() {
                                                Ok(command) if command.is_write() => {
                                                    let Command::Write(request) =
                                                        command.retain(&retained)
                                                    else {
                                                        unreachable!()
                                                    };
                                                    group.push(request);
                                                }
                                                Ok(boundary) => {
                                                    pending = Some(boundary);
                                                    break;
                                                }
                                                Err(_) => break,
                                            }
                                        }
                                        runtime.block_on(crate::writeback::commit(
                                            &mut connection,
                                            group,
                                            &validate,
                                        ))
                                    }
                                    Command::Shutdown => {
                                        closing = true;
                                        // Reject new sends, then drain every accepted job.
                                        receiver.close();
                                        true
                                    }
                                }));
                            if !matches!(executed, Ok(true)) {
                                // Neither an unwound nor uncertain transaction may be reused.
                                break;
                            }
                            match runtime.block_on(
                                sqlx::query_scalar::<_, i64>("SELECT total_changes()")
                                    .fetch_one(&mut connection),
                            ) {
                                Ok(total) if total == last_changes => {}
                                Ok(total) => {
                                    last_changes = total;
                                    changed.send_replace(());
                                }
                                // Preserve the job's result and real close path. A
                                // subscriber's canonical read will report any failure.
                                Err(_) => {
                                    changed.send_replace(());
                                }
                            }
                            // Waiting for the handle also flushes queued Transaction::drop
                            // rollbacks. A successful query alone is not proof of cleanup.
                            if !runtime.block_on(is_autocommit(&mut connection)) {
                                break;
                            }
                            retained.clear(0);
                        }
                    }
                    // Readers can await writer replies. Close admission, then reject
                    // queued work, including sends holding an earlier capacity permit,
                    // before joining readers. None also accounts for those permits.
                    receiver.close();
                    queued_drop_panicked |=
                        std::panic::catch_unwind(AssertUnwindSafe(|| drop(pending))).is_err();
                    while let Some(command) = runtime.block_on(receiver.recv()) {
                        queued_drop_panicked |=
                            std::panic::catch_unwind(AssertUnwindSafe(|| drop(command))).is_err();
                    }
                    let mut close_failures = Vec::new();
                    // Close read ingress independently, then drain every accepted read
                    // before releasing the writer's original authority.
                    reader_stop.cancel();
                    let reader_failure = runtime
                        .block_on(reader_owner)
                        .map_err(|error| error.to_string())
                        .and_then(|closed| closed.map_err(|error| error.to_string()))
                        .err();
                    // Await real close before releasing authority, even after failure.
                    match runtime.block_on(connection.close()) {
                        Ok(()) => retained.clear(0),
                        Err(error) => close_failures.push(error.to_string()),
                    }
                    close_failures.extend(reader_failure);
                    if close_failures.is_empty() {
                        Ok(())
                    } else {
                        Err(StoreError::CloseFailed(close_failures.join("; ")))
                    }
                }))
                .unwrap_or_else(|_| {
                    Err(StoreError::StartupCleanupFailed {
                        cause: Box::new(StoreError::Initialization),
                        cleanup: Box::new(StoreError::OperationUnknown),
                    })
                });
                // Unexecuted accepted jobs still own their original payloads.
                // Their destructors cannot unwind past this authority boundary.
                if std::panic::catch_unwind(AssertUnwindSafe(|| drop(receiver))).is_err()
                    || queued_drop_panicked
                {
                    result = Err(StoreError::CloseFailed(format!(
                        "queued connection work destruction panicked; prior close: {result:?}"
                    )));
                }
                let cleanup_failed = matches!(
                    result,
                    Err(StoreError::CloseFailed(_) | StoreError::StartupCleanupFailed { .. })
                );
                if let Some(registration) = &mut registration {
                    registration.complete(result.is_ok());
                }
                if !cleanup_failed {
                    drop(authority);
                    drop(retained);
                }
                let _ = completion.send(result);
                // A failed real close is not permission to release the original
                // authority. Keep its actual worker alive; no replacement owner
                // or process exit can manufacture a cleanup acknowledgement.
                if cleanup_failed {
                    loop {
                        std::thread::park();
                    }
                }
            })?;
        match startup.await {
            Ok(Ok(())) => Ok(Self {
                failures: Arc::new(AtomicU64::new(0)),
                jobs,
                read_jobs,
                observation_jobs,
                writer_stop,
                closed: async move {
                    closed
                        .await
                        .map_err(|_| {
                            "connection owner exited without close acknowledgement".to_owned()
                        })?
                        .map_err(|error| error.to_string())
                }
                .boxed()
                .shared(),
                readers: Arc::new(Semaphore::new(1)),
                observations: Arc::new(Semaphore::new(1)),
                changes,
                custody: None,
            }),
            Ok(Err(error)) => {
                drop(jobs);
                match closed.await {
                    Ok(Ok(())) => Err(error),
                    result => Err(StoreError::StartupCleanupFailed {
                        cause: Box::new(error),
                        cleanup: Box::new(match result {
                            Ok(Err(error)) => error,
                            Err(_) => StoreError::OperationUnknown,
                            Ok(Ok(())) => unreachable!(),
                        }),
                    }),
                }
            }
            Err(_) => {
                drop(jobs);
                match closed.await {
                    Ok(Ok(())) => Err(StoreError::Initialization),
                    Ok(Err(error @ StoreError::StartupCleanupFailed { .. })) => Err(error),
                    Ok(Err(error)) if !matches!(error, StoreError::CloseFailed(_)) => {
                        // Owned startup confirms any acquired connection has closed;
                        // a crashed worker or failed close takes the typed branch above.
                        Err(error)
                    }
                    result => Err(StoreError::StartupCleanupFailed {
                        cause: Box::new(StoreError::Initialization),
                        cleanup: Box::new(match result {
                            Ok(Err(error)) => error,
                            Err(_) => StoreError::OperationUnknown,
                            Ok(Ok(())) => unreachable!(),
                        }),
                    }),
                }
            }
        }
    }

    pub async fn run<T: Send + 'static>(
        &self,
        operation: impl for<'c> FnOnce(&'c mut SqliteConnection) -> BoxFuture<'c, Result<T, StoreError>>
        + Send
        + 'static,
    ) -> Result<T, StoreError> {
        self.writer().run(operation).await
    }

    /// Close public admission before awaiting any close receipt. Accepted writer
    /// cleanup retains observation ingress until the writer has drained.
    pub(crate) fn request_shutdown(&self) {
        self.readers.close();
        self.observations.close();
        self.writer_stop.cancel();
    }

    pub async fn shutdown(&self) -> Result<(), StoreError> {
        self.request_shutdown();
        self.closed.clone().await.map_err(StoreError::CloseFailed)
    }

    /// Bounded independent readers keep large snapshots off the serialized writer.
    /// Accepted reads drain on shutdown even if their caller or executor disappears.
    pub(crate) async fn read<T: Send + 'static>(
        &self,
        operation: impl for<'c> FnOnce(&'c mut SqliteConnection) -> BoxFuture<'c, Result<T, StoreError>>
        + Send
        + 'static,
    ) -> Result<T, StoreError> {
        self.read_job(ReaderRole::Read, operation, false).await
    }

    /// Pure database reads may stop when their observer disappears. The owner
    /// still awaits operation and transaction cleanup before reusing a reader.
    pub(crate) async fn read_interruptible<T: Send + 'static>(
        &self,
        operation: impl for<'c> FnOnce(&'c mut SqliteConnection) -> BoxFuture<'c, Result<T, StoreError>>
        + Send
        + 'static,
    ) -> Result<T, StoreError> {
        self.read_job(ReaderRole::Read, operation, true).await
    }

    /// Private observation state belongs to one physical reader. Its admission
    /// is independent of pure reads, so cache work cannot consume their capacity.
    /// Disposable cache work may stop after caller loss; its rollback still drains
    /// before this physical reader or its retained source custody can be reused.
    pub(crate) async fn observe<T: Send + 'static>(
        &self,
        operation: impl for<'c> FnOnce(&'c mut SqliteConnection) -> BoxFuture<'c, Result<T, StoreError>>
        + Send
        + 'static,
    ) -> Result<T, StoreError> {
        self.read_job(ReaderRole::Observation, operation, true)
            .await
    }

    async fn read_job<T: Send + 'static>(
        &self,
        role: ReaderRole,
        operation: impl for<'c> FnOnce(&'c mut SqliteConnection) -> BoxFuture<'c, Result<T, StoreError>>
        + Send
        + 'static,
        interruptible: bool,
    ) -> Result<T, StoreError> {
        let (jobs, admission) = match role {
            ReaderRole::Read => (&self.read_jobs, &self.readers),
            ReaderRole::Observation => (&self.observation_jobs, &self.observations),
        };
        let permit = admission
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| StoreError::ConnectionClosed)?;
        self.read_job_with_permit(jobs, operation, interruptible, permit, || Ok(None))
            .await
    }

    async fn read_job_with_permit<T: Send + 'static>(
        &self,
        jobs: &mpsc::Sender<ReadEnvelope>,
        operation: impl for<'c> FnOnce(&'c mut SqliteConnection) -> BoxFuture<'c, Result<T, StoreError>>
        + Send
        + 'static,
        interruptible: bool,
        permit: tokio::sync::OwnedSemaphorePermit,
        admit: impl FnOnce() -> Result<Option<Custody>, StoreError> + Send,
    ) -> Result<T, StoreError> {
        let (mut reply, result) = oneshot::channel();
        let queue = jobs
            .reserve()
            .await
            .map_err(|_| StoreError::ConnectionClosed)?;
        queue.send(ReadEnvelope {
            custody: match admit()? {
                Some(additional) => Some(custody::combine(&self.custody, additional)),
                None => self.custody.clone(),
            },
            job: ReadJob::Execute(Box::new(move |connection| {
                Box::pin(async move {
                    let _permit = permit;
                    let mut clean = true;
                    let executed = match connection {
                        Ok(connection) => {
                            let cancel = Arc::new(AtomicBool::new(false));
                            if interruptible {
                                match connection.lock_handle().await {
                                    Ok(mut locked) => {
                                        let cancel = cancel.clone();
                                        // Remember cancellation between statements, then consume
                                        // it once so transaction rollback can run normally.
                                        locked.set_progress_handler(1000, move || {
                                            !cancel.swap(false, Ordering::Relaxed)
                                        });
                                    }
                                    Err(error) => {
                                        let _ = reply.send(Err(error.into()));
                                        return false;
                                    }
                                }
                            }
                            let executed = {
                                let operation =
                                    AssertUnwindSafe(async { operation(&mut *connection).await })
                                        .catch_unwind();
                                tokio::pin!(operation);
                                tokio::select! {
                                    result = &mut operation => result,
                                    () = reply.closed(), if interruptible => {
                                        cancel.store(true, Ordering::Relaxed);
                                        operation.await
                                    }
                                }
                            };
                            if interruptible {
                                // The handle lock follows queued Transaction::drop rollbacks.
                                clean = match connection.lock_handle().await {
                                    Ok(mut locked) => {
                                        locked.remove_progress_handler();
                                        // SAFETY: the SQLx guard excludes worker FFI calls;
                                        // this only reads the live handle's transaction state.
                                        unsafe {
                                            rusqlite::ffi::sqlite3_get_autocommit(
                                                locked.as_raw_handle().as_ptr(),
                                            ) != 0
                                        }
                                    }
                                    Err(_) => false,
                                };
                            }
                            executed
                        }
                        Err(error) => Ok(Err(error)),
                    };
                    let reusable = clean
                        && !matches!(
                            &executed,
                            Err(_) | Ok(Err(StoreError::Sqlx(sqlx::Error::WorkerCrashed)))
                        );
                    let result = executed.unwrap_or(Err(StoreError::OperationUnknown));
                    let _ = reply.send(result);
                    reusable
                })
            })),
        });
        result.await.map_err(|_| StoreError::OperationUnknown)?
    }

    pub async fn close(self) -> Result<(), StoreError> {
        self.shutdown().await
    }
}

#[derive(Clone)]
struct ReaderOptions {
    connection: SqliteConnectOptions,
    control: Option<ReadOnlyControl>,
}

// Both physical roles remain on the original owner's runtime, with independent
// ingress and admission. Only the observation role owns writable private state.
async fn run_readers(
    receiver: mpsc::Receiver<ReadEnvelope>,
    observations: mpsc::Receiver<ReadEnvelope>,
    stop: CancellationToken,
    options: ReaderOptions,
    authority: Arc<ConnectionAuthority>,
    retained: Arc<Retained>,
    writer_stop: CancellationToken,
) -> Result<(), StoreError> {
    let mut readers = tokio::task::JoinSet::new();
    for (slot, role, receiver) in [
        (1, ReaderRole::Read, receiver),
        (2, ReaderRole::Observation, observations),
    ] {
        readers.spawn(reader_worker(
            receiver,
            stop.clone(),
            options.clone(),
            authority.clone(),
            retained.clone(),
            slot,
            role,
        ));
    }
    let mut failure = None;
    while let Some(result) = readers.join_next().await {
        retain_reader_failure(result, &mut failure);
        if failure.is_some() {
            // A failed physical reader must not leave the writer accepting new
            // work indefinitely; its retained slot survives with that owner.
            stop.cancel();
            writer_stop.cancel();
        }
    }
    match failure {
        Some(error) => Err(StoreError::CloseFailed(error)),
        None => Ok(()),
    }
}

async fn reader_worker(
    mut receiver: mpsc::Receiver<ReadEnvelope>,
    stop: CancellationToken,
    options: ReaderOptions,
    authority: Arc<ConnectionAuthority>,
    retained: Arc<Retained>,
    slot: usize,
    role: ReaderRole,
) -> Result<(), StoreError> {
    let mut connection = None;
    let mut failure = None;
    loop {
        let job = {
            tokio::select! {
                biased;
                () = stop.cancelled(), if !receiver.is_closed() => {
                    receiver.close();
                    receiver.recv().await
                },
                job = receiver.recv() => job,
            }
        };
        let Some(ReadEnvelope { job, custody }) = job else {
            break;
        };
        if let Some(custody) = custody {
            retained.hold(slot, custody);
        }
        let mut valid = if connection.is_none() {
            authority.validate()
        } else {
            Ok(())
        };
        if valid.is_ok() && connection.is_none() && matches!(&job, ReadJob::Execute(_)) {
            match connect_reader(&options.connection, options.control.as_ref(), role).await {
                Ok(opened) => connection = Some(opened),
                Err(error) => {
                    if matches!(error, StoreError::StartupCleanupFailed { .. }) {
                        failure.get_or_insert(error.to_string());
                    }
                    valid = Err(error);
                }
            }
        }
        // Every job checks the current original authority, including after a
        // connection startup await. The immutable connection is never a grant.
        let ready = valid.and_then(|()| authority.validate());
        let reusable = match job {
            ReadJob::Execute(job) => {
                job(ready.map(|()| connection.as_mut().expect("validated reader connection"))).await
            }
            ReadJob::Observe(job) => job(slot, ready.map(|()| connection.as_mut())).await,
        };
        // Noninterruptible reads must prove cleanup too. A forgotten transaction
        // or a failed startup close retires this physical reader before reuse.
        let clean = match connection.as_mut() {
            Some(connection) => is_autocommit(connection).await,
            None => failure.is_none(),
        };
        if (!reusable || !clean)
            && let Some(connection) = connection.take()
            && let Err(error) = close_reader(connection).await
        {
            failure.get_or_insert(error.to_string());
        }
        if failure.is_some() {
            break;
        }
        retained.clear(slot);
    }
    if let Some(connection) = connection
        && let Err(error) = close_reader(connection).await
    {
        failure.get_or_insert(error.to_string());
    }
    match failure {
        Some(error) => Err(StoreError::CloseFailed(error)),
        None => Ok(()),
    }
}

async fn is_autocommit(connection: &mut SqliteConnection) -> bool {
    match connection.lock_handle().await {
        Ok(mut locked) => {
            // SAFETY: the SQLx guard excludes worker FFI calls and follows all
            // queued rollback work. Only the current transaction state is read.
            unsafe { rusqlite::ffi::sqlite3_get_autocommit(locked.as_raw_handle().as_ptr()) != 0 }
        }
        Err(_) => false,
    }
}

async fn close_reader(connection: SqliteConnection) -> Result<(), StoreError> {
    AssertUnwindSafe(connection.close())
        .catch_unwind()
        .await
        .map_err(|_| StoreError::CloseFailed("reader close panicked".into()))?
        .map_err(|error| StoreError::CloseFailed(error.to_string()))
}

async fn connect_reader(
    options: &SqliteConnectOptions,
    control: Option<&ReadOnlyControl>,
    role: ReaderRole,
) -> Result<SqliteConnection, StoreError> {
    let mut connection = connect_owned(options).await?;
    if let Err(error) = crate::sqlite_functions::register(&mut connection).await {
        return Err(close_startup(connection, error).await);
    }
    if matches!(role, ReaderRole::Observation)
        && let Err(error) = crate::transcript::initialize_cache(&mut connection).await
    {
        return Err(close_startup(connection, error).await);
    }
    if let Err(error) = control::initialize_views(&mut connection, control).await {
        return Err(close_startup(connection, error).await);
    }
    Ok(connection)
}

// These are the original owner's startup and reader cleanup boundaries, not
// another SQL owner. A returned ordinary startup error confirms actual close.
async fn close_startup(connection: SqliteConnection, cause: StoreError) -> StoreError {
    match connection.close().await {
        Ok(()) => cause,
        Err(cleanup) => StoreError::StartupCleanupFailed {
            cause: Box::new(cause),
            cleanup: Box::new(StoreError::CloseFailed(cleanup.to_string())),
        },
    }
}
async fn connect_owned(options: &SqliteConnectOptions) -> Result<SqliteConnection, StoreError> {
    let mut connection = match SqliteConnection::establish(options).await {
        Ok(connection) => connection,
        Err(sqlx::Error::WorkerCrashed) => {
            return Err(StoreError::StartupCleanupFailed {
                cause: Box::new(StoreError::Initialization),
                cleanup: Box::new(StoreError::OperationUnknown),
            });
        }
        Err(error) => return Err(error.into()),
    };
    if let Err(error) = connection.configure(options).await {
        return Err(close_startup(connection, error.into()).await);
    }
    Ok(connection)
}
fn retain_reader_failure(
    result: Result<Result<(), StoreError>, tokio::task::JoinError>,
    failure: &mut Option<String>,
) {
    if let Err(error) = result
        .map_err(|error| error.to_string())
        .and_then(|closed| closed.map_err(|error| error.to_string()))
    {
        failure.get_or_insert(error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::{File, OpenOptions},
        sync::{Arc, mpsc as blocking},
        time::Duration,
    };

    #[tokio::test]
    async fn long_lived_readers_do_not_install_startup_migration_functions() {
        let directory = tempfile::tempdir().unwrap();
        let options = SqliteConnectOptions::new()
            .filename(directory.path().join("runtime.sqlite"))
            .create_if_missing(true)
            .foreign_keys(true);
        let mut writer = connect_owned(&options).await.unwrap();
        crate::schema::initialize_connection(&mut writer)
            .await
            .unwrap();
        writer.close().await.unwrap();
        for role in [ReaderRole::Read, ReaderRole::Observation] {
            let mut reader = connect_reader(&options, None, role).await.unwrap();
            let functions: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM pragma_function_list
                 WHERE name IN ('maka_directory_row','maka_directory_payload','maka_directory_child')",
            ).fetch_one(&mut reader).await.unwrap();
            assert_eq!(
                functions, 0,
                "readers must never retain migration-only functions"
            );
            close_reader(reader).await.unwrap();
        }
    }

    #[tokio::test]
    async fn canonical_session_reads_bypass_a_blocked_writer() {
        let directory = tempfile::tempdir().unwrap();
        let namespaces = crate::root::RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let root = Arc::new(
            crate::root::RootOwner::create(&directory.path().join("root"), &namespaces).unwrap(),
        );
        let store = Arc::new(crate::EventLog::for_root(root).await.unwrap());
        store
            .create_session("foreground", "original", &serde_json::json!({}), 1)
            .await
            .unwrap();
        let (entered, reached) = oneshot::channel();
        let (release, gate) = oneshot::channel();
        let writer = store.clone();
        let blocked = tokio::spawn(async move {
            writer
                .connection
                .run(move |_| {
                    Box::pin(async move {
                        entered.send(()).unwrap();
                        gate.await.unwrap();
                        Ok(())
                    })
                })
                .await
        });
        reached.await.unwrap();
        // Awaited commits remain visible even while a later writer cannot finish.
        tokio::time::timeout(Duration::from_secs(5), async {
            assert!(
                store
                    .get_session::<serde_json::Value>("foreground")
                    .await
                    .unwrap()
                    .is_some()
            );
            assert!(
                store
                    .observe_session::<serde_json::Value>("foreground")
                    .await
                    .unwrap()
                    .is_some()
            );
            assert!(
                store
                    .latest_message_opening("foreground")
                    .await
                    .unwrap()
                    .is_none()
            );
            assert!(store.context_usage("foreground").await.unwrap().1.is_none());
        })
        .await
        .unwrap();
        release.send(()).unwrap();
        blocked.await.unwrap().unwrap();
        Arc::try_unwrap(store).ok().unwrap().close().await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_waits_for_persistent_readers_actual_sqlite_close() {
        struct CloseGate {
            entered: blocking::Sender<()>,
            release: blocking::Receiver<()>,
        }
        impl Drop for CloseGate {
            fn drop(&mut self) {
                self.entered.send(()).unwrap();
                self.release.recv_timeout(Duration::from_secs(10)).unwrap();
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let lock = directory.path().join("writer.lock");
        let lease = Arc::new(crate::root::FileLease::acquire(&lock).unwrap());
        let contender = File::open(&lock).unwrap();
        let owner = Arc::new(
            OwnedConnection::open(
                SqliteConnectOptions::new()
                    .filename(directory.path().join("close.sqlite"))
                    .create_if_missing(true),
                ConnectionAuthority::Writer { lease, root: None },
                |_| Box::pin(async { Ok(()) }),
            )
            .await
            .unwrap(),
        );
        let (entered, closing) = blocking::channel();
        let (release, gate) = blocking::channel();
        let reader = owner.clone();
        let caller = tokio::spawn(async move {
            reader
                .read(move |connection| {
                    Box::pin(async move {
                        let close = CloseGate {
                            entered,
                            release: gate,
                        };
                        connection
                            .lock_handle()
                            .await?
                            .set_progress_handler(1, move || {
                                let _retained = &close;
                                true
                            });
                        Ok(())
                    })
                })
                .await
        });
        caller.await.unwrap().unwrap();
        let closing_owner = owner.clone();
        let shutdown = tokio::spawn(async move { closing_owner.shutdown().await });
        tokio::time::timeout(Duration::from_secs(5), async {
            while closing.try_recv().is_err() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(!shutdown.is_finished());
        assert!(owner.closed.clone().now_or_never().is_none());
        assert!(matches!(
            contender.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), shutdown)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        contender.try_lock().unwrap();
    }

    #[tokio::test]
    async fn actual_reader_close_failure_fences_the_original_writer_and_root_authority() {
        struct PanickingDrop;
        impl Drop for PanickingDrop {
            fn drop(&mut self) {
                panic!("actual SQLite callback destructor failed");
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("root");
        let namespaces = crate::root::RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let authority = Arc::new(crate::root::RootOwner::create(&root, &namespaces).unwrap());
        let original = Arc::downgrade(&authority);
        let owner = OwnedConnection::open(
            SqliteConnectOptions::new()
                .filename(root.join(crate::root::ROOT_DATABASE))
                .create_if_missing(true),
            ConnectionAuthority::Root(authority),
            |_| Box::pin(async { Ok(()) }),
        )
        .await
        .unwrap();
        let read = owner
            .read(|connection| {
                Box::pin(async move {
                    let actual = PanickingDrop;
                    connection
                        .lock_handle()
                        .await?
                        .set_progress_handler(1, move || {
                            let _retained = &actual;
                            true
                        });
                    Ok(())
                })
            })
            .await;
        assert!(
            read.is_ok(),
            "successful reads retain their connection until shutdown"
        );
        let (entered, reached) = oneshot::channel();
        let (release, gate) = oneshot::channel();
        owner
            .jobs
            .send(Command::Run(Box::new(move |_, _| {
                Box::pin(async move {
                    entered.send(()).unwrap();
                    gate.await.unwrap();
                    panic!("accepted writer operation unwound");
                })
            })))
            .await
            .unwrap();
        reached.await.unwrap();
        let queued_payload = PanickingDrop;
        owner
            .jobs
            .send(Command::Run(Box::new(move |_, _| {
                // The earlier operation unwinds before this queued job runs;
                // receiver destruction must settle its original payload here.
                drop(queued_payload);
                Box::pin(async {})
            })))
            .await
            .unwrap();
        release.send(()).unwrap();
        let closed = owner.shutdown().await;
        assert!(matches!(closed, Err(StoreError::CloseFailed(_))));
        assert!(
            closed
                .unwrap_err()
                .to_string()
                .contains("queued connection work destruction panicked")
        );
        drop(owner);
        assert!(
            original.upgrade().is_some(),
            "the same original SQL worker must retain authority"
        );
        assert_eq!(
            crate::root::RootOwner::open(&root, &namespaces)
                .err()
                .unwrap()
                .kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn dropped_caller_runtime_keeps_authority_until_real_commit_and_close() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("owner.sqlite");
        let lock = directory.path().join("writer.lock");
        let lease = Arc::new(crate::root::FileLease::acquire(&lock).unwrap());
        let contender = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock)
            .unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let owner = runtime
            .block_on(OwnedConnection::open(
                options,
                ConnectionAuthority::Writer { lease, root: None },
                |connection| {
                    Box::pin(async move {
                        sqlx::query("CREATE TABLE committed(value INTEGER)")
                            .execute(connection)
                            .await?;
                        Ok(())
                    })
                },
            ))
            .unwrap();
        let (entered, reached) = blocking::channel();
        let (release, gate) = blocking::channel();
        let close_ack = owner.closed.clone();
        runtime.spawn(async move {
            owner
                .run(move |connection| {
                    Box::pin(async move {
                        connection.lock_handle().await?.set_commit_hook(move || {
                            entered.send(()).unwrap();
                            gate.recv_timeout(Duration::from_secs(10)).unwrap();
                            true
                        });
                        sqlx::query("INSERT INTO committed VALUES (7)")
                            .execute(connection)
                            .await?;
                        Ok(())
                    })
                })
                .await
                .unwrap();
        });
        runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(5), async {
                while reached.try_recv().is_err() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
        });
        drop(runtime);
        assert!(matches!(
            contender.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        release.send(()).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            close_ack.await.unwrap();
            contender.try_lock().unwrap();
            let mut connection =
                SqliteConnection::connect_with(&SqliteConnectOptions::new().filename(&path))
                    .await
                    .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT value FROM committed")
                    .fetch_one(&mut connection)
                    .await
                    .unwrap(),
                7
            );
            connection.close().await.unwrap();
        });
    }
}
