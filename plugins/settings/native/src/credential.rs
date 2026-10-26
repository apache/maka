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

use crate::{connections, contract::*};
use futures_util::future::BoxFuture;
use maka_agent_facts::oauth::Failure;
use maka_agent_facts::oauth::LoginStart;
use maka_agent_facts::oauth::Phase;
use maka_agent_facts::oauth::Target;
use maka_agent_facts::provider::AuthenticationInput;
use maka_agent_ports::model::Connect;
use maka_agent_ports::model::Error;
use maka_agent_ports::model::Socket;
use maka_agent_ports::model::Transport;
use maka_agent_ports::provider;
use maka_agent_ports::provider::authentication::Authenticate;
use maka_config::{
    ConfigurationStore,
    oauth::enrollment::{LoginCompletion, LoginPreparation, LoginRejection},
};
use maka_host_runtime::application::Context;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

/// API-key authentication only validates and wraps local input. Its Context does
/// not acquire network authority merely to satisfy the provider interface.
struct NoNetwork;
impl Transport for NoNetwork {
    fn identity(&self) -> u64 {
        0
    }
    fn request(
        &self,
        _: maka_capabilities::http::Request,
        _: tokio_util::sync::CancellationToken,
    ) -> BoxFuture<'_, Result<maka_capabilities::http::Response, Error>> {
        Box::pin(async {
            Err(Error::Adapter(
                "settings_authentication_network_unavailable".into(),
            ))
        })
    }
    fn connect(&self, _: Connect) -> BoxFuture<'_, Result<Arc<dyn Socket>, Error>> {
        Box::pin(async {
            Err(Error::Adapter(
                "settings_authentication_network_unavailable".into(),
            ))
        })
    }
}
fn rejected(reason: CredentialRejection) -> Result<Value, String> {
    connections::encode(CredentialSaveResult::Rejected { reason })
}
pub(crate) async fn save(
    store: &Arc<ConfigurationStore>,
    snapshot: Arc<maka_providers::catalog::Snapshot>,
    input: Value,
    context: Context,
) -> Result<Value, String> {
    context.operation().ok_or("settings_mutation_required")?;
    let Ok(request) = serde_json::from_value::<SaveCredential>(input) else {
        return rejected(CredentialRejection::InvalidInput);
    };
    let Ok(definition) = connections::definition(&request.expected.provider, snapshot) else {
        return rejected(CredentialRejection::ProviderUnavailable);
    };
    if !definition
        .descriptor()
        .authentication
        .iter()
        .any(|method| method.id == "api-key" && !method.interactive)
    {
        return rejected(CredentialRejection::AuthenticationUnavailable);
    }
    let Some(resource) = context.attachments().get("secret") else {
        return rejected(CredentialRejection::InvalidSecret);
    };
    let bytes = resource.bytes();
    if bytes == 0 {
        return rejected(CredentialRejection::InvalidSecret);
    }
    let Ok(secret) = resource.read(0..bytes) else {
        return rejected(CredentialRejection::SecretUnavailable);
    };
    let Ok(secret) = String::from_utf8(secret) else {
        return rejected(CredentialRejection::InvalidSecret);
    };
    if secret.len() != bytes || secret.chars().any(char::is_control) {
        return rejected(CredentialRejection::InvalidSecret);
    }
    enroll(
        store,
        definition,
        request,
        AuthenticationInput {
            method: "api-key".into(),
            input: json!({"apiKey":secret}),
        },
        context,
        false,
    )
    .await
}

struct LoginInteraction(Context);
impl provider::authentication::Interaction for LoginInteraction {
    fn open_external(
        &self,
        url: String,
        user_code: Option<String>,
    ) -> BoxFuture<'_, Result<(), provider::Error>> {
        Box::pin(async move {
            let user_code = user_code.unwrap_or_default();
            if url != "https://auth.openai.com/codex/device" {
                return Err(provider::Error::Invalid("invalid login prompt".into()));
            }
            self.0
                .emit(
                    serde_json::to_value(LoginPrompt { url, user_code })
                        .map_err(|_| provider::Error::Unavailable)?,
                )
                .await
                .map_err(|_| provider::Error::Cancelled)
        })
    }
}

pub(crate) async fn login(
    store: &Arc<ConfigurationStore>,
    snapshot: Arc<maka_providers::catalog::Snapshot>,
    input: Value,
    context: Context,
) -> Result<Value, String> {
    context.operation().ok_or("settings_mutation_required")?;
    let Ok(input) = serde_json::from_value::<LoginCredential>(input) else {
        return rejected(CredentialRejection::InvalidInput);
    };
    let Ok(definition) = connections::definition(&input.expected.provider, snapshot) else {
        return rejected(CredentialRejection::ProviderUnavailable);
    };
    if !definition
        .descriptor()
        .authentication
        .iter()
        .any(|method| method.id == input.method && method.interactive)
    {
        return rejected(CredentialRejection::AuthenticationUnavailable);
    }
    enroll(
        store,
        definition,
        SaveCredential {
            expected: input.expected,
            expected_credential: input.expected_credential,
        },
        AuthenticationInput {
            method: input.method,
            input: json!({}),
        },
        context,
        true,
    )
    .await
}

async fn enroll(
    store: &Arc<ConfigurationStore>,
    definition: provider::Definition,
    request: SaveCredential,
    authentication: AuthenticationInput,
    context: Context,
    interactive: bool,
) -> Result<Value, String> {
    let operation = context.operation().ok_or("settings_mutation_required")?;
    let attempt_id = format!(
        "settings-{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(operation).map_err(|_| "settings_operation_invalid")?
        ))
    );
    let input = LoginStart {
        attempt_id,
        target: Target::Existing {
            expected: request.expected.clone(),
            configuration: request.expected.configuration.clone(),
        },
        expected_credential: request.expected_credential,
        authentication,
    };
    if input.validate().is_err() {
        return rejected(CredentialRejection::InvalidInput);
    }
    let authentication = input.authentication.clone();
    let prepared = store
        .prepare_oauth_login(input)
        .await
        .map_err(|_| "settings_effect_unknown")?;
    let ticket = match prepared {
        LoginPreparation::Ready(ticket) => ticket,
        LoginPreparation::Finished(receipt) if receipt.phase == Phase::Authenticated => {
            return connections::encode(CredentialSaveResult::Saved {
                connection: receipt.connection,
            });
        }
        LoginPreparation::Finished(_) | LoginPreparation::OutcomeUnknown(_) => {
            return Err("settings_effect_unknown".into());
        }
        LoginPreparation::Rejected(reason) => {
            return rejected(match reason {
                LoginRejection::AttemptConflict => CredentialRejection::AttemptConflict,
                LoginRejection::ConnectionNotFound | LoginRejection::ConnectionChanged => {
                    CredentialRejection::ConnectionChanged
                }
                LoginRejection::CredentialChanged => CredentialRejection::CredentialChanged,
                LoginRejection::SlugTaken => CredentialRejection::SlugTaken,
            });
        }
    };
    let transport = if interactive {
        let network = ticket.network_configuration();
        let policy =
            maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
                .map_err(|_| "settings_network_unavailable")?;
        maka_model::provider_transport(&policy).map_err(|_| "settings_network_unavailable")?
    } else {
        Arc::new(NoNetwork) as Arc<dyn Transport>
    };
    let provider_context = provider::Context {
        transport,
        cancellation: context.scope().cancellation.clone(),
        interaction: interactive.then(|| {
            Arc::new(LoginInteraction(context)) as Arc<dyn provider::authentication::Interaction>
        }),
    };
    authenticate(
        ticket,
        definition,
        authentication,
        provider_context,
        interactive,
    )
    .await
}

async fn authenticate(
    ticket: Box<maka_config::oauth::enrollment::PreparedLogin>,
    definition: provider::Definition,
    authentication: AuthenticationInput,
    provider_context: provider::Context,
    interactive: bool,
) -> Result<Value, String> {
    if !ticket
        .claim()
        .await
        .map_err(|_| "settings_effect_unknown")?
    {
        return Err("settings_effect_unknown".into());
    }
    let row = ticket.connection();
    let credential = definition
        .authenticate(
            Authenticate {
                connection: provider::Connection {
                    id: row.connection_id.clone(),
                    revision: row.revision,
                    configuration: row.configuration.clone(),
                },
                method: authentication.method,
                input: authentication.input,
            },
            provider_context,
        )
        .await;
    let credential = match credential {
        Ok(credential) => credential,
        Err(error) => {
            if matches!(error, provider::Error::OutcomeUnknown) {
                return Err("settings_effect_unknown".into());
            }
            ticket
                .finish_failure(if matches!(error, provider::Error::Cancelled) {
                    Phase::Cancelled
                } else {
                    Phase::Failed {
                        failure: Failure::AuthorizationFailed,
                    }
                })
                .await
                .map_err(|_| "settings_effect_unknown")?;
            if interactive {
                let (reason, message) = match error {
                    provider::Error::Cancelled => (LoginFailure::Cancelled, String::new()),
                    provider::Error::AuthenticationRequired => {
                        (LoginFailure::Expired, String::new())
                    }
                    provider::Error::Transport(_) | provider::Error::Http(_) => {
                        (LoginFailure::Transport, String::new())
                    }
                    provider::Error::Rejected(message) => (LoginFailure::Authentication, message),
                    _ => (LoginFailure::Authentication, String::new()),
                };
                return connections::encode(CredentialLoginResult::Failed { reason, message });
            }
            return rejected(CredentialRejection::Authentication);
        }
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "settings_clock_unavailable")?
        .as_secs();
    match ticket
        .complete(credential, now)
        .await
        .map_err(|_| "settings_effect_unknown")?
    {
        LoginCompletion::Committed(receipt) => connections::encode(CredentialSaveResult::Saved {
            connection: receipt.connection,
        }),
        LoginCompletion::ConnectionChanged => rejected(CredentialRejection::ConnectionChanged),
        LoginCompletion::CredentialChanged => rejected(CredentialRejection::CredentialChanged),
        LoginCompletion::AttemptConflict => rejected(CredentialRejection::AttemptConflict),
        LoginCompletion::SlugTaken => rejected(CredentialRejection::SlugTaken),
    }
}

#[cfg(test)]
mod tests;
