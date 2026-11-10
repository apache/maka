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

//! One Root authority and one transactional runtime database.

use crate::{EventLog, OpenPurpose, StoreError, root, sessions::SessionRecord};
use rusqlite::{Connection as SqliteConnection, OptionalExtension};
use serde::{Serialize, de::DeserializeOwned};
use std::sync::{
    Arc, Weak,
    atomic::{AtomicBool, Ordering},
};

pub(crate) mod creation;
mod data;
pub use data::{DataChange, DataWriter};
mod effects;
mod execution;
pub use effects::BrowserLeaseChildReceipt;
mod family;
mod gates;
mod workspace_fence;
pub use workspace_fence::{RootWorkspace, WorkspaceFence};
mod work_fence;
pub use work_fence::SessionWorkFence;
mod lifecycle;
mod material;
mod resource_io;
pub use execution::{
    RetainedWorkSettlement, SessionWorkLease, SessionWorkScope, WorkEffectLease, WorkEffects,
    WorkSettlementObserver,
};
pub use resource_io::{RequestFileCloseFailure, close_request_file, create_request_file};
mod applications;
pub(crate) mod checkpoints;
mod control;
pub use checkpoints::{Checkout, HistoryCheckpoints};
mod plugins;
mod recovery;
mod retirement;
mod subscriptions;
pub use subscriptions::RootSubscription;
pub(crate) mod catalog;
mod operations;
mod tool_execution;
pub use operations::{OperationStore, OperationWork, ProviderJournal, RecoveredOperation};
mod projects;
pub use projects::ProjectWorkspacePlan;
mod session_metadata;
pub use session_metadata::SessionRevisionGuard;
mod session_store;
pub use creation::{CreationRejection, SessionCreationRequest};

mod routes;

/// Session and operation handles never extend the lifetime of an idle SQL owner.
/// An accepted call holds the original owner through its completion instead.
pub struct RootStore {
    log: Arc<EventLog>,
    closed: Arc<AtomicBool>,
    gates: Arc<gates::Gates>,
    lifecycle: Option<lifecycle::Lifecycle>,
    project_mutations: Arc<tokio::sync::Mutex<()>>,
}

#[derive(Clone)]
pub struct SessionStore {
    id: Arc<str>,
    log: Weak<EventLog>,
    work: Option<Arc<execution::Pins>>,
    gates: Arc<gates::Gates>,
    closed: Arc<AtomicBool>,
}

impl SessionStore {
    pub fn id(&self) -> &str {
        &self.id
    }

    fn owner(&self) -> Result<Arc<EventLog>, StoreError> {
        if self.work.as_ref().is_some_and(|pins| !pins.active())
            || (self.work.is_none()
                && (self.closed.load(Ordering::Acquire) || self.gates.is_closing()))
        {
            return Err(StoreError::ConnectionClosed);
        }
        self.log.upgrade().ok_or(StoreError::ConnectionClosed)
    }

    /// Capture a stable Session attachment before entering its binding gate.
    /// The accepted SQL job inherits both guards through the scoped connection.
    async fn scoped(&self) -> Result<EventLog, StoreError> {
        let owner = self.owner()?;
        if let Some(pins) = &self.work {
            return Ok(owner.scoped(pins.custody()?).bind_session(self.id.clone()));
        }
        Ok(
            pin_sessions(owner, &self.gates, &[self.id.to_string()], &[])
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
        Ok(owner
            .subscribe_session_commits(&self.id)
            .with_control(owner.subscribe_catalog_changes()))
    }
}

impl RootStore {
    /// Observe the runtime database writer and its independent readers.
    pub async fn sqlite_resource_stats(
        &self,
    ) -> Result<crate::connection::ConnectionResourceStats, StoreError> {
        self.log.sqlite_resource_stats().await
    }

    /// Open with the complete product migration catalog, including Root migrations.
    pub async fn open(
        owner: Arc<root::RootOwner>,
        catalog: &[crate::migration::Migration],
    ) -> Result<Self, StoreError> {
        owner.validate_current()?;
        let log = Arc::new(
            EventLog::open_owned(
                &owner.canonical_path().join(root::ROOT_DATABASE),
                Some(owner.clone()),
                OpenPurpose::Execution,
                catalog,
            )
            .await?,
        );
        let mut store = Self {
            log,
            closed: Arc::new(AtomicBool::new(false)),
            gates: gates::Gates::new(&owner),
            lifecycle: None,
            project_mutations: Arc::new(tokio::sync::Mutex::new(())),
        };
        let opened = async {
            store.lifecycle =
                Some(lifecycle::Lifecycle::start(store.log.clone(), store.gates.clone()).await?);
            // Recovery also owns real workers. Install their independent close
            // observer before recovery can retain a failed SQL job or stage.
            store.recover_creations().await?;
            store.recover_checkpoints().await?;
            // No admission or retirement can observe work abandoned by the
            // previous owner as live after a process restart.
            store.recover_host_effects().await?;
            store.recover_shell_runs(now_millis()?).await?;
            store
                .lifecycle
                .as_mut()
                .expect("Root lifecycle is installed before recovery")
                .start_maintenance()?;
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

    fn handle(&self, id: String) -> SessionStore {
        SessionStore {
            id: id.into(),
            log: Arc::downgrade(&self.log),
            work: None,
            gates: self.gates.clone(),
            closed: self.closed.clone(),
        }
    }

    fn request_shutdown(&self) {
        self.closed.store(true, Ordering::Release);
        self.gates.close();
        if self.lifecycle.is_none() {
            self.log.request_shutdown();
        }
    }

    pub async fn shutdown(&self) -> Result<(), StoreError> {
        self.request_shutdown();
        if let Some(lifecycle) = &self.lifecycle {
            return lifecycle.wait().await;
        }
        self.log.shutdown().await
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

/// All attachment-changing callers take an exclusive Session gate; ordinary
/// work shares it. Binding pins then fence Root relocation until SQL cleanup.
async fn pin_sessions(
    owner: Arc<EventLog>,
    gates: &Arc<gates::Gates>,
    sessions: &[String],
    additional: &[maka_sandbox::workspace::BindingRef],
) -> Result<EventLog, StoreError> {
    let session_pins = gates
        .read(sessions.iter().cloned().map(gates::Key::Session))
        .await?;
    let ids = sessions.to_vec();
    let mut bindings = owner.connection.read(move |connection| {
        let mut binding_ids = Vec::new();
        for session in ids {
            let reference: Option<Option<String>> = connection.query_row("SELECT json_extract(configuration,'$.workspace') FROM session_control WHERE id=?", rusqlite::params![session], |row| row.get(0)).optional()?;
            if let Some(Some(reference)) = reference {
                let reference: maka_sandbox::workspace::BindingRef = serde_json::from_str(&reference)?;
                reference.validate().map_err(|error| StoreError::InvalidTransition(error.into()))?;
                binding_ids.push(reference.id);
            }
        }
        Ok(binding_ids)
    }).await?;
    bindings.extend(additional.iter().map(|reference| reference.id));
    let binding_pins = gates
        .read(bindings.into_iter().map(gates::Key::Binding))
        .await?;
    Ok(owner.scoped(Arc::new((session_pins, binding_pins))))
}

fn now_millis() -> Result<u64, StoreError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .ok_or_else(|| StoreError::InvalidTransition("clock is outside the supported range".into()))
}
