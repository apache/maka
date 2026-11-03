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

use super::Selection;
use crate::facts::{
    ProviderFacts,
    adapter::{
        AdapterKind, AdapterName, AnthropicAuth, OpenaiReasoningReplay, ResponsesContract,
        RuntimeAdapter,
    },
};
use maka_agent_ports::model::ProviderKind;
use maka_agent_ports::provider::Error;

pub(crate) use maka_agent_facts::configuration::ApiProtocol as Wire;

fn supports(adapter: &RuntimeAdapter, wire: Wire) -> bool {
    match &adapter.kind {
        AdapterKind::OpenaiCodex { .. } => wire == Wire::OpenaiResponses,
        AdapterKind::Openai { api_protocol, .. } => {
            wire != Wire::AnthropicMessages && api_protocol.is_none_or(|selected| selected == wire)
        }
        AdapterKind::OpenaiCompatible { responses, .. } => {
            wire == Wire::OpenaiChatCompletions
                || (wire == Wire::OpenaiResponses && responses.is_some())
        }
        AdapterKind::Anthropic { .. } => wire == Wire::AnthropicMessages,
        AdapterKind::Google { .. } | AdapterKind::Cohere | AdapterKind::Unavailable => false,
    }
}

fn check_execution(adapter: &RuntimeAdapter, wire: Wire) -> Result<(), Error> {
    let supported = match &adapter.kind {
        AdapterKind::Openai { responses, .. } | AdapterKind::OpenaiCodex { responses } => {
            wire != Wire::OpenaiResponses
                || !matches!(
                    responses,
                    ResponsesContract::Openai {
                        reasoning_replay: OpenaiReasoningReplay::None
                    }
                )
        }
        AdapterKind::Anthropic {
            auth: AnthropicAuth::ApiKey,
            include_beta_headers: None,
            ..
        } => true,
        AdapterKind::OpenaiCompatible {
            responses: Some(_), ..
        } if wire == Wire::OpenaiResponses => true,
        AdapterKind::OpenaiCompatible {
            replay_assistant_reasoning_details: None,
            normalize_usage: None,
            ..
        } => wire == Wire::OpenaiChatCompletions,
        _ => false,
    };
    if !supported {
        return Err(Error::UnsupportedExecutionProfile);
    }
    Ok(())
}

pub(crate) struct Route<'a> {
    pub wire: Wire,
    pub kind: ProviderKind,
    pub base_url: String,
    pub(super) adapter: &'a RuntimeAdapter,
}

impl Route<'_> {
    pub(crate) fn check_probe(&self) -> Result<(), Error> {
        if matches!(
            self.adapter.kind,
            AdapterKind::Anthropic {
                auth: AnthropicAuth::Bearer,
                ..
            }
        ) {
            return Err(Error::UnsupportedProbeAuthentication);
        }
        Ok(())
    }

    pub(crate) fn check_execution(&self) -> Result<(), Error> {
        check_execution(self.adapter, self.wire)
    }
}

fn adapter(value: &RuntimeAdapter) -> Result<&RuntimeAdapter, Error> {
    match value.kind {
        AdapterKind::Google { .. } | AdapterKind::Cohere | AdapterKind::Unavailable => {
            Err(Error::UnsupportedProtocol)
        }
        _ => Ok(value),
    }
}

use super::preferred::resolve as preferred;

pub(crate) fn resolve<'a>(
    row: &Selection<'_>,
    facts: &'a ProviderFacts,
) -> Result<Route<'a>, Error> {
    let model = row.model.id.as_str();
    let known = facts.models.get(model);
    let override_ = known.and_then(|model| model.runtime_override.as_ref());
    let base = adapter(
        override_
            .map(|value| &value.adapter)
            .unwrap_or(&facts.runtime_adapter),
    )?;
    let stored = Some(row.model);
    let explicit = row.overrides.and_then(|value| value.api_protocol);
    let declared = explicit.or_else(|| stored.and_then(|model| model.api_protocol));
    let wire = match declared {
        Some(wire) => wire,
        None => {
            let preferred = preferred(row.provider, model);
            if supports(base, preferred) {
                preferred
            } else if supports(base, Wire::OpenaiChatCompletions) {
                Wire::OpenaiChatCompletions
            } else if supports(base, Wire::OpenaiResponses) {
                Wire::OpenaiResponses
            } else {
                Wire::AnthropicMessages
            }
        }
    };
    let uses_override = supports(base, wire);
    let selected = if uses_override {
        base
    } else {
        let alternate = facts
            .protocol_adapters
            .get(&wire)
            .map(adapter)
            .transpose()?;
        match alternate {
            Some(value) if supports(value, wire) => value,
            _ => adapter(&facts.runtime_adapter)?,
        }
    };
    if !supports(selected, wire) {
        return Err(Error::UnsupportedProtocol);
    }
    let resolved_endpoint = if row.base_url == facts.base_url && uses_override {
        override_
            .and_then(|value| value.base_url.as_deref())
            .unwrap_or(row.base_url)
    } else {
        row.base_url
    };
    let mut url = url::Url::parse(resolved_endpoint).map_err(|_| Error::InvalidEndpoint)?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(Error::InvalidEndpoint);
    }
    let path = url.path().trim_end_matches('/');
    let normalize_base_url = match selected.kind {
        AdapterKind::Anthropic {
            normalize_base_url, ..
        } => normalize_base_url,
        AdapterKind::OpenaiCompatible {
            normalize_base_url, ..
        } => normalize_base_url.unwrap_or(false),
        _ => false,
    };
    let path = if normalize_base_url {
        let root = if path.to_ascii_lowercase().ends_with("/v1") {
            &path[..path.len() - 3]
        } else {
            path
        };
        format!("{root}/v1")
    } else if wire == Wire::OpenaiResponses && path.to_ascii_lowercase().ends_with("/responses") {
        path[..path.len() - 10].to_owned()
    } else {
        path.to_owned()
    };
    url.set_path(&path);
    let kind = match wire {
        Wire::OpenaiChatCompletions
            if matches!(selected.kind, AdapterKind::OpenaiCompatible { .. }) =>
        {
            ProviderKind::OpenaiCompatible {
                name: if matches!(
                    selected.kind,
                    AdapterKind::OpenaiCompatible {
                        name: AdapterName::Connection,
                        ..
                    }
                ) {
                    row.connection.id.clone()
                } else {
                    row.provider.to_owned()
                },
            }
        }
        Wire::OpenaiChatCompletions => ProviderKind::OpenaiChatCompletions,
        Wire::OpenaiResponses => {
            let responses = match &selected.kind {
                AdapterKind::Openai { responses, .. } | AdapterKind::OpenaiCodex { responses } => {
                    responses
                }
                AdapterKind::OpenaiCompatible {
                    responses: Some(responses),
                    ..
                } => responses,
                _ => return Err(Error::MissingResponsesContract),
            };
            match responses {
                ResponsesContract::Openai { .. } => ProviderKind::OpenaiResponses,
                ResponsesContract::OpenResponses { contract } => {
                    ProviderKind::OpenResponses(*contract)
                }
            }
        }
        Wire::AnthropicMessages => ProviderKind::Anthropic,
    };
    Ok(Route {
        wire,
        kind,
        base_url: url.to_string(),
        adapter: selected,
    })
}
