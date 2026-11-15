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

//! Durable single-machine reference adapter: independent clients/processes share
//! SQLite arbitration and immutable files. Not a distributed filesystem lease.
use super::*;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Seek, Write},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone)]
pub struct FileObjects {
    directory: PathBuf,
    identity: String,
}
impl FileObjects {
    pub fn open(directory: &Path, identity: String) -> Result<Self, StoreError> {
        if !cfg!(unix) {
            return Err(invalid("durable checkpoint file adapter requires Unix"));
        }
        crate::root::private_directory(directory)?;
        File::open(directory)?.sync_all()?;
        if let Some(parent) = directory.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(Self {
            directory: fs::canonicalize(directory)?,
            identity,
        })
    }
    pub(crate) fn existing(directory: PathBuf, identity: String) -> Result<Self, StoreError> {
        if !fs::symlink_metadata(&directory)?.file_type().is_dir() {
            return Err(invalid("checkpoint object directory differs"));
        }
        Ok(Self {
            directory,
            identity,
        })
    }
    fn path(&self, object: &ObjectRef) -> Result<PathBuf, StoreError> {
        if !valid_digest(&object.digest) {
            return Err(invalid("invalid checkpoint object digest"));
        }
        Ok(self.directory.join(&object.digest))
    }
}
impl ImmutableObjectStore for FileObjects {
    fn identity(&self) -> &str {
        &self.identity
    }
    fn local_directory(&self) -> Option<&Path> {
        Some(&self.directory)
    }
    fn put(&self, source: &mut dyn Read) -> Result<ObjectRef, StoreError> {
        let mut staged = tempfile::NamedTempFile::new_in(&self.directory)?;
        let mut hash = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            let count = source.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            staged.write_all(&buffer[..count])?;
            hash.update(&buffer[..count]);
            bytes = bytes
                .checked_add(count as u64)
                .ok_or_else(|| invalid("object size overflow"))?;
        }
        staged.as_file().sync_all()?;
        let object = ObjectRef {
            digest: hex::encode(hash.finalize()),
            bytes,
        };
        match staged.persist_noclobber(self.path(&object)?) {
            Ok(_) => (),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                self.read(&object)?;
            }
            Err(error) => return Err(error.error.into()),
        }
        File::open(&self.directory)?.sync_all()?;
        Ok(object)
    }
    fn read(&self, object: &ObjectRef) -> Result<File, StoreError> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let mut file = options.open(self.path(object)?)?;
        if !file.metadata()?.is_file() {
            return Err(invalid("checkpoint object is not a regular file"));
        }
        let mut hash = Sha256::new();
        let mut bytes = 0u64;
        let mut buffer = [0u8; 65536];
        loop {
            let count = file.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            bytes = bytes
                .checked_add(count as u64)
                .ok_or_else(|| invalid("object size overflow"))?;
            hash.update(&buffer[..count]);
        }
        if bytes != object.bytes || hex::encode(hash.finalize()) != object.digest {
            return Err(invalid("checkpoint object digest or size differs"));
        }
        file.rewind()?;
        Ok(file)
    }
}

#[derive(Clone)]
pub struct FileRepository {
    directory: PathBuf,
    identity: String,
    objects: Arc<FileObjects>,
}
impl FileRepository {
    /// Blocking initialization: invoke from trusted bootstrap's physical I/O lane.
    pub fn open(directory: &Path) -> Result<Self, StoreError> {
        if !cfg!(unix) {
            return Err(invalid("durable checkpoint file adapter requires Unix"));
        }
        crate::root::private_directory(directory)?;
        let directory = fs::canonicalize(directory)?;
        // Journal-mode setup and identity inspection must precede other initializers.
        // The OS releases this lock on process death; never unlink its stable file.
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let initialization = options.open(directory.join("initialization.lock"))?;
        if !initialization.metadata()?.is_file() {
            return Err(invalid(
                "repository initialization lock is not a regular file",
            ));
        }
        initialization.lock()?;
        let db = connect(&directory, true)?;
        let application: i64 = db.query_row("PRAGMA application_id", [], |r| r.get(0))?;
        let tables: i64 = db.query_row(
            "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            [],
            |r| r.get(0),
        )?;
        if application != 0x4d435052 && !(application == 0 && tables == 0) {
            return Err(StoreError::UnsupportedDatabase);
        }
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA application_id=1296257106")?;
        let tx = db.unchecked_transaction()?;
        crate::migration::run(
            &tx,
            &[
                crate::migration::Migration {
                    version: 1,
                    description: "checkpoint repository",
                    sql: include_str!("../../../migrations/0040_checkpoint_repository.sql"),
                },
                crate::migration::Migration {
                    version: 2,
                    description: "shared checkpoint heads",
                    sql: include_str!("../../../migrations/repository/0002_heads.sql"),
                },
            ],
        )?;
        let id: Option<String> = tx
            .query_row(
                "SELECT configuration_json FROM checkpoint_repository_settings WHERE singleton=1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let identity = match id {
            Some(id) => serde_json::from_str::<Uuid>(&id)?.to_string(),
            None => {
                let id = Uuid::new_v4();
                tx.execute(
                    "INSERT INTO checkpoint_repository_settings VALUES(1,?)",
                    [serde_json::to_string(&id)?],
                )?;
                id.to_string()
            }
        };
        tx.commit().map_err(StoreError::CommitUnknown)?;
        let objects = Arc::new(FileObjects::open(
            &directory.join("objects"),
            identity.clone(),
        )?);
        File::open(&directory)?.sync_all()?;
        if let Some(parent) = directory.parent() {
            File::open(parent)?.sync_all()?;
        }
        Ok(Self {
            directory,
            identity,
            objects,
        })
    }
    pub fn objects(&self) -> Arc<dyn ImmutableObjectStore> {
        self.objects.clone()
    }
    pub fn storage(&self, agent: Uuid) -> Result<Storage, StoreError> {
        Storage::new(self.objects(), Arc::new(self.clone()), agent)
    }
    fn run<T: Send + 'static>(
        &self,
        action: impl FnOnce(&Connection) -> Result<T, StoreError> + Send + 'static,
    ) -> BoxFuture<'static, Result<T, StoreError>> {
        let directory = self.directory.clone();
        let identity = self.identity.clone();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let db = connect(&directory, false)?;
                let original: String = db.query_row("SELECT configuration_json FROM checkpoint_repository_settings WHERE singleton=1", [], |r|r.get(0))?;
                if serde_json::from_str::<Uuid>(&original)?.to_string() != identity {
                    return Err(invalid("checkpoint repository identity changed"));
                }
                action(&db)
            })
                .await.map_err(|_| StoreError::OperationUnknown)?
        })
    }
}
fn connect(directory: &Path, create: bool) -> Result<Connection, StoreError> {
    let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    if create {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    let db = Connection::open_with_flags(directory.join("repository.sqlite"), flags)?;
    db.busy_timeout(Duration::from_secs(10))?;
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
    Ok(db)
}
impl SessionRepository for FileRepository {
    fn identity(&self) -> &str {
        &self.identity
    }
    fn object_store_identity(&self) -> &str {
        &self.identity
    }
    fn lookup(
        &self,
        source: Source,
        agent: Uuid,
    ) -> BoxFuture<'_, Result<Option<Binding>, StoreError>> {
        self.run(move |db| sql::lookup(db, &source, agent))
    }
    fn bind(&self, source: Source, agent: Uuid) -> BoxFuture<'_, Result<Binding, StoreError>> {
        self.run(move |db| sql::bind(db, &source, agent, sql::Layout::Shared))
    }
    fn read_head(
        &self,
        identity: SessionIdentity,
    ) -> BoxFuture<'_, Result<Option<Head>, StoreError>> {
        self.run(move |db| sql::head(db, &identity, sql::Layout::Shared))
    }
    fn receipt(&self, request: Commit) -> BoxFuture<'_, Result<Option<CommitReceipt>, StoreError>> {
        self.run(move |db| sql::receipt(db, &request))
    }
    fn commit(
        &self,
        request: Commit,
        verified: VerifiedCheckpoint,
    ) -> BoxFuture<'_, Result<CommitReceipt, StoreError>> {
        let identity = self.identity.clone();
        self.run(move |db| {
            verified.validate(&identity, &request)?;
            sql::commit(db, &request, sql::Layout::Shared)
        })
    }
}
