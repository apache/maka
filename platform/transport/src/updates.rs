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

//! One trusted launcher pipeline; foreground preflight precedes connection approval.
use crate::{Connections, Result};
use futures_util::{FutureExt, future::BoxFuture};
use maka_event_log::{applications::DeploymentChanges, root_store::RootStore};
use maka_plugin_core::deployment::DeploymentRef;
use maka_ui_runtime::{Application, CommittedUpdate, PreparedUpdate, actions::RemoteService};
use std::{
    collections::BTreeSet,
    sync::Arc,
    task::{Context, Poll, Waker},
    time::{Duration, Instant},
};
use tokio::{runtime::Handle, sync::Mutex, task::JoinHandle};

type Watch = BoxFuture<'static, (DeploymentChanges, Result<DeploymentRef>)>;
enum Work {
    Probe(JoinHandle<Result<bool>>),
    Load(JoinHandle<maka_ui_runtime::Result<CommittedUpdate>>),
    Approve {
        prepared: Box<PreparedUpdate>,
        task: JoinHandle<Result<Vec<RemoteService>>>,
    },
    Retain(JoinHandle<Result<()>>),
}
/// Owned by the original frontend. Watching is evidence, not authority: this
/// launcher explicitly delegates its original connection configuration only
/// after that frontend accepts the exact candidate's native availability.
pub struct Updates {
    connections: Arc<Mutex<Connections>>,
    scheduler: Handle,
    cursor: Option<DeploymentChanges>,
    watch: Option<Watch>,
    work: Option<Work>,
    next_probe: Instant,
    retained: BTreeSet<u64>,
    stopped: bool,
    unconfirmed: bool,
    wake: Waker,
}
/// Approved exact candidate; final adoption still checks the original frontend.
pub struct ApprovedUpdate {
    pub prepared: PreparedUpdate,
    pub registrations: Vec<RemoteService>,
}
impl Updates {
    pub fn new(
        store: Arc<RootStore>,
        source: DeploymentRef,
        connections: Arc<Mutex<Connections>>,
        scheduler: Handle,
    ) -> Result<Self> {
        let cursor = store
            .subscribe_application(source.clone())
            .map_err(|e| e.to_string())?;
        Ok(Self {
            connections,
            scheduler,
            cursor: Some(cursor),
            watch: None,
            work: None,
            next_probe: Instant::now() + Duration::from_secs(1),
            retained: BTreeSet::from([source.revision]),
            stopped: false,
            unconfirmed: false,
            wake: Waker::noop().clone(),
        })
    }
    pub fn set_waker(&mut self, wake: Waker) {
        self.wake = wake;
    }
    /// Controller probes are actual deadlines; work and source changes wake the
    /// original owner through their registered future, without frame polling.
    pub fn next_deadline(&self) -> Option<Instant> {
        (!self.stopped && !self.unconfirmed && self.work.is_none()).then_some(self.next_probe)
    }
    /// Bounded foreground turn. SQL and original controller exchanges run on
    /// the existing scheduler; at most one load/approval/retention is in flight.
    pub fn poll<V: ?Sized + 'static>(
        &mut self,
        application: &Application<V>,
    ) -> Result<Option<ApprovedUpdate>> {
        if self.stopped || self.unconfirmed {
            return Ok(None);
        }
        if application.is_closing() {
            self.stop();
            return Ok(None);
        }
        let mut cx = Context::from_waker(&self.wake);
        if let Some(work) = self.work.as_mut() {
            match work {
                Work::Probe(task) => {
                    let Poll::Ready(result) = task.poll_unpin(&mut cx) else {
                        return Ok(None);
                    };
                    self.work.take();
                    self.next_probe = Instant::now() + Duration::from_secs(1);
                    let changed = match result {
                        Ok(result) => result?,
                        Err(error) => {
                            self.unconfirmed = true;
                            return Err(error.to_string());
                        }
                    };
                    if changed {
                        let prepared = application
                            .prepare_current_update()
                            .map_err(|e| e.to_string())?;
                        self.approve(prepared, application.live_source_revisions());
                        return Ok(None);
                    }
                }
                Work::Load(task) => {
                    let Poll::Ready(result) = task.poll_unpin(&mut cx) else {
                        return Ok(None);
                    };
                    self.work.take();
                    let update = result
                        .map_err(|e| e.to_string())?
                        .map_err(|e| e.to_string())?;
                    let prepared = application
                        .prepare_update(update)
                        .map_err(|e| e.to_string())?;
                    self.approve(prepared, application.live_source_revisions());
                    return Ok(None);
                }
                Work::Approve { task, .. } => {
                    let Poll::Ready(result) = task.poll_unpin(&mut cx) else {
                        return Ok(None);
                    };
                    let Some(Work::Approve { prepared, .. }) = self.work.take() else {
                        unreachable!()
                    };
                    self.retained.clear();
                    let registrations = match result {
                        Ok(result) => result?,
                        Err(error) => {
                            self.unconfirmed = true;
                            return Err(error.to_string());
                        }
                    };
                    // Reconcile from actual foreground facts on the next turn,
                    // after adoption or any final rejection.
                    self.wake.wake_by_ref();
                    return Ok(Some(ApprovedUpdate {
                        prepared: *prepared,
                        registrations,
                    }));
                }
                Work::Retain(task) => {
                    let Poll::Ready(result) = task.poll_unpin(&mut cx) else {
                        return Ok(None);
                    };
                    self.work.take();
                    match result {
                        Ok(Err(error)) => {
                            self.retained.clear();
                            return Err(error);
                        }
                        Ok(Ok(())) => {}
                        Err(error) => {
                            self.unconfirmed = true;
                            return Err(error.to_string());
                        }
                    }
                }
            }
        }
        let retain = application.live_source_revisions();
        if retain != self.retained {
            // Immediate local revocation; original child-controller acknowledgement
            // follows asynchronously. This does not mint or rebind consumers.
            if let Ok(mut connections) = self.connections.try_lock() {
                connections.revoke_sources(&retain)?;
            }
            let connections = self.connections.clone();
            self.retained = retain.clone();
            self.work = Some(Work::Retain(self.scheduler.spawn(async move {
                connections.lock().await.retain_sources(retain).await
            })));
            self.wake.wake_by_ref();
            return Ok(None);
        }
        if self.watch.is_none() {
            let mut cursor = self.cursor.take().expect("owned deployment cursor");
            self.watch = Some(
                async move {
                    let result = cursor.next().await.map_err(|e| e.to_string());
                    (cursor, result)
                }
                .boxed(),
            );
        }
        let Poll::Ready((cursor, source)) = self.watch.as_mut().expect("watch").poll_unpin(&mut cx)
        else {
            if Instant::now() >= self.next_probe {
                let connections = self.connections.clone();
                self.work = Some(Work::Probe(self.scheduler.spawn(async move {
                    connections.lock().await.registrations_changed().await
                })));
                self.wake.wake_by_ref();
            }
            return Ok(None);
        };
        self.watch.take();
        self.cursor = Some(cursor);
        let future = application
            .load_committed_update(source?)
            .map_err(|e| e.to_string())?;
        self.work = Some(Work::Load(self.scheduler.spawn(future)));
        self.wake.wake_by_ref();
        Ok(None)
    }
    fn approve(&mut self, prepared: PreparedUpdate, mut retain: BTreeSet<u64>) {
        let source = prepared.source().clone();
        retain.insert(source.revision);
        let plan = prepared.plan().clone();
        let target = prepared.target();
        let connections = self.connections.clone();
        let task = self.scheduler.spawn(async move {
            connections
                .lock()
                .await
                .approve_plan(source, target, plan, retain)
                .await
        });
        self.work = Some(Work::Approve {
            prepared: Box::new(prepared),
            task,
        });
        self.wake.wake_by_ref();
    }
    /// No new candidate work. Never abort an already started controller exchange.
    pub fn stop(&mut self) {
        self.stopped = true;
        self.watch.take();
        self.cursor.take();
    }
    /// Must precede Connections and SQL drain. Failed physical observers retain
    /// the original owners; they cannot be turned into a clean shutdown receipt.
    pub async fn drain(mut self) {
        self.stop();
        if let Some(work) = self.work.take() {
            let physical = !matches!(work, Work::Load(_));
            let result = match work {
                Work::Probe(task) => task.await.map(|_| ()),
                Work::Load(task) => task.await.map(|_| ()),
                Work::Approve { task, .. } => task.await.map(|_| ()),
                Work::Retain(task) => task.await.map(|_| ()),
            };
            if physical && let Err(error) = result {
                self.unconfirmed = true;
                eprintln!("deployment controller observer unconfirmed: {error}");
            }
        }
        if self.unconfirmed {
            std::future::pending::<()>().await;
        }
    }
}
