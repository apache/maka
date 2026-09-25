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

mod binding;
mod page;
pub(super) use page::receipt;

use super::{failure, worker};
use maka_plugins::remote::{Error, Target};
use maka_protocol::{
    OperationError,
    plugin::{RemoteBinding, RemoteKind},
};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::{
    sync::CancellationToken,
    task::{TaskTracker, task_tracker::TaskTrackerToken},
};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct Registry(Arc<Inner>);
struct Inner {
    connections: Mutex<HashMap<Uuid, ConnectionState>>,
    capacity: Arc<Semaphore>,
}
struct ConnectionState {
    documents: HashMap<Uuid, Arc<Document>>,
    capacity: Arc<Semaphore>,
}
pub(crate) struct Connection {
    registry: Registry,
    id: Uuid,
}
pub(super) struct Document {
    state: Mutex<DocumentState>,
    capacity: [Arc<Semaphore>; 3],
    pub cancellation: CancellationToken,
    tasks: TaskTracker,
}
struct DocumentState {
    closed: bool,
    cleanup_failed: bool,
    ordinary: bool,
    streams: HashMap<Uuid, Arc<worker::Handle>>,
    presenter: Option<binding::Binding>,
    reservations: HashMap<Uuid, binding::Identity>,
}
pub(super) struct Reservation {
    pub document: Arc<Document>,
    id: Uuid,
    _permits: Vec<OwnedSemaphorePermit>,
    _task: TaskTrackerToken,
}
impl Default for Registry {
    fn default() -> Self {
        Self(Arc::new(Inner {
            connections: Mutex::default(),
            capacity: Arc::new(Semaphore::new(512)),
        }))
    }
}
impl Registry {
    pub fn connection(&self, id: Uuid) -> Connection {
        self.0.connections.lock().unwrap().insert(
            id,
            ConnectionState {
                documents: HashMap::new(),
                capacity: Arc::new(Semaphore::new(128)),
            },
        );
        Connection {
            registry: self.clone(),
            id,
        }
    }
    pub fn open(&self, connection: Uuid) -> Result<Uuid, OperationError> {
        let mut connections = self.0.connections.lock().unwrap();
        let state = connections
            .get_mut(&connection)
            .ok_or_else(|| failure(Error::Cancelled))?;
        if state.documents.len() >= 32 {
            return Err(failure(Error::Invalid(
                "Remote document limit exceeded".into(),
            )));
        }
        let id = Uuid::new_v4();
        state.documents.insert(
            id,
            Arc::new(Document {
                state: Mutex::new(DocumentState {
                    closed: false,
                    cleanup_failed: false,
                    ordinary: false,
                    streams: HashMap::new(),
                    presenter: None,
                    reservations: HashMap::new(),
                }),
                capacity: [
                    Arc::new(Semaphore::new(32)),
                    state.capacity.clone(),
                    self.0.capacity.clone(),
                ],
                cancellation: CancellationToken::new(),
                tasks: TaskTracker::new(),
            }),
        );
        Ok(id)
    }
    pub(super) fn get(
        &self,
        connection: Uuid,
        document: Uuid,
    ) -> Result<Arc<Document>, OperationError> {
        self.0
            .connections
            .lock()
            .unwrap()
            .get(&connection)
            .and_then(|state| state.documents.get(&document))
            .cloned()
            .ok_or_else(|| failure(Error::Cancelled))
    }
    pub(super) fn close_document(
        &self,
        connection: Uuid,
        document: Uuid,
    ) -> Result<Option<Arc<Document>>, OperationError> {
        let mut connections = self.0.connections.lock().unwrap();
        let state = connections
            .get_mut(&connection)
            .ok_or_else(|| failure(Error::Cancelled))?;
        let document = state.documents.get(&document).cloned();
        if let Some(document) = &document {
            document.close();
        }
        Ok(document)
    }
    pub(super) fn forget_document(&self, connection: Uuid, document: Uuid) {
        if let Some(state) = self.0.connections.lock().unwrap().get_mut(&connection) {
            state.documents.remove(&document);
        }
    }
    pub fn close(&self) {
        let connections = std::mem::take(&mut *self.0.connections.lock().unwrap());
        for state in connections.into_values() {
            for document in state.documents.into_values() {
                document.close();
            }
        }
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        let state = self.registry.0.connections.lock().unwrap().remove(&self.id);
        if let Some(state) = state {
            for document in state.documents.into_values() {
                document.close();
            }
        }
    }
}
impl Document {
    pub fn reserve(
        self: &Arc<Self>,
        binding: &RemoteBinding,
        target: &Target,
        kind: RemoteKind,
        input: &Value,
    ) -> Result<Reservation, OperationError> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(failure(Error::Cancelled));
        }
        if let Some(presenter) = &state.presenter {
            presenter.check(binding, target, kind, input)?;
        }
        let permits = self
            .capacity
            .iter()
            .map(|capacity| capacity.clone().try_acquire_owned())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| failure(Error::Invalid("Remote capacity exhausted".into())))?;
        let id = Uuid::new_v4();
        state
            .reservations
            .insert(id, binding::Identity::new(binding, target, kind));
        Ok(Reservation {
            document: self.clone(),
            id,
            _permits: permits,
            _task: self.tasks.token(),
        })
    }
    pub fn insert(&self, id: Uuid, stream: Arc<worker::Handle>) -> Result<(), OperationError> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(failure(Error::Cancelled));
        }
        if state.presenter.is_none() {
            state.ordinary = true;
        }
        state.streams.insert(id, stream);
        Ok(())
    }
    pub fn stream(&self, id: Uuid) -> Result<Arc<worker::Handle>, OperationError> {
        self.state
            .lock()
            .unwrap()
            .streams
            .get(&id)
            .cloned()
            .ok_or_else(|| failure(Error::Retired))
    }
    pub fn forget(&self, id: Uuid) {
        self.state.lock().unwrap().streams.remove(&id);
    }
    pub fn cleanup_failed(&self) {
        self.state.lock().unwrap().cleanup_failed = true;
    }
    pub fn check_cleanup(&self) -> Result<(), OperationError> {
        if self.state.lock().unwrap().cleanup_failed {
            return Err(failure(Error::CleanupUnconfirmed));
        }
        Ok(())
    }
    pub fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        let presenter = state.presenter.clone();
        self.cancellation.cancel();
        self.tasks.close();
        drop(state);
        if let Some(presenter) = presenter {
            presenter.cancel();
        }
    }
    pub async fn drained(&self) -> Result<(), OperationError> {
        // A cancelled page settles for at most six seconds; its independent
        // invocation resources then retain their existing five-second budget.
        tokio::time::timeout(std::time::Duration::from_secs(12), self.tasks.wait())
            .await
            .map_err(|_| failure(Error::CleanupUnconfirmed))?;
        self.check_cleanup()
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.document
            .state
            .lock()
            .unwrap()
            .reservations
            .remove(&self.id);
    }
}
