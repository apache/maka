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
use maka_agent_facts::external_publication::{
    ExternalPublicationBlocker, ExternalPublicationEvent, ExternalPublicationKey,
};

impl Engine {
    #[expect(
        clippy::too_many_arguments,
        reason = "Publication launch needs the original claim, frontier, ports and both live work registries"
    )]
    pub(super) async fn launch_publication(
        &self,
        claim: &DriverClaim,
        view: &RunView,
        ports: Arc<dyn DriverPorts>,
        live: &mut Live,
        work: &mut Work,
        action: Action,
        at: UnixMillis,
    ) -> Result<(), RunError> {
        if let Action::AbandonPublication(id) = &action {
            self.publish(
                Some(claim),
                view,
                vec![Fact::ExternalPublication {
                    event: ExternalPublicationEvent::Abandoned { id: *id },
                }],
                vec![],
                at,
            )
            .await?;
            return Ok(());
        }
        let id = match &action {
            Action::PreparePublication(id) => {
                live.publication_prepared.insert(*id);
                if !fresh_publication(view, at) {
                    return Ok(());
                }
                *id
            }
            Action::ValidatePublication(key) => {
                if !fresh_publication(view, at) || !next_publication_item(view, *key) {
                    return Ok(());
                }
                key.publication
            }
            Action::LookupPublication(key) => {
                live.publication_looked_up.insert(*key);
                key.publication
            }
            Action::ObservePublication(key, _) => {
                live.publication_observed.insert(*key);
                key.publication
            }
            _ => unreachable!("publication action dispatch"),
        };
        let Some(capability) = ports.publication() else {
            return self
                .block(
                    claim,
                    view,
                    BlockerKind::ExternalPublicationUnavailable {
                        publication: id,
                        diagnostic: "current Native publication capability is unavailable".into(),
                    },
                    at,
                )
                .await;
        };
        live.work.insert(WorkKey::Publication(id));
        let run = claim.run();
        match action {
            Action::PreparePublication(id) => {
                let snapshot = view.clone();
                work.push(
                    async move {
                        Completion::PublicationPrepared {
                            id,
                            control: snapshot.control_version,
                            result: capability.prepare_publication(&snapshot, id).await,
                        }
                    }
                    .boxed(),
                );
            }
            Action::ValidatePublication(key) => {
                let snapshot = view.clone();
                work.push(
                    async move {
                        Completion::PublicationValidated {
                            key,
                            control: snapshot.control_version,
                            result: capability.validate_publication_item(&snapshot, key).await,
                        }
                    }
                    .boxed(),
                );
            }
            Action::LookupPublication(key) => {
                let witness = PublicationWitness::new(self.store.clone(), run, key);
                work.push(
                    async move {
                        Completion::PublicationLooked {
                            key,
                            result: capability.lookup_publication_item(run, key, witness).await,
                        }
                    }
                    .boxed(),
                );
            }
            Action::ObservePublication(key, reference) => {
                let witness = PublicationWitness::new(self.store.clone(), run, key);
                work.push(
                    async move {
                        Completion::PublicationRecorded {
                            key,
                            result: capability
                                .observe_publication_item(run, key, reference, witness)
                                .await,
                        }
                    }
                    .boxed(),
                );
            }
            _ => unreachable!("publication action dispatch"),
        }
        Ok(())
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "Publication completion settles the original claim, frontier, ports and work registries together"
    )]
    pub(super) async fn complete_publication(
        &self,
        claim: &DriverClaim,
        view: &RunView,
        ports: &Arc<dyn DriverPorts>,
        live: &mut Live,
        work: &mut Work,
        completion: Completion,
        at: UnixMillis,
        retiring: bool,
    ) -> Result<(), RunError> {
        match completion {
            Completion::PublicationPrepared {
                id,
                control,
                result,
            } => {
                live.work.remove(&WorkKey::Publication(id));
                let result = match result {
                    Err(error @ (RunError::Store(_) | RunError::PublicationUncertain { .. })) => {
                        return Err(error);
                    }
                    result => result,
                };
                if retiring || control != view.control_version || !fresh_publication(view, at) {
                    return Ok(());
                }
                let prepared = match result {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        return self
                            .publication_unavailable(claim, view, id, error, at)
                            .await;
                    }
                };
                let mut contents = prepared.contents;
                contents.push(prepared.manifest.clone());
                self.publish(
                    Some(claim),
                    view,
                    vec![Fact::ExternalPublication {
                        event: ExternalPublicationEvent::Prepared {
                            id,
                            manifest: prepared.manifest.reference().clone(),
                            item_count: prepared.item_count,
                        },
                    }],
                    contents,
                    at,
                )
                .await?;
            }
            Completion::PublicationValidated {
                key,
                control,
                result,
            } => {
                live.work.remove(&WorkKey::Publication(key.publication));
                let result = match result {
                    Err(error @ (RunError::Store(_) | RunError::PublicationUncertain { .. })) => {
                        return Err(error);
                    }
                    result => result,
                };
                if retiring
                    || control != view.control_version
                    || !fresh_publication(view, at)
                    || !next_publication_item(view, key)
                {
                    return Ok(());
                }
                let basis = match result {
                    Ok(basis) => basis,
                    Err(error) => {
                        return self
                            .publication_unavailable(claim, view, key.publication, error, at)
                            .await;
                    }
                };
                let Some(capability) = ports.publication() else {
                    return self
                        .publication_unavailable(
                            claim,
                            view,
                            key.publication,
                            RunError::Internal(
                                "current Native publication capability disappeared".into(),
                            ),
                            at,
                        )
                        .await;
                };
                if !self
                    .publish(
                        Some(claim),
                        view,
                        vec![Fact::ExternalPublication {
                            event: ExternalPublicationEvent::Admitted { key, basis },
                        }],
                        vec![],
                        at,
                    )
                    .await?
                {
                    return Ok(());
                }
                // The durable T1 ACK precedes every effect RPC. Stop, replacement
                // or budget exhaustion during that commit cannot dispatch fresh work.
                let witness = PublicationWitness::new(self.store.clone(), claim.run(), key);
                let current = match self.store.driver_frontier(claim).await {
                    Ok(current) => current,
                    Err(source) => {
                        witness.prevented_before_dispatch(format!("Original Agent admission was not handed to Native dispatch: {source}"),ports.now()).await?;
                        return Err(source.into());
                    }
                };
                if !fresh_publication(&current, ports.now())
                    || current.control_version != control
                    || current
                        .blockers
                        .values()
                        .any(|blocker| blocker.decision.is_none() && blocker.resolved_by.is_none())
                {
                    witness
                        .prevented_before_dispatch(
                            "Original Agent admission was fenced before Native dispatch".into(),
                            ports.now(),
                        )
                        .await?;
                    return Ok(());
                }
                let run = claim.run();
                live.work.insert(WorkKey::Publication(key.publication));
                work.push(
                    async move {
                        Completion::PublicationRecorded {
                            key,
                            result: capability
                                .dispatch_publication_item(run, key, witness)
                                .await,
                        }
                    }
                    .boxed(),
                );
            }
            Completion::PublicationLooked { key, result } => {
                live.work.remove(&WorkKey::Publication(key.publication));
                match result {
                    Ok(OriginalLookup::Found(reference)) => {
                        let item = self.store.publication_item(claim.run(), key).await?;
                        let original = item.as_ref().and_then(|item| item.original.as_ref());
                        if original != Some(&reference) {
                            return Err(RunError::Internal(
                                "publication lookup acknowledged an unrecorded original binding"
                                    .into(),
                            ));
                        }
                    }
                    Ok(OriginalLookup::Absent) => {}
                    Ok(OriginalLookup::Blocked(reason)) => {
                        self.block(claim, view, reason, at).await?;
                    }
                    Err(RunError::Blocked(reason)) => {
                        self.block(claim, view, *reason, at).await?;
                    }
                    Err(error) => return Err(error),
                }
            }
            Completion::PublicationRecorded { key, result } => {
                live.work.remove(&WorkKey::Publication(key.publication));
                match result {
                    Ok(id) => {
                        let recorded = self.store.fact(claim.run(), id).await?;
                        if !recorded.is_some_and(|recorded| {
                            recorded.run == claim.run()
                                && matches!(recorded.fact, Fact::ExternalPublication { event } if event.key() == Some(key))
                        }) {
                            return Err(RunError::Internal(
                                "publication source acknowledged a fact outside its original item".into(),
                            ));
                        }
                    }
                    Err(error @ (RunError::Store(_) | RunError::PublicationUncertain { .. })) => {
                        return Err(error);
                    }
                    Err(RunError::Blocked(reason)) => {
                        self.block(claim, view, *reason, at).await?;
                    }
                    Err(error) => {
                        tracing::error!(publication=%key.publication,index=key.index,cause=%error,"original publication item observation failed");
                        let current = self.store.frontier(claim.run()).await?;
                        let item = self
                            .store
                            .publication_item(claim.run(), key)
                            .await?
                            .ok_or_else(|| {
                                RunError::Internal(
                                    "publication completion has no original T1".into(),
                                )
                            })?;
                        if !item.known() {
                            self.block(
                                claim,
                                &current,
                                BlockerKind::ExternalPublicationItem {
                                    key,
                                    reason: ExternalPublicationBlocker::Unknown,
                                },
                                at,
                            )
                            .await?;
                        }
                    }
                }
            }
            _ => unreachable!("publication completion dispatch"),
        }
        Ok(())
    }

    async fn publication_unavailable(
        &self,
        claim: &DriverClaim,
        view: &RunView,
        id: ExternalPublicationId,
        error: RunError,
        at: UnixMillis,
    ) -> Result<(), RunError> {
        let reason = match error {
            RunError::Blocked(reason) => *reason,
            error @ (RunError::Store(_) | RunError::PublicationUncertain { .. }) => {
                return Err(error);
            }
            error => BlockerKind::ExternalPublicationUnavailable {
                publication: id,
                diagnostic: error.to_string(),
            },
        };
        self.block(claim, view, reason, at).await
    }
}

fn fresh_publication(view: &RunView, at: UnixMillis) -> bool {
    !view.stopped
        && !view.cancelled_by_risk
        && view.terminal.is_none()
        && view
            .spec
            .budget
            .deadline
            .is_none_or(|deadline| at < deadline)
        && view
            .spec
            .budget
            .tokens
            .is_none_or(|limit| view.tokens < limit)
}

fn next_publication_item(view: &RunView, key: ExternalPublicationKey) -> bool {
    view.blockers
        .values()
        .all(|blocker| blocker.decision.is_some() || blocker.resolved_by.is_some())
        && view
            .external
            .as_ref()
            .and_then(|task| task.publication.as_ref())
            .is_some_and(|publication| {
                publication.id == key.publication
                    && !publication.abandoned
                    && publication.manifest.is_some()
                    && publication
                        .item_count
                        .is_some_and(|count| key.index < count)
                    && key.index == publication.settled
                    && publication.admitted == publication.settled
                    && !publication.items.contains_key(&key.index)
            })
}
