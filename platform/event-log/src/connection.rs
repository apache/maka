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
use async_channel::Sender;
use futures_util::{FutureExt, future::Shared};
use rusqlite::{Connection, OpenFlags};
use std::{
    collections::VecDeque,
    future::Future,
    panic::{AssertUnwindSafe, catch_unwind},
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Condvar, Mutex,
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

/// A synchronous, read-only SQL query owned by a trusted native domain.
/// No connection escapes this method. Queries perform no network or external
/// runtime effects. Source materialization may stream immutable bytes into an
/// already-owned temporary prepared backing on this blocking lane; it must not
/// write arbitrary user files or re-enter the writer.
pub trait Query: Send + 'static {
    type Output: Send + 'static;
    fn execute(self, connection: &Connection) -> Result<Self::Output, StoreError>;
}

const WRITE_CAPACITY: usize = 32;

static SQLITE_CONFIGURED: std::sync::Once = std::sync::Once::new();

/// Disable SQLite's global MEMSTATUS allocator mutex before initialization so
/// concurrent WAL readers and the writer do not serialize on `sqlite3Malloc`.
pub fn configure_sqlite() {
    SQLITE_CONFIGURED.call_once(|| {
        // SAFETY: `SQLITE_CONFIG_MEMSTATUS` takes a single `c_int` boolean (0 = off).
        // Calling before `sqlite3_initialize` disables the global `SQLITE_MUTEX_STATIC_MEM`
        // lock; if SQLite is already initialized in a shared test process, SQLite safely
        // returns `SQLITE_MISUSE` without side effects.
        unsafe {
            let _ = rusqlite::ffi::sqlite3_config(
                rusqlite::ffi::SQLITE_CONFIG_MEMSTATUS,
                0 as std::ffi::c_int,
            );
        }
    });
}

fn pure_reader_count() -> usize {
    std::thread::available_parallelism().map_or(4, |count| count.get().clamp(4, 8))
}

/// Physical SQLite opening policy. Anonymous databases stay on their own actor.
#[derive(Clone)]
pub struct OpenOptions {
    path: PathBuf,
    create: bool,
    read_only: bool,
    exclusive: bool,
    immutable: bool,
    worker_pool: bool,
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
            worker_pool: false,
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
    pub(crate) fn worker_pool(mut self, value: bool) -> Self {
        self.worker_pool = value;
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
        configure_sqlite();
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
type Job = Box<
    dyn FnOnce(&mut Connection, Result<(), StoreError>, &watch::Sender<()>) -> (bool, Reply) + Send,
>;
struct Envelope {
    command: Command,
    _custody: Option<Custody>,
    _permit: Option<Arc<tokio::sync::OwnedSemaphorePermit>>,
}
enum Command {
    Run(Job),
    Write(PreparedWrite),
    Wake,
    ReaderClosed(Result<(), String>),
    Take(oneshot::Sender<Result<Connection, StoreError>>),
}
enum PreparedWrite {
    Ready(crate::writeback::Request),
    Preparing(oneshot::Receiver<Option<crate::writeback::Request>>),
}
impl PreparedWrite {
    fn resolve(self) -> Option<crate::writeback::Request> {
        match self {
            Self::Ready(request) => Some(request),
            Self::Preparing(receiver) => receiver.blocking_recv().ok().flatten(),
        }
    }
}
type ReadOperation =
    Box<dyn FnOnce(&mut Option<Connection>, Result<(), StoreError>) -> (bool, Reply) + Send>;
struct ReadQueue {
    closed: bool,
    active_readers: usize,
    shared: VecDeque<ReadJob>,
    targeted: Vec<VecDeque<ReadJob>>,
}

/// Fair MPMC read queue shared by the SQLite reader threads.
/// Callers enqueue synchronously without awaiting a reader slot, avoiding both
/// wake-all thundering herds and deadlocks when a dormant child future queued first.
struct ReadDispatcher {
    readers: usize,
    queue: Mutex<ReadQueue>,
    available: Condvar,
}

impl ReadDispatcher {
    fn new(readers: usize) -> Self {
        Self {
            readers,
            queue: Mutex::new(ReadQueue {
                closed: false,
                active_readers: 0,
                shared: VecDeque::new(),
                targeted: (0..readers).map(|_| VecDeque::new()).collect(),
            }),
            available: Condvar::new(),
        }
    }

    fn reader_count(&self) -> usize {
        self.readers
    }

    fn register_reader(&self) {
        self.queue.lock().unwrap().active_readers += 1;
    }

    fn enqueue(&self, job: ReadJob) -> Result<(), StoreError> {
        let mut queue = self.queue.lock().unwrap();
        if queue.closed {
            return Err(StoreError::ConnectionClosed);
        }
        queue.shared.push_back(job);
        drop(queue);
        self.available.notify_one();
        Ok(())
    }

    fn enqueue_targeted_all(&self, jobs: Vec<ReadJob>) -> Result<(), StoreError> {
        debug_assert_eq!(jobs.len(), self.readers);
        let mut queue = self.queue.lock().unwrap();
        if queue.closed || queue.active_readers < self.readers {
            return Err(StoreError::ConnectionClosed);
        }
        for (index, job) in jobs.into_iter().enumerate() {
            queue.targeted[index].push_back(job);
        }
        drop(queue);
        self.available.notify_all();
        Ok(())
    }

    fn pop(&self, index: usize) -> Option<ReadJob> {
        let mut queue = self.queue.lock().unwrap();
        loop {
            if let Some(job) = queue.targeted[index].pop_front() {
                return Some(job);
            }
            if let Some(job) = queue.shared.pop_front() {
                return Some(job);
            }
            if queue.closed {
                return None;
            }
            queue = self.available.wait(queue).unwrap();
        }
    }

    fn close(&self) {
        let mut queue = self.queue.lock().unwrap();
        if !queue.closed {
            queue.closed = true;
            self.available.notify_all();
        }
    }

    fn reader_exited(&self, index: usize) {
        let mut queue = self.queue.lock().unwrap();
        queue.targeted[index].clear();
        queue.active_readers = queue.active_readers.saturating_sub(1);
        if queue.active_readers == 0 {
            queue.shared.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;
    use std::task::{Context, Poll, Wake, Waker};
    use std::time::Duration;

    #[derive(Default)]
    struct WakeFlag(AtomicBool);

    impl Wake for WakeFlag {
        fn wake(self: Arc<Self>) {
            self.0.store(true, Ordering::Relaxed);
        }
    }

    #[tokio::test]
    async fn returned_reader_wakes_a_driver_behind_its_children() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("driver-behind-child.sqlite");
        let conn = Arc::new(
            OwnedConnection::open(
                OpenOptions::file(&db_path).create(true).worker_pool(true),
                ConnectionAuthority::Temporary,
                |c| {
                    c.execute_batch(
                        "PRAGMA journal_mode = WAL; CREATE TABLE items(v INTEGER NOT NULL); INSERT INTO items(v) VALUES (42);",
                    )?;
                    Ok(())
                },
            )
            .await
            .unwrap(),
        );

        let reader_count = pure_reader_count();
        let entered = Arc::new(Barrier::new(reader_count + 1));
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let mut blockers = Vec::with_capacity(reader_count);
        for _ in 0..reader_count {
            let conn = conn.clone();
            let entered = entered.clone();
            let release = release.clone();
            blockers.push(tokio::spawn(async move {
                conn.read(move |_| {
                    entered.wait();
                    let (lock, cv) = &*release;
                    let mut go = lock.lock().unwrap();
                    while !*go {
                        go = cv.wait(go).unwrap();
                    }
                    Ok(())
                })
                .await
                .unwrap();
            }));
        }
        // Wait until every SQLite reader thread is occupied.
        tokio::task::spawn_blocking(move || entered.wait())
            .await
            .unwrap();

        // Older child read is polled once and then left parked without being polled again.
        let mut child = std::pin::pin!(
            conn.read(|c| { Ok(c.query_row("SELECT v FROM items", [], |r| r.get::<_, i64>(0))?) })
        );
        let mut driver = std::pin::pin!(
            conn.read(|c| { Ok(c.query_row("SELECT v FROM items", [], |r| r.get::<_, i64>(0))?) })
        );
        let wake = Arc::new(WakeFlag::default());
        let waker = Waker::from(wake.clone());
        assert!(
            child
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
                .is_pending()
        );
        assert!(
            driver
                .as_mut()
                .poll(&mut Context::from_waker(&waker))
                .is_pending()
        );

        {
            let (lock, cv) = &*release;
            *lock.lock().unwrap() = true;
            cv.notify_all();
        }
        for blocker in blockers {
            blocker.await.unwrap();
        }

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !wake.0.load(Ordering::Acquire) {
            assert!(
                std::time::Instant::now() < deadline,
                "driver was not woken while older child stayed parked"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let Poll::Ready(Ok(value)) = driver.as_mut().poll(&mut Context::from_waker(&waker)) else {
            panic!("driver must complete while the older child is parked");
        };
        assert_eq!(value, 42);
        conn.shutdown().await.unwrap();
    }

    struct OffThreadInsert(i64);
    impl crate::writeback::Statement for OffThreadInsert {
        type Output = i64;
        type Value = i64;
        const PREPARE_OFF_THREAD: bool = true;

        fn execute(
            self,
            connection: &Connection,
        ) -> Result<crate::writeback::Prepared<i64>, StoreError> {
            connection.execute("INSERT INTO items(v) VALUES(?1)", [self.0])?;
            Ok(crate::writeback::Prepared {
                value: self.0,
                changed: true,
                notification: crate::writeback::Notification::default(),
            })
        }
        fn committed(value: i64) -> i64 {
            value
        }
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }

    #[tokio::test]
    async fn writer_only_connection_runs_reads_and_off_thread_writes_without_pool_threads() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("single.sqlite");
        let conn = OwnedConnection::open(
            OpenOptions::file(&db_path).create(true),
            ConnectionAuthority::Temporary,
            |c| {
                c.execute_batch("CREATE TABLE items(v INTEGER NOT NULL);")?;
                Ok(())
            },
        )
        .await
        .unwrap();

        let commits = crate::commits::CommitHub::new();
        assert_eq!(
            conn.write(OffThreadInsert(7), commits.notice())
                .await
                .unwrap(),
            7
        );
        let value: i64 = conn
            .read(|c| Ok(c.query_row("SELECT v FROM items", [], |r| r.get(0))?))
            .await
            .unwrap();
        assert_eq!(value, 7);

        let stats = conn.resource_stats().await.unwrap();
        assert!(stats.readers.is_empty());
        conn.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn worker_pool_connection_opens_reader_lanes_and_runs_off_thread_writes() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("pooled.sqlite");
        let conn = OwnedConnection::open(
            OpenOptions::file(&db_path).create(true).worker_pool(true),
            ConnectionAuthority::Temporary,
            |c| {
                c.execute_batch(
                    "PRAGMA journal_mode = WAL; CREATE TABLE items(v INTEGER NOT NULL);",
                )?;
                Ok(())
            },
        )
        .await
        .unwrap();

        let commits = crate::commits::CommitHub::new();
        assert_eq!(
            conn.write(OffThreadInsert(9), commits.notice())
                .await
                .unwrap(),
            9
        );
        let value: i64 = conn
            .read(|c| Ok(c.query_row("SELECT v FROM items", [], |r| r.get(0))?))
            .await
            .unwrap();
        assert_eq!(value, 9);

        let stats = conn.resource_stats().await.unwrap();
        assert_eq!(stats.readers.len(), pure_reader_count());
        assert!(stats.readers.iter().any(Option::is_some));
        conn.shutdown().await.unwrap();
    }
}

struct ReadJob {
    open: bool,
    run: ReadOperation,
    _custody: Option<Custody>,
}
struct Admission {
    accepting: Arc<AtomicBool>,
    reads: Arc<ReadDispatcher>,
    writer: Sender<Envelope>,
}
impl Admission {
    fn stop(&self) {
        self.accepting.store(false, Ordering::Release);
        self.reads.close();
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

#[derive(Clone, Copy, PartialEq, Eq)]
struct WriterIdentity(usize);
impl WriterIdentity {
    fn of(connection: &Connection) -> Self {
        // SAFETY: the borrow keeps this SQLite handle live. Only its address is
        // copied for identity comparison; the raw pointer is never dereferenced.
        Self(unsafe { connection.handle() } as usize)
    }
}
struct CloseWriterIngress {
    ingress: Sender<Envelope>,
    physical_released: Arc<AtomicBool>,
}
impl Drop for CloseWriterIngress {
    fn drop(&mut self) {
        self.physical_released.store(true, Ordering::Release);
        self.ingress.close();
    }
}

pub struct OwnedConnection {
    admission: Arc<Admission>,
    writer_identity: WriterIdentity,
    physical_released: Arc<AtomicBool>,
    writer: WriterIngress,
    read_on_owner: bool,
    temporary: bool,
    closed: Shared<BoxFuture<'static, Result<(), String>>>,
    changes: watch::Receiver<()>,
    custody: Option<Custody>,
}
#[derive(Clone)]
pub(crate) struct WriterIngress {
    jobs: Sender<Envelope>,
    failures: Arc<AtomicU64>,
    capacity: Arc<Semaphore>,
    preparations: Option<Sender<Preparation>>,
    custody: Option<Custody>,
}
impl WriterIngress {
    pub(crate) async fn write<S: crate::writeback::Statement>(
        &self,
        statement: S,
        commits: crate::commits::CommitNotice,
    ) -> Result<S::Output, StoreError> {
        let permit = Arc::new(
            self.capacity
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| StoreError::ConnectionClosed)?,
        );
        let (reply, result) = oneshot::channel();
        let pending =
            crate::writeback::Pending::new(statement, commits, reply, self.failures.clone());
        if S::PREPARE_OFF_THREAD
            && let Some(preparations) = &self.preparations
        {
            let (prepared, ready) = oneshot::channel();
            self.jobs
                .send(Envelope {
                    command: Command::Write(PreparedWrite::Preparing(ready)),
                    _custody: self.custody.clone(),
                    _permit: Some(permit.clone()),
                })
                .await
                .map_err(|_| StoreError::ConnectionClosed)?;
            preparations
                .try_send(Box::new(move || {
                    let _permit = permit;
                    let _ = prepared.send(Some(pending.prepare().into_request()));
                }))
                .map_err(|_| StoreError::ConnectionClosed)?;
        } else {
            let request = pending.prepare().into_request();
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
                command: Command::Run(Box::new(move |connection, valid, changed| {
                    let before = connection.total_changes();
                    let (result, clean, _) = execute(connection, valid, operation);
                    if result.is_err() {
                        failures.fetch_add(1, Ordering::AcqRel);
                    }
                    if result.is_ok() && connection.total_changes() != before {
                        changed.send_replace(());
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
) -> (Result<T, StoreError>, bool, bool) {
    let mut panicked = false;
    let mut result = match valid {
        Err(error) => Err(error),
        Ok(()) => {
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
    pub(crate) fn require_same_writer(&self, connection: &Connection) -> Result<(), StoreError> {
        if self.writer_identity != WriterIdentity::of(connection) {
            return Err(StoreError::InvalidTransition(
                "foreign physical Root writer".into(),
            ));
        }
        // Read release after comparing the handle, preventing address-reuse ABA.
        // Ingress can close while accepted jobs drain; only physical EOF/transfer
        // or unwind marks release before SQLite can be freed or transferred.
        if self.physical_released.load(Ordering::Acquire) {
            return Err(StoreError::ConnectionClosed);
        }
        Ok(())
    }
    pub(crate) fn cloned(&self) -> Self {
        Self {
            admission: self.admission.clone(),
            writer_identity: self.writer_identity,
            physical_released: self.physical_released.clone(),
            writer: self.writer.clone(),
            read_on_owner: self.read_on_owner,
            temporary: self.temporary,
            closed: self.closed.clone(),
            changes: self.changes.clone(),
            custody: self.custody.clone(),
        }
    }
    pub(crate) fn scoped(&self, custody: Custody) -> Self {
        let mut value = self.cloned();
        value.custody = Some(custody::combine(&value.custody, custody));
        value.writer.custody = value.custody.clone();
        value
    }

    pub(crate) async fn write<S: crate::writeback::Statement>(
        &self,
        statement: S,
        commits: crate::commits::CommitNotice,
    ) -> Result<S::Output, StoreError> {
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
        Self::start(options, authority, initialize, None).await
    }
    pub async fn from_temporary_connection(connection: Connection) -> Result<Self, StoreError> {
        Self::start(
            OpenOptions::temporary(),
            ConnectionAuthority::Temporary,
            |_| Ok(()),
            Some(connection),
        )
        .await
    }
    async fn start(
        options: OpenOptions,
        authority: ConnectionAuthority,
        initialize: impl FnOnce(&mut Connection) -> Result<(), StoreError> + Send + 'static,
        existing: Option<Connection>,
    ) -> Result<Self, StoreError> {
        let read_on_owner = !options.worker_pool
            || options.local()
            || matches!(authority, ConnectionAuthority::Inspection { .. });
        let use_preparers =
            options.worker_pool && !matches!(authority, ConnectionAuthority::Inspection { .. });
        let temporary = options.path.as_os_str().is_empty();
        let (jobs, receiver) = async_channel::bounded(WRITE_CAPACITY);
        let (preparations, preparation_receiver) = if use_preparers {
            let (tx, rx) = async_channel::bounded::<Preparation>(WRITE_CAPACITY);
            (Some(tx), Some(rx))
        } else {
            (None, None)
        };
        let reader_count = if read_on_owner {
            0
        } else {
            pure_reader_count()
        };
        let reads = Arc::new(ReadDispatcher::new(reader_count));
        let accepting = Arc::new(AtomicBool::new(true));
        let physical_released = Arc::new(AtomicBool::new(false));
        let writer_physical_released = physical_released.clone();
        let failures = Arc::new(AtomicU64::new(0));
        let capacity = Arc::new(Semaphore::new(WRITE_CAPACITY));
        let (changed, changes) = watch::channel(());
        let (ready, initialized) = oneshot::channel();
        let (closed, completion) = oneshot::channel();
        let admission = Arc::new(Admission {
            accepting: accepting.clone(),
            reads: reads.clone(),
            writer: jobs.clone(),
        });
        let writer = WriterIngress {
            jobs: jobs.clone(),
            failures,
            capacity,
            preparations: preparations.clone(),
            custody: None,
        };
        let close_receipt = async move {
            completion
                .await
                .unwrap_or_else(|_| Err("database actor terminated without closing".into()))
        }
        .boxed()
        .shared();
        std::thread::Builder::new()
            .name("runtime-sqlite-writer".into())
            .spawn(move || {
                let authority = Arc::new(authority);
                let initialized_connection = authority.validate().and_then(|()| match existing {
                    Some(connection) => Ok(connection),
                    None => options.open(),
                });
                let mut connection = match initialized_connection {
                    Ok(connection) => connection,
                    Err(error) => {
                        writer_physical_released.store(true, Ordering::Release);
                        let _ = ready.send(Err(error));
                        drop(authority);
                        let _ = closed.send(Ok(()));
                        return;
                    }
                };
                // Declared after SQLite so unwind marks physical release before
                // the handle can be freed and its address reused by another actor.
                let _close_ingress = CloseWriterIngress {
                    ingress: jobs.clone(),
                    physical_released: writer_physical_released.clone(),
                };
                let init = catch_unwind(AssertUnwindSafe(|| initialize(&mut connection)))
                    .unwrap_or(Err(StoreError::Initialization));
                if init.is_err() || ready.is_closed() {
                    writer_physical_released.store(true, Ordering::Release);
                    receiver.close();
                    let cleanup = close(connection, &authority, Vec::new());
                    let _ = ready.send(Err(init.err().unwrap_or(StoreError::Initialization)));
                    drop(authority);
                    let _ = closed.send(cleanup);
                    return;
                }
                let mut remaining_readers = 0usize;
                let mut startup_error = None;
                let mut readers = Vec::new();
                let mut preparers = Vec::new();
                if let Some(preparation_receiver) = preparation_receiver {
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
                                reads.close();
                            }
                        }
                    }
                }
                if !read_on_owner {
                    for index in 0..reader_count {
                        let dispatcher = reads.clone();
                        let output = jobs.clone();
                        let authority = authority.clone();
                        let options = options.clone();
                        let read_accepting = accepting.clone();

                        match std::thread::Builder::new()
                            .name("runtime-sqlite-reader".into())
                            .spawn(move || {
                                let result = catch_unwind(AssertUnwindSafe(|| {
                                    read_loop(index, &dispatcher, options, authority)
                                }))
                                .unwrap_or_else(|_| Err("database reader panicked".into()));
                                if result.is_err() {
                                    read_accepting.store(false, Ordering::Release);
                                    dispatcher.close();
                                }
                                dispatcher.reader_exited(index);
                                let _ = output.send_blocking(Envelope {
                                    command: Command::ReaderClosed(result),
                                    _custody: None,
                                    _permit: None,
                                });
                            }) {
                            Ok(reader) => {
                                reads.register_reader();
                                remaining_readers += 1;
                                readers.push(reader);
                            }
                            Err(error) => {
                                startup_error.get_or_insert(StoreError::Io(error));
                                accepting.store(false, Ordering::Release);
                                reads.close();
                            }
                        }
                    }
                }
                let _ = ready
                    .send(startup_error.map_or_else(|| Ok(WriterIdentity::of(&connection)), Err));
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
                                let (clean, reply) =
                                    job(&mut connection, authority.validate(), &changed);
                                (clean, Some(reply))
                            }
                            Command::Write(first) => {
                                let mut group = Vec::new();
                                if let Some(request) = first.resolve() {
                                    group.push(request);
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
                                            if let Some(request) = next.resolve() {
                                                group.push(request);
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
                                    (true, None)
                                } else {
                                    let (clean, finish) = crate::writeback::commit(
                                        &mut connection,
                                        group,
                                        &|| authority.validate(),
                                        &changed,
                                    );
                                    (clean, Some(Box::new(finish) as Reply))
                                }
                            }
                            Command::Wake => (true, None),
                            Command::ReaderClosed(result) => {
                                remaining_readers -= 1;
                                if let Err(error) = result {
                                    failure.get_or_insert(error);
                                    accepting.store(false, Ordering::Release);
                                    reads.close();
                                }
                                (true, None)
                            }
                            Command::Take(reply) => {
                                accepting.store(false, Ordering::Release);
                                reads.close();
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
                        failure.get_or_insert("database transaction cleanup failed".into());
                        accepting.store(false, Ordering::Release);
                        reads.close();
                        receiver.close();
                        if let Some(notify) = notify {
                            notify();
                        }
                        break;
                    }
                }
                // Stop all producers before joining readers; writer never waits for a live read job.
                reads.close();
                drop(pending.take());
                while let Ok(envelope) = receiver.try_recv() {
                    drop(envelope);
                }
                receiver.close();
                drop(receiver);
                for reader in readers {
                    if reader.join().is_err() {
                        failure.get_or_insert("database reader panicked".into());
                    }
                }
                if let Some(preparations) = &preparations {
                    preparations.close();
                }
                for preparer in preparers {
                    if preparer.join().is_err() {
                        failure.get_or_insert("database preparation worker panicked".into());
                    }
                }
                writer_physical_released.store(true, Ordering::Release);
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
                if let Err(error) = result {
                    failure.get_or_insert(error);
                }
                drop(authority);
                drop(retained);
                let _ = closed.send(failure.map_or(Ok(()), Err));
            })?;
        match initialized.await.unwrap_or(Err(StoreError::Initialization)) {
            Ok(writer_identity) => Ok(Self {
                admission,
                writer_identity,
                physical_released,
                writer,
                read_on_owner,
                temporary,
                closed: close_receipt,
                changes,
                custody: None,
            }),
            Err(cause) => {
                admission.stop();
                match close_receipt.await.map_err(StoreError::CloseFailed) {
                    Ok(()) => Err(cause),
                    Err(cleanup) => Err(StoreError::StartupCleanupFailed {
                        cause: Box::new(cause),
                        cleanup: Box::new(cleanup),
                    }),
                }
            }
        }
    }
    pub async fn run<T: Send + 'static>(
        &self,
        operation: impl FnOnce(&mut Connection) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        self.require_open()?;
        self.writer.run(operation).await
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
        self.require_open()?;
        if self.read_on_owner {
            return self.run(operation).await;
        }
        let (reply, result) = oneshot::channel();
        self.admission.reads.enqueue(ReadJob {
            open: true,
            _custody: self.custody.clone(),
            run: Box::new(move |db, valid| {
                if reply.is_closed() {
                    return (true, Box::new(|| {}));
                }
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
                let (value, clean, panicked) = execute(connection, valid, operation);
                (
                    clean && !panicked,
                    Box::new(move || {
                        let _ = reply.send(value);
                    }),
                )
            }),
        })?;
        result.await.map_err(|_| StoreError::OperationUnknown)?
    }
}
fn read_loop(
    index: usize,
    dispatcher: &ReadDispatcher,
    mut options: OpenOptions,
    authority: Arc<ConnectionAuthority>,
) -> Result<(), String> {
    options.create = false;
    options.read_only = true;
    let mut connection = None;
    while let Some(ReadJob {
        open,
        run,
        _custody,
    }) = dispatcher.pop(index)
    {
        let mut valid = authority.validate();
        if valid.is_ok() && open && connection.is_none() {
            valid = (|| {
                let db = options.open()?;
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
            if let Some(notify) = notify {
                notify();
            }
            result?;
            continue;
        }
        drop(_custody);
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
