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

use super::*;
use crate::connection::BoxFuture;
use futures_util::{FutureExt, future::Shared};
use std::panic::AssertUnwindSafe;

/// The original Root owner closes SQL only after accepted physical work drains.
/// It survives destruction of the caller's runtime and never blocks a SQL actor.
pub(super) struct Lifecycle {
    closed: Shared<BoxFuture<'static, Result<(), String>>>,
    maintenance: Option<tokio::sync::oneshot::Sender<()>>,
}
impl Lifecycle {
    pub(super) async fn start(
        logs: Vec<Arc<EventLog>>,
        gates: Arc<gates::Gates>,
    ) -> Result<Self, StoreError> {
        let (ready, started) = tokio::sync::oneshot::channel();
        let (done, closed) = tokio::sync::oneshot::channel();
        let (maintenance, recovered) = tokio::sync::oneshot::channel();
        std::thread::Builder::new()
            .name("runtime-root-owner".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        for log in &logs {
                            log.request_shutdown();
                        }
                        let reason = error.to_string();
                        let _ = ready.send(Err(reason.clone()));
                        let _ = done.send(Err(reason));
                        return;
                    }
                };
                // A cancelled startup observer is an instruction to close, not a
                // detached Root with no remaining authority holder.
                if ready.send(Ok(())).is_err() {
                    gates.close();
                }
                let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
                    let (unconfirmed, premature_close) = runtime.block_on(async {
                        let receipts = logs.iter().map(|log| log.close_receipt()).collect::<Vec<_>>();
                        let shutdown = async {
                            tokio::select! {
                            failed = gates.wait_for_shutdown() => (failed, None),
                            (closed, _, _) = futures_util::future::select_all(receipts) => {
                                let ready = gates.shutdown_ready();
                                gates.close();
                                match (closed, ready) {
                                    (Ok(()), Some(unconfirmed)) => (unconfirmed, None),
                                    (closed, _) => (false, Some(closed.err().unwrap_or_else(|| "SQL owner closed before Root work drained".into()))),
                                }
                            }
                            }
                        };
                        let (_, result) = futures_util::future::join(
                            material::maintain(&logs[1..], recovered, gates.cancellation()),
                            shutdown,
                        ).await;
                        result
                    });
                    if unconfirmed {
                        // Closing admission is not evidence that accepted owners
                        // have stopped using SQL. Keep their live
                        // actors and original authority so valid execution pins
                        // can still persist known results before quarantining.
                        return Err("accepted Root work cleanup is unconfirmed".into());
                    }
                    for log in &logs { log.request_shutdown(); }
                    let results = runtime.block_on(futures_util::future::join_all(logs.iter().map(|log| log.shutdown())));
                    let mut failures: Vec<String> = results.into_iter().filter_map(Result::err).map(|error| error.to_string()).collect();
                    if let Some(error) = premature_close { failures.push(error); }
                    if failures.is_empty() {
                        Ok(())
                    } else {
                        Err(failures.join("; "))
                    }
                }))
                .unwrap_or_else(|_| {
                    Err("Root lifecycle owner panicked before confirming cleanup".into())
                });
                let failed = result.is_err();
                if !failed {
                    drop(logs);
                    drop(gates);
                }
                let _ = done.send(result);
                if failed {
                    // Retain the original authority and unconfirmed work. Reporting
                    // failure is not permission to install a replacement Root.
                    loop {
                        std::thread::park();
                    }
                }
            })?;
        match started.await {
            Ok(Ok(())) => Ok(Self {
                maintenance: Some(maintenance),
                closed: async move {
                    closed
                        .await
                        .map_err(|_| "Root owner exited without close acknowledgement".to_owned())?
                }
                .boxed()
                .shared(),
            }),
            Ok(Err(error)) => Err(StoreError::CloseFailed(error)),
            Err(_) => Err(StoreError::Initialization),
        }
    }
    pub(super) fn start_maintenance(&mut self) -> Result<(), StoreError> {
        self.maintenance
            .take()
            .expect("Root enables maintenance once, after startup recovery")
            .send(())
            .map_err(|_| StoreError::ConnectionClosed)
    }
    #[cfg(test)]
    pub(super) fn receipt(&self) -> Shared<BoxFuture<'static, Result<(), String>>> {
        self.closed.clone()
    }
    pub(super) async fn wait(&self) -> Result<(), StoreError> {
        self.closed.clone().await.map_err(StoreError::CloseFailed)
    }
}

/// Captured from the live Root; temporary stage SQL joins the same shutdown
/// barrier as physical Session work without becoming a permanent partition.
#[derive(Clone)]
pub(crate) struct StageOwner {
    root: Arc<root::RootOwner>,
    gates: Arc<gates::Gates>,
}

impl RootStore {
    pub(crate) fn stage_owner(&self) -> Result<StageOwner, StoreError> {
        self.require_open()?;
        Ok(StageOwner {
            root: self.control.owned_root()?,
            gates: self.gates.clone(),
        })
    }
}

impl StageOwner {
    pub(crate) fn validate_current(&self) -> Result<(), StoreError> {
        self.root.validate_current()?;
        Ok(())
    }
    pub(crate) async fn open(
        &self,
        options: sqlx::sqlite::SqliteConnectOptions,
        initialize: impl for<'c> FnOnce(
            &'c mut SqliteConnection,
        ) -> BoxFuture<'c, Result<(), StoreError>>
        + Send
        + 'static,
    ) -> Result<crate::connection::OwnedConnection, StoreError> {
        self.validate_current()?;
        // No await separates registration from spawning the actual SQL owner.
        self.gates.start_work()?;
        let registration = StageRegistration {
            owner: Some(self.clone()),
            started: false,
        };
        crate::connection::OwnedConnection::open_tracked(
            options,
            crate::connection::ConnectionAuthority::Root(self.root.clone()),
            initialize,
            registration,
        )
        .await
    }
}

/// Moved to the original connection thread before initialization can yield.
/// Losing that thread's terminal report is failure, never inferred completion.
pub(crate) struct StageRegistration {
    owner: Option<StageOwner>,
    started: bool,
}
impl StageRegistration {
    pub(crate) fn started(&mut self) {
        self.started = true;
    }
    pub(crate) fn complete(&mut self, clean: bool) {
        if let Some(owner) = self.owner.take() {
            if clean {
                owner.gates.finish_work();
            } else {
                owner.gates.close();
                owner.gates.retain_unconfirmed(owner.root);
            }
        }
    }
}
impl Drop for StageRegistration {
    fn drop(&mut self) {
        // spawn failure destroys an unstarted closure without ever opening SQL.
        // Once started, only the explicit actual-close path may acknowledge it.
        self.complete(!self.started);
    }
}
