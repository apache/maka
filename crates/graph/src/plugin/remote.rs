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

use super::read::{self, Query};
use crate::{GraphId, owner::View};
use futures_util::future::BoxFuture;
use maka_plugins::{
    contributions::Staged,
    remote::{Caller, Endpoint, Error, Handler, Method, Stream, StreamProvider, key},
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{Mutex, Semaphore, watch};
use tokio_util::sync::CancellationToken;

pub(super) fn register(
    staged: &mut Staged,
    manager: Arc<super::Manager>,
    digest: &str,
) -> Result<(), String> {
    let package = manager.parent.identity().map_err(message)?.package_id;
    let service = Arc::new(Service {
        manager,
        reads: Semaphore::new(2),
    });
    super::terminal::register(staged, &package, service.clone())?;
    for (name, handler) in [
        (
            "settings",
            Handler::Method(Arc::new(Call {
                service: service.clone(),
                action: Action::Settings,
            }) as Arc<dyn Method>),
        ),
        (
            "authorize",
            Handler::Method(Arc::new(Call {
                service: service.clone(),
                action: Action::Authorize,
            }) as Arc<dyn Method>),
        ),
        (
            "query",
            Handler::Method(Arc::new(Call {
                service: service.clone(),
                action: Action::Query,
            }) as Arc<dyn Method>),
        ),
        (
            "stop",
            Handler::Method(Arc::new(Call {
                service: service.clone(),
                action: Action::Stop,
            }) as Arc<dyn Method>),
        ),
        (
            "changes",
            Handler::Stream(service as Arc<dyn StreamProvider>),
        ),
    ] {
        staged
            .insert(
                key(&package, name).map_err(message)?,
                Endpoint::new(digest.into(), handler),
            )
            .map_err(message)?;
    }
    Ok(())
}
pub(super) struct Service {
    manager: Arc<super::Manager>,
    reads: Semaphore,
}
pub(super) struct Call {
    pub(super) service: Arc<Service>,
    pub(super) action: Action,
}
#[derive(Clone, Copy)]
pub(super) enum Action {
    Settings,
    Authorize,
    Query,
    Stop,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Stop {
    graph_id: GraphId,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum AuthorizationRequest {
    Status,
    Remember { id: maka_plugins::authorization::Id },
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum SettingsRequest {
    Read,
    Replace { snapshot: crate::settings::Snapshot },
}

impl Method for Call {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let service = self.service.clone();
        let action = self.action;
        Box::pin(async move {
            if matches!(action, Action::Settings) {
                let request: SettingsRequest = serde_json::from_value(input)
                    .map_err(|error| Error::Invalid(error.to_string()))?;
                let settings = &service.manager.settings;
                let result = match request {
                    SettingsRequest::Read => settings.read().await,
                    SettingsRequest::Replace { snapshot } => settings.replace(snapshot).await,
                }
                .map_err(graph_error)?;
                return serde_json::to_value(result).map_err(failure);
            }
            let root = caller
                .session_id
                .ok_or_else(|| Error::Invalid("Agent Graph requires a Session".into()))?;
            match action {
                Action::Settings => unreachable!(),
                Action::Authorize => {
                    let request: AuthorizationRequest = serde_json::from_value(input)
                        .map_err(|error| Error::Invalid(error.to_string()))?;
                    match request {
                        AuthorizationRequest::Remember { id } => {
                            service
                                .manager
                                .access
                                .remember(&root, id)
                                .await
                                .map_err(graph_error)?;
                            service.manager.changed.send_replace(());
                            Ok(Value::Null)
                        }
                        AuthorizationRequest::Status => {
                            let authorized = caller.views.authorize(session_consent(&root)).await?;
                            let result = async {
                                let commands = service.manager.access.executions.acquire(authorized.scope()).await.map_err(failure)?;
                                let session = commands.session(root.clone()).await.map_err(failure)?;
                                let approved = match service.manager.access.commands(&root).await {
                                    Ok(_) => true,
                                    Err(crate::Error::Host(
                                        maka_plugins::execution::CommandError::Denied
                                        | maka_plugins::execution::CommandError::Revoked
                                        | maka_plugins::execution::CommandError::NotFound
                                    )) => false,
                                    Err(error) => return Err(graph_error(error)),
                                };
                                Ok(serde_json::json!({"authorized": approved,
                                    "selected": matches!(session.behavior.as_str(), "graph" | "swarm")}))
                            }.await;
                            authorized
                                .finish()
                                .await
                                .map_err(|_| Error::CleanupUnconfirmed)?;
                            result
                        }
                    }
                }
                Action::Query => {
                    let query: Query = serde_json::from_value(input)
                        .map_err(|error| Error::Invalid(error.to_string()))?;
                    let read = async {
                        let authorized = caller.views.authorize(session_consent(&root)).await?;
                        let result = async {
                            let commands = service
                                .manager
                                .access
                                .executions
                                .acquire(authorized.scope())
                                .await
                                .map_err(failure)?;
                            let _permit =
                                service.reads.acquire().await.map_err(|_| Error::Retired)?;
                            let value = read::query(
                                read::Source {
                                    commands: commands.as_ref(),
                                    storage: service.manager.access.storage.as_ref(),
                                    repository: &service.manager.repository,
                                },
                                &root,
                                query,
                            )
                            .await?;
                            serde_json::to_value(value).map_err(failure)
                        }
                        .await;
                        authorized
                            .finish()
                            .await
                            .map_err(|_| Error::CleanupUnconfirmed)?;
                        result
                    };
                    tokio::select! {
                        biased;
                        _ = caller.cancellation.cancelled() => Err(Error::Cancelled),
                        result = read => result,
                    }
                }
                Action::Stop => {
                    let input: Stop = serde_json::from_value(input)
                        .map_err(|error| Error::Invalid(error.to_string()))?;
                    if caller.cancellation.is_cancelled() {
                        return Err(Error::Cancelled);
                    }
                    let authorized = caller.views.authorize(session_consent(&root)).await?;
                    let result = async {
                        let commands = service
                            .manager
                            .access
                            .executions
                            .acquire(authorized.scope())
                            .await
                            .map_err(failure)?;
                        service
                            .manager
                            .stop(&root, &input.graph_id, commands)
                            .await?;
                        Ok(Value::Null)
                    }
                    .await;
                    authorized
                        .finish()
                        .await
                        .map_err(|_| Error::CleanupUnconfirmed)?;
                    result
                }
            }
        })
    }
}
impl StreamProvider for Service {
    fn open(
        &self,
        input: Value,
        caller: Caller,
    ) -> BoxFuture<'static, Result<Box<dyn Stream>, Error>> {
        let manager = self.manager.clone();
        Box::pin(async move {
            if !input.is_null() || caller.session_id.is_none() {
                return Err(Error::Invalid(
                    "Graph changes require a Session and null input".into(),
                ));
            }
            Ok(Box::new(Changes {
                state: Mutex::new(Watch {
                    changed: manager.changed.subscribe(),
                    view: None,
                    previous: None,
                    initialized: false,
                }),
                manager,
                session: caller.session_id.expect("validated Session"),
                stop: caller.cancellation,
            }) as Box<dyn Stream>)
        })
    }
}
struct Changes {
    manager: Arc<super::Manager>,
    session: String,
    state: Mutex<Watch>,
    stop: CancellationToken,
}
struct Watch {
    changed: watch::Receiver<()>,
    view: Option<watch::Receiver<Arc<View>>>,
    previous: Option<Value>,
    initialized: bool,
}
impl Stream for Changes {
    fn next(&self) -> BoxFuture<'_, Result<Option<Value>, Error>> {
        Box::pin(async move {
            let mut state = self.state.lock().await;
            loop {
                if self.stop.is_cancelled() {
                    return Ok(None);
                }
                if !state.initialized || state.changed.has_changed().map_err(|_| Error::Retired)? {
                    state.changed.borrow_and_update();
                    state.previous = None;
                    let slot = self
                        .manager
                        .roots
                        .lock()
                        .unwrap()
                        .get(&self.session)
                        .cloned();
                    state.view = match slot {
                        Some(slot) => {
                            let root = tokio::select! {
                                biased;
                                _ = self.stop.cancelled() => return Ok(None),
                                root = slot.lock() => root,
                            };
                            root.as_ref().map(|root| root.handle.subscribe())
                        }
                        None => None,
                    };
                    state.initialized = true;
                }
                let key = state.view.as_mut().map_or(Value::Null, |changes| {
                    let view = changes.borrow_and_update();
                    serde_json::json!([view.change_key, view.error, view.initialized])
                });
                if state.previous.as_ref() != Some(&key) {
                    state.previous = Some(key);
                    return Ok(Some(Value::Null));
                }
                let Watch { changed, view, .. } = &mut *state;
                tokio::select! {
                    biased;
                    _ = self.stop.cancelled() => return Ok(None),
                    result = changed.changed() => {
                        result.map_err(|_| Error::Retired)?;
                        state.initialized = false;
                    },
                    result = async {
                        match view {
                            Some(view) => view.changed().await,
                            None => std::future::pending().await,
                        }
                    } => if result.is_err() {
                        state.view = None;
                        state.previous = None;
                    },
                }
            }
        })
    }
    fn cancel(&self) {
        self.stop.cancel();
    }
    fn close(self: Box<Self>) -> BoxFuture<'static, Result<(), Error>> {
        self.stop.cancel();
        Box::pin(async { Ok(()) })
    }
}
fn message(error: impl ToString) -> String {
    error.to_string()
}
fn failure(error: impl ToString) -> Error {
    Error::Provider(error.to_string())
}

pub(super) fn graph_error(error: crate::Error) -> Error {
    match error {
        crate::Error::OutcomeUnknown(message)
        | crate::Error::Storage(maka_plugins::storage::StoreError::OutcomeUnknown(message))
        | crate::Error::Host(maka_plugins::execution::CommandError::OutcomeUnknown(message)) => {
            Error::OutcomeUnknown(message)
        }
        error => Error::Provider(error.to_string()),
    }
}

fn session_consent(session: &str) -> maka_plugins::authorization::Request {
    maka_plugins::authorization::Request {
        operation_id: uuid::Uuid::new_v4(),
        title: "Inspect Agent Graph".into(),
        target: maka_plugins::authorization::Target::Session {
            session_id: session.into(),
        },
        capabilities: [maka_plugins::authorization::Capability::Executions].into(),
    }
}
