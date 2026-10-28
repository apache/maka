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

//! One disposable SQL owner, isolated from canonical writes and their queue.
use super::{
    lifetime::{PreparedCache, PreparedRegistry},
    runtime::InFlight,
};
use crate::{
    StoreError,
    connection::{
        BoxFuture, ConnectionAuthority, OwnedConnection, WriterIngress, control::ReadOnlyControl,
        custody::Custody,
    },
    root::{FileLease, RootOwner},
};
use futures_util::future::Shared;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

pub(crate) struct PreparedStore {
    connection: OwnedConnection,
    admission: Arc<Admission>,
    registry: PreparedRegistry,
}
impl Clone for PreparedStore {
    fn clone(&self) -> Self {
        Self {
            connection: self.connection.cloned(),
            admission: self.admission.clone(),
            registry: self.registry.clone(),
        }
    }
}
#[derive(Default)]
struct Admission {
    state: Mutex<AdmissionState>,
    changed: Notify,
}
#[derive(Default)]
struct AdmissionState {
    sealed: bool,
    active: usize,
}
struct Accepted(Arc<Admission>);
impl Drop for Accepted {
    fn drop(&mut self) {
        self.0
            .state
            .lock()
            .expect("prepared admission lock poisoned")
            .active -= 1;
        self.0.changed.notify_waiters();
    }
}
impl Admission {
    fn accept(self: &Arc<Self>) -> Result<Custody, StoreError> {
        let mut state = self.state.lock().expect("prepared admission lock poisoned");
        if state.sealed {
            return Err(StoreError::ConnectionClosed);
        }
        state.active = state
            .active
            .checked_add(1)
            .ok_or_else(|| super::invalid("prepared admission count exhausted"))?;
        Ok(Arc::new(Accepted(self.clone())))
    }
    fn seal(&self) {
        self.state
            .lock()
            .expect("prepared admission lock poisoned")
            .sealed = true;
        self.changed.notify_waiters();
    }
    async fn drain(&self) {
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if self
                .state
                .lock()
                .expect("prepared admission lock poisoned")
                .active
                == 0
            {
                return;
            }
            changed.await;
        }
    }
}

impl PreparedStore {
    pub(crate) async fn open(
        canonical: &Path,
        source: Arc<FileLease>,
        root: Option<Arc<RootOwner>>,
        cache: PreparedCache,
        control: Option<ReadOnlyControl>,
    ) -> Result<Self, StoreError> {
        let registry = cache.registry();
        let canonical = crate::connection::control::database_uri(canonical, "ro")?;
        // URI mode seals main; the connection's open flags must still allow
        // the separate writable prepared attachment to be created.
        let options = SqliteConnectOptions::new()
            .filename(canonical)
            .create_if_missing(true)
            .query_planner_stability(true);
        let initialize_control = control.clone();
        let connection = OwnedConnection::open_with_cache(
            options,
            ConnectionAuthority::Projection { source, root },
            move |connection| {
                Box::pin(async move {
                    crate::sqlite_functions::register(connection).await?;
                    crate::connection::control::initialize_views(
                        connection,
                        initialize_control.as_ref(),
                    )
                    .await
                })
            },
            Some(cache),
            control,
        )
        .await?;
        Ok(Self {
            connection,
            admission: Arc::new(Admission::default()),
            registry,
        })
    }
    pub(crate) fn scoped(&self, custody: Custody) -> Self {
        Self {
            connection: self.connection.scoped(custody),
            admission: self.admission.clone(),
            registry: self.registry.clone(),
        }
    }
    pub(crate) async fn run<T: Send + 'static>(
        &self,
        operation: impl for<'c> FnOnce(
            &'c mut SqliteConnection,
            &'c mut InFlight,
        ) -> BoxFuture<'c, Result<T, StoreError>>
        + Send
        + 'static,
    ) -> Result<T, StoreError> {
        let admission = self.admission.clone();
        self.connection
            .run_prepared_pinned(operation, move || admission.accept())
            .await
    }
    pub(crate) async fn read_interruptible<T: Send + 'static>(
        &self,
        operation: impl for<'c> FnOnce(&'c mut SqliteConnection) -> BoxFuture<'c, Result<T, StoreError>>
        + Send
        + 'static,
    ) -> Result<T, StoreError> {
        let admission = self.admission.clone();
        self.connection
            .read_interruptible_pinned(operation, move || admission.accept())
            .await
    }
    pub(crate) fn request_quiesce(&self) {
        self.admission.seal();
    }
    pub(crate) async fn quiesce(&self) -> Result<(), StoreError> {
        self.request_quiesce();
        tokio::select! {
            () = self.admission.drain() => Ok(()),
            closed = self.close_receipt() => closed.map_err(StoreError::CloseFailed),
        }
    }
    #[cfg(test)]
    pub(crate) async fn resource_stats(
        &self,
    ) -> Result<crate::connection::ConnectionResourceStats, StoreError> {
        self.connection.resource_stats().await
    }
    pub(crate) fn cleanup(&self) -> PreparedCleanup {
        PreparedCleanup {
            writer: self.connection.writer(),
            registry: self.registry.clone(),
        }
    }
    pub(crate) async fn shutdown(&self) -> Result<(), StoreError> {
        self.connection.shutdown().await
    }
    pub(crate) fn close_receipt(&self) -> Shared<BoxFuture<'static, Result<(), String>>> {
        self.connection.close_receipt()
    }
}

/// Accepted canonical lifecycle callbacks retain cleanup admission through quiesce.
#[derive(Clone)]
pub(crate) struct PreparedCleanup {
    writer: WriterIngress,
    registry: PreparedRegistry,
}
impl PreparedCleanup {
    pub(crate) async fn retire_owner(&self, session: String) -> Result<(), StoreError> {
        let registry = self.registry.clone();
        self.writer
            .run_prepared(
                move |connection, _| {
                    Box::pin(async move {
                        let mut tx = connection.begin().await?;
                        super::gc::retire_owner(&mut tx, &session).await?;
                        tx.commit().await.map_err(StoreError::CommitUnknown)?;
                        registry.wake();
                        Ok(())
                    })
                },
                || Ok(None),
            )
            .await
    }
}
