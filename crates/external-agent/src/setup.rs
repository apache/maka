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

use crate::{
    settings::Manager,
    transport::{Connection, Peer},
};
use agent_client_protocol::schema::{v1 as acp, v2};
use futures_util::future::BoxFuture;
use maka_plugins::{
    authorization, fiber, process,
    remote::{self, Error},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::sync::{Mutex, mpsc, oneshot};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

mod auth;

pub(crate) struct Provider {
    pub manager: Arc<Manager>,
    pub context: fiber::Context,
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Input {
    Check {
        agent_id: String,
        #[schemars(with = "String")]
        operation_id: Uuid,
    },
    Authenticate {
        agent_id: String,
        method_id: String,
        #[schemars(with = "String")]
        operation_id: Uuid,
    },
    InstallAntigravity {
        #[schemars(with = "String")]
        operation_id: Uuid,
    },
}
impl Input {
    fn operation_id(&self) -> Uuid {
        match self {
            Self::Check { operation_id, .. }
            | Self::Authenticate { operation_id, .. }
            | Self::InstallAntigravity { operation_id } => *operation_id,
        }
    }
}

impl remote::StreamProvider for Provider {
    fn open(
        &self,
        input: Value,
        caller: remote::Caller,
    ) -> BoxFuture<'static, Result<Box<dyn remote::Stream>, Error>> {
        let manager = self.manager.clone();
        let context = self.context.clone();
        Box::pin(async move {
            let input: Input =
                serde_json::from_value(input).map_err(|e| Error::Invalid(e.to_string()))?;
            if let Input::Authenticate { method_id, .. } = &input
                && (method_id.is_empty()
                    || method_id.len() > 1024
                    || method_id.chars().any(char::is_control))
            {
                return Err(Error::Invalid("Invalid authentication method".into()));
            }
            // Views captured this same request token; cancel also withdraws pending consent.
            let cancellation = caller.cancellation.clone();
            let worker_cancel = cancellation.clone();
            let (send, receive) = mpsc::channel(8);
            let done = context
                .spawn_resource("external agent setup", move |stopping| async move {
                    let result =
                        work(manager, input, caller, &send, &worker_cancel, &stopping).await;
                    let cleanup_failed = matches!(result, Err(Error::CleanupUnconfirmed));
                    if let Err(error) = result {
                        tokio::select! {
                            biased;
                            _ = worker_cancel.cancelled() => {},
                            _ = stopping.cancelled() => {},
                            _ = send.send(Err(error)) => {},
                        }
                    }
                    if cleanup_failed {
                        Err("external agent setup cleanup is unconfirmed".into())
                    } else {
                        Ok(())
                    }
                })
                .map_err(|_| Error::Retired)?;
            Ok(Box::new(SetupStream {
                receive: Mutex::new(receive),
                cancellation,
                done,
            }) as Box<dyn remote::Stream>)
        })
    }
}

struct SetupStream {
    receive: Mutex<mpsc::Receiver<Result<Value, Error>>>,
    cancellation: CancellationToken,
    done: oneshot::Receiver<Result<(), String>>,
}
impl remote::Stream for SetupStream {
    fn next(&self) -> BoxFuture<'_, Result<Option<Value>, Error>> {
        Box::pin(async move {
            tokio::select! {
                biased;
                _ = self.cancellation.cancelled() => Err(Error::Cancelled),
                item = async { self.receive.lock().await.recv().await } => item.transpose(),
            }
        })
    }
    fn cancel(&self) {
        self.cancellation.cancel();
    }
    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), Error>> {
        Box::pin(async move {
            self.cancellation.cancel();
            match tokio::time::timeout(Duration::from_secs(5), self.done).await {
                Ok(Ok(Ok(()))) => Ok(()),
                _ => Err(Error::CleanupUnconfirmed),
            }
        })
    }
}

async fn work(
    manager: Arc<Manager>,
    input: Input,
    caller: remote::Caller,
    send: &mpsc::Sender<Result<Value, Error>>,
    cancellation: &CancellationToken,
    stopping: &CancellationToken,
) -> Result<(), Error> {
    if cancellation.is_cancelled() || stopping.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let (title, agent) = match &input {
        Input::Check { agent_id, .. } => (
            "Check external agent",
            Some(manager.agent(agent_id).await.map_err(Error::Invalid)?),
        ),
        Input::Authenticate { agent_id, .. } => (
            "Authenticate external agent",
            Some(manager.agent(agent_id).await.map_err(Error::Invalid)?),
        ),
        Input::InstallAntigravity { .. } => ("Download and install Antigravity from Google", None),
    };
    let authorization = authorization::Request {
        operation_id: input.operation_id(),
        title: agent
            .as_ref()
            .map_or_else(|| title.into(), |agent| format!("{title}: {}", agent.id)),
        target: authorization::Target::PluginWorkspace {
            sandbox_mode: if agent.is_some() {
                maka_runtime::execution::SandboxMode::DangerFullAccess
            } else {
                maka_runtime::execution::SandboxMode::WorkspaceWrite
            },
        },
        capabilities: [if agent.is_some() {
            authorization::Capability::Processes
        } else {
            authorization::Capability::Network
        }]
        .into(),
    };
    let owned = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(Error::Cancelled),
        _ = stopping.cancelled() => {
            cancellation.cancel();
            return Err(Error::Cancelled);
        },
        result = caller.views.authorize(authorization) => result?,
    };
    let scope = owned.scope();
    if matches!(input, Input::InstallAntigravity { .. }) {
        let data = manager
            .data
            .as_ref()
            .ok_or_else(|| Error::Provider("Plugin private storage unavailable".into()));
        let result = match data {
            Ok(data) => {
                let install = crate::install::antigravity(&manager.host, data, scope, cancellation);
                tokio::pin!(install);
                tokio::select! {
                    biased;
                    _ = stopping.cancelled() => {
                        cancellation.cancel();
                        install.await
                    },
                    result = &mut install => result,
                }
                .map_err(|error| match error {
                    crate::install::Error::Cleanup => Error::CleanupUnconfirmed,
                    crate::install::Error::Cancelled => Error::Cancelled,
                    other => provider(other),
                })
            }
            Err(error) => Err(error),
        };
        owned
            .finish()
            .await
            .map_err(|_| Error::CleanupUnconfirmed)?;
        return emit(send, json!({"kind":"installed", "agent":result?})).await;
    }
    let mut process_owner = None;
    let result = tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(Error::Cancelled),
        _ = stopping.cancelled() => { cancellation.cancel(); Err(Error::Cancelled) },
        result = async {
            let mut command = agent.expect("process setup has an agent").command();
            command.lifetime = process::Lifetime::Invocation;
            let handle = manager.host.processes.spawn(scope.clone(), command.clone()).await.map_err(provider)?;
            let mut connection = Connection::new(manager.host.clone(), scope, command, handle, false);
            process_owner = Some(connection.owner.clone());
            run(&mut connection, input, send).await
        } => result,
    };
    // Both cleanup paths run, even when process close fails. The Owned scope
    // also settles an admitted spawn whose reply was lost during cancellation.
    let cleanup = tokio::time::timeout(Duration::from_secs(4), async {
        let close_process = async {
            match process_owner {
                Some(owner) => owner.close().await.map_err(|_| Error::CleanupUnconfirmed),
                None => Ok(()),
            }
        };
        let (process_result, scope_result) = tokio::join!(close_process, owned.finish());
        process_result.and(scope_result.map_err(|_| Error::CleanupUnconfirmed))
    })
    .await
    .map_err(|_| Error::CleanupUnconfirmed)?;
    cleanup?;
    result
}

async fn run(
    connection: &mut Connection,
    action: Input,
    send: &mpsc::Sender<Result<Value, Error>>,
) -> Result<(), Error> {
    let mut stderr = auth::Urls::default();
    auth::initialize(connection, send, &mut stderr).await?;
    match action {
        Input::Check { .. } => {
            let event = match connection.peer.as_ref().unwrap() {
                Peer::V1(_, initialized) => {
                    json!({"kind":"initialized", "agentInfo":initialized.agent_info, "authMethods": initialized.auth_methods})
                }
                Peer::V2(_, initialized) => {
                    // Host setup's method selector has a protocol-independent ID;
                    // authentication itself uses the negotiated typed SDK request.
                    let methods: Vec<_> = initialized.auth_methods.iter().map(|method| json!({
                        "id": method.method_id(), "name": method.name(), "description": method.description(),
                        "type": if matches!(method, v2::AuthMethod::Agent(_)) { "agent" } else { "unsupported" },
                    })).collect();
                    json!({"kind":"initialized", "agentInfo":initialized.info, "authMethods": methods})
                }
            };
            emit(send, event).await
        }
        Input::Authenticate { method_id, .. } => {
            let is_v2 = match connection.peer.as_ref().unwrap() {
                Peer::V1(_, initialized) => {
                    if !initialized.auth_methods.iter().any(|method| {
                        matches!(method, acp::AuthMethod::Agent(_))
                            && method.id().0.as_ref() == method_id
                    }) {
                        return Err(Error::Invalid("Authentication method is not offered or requires an unsupported terminal".into()));
                    }
                    false
                }
                Peer::V2(_, initialized) => {
                    if !initialized.auth_methods.iter().any(|method| {
                        matches!(method, v2::AuthMethod::Agent(_))
                            && method.method_id().0.as_ref() == method_id
                    }) {
                        return Err(Error::Invalid("Authentication method is not offered or requires an unsupported terminal".into()));
                    }
                    true
                }
            };
            if is_v2 {
                auth::rpc(
                    connection,
                    v2::LoginAuthRequest::new(method_id),
                    send,
                    &mut stderr,
                )
                .await?;
            } else {
                auth::rpc(
                    connection,
                    acp::AuthenticateRequest::new(method_id),
                    send,
                    &mut stderr,
                )
                .await?;
            }
            emit(send, json!({"kind":"authenticated"})).await
        }
        Input::InstallAntigravity { .. } => unreachable!("installation does not run an agent"),
    }
}

async fn emit(send: &mpsc::Sender<Result<Value, Error>>, event: Value) -> Result<(), Error> {
    remote::validate_payload(&event)?;
    send.send(Ok(event)).await.map_err(|_| Error::Cancelled)
}
fn provider(error: impl std::fmt::Display) -> Error {
    Error::Provider(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_actions_require_explicit_authentication_method() {
        let mut input = json!({"agentId":"agent", "operationId":Uuid::nil(), "kind":"check"});
        assert!(serde_json::from_value::<Input>(input.clone()).is_ok());
        input["kind"] = json!("authenticate");
        assert!(serde_json::from_value::<Input>(input.clone()).is_err());
        input["methodId"] = json!("offered-method");
        assert!(serde_json::from_value::<Input>(input).is_ok());
    }
}
