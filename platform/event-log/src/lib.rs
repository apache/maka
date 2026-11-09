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

//! Separate prototype database; does not open or migrate old Maka State Roots.

mod application_inspection;
pub mod applications;
pub mod checkpoints;
mod commits;
pub mod content;
pub use commits::SessionSubscription;
pub mod connection;
pub mod effects;
pub mod migration;
pub mod plugins;
pub mod projects;
pub mod root;
pub mod root_store;
pub use root_store::{RootStore, SessionStore};
mod schema;
pub use schema::ROOT_MIGRATIONS;
pub mod sessions;
pub mod shell_runs;
pub mod workspace;
pub mod workspace_bindings;

use std::path::Path;
use std::sync::Arc;

pub mod writeback;

use connection::OpenOptions;
use connection::{ConnectionAuthority, OwnedConnection};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(
        "Resource prefix is ambiguous in this Session; use a longer prefix or the full reference"
    )]
    AmbiguousReadResource,
    #[error(transparent)]
    Project(#[from] projects::ProjectError),
    #[error("event log already has a writer")]
    WriterBusy,
    #[error("not a supported Rust prototype event log; old Maka databases are not migrated")]
    UnsupportedDatabase,
    #[error("event identity conflicts with committed content")]
    EventConflict,
    #[error("session create request conflicts with committed configuration")]
    SessionConflict,
    #[error("Session creation was rejected: {0}")]
    SessionCreationRejected(root_store::CreationRejection),
    #[error("shell resource identity already exists")]
    ShellConflict,
    #[error("shell resource not found in this session")]
    ShellNotFound,
    #[error("session not found")]
    SessionNotFound,
    #[error("session retired")]
    SessionRetired,
    #[error("Root work cleanup is unconfirmed: {0}")]
    CleanupUnconfirmed(String),
    #[error("permission grant is no longer current")]
    PermissionRevoked,
    #[error("session has active native work")]
    SessionBusy,
    #[error("catalog revision changed from {expected} to {actual}")]
    RevisionConflict { expected: String, actual: String },
    #[error("Session revision changed from {expected} to {actual}")]
    SessionRevisionConflict { expected: u64, actual: u64 },
    #[error("external completion remains unresolved: {cause}")]
    CompletionUnresolved {
        #[source]
        cause: Arc<StoreError>,
    },
    #[error("{diagnostic}: {cause}")]
    StatementRejected {
        diagnostic: String,
        #[source]
        cause: Arc<StoreError>,
    },
    #[error("invalid event transition: {0}")]
    InvalidTransition(String),
    #[error("event log mutex poisoned")]
    Poisoned,
    #[error("event commit outcome unknown: {0}")]
    CommitUnknown(rusqlite::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error("database migration failed: {0}")]
    Migration(String),
    #[error(transparent)]
    Shared(Arc<StoreError>),
    #[error("{cause}; database rollback failed: {cleanup}")]
    RollbackFailed {
        #[source]
        cause: Arc<StoreError>,
        cleanup: rusqlite::Error,
    },
    #[error("database initialization worker failed")]
    Initialization,
    #[error("database connection closed before accepting the operation")]
    ConnectionClosed,
    #[error("accepted database operation outcome is unknown")]
    OperationUnknown,
    #[error("database close failed: {0}")]
    CloseFailed(String),
    #[error("database startup failed: {cause}; cleanup unconfirmed: {cleanup}")]
    StartupCleanupFailed {
        cause: Box<StoreError>,
        cleanup: Box<StoreError>,
    },
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

impl StoreError {
    /// Return the original cause of a failure shared by grouped writes.
    pub fn underlying(&self) -> &Self {
        match self {
            Self::Shared(error) => error.underlying(),
            Self::RollbackFailed { cause, .. } => cause.underlying(),
            error => error,
        }
    }
}

pub struct EventLog {
    expected_session: Option<Arc<str>>,
    // The independent owner drains SQLite work and closes the connection before releasing its lease.
    connection: OwnedConnection,
    root_owner: Option<Arc<root::RootOwner>>,
    operation_live: Arc<applications::operations::LiveOperations>,
    commits: commits::CommitHub,
    shell_changes: tokio::sync::broadcast::Sender<shell_runs::ShellChange>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OpenPurpose {
    Execution,
    ApplicationInspection,
}

impl EventLog {
    /// Observe canonical SQLite actors.
    pub async fn sqlite_resource_stats(
        &self,
    ) -> Result<connection::ConnectionResourceStats, StoreError> {
        self.connection.resource_stats().await
    }

    /// Root/SessionStore-only ingress carrying an already acquired SQL pin.
    /// All journals, notices and actual workers remain the original owner's.
    fn scoped(&self, custody: connection::custody::Custody) -> Self {
        Self {
            connection: self.connection.scoped(custody.clone()),
            expected_session: self.expected_session.clone(),
            root_owner: self.root_owner.clone(),
            operation_live: self.operation_live.clone(),
            commits: self.commits.clone(),
            shell_changes: self.shell_changes.clone(),
        }
    }

    /// Only SessionStore binds this private clone; no public raw log escapes.
    fn bind_session(mut self, session: Arc<str>) -> Self {
        self.expected_session = Some(session);
        self
    }

    fn check_bound_session(&self, session: &str) -> Result<(), StoreError> {
        Self::require_session_scope(self.expected_session.as_deref(), session)
    }

    fn require_session_scope(expected: Option<&str>, actual: &str) -> Result<(), StoreError> {
        if expected.is_some_and(|expected| expected != actual) {
            return Err(StoreError::InvalidTransition(
                "foreign Session resource".into(),
            ));
        }
        Ok(())
    }

    /// Inspect saved application state without migrations, derived initialization
    /// or stored member/byte changes. Retains the original Root and database lease until
    /// SQL close. Only application SELECT APIs using the owned connection belong
    /// to this opening; it is not a general-purpose read-only EventLog.
    pub async fn for_application_inspection(
        owner: Arc<root::RootOwner>,
    ) -> Result<Self, StoreError> {
        owner.validate_current()?;
        let path = owner.canonical_path().join(root::ROOT_DATABASE);
        Self::open_owned(&path, Some(owner), OpenPurpose::ApplicationInspection, &[]).await
    }

    /// Reuse the actual owned Root for another trusted native store. This is a
    /// writer lease, never a guest path or serialized authorization token.
    pub fn owned_root(&self) -> Result<Arc<root::RootOwner>, StoreError> {
        self.validate_root()?;
        self.root_owner.clone().ok_or_else(|| {
            StoreError::InvalidTransition("store requires an owned State Root".into())
        })
    }

    fn validate_root(&self) -> Result<(), StoreError> {
        if let Some(owner) = &self.root_owner {
            owner.validate_current()?;
        }
        Ok(())
    }

    pub async fn open(path: &Path) -> Result<Self, StoreError> {
        Self::open_owned(path, None, OpenPurpose::Execution, ROOT_MIGRATIONS).await
    }

    async fn open_owned(
        path: &Path,
        root_owner: Option<Arc<root::RootOwner>>,
        purpose: OpenPurpose,
        catalog: &[migration::Migration],
    ) -> Result<Self, StoreError> {
        // A symlink alias must share the same lease and SQLite sidecars.
        let path = match path.canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if purpose == OpenPurpose::ApplicationInspection {
                    return Err(error.into());
                }
                if path.symlink_metadata().is_ok() {
                    return Err(StoreError::InvalidTransition(
                        "dangling database symlink is unsupported".into(),
                    ));
                }
                let name = path.file_name().ok_or_else(|| {
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        "missing database filename",
                    )
                })?;
                let parent = path
                    .parent()
                    .filter(|parent| !parent.as_os_str().is_empty())
                    .unwrap_or_else(|| Path::new("."));
                parent.canonicalize()?.join(name)
            }
            Err(error) => return Err(error.into()),
        };
        // Different hard-link names cannot share WAL sidecars safely.
        #[cfg(unix)]
        if let Ok(metadata) = path.metadata() {
            use std::os::unix::fs::MetadataExt;
            if metadata.nlink() != 1 {
                return Err(StoreError::InvalidTransition(
                    "hard-linked event log is unsupported".into(),
                ));
            }
        }
        // A distinct stable lock file avoids colliding with SQLite's own
        // byte-range locks on the database. Never unlink it while in use.
        let mut lock_path = path.as_os_str().to_os_string();
        lock_path.push(".writer.lock");
        let acquired = match purpose {
            OpenPurpose::Execution => root::FileLease::acquire(Path::new(&lock_path)),
            OpenPurpose::ApplicationInspection => {
                root::FileLease::acquire_existing(Path::new(&lock_path))
            }
        };
        let lease = match acquired {
            Ok(lease) => Arc::new(lease),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                return Err(StoreError::WriterBusy);
            }
            Err(error) => return Err(StoreError::Io(error)),
        };
        let options = match purpose {
            OpenPurpose::Execution => OpenOptions::file(&path).create(true),
            OpenPurpose::ApplicationInspection => application_inspection::options(&path)?,
        };
        let catalog = catalog.to_vec();
        let connection = OwnedConnection::open(
            options,
            match purpose {
                OpenPurpose::Execution => ConnectionAuthority::Writer {
                    lease,
                    root: root_owner.clone(),
                },
                OpenPurpose::ApplicationInspection => ConnectionAuthority::Inspection {
                    lease,
                    root: root_owner.clone(),
                },
            },
            move |connection| match purpose {
                OpenPurpose::Execution => schema::initialize_connection(connection, &catalog),
                OpenPurpose::ApplicationInspection => {
                    application_inspection::initialize(connection)
                }
            },
        )
        .await?;
        let high_water = connection
            .run(move |connection| {
                sequence_number(connection.query_row(
                    "SELECT COALESCE(MAX(sequence), 0) FROM event_log",
                    [],
                    |row| row.get(0),
                )?)
            })
            .await;
        let high_water = match high_water {
            Ok(value) => value,
            Err(cause) => {
                // Startup errors have the same real close boundary as normal shutdown.
                if let Err(cleanup) = connection.shutdown().await {
                    return Err(StoreError::StartupCleanupFailed {
                        cause: Box::new(cause),
                        cleanup: Box::new(cleanup),
                    });
                }
                return Err(cause);
            }
        };
        let operation_live = root_owner.as_ref().map_or_else(
            || Arc::new(applications::operations::LiveOperations::default()),
            |owner| owner.operation_live.clone(),
        );
        Ok(Self {
            expected_session: None,
            connection,
            root_owner,
            operation_live,
            commits: commits::CommitHub::new(high_water),
            shell_changes: tokio::sync::broadcast::channel(256).0,
        })
    }

    fn request_shutdown(&self) {
        self.connection.request_shutdown();
    }

    fn close_receipt(
        &self,
    ) -> futures_util::future::Shared<connection::BoxFuture<'static, Result<(), String>>> {
        self.connection.close_receipt()
    }

    /// Finish every accepted operation and close SQLite before releasing its lease.
    pub async fn close(self) -> Result<(), StoreError> {
        self.connection.close().await
    }

    /// Close ingress and drain while existing observers still hold log handles.
    pub async fn shutdown(&self) -> Result<(), StoreError> {
        self.connection.shutdown().await
    }

    /// Wait for this SQL owner's real close acknowledgement. A failed close
    /// retains its Root and reports the failure; it never confirms process exit.
    pub async fn drain(&self) {
        let mut reported = std::collections::BTreeSet::new();
        loop {
            match self.shutdown().await {
                Ok(()) => return,
                Err(error) => {
                    let error = error.to_string();
                    if reported.insert(error.clone()) {
                        eprintln!("SQL cleanup unconfirmed: {error:?}");
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        }
    }

    /// A coalescible wakeup, not a replacement for committed facts. Register
    /// before reading a bootstrap snapshot, then catch up from its SQL cursor.
    pub fn subscribe_commits(&self) -> tokio::sync::watch::Receiver<u64> {
        self.commits.subscribe()
    }

    /// Coalescible hints for this Session only. Subscribe before reading its
    /// bootstrap snapshot; catch up from the committed SQL cursor after waking.
    pub fn subscribe_session_commits(&self, session: &str) -> SessionSubscription {
        self.commits.subscribe_session(session)
    }

    /// Register before reading activation state. This hint never grants execution authority.
    pub fn subscribe_activation_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.commits.subscribe_activations()
    }

    /// Register before reading catalog state. Hints include metadata writes;
    /// only a re-read of the canonical catalog revision establishes a change.
    pub fn subscribe_catalog_changes(&self) -> tokio::sync::watch::Receiver<()> {
        self.connection.subscribe_changes()
    }
}

fn sequence_number(value: i64) -> Result<u64, StoreError> {
    u64::try_from(value)
        .map_err(|_| StoreError::InvalidTransition("negative ledger sequence".into()))
}
