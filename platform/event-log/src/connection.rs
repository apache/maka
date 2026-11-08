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

use crate::StoreError;
use async_channel::{Receiver, Sender};
use futures_util::{FutureExt, future::Shared};
use rusqlite::{Connection, OpenFlags};
use std::{
    future::Future,
    panic::{AssertUnwindSafe, catch_unwind},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tokio::sync::{Semaphore, oneshot, watch};

mod authority;
pub use authority::ConnectionAuthority;
pub(crate) mod custody;
use custody::Custody;
mod stats;
pub use stats::{ConnectionResourceStats, SqliteResourceStats};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
const WRITE_CAPACITY: usize = 32;
const PURE_READERS: usize = 2;

/// Physical SQLite opening policy. Anonymous databases stay on their own actor.
#[derive(Clone)]
pub struct OpenOptions {
    path: PathBuf,
    create: bool,
    read_only: bool,
    exclusive: bool,
    immutable: bool,
    pragmas: Vec<(String, String)>,
}
impl OpenOptions {
    pub fn file(path: impl AsRef<Path>) -> Self {
        Self {
            path: path.as_ref().into(),
            create: false,
            read_only: false,
            exclusive: false,
            immutable: false,
            pragmas: Vec::new(),
        }
    }
    pub fn temporary() -> Self {
        Self::file("").create(true)
    }
    pub fn memory() -> Self {
        Self::file(":memory:").create(true)
    }
    pub fn create(mut self, value: bool) -> Self {
        self.create = value;
        self
    }
    pub fn read_only(mut self, value: bool) -> Self {
        self.read_only = value;
        self
    }
    pub fn exclusive(mut self, value: bool) -> Self {
        self.exclusive = value;
        self
    }
    pub fn immutable(mut self, value: bool) -> Self {
        self.immutable = value;
        self
    }
    pub fn pragma(mut self, name: impl Into<String>, value: impl ToString) -> Self {
        self.pragmas.push((name.into(), value.to_string()));
        self
    }
    fn local(&self) -> bool {
        self.path.as_os_str().is_empty() || self.path == Path::new(":memory:")
    }
    fn open(&self) -> Result<Connection, StoreError> {
        let mut flags = if self.read_only {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        };
        if self.create {
            flags |= OpenFlags::SQLITE_OPEN_CREATE;
        }
        let connection = if self.immutable {
            let uri = url::Url::from_file_path(&self.path)
                .map_err(|()| StoreError::InvalidTransition("invalid database path".into()))?;
            Connection::open_with_flags(
                format!("{uri}?immutable=1"),
                flags | OpenFlags::SQLITE_OPEN_URI,
            )?
        } else {
            Connection::open_with_flags(&self.path, flags)?
        };
        if self.exclusive {
            if !connection.set_db_config(
                rusqlite::config::DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE,
                true,
            )? {
                return Err(StoreError::InvalidTransition(
                    "application inspection could not disable close checkpoints".into(),
                ));
            }
            // pragma_update validates names through a SELECT first, which would
            // initialize shared WAL indexing before exclusive mode takes effect.
            connection.execute_batch("PRAGMA locking_mode = EXCLUSIVE")?;
        }
        connection.set_db_config(
            rusqlite::config::DbConfig::SQLITE_DBCONFIG_ENABLE_QPSG,
            true,
        )?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.set_prepared_statement_cache_capacity(100);
        for (name, value) in &self.pragmas {
            connection.pragma_update(None, name, value)?;
        }
        Ok(connection)
    }
}

type Preparation = Box<dyn FnOnce() + Send>;
type Reply = Box<dyn FnOnce() + Send>;
type Job = Box<dyn FnOnce(&mut Connection, Result<(), StoreError>) -> (bool, Reply) + Send>;
struct Envelope {
    command: Command,
    _custody: Option<Custody>,
    _permit: Option<Arc<tokio::sync::OwnedSemaphorePermit>>,
}
enum Command {
    Run(Job),
    PreparingRun(oneshot::Receiver<Job>),
    Write(PreparedWrite),
    Wake,
    ReaderClosed(Result<(), String>),
    Take(oneshot::Sender<Result<Connection, StoreError>>),
}
enum PreparedWrite {
    Ready(crate::writeback::Request),
    Preparing(oneshot::Receiver<Result<crate::writeback::Request, Reply>>),
}
impl PreparedWrite {
    fn resolve(self) -> Result<Option<crate::writeback::Request>, Reply> {
        match self {
            Self::Ready(request) => Ok(Some(request)),
            Self::Preparing(receiver) => match receiver.blocking_recv() {
                Ok(Ok(request)) => Ok(Some(request)),
                Ok(Err(reply)) => Err(reply),
                Err(_) => Ok(None),
            },
        }
    }
}
type ReadOperation =
    Box<dyn FnOnce(&mut Option<Connection>, Result<(), StoreError>) -> (bool, Reply) + Send>;
struct ReadSlot {
    index: usize,
    idle: Sender<usize>,
}
impl Drop for ReadSlot {
    fn drop(&mut self) {
        let _ = self.idle.try_send(self.index);
    }
}
struct ReadJob {
    _slot: Option<ReadSlot>,
    open: bool,
    run: ReadOperation,
    _custody: Option<Custody>,
}
struct Admission {
    accepting: Arc<AtomicBool>,
    reads: Vec<Sender<ReadJob>>,
    observations: Sender<ReadJob>,
    writer: Sender<Envelope>,
    idle_readers: Sender<usize>,
}
impl Admission {
    fn stop(&self) {
        self.accepting.store(false, Ordering::Release);
        self.idle_readers.close();
        for lane in &self.reads {
            lane.close();
        }
        self.observations.close();
        let _ = self.writer.try_send(Envelope {
            command: Command::Wake,
            _custody: None,
            _permit: None,
        });
    }
}
impl Drop for Admission {
    fn drop(&mut self) {
        self.stop();
    }
}

pub struct OwnedConnection {
    admission: Arc<Admission>,
    writer: WriterIngress,
    reads: Vec<Sender<ReadJob>>,
    observations: Sender<ReadJob>,
    read_on_owner: bool,
    temporary: bool,
    closed: Shared<BoxFuture<'static, Result<(), String>>>,
    changes: watch::Receiver<()>,
    custody: Option<Custody>,
    idle_readers: Sender<usize>,
    read_slots: Receiver<usize>,
}
#[derive(Clone)]
pub(crate) struct WriterIngress {
    jobs: Sender<Envelope>,
    failures: Arc<AtomicU64>,
    capacity: Arc<Semaphore>,
    preparations: Sender<Preparation>,
    custody: Option<Custody>,
}
#[derive(Clone)]
pub(crate) struct ObservationIngress {
    jobs: Sender<ReadJob>,
    custody: Option<Custody>,
}
impl ObservationIngress {
    pub(crate) async fn purge_session(&self, session: String) -> Result<(), StoreError> {
        let (reply, result) = oneshot::channel();
        self.jobs
            .send(ReadJob {
                _slot: None,
                open: false,
                _custody: self.custody.clone(),
                run: Box::new(move |db, valid| {
                    let value = valid.and_then(|()| match db {
                        Some(db) => crate::transcript::purge_cache(db, &session),
                        None => Ok(()),
                    });
                    (
                        true,
                        Box::new(move || {
                            let _ = reply.send(value);
                        }),
                    )
                }),
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
        let permit = Arc::new(
            self.capacity
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| StoreError::ConnectionClosed)?,
        );
        let (reply, result) = oneshot::channel();
        if S::PREPARE_OFF_THREAD {
            let (prepared, ready) = oneshot::channel();
            self.jobs
                .send(Envelope {
                    command: Command::Write(PreparedWrite::Preparing(ready)),
                    _custody: self.custody.clone(),
                    _permit: Some(permit.clone()),
                })
                .await
                .map_err(|_| StoreError::ConnectionClosed)?;
            let failures = self.failures.clone();
            self.preparations
                .try_send(Box::new(move || {
                    let _permit = permit;
                    match catch_unwind(AssertUnwindSafe(|| statement.prepare()))
                        .unwrap_or(Err(StoreError::OperationUnknown))
                    {
                        Ok(statement) => {
                            let _ = prepared.send(Ok(crate::writeback::Pending::new(
                                statement, commits, reply, failures,
                            )
                            .into()));
                        }
                        Err(error) => {
                            let notify: Reply = Box::new(move || {
                                let _ = reply.send(Err(error));
                            });
                            if let Err(Err(notify)) = prepared.send(Err(notify)) {
                                notify();
                            }
                        }
                    }
                }))
                .map_err(|_| StoreError::ConnectionClosed)?;
        } else {
            let request = crate::writeback::Pending::new(
                statement.prepare()?,
                commits,
                reply,
                self.failures.clone(),
            )
            .into();
            self.jobs
                .send(Envelope {
                    command: Command::Write(PreparedWrite::Ready(request)),
                    _custody: self.custody.clone(),
                    _permit: Some(permit),
                })
                .await
                .map_err(|_| StoreError::ConnectionClosed)?;
        }
        result.await.map_err(|_| StoreError::OperationUnknown)?
    }
    async fn run_prepared<P: Send + 'static, T: Send + 'static>(
        &self,
        prepare: impl FnOnce() -> Result<P, StoreError> + Send + 'static,
        operation: impl FnOnce(&mut Connection, P) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        let permit = Arc::new(
            self.capacity
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| StoreError::ConnectionClosed)?,
        );
        let (reply, result) = oneshot::channel();
        let (prepared, ready) = oneshot::channel();
        self.jobs
            .send(Envelope {
                command: Command::PreparingRun(ready),
                _custody: self.custody.clone(),
                _permit: Some(permit.clone()),
            })
            .await
            .map_err(|_| StoreError::ConnectionClosed)?;
        let failures = self.failures.clone();
        self.preparations
            .try_send(Box::new(move || {
                let _permit = permit;
                let value = catch_unwind(AssertUnwindSafe(prepare))
                    .unwrap_or(Err(StoreError::OperationUnknown));
                let job: Job = Box::new(move |connection, valid| {
                    let (value, clean, _) = execute(
                        connection,
                        valid,
                        move |connection| operation(connection, value?),
                        None,
                    );
                    if value.is_err() {
                        failures.fetch_add(1, Ordering::AcqRel);
                    }
                    (
                        clean,
                        Box::new(move || {
                            let _ = reply.send(value);
                        }),
                    )
                });
                let _ = prepared.send(job);
            }))
            .map_err(|_| StoreError::ConnectionClosed)?;
        result.await.map_err(|_| StoreError::OperationUnknown)?
    }
    #[cfg(test)]
    pub(crate) fn failures(&self) -> u64 {
        self.failures.load(Ordering::Acquire)
    }
    pub(crate) async fn run<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        let permit = self
            .capacity
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| StoreError::ConnectionClosed)?;
        let (reply, result) = oneshot::channel();
        let failures = self.failures.clone();
        self.jobs
            .send(Envelope {
                _custody: self.custody.clone(),
                _permit: Some(Arc::new(permit)),
                command: Command::Run(Box::new(move |connection, valid| {
                    let (result, clean, _) = execute(connection, valid, operation, None);
                    if result.is_err() {
                        failures.fetch_add(1, Ordering::AcqRel);
                    }
                    (
                        clean,
                        Box::new(move || {
                            let _ = reply.send(result);
                        }),
                    )
                })),
            })
            .await
            .map_err(|_| StoreError::ConnectionClosed)?;
        result.await.map_err(|_| StoreError::OperationUnknown)?
    }
}

/// Synchronous cleanup follows the operation on the same connection and stack.
fn execute<T>(
    connection: &mut Connection,
    valid: Result<(), StoreError>,
    operation: impl FnOnce(&mut Connection) -> Result<T, StoreError>,
    cancel: Option<Arc<AtomicBool>>,
) -> (Result<T, StoreError>, bool, bool) {
    let mut panicked = false;
    let mut result = match valid {
        Err(error) => Err(error),
        Ok(()) => {
            if cancel
                .as_ref()
                .is_some_and(|cancel| cancel.load(Ordering::Acquire))
            {
                return (
                    Err(rusqlite::Error::SqliteFailure(
                        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_INTERRUPT),
                        None,
                    )
                    .into()),
                    true,
                    false,
                );
            }
            if let Some(cancel) = cancel
                && let Err(error) =
                    connection.progress_handler(1000, Some(move || cancel.load(Ordering::Acquire)))
            {
                return (Err(error.into()), false, false);
            }
            let result =
                catch_unwind(AssertUnwindSafe(|| operation(connection))).unwrap_or_else(|_| {
                    panicked = true;
                    Err(StoreError::OperationUnknown)
                });
            if let Err(error) = connection.progress_handler(0, None::<fn() -> bool>) {
                return (Err(error.into()), false, panicked);
            }
            result
        }
    };
    if !connection.is_autocommit() {
        match connection.execute_batch("ROLLBACK") {
            Ok(()) => {
                if result.is_ok() {
                    result = Err(StoreError::InvalidTransition(
                        "database operation left an unfinished transaction".into(),
                    ));
                }
            }
            Err(cleanup) => {
                return (
                    Err(StoreError::RollbackFailed {
                        cause: Arc::new(result.err().unwrap_or(StoreError::OperationUnknown)),
                        cleanup,
                    }),
                    false,
                    panicked,
                );
            }
        }
    }
    (result, true, panicked)
}

impl OwnedConnection {
    pub(crate) fn owner_identity(&self) -> std::sync::Weak<AtomicU64> {
        Arc::downgrade(&self.writer.failures)
    }
    pub(crate) fn cloned(&self) -> Self {
        Self {
            admission: self.admission.clone(),
            writer: self.writer.clone(),
            reads: self.reads.clone(),
            observations: self.observations.clone(),
            read_on_owner: self.read_on_owner,
            temporary: self.temporary,
            closed: self.closed.clone(),
            changes: self.changes.clone(),
            custody: self.custody.clone(),
            idle_readers: self.idle_readers.clone(),
            read_slots: self.read_slots.clone(),
        }
    }
    pub(crate) fn scoped(&self, custody: Custody) -> Self {
        let mut value = self.cloned();
        value.custody = Some(custody::combine(&value.custody, custody));
        value.writer.custody = value.custody.clone();
        value
    }
    pub(crate) fn observations(&self) -> ObservationIngress {
        ObservationIngress {
            jobs: self.observations.clone(),
            custody: self.custody.clone(),
        }
    }
    #[cfg(test)]
    pub(crate) fn writer(&self) -> WriterIngress {
        self.writer.clone()
    }
    pub(crate) async fn write<S: crate::writeback::Statement>(
        &self,
        statement: S,
        commits: crate::commits::CommitNotice,
    ) -> Result<S::Output, StoreError>
    where
        crate::writeback::Request: From<crate::writeback::Pending<S>>,
    {
        self.require_open()?;
        self.writer.write(statement, commits).await
    }
    fn require_open(&self) -> Result<(), StoreError> {
        if self.admission.accepting.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(StoreError::ConnectionClosed)
        }
    }
    pub fn subscribe_changes(&self) -> watch::Receiver<()> {
        self.changes.clone()
    }
    pub(crate) fn close_receipt(&self) -> Shared<BoxFuture<'static, Result<(), String>>> {
        self.closed.clone()
    }
    pub async fn open(
        options: OpenOptions,
        authority: ConnectionAuthority,
        initialize: impl FnOnce(&mut Connection) -> Result<(), StoreError> + Send + 'static,
    ) -> Result<Self, StoreError> {
        Self::start(options, authority, initialize, None, None).await
    }
    pub(crate) async fn open_tracked(
        options: OpenOptions,
        authority: ConnectionAuthority,
        initialize: impl FnOnce(&mut Connection) -> Result<(), StoreError> + Send + 'static,
        registration: crate::root_store::StageRegistration,
    ) -> Result<Self, StoreError> {
        Self::start(options, authority, initialize, Some(registration), None).await
    }
    pub async fn from_temporary_connection(connection: Connection) -> Result<Self, StoreError> {
        Self::start(
            OpenOptions::temporary(),
            ConnectionAuthority::Temporary,
            |_| Ok(()),
            None,
            Some(connection),
        )
        .await
    }
    async fn start(
        options: OpenOptions,
        authority: ConnectionAuthority,
        initialize: impl FnOnce(&mut Connection) -> Result<(), StoreError> + Send + 'static,
        mut registration: Option<crate::root_store::StageRegistration>,
        existing: Option<Connection>,
    ) -> Result<Self, StoreError> {
        let read_on_owner =
            options.local() || matches!(authority, ConnectionAuthority::Inspection { .. });
        let temporary = options.path.as_os_str().is_empty();
        let (jobs, receiver) = async_channel::bounded(WRITE_CAPACITY);
        let (preparations, preparation_receiver) =
            async_channel::bounded::<Preparation>(WRITE_CAPACITY);
        let (reads, read_receivers): (Vec<_>, Vec<_>) =
            (0..PURE_READERS).map(|_| async_channel::bounded(1)).unzip();
        let (observations, observation_receiver) = async_channel::bounded(1);
        let (idle_readers, read_slots) = async_channel::bounded(PURE_READERS);
        for index in 0..PURE_READERS {
            idle_readers
                .try_send(index)
                .expect("new reader-slot channel fits every lane");
        }
        let accepting = Arc::new(AtomicBool::new(true));
        let failures = Arc::new(AtomicU64::new(0));
        let capacity = Arc::new(Semaphore::new(WRITE_CAPACITY));
        let (changed, changes) = watch::channel(());
        let (ready, initialized) = oneshot::channel();
        let (closed, completion) = oneshot::channel();
        let admission = Arc::new(Admission {
            accepting: accepting.clone(),
            reads: reads.clone(),
            observations: observations.clone(),
            writer: jobs.clone(),
            idle_readers: idle_readers.clone(),
        });
        let handle = Self {
            admission,
            writer: WriterIngress {
                jobs: jobs.clone(),
                failures,
                capacity,
                preparations: preparations.clone(),
                custody: None,
            },
            reads: reads.clone(),
            observations: observations.clone(),
            read_on_owner,
            temporary,
            closed: async move {
                completion
                    .await
                    .unwrap_or_else(|_| Err("database actor terminated without closing".into()))
            }
            .boxed()
            .shared(),
            changes,
            custody: None,
            idle_readers: idle_readers.clone(),
            read_slots,
        };
        std::thread::Builder::new()
            .name("runtime-sqlite-writer".into())
            .spawn(move || {
                if let Some(registration) = &mut registration {
                    registration.started();
                }
                let authority = Arc::new(authority);
                let initialized_connection = authority.validate().and_then(|()| match existing {
                    Some(connection) => Ok(connection),
                    None => options.open(),
                });
                let mut connection = match initialized_connection {
                    Ok(connection) => connection,
                    Err(error) => {
                        let _ = ready.send(Err(error));
                        if let Some(registration) = &mut registration {
                            registration.complete(true);
                        }
                        drop(authority);
                        let _ = closed.send(Ok(()));
                        return;
                    }
                };
                let init = catch_unwind(AssertUnwindSafe(|| initialize(&mut connection)))
                    .unwrap_or(Err(StoreError::Initialization));
                if init.is_err() || ready.is_closed() {
                    let cleanup = close(connection, &authority, Vec::new());
                    let _ = ready.send(Err(init.err().unwrap_or(StoreError::Initialization)));
                    if let Some(registration) = &mut registration {
                        registration.complete(cleanup.is_ok());
                    }
                    drop(authority);
                    let _ = closed.send(cleanup);
                    return;
                }
                let mut remaining_readers = 0usize;
                let mut startup_error = None;
                let mut readers = Vec::new();
                let mut preparers = Vec::new();
                for _ in 0..2 {
                    let input = preparation_receiver.clone();
                    match std::thread::Builder::new()
                        .name("runtime-sqlite-prepare".into())
                        .spawn(move || {
                            while let Ok(job) = input.recv_blocking() {
                                let _ = catch_unwind(AssertUnwindSafe(job));
                            }
                        }) {
                        Ok(thread) => preparers.push(thread),
                        Err(error) => {
                            startup_error.get_or_insert(StoreError::Io(error));
                            accepting.store(false, Ordering::Release);
                            idle_readers.close();
                            for lane in &reads {
                                lane.close();
                            }
                            observations.close();
                        }
                    }
                }
                if !read_on_owner {
                    for (role, input) in read_receivers
                        .into_iter()
                        .map(|input| (false, input))
                        .chain(std::iter::once((true, observation_receiver)))
                    {
                        let input = input.clone();
                        let output = jobs.clone();
                        let authority = authority.clone();
                        let options = options.clone();
                        let read_accepting = accepting.clone();
                        let read_idle = idle_readers.clone();
                        let read_lanes = reads.clone();
                        let read_observations = observations.clone();

                        match std::thread::Builder::new()
                            .name(
                                if role {
                                    "runtime-sqlite-observation"
                                } else {
                                    "runtime-sqlite-reader"
                                }
                                .into(),
                            )
                            .spawn(move || {
                                let result = catch_unwind(AssertUnwindSafe(|| {
                                    read_loop(input, options, authority, role)
                                }))
                                .unwrap_or_else(|_| Err("database reader panicked".into()));
                                if result.is_err() {
                                    read_accepting.store(false, Ordering::Release);
                                    read_idle.close();
                                    for lane in read_lanes {
                                        lane.close();
                                    }
                                    read_observations.close();
                                }
                                let _ = output.send_blocking(Envelope {
                                    command: Command::ReaderClosed(result),
                                    _custody: None,
                                    _permit: None,
                                });
                            }) {
                            Ok(reader) => {
                                remaining_readers += 1;
                                readers.push(reader);
                            }
                            Err(error) => {
                                startup_error.get_or_insert(StoreError::Io(error));
                                accepting.store(false, Ordering::Release);
                                idle_readers.close();
                                for lane in &reads {
                                    lane.close();
                                }
                                observations.close();
                            }
                        }
                    }
                }
                let _ = ready.send(startup_error.map_or(Ok(()), Err));
                let mut pending = None;
                let mut failure = None;
                let mut transfer = None;
                let mut retained = Vec::new();
                loop {
                    if !accepting.load(Ordering::Acquire) && remaining_readers == 0 {
                        receiver.close();
                    }
                    let envelope = match pending
                        .take()
                        .map(Ok)
                        .unwrap_or_else(|| receiver.recv_blocking())
                    {
                        Ok(value) => value,
                        Err(_) => break,
                    };
                    let before = connection.total_changes();
                    let mut active = Vec::new();
                    if let Some(custody) = envelope._custody {
                        active.push(custody);
                    }
                    let mut permits = Vec::new();
                    if let Some(permit) = envelope._permit {
                        permits.push(permit);
                    }
                    let (clean, notify): (bool, Option<Reply>) =
                        catch_unwind(AssertUnwindSafe(|| match envelope.command {
                            Command::Run(job) => {
                                let (clean, reply) = job(&mut connection, authority.validate());
                                (clean, Some(reply))
                            }
                            Command::PreparingRun(ready) => match ready.blocking_recv() {
                                Ok(job) => {
                                    let (clean, reply) = job(&mut connection, authority.validate());
                                    (clean, Some(reply))
                                }
                                Err(_) => (true, None),
                            },
                            Command::Write(first) => {
                                let mut group = Vec::new();
                                let mut rejected = Vec::new();
                                match first.resolve() {
                                    Ok(Some(request)) => group.push(request),
                                    Ok(None) => {}
                                    Err(reply) => rejected.push(reply),
                                }
                                while group.len() < WRITE_CAPACITY {
                                    match receiver.try_recv() {
                                        Ok(Envelope {
                                            command: Command::Write(next),
                                            _custody,
                                            _permit,
                                        }) => {
                                            if let Some(custody) = _custody {
                                                active.push(custody);
                                            }
                                            if let Some(permit) = _permit {
                                                permits.push(permit);
                                            }
                                            match next.resolve() {
                                                Ok(Some(request)) => group.push(request),
                                                Ok(None) => {}
                                                Err(reply) => rejected.push(reply),
                                            }
                                        }
                                        Ok(other) => {
                                            pending = Some(other);
                                            break;
                                        }
                                        Err(_) => break,
                                    }
                                }
                                if group.is_empty() {
                                    (
                                        true,
                                        Some(Box::new(move || {
                                            for reply in rejected {
                                                reply();
                                            }
                                        }) as Reply),
                                    )
                                } else {
                                    let (clean, finish) =
                                        crate::writeback::commit(&mut connection, group, &|| {
                                            authority.validate()
                                        });
                                    (
                                        clean,
                                        Some(Box::new(move || {
                                            for reply in rejected {
                                                reply();
                                            }
                                            finish();
                                        }) as Reply),
                                    )
                                }
                            }
                            Command::Wake => (true, None),
                            Command::ReaderClosed(result) => {
                                remaining_readers -= 1;
                                if let Err(error) = result {
                                    failure.get_or_insert(error);
                                    accepting.store(false, Ordering::Release);
                                    idle_readers.close();
                                    for lane in &reads {
                                        lane.close();
                                    }
                                    observations.close();
                                }
                                (true, None)
                            }
                            Command::Take(reply) => {
                                accepting.store(false, Ordering::Release);
                                idle_readers.close();
                                for lane in &reads {
                                    lane.close();
                                }
                                observations.close();
                                transfer = Some(reply);
                                (true, None)
                            }
                        }))
                        .unwrap_or_else(|_| {
                            (
                                connection.progress_handler(0, None::<fn() -> bool>).is_ok()
                                    && (connection.is_autocommit()
                                        || connection.execute_batch("ROLLBACK").is_ok()),
                                None,
                            )
                        });
                    if connection.total_changes() != before {
                        changed.send_replace(());
                    }
                    let healthy = clean && connection.is_autocommit();
                    if healthy {
                        drop(active);
                        drop(permits);
                        if let Some(notify) = notify {
                            notify();
                        }
                    } else {
                        retained.extend(active);
                        drop(permits);
                        idle_readers.close();
                        failure.get_or_insert("database transaction cleanup failed".into());
                        accepting.store(false, Ordering::Release);
                        for lane in &reads {
                            lane.close();
                        }
                        observations.close();
                        receiver.close();
                        if let Some(notify) = notify {
                            notify();
                        }
                        break;
                    }
                }
                // Stop all producers before joining readers; writer never waits for a live read job.
                for lane in &reads {
                    lane.close();
                }
                observations.close();
                drop(pending.take());
                while let Ok(envelope) = receiver.try_recv() {
                    drop(envelope);
                }
                drop(receiver);
                for reader in readers {
                    if reader.join().is_err() {
                        failure.get_or_insert("database reader panicked".into());
                    }
                }
                preparations.close();
                for preparer in preparers {
                    if preparer.join().is_err() {
                        failure.get_or_insert("database preparation worker panicked".into());
                    }
                }
                let result = if let Some(reply) = transfer {
                    if failure.is_none() {
                        match reply.send(Ok(connection)) {
                            Ok(()) => Ok(()),
                            Err(Ok(connection)) => {
                                close(connection, &authority, std::mem::take(&mut retained))
                            }
                            Err(Err(_)) => unreachable!(),
                        }
                    } else {
                        let _ = reply.send(Err(StoreError::CloseFailed(failure.clone().unwrap())));
                        close(connection, &authority, std::mem::take(&mut retained))
                    }
                } else {
                    close(connection, &authority, std::mem::take(&mut retained))
                };
                let physical_closed = result.is_ok();
                if let Err(error) = result {
                    failure.get_or_insert(error);
                }
                if let Some(registration) = &mut registration {
                    registration.complete(physical_closed);
                }
                drop(authority);
                drop(retained);
                let _ = closed.send(failure.map_or(Ok(()), Err));
            })?;
        match initialized.await.unwrap_or(Err(StoreError::Initialization)) {
            Ok(()) => Ok(handle),
            Err(cause) => match handle.shutdown().await {
                Ok(()) => Err(cause),
                Err(cleanup) => Err(StoreError::StartupCleanupFailed {
                    cause: Box::new(cause),
                    cleanup: Box::new(cleanup),
                }),
            },
        }
    }
    pub async fn run<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.require_open()?;
        self.writer.run(operation).await
    }
    pub async fn run_prepared<P: Send + 'static, T: Send + 'static>(
        &self,
        prepare: impl FnOnce() -> Result<P, StoreError> + Send + 'static,
        operation: impl FnOnce(&mut Connection, P) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.require_open()?;
        self.writer.run_prepared(prepare, operation).await
    }
    pub(crate) fn request_shutdown(&self) {
        self.admission.stop();
    }
    pub async fn shutdown(&self) -> Result<(), StoreError> {
        self.request_shutdown();
        self.closed.clone().await.map_err(StoreError::CloseFailed)
    }
    pub async fn close(self) -> Result<(), StoreError> {
        self.shutdown().await
    }
    pub async fn into_temporary_connection(self) -> Result<Connection, StoreError> {
        if !self.temporary {
            return Err(StoreError::InvalidTransition(
                "only an anonymous database can leave its actor".into(),
            ));
        }
        self.require_open()?;
        let (reply, result) = oneshot::channel();
        self.writer
            .jobs
            .send(Envelope {
                command: Command::Take(reply),
                _custody: None,
                _permit: None,
            })
            .await
            .map_err(|_| StoreError::ConnectionClosed)?;
        let connection = result.await.map_err(|_| StoreError::OperationUnknown)??;
        self.closed.clone().await.map_err(StoreError::CloseFailed)?;
        Ok(connection)
    }
    pub(crate) async fn read<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.read_job(operation, false, false).await
    }
    pub(crate) async fn read_interruptible<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.read_job(operation, false, true).await
    }
    pub(crate) async fn observe<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.read_job(operation, true, true).await
    }
    async fn read_job<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, StoreError> + Send + 'static,
        observation: bool,
        interruptible: bool,
    ) -> Result<T, StoreError> {
        self.require_open()?;
        if self.read_on_owner {
            return self.run(operation).await;
        }
        let cancel = Arc::new(AtomicBool::new(false));
        struct Cancel(Arc<AtomicBool>);
        impl Drop for Cancel {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let _cancel = Cancel(cancel.clone());
        let (reply, result) = oneshot::channel();
        let slot = if observation {
            None
        } else {
            Some(ReadSlot {
                index: self
                    .read_slots
                    .recv()
                    .await
                    .map_err(|_| StoreError::ConnectionClosed)?,
                idle: self.idle_readers.clone(),
            })
        };
        let jobs = match &slot {
            Some(slot) => &self.reads[slot.index],
            None => &self.observations,
        };
        jobs.send(ReadJob {
            _slot: slot,
            open: true,
            _custody: self.custody.clone(),
            run: Box::new(move |db, valid| {
                let connection = match db {
                    Some(connection) => connection,
                    None => {
                        let error = valid.err().unwrap_or(StoreError::Initialization);
                        return (
                            true,
                            Box::new(move || {
                                let _ = reply.send(Err(error));
                            }),
                        );
                    }
                };
                let (value, clean, panicked) = execute(
                    connection,
                    valid,
                    operation,
                    interruptible.then_some(cancel),
                );
                (
                    clean && !panicked,
                    Box::new(move || {
                        let _ = reply.send(value);
                    }),
                )
            }),
        })
        .await
        .map_err(|_| StoreError::ConnectionClosed)?;
        result.await.map_err(|_| StoreError::OperationUnknown)?
    }
}
fn read_loop(
    input: Receiver<ReadJob>,
    mut options: OpenOptions,
    authority: Arc<ConnectionAuthority>,
    observation: bool,
) -> Result<(), String> {
    options.create = false;
    options.read_only = true;
    let mut connection = None;
    while let Ok(ReadJob {
        _slot,
        open,
        run,
        _custody,
    }) = input.recv_blocking()
    {
        let mut valid = authority.validate();
        if valid.is_ok() && open && connection.is_none() {
            valid = (|| {
                let db = options.open()?;
                crate::sqlite_functions::register(&db)?;
                if observation {
                    crate::transcript::initialize_cache(&db)?;
                }
                connection = Some(db);
                Ok(())
            })();
        }
        let (clean, notify) = match catch_unwind(AssertUnwindSafe(|| run(&mut connection, valid))) {
            Ok((clean, notify)) => (clean, Some(notify)),
            Err(_) => (false, None),
        };
        if !clean && let Some(db) = connection.take() {
            let result = close(db, &authority, _custody.into_iter().collect());
            drop(_slot);
            if let Some(notify) = notify {
                notify();
            }
            result?;
            continue;
        }
        drop(_custody);
        drop(_slot);
        if let Some(notify) = notify {
            notify();
        }
    }
    if let Some(db) = connection {
        close(db, &authority, Vec::new())?;
    }
    Ok(())
}
fn close(
    connection: Connection,
    authority: &Arc<ConnectionAuthority>,
    custody: Vec<Custody>,
) -> Result<(), String> {
    connection.close().map_err(|(connection, error)| {
        // SQLite returned a live handle. Keep its authority until process exit;
        // dropping the wrapper would merely retry close and discard another error.
        std::mem::forget((connection, authority.clone(), custody));
        error.to_string()
    })
}

#[cfg(test)]
mod tests;
