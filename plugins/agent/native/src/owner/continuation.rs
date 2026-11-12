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

//! Prepare one new continuation admission without starting its driver or model.
use super::*;
use maka_agent_engine::cleanup::Evidence;
use maka_agent_facts::{
    continuation::ContinuationClaim,
    durable::{RunId, RunOrigin, UnixMillis},
    input::RunInput,
};
use maka_agent_state::{Admission, fold::RunView};
use maka_capabilities::call::Scope;
use maka_plugin_core::operation::RecoveryRef;

#[expect(
    clippy::large_enum_variant,
    reason = "Continuation preparation consumes one readiness snapshot at a time"
)]
enum ContinuationReadiness {
    Ready {
        source: RunView,
        session: SessionRecord<ResolvedConfiguration>,
    },
    Rejected(ContinuationRejection),
}
impl Owner {
    pub async fn continuation_availability(
        &self,
        input: ExecutionRead,
        parent: &Scope,
    ) -> Result<ContinuationAvailability, String> {
        let Some(source) = self.session_run(&input.session_id, input.run_id).await? else {
            return Ok(ContinuationAvailability::Rejected {
                reason: ContinuationRejection::SourceMissing,
            });
        };
        Ok(match self.continuation_readiness(source, parent).await? {
            ContinuationReadiness::Ready { source, .. } => ContinuationAvailability::Ready {
                source: super::execution::project(&source),
            },
            ContinuationReadiness::Rejected(reason) => {
                ContinuationAvailability::Rejected { reason }
            }
        })
    }
    async fn continuation_readiness(
        &self,
        source: RunView,
        parent: &Scope,
    ) -> Result<ContinuationReadiness, String> {
        if source.spec.owner != self.run_owner() || !self.owns(&source.spec.session_id) {
            return Ok(ContinuationReadiness::Rejected(
                ContinuationRejection::SourceMissing,
            ));
        }
        let session_id = source.spec.session_id.clone();
        if self.runs.state().await.closing
            || self.stop.is_cancelled()
            || parent.cancellation.is_cancelled()
        {
            return Ok(ContinuationReadiness::Rejected(
                ContinuationRejection::Closed,
            ));
        }
        let Some(actual) = self.session_run(&session_id, source.run).await? else {
            return Ok(ContinuationReadiness::Rejected(
                ContinuationRejection::SourceMissing,
            ));
        };
        if actual.revision != source.revision || actual.spec.turn_id != source.spec.turn_id {
            return Ok(ContinuationReadiness::Rejected(
                ContinuationRejection::SourceChanged,
            ));
        }
        if actual.terminal.is_none() {
            return Ok(ContinuationReadiness::Rejected(
                ContinuationRejection::SourceNotTerminal,
            ));
        }
        if actual.spec.origin != RunOrigin::Local || actual.blocks_followup() {
            return Ok(ContinuationReadiness::Rejected(
                ContinuationRejection::SafetyCheckFailed,
            ));
        }
        let session = self.scoped_session(parent, &session_id).await?;
        if session.archived {
            return Ok(ContinuationReadiness::Rejected(
                ContinuationRejection::Archived,
            ));
        }
        if actual.spec.workspace != session.configuration.workspace.path
            || actual.spec.permission_basis.binding.id
                != session.configuration.permission_basis().binding.id
            || workspace::validate(
                &self.workspace_roots,
                &session.configuration.workspace,
                &self.managed_worktrees,
            )
            .await
            .is_err()
        {
            return Ok(ContinuationReadiness::Rejected(
                ContinuationRejection::WorkspaceChanged,
            ));
        }
        let history = self
            .durable
            .session_history(self.run_owner(), session_id.clone());
        if history
            .successor(actual.run)
            .await
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Ok(ContinuationReadiness::Rejected(
                ContinuationRejection::AlreadyContinued,
            ));
        }
        let busy = self.runs.state().await.busy(&session_id);
        if busy
            || !self
                .durable
                .queue()
                .read(session_id.clone())
                .await
                .map_err(|error| error.to_string())?
                .entries
                .is_empty()
        {
            return Ok(ContinuationReadiness::Rejected(ContinuationRejection::Busy));
        }
        if let Some(latest) = self
            .durable
            .latest_run(session_id.clone())
            .await
            .map_err(|error| error.to_string())?
        {
            let latest = self
                .durable
                .frontier(latest)
                .await
                .map_err(|error| error.to_string())?;
            if latest.terminal.is_none() {
                return Ok(ContinuationReadiness::Rejected(ContinuationRejection::Busy));
            }
        }
        Ok(ContinuationReadiness::Ready {
            source: actual,
            session,
        })
    }
    pub(super) async fn admit_continuation(
        self: &Arc<Self>,
        source: RunView,
        model: ModelSelection,
        thinking: Option<ThinkingLevel>,
        operation: &RecoveryRef,
        parent: &Scope,
    ) -> Result<NativeMutation<ContinuationResult>, String> {
        let rejected = |reason| {
            Ok(NativeMutation::Returned(ContinuationResult::Rejected {
                reason,
            }))
        };
        let session_id = source.spec.session_id.clone();
        let _ordered = self.runs.session(&session_id).await;
        let (actual, session) = match self.continuation_readiness(source, parent).await? {
            ContinuationReadiness::Ready { source, session } => (source, session),
            ContinuationReadiness::Rejected(reason) => return rejected(reason),
        };
        let target = ExecutionIdentity {
            session_id: session_id.clone(),
            turn_id: format!("t_{}", self.operation_id(operation)),
            run_id: RunId::new(),
        };
        let preference = BackendPreference::Model {
            connection_id: model.connection_id,
            model_id: model.model_id,
            thinking_level: thinking,
        };
        let basis = self
            .capture_current_run(
                &session_id,
                Some(preference),
                operation.fingerprint.clone(),
                parent,
            )
            .await?;
        if basis.workspace != session.configuration.workspace
            || basis.binding != session.configuration.binding
        {
            return rejected(ContinuationRejection::WorkspaceChanged);
        }
        let accepted = basis
            .model
            .as_ref()
            .ok_or("agent_continuation_requires_model")?;
        let cancellation = parent.cancellation.child_token();
        let lease = self
            .auxiliary_lease(parent, &session_id)
            .await
            .map_err(|error| maka_agent_facts::tools::ToolError::from(error).to_string())?;
        let mut original_model = None;
        let prepared = async {
            let log = lease.store();
            let custody = log.work_custody()?;
            let writer = self
                .store
                .data_writer_for_work(custody.as_ref(), &session_id)?;
            let state = self.durable.with_data_writer(writer)?;
            let source = crate::model::Source::restore(
                self.configuration.clone(),
                self.credentials.clone(),
                accepted.clone(),
                session_id.clone(),
                self.revision.clone(),
            )?;
            let source = match &self.pricing {
                Some(pricing) => source.with_pricing(Arc::clone(pricing)),
                None => source,
            };
            let (preview, _) = tokio::sync::watch::channel(None);
            original_model = Some(driver_model::DriverModel {
                state,
                log: Arc::new(log),
                source: Arc::new(source),
                executor: self.credentials.executor.clone(),
                resources: self.services.model_preparation_resources(),
                execution: target.clone(),
                cancellation,
                cleanup: Evidence::default(),
                workers: TaskTracker::new(),
                original_cleanup: Default::default(),
                conversation: Default::default(),
                preview,
            });
            original_model
                .as_ref()
                .expect("original preparation model")
                .prepare_continuation(actual.run, basis.behavior.clone())
                .await
        }
        .await;
        let cleanup = match &original_model {
            Some(model) => model.finish().await,
            None => Ok(()),
        };
        if cleanup.is_err()
            || prepared
                .as_ref()
                .is_err_and(RunError::is_cleanup_unconfirmed)
        {
            let reason = match (&prepared, &cleanup) {
                (Err(error), _) if error.is_cleanup_unconfirmed() => error.to_string(),
                (_, Err(error)) => error.to_string(),
                _ => unreachable!("unknown cleanup has its original evidence"),
            };
            self.retain_original_preparation(session_id.clone(), lease, original_model)
                .await;
            return Err(reason);
        }
        // This read-only fork does not own or seal its parent's effect group.
        // Its model/arena work must close before dropping capabilities and releasing pins.
        drop(original_model);
        lease.finish();
        let prepared = prepared.map_err(|error| error.to_string())?;
        if prepared.source.high_water != actual.revision
            || prepared.source.execution.run_id != actual.run
            || prepared.source.execution.session_id != session_id
            || prepared.source.execution.turn_id != actual.spec.turn_id
        {
            return rejected(ContinuationRejection::SourceChanged);
        }
        let claim = ContinuationClaim {
            id: self.operation_id(operation),
            source: prepared.source,
            base: prepared.base,
            replay: prepared.replay,
        };
        claim.validate(&target).map_err(|error| error.to_string())?;
        let (spec, contents) = self
            .freeze_operation_spec(
                &target,
                &basis,
                RunInput::Continuation {
                    claim: Box::new(claim),
                    request_fingerprint: operation.fingerprint.clone(),
                },
                parent,
            )
            .await?;
        if spec.workspace != actual.spec.workspace
            || spec.permission_basis != session.configuration.permission_basis()
        {
            return rejected(ContinuationRejection::WorkspaceChanged);
        }
        let admission = Admission::with_identity(
            target.run_id,
            spec,
            UnixMillis(now().try_into().map_err(|_| "agent_clock_invalid")?),
            contents,
        );
        let execution =
            super::execution::project(&admission.preview().map_err(|error| error.to_string())?);
        Ok(NativeMutation::Commit {
            value: ContinuationResult::Started { execution },
            change: self.durable.prepare_admission(admission),
        })
    }
}
