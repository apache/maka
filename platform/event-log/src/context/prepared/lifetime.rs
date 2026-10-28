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

//! Live ownership belongs to accepted work, not to the age of a Session.
use crate::StoreError;
use std::{
    collections::{BTreeSet, HashMap},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::sync::Notify;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) struct Key {
    pub kind: &'static str,
    pub id: String,
}
#[derive(Default)]
struct State {
    live: HashMap<Key, usize>,
    released: BTreeSet<Key>,
}
struct Registry {
    state: Mutex<State>,
    changed: Notify,
    closed: AtomicBool,
}
#[derive(Clone)]
pub(crate) struct PreparedRegistry(Arc<Registry>);
#[derive(Clone)]
pub(super) struct Lease(Arc<LeaseInner>);
struct LeaseInner {
    key: Key,
    registry: Weak<Registry>,
    // A fresh base lease pins one generation, never its obsolete ancestry.
    _base: Option<Lease>,
}
impl std::fmt::Debug for Lease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("PreparedLease").field(&self.0.key).finish()
    }
}
impl PreparedRegistry {
    pub(crate) fn new() -> Self {
        Self(Arc::new(Registry {
            state: Mutex::default(),
            changed: Notify::new(),
            closed: AtomicBool::new(false),
        }))
    }
    pub(super) fn acquire(
        &self,
        kind: &'static str,
        id: &str,
        base: Option<Lease>,
    ) -> Result<Lease, StoreError> {
        if self.0.closed.load(Ordering::Acquire) {
            return Err(StoreError::ConnectionClosed);
        }
        let key = Key {
            kind,
            id: id.to_owned(),
        };
        *self
            .0
            .state
            .lock()
            .unwrap()
            .live
            .entry(key.clone())
            .or_default() += 1;
        Ok(Lease(Arc::new(LeaseInner {
            key,
            registry: Arc::downgrade(&self.0),
            _base: base,
        })))
    }
    pub(crate) fn live(&self, kind: &'static str, id: &str) -> bool {
        self.0.state.lock().unwrap().live.contains_key(&Key {
            kind,
            id: id.to_owned(),
        })
    }
    pub(crate) fn has_live(&self) -> bool {
        !self.0.state.lock().unwrap().live.is_empty()
    }
    pub(crate) fn take_released(&self, limit: usize) -> Vec<Key> {
        let mut state = self.0.state.lock().unwrap();
        (0..limit)
            .filter_map(|_| state.released.pop_first())
            .collect()
    }
    pub(crate) fn restore_released(&self, keys: Vec<Key>) {
        self.0.state.lock().unwrap().released.extend(keys);
        self.wake();
    }
    pub(crate) fn has_released(&self) -> bool {
        !self.0.state.lock().unwrap().released.is_empty()
    }
    pub(crate) fn wake(&self) {
        self.0.changed.notify_one();
    }
    pub(crate) async fn notified(&self) {
        self.0.changed.notified().await;
    }
    pub(crate) fn close(&self) {
        self.0.closed.store(true, Ordering::Release);
    }
}
impl Lease {
    pub(super) fn validate(&self, expected: &PreparedRegistry) -> Result<(), StoreError> {
        if self.0.registry.ptr_eq(&Arc::downgrade(&expected.0))
            && !expected.0.closed.load(Ordering::Acquire)
        {
            Ok(())
        } else {
            Err(super::invalid(
                "prepared view belongs to another database owner",
            ))
        }
    }
    pub(super) fn wake(&self) {
        if let Some(registry) = self.0.registry.upgrade() {
            registry.changed.notify_one();
        }
    }
}
impl Drop for LeaseInner {
    fn drop(&mut self) {
        let Some(registry) = self.registry.upgrade() else {
            return;
        };
        let mut state = registry.state.lock().unwrap();
        let count = state
            .live
            .get_mut(&self.key)
            .expect("registered prepared lease");
        *count -= 1;
        if *count == 0 {
            state.live.remove(&self.key);
            state.released.insert(self.key.clone());
            registry.changed.notify_one();
        }
    }
}

/// The original SQL owner and its readers jointly own these files. They are
/// disposable projection bytes, never a second canonical execution journal.
#[derive(Clone)]
pub(crate) struct PreparedCache(Arc<CacheFiles>);
struct CacheFiles {
    directory: tempfile::TempDir,
    registry: PreparedRegistry,
}
impl PreparedCache {
    pub(crate) fn new(database: &std::path::Path) -> Result<Self, StoreError> {
        // The caller already owns this database's writer lease. A stable private
        // namespace lets the next owner collect files left by a killed Host.
        let mut name = database.as_os_str().to_os_string();
        name.push(".prepared-cache");
        let directory = std::path::PathBuf::from(name);
        const MARKER: &[u8] = b"maka-prepared-cache-v1\n";
        match std::fs::symlink_metadata(&directory) {
            Ok(metadata) => {
                if !metadata.file_type().is_dir()
                    || std::fs::read(directory.join("owner"))? != MARKER
                {
                    return Err(super::invalid(
                        "prepared cache namespace is not owned by this store",
                    ));
                }
                std::fs::remove_dir_all(&directory)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        // Publish the marker and namespace together. A crash during bootstrap
        // must never leave an unmarked permanent path that blocks the next Host.
        let staged = tempfile::Builder::new()
            .prefix(".prepared-cache-init-")
            .tempdir_in(
                directory
                    .parent()
                    .unwrap_or_else(|| std::path::Path::new(".")),
            )?;
        std::fs::write(staged.path().join("owner"), MARKER)?;
        std::fs::rename(staged.path(), &directory)?;
        Ok(Self(Arc::new(CacheFiles {
            directory: tempfile::Builder::new()
                .prefix("owner-")
                .tempdir_in(directory)?,
            registry: PreparedRegistry::new(),
        })))
    }
    pub(crate) fn registry(&self) -> PreparedRegistry {
        self.0.registry.clone()
    }
    pub(crate) async fn attach(
        &self,
        connection: &mut sqlx::SqliteConnection,
        writer: bool,
    ) -> Result<(), StoreError> {
        let path = self.0.directory.path().join("prepared.sqlite");
        let mode = if writer { "rwc" } else { "ro" };
        let uri = crate::connection::control::database_uri(&path, mode)?;
        sqlx::query("ATTACH DATABASE ? AS prepared_cache")
            .bind(uri)
            .execute(&mut *connection)
            .await?;
        if writer {
            sqlx::raw_sql(
                "PRAGMA prepared_cache.auto_vacuum=INCREMENTAL;
                PRAGMA prepared_cache.journal_mode=WAL; PRAGMA prepared_cache.synchronous=OFF;
                PRAGMA prepared_cache.cache_size=-4096; PRAGMA prepared_cache.mmap_size=0;",
            )
            .execute(&mut *connection)
            .await?;
            sqlx::raw_sql(include_str!("schema.sql"))
                .execute(&mut *connection)
                .await?;
        } else {
            sqlx::raw_sql(
                "PRAGMA prepared_cache.cache_size=-1024; PRAGMA prepared_cache.mmap_size=0;",
            )
            .execute(&mut *connection)
            .await?;
        }
        use sqlx::Connection;
        connection.clear_cached_statements().await?;
        Ok(())
    }
}
