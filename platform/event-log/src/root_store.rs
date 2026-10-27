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

//! One Root authority, a control database, and a fixed set of independent writers.

use crate::{EventLog, OpenPurpose, StoreError, root, sessions::SessionRecord};
use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use sqlx::{Connection, Row, SqliteConnection};
use std::sync::{
    Arc, Weak,
    atomic::{AtomicBool, Ordering},
};

pub(crate) mod creation;
mod effects;
mod execution;
pub use effects::BrowserLeaseChildReceipt;
mod family;
mod gates;
mod lifecycle;
pub use execution::{
    InvocationEffectLease, InvocationEffects, SessionExecutionLease, SessionExecutionScope,
};
pub(crate) use lifecycle::{StageOwner, StageRegistration};
mod applications;
mod attachments;
mod computer_apps;
mod control;
pub(crate) use computer_apps::activity::{
    record_computer_app_activity, require_computer_app_running,
};
mod plugins;
mod recall;
mod recovery;
mod retirement;
mod subscriptions;
pub use subscriptions::RootSubscription;
mod tool_execution;
mod usage;
pub(crate) mod usage_meter;
pub use usage::{
    UsageActivityCursor, UsageActivityPage, UsageFence, UsageGroupCursor, UsageQuery, UsageReport,
};
pub use usage_meter::SessionUsageTotals;
pub(crate) mod catalog;
mod operations;
pub use operations::{OperationAuxiliary, OperationStore};
mod projects;
mod session_metadata;
mod session_store;
pub use creation::CreationRejection;
#[cfg(test)]
mod applications_tests;
mod routes;
#[cfg(test)]
mod tests;

pub const PARTITION_COUNT: usize = 8;

/// Session and operation handles never extend the lifetime of an idle SQL owner.
/// An accepted call holds the original owner through its completion instead.
pub struct RootStore {
    control: Arc<EventLog>,
    partitions: Vec<Arc<EventLog>>,
    closed: Arc<AtomicBool>,
    gates: Arc<gates::Gates>,
    lifecycle: Option<lifecycle::Lifecycle>,
    project_mutations: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Clone)]
pub struct SessionStore {
    id: Arc<str>,
    partition: Weak<EventLog>,
    journals: [Weak<EventLog>; PARTITION_COUNT],
    control: Weak<EventLog>,
    execution: Option<Arc<execution::Pins>>,
    gates: Arc<gates::Gates>,
    closed: Arc<AtomicBool>,
}

impl SessionStore {
    pub fn id(&self) -> &str {
        &self.id
    }

    fn owner(&self) -> Result<Arc<EventLog>, StoreError> {
        if self.execution.as_ref().is_some_and(|pins| !pins.active())
            || (self.execution.is_none()
                && (self.closed.load(Ordering::Acquire) || self.gates.is_closing()))
        {
            return Err(StoreError::ConnectionClosed);
        }
        self.partition.upgrade().ok_or(StoreError::ConnectionClosed)
    }

    /// Capture a stable Session attachment before entering its binding gate.
    /// The accepted SQL job inherits both guards through the scoped connection.
    async fn scoped(&self) -> Result<EventLog, StoreError> {
        let owner = self.owner()?;
        if let Some(pins) = &self.execution {
            return Ok(owner.scoped(pins.custody()?).bind_session(self.id.clone()));
        }
        Ok(
            pin_partition(owner, &self.gates, &[self.id.to_string()], &[])
                .await?
                .bind_session(self.id.clone()),
        )
    }

    fn check_session(&self, id: &str) -> Result<(), StoreError> {
        if id == self.id() {
            Ok(())
        } else {
            Err(StoreError::InvalidTransition(
                "foreign Session handle".into(),
            ))
        }
    }

    pub async fn get<T: DeserializeOwned + Send + 'static>(
        &self,
    ) -> Result<Option<SessionRecord<T>>, StoreError> {
        self.scoped().await?.get_session(&self.id).await
    }

    pub fn subscribe_commits(&self) -> Result<crate::SessionSubscription, StoreError> {
        let owner = self.owner()?;
        let subscription = owner.subscribe_session_commits(&self.id);
        let mut peers = Vec::with_capacity(PARTITION_COUNT - 1);
        for journal in &self.journals {
            let journal = journal.upgrade().ok_or(StoreError::ConnectionClosed)?;
            if !Arc::ptr_eq(&journal, &owner) {
                peers.push(journal.subscribe_session_commits(&self.id));
            }
        }
        let control = self.control.upgrade().ok_or(StoreError::ConnectionClosed)?;
        Ok(subscription
            .with_peers(peers)
            .with_control(control.subscribe_catalog_changes()))
    }
}

impl RootStore {
    /// Observe canonical owners once: control first, then partition order.
    /// Disposable prepared actors are excluded.
    pub async fn sqlite_resource_stats(
        &self,
    ) -> Result<Vec<crate::connection::ConnectionResourceStats>, StoreError> {
        let mut stats = Vec::with_capacity(self.partitions.len() + 1);
        for owner in std::iter::once(&self.control).chain(&self.partitions) {
            stats.push(owner.sqlite_resource_stats().await?);
        }
        Ok(stats)
    }

    pub async fn open(owner: Arc<root::RootOwner>) -> Result<Self, StoreError> {
        owner.validate_current()?;
        let control = Arc::new(
            EventLog::open_owned(
                &owner.canonical_path().join(root::ROOT_DATABASE),
                Some(owner.clone()),
                OpenPurpose::RootControl,
            )
            .await?,
        );
        let mut store = Self {
            control,
            partitions: Vec::with_capacity(PARTITION_COUNT),
            closed: Arc::new(AtomicBool::new(false)),
            gates: gates::Gates::new(),
            lifecycle: None,
            project_mutations: Arc::new(tokio::sync::Mutex::new(())),
        };
        let opened = async {
            let read_control = crate::connection::control::ReadOnlyControl::new(
                &owner.canonical_path().join(root::ROOT_DATABASE),
            )?;
            let directory = owner.canonical_path().join("runtime-partitions");
            root::private_directory(&directory)?;
            for index in 0..PARTITION_COUNT {
                let path = directory.join(format!("{index:02}.sqlite"));
                // A missing file is only safe before any route references this partition.
                if !path.exists() && store.partition_has_routes(index).await? {
                    return Err(StoreError::InvalidTransition(
                        "routed partition is missing".into(),
                    ));
                }
                store.partitions.push(Arc::new(
                    EventLog::open_owned_with_control(
                        &path,
                        Some(owner.clone()),
                        OpenPurpose::Execution,
                        Some(read_control.clone()),
                    )
                    .await?,
                ));
            }
            let logs = std::iter::once(store.control.clone())
                .chain(store.partitions.iter().cloned())
                .collect();
            store.lifecycle = Some(lifecycle::Lifecycle::start(logs, store.gates.clone()).await?);
            // Recovery also owns real workers. Install their independent close
            // observer before recovery can retain a failed SQL job or stage.
            store.recover_creations().await?;
            // No admission or retirement can observe abandoned cross-partition
            // auxiliary work as live after a process restart.
            store.recover_host_effects().await?;
            store.recover_auxiliary_models().await?;
            Ok::<(), StoreError>(())
        }
        .await;
        if let Err(cause) = opened {
            return match store.shutdown().await {
                Ok(()) => Err(cause),
                Err(cleanup) => Err(StoreError::StartupCleanupFailed {
                    cause: Box::new(cause),
                    cleanup: Box::new(cleanup),
                }),
            };
        }
        Ok(store)
    }

    fn require_open(&self) -> Result<(), StoreError> {
        if self.closed.load(Ordering::Acquire) || self.gates.is_closing() {
            Err(StoreError::ConnectionClosed)
        } else {
            Ok(())
        }
    }

    fn handle(&self, id: String, partition: usize) -> SessionStore {
        SessionStore {
            id: id.into(),
            partition: Arc::downgrade(&self.partitions[partition]),
            journals: std::array::from_fn(|index| Arc::downgrade(&self.partitions[index])),
            control: Arc::downgrade(&self.control),
            execution: None,
            gates: self.gates.clone(),
            closed: self.closed.clone(),
        }
    }

    fn request_shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        self.gates.close();
        if self.lifecycle.is_none() {
            self.control.request_shutdown();
            for partition in &self.partitions {
                partition.request_shutdown();
            }
        }
    }

    pub async fn shutdown(&self) -> Result<(), StoreError> {
        self.request_shutdown();
        if let Some(lifecycle) = &self.lifecycle {
            return lifecycle.wait().await;
        }
        // Bootstrap failures have not installed a lifecycle owner yet.
        // Observe every real close even if an earlier owner fails. Each failed
        // owner retains its original authority, so it cannot be replaced.
        let results = futures_util::future::join_all(
            std::iter::once(&self.control)
                .chain(&self.partitions)
                .map(|log| log.shutdown()),
        )
        .await;
        let failures: Vec<_> = results
            .into_iter()
            .filter_map(Result::err)
            .map(|error| error.to_string())
            .collect();
        if failures.is_empty() {
            Ok(())
        } else {
            Err(StoreError::CloseFailed(failures.join("; ")))
        }
    }

    pub async fn close(self) -> Result<(), StoreError> {
        self.shutdown().await
    }
}

impl Drop for RootStore {
    fn drop(&mut self) {
        self.request_shutdown();
    }
}

fn partition_for(domain: &[u8], identity: &str) -> usize {
    let mut digest = Sha256::new();
    digest.update(domain);
    digest.update([0]);
    digest.update(identity.as_bytes());
    usize::from(digest.finalize()[0]) % PARTITION_COUNT
}

pub(crate) async fn initialize_control(
    connection: &mut SqliteConnection,
) -> Result<(), StoreError> {
    let has_layout: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='root_store_layout' AND type='table')")
        .fetch_one(&mut *connection).await?;
    if has_layout {
        let layout: (i64, i64) =
            sqlx::query_as("SELECT version, partitions FROM root_store_layout WHERE singleton=1")
                .fetch_one(&mut *connection)
                .await?;
        if layout != (1, PARTITION_COUNT as i64) {
            return Err(StoreError::UnsupportedDatabase);
        }
    } else {
        // Never silently orphan a previous single-writer data store. An empty
        // interrupted initialization remains safe to retry.
        for (table, query) in [
            (
                "session_control",
                "SELECT EXISTS(SELECT 1 FROM session_control)",
            ),
            ("event_log", "SELECT EXISTS(SELECT 1 FROM event_log)"),
            (
                "application_operations",
                "SELECT EXISTS(SELECT 1 FROM application_operations)",
            ),
            ("host_effects", "SELECT EXISTS(SELECT 1 FROM host_effects)"),
            ("plugin_data", "SELECT EXISTS(SELECT 1 FROM plugin_data)"),
            (
                "application_intents",
                "SELECT EXISTS(SELECT 1 FROM application_intents)",
            ),
        ] {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name=? AND type='table')",
            )
            .bind(table)
            .fetch_one(&mut *connection)
            .await?;
            if exists
                && sqlx::query_scalar::<_, bool>(query)
                    .fetch_one(&mut *connection)
                    .await?
            {
                return Err(StoreError::UnsupportedDatabase);
            }
        }
    }
    crate::schema::initialize_connection(connection).await?;
    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("CREATE TABLE IF NOT EXISTS root_store_layout(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, partitions INTEGER NOT NULL)")
        .execute(&mut *tx).await?;
    sqlx::raw_sql(include_str!("root_store/routes.sql"))
        .execute(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO root_store_layout VALUES(1,1,?) ON CONFLICT(singleton) DO NOTHING")
        .bind(PARTITION_COUNT as i64)
        .execute(&mut *tx)
        .await?;
    tx.commit().await.map_err(StoreError::CommitUnknown)
}

/// All attachment-changing callers take an exclusive Session gate; ordinary
/// work shares it. Binding pins then fence Root relocation until SQL cleanup.
async fn pin_partition(
    owner: Arc<EventLog>,
    gates: &Arc<gates::Gates>,
    sessions: &[String],
    additional: &[maka_agent_facts::workspace::BindingRef],
) -> Result<EventLog, StoreError> {
    let session_pins = gates
        .read(sessions.iter().cloned().map(gates::Key::Session))
        .await?;
    let ids = sessions.to_vec();
    let mut bindings = owner.connection.read(move |connection| Box::pin(async move {
        let mut binding_ids = Vec::new();
        for session in ids {
            let reference: Option<Option<String>> = sqlx::query_scalar("SELECT json_extract(configuration,'$.workspace') FROM session_control WHERE id=?")
                .bind(session).fetch_optional(&mut *connection).await?;
            if let Some(Some(reference)) = reference {
                let reference: maka_agent_facts::workspace::BindingRef = serde_json::from_str(&reference)?;
                reference.validate().map_err(|error| StoreError::InvalidTransition(error.into()))?;
                binding_ids.push(reference.id);
            }
        }
        Ok(binding_ids)
    })).await?;
    bindings.extend(additional.iter().map(|reference| reference.id));
    let binding_pins = gates
        .read(bindings.into_iter().map(gates::Key::Binding))
        .await?;
    Ok(owner.scoped(Arc::new((session_pins, binding_pins))))
}
