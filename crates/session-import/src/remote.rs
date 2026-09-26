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

use crate::{Error, catalog, intent, source};
use futures_util::future::BoxFuture;
use maka_plugins::{
    execution::{Access, CommandError},
    llm::{Choices, Models, Search},
    remote::{Caller, Error as RemoteError, Method},
    storage::{Store, StoreError},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
pub struct Import {
    store: Arc<dyn Store>,
    access: Arc<dyn Access>,
    models: Arc<dyn Models>,
}
impl Import {
    pub fn new(store: Arc<dyn Store>, access: Arc<dyn Access>, models: Arc<dyn Models>) -> Self {
        Self {
            store,
            access,
            models,
        }
    }
}
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    Models {
        query: Search,
    },
    Sources,
    SaveSources {
        expected_revision: Option<u64>,
        configuration: source::Configuration,
    },
    Catalog {
        source_id: Uuid,
        revision: u64,
        query: catalog::Query,
    },
    Prepare {
        request: Box<intent::Request>,
    },
    Deliver {
        operation_id: Uuid,
    },
    Abandon {
        operation_id: Uuid,
    },
    Copies {
        after: Option<Uuid>,
    },
    Copy {
        operation_id: Uuid,
    },
}
#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Response {
    Models { choices: Choices },
    Sources { snapshot: source::Snapshot },
    Catalog { page: catalog::Page },
    Copy { copy: intent::Copy },
    Copies { page: intent::Page },
    Detail { copy: Option<intent::Copy> },
    Conflict,
}
impl Method for Import {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, RemoteError>> {
        let backend = self.clone();
        Box::pin(async move {
            let request = serde_json::from_value(input)
                .map_err(|error| RemoteError::Invalid(error.to_string()))?;
            let response = match backend.handle(request, caller).await {
                Ok(response) => response,
                Err(
                    Error::Conflict
                    | Error::Storage(StoreError::Conflict { .. })
                    | Error::Execution(CommandError::Conflict),
                ) => Response::Conflict,
                Err(error) => return Err(remote_error(error)),
            };
            serde_json::to_value(response).map_err(|error| RemoteError::Provider(error.to_string()))
        })
    }
}
impl Import {
    async fn handle(&self, request: Request, caller: Caller) -> Result<Response, Error> {
        let repository = intent::Repository::new(self.store.clone());
        match request {
            Request::Models { query } => Ok(Response::Models {
                choices: self
                    .models
                    .search(query)
                    .await
                    .map_err(|error| Error::Remote(RemoteError::Provider(error.to_string())))?,
            }),
            Request::Sources => Ok(Response::Sources {
                snapshot: source::read(self.store.as_ref()).await?,
            }),
            Request::SaveSources {
                expected_revision,
                configuration,
            } => Ok(Response::Sources {
                snapshot: source::save(self.store.as_ref(), expected_revision, configuration)
                    .await?,
            }),
            Request::Catalog {
                source_id,
                revision,
                query,
            } => {
                let source = self.source(source_id, revision).await?;
                Ok(Response::Catalog {
                    page: source.catalog(caller.views.as_ref(), query).await?,
                })
            }
            Request::Prepare { request } => {
                let request = *request;
                let saved = match repository.get(request.operation_id).await? {
                    Some(saved) => {
                        if saved.intent().request != request {
                            return Err(Error::Conflict);
                        }
                        saved
                    }
                    None => {
                        let source = self
                            .source(
                                request.selection.source_id,
                                request.selection.source_revision,
                            )
                            .await?;
                        let transcript = source
                            .read(caller.views.as_ref(), &request.selection)
                            .await?;
                        repository.prepare(request, source, transcript).await?
                    }
                };
                Ok(Response::Copy { copy: saved.copy() })
            }
            Request::Deliver { operation_id } => {
                repository
                    .deliver(operation_id, caller.views.as_ref(), self.access.as_ref())
                    .await?;
                let saved = repository.get(operation_id).await?.ok_or(Error::Conflict)?;
                Ok(Response::Copy { copy: saved.copy() })
            }
            Request::Abandon { operation_id } => {
                repository
                    .abandon(operation_id, caller.views.as_ref(), self.access.as_ref())
                    .await?;
                let saved = repository.get(operation_id).await?.ok_or(Error::Conflict)?;
                Ok(Response::Copy { copy: saved.copy() })
            }
            Request::Copies { after } => Ok(Response::Copies {
                page: repository.list(after).await?,
            }),
            Request::Copy { operation_id } => Ok(Response::Detail {
                copy: repository
                    .get(operation_id)
                    .await?
                    .map(|saved| saved.copy()),
            }),
        }
    }
    async fn source(&self, id: Uuid, revision: u64) -> Result<source::Source, Error> {
        let snapshot = source::read(self.store.as_ref()).await?;
        if snapshot.revision != Some(revision) {
            return Err(Error::Conflict);
        }
        snapshot
            .configuration
            .sources
            .into_iter()
            .find(|source| source.id == id)
            .ok_or(Error::Conflict)
    }
}
fn remote_error(error: Error) -> RemoteError {
    match error {
        Error::Remote(error) => error,
        Error::Storage(StoreError::Retired)
        | Error::Execution(CommandError::Revoked | CommandError::Denied | CommandError::Draining) => {
            RemoteError::Retired
        }
        Error::Storage(StoreError::OutcomeUnknown(message))
        | Error::Execution(CommandError::OutcomeUnknown(message)) => {
            RemoteError::OutcomeUnknown(message)
        }
        Error::Invalid(message) => RemoteError::Invalid(message.into()),
        Error::Execution(CommandError::Invalid(message)) => RemoteError::Invalid(message),
        other => RemoteError::Provider(other.to_string()),
    }
}
