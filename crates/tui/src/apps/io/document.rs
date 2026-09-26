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

//! One transient execution owner allocates and retires a page document.
//! Calls borrow it; request cancellation cannot drop its allocation or cleanup.

use super::{Failure, Request};
use maka_client::Client;
use maka_protocol::plugin::{RemoteRequest, RemoteResult};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use tokio::{
    sync::{oneshot, watch},
    task::JoinSet,
};
use uuid::Uuid;

#[derive(Clone)]
pub struct Document(Arc<State>);
struct State {
    available: watch::Receiver<Option<Result<Uuid, ()>>>,
    closed: watch::Receiver<Option<Result<(), ()>>>,
    initialized: AtomicBool,
    alive: AtomicBool,
    stop: Mutex<Option<oneshot::Sender<()>>>,
    pub calls: tokio::sync::Mutex<()>,
    target: Mutex<Option<maka_plugins::remote::Target>>,
}

pub(super) struct Owned {
    pub document: Document,
    root: String,
    epoch: String,
    key: Option<super::super::Key>,
}
impl Owned {
    pub fn new(
        client: Client,
        request: &Request,
        preceding: Vec<Document>,
        tasks: &mut JoinSet<Result<(), ()>>,
    ) -> Self {
        let (available, receiver) = watch::channel(None);
        let (closed, settled) = watch::channel(None);
        let (stop, stopped) = oneshot::channel();
        let document = Document(Arc::new(State {
            available: receiver,
            closed: settled,
            initialized: AtomicBool::new(false),
            alive: AtomicBool::new(true),
            stop: Mutex::new(Some(stop)),
            target: Mutex::new(None),
            calls: tokio::sync::Mutex::new(()),
        }));
        // This task is never aborted, including a late allocation after retirement.
        tasks.spawn(async move {
            let result = allocate(client, stopped, available, preceding).await;
            let _ = closed.send(Some(result));
            result
        });
        Self {
            document,
            root: request.root.clone(),
            epoch: request.epoch.clone(),
            key: request.key.clone(),
        }
    }
    pub fn matches(&self, request: &Request) -> bool {
        self.root == request.root && self.epoch == request.epoch && self.key == request.key
    }
}
impl Drop for Owned {
    fn drop(&mut self) {
        self.document.retire();
    }
}
impl Document {
    pub(super) fn confirmed_closed(&self) -> bool {
        matches!(*self.0.closed.borrow(), Some(Ok(())))
    }
    async fn closed(&self) -> Result<(), ()> {
        let mut closed = self.0.closed.clone();
        loop {
            if let Some(result) = *closed.borrow_and_update() {
                return result;
            }
            closed.changed().await.map_err(|_| ())?;
        }
    }
    pub(super) fn accepts(&self, target: &maka_plugins::remote::Target) -> bool {
        let mut current = self.0.target.lock().expect("document target");
        match current.as_ref() {
            Some(current) => current == target,
            None => {
                *current = Some(target.clone());
                true
            }
        }
    }
    pub(super) async fn lock(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.0.calls.lock().await
    }
    pub(super) async fn id(&self) -> Result<Uuid, Failure> {
        let mut available = self.0.available.clone();
        loop {
            if !self.0.alive.load(Ordering::Acquire) {
                return Err(Failure { unknown: false });
            }
            if let Some(result) = *available.borrow_and_update() {
                return result.map_err(|_| Failure { unknown: false });
            }
            available
                .changed()
                .await
                .map_err(|_| Failure { unknown: false })?;
        }
    }
    pub(super) fn initialized(&self) {
        self.0.initialized.store(true, Ordering::Release);
    }
    pub(super) fn ready(&self) -> Option<Uuid> {
        if !self.0.alive.load(Ordering::Acquire) || !self.0.initialized.load(Ordering::Acquire) {
            return None;
        }
        (*self.0.available.borrow()).and_then(Result::ok)
    }
    pub(super) fn retire(&self) {
        self.0.alive.store(false, Ordering::Release);
        if let Some(stop) = self.0.stop.lock().expect("document owner").take() {
            let _ = stop.send(());
        }
    }
}

async fn allocate(
    client: Client,
    mut stopped: oneshot::Receiver<()>,
    available: watch::Sender<Option<Result<Uuid, ()>>>,
    preceding: Vec<Document>,
) -> Result<(), ()> {
    // Close completion, not retirement intent, frees the prior Page's capacity.
    for previous in preceding {
        let settled = tokio::select! {
            biased;
            _ = &mut stopped => false,
            closed = previous.closed() => closed.is_ok(),
        };
        if !settled {
            let _ = available.send(Some(Err(())));
            return Ok(()); // This owner allocated nothing; the old failure remains fenced.
        }
    }
    let result = client.plugin_remote(RemoteRequest::OpenDocument).await;
    let Ok(RemoteResult::Document { document }) = result else {
        let _ = available.send(Some(Err(())));
        return if matches!(result, Err(maka_client::RequestFailure::Unknown(_))) {
            Err(())
        } else {
            Ok(())
        };
    };
    let _ = available.send(Some(Ok(document)));
    let _ = stopped.await;
    match client
        .plugin_remote(RemoteRequest::CloseDocument { document })
        .await
    {
        Ok(RemoteResult::Closed) => Ok(()),
        _ => Err(()),
    }
}

impl crate::app::App {
    pub fn apps_observation_failed(&mut self, owner: Uuid) {
        if let Some(instance) = self
            .apps
            .instances
            .values_mut()
            .find(|instance| instance.execution == owner)
        {
            // A frozen write still pins the old document until its authoritative result.
            instance.fail_read(crate::apps::instance::Notice::Local("extensions-failed"));
        }
    }
    /// Visibility owns execution, except a frozen write stays pinned to its receipt.
    pub fn apps_executions(&mut self) -> std::collections::BTreeSet<Uuid> {
        let selected: std::collections::BTreeSet<_> = self
            .apps
            .instances
            .keys()
            .filter(|key| self.app_selected(key))
            .cloned()
            .collect();
        let mut wanted = std::collections::BTreeSet::new();
        for (key, instance) in &mut self.apps.instances {
            let active = instance.writing
                || (selected.contains(key)
                    && instance.entry.is_some()
                    && (instance.live.is_some() || instance.busy || instance.pending.is_some()));
            if active {
                if instance.execution.is_nil() {
                    instance.execution = Uuid::new_v4();
                }
                wanted.insert(instance.execution);
            } else {
                instance.retire_execution();
            }
        }
        wanted
    }
}

#[cfg(test)]
mod tests;
