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

//! Responses execution, canonical projection, and disposable connection state.
mod adapter;
pub(super) mod body;
mod budget;
mod decode;
mod lane;
pub(super) mod request;
mod stream;
mod transport;

pub(super) use adapter::Adapter;
use lane::Lane;
use stream::stream;

pub(super) type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub(super) enum Error {
    #[error("local model authorization refused: {0}")]
    LocalAuthorization(String),
    #[error("Responses request cancelled")]
    Cancelled,
    #[error("Responses resource cleanup is unconfirmed")]
    CleanupUnconfirmed,
    #[error("Responses stream ended without completion")]
    Truncated {
        replay_safe: bool,
        retained_output_safe: bool,
    },
    #[error("Responses provider failed: {error:?}")]
    Provider {
        error: Box<maka_provider_protocol::output::ProviderError>,
        observed_output: bool,
        replay_safe: bool,
        retained_output_safe: bool,
    },
    #[error("{0}")]
    Invalid(String),
    /// Network interruption; replay safety belongs to the protocol decoder.
    #[error("{0}")]
    Interrupted(String),
    #[error("{0}")]
    Transport(String),
}

impl From<maka_provider_protocol::responses::Error> for Error {
    fn from(error: maka_provider_protocol::responses::Error) -> Self {
        use maka_provider_protocol::responses::Error as ProtocolError;
        match error {
            ProtocolError::Invalid(message) => Self::Invalid(message),
            ProtocolError::Truncated {
                replay_safe,
                retained_output_safe,
            } => Self::Truncated {
                replay_safe,
                retained_output_safe,
            },
            ProtocolError::Provider {
                error,
                observed_output,
                replay_safe,
                retained_output_safe,
            } => Self::Provider {
                error,
                observed_output,
                replay_safe,
                retained_output_safe,
            },
        }
    }
}

fn recovery_contract(
    kind: &maka_agent_ports::model::ProviderKind,
    tools: &[std::sync::Arc<maka_agent_facts::tools::ToolDefinition>],
) -> Option<maka_agent_ports::model::RecoveryContract> {
    if !matches!(kind, maka_agent_ports::model::ProviderKind::OpenaiResponses)
        || tools.iter().any(|tool| tool.provider.is_some())
    {
        return None;
    }
    Some(maka_agent_ports::model::RecoveryContract {
        protocol: "maka.adapter.responses.local-functions".into(),
        version: 1,
    })
}
fn continuation_cursor(
    contract: &maka_agent_ports::model::RecoveryContract,
    part: &maka_agent_facts::model::ModelPart,
) -> Option<serde_json::Value> {
    use maka_agent_facts::model::{ModelPart, TextKind};
    if contract.version != 1 || contract.protocol != "maka.adapter.responses.local-functions" {
        return None;
    }
    let options = match part {
        ModelPart::Text {
            text_kind,
            provider_options,
            ..
        } => {
            let options = provider_options
                .as_deref()
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            if *text_kind == TextKind::Thinking
                && !options["openai"]["reasoningEncryptedContent"]
                    .as_str()
                    .is_some_and(|value| !value.is_empty())
            {
                return None;
            }
            options
        }
        ModelPart::ToolCall { call } if !call.provider_executed => call
            .provider_options
            .clone()
            .unwrap_or(serde_json::Value::Null),
        ModelPart::Source { .. } => serde_json::Value::Null,
        _ => return None,
    };
    if let Some(value) = options["openai"].get("responsesReplay") {
        let replay = maka_provider_protocol::responses::Replay::from_value(value.clone()).ok()?;
        match part {
            ModelPart::Text {
                text_kind, text, ..
            } => {
                let body: String = text.chunks().collect();
                replay
                    .text(
                        &body,
                        if *text_kind == TextKind::Thinking {
                            "reasoning"
                        } else {
                            "message"
                        },
                        options["openai"]["reasoningEncryptedContent"].as_str(),
                    )
                    .ok()?;
            }
            ModelPart::ToolCall { call } => {
                let (kind, payload) = match &call.input {
                    maka_agent_facts::model::ToolInput::Json(serde_json::Value::String(raw))
                        if options["openai"]["toolKind"] == "custom" =>
                    {
                        ("custom_tool_call", raw.clone())
                    }
                    maka_agent_facts::model::ToolInput::Json(value) => {
                        ("function_call", value.to_string())
                    }
                    maka_agent_facts::model::ToolInput::InvalidJson { raw } => {
                        ("function_call", raw.clone())
                    }
                };
                replay.call(kind, &call.id, &call.name, &payload).ok()?;
            }
            _ => return None,
        }
    }
    Some(serde_json::json!({"providerOptions": options}))
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    use maka_agent_facts::model::{ModelPart, TextKind};
    use maka_agent_ports::model::ProviderKind;
    #[test]
    fn cold_replay_retains_encrypted_reasoning_and_rejects_unsigned_tail() {
        let contract = recovery_contract(&ProviderKind::OpenaiResponses, &[]).unwrap();
        let mut part = ModelPart::Text {
            text_kind: TextKind::Thinking,
            text: "summary".into(),
            provider_options: None,
        };
        assert_eq!(continuation_cursor(&contract, &part), None);
        if let ModelPart::Text {
            provider_options, ..
        } = &mut part
        {
            *provider_options = Some(std::sync::Arc::new(
                serde_json::json!({"openai":{"itemId":"rs_original","reasoningEncryptedContent":"signed_original","responsesReplay":maka_provider_protocol::responses::replay::capture(&serde_json::json!({"type":"reasoning","id":"rs_original","summary":[{"type":"summary_text","text":"summary"}],"encrypted_content":"signed_original","extra":"preserved"})).unwrap()}}),
            ));
        }
        let cursor = continuation_cursor(&contract, &part).unwrap();
        assert_eq!(
            cursor["providerOptions"]["openai"]["reasoningEncryptedContent"],
            "signed_original"
        );
        assert_eq!(
            cursor["providerOptions"]["openai"]["responsesReplay"]["fields"]["extra"],
            "preserved"
        );
        let unknown = maka_agent_ports::model::RecoveryContract {
            version: 2,
            ..contract
        };
        assert_eq!(continuation_cursor(&unknown, &part), None);
    }
    #[test]
    fn remote_tools_do_not_acquire_local_function_replay_contract() {
        let tool = maka_agent_facts::tools::ToolDefinition {
            provider: Some(maka_agent_facts::tools::ProviderTool {
                id: "openai.web_search".into(),
                args: serde_json::json!({}),
            }),
            name: "search".into(),
            description: String::new(),
            input_schema: serde_json::json!({}),
            freeform: None,
            output_schema: None,
        };
        assert!(
            recovery_contract(&ProviderKind::OpenaiResponses, &[std::sync::Arc::new(tool)])
                .is_none()
        );
    }
}
