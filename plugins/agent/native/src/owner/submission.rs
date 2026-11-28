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

use super::{
    send::{PreparedAgentSend, PreparedSend},
    *,
};
use maka_agent_state::queue::SubmissionKey;
use maka_capabilities::call::Scope;
use maka_event_log::{
    StoreError,
    writeback::{Notification, Prepared, Statement},
};
use maka_plugin_core::operation::RecoveryRef;

fn submission_key(session: String, key: String) -> SubmissionKey {
    SubmissionKey {
        session,
        digest: Sha256::digest(key.as_bytes()).into(),
    }
}

impl Owner {
    async fn require_submission_session(&self, scope: &Scope, session: &str) -> Result<(), String> {
        use maka_capabilities::call::Identity;
        if !matches!(scope.identity, Identity::Native | Identity::Remote { .. }) {
            return Err("agent_submission_user_action_required".into());
        }
        self.require_session(session).await?;
        self.require_execution(session).await
    }

    pub(crate) async fn lookup_submission(
        &self,
        input: LookupSubmission,
        scope: &Scope,
    ) -> Result<Option<String>, String> {
        self.require_submission_session(scope, &input.session_id)
            .await?;
        self.message_writer(scope)?
            .query(submission_key(input.session_id, input.idempotency_key))
            .await
            .map_err(|e| e.to_string())
    }

    pub(crate) async fn withdraw_submission(
        &self,
        input: WithdrawSubmission,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<NativeMutation<WithdrawalResult>, String> {
        self.require_submission_session(scope, &input.session_id)
            .await?;
        let at =
            maka_agent_facts::durable::UnixMillis(now().try_into().map_err(|_| "invalid clock")?);
        let statement = maka_agent_state::queue::WithdrawMessage {
            session: input.session_id,
            message: input.message_id,
            command: self.control_id(operation, "withdraw_submission"),
            at,
        };
        let change = self
            .message_writer(scope)?
            .prepare_result(|_| Ok(statement))
            .map_err(|e| e.to_string())?;
        Ok(NativeMutation::Computed { change })
    }

    pub(crate) async fn submit_message(
        self: &Arc<Self>,
        input: SubmitMessage,
        operation: &RecoveryRef,
        scope: &Scope,
    ) -> Result<NativeMutation<MessageSubmissionResult>, String> {
        self.require_submission_session(scope, &input.session_id)
            .await?;
        let key = input
            .idempotency_key
            .map(|key| submission_key(input.session_id.clone(), key));
        let writer = self.message_writer(scope)?;
        let current = || async {
            match &key {
                Some(key) => writer.query(key.clone()).await.map_err(|e| e.to_string()),
                None => Ok(None),
            }
        };
        if let Some(message_id) = current().await? {
            return Ok(NativeMutation::Returned(
                MessageSubmissionResult::Duplicate { message_id },
            ));
        }
        let attempt = self.send_key(operation, &input.session_id);
        let prepare = async {
            let send = Send {
                session_id: input.session_id,
                message: input.message,
                backend: input.backend,
                delivery: Some(SendDelivery::Queue),
                attachments: input.attachments,
                quotes: vec![],
                mentions: vec![],
                on_complete: None,
                expected_run_id: None,
                reply_to: None,
            };
            match self
                .prepare_user_send(send, &attempt, operation, scope)
                .await?
            {
                PreparedSend::Ready {
                    statement,
                    value: SendResult::Queued { message_id, .. },
                    dossier_reply,
                } => Ok((statement, message_id, dossier_reply)),
                PreparedSend::Ready { .. } => Err("agent_input_not_queued".to_owned()),
                PreparedSend::Returned(SendResult::Rejected { reason, .. }) => Err(format!(
                    "agent input rejected: {}",
                    serde_json::to_value(reason).map_err(|e| e.to_string())?
                )),
                PreparedSend::Returned(_) => Err("agent_input_not_admitted".to_owned()),
            }
        }
        .await;
        let (statement, message_id, dossier_reply) = match prepare {
            Ok(statement) => statement,
            Err(error) => {
                // A concurrent winner may have started the run during preparation.
                return match current().await? {
                    Some(message_id) => Ok(NativeMutation::Returned(
                        MessageSubmissionResult::Duplicate { message_id },
                    )),
                    None => Err(error),
                };
            }
        };
        let observed = if dossier_reply {
            self.discovery
                .thread_topic(statement.queue.session.clone())
                .await
                .map_err(|error| error.to_string())?
                .map(|topic| self.discovery_outcome_signal(topic, "replied in the dossier thread"))
        } else {
            None
        };
        let change = writer
            .prepare_result(|_| {
                Ok(Submit {
                    key,
                    message_id,
                    statement: *statement,
                    observed,
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(NativeMutation::Computed { change })
    }
}

struct Submit {
    key: Option<SubmissionKey>,
    message_id: String,
    statement: PreparedAgentSend,
    observed: Option<tokio::sync::oneshot::Sender<()>>,
}

#[derive(serde::Serialize)]
#[serde(transparent)]
struct Submitted {
    result: MessageSubmissionResult,
    #[serde(skip)]
    observed: Option<tokio::sync::oneshot::Sender<()>>,
}
impl Statement for Submit {
    type Value = Submitted;
    type Output = MessageSubmissionResult;

    fn retain(&self) -> Vec<Arc<dyn std::marker::Send + Sync>> {
        self.statement.retain()
    }
    fn execute(mut self, c: &rusqlite::Connection) -> Result<Prepared<Self::Value>, StoreError> {
        if let Some(key) = &self.key
            && let Some(message_id) = key.current(c)?
        {
            return Ok(Prepared {
                value: Submitted {
                    result: MessageSubmissionResult::Duplicate { message_id },
                    observed: None,
                },
                changed: false,
                notification: Notification::NONE,
            });
        }
        self.statement.queue.use_current_revision(c)?;
        let accepted = self.statement.execute(c)?;
        if let Some(key) = self.key {
            key.record(c, &self.message_id)?;
        }
        Ok(Prepared {
            value: Submitted {
                result: MessageSubmissionResult::Queued {
                    message_id: self.message_id,
                },
                observed: self.observed,
            },
            changed: accepted.changed,
            notification: accepted.notification,
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        if let Some(signal) = value.observed {
            let _ = signal.send(());
        }
        value.result
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        PreparedAgentSend::isolated_rejection(error)
    }
}
