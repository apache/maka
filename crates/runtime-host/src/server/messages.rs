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

use super::{Host, HostError};
use maka_event_log::{StoreError, message_resolution::MessageResolution};
use maka_protocol::{Operation, OperationError, OperationErrorCode as Code, Outcome, message::*};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) mod capacity;
mod mutations;
pub(crate) mod projection;
mod update;

pub(super) use maka_protocol::message::{ERRORS, supports};
pub(super) async fn execute(
    host: &Host,
    connection_id: uuid::Uuid,
    principal: maka_config::plugin_authorization::Principal,
    operation: Operation,
    value: &Value,
) -> Result<Outcome, HostError> {
    let input = decode_input(operation, value)?;
    let result = match input {
        Input::Interrupt(input) => host
            .executions
            .interrupt(input, &host.epoch)
            .await
            .map(|result| Output::Interrupt(Box::new(result))),
        Input::Submit(input) => host
            .executions
            .submit(
                *input,
                connection_id,
                host.root_id(),
                &host.epoch,
                &principal,
            )
            .await
            .map(Output::Submit),
        Input::ExecutionQuery(input) => host
            .executions
            .query_message_executions(input)
            .await
            .map(|resolutions| Output::Executions(ExecutionQueryResult { resolutions })),
        Input::Query(input) => host
            .log
            .message_resolutions(&input.session_id, &input.message_ids)
            .await
            .map(query_result)
            .map_err(|error| storage_error(host, error)),
        input => mutations::execute(host, connection_id, operation, input).await,
    };
    Ok(match result {
        Ok(output) => {
            let value = serde_json::to_value(output)?;
            decode_output(operation, &value)?;
            Outcome::success(value)
        }
        Err(error) => Outcome::failure(error),
    })
}
fn query_result(resolutions: Vec<MessageResolution>) -> Output {
    Output::Query(QueryResult {
        cancelled_message_ids: resolutions
            .into_iter()
            .filter_map(|r| {
                if let MessageResolution::Cancelled { message_id } = r {
                    Some(message_id)
                } else {
                    None
                }
            })
            .collect(),
    })
}
pub(super) fn storage_error(host: &Host, error: StoreError) -> OperationError {
    host.executions.message_storage_error(error)
}
fn failure(code: Code, message: &str) -> OperationError {
    OperationError {
        code,
        message: message.chars().take(1024).collect(),
    }
}

fn fingerprint(input: &Input) -> Result<String, OperationError> {
    Ok(format!(
        "sha256:{:x}",
        Sha256::digest(
            serde_json::to_vec(input)
                .map_err(|e| failure(Code::InternalFailure, &e.to_string()))?
        )
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_event_log::{
        message_admissions::PendingMessageAdmission,
        root::{RootNamespaces, RootOwner},
    };
    use maka_runtime::{
        event::Invocation,
        input::DeliveredMessage,
        message::{MessageDisposition, RootSourceMessage},
    };

    #[tokio::test]
    async fn non_admission_query_waits_for_the_shared_writer_and_observes_its_commit() {
        let directory = tempfile::tempdir().unwrap();
        let namespaces = RootNamespaces {
            ownership: directory.path().join("owners"),
            control: directory.path().join("control"),
        };
        let host =
            Host::open(RootOwner::create(&directory.path().join("root"), &namespaces).unwrap())
                .await
                .unwrap();
        let cwd = directory
            .path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let configuration = crate::session::PreparedSession::new(serde_json::from_value(serde_json::json!({
            "sessionId":"session", "workspace":{"kind":"host_path","path":cwd}, "executorId":"fixture"
        })).unwrap()).unwrap().bind(
            maka_protocol::session::WorkspaceProjection {
                target: maka_protocol::session::WorkspaceTarget::HostPath { path: cwd.clone() },
                host_cwd: cwd,
            },
            crate::session::SessionTarget::Executor { executor_id: "fixture".to_owned().try_into().unwrap(), settings: Default::default() },
            maka_protocol::session::SandboxMode::ReadOnly,
        );
        host.log
            .create_session("session", "create", &configuration, 1)
            .await
            .unwrap();
        let query = QueryInput {
            session_id: "session".into(),
            message_ids: vec!["message".into(), "absent".into()],
        };
        let gate = host.executions.lock_admission().await;
        let mut reader = Box::pin(host.executions.query_message_executions(query));
        assert!(futures_util::poll!(&mut reader).is_pending());
        let content: maka_runtime::input::MessageInput = "queued input".into();
        host.log
            .admit_message(PendingMessageAdmission {
                invocation: Invocation {
                    session_id: "session".into(),
                    turn_id: "turn".into(),
                    run_id: "run".into(),
                    invocation_id: "invocation".into(),
                },
                steering_invocation: None,
                source: RootSourceMessage {
                    unprepared_content: content.clone(),
                    message: DeliveredMessage {
                        message_id: "message".into(),
                        submitted_content_digest: content.content_digest().unwrap(),
                        content,
                    },
                    submitted_placement: Placement::NextTurn,
                    disposition: MessageDisposition::TurnStarted,
                    submitted_intent: None,
                },
                required_tools: Default::default(),
                admitted_at: 2,
            })
            .await
            .unwrap();
        drop(gate);
        assert_eq!(
            reader.await.unwrap(),
            vec![
                ExecutionResolution::Pending {
                    message_id: "message".into()
                },
                ExecutionResolution::NotAdmitted {
                    message_id: "absent".into()
                },
            ]
        );
        host.draining.cancel();
        host.plugin_tasks.close();
        host.plugin_tasks.wait().await;
        host.executions.shutdown().await;
        host.shells.shutdown().await;
        host.log.shutdown().await.unwrap();
        host.configuration.shutdown().await.unwrap();
    }
}
