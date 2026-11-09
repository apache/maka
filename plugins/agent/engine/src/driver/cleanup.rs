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
use maka_agent_state::DriverPurpose;
use maka_plugin_core::operation::OperationCleanup;

impl Engine {
    pub async fn drive_cleanup(
        &self,
        claim: DriverClaim,
        ports: Arc<dyn ExternalCleanupPorts>,
        cancellation: CancellationToken,
    ) -> Result<DriverExit, RunError> {
        if !matches!(claim.purpose(), DriverPurpose::LateExternalCleanup { .. }) {
            return Err(RunError::InvalidInput(
                "business claim is not a cleanup capability".into(),
            ));
        }
        let run = claim.run();
        let retirement = claim.retirement();
        if cancellation.is_cancelled() || retirement.is_cancelled() {
            return Ok(DriverExit::Retired { run });
        }
        let original = self.store.cleanup_frontier(&claim).await?;
        match reconcile::cleanup_next(&original, ports.now()) {
            reconcile::CleanupAction::Done => return Ok(DriverExit::Waiting { run, due_at: None }),
            reconcile::CleanupAction::Wait(at) => {
                return Ok(DriverExit::Waiting {
                    run,
                    due_at: Some(at),
                });
            }
            reconcile::CleanupAction::Observe => {}
        }
        let mut source = match ports.open(original.clone()).await {
            Ok(source) => source,
            Err(error) => {
                return self
                    .defer_cleanup(&claim, error.to_string(), ports.now())
                    .await;
            }
        };
        let result = async {
            let mut notices = self.store.subscribe()?;
            loop {
                notices.borrow_and_update();
                if cancellation.is_cancelled() || retirement.is_cancelled() { return Ok(DriverExit::Retired { run }); }
                let current = self.store.cleanup_frontier(&claim).await?;
                if current.cleanup == OperationCleanup::Confirmed { return Ok(DriverExit::Waiting { run, due_at: None }); }
                let observed = {
                    let next = source.next();
                    tokio::pin!(next);
                    loop {
                        tokio::select! {
                            biased;
                            () = cancellation.cancelled() => return Ok(DriverExit::Retired { run }),
                            () = retirement.cancelled() => return Ok(DriverExit::Retired { run }),
                            changed = notices.changed() => {
                                changed.map_err(|_| StoreError::ConnectionClosed)?;
                                let current = self.store.cleanup_frontier(&claim).await?;
                                if current.cleanup == OperationCleanup::Confirmed { return Ok(DriverExit::Waiting { run, due_at: None }); }
                            },
                            observed = &mut next => break observed,
                        }
                    }
                };
                match observed {
                    Ok(OperationCleanup::Confirmed) => {
                        let witness = ExternalWitness::new(self.store.clone(), run, original.task);
                        let publication = witness.prepare_cleanup(OperationCleanup::Confirmed, ports.now());
                        loop {
                            notices.borrow_and_update();
                            match publication.reconcile().await {
                                Ok(_) => return Ok(DriverExit::Waiting { run, due_at: None }),
                                Err(error) => {
                                    tracing::error!(%run, %error, "Original cleanup proof publication remains unresolved");
                                    tokio::select! {
                                        biased;
                                        () = cancellation.cancelled() => return Ok(DriverExit::Retired { run }),
                                        () = retirement.cancelled() => return Ok(DriverExit::Retired { run }),
                                        changed = notices.changed() => { changed.map_err(|_| StoreError::ConnectionClosed)?; }
                                    }
                                }
                            }
                        }
                    }
                    Ok(OperationCleanup::Unconfirmed) => {},
                    Ok(OperationCleanup::Failed { diagnostic }) => return self.defer_cleanup(&claim, diagnostic, ports.now()).await,
                    Err(error) => return self.defer_cleanup(&claim, error.to_string(), ports.now()).await,
                }
            }
        }.await;
        source.close().await;
        result
    }

    async fn defer_cleanup(
        &self,
        claim: &DriverClaim,
        diagnostic: String,
        at: UnixMillis,
    ) -> Result<DriverExit, RunError> {
        let run = claim.run();
        let DriverPurpose::LateExternalCleanup { task } = claim.purpose() else {
            unreachable!("cleanup driver");
        };
        let due = UnixMillis(
            at.0.checked_add(30_000)
                .ok_or_else(|| RunError::InvalidInput("cleanup due overflow".into()))?,
        );
        let change = Change::new(
            Fact::ExternalTaskCleanupDeferred {
                task,
                not_before: due,
                diagnostic,
            },
            at,
        );
        let mut notices = self.store.subscribe()?;
        let retirement = claim.retirement();
        loop {
            notices.borrow_and_update();
            if claim.retirement().is_cancelled() {
                return Ok(DriverExit::Retired { run });
            }
            let current = self.store.cleanup_frontier(claim).await?;
            if current.cleanup == OperationCleanup::Confirmed {
                return Ok(DriverExit::Waiting { run, due_at: None });
            }
            if let Some(existing) = current.not_before.filter(|existing| *existing > at) {
                return Ok(DriverExit::Waiting {
                    run,
                    due_at: Some(existing),
                });
            }
            let publication = PendingPublication {
                run,
                claim: Some(claim.clone()),
                head: current.head,
                changes: vec![change.clone()],
                contents: vec![],
                steering: None,
            };
            loop {
                notices.borrow_and_update();
                match publication.reconcile(&self.store).await {
                    Ok(PublicationResolution::Committed(_)) => {
                        return Ok(DriverExit::Waiting {
                            run,
                            due_at: Some(due),
                        });
                    }
                    Ok(PublicationResolution::NotCommitted) => break,
                    Err(error) => {
                        tracing::error!(%run, %error, "Original cleanup defer publication remains unresolved");
                        tokio::select! {
                            biased;
                            () = retirement.cancelled() => return Ok(DriverExit::Retired { run }),
                            changed = notices.changed() => { changed.map_err(|_| StoreError::ConnectionClosed)?; }
                        }
                    }
                }
            }
        }
    }
}
