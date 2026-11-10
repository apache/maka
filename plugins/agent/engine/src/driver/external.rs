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
use maka_plugin_core::operation::OperationCleanup;

fn read(work: &mut Work, task: ExternalTaskId, index: u64, mut connection: ExternalConnection) {
    work.push(
        async move {
            let notice = connection.next().await;
            Completion::External {
                task,
                index,
                connection,
                notice,
            }
        }
        .boxed(),
    );
}
impl Engine {
    pub(super) async fn launch_external(
        &self,
        claim: &DriverClaim,
        view: &RunView,
        ports: &Arc<dyn DriverPorts>,
        live: &mut Live,
        work: &mut Work,
        action: Action,
    ) -> Result<(), RunError> {
        let capability = ports.external().ok_or_else(|| {
            RunError::InvalidInput("executor Run requires a live external capability".into())
        })?;
        let run = claim.run();
        let now = ports.now();
        match action {
            Action::PrepareExternal(task) => {
                live.work.insert(WorkKey::External);
                let snapshot = view.clone();
                work.push(
                    async move {
                        Completion::ExternalPrepared {
                            task,
                            control: snapshot.control_version,
                            result: capability.prepare_external(&snapshot, task).await,
                        }
                    }
                    .boxed(),
                );
            }
            Action::StartExternal(task) => {
                if self
                    .publish(
                        Some(claim),
                        view,
                        vec![Fact::ExternalTaskAdmitted { task }],
                        vec![],
                        now,
                    )
                    .await?
                {
                    live.work.insert(WorkKey::External);
                    let witness = ExternalWitness::new(self.store.clone(), run, task);
                    let descriptor = view
                        .external
                        .as_ref()
                        .expect("prepared external task")
                        .descriptor
                        .clone();
                    work.push(
                        async move {
                            Completion::ExternalConnected {
                                task,
                                result: capability
                                    .start_external(run, task, descriptor, witness)
                                    .await,
                            }
                        }
                        .boxed(),
                    );
                }
            }
            Action::ObserveExternal(task, descriptor) => {
                live.work.insert(WorkKey::External);
                live.external_observed = true;
                let witness = ExternalWitness::new(self.store.clone(), run, task);
                let after = view.external.as_ref().expect("original task").observed;
                work.push(
                    async move {
                        Completion::ExternalConnected {
                            task,
                            result: capability
                                .observe_external(run, task, descriptor, after, witness)
                                .await,
                        }
                    }
                    .boxed(),
                );
            }
            _ => unreachable!("external action dispatch"),
        }
        Ok(())
    }
    pub(super) async fn complete_external(
        &self,
        claim: &DriverClaim,
        ports: &Arc<dyn DriverPorts>,
        live: &mut Live,
        work: &mut Work,
        completion: Completion,
        retiring: bool,
    ) -> Result<(), RunError> {
        let view = self.store.frontier(claim.run()).await?;
        let now = ports.now();
        let retiring = retiring || view.terminal.is_some();
        match completion {
            Completion::ExternalPrepared {
                task,
                control,
                result,
            } => {
                live.work.remove(&WorkKey::External);
                if retiring
                    || view.stopped
                    || view.terminal.is_some()
                    || control != view.control_version
                {
                    return Ok(());
                }
                let prepared = match result {
                    Ok(value) => value,
                    Err(error) => return self.port_failure(claim, &view, error, now).await,
                };
                let mut contents = prepared.contents;
                contents.push(prepared.descriptor.clone());
                self.publish(
                    Some(claim),
                    &view,
                    vec![Fact::ExternalTaskPrepared {
                        task,
                        descriptor: prepared.descriptor.reference().clone(),
                    }],
                    contents,
                    now,
                )
                .await?;
            }
            Completion::ExternalConnected { task, result } => match result {
                Ok(connection) => read(
                    work,
                    task,
                    view.external
                        .as_ref()
                        .expect("connected original task")
                        .observed,
                    connection,
                ),
                Err(error) => {
                    live.work.remove(&WorkKey::External);
                    if retiring {
                        return Ok(());
                    }
                    if view
                        .external
                        .as_ref()
                        .is_some_and(|original| original.task == task && original.closed.is_some())
                    {
                        tracing::error!(%task, %error, "External connection error after known canonical closure");
                        return Ok(());
                    }
                    let reason = match error {
                        RunError::Blocked(reason) => reason,
                        error => {
                            tracing::error!(task = %task, cause = %error, "original external task is unobservable");
                            let original = view.external.as_ref().expect("admitted original task");
                            BlockerKind::ExternalTaskUnobservable {
                                descriptor: original
                                    .binding
                                    .clone()
                                    .unwrap_or_else(|| original.descriptor.clone()),
                            }
                        }
                    };
                    if matches!(&reason, BlockerKind::ExternalTaskUnobservable { .. })
                        && view.stopped
                        && view.external.as_ref().is_some_and(|original| {
                            original.task == task
                                && !matches!(&original.cleanup, OperationCleanup::Failed { .. })
                        })
                    {
                        return Ok(());
                    }
                    self.block(claim, &view, reason, now).await?;
                }
            },
            Completion::External {
                task,
                index,
                connection,
                notice,
            } => {
                let Some(notice) = notice else {
                    live.work.remove(&WorkKey::External);
                    // A disconnected observer is not a completion receipt. Reconcile
                    // only through the exact original task port on the next action.
                    return Ok(());
                };
                let fact = match notice {
                    Ok(fact) => fact,
                    Err(error) => {
                        live.work.remove(&WorkKey::External);
                        if retiring {
                            return Ok(());
                        }
                        if view.external.as_ref().is_some_and(|original| {
                            original.task == task && original.closed.is_some()
                        }) {
                            tracing::error!(%task, %error, "External observation error after known canonical closure");
                            return Ok(());
                        }
                        let reason = match error {
                            RunError::Blocked(reason) => reason,
                            error => {
                                tracing::error!(cause=%error,"original external observation failed");
                                let original = view.external.as_ref().expect("original task");
                                BlockerKind::ExternalTaskUnobservable {
                                    descriptor: original
                                        .binding
                                        .clone()
                                        .unwrap_or_else(|| original.descriptor.clone()),
                                }
                            }
                        };
                        if matches!(&reason, BlockerKind::ExternalTaskUnobservable { .. })
                            && view.stopped
                            && view.external.as_ref().is_some_and(|original| {
                                original.task == task
                                    && !matches!(&original.cleanup, OperationCleanup::Failed { .. })
                            })
                        {
                            return Ok(());
                        }
                        return self.block(claim, &view, reason, now).await;
                    }
                };
                let original = self.store.fact(claim.run(), fact).await?.ok_or_else(|| {
                    RunError::Internal(
                        "external source acknowledged an absent original fact".into(),
                    )
                })?;
                let (next, done) = match original.fact {
                    Fact::ExternalTaskBound { task: source, .. } if source == task => {
                        (index, false)
                    }
                    Fact::ExternalTaskObserved {
                        task: source,
                        index: source_index,
                        ..
                    } if source == task => (
                        source_index
                            .checked_add(1)
                            .ok_or_else(|| RunError::Internal("external index overflow".into()))?,
                        false,
                    ),
                    Fact::ExternalTaskClosed { task: source, .. }
                    | Fact::ExternalTaskCleanupObserved { task: source, .. }
                        if source == task =>
                    {
                        (
                            index,
                            view.external.as_ref().is_some_and(|original| {
                                original.task == task
                                    && original.closed.is_some()
                                    && original.cleanup
                                        == maka_plugin_core::operation::OperationCleanup::Confirmed
                            }),
                        )
                    }
                    _ => {
                        return Err(RunError::Internal(
                            "external source acknowledged another task's fact".into(),
                        ));
                    }
                };
                if done {
                    live.work.remove(&WorkKey::External);
                } else {
                    read(work, task, next, connection);
                }
            }
            _ => unreachable!("external completion dispatch"),
        }
        Ok(())
    }
}
