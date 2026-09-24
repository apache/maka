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

use super::Web;
use crate::{search, settings};
use futures_util::future::BoxFuture;
use maka_plugins::{
    authorization::{Capability, Request as Authorization, Target},
    client::Bundle,
    contributions::Staged,
    credentials,
    remote::{Caller, Endpoint, Error, Handler, Method, key},
    storage::StoreError,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Request {
    Read,
    Configure {
        expected_revision: Option<u64>,
        settings: settings::Settings,
    },
    Credential {
        expected_revision: Option<u64>,
        secret: Option<String>,
    },
    Test {
        operation_id: uuid::Uuid,
    },
    Search {
        operation_id: uuid::Uuid,
        query: search::Query,
    },
}
#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Response {
    Snapshot { snapshot: settings::Snapshot },
    Saved { revision: u64 },
    Credential { receipt: credentials::WriteResult },
    Test { check: settings::Check },
    Search { results: search::Results },
}
pub(super) fn publish(
    web: Arc<Web>,
    identity: &maka_plugins::fiber::Identity,
    bundle: &Bundle,
    staged: &mut Staged,
) -> Result<(), String> {
    staged
        .insert(
            key(&identity.package_id, "request").map_err(message)?,
            Endpoint::new(
                bundle.content_digest.clone(),
                Handler::Method(Arc::new(Service {
                    web,
                    scope: identity.scope.clone(),
                })),
            ),
        )
        .map_err(message)
}
pub(super) struct Service {
    pub(super) web: Arc<Web>,
    pub(super) scope: maka_plugins::composition::Scope,
}
impl Method for Service {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let web = self.web.clone();
        let target = match &self.scope {
            maka_plugins::composition::Scope::Session(id) => Target::Session {
                session_id: id.clone(),
            },
            _ => Target::PluginWorkspace {
                sandbox_mode: maka_runtime::execution::SandboxMode::ReadOnly,
            },
        };
        Box::pin(async move {
            let input: Request =
                serde_json::from_value(input).map_err(|error| Error::Invalid(error.to_string()))?;
            let response = match input {
                Request::Read => Response::Snapshot {
                    snapshot: web.settings.snapshot().await.map_err(storage)?,
                },
                Request::Configure {
                    expected_revision,
                    settings,
                } => {
                    let receipt = web
                        .settings
                        .save(expected_revision, settings)
                        .await
                        .map_err(storage)?;
                    Response::Saved {
                        revision: receipt.revision,
                    }
                }
                Request::Credential {
                    expected_revision,
                    secret,
                } => {
                    let secret = secret
                        .map(|value| value.trim().to_owned())
                        .filter(|value| !value.is_empty());
                    if secret.as_ref().is_some_and(|value| {
                        value.len() > 4096 || value.chars().any(char::is_control)
                    }) {
                        return Err(Error::Invalid("invalid search credential".into()));
                    }
                    Response::Credential {
                        receipt: web
                            .settings
                            .credentials
                            .write(credentials::Write {
                                key: settings::KEY.into(),
                                expected_revision,
                                secret,
                            })
                            .await
                            .map_err(storage)?,
                    }
                }
                Request::Test { operation_id } | Request::Search { operation_id, .. } => {
                    if web
                        .preferences
                        .read()
                        .await
                        .map_err(provider)?
                        .privacy
                        .incognito_active
                    {
                        return Err(Error::Provider(
                            "Web search is disabled in incognito mode".into(),
                        ));
                    }
                    let test = matches!(input, Request::Test { .. });
                    let query = match input {
                        Request::Search { query, .. } => {
                            let (_, settings) = web.settings.settings().await.map_err(storage)?;
                            if !settings.enabled || settings.source != settings::Source::Tavily {
                                return Err(Error::Provider(
                                    "Manual queries require enabled Tavily search".into(),
                                ));
                            }
                            query
                        }
                        _ => search::Query {
                            query: "Maka AI assistant".into(),
                            limit: 1,
                        },
                    };
                    query
                        .validate()
                        .map_err(|error| Error::Invalid(error.to_string()))?;
                    let record = web
                        .settings
                        .credentials
                        .read(settings::KEY.into())
                        .await
                        .map_err(storage)?
                        .ok_or_else(|| provider(search::Error::NotConfigured))?;
                    let secret = record
                        .secret
                        .ok_or_else(|| provider(search::Error::NotConfigured))?;
                    let owned = caller
                        .views
                        .authorize(Authorization {
                            operation_id,
                            title: if test {
                                "Test Tavily search credentials"
                            } else {
                                "Search the web with Tavily"
                            }
                            .into(),
                            target,
                            capabilities: [Capability::Network].into(),
                        })
                        .await?;
                    let result = web.search.query(&owned.scope(), &secret, &query).await;
                    owned.finish().await.map_err(settlement)?;
                    if test {
                        let outcome = match result {
                            Ok(_) => settings::CheckOutcome::Valid,
                            Err(search::Error::InvalidCredentials) => {
                                settings::CheckOutcome::InvalidCredentials
                            }
                            Err(search::Error::RateLimited) => settings::CheckOutcome::RateLimited,
                            Err(search::Error::Timeout) => settings::CheckOutcome::Timeout,
                            Err(
                                search::Error::Network
                                | search::Error::Status(_)
                                | search::Error::Response,
                            ) => settings::CheckOutcome::NetworkError,
                            Err(search::Error::Settlement(error)) => return Err(settlement(error)),
                            Err(error) => return Err(provider(error)),
                        };
                        let check = settings::Check {
                            credential_revision: record.revision,
                            outcome,
                        };
                        web.settings
                            .record_check(check.clone())
                            .await
                            .map_err(storage)?;
                        Response::Test { check }
                    } else {
                        Response::Search {
                            results: result.map_err(|error| match error {
                                search::Error::Settlement(error) => settlement(error),
                                error => provider(error),
                            })?,
                        }
                    }
                }
            };
            serde_json::to_value(response).map_err(provider)
        })
    }
}
fn settlement(error: maka_runtime::tools::ToolError) -> Error {
    match error {
        maka_runtime::tools::ToolError::CleanupUnconfirmed(_) => Error::CleanupUnconfirmed,
        maka_runtime::tools::ToolError::OutcomeUnknown(message) => Error::OutcomeUnknown(message),
        error => provider(error),
    }
}
fn storage(error: StoreError) -> Error {
    match error {
        StoreError::Retired => Error::Retired,
        StoreError::OutcomeUnknown(message) => Error::OutcomeUnknown(message),
        error => provider(error),
    }
}
fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn provider(error: impl std::fmt::Display) -> Error {
    Error::Provider(error.to_string())
}
