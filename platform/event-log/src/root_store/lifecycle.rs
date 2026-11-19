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
use futures_util::future::BoxFuture;
use futures_util::{FutureExt, future::Shared};
use std::panic::AssertUnwindSafe;

/// The original Root owner closes SQL only after accepted physical work drains.
/// It survives destruction of the caller's runtime and never blocks a SQL actor.
pub(super) struct Lifecycle {
    closed: Shared<BoxFuture<'static, Result<(), String>>>,
    maintenance: Option<tokio::sync::oneshot::Sender<()>>,
}
enum CloseFailure {
    RetainedWork,
    Unconfirmed(String),
}

impl Lifecycle {
    pub(super) async fn start(
        log: Arc<EventLog>,
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
                        log.request_shutdown();
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
                        let receipt = log.close_receipt();
                        let shutdown = async {
                            tokio::select! {
                            failed = gates.wait_for_shutdown() => (failed, None),
                            closed = receipt => {
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
                            material::maintain(&log, recovered, gates.cancellation()),
                            shutdown,
                        ).await;
                        result
                    });
                    if unconfirmed {
                        // Closing admission is not evidence that accepted owners
                        // have stopped using SQL. Keep their live
                        // actors and original authority so valid execution pins
                        // can still persist known results before quarantining.
                        return Err(CloseFailure::RetainedWork);
                    }
                    log.request_shutdown();
                    let mut failures: Vec<String> = runtime.block_on(log.shutdown()).err().map(|error|error.to_string()).into_iter().collect();
                    if let Some(error) = premature_close { failures.push(error); }
                    if failures.is_empty() {
                        Ok(())
                    } else {
                        Err(CloseFailure::Unconfirmed(failures.join("; ")))
                    }
                }))
                .unwrap_or_else(|_| {
                    Err(CloseFailure::Unconfirmed(
                        "Root lifecycle owner panicked before confirming cleanup".into(),
                    ))
                });
                match result {
                    Ok(()) => {
                        drop(log);
                        drop(gates);
                        let _ = done.send(Ok(()));
                    }
                    Err(CloseFailure::RetainedWork) => {
                        let _ = done.send(Err("accepted Root work cleanup is unconfirmed".into()));
                        // The original failure receipt stays failed. Only actual
                        // original settlement can release the retained authority.
                        let closed = std::panic::catch_unwind(AssertUnwindSafe(|| {
                            runtime.block_on(async {
                                gates.wait_for_settlement().await;
                                log.request_shutdown();
                                log.shutdown().await
                            })
                        }));
                        match closed {
                            Ok(Ok(())) => {
                                drop(log);
                                drop(gates);
                            }
                            failure => {
                                if let Ok(Err(error)) = failure {
                                    eprintln!("Root late cleanup close is unconfirmed: {error}");
                                }
                                loop { std::thread::park(); }
                            }
                        }
                    }
                    Err(CloseFailure::Unconfirmed(error)) => {
                        let _ = done.send(Err(error));
                        // A failed SQL close or lost owner has no release proof.
                        loop { std::thread::park(); }
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

    pub(super) async fn wait(&self) -> Result<(), StoreError> {
        self.closed.clone().await.map_err(StoreError::CloseFailed)
    }
}
