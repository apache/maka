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

use super::{Result, failure, item, stored};
use crate::{server::Host, session::SessionConfiguration};
use maka_event_log::sessions::{AbandonRevision, SessionCopyResult};
use maka_protocol::{OperationErrorCode as Code, session::copy::*};

pub(super) async fn create(host: &Host, input: Input) -> Result<Output> {
    let mut observed = None;
    loop {
        let admission = host.executions.lock_admission().await;
        ready(host)?;
        crate::session::require_unmanaged(
            &host.log,
            &input.target_session_id,
            Code::OperationConflict,
        )
        .await?;
        // The exact receipt precedes any source read: a lost reply must remain
        // recoverable after source edits, removal or workspace unavailability.
        if let Some(receipt) = host
            .log
            .session_copy_receipt(&input.target_session_id)
            .await
            .map_err(stored)?
        {
            if receipt.request != input {
                return Err(failure(
                    Code::OperationConflict,
                    "Session copy request changed",
                ));
            }
            let target = host
                .log
                .get_session::<SessionConfiguration>(&input.target_session_id)
                .await
                .map_err(stored)?
                .ok_or_else(|| failure(Code::NotFound, "Copied Session was removed"))?;
            return finish(host, input, &target.configuration).await;
        }
        crate::session::require_unmanaged(
            &host.log,
            &input.source_session_id,
            Code::OperationConflict,
        )
        .await?;
        let source = host
            .log
            .get_session::<SessionConfiguration>(&input.source_session_id)
            .await
            .map_err(stored)?
            .ok_or_else(|| failure(Code::NotFound, "Source Session does not exist"))?;
        if source.revision != input.expected_source_revision {
            return Ok(Output::SourceRevisionConflict {
                expected_revision: input.expected_source_revision,
                actual_revision: source.revision,
            });
        }
        if source.archived && matches!(input.purpose, Purpose::Revision { .. }) {
            return Err(failure(
                Code::OperationConflict,
                "An archived Session cannot create an active revision",
            ));
        }
        if source.configuration.worktree.is_some() {
            return Err(failure(
                Code::OperationConflict,
                "A linked execution workspace requires its owner's lifecycle",
            ));
        }
        // Destination scope may select a different registration for this ID.
        // Only Host history is copied; provider-owned conversation state is not.
        if let crate::session::SessionTarget::Executor { executor_id, .. } =
            &source.configuration.target
            && !host
                .executions
                .executor_binding(&input.target_session_id, executor_id)?
                .capabilities()
                .history_copy
        {
            return Err(failure(
                Code::OperationConflict,
                "This executor cannot copy its conversation; create a new Session instead",
            ));
        }
        let Some((project, workspace)) = observed.take() else {
            let project = match &source.configuration.workspace.target {
                maka_protocol::session::WorkspaceTarget::Project { project_id } => Some(
                    host.log
                        .get_project(project_id)
                        .await
                        .map_err(stored)?
                        .ok_or_else(|| failure(Code::NotFound, "Source Project does not exist"))?,
                ),
                _ => None,
            };
            drop(admission);
            let workspace =
                super::workspace::resolve(host, &source.configuration.workspace.target).await?;
            observed = Some((project, workspace));
            continue;
        };
        if let Some(project) = project
            && host
                .log
                .get_project(&project.id)
                .await
                .map_err(stored)?
                .as_ref()
                != Some(&project)
        {
            return Err(failure(
                Code::OperationConflict,
                "Source Project changed during copy",
            ));
        }
        if workspace != source.configuration.workspace {
            return Err(failure(
                Code::OperationConflict,
                "Source workspace changed during copy",
            ));
        }
        let mut configuration = source.configuration;
        configuration.boundary_revision = 0;
        return finish(host, input, &configuration).await;
    }
}

async fn finish(host: &Host, input: Input, configuration: &SessionConfiguration) -> Result<Output> {
    host.executions.validate_workspace(configuration)?;
    let result = host
        .log
        .copy_session(
            input.clone(),
            configuration,
            super::super::configuration::now().map_err(super::super::configuration::failure)?,
        )
        .await
        .map_err(|error| match error {
            maka_event_log::StoreError::InvalidTransition(message) => {
                failure(Code::OperationConflict, &message)
            }
            error => stored(error),
        })?;
    Ok(match result {
        SessionCopyResult::Committed(record) => {
            host.executions
                .publish_session_change(&input.target_session_id)
                .await;
            host.executions
                .publish_session_change(&input.source_session_id)
                .await;
            Output::Committed {
                session: Box::new(item(*record)),
            }
        }
        SessionCopyResult::SourceRevisionConflict { expected, actual } => {
            Output::SourceRevisionConflict {
                expected_revision: expected,
                actual_revision: actual,
            }
        }
    })
}

pub(super) async fn abandon(host: &Host, input: AbandonInput) -> Result<AbandonOutput> {
    let _admission = host.executions.lock_admission().await;
    ready(host)?;
    crate::session::require_unmanaged(&host.log, &input.target_session_id, Code::OperationConflict)
        .await?;
    let receipt = host
        .log
        .session_copy_receipt(&input.target_session_id)
        .await
        .map_err(stored)?
        .ok_or_else(|| failure(Code::NotFound, "Session revision does not exist"))?;
    if !matches!(receipt.request.purpose, Purpose::Revision { .. }) {
        return Err(failure(
            Code::OperationConflict,
            "Session is not a revision",
        ));
    }
    Ok(
        match host
            .log
            .abandon_revision(&input.target_session_id)
            .await
            .map_err(stored)?
        {
            AbandonRevision::Abandoned => {
                host.executions.request_removal_recovery();
                host.executions
                    .publish_session_change(&input.target_session_id)
                    .await;
                AbandonOutput::Abandoned {
                    session_id: input.target_session_id,
                }
            }
            AbandonRevision::Retained => AbandonOutput::Retained {
                session_id: input.target_session_id,
            },
        },
    )
}

fn ready(host: &Host) -> Result<()> {
    if !host.executions.accepting() {
        Err(failure(Code::HostDraining, "Host is draining"))
    } else {
        Ok(())
    }
}
