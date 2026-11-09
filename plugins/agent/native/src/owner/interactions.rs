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

mod delegation;

use super::send::NativeMutation;
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
        let mut observed = self
            .durable
            .interactions()
            .pending(session_id)
            .await
            .map_err(|error| error.to_string())?;
        let mut cursor = observed.next.take();
        while let Some(after) = cursor {
            let page = self
                .durable
                .interactions()
                .pending_page(session_id, Some(after), 256)
                .await
                .map_err(|error| error.to_string())?;
            if page.revision != observed.revision {
                return Err("agent_interactions_changed".into());
            }
            cursor = page.next;
            observed.records.extend(page.records);
        }
        Ok(PendingInteractions {
            revision: observed.revision,
            entries: observed
                .records
                .into_iter()
                .map(|record| InteractionSummary {
                    request_id: record.request_id,
                    tool_use_id: match &record.request {
                        InteractionRequest::Permissions { tool_use_id, .. } => tool_use_id.clone(),
                        InteractionRequest::ServiceApproval { tool_use_id, .. }
                        | InteractionRequest::Question { tool_use_id, .. }
                        | InteractionRequest::Form { tool_use_id, .. }
                        | InteractionRequest::ClientCapability { tool_use_id, .. }
                        | InteractionRequest::ComputerApp { tool_use_id, .. }
                        | InteractionRequest::SystemPermission { tool_use_id, .. }
                        | InteractionRequest::SessionApproval { tool_use_id, .. } => {
                            Some(tool_use_id.clone())
                        }
                    },
                    kind: match record.request {
                        InteractionRequest::ServiceApproval { .. } => {
                            InteractionKind::ServiceApproval
                        }
                        InteractionRequest::SessionApproval { .. } => {
                            InteractionKind::SessionApproval
                        }
                        InteractionRequest::Question { .. } => InteractionKind::Question,
                        InteractionRequest::Permissions { .. } => InteractionKind::Permissions,
                        InteractionRequest::Form { .. } => InteractionKind::Form,
                        InteractionRequest::ClientCapability { .. } => {
                            InteractionKind::ClientCapability
                        }
                        InteractionRequest::ComputerApp { .. } => InteractionKind::ComputerApp,
                        InteractionRequest::SystemPermission { .. } => {
                            InteractionKind::SystemPermission
                        }
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
        self.find_interaction(session_id, request_id)
            .await?
            .ok_or_else(|| "agent_interaction_unavailable".into())
    }

    async fn find_interaction(
        &self,
        session_id: &str,
        request_id: &str,
    ) -> Result<Option<InteractionRecord>, String> {
        self.durable
            .interactions()
            .read(session_id, request_id)
            .await
            .map_err(|error| error.to_string())
    }
    async fn prepare_response(
        &self,
        input: InteractionRespond,
    ) -> Result<NativeMutation<InteractionResult>, String> {
        let runs = std::sync::Arc::new(self.runs.lock().await);
        let reject = |reason| {
            Ok(NativeMutation::Returned(InteractionResult::Rejected {
                reason,
            }))
        };
        if runs.closing {
            return reject(InteractionRejection::Closed);
        }
        self.prepare_response_locked(input, runs, None).await
    }

    async fn prepare_response_locked(
        &self,
        input: InteractionRespond,
        guard: std::sync::Arc<super::runs::Exclusive>,
        caller: Option<maka_agent_state::CallerFence>,
    ) -> Result<NativeMutation<InteractionResult>, String> {
        let reject = |reason| {
            Ok(NativeMutation::Returned(InteractionResult::Rejected {
                reason,
            }))
        };
        if !self.owns(&input.session_id) {
            return reject(InteractionRejection::Unavailable);
        }
        let Some(session) = self
            .store
            .get_session::<StoredSessionConfiguration>(&input.session_id)
            .await
            .map_err(|error| error.to_string())?
        else {
            return reject(InteractionRejection::Unavailable);
        };
        if session.archived {
            return reject(InteractionRejection::Unavailable);
        }
        let Some(record) = self
            .find_interaction(&input.session_id, &input.request_id)
            .await?
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
                    || maka_workspace_api::computer::is_browser_download_target(target)
                    || maka_workspace_api::computer::is_browser_history_target(target)
                    || maka_workspace_api::computer::is_browser_upload_target(target)
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
                    | InteractionRequest::SystemPermission { .. }
                    | InteractionRequest::SessionApproval { .. }
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
                | InteractionAnswer::SystemPermissionCancel {}
                | InteractionAnswer::SessionApproval { .. }
        ) || input.answer.validate_for_request(&record.request).is_err()
        {
            return reject(InteractionRejection::InvalidAnswer);
        }
        if record.outcome.is_some() {
            return Ok(NativeMutation::Returned(InteractionResult::Recorded {
                record: Box::new(record),
            }));
        }
        let change = self
            .durable
            .interactions()
            .prepare_outcome(
                &record.execution.session_id,
                &record.request_id,
                input.answer.into_outcome(now()),
                caller,
                guard,
                |settlement| {
                    use maka_agent_state::interactions::AnswerSettlement;
                    let result = match settlement {
                        AnswerSettlement::Recorded(record) => InteractionResult::Recorded {
                            record: Box::new(record),
                        },
                        AnswerSettlement::Unavailable => InteractionResult::Rejected {
                            reason: InteractionRejection::Unavailable,
                        },
                        AnswerSettlement::AuthorizationChanged => InteractionResult::Rejected {
                            reason: InteractionRejection::AuthorizationChanged,
                        },
                    };
                    serde_json::to_value(result).map_err(maka_event_log::StoreError::from)
                },
            )
            .map_err(|error| error.to_string())?;
        Ok(NativeMutation::Computed { change })
    }
}
