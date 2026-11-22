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
    pub async fn drive_model_cleanup(
        &self,
        claim: DriverClaim,
        ports: Arc<dyn ModelCleanupPorts>,
        cancellation: CancellationToken,
        cold_probe: bool,
    ) -> Result<DriverExit, RunError> {
        if claim.purpose() != DriverPurpose::LateModelCleanup {
            return Err(RunError::InvalidInput("not a model cleanup claim".into()));
        }
        let run = claim.run();
        let retirement = claim.retirement();
        let mut after = None;
        let mut unavailable = None;
        loop {
            let page = self
                .store
                .model_cleanups(&claim, after, 64, cold_probe)
                .await?;
            if page.is_empty() {
                break;
            }
            for original in page {
                after = Some(original.attempt);
                if cancellation.is_cancelled() || retirement.is_cancelled() {
                    return Ok(DriverExit::Retired { run });
                }
                match ports.observe(&original).await {
                    Ok(OperationCleanup::Confirmed) => {
                        let head = Head::from(&self.store.frontier(run).await?);
                        let publication = ModelCleanupPublication::claimed(
                            self.store.clone(),
                            claim.clone(),
                            head,
                            original.attempt,
                            ports.now(),
                        )?;
                        publication.reconcile_claimed().await?;
                    }
                    Ok(_) | Err(_) => {
                        unavailable.get_or_insert(original.attempt);
                    }
                }
            }
        }
        if let Some(attempt) = unavailable {
            return Err(RunError::from(BlockerKind::ModelCleanupUnconfirmed {
                attempt,
                diagnostic: "original model cleanup source is unavailable".into(),
            }));
        }
        Ok(DriverExit::Waiting { run, due_at: None })
    }

    pub async fn block_unavailable_model_cleanups(
        &self,
        claim: &DriverClaim,
        at: UnixMillis,
    ) -> Result<(), RunError> {
        let view = self.store.original_driver_frontier(claim).await?;
        let facts: Vec<_> = view.attempts.iter().filter(|(id, attempt)| {
            attempt.admission.is_some() && attempt.cleanup != OperationCleanup::Confirmed
                && !view.blockers.values().any(|blocker| blocker.resolved_by.is_none()
                    && matches!(&blocker.reason, BlockerKind::ModelCleanupUnconfirmed { attempt, .. } if attempt == *id))
        }).map(|(attempt, _)| Fact::Blocked {
            blocker: BlockerId::new(), reason: BlockerKind::ModelCleanupUnconfirmed {
                attempt: *attempt, diagnostic: "original model cleanup source is unavailable".into(),
            },
        }).collect();
        if !facts.is_empty() {
            match self.publish(Some(claim), &view, facts, vec![], at).await {
                Ok(_) => {}
                Err(RunError::PublicationUncertain { publication, .. }) => {
                    let result = publication.reconcile(&self.store).await;
                    super::witness::settle_result(&self.store, &publication, result).await?;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    pub async fn settle_closed_model(
        &self,
        claim: DriverClaim,
        at: UnixMillis,
    ) -> Result<DriverExit, RunError> {
        if claim.purpose() != DriverPurpose::Business {
            return Err(RunError::InvalidInput(
                "canonical settlement requires its business claim".into(),
            ));
        }
        loop {
            if claim.retirement().is_cancelled() {
                return Ok(DriverExit::Retired { run: claim.run() });
            }
            let view = self.store.original_driver_frontier(&claim).await?;
            if view.terminal.is_some() {
                return Ok(exit(&view));
            }
            if view.attempts.values().any(|attempt| {
                attempt.admission.is_some() && attempt.cleanup != OperationCleanup::Confirmed
            }) {
                return Ok(exit(&view));
            }
            let action = match view.current_step {
                Some(step) => {
                    let request = self.store.request(view.run, step).await?;
                    reconcile::model_settlement_action(&view, &request, at)
                }
                None => None,
            };
            let Some(action) = action else {
                return Ok(exit(&view));
            };
            if !reconcile::budget_exhausted(&view)
                && !self
                    .store
                    .queue()
                    .steering(view.spec.session_id.clone(), view.run)
                    .await?
                    .entries
                    .is_empty()
            {
                return Ok(exit(&view));
            }
            let terminal = match &action {
                Action::Terminate(terminal) => Some(terminal.clone()),
                _ => None,
            };
            let (facts, contents) = match action {
                Action::Terminate(terminal) => (termination_facts(&view, terminal, None), vec![]),
                Action::Satisfy(wait) => {
                    let evidence = ContentBlob::json(
                        &serde_json::json!({"run":view.run,"revision":view.revision,"at":at}),
                    )?;
                    (
                        vec![Fact::WaitSatisfied {
                            wait,
                            evidence: evidence.reference().clone(),
                        }],
                        vec![evidence],
                    )
                }
                Action::CancelWait(wait) => (
                    vec![Fact::WaitCancelled {
                        wait,
                        diagnostic: "Original final reply settled".into(),
                    }],
                    vec![],
                ),
                _ => return Ok(exit(&view)),
            };
            match self.publish(Some(&claim), &view, facts, contents, at).await {
                Ok(_) => {}
                Err(RunError::PublicationUncertain { publication, .. }) => {
                    let result = publication.reconcile(&self.store).await;
                    if matches!(
                        super::witness::settle_result(&self.store, &publication, result).await?,
                        PublicationResolution::NotCommitted
                    ) {
                        return Ok(DriverExit::Retired { run: view.run });
                    }
                }
                Err(error) => return Err(error),
            }
            if let Some(terminal) = terminal {
                return Ok(DriverExit::Terminal {
                    run: view.run,
                    terminal,
                });
            }
        }
    }

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
