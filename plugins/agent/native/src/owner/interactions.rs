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

use super::{Owner, StoredSessionConfiguration, now};
use crate::contract::*;
use maka_agent_facts::interaction::InteractionAnswer;
use maka_agent_facts::interaction::InteractionRecord;
use maka_agent_facts::interaction::InteractionRequest;

impl Owner {
    pub async fn pending_interactions(
        &self,
        session_id: &str,
    ) -> Result<PendingInteractions, String> {
        self.session(session_id).await?;
        let observed = self
            .store
            .session(session_id)
            .await
            .map_err(|error| error.to_string())?
            .session_projection::<StoredSessionConfiguration>(session_id)
            .await
            .map_err(|_| "agent_interactions_unavailable")?
            .ok_or("agent_session_unavailable")?;
        Ok(PendingInteractions {
            revision: observed.session.revision,
            entries: observed
                .pending_interactions
                .into_iter()
                .map(|record| InteractionSummary {
                    request_id: record.request_id,
                    tool_use_id: match &record.request {
                        InteractionRequest::Permissions { tool_use_id, .. } => tool_use_id.clone(),
                        InteractionRequest::ServiceApproval { tool_use_id, .. }
                        | InteractionRequest::Question { tool_use_id, .. }
                        | InteractionRequest::Form { tool_use_id, .. }
                        | InteractionRequest::ClientCapability { tool_use_id, .. }
                        | InteractionRequest::ComputerApp { tool_use_id, .. } => {
                            Some(tool_use_id.clone())
                        }
                    },
                    kind: match record.request {
                        InteractionRequest::ServiceApproval { .. } => {
                            InteractionKind::ServiceApproval
                        }
                        InteractionRequest::Question { .. } => InteractionKind::Question,
                        InteractionRequest::Permissions { .. } => InteractionKind::Permissions,
                        InteractionRequest::Form { .. } => InteractionKind::Form,
                        InteractionRequest::ClientCapability { .. } => {
                            InteractionKind::ClientCapability
                        }
                        InteractionRequest::ComputerApp { .. } => InteractionKind::ComputerApp,
                    },
                })
                .collect(),
        })
    }
    pub async fn interaction(
        &self,
        session_id: &str,
        request_id: &str,
    ) -> Result<InteractionRecord, String> {
        self.session(session_id).await?;
        self.store
            .session(session_id)
            .await
            .map_err(|error| error.to_string())?
            .interaction(request_id)
            .await
            .map_err(|_| "agent_interactions_unavailable")?
            .filter(|record| record.session_id == session_id)
            .ok_or_else(|| "agent_interaction_unavailable".into())
    }
    pub async fn respond(&self, input: InteractionRespond) -> Result<InteractionResult, String> {
        let runs = self.runs.lock().await;
        let reject = |reason| Ok(InteractionResult::Rejected { reason });
        if runs.closing {
            return reject(InteractionRejection::Closed);
        }
        if !self.owns(&input.session_id) {
            return reject(InteractionRejection::Unavailable);
        }
        let session = self.session(&input.session_id).await?;
        if session.archived {
            return reject(InteractionRejection::Unavailable);
        }
        let Some(record) = self
            .store
            .session(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
            .interaction(&input.request_id)
            .await
            .map_err(|_| "agent_interactions_unavailable")?
            .filter(|record| record.session_id == input.session_id)
        else {
            return reject(InteractionRejection::Unavailable);
        };
        // Each supported producer owns its policy; the store commits only the
        // original bounded answer and current permission boundary.
        let computer = match &record.request {
            InteractionRequest::ClientCapability {
                target,
                basis: Some(_),
                ..
            } => {
                target == &maka_workspace_api::computer::target()
                    || target == &maka_workspace_api::computer::audio_target()
                    || maka_workspace_api::computer::is_browser_target(target)
            }
            InteractionRequest::ComputerApp { target, .. } => {
                let mut expected = maka_workspace_api::computer::target();
                expected.scope = target.scope.clone();
                target == &expected
            }
            _ => false,
        };
        if !computer
            && !matches!(
                record.request,
                InteractionRequest::Question { .. }
                    | InteractionRequest::ServiceApproval { .. }
                    | InteractionRequest::Permissions { .. }
                    | InteractionRequest::Form { .. }
            )
        {
            return reject(InteractionRejection::Unsupported);
        }
        if !matches!(
            input.answer,
            InteractionAnswer::Question { .. }
                | InteractionAnswer::ServiceApproval { .. }
                | InteractionAnswer::Permissions { .. }
                | InteractionAnswer::Form { .. }
                | InteractionAnswer::ClientCapability { .. }
                | InteractionAnswer::ComputerApp { .. }
                | InteractionAnswer::ComputerAppCancel {}
        ) || input.answer.validate_for_request(&record.request).is_err()
        {
            return reject(InteractionRejection::InvalidAnswer);
        }
        if record.outcome.is_some() {
            return Ok(InteractionResult::Recorded {
                record: Box::new(record),
            });
        }
        let committed = self
            .store
            .session(&record.session_id)
            .await
            .map_err(|error| error.to_string())?
            .commit_interaction_outcome(&record.request_id, input.answer.into_outcome(now()))
            .await
            .map_err(|_| "agent_interaction_commit_unavailable")?;
        Ok(InteractionResult::Recorded {
            record: Box::new(committed.record),
        })
    }
}
