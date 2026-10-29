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

use super::{ADAPTER, Codex, login};
use futures_util::future::BoxFuture;
use maka_agent_facts::configuration::ApiProtocol;
use maka_agent_facts::configuration::ModelInfo;
use maka_agent_facts::execution::ThinkingLevel;
use maka_agent_ports::model::Credentials;
use maka_agent_ports::model::ProviderKind;
use maka_agent_ports::provider::Connection;
use maka_agent_ports::provider::Context;
use maka_agent_ports::provider::Definition;
use maka_agent_ports::provider::Descriptor;
use maka_agent_ports::provider::Discovery;
use maka_agent_ports::provider::Error;
use maka_agent_ports::provider::Model;
use maka_agent_ports::provider::Provider;
use maka_agent_ports::provider::Resolve;
use maka_agent_ports::provider::Verification;
use maka_agent_ports::provider::authentication::Authenticate;
use maka_agent_ports::provider::authentication::Credential;
use maka_agent_ports::provider::authentication::Method;
use maka_capabilities::http;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Arc;

const ENDPOINT: &str = "https://chatgpt.com/backend-api/codex";
#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration {
    base_url: String,
}
#[derive(Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct LoginInput {}

pub(super) fn configuration(connection: &Connection) -> Result<String, Error> {
    let configuration: Configuration = serde_json::from_value(connection.configuration.clone())
        .map_err(|_| Error::Invalid("invalid subscription configuration".into()))?;
    if configuration.base_url.trim_end_matches('/') != ENDPOINT {
        return Err(Error::Invalid(
            "subscription endpoint cannot be overridden".into(),
        ));
    }
    Ok(configuration.base_url)
}

impl Codex {
    pub fn definition(&self) -> Result<Definition, maka_capabilities::Error> {
        Definition::new(
            Descriptor {
                label: "ChatGPT Subscription".into(),
                custom_endpoint: false,
                configuration_schema: serde_json::to_value(schemars::schema_for!(Configuration))
                    .map_err(|e| maka_capabilities::Error::Invalid(e.to_string()))?,
                configuration_defaults: json!({ "baseUrl": ENDPOINT }),
                authentication: vec![Method {
                    id: "chatgpt".into(),
                    label: "Sign in with ChatGPT".into(),
                    input_schema: serde_json::to_value(schemars::schema_for!(LoginInput))
                        .map_err(|e| maka_capabilities::Error::Invalid(e.to_string()))?,
                    interactive: true,
                }],
                anonymous: false,
                discovery: true,
            },
            Arc::new(self.clone()),
        )
        .map_err(|e| maka_capabilities::Error::Invalid(e.to_string()))
    }
}
impl Provider for Codex {
    fn resolve(&self, request: Resolve) -> BoxFuture<'_, Result<Model, Error>> {
        Box::pin(async move {
            let base_url = configuration(&request.connection)?;
            let reported = self.snapshot.resolve(
                "chatgpt",
                request.model,
                request
                    .overrides
                    .as_ref()
                    .and_then(|value| value.catalog_model.as_ref()),
            );
            let mut info = match &request.overrides {
                Some(overrides) => overrides.apply(&reported),
                None => reported,
            };
            // Existing saved connections may predate discovery of this fact.
            if info.max_output_tokens.is_none() {
                info.max_output_tokens = super::inventory::output_capacity(&info.id)?;
            }
            if info
                .api_protocol
                .is_some_and(|wire| wire != ApiProtocol::OpenaiResponses)
            {
                return Err(Error::Invalid(
                    "subscription requires the Responses protocol".into(),
                ));
            }
            let thinking_levels = request
                .overrides
                .as_ref()
                .and_then(|o| o.thinking_levels.clone())
                .or_else(|| info.thinking_levels.clone())
                .unwrap_or_default();
            let level = request.thinking_level.or_else(|| {
                request
                    .overrides
                    .as_ref()
                    .and_then(|o| o.default_thinking_level)
            });
            if level.is_some_and(|level| !thinking_levels.contains(&level)) {
                return Err(Error::Invalid(
                    "unsupported subscription thinking level".into(),
                ));
            }
            let parallel = info
                .capabilities
                .and_then(|c| c.parallel_tool_calls)
                .unwrap_or(true);
            let mut options = json!({"openai":{"store":false,"parallelToolCalls":parallel}});
            if let Some(level) = level {
                options["openai"]["reasoningEffort"] = match level {
                    ThinkingLevel::Off => json!("none"),
                    level => {
                        serde_json::to_value(level).map_err(|e| Error::Invalid(e.to_string()))?
                    }
                };
            }
            let summary = info
                .supports_reasoning_summary
                .unwrap_or(info.capabilities.and_then(|c| c.reasoning) != Some(false));
            if summary && level != Some(ThinkingLevel::Off) {
                options["openai"]["reasoningSummary"] = json!("auto");
            }
            if summary || level.is_some() {
                options["openai"]["forceReasoning"] = json!(true);
            }
            let model = Model {
                main_output_limit: request
                    .overrides
                    .as_ref()
                    .and_then(|o| o.max_output_tokens)
                    .map(|limit| {
                        info.max_output_tokens
                            .map_or(limit, |capacity| limit.min(capacity))
                    })
                    .or(info.max_output_tokens),
                adapter: request
                    .overrides
                    .as_ref()
                    .and_then(|o| o.adapter.clone())
                    .unwrap_or_else(|| ADAPTER.into()),
                protocol: ProviderKind::OpenaiResponses,
                base_url,
                info,
                thinking_levels,
                provider_options: options,
            };
            model.validate()?;
            Ok(model)
        })
    }

    fn authorize(
        &self,
        connection: Connection,
        credential: Option<Credential>,
        session_id: String,
    ) -> BoxFuture<'_, Result<Credentials, Error>> {
        Box::pin(async move {
            configuration(&connection)?;
            let tokens = login::Tokens::read(&credential.ok_or(Error::AuthenticationRequired)?)?;
            let headers = super::request_headers(&tokens.access_token, &session_id)?;
            Ok(Credentials::RequestHeaders(headers))
        })
    }

    fn authenticate(
        &self,
        request: Authenticate,
        context: Context,
    ) -> BoxFuture<'_, Result<Credential, Error>> {
        Box::pin(async move {
            serde_json::from_value::<LoginInput>(request.input.clone())
                .map_err(|_| Error::Invalid("invalid subscription login input".into()))?;
            login::authenticate(request, context).await
        })
    }

    fn refresh(
        &self,
        connection: Connection,
        credential: Credential,
        context: Context,
    ) -> BoxFuture<'_, Result<Credential, Error>> {
        Box::pin(async move {
            configuration(&connection)?;
            login::refresh(credential, context).await
        })
    }

    fn discover(
        &self,
        request: Discovery,
        context: Context,
    ) -> BoxFuture<'_, Result<Vec<ModelInfo>, Error>> {
        Box::pin(async move {
            let Discovery {
                connection,
                credential,
                request_headers,
            } = request;
            let base_url = configuration(&connection)?;
            let tokens = login::Tokens::read(&credential.ok_or(Error::AuthenticationRequired)?)?;
            let mut headers = super::request_headers(&tokens.access_token, &connection.id)?;
            for (name, value) in request_headers {
                if headers
                    .iter()
                    .any(|(key, existing)| key.eq_ignore_ascii_case(&name) && existing != &value)
                {
                    return Err(Error::Invalid(
                        "request headers conflict with provider authentication".into(),
                    ));
                }
                headers.retain(|key, _| !key.eq_ignore_ascii_case(&name));
                headers.insert(name, value);
            }
            let response = context
                .transport
                .request(
                    http::Request {
                        url: format!(
                            "{}/models?client_version=1.0.0",
                            base_url.trim_end_matches('/')
                        ),
                        method: http::Method::Get,
                        headers: headers.into_iter().collect(),
                        body: Default::default(),
                    },
                    context.cancellation.clone(),
                )
                .await
                .map_err(|_| Error::Transport("model discovery failed".into()))?;
            let result = async {
                if !(200..300).contains(&response.head.status) {
                    return Err(Error::Http(response.head.status));
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response
                    .body
                    .next()
                    .await
                    .map_err(|_| Error::Transport("model inventory read failed".into()))?
                {
                    bytes.extend_from_slice(&chunk);
                }
                super::decode_model_inventory(&bytes)
            }
            .await;
            response.body.cancel();
            response
                .body
                .close()
                .await
                .map_err(|_| Error::Transport("inventory cleanup failed".into()))?;
            result
        })
    }

    fn verify(&self, request: Verification, context: Context) -> BoxFuture<'_, Result<(), Error>> {
        Box::pin(async move {
            self.resolve(Resolve {
                connection: request.connection.clone(),
                model: request.model.clone(),
                overrides: request.overrides,
                thinking_level: None,
            })
            .await?;
            let models = self
                .discover(
                    Discovery {
                        connection: request.connection,
                        credential: request.credential,
                        request_headers: request.request_headers,
                    },
                    context,
                )
                .await?;
            if models.iter().any(|model| model.id == request.model.id) {
                Ok(())
            } else {
                Err(Error::Rejected(
                    "model is absent from the account inventory".into(),
                ))
            }
        })
    }
}
