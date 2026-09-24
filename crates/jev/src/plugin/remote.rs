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
    decision::{Evaluation, Jev, Question},
    settings::{Secrets, Settings},
};
use futures_util::future::BoxFuture;
use maka_plugins::{
    authorization::{Capability, Request as Authorization, Target},
    client::Bundle,
    contributions::Staged,
    credentials,
    remote::{Caller, Endpoint, Error, Handler, Method, key},
};
use serde::Deserialize;
use serde_json::{Value, json};
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
        settings: Settings,
    },
    Credential {
        url: String,
        expected_revision: Option<u64>,
        secret: Option<Secrets>,
    },
    Test {
        operation_id: uuid::Uuid,
    },
}
pub(super) fn publish(
    backend: Arc<Jev>,
    bundle: Option<&Bundle>,
    staged: &mut Staged,
) -> Result<(), String> {
    let service = Arc::new(Service(backend));
    staged
        .insert(
            key(super::ID, "manage").map_err(message)?,
            Endpoint::standalone(Handler::Method(service.clone())),
        )
        .map_err(message)?;
    if let Some(bundle) = bundle {
        staged
            .insert(
                key(super::ID, "request").map_err(message)?,
                Endpoint::new(bundle.content_digest.clone(), Handler::Method(service)),
            )
            .map_err(message)?;
    }
    Ok(())
}
pub(super) struct Service(pub(super) Arc<Jev>);
impl Method for Service {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let jev = self.0.clone();
        Box::pin(async move {
            let request: Request = serde_json::from_value(input)
                .map_err(|_| Error::Invalid("Invalid Jev request".into()))?;
            match request {
                Request::Read => {}
                Request::Configure {
                    expected_revision,
                    settings,
                } => {
                    jev.settings
                        .save(expected_revision, settings)
                        .await
                        .map_err(failed)?;
                }
                Request::Credential {
                    url,
                    expected_revision,
                    secret,
                } => {
                    let settings = Settings {
                        url,
                        ..Settings::default()
                    };
                    settings.validate().map_err(failed)?;
                    if let Some(secret) = &secret {
                        secret.validate().map_err(failed)?;
                    }
                    let secret = secret
                        .map(|value| serde_json::to_string(&value))
                        .transpose()
                        .map_err(failed)?;
                    let receipt = jev
                        .settings
                        .credentials
                        .write(credentials::Write {
                            key: settings.credential_key(),
                            expected_revision,
                            secret,
                        })
                        .await
                        .map_err(failed)?;
                    if matches!(receipt, credentials::WriteResult::Conflict { .. }) {
                        return Err(Error::Provider(
                            "Credential changed; refresh before retrying".into(),
                        ));
                    }
                }
                Request::Test { operation_id } => {
                    let (_, settings) = jev.settings.settings().await.map_err(failed)?;
                    let owned = caller
                        .views
                        .authorize(Authorization {
                            operation_id,
                            title: format!(
                                "Test Jev at {}",
                                url::Url::parse(&settings.url)
                                    .map_err(failed)?
                                    .host_str()
                                    .unwrap_or("configured endpoint")
                            ),
                            target: Target::PluginWorkspace {
                                sandbox_mode: maka_runtime::execution::SandboxMode::ReadOnly,
                            },
                            capabilities: [Capability::Network].into(),
                        })
                        .await?;
                    let result = jev
                        .configured(
                            &owned.scope(),
                            Evaluation {
                                state: json!({"test":true}),
                                questions: [(
                                    "ready".into(),
                                    Question::Noul {
                                        instructions: json!("Is test true?"),
                                        criteria: None,
                                    },
                                )]
                                .into(),
                            },
                            settings,
                        )
                        .await;
                    owned.finish().await.map_err(|_| {
                        Error::OutcomeUnknown("Jev test cleanup is unconfirmed".into())
                    })?;
                    return result
                        .map(|answer| json!({"kind":"tested", "answer":answer}))
                        .map_err(|error| {
                            if error.outcome_unknown() {
                                Error::OutcomeUnknown(error.to_string())
                            } else {
                                failed(error)
                            }
                        });
                }
            }
            Ok(
                json!({"kind":"snapshot", "snapshot":jev.settings.snapshot().await.map_err(failed)?}),
            )
        })
    }
}
fn message(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn failed(e: impl std::fmt::Display) -> Error {
    Error::Provider(e.to_string())
}
