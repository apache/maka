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

//! Original runtime custody, not another execution or recovery ledger.
use super::*;
use futures_util::{
    FutureExt, StreamExt,
    stream::{BoxStream, FuturesUnordered, SelectAll},
};
use maka_event_log::root_store::{RetainedWorkSettlement, SessionWorkLease, WorkEffects};

pub(super) enum OriginalScope {
    Driver {
        driver: Option<Arc<driver::NativeDriver>>,
        effects: WorkEffects,
        state: maka_agent_state::Store,
        pending: Option<maka_agent_engine::PendingPublication>,
    },
    Preparation(Option<driver_model::DriverModel>),
}
struct RetainedMaterial {
    original: Arc<OriginalScope>,
    settlement: RetainedWorkSettlement,
}
pub(super) struct RetainedScope {
    material: std::sync::Mutex<Option<RetainedMaterial>>,
    close_requested: CancellationToken,
    close_round_finished: CancellationToken,
    observer: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl RetainedScope {
    async fn release(self: &Arc<Self>, owner: &Arc<Owner>, session: &str) {
        let mut runs = owner.runs.state().await;
        if let Some(material) = self.material.lock().unwrap().take() {
            drop(material.original);
            material.settlement.confirm_cleanup();
        }
        if let Some(scopes) = runs.retained_cleanup.get_mut(session) {
            scopes.retain(|candidate| !Arc::ptr_eq(candidate, self));
            if scopes.is_empty() {
                runs.retained_cleanup.remove(session);
            }
        }
        drop(runs);
        owner.physical_availability_changed();
    }
}
impl OriginalScope {
    fn model_changes(&self) -> Option<tokio::sync::watch::Receiver<()>> {
        match self {
            Self::Driver {
                driver: Some(driver),
                ..
            } => match &driver.backend {
                driver::NativeBackend::Model { model, .. } => {
                    Some(model.original_cleanup.changes())
                }
                _ => None,
            },
            Self::Preparation(Some(model)) => Some(model.original_cleanup.changes()),
            _ => None,
        }
    }
    async fn signals(&self) -> Vec<BoxFuture<'static, ()>> {
        match self {
            Self::Driver {
                driver: Some(driver),
                ..
            } => driver.original_cleanup_signals().await,
            _ => Vec::new(),
        }
    }
    async fn confirmed(&self) -> Result<bool, RunError> {
        match self {
            Self::Driver {
                driver,
                effects,
                state,
                pending,
            } => {
                if let Some(pending) = pending {
                    pending.reconcile(state).await?;
                }
                let closed = match driver {
                    Some(driver) => driver.original_cleanup_confirmed().await?,
                    None => pending.is_some(),
                };
                Ok(closed && !effects.has_pending())
            }
            Self::Preparation(Some(model)) => model.original_cleanup_confirmed().await,
            // The original owner was lost before providing a resource observer.
            Self::Preparation(None) => Ok(false),
        }
    }
}
impl Owner {
    pub(super) async fn try_confirm_retained_scopes(self: &Arc<Self>) {
        let scopes = {
            let runs = self.runs.state().await;
            runs.retained_cleanup
                .values()
                .flat_map(|scopes| scopes.iter().cloned())
                .collect::<Vec<_>>()
        };
        for scope in &scopes {
            scope.close_requested.cancel();
        }
        for scope in scopes {
            scope.close_round_finished.cancelled().await;
            let observer = {
                let mut observer = scope.observer.lock().unwrap();
                if observer
                    .as_ref()
                    .is_some_and(|observer| observer.is_finished())
                {
                    observer.take()
                } else {
                    None
                }
            };
            if let Some(observer) = observer {
                if let Err(error) = observer.await {
                    tracing::error!(%error, "Original cleanup observer failed to join normally");
                }
            }
            let material = scope.material.lock().unwrap();
            let Some(material) = material.as_ref() else {
                continue;
            };
            let (kind, run) = match material.original.as_ref() {
                OriginalScope::Driver {
                    driver: Some(driver),
                    ..
                } => ("driver", Some(driver.access.execution().run_id)),
                OriginalScope::Driver { .. } => ("driver_missing", None),
                OriginalScope::Preparation(Some(model)) => {
                    ("preparation", Some(model.execution.run_id))
                }
                OriginalScope::Preparation(None) => ("preparation_missing", None),
            };
            tracing::warn!(scope_kind = kind, run_id = ?run, "Original retained Scope has no positive Root cleanup fence");
        }
    }

    pub(super) async fn retain_original_preparation(
        self: &Arc<Self>,
        session: String,
        lease: SessionWorkLease,
        model: Option<driver_model::DriverModel>,
    ) {
        self.retain_original_scope(session, lease, OriginalScope::Preparation(model))
            .await;
    }
    pub(super) async fn retain_original_scope(
        self: &Arc<Self>,
        session: String,
        lease: SessionWorkLease,
        original: OriginalScope,
    ) {
        if let OriginalScope::Driver { effects, .. } = &original {
            let _historical_failure = effects.seal();
        }
        let original = Arc::new(original);
        let settlement = lease.retain_original_material(original.clone());
        let scope = Arc::new(RetainedScope {
            material: std::sync::Mutex::new(Some(RetainedMaterial {
                original,
                settlement,
            })),
            close_requested: CancellationToken::new(),
            close_round_finished: CancellationToken::new(),
            observer: std::sync::Mutex::new(None),
        });
        let mut runs = self.runs.state().await;
        runs.retained_cleanup
            .entry(session.clone())
            .or_default()
            .push(scope.clone());
        scope.start_observer(self.clone(), session);
        drop(runs);
        self.physical_availability_changed();
    }
}
impl RetainedScope {
    fn start_observer(self: &Arc<Self>, owner: Arc<Owner>, session: String) {
        let mut observer_slot = self.observer.lock().unwrap();
        if observer_slot.is_some() {
            return;
        }
        if self.material.lock().unwrap().is_none() {
            return;
        }
        let retained = self.clone();
        let exit_notice = retained.close_round_finished.clone().drop_guard();
        let observer = tokio::spawn(async move {
            let _exit_notice = exit_notice;
            // A close request wakes the observer; it must never abandon an admitted read.
            let mut close_seen = false;
            let mut notices = match owner.durable.subscribe() {
                Ok(notices) => Some(notices),
                Err(error) => {
                    tracing::error!(%error, "original SQL cleanup observation unavailable");
                    None
                }
            };
            let mut physical = FuturesUnordered::<BoxFuture<'static, ()>>::new();
            let mut cells = SelectAll::<BoxStream<'static, ()>>::new();
            let mut model_changes;
            {
                let original = match retained.material.lock().unwrap().as_ref() {
                    Some(material) => material.original.clone(),
                    None => return,
                };
                model_changes = original.model_changes();
                match original.as_ref() {
                    OriginalScope::Driver { driver, .. } => {
                        if let Some(driver) = driver {
                            if let driver::NativeBackend::Model {
                                cells: Some(runtime),
                                ..
                            } = &driver.backend
                            {
                                let (js, python, coordinator) = runtime.physical_changes();
                                for receiver in [js, python, coordinator] {
                                    cells.push(
                                        futures_util::stream::unfold(
                                            receiver,
                                            |mut receiver| async move {
                                                receiver.changed().await.ok()?;
                                                Some(((), receiver))
                                            },
                                        )
                                        .boxed(),
                                    );
                                }
                            }
                        }
                        physical.push(
                            async move {
                                if let OriginalScope::Driver { effects, .. } = original.as_ref() {
                                    let _historical_failure = effects.settle().await;
                                }
                            }
                            .boxed(),
                        );
                    }
                    OriginalScope::Preparation(Some(model)) => {
                        let workers = model.workers.clone();
                        physical.push(
                            async move {
                                workers.wait().await;
                            }
                            .boxed(),
                        );
                    }
                    OriginalScope::Preparation(None) => {}
                }
            }
            loop {
                if let Some(changes) = model_changes.as_mut() {
                    changes.borrow_and_update();
                }
                if let Some(notices) = notices.as_mut() {
                    notices.borrow_and_update();
                }
                let original = {
                    let material = retained.material.lock().unwrap();
                    match material.as_ref() {
                        Some(material) => material.original.clone(),
                        None => return,
                    }
                };
                let close_round = retained.close_requested.is_cancelled();
                let confirmed = std::panic::AssertUnwindSafe(async {
                    physical.extend(original.signals().await);
                    // Drain ready hints so every remaining source has installed its wake.
                    futures_util::future::poll_fn(|cx| {
                        while let std::task::Poll::Ready(Some(())) = physical.poll_next_unpin(cx) {}
                        std::task::Poll::Ready(())
                    })
                    .await;
                    let confirmed = original.confirmed().await;
                    // A probe may itself retain a newly pending original reader.
                    if !matches!(&confirmed, Ok(true)) {
                        physical.extend(original.signals().await);
                    }
                    confirmed
                })
                .catch_unwind()
                .await
                .unwrap_or_else(|_| {
                    Err(RunError::Internal("original cleanup probe panicked".into()))
                });
                drop(original);
                if matches!(&confirmed, Ok(true)) {
                    physical.clear();
                    cells.clear();
                    retained.release(&owner, &session).await;
                    return;
                }
                if close_round {
                    close_seen = true;
                    retained.close_round_finished.cancel();
                }
                match confirmed {
                    Ok(true) => unreachable!("confirmed scope handled"),
                    Ok(false) => {}
                    Err(error) => tracing::error!(%error, "original cleanup remains unconfirmed"),
                }
                tokio::select! {
                    biased;
                    () = retained.close_requested.cancelled(), if !close_seen => { close_seen = true; },
                    changed = async { model_changes.as_mut().expect("original model receiver branch enabled").changed().await }, if model_changes.is_some() => if changed.is_err() { model_changes = None; },
                    changed = async { notices.as_mut().expect("SQL receiver branch enabled").changed().await }, if notices.is_some() => if changed.is_err() { notices = None; },
                    _ = physical.next(), if !physical.is_empty() => {},
                    _ = cells.next(), if !cells.is_empty() => {},
                    else => return,
                }
            }
        });
        *observer_slot = Some(observer);
    }
}
