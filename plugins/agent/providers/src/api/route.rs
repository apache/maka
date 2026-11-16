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
        AdapterName, AnthropicAuth, OpenaiReasoningReplay, ResponsesContract, RuntimeAdapter,
    },
};
use maka_agent_ports::model::ProviderKind;
use maka_agent_ports::provider::Error;

pub(crate) use maka_agent_facts::configuration::ApiProtocol as Wire;

fn check_execution(adapter: &RuntimeAdapter) -> Result<(), Error> {
    let supported = match adapter {
        RuntimeAdapter::OpenaiChat {} => true,
        RuntimeAdapter::OpenaiResponses { responses }
        | RuntimeAdapter::OpenaiCodex { responses } => !matches!(
            responses,
            ResponsesContract::Openai {
                reasoning_replay: OpenaiReasoningReplay::None
            }
        ),
        RuntimeAdapter::Anthropic {
            auth: AnthropicAuth::ApiKey,
            include_beta_headers: None,
            ..
        } => true,
        RuntimeAdapter::OpenaiCompatible {
            replay_assistant_reasoning_details: None,
            normalize_usage: None,
            ..
        } => true,
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
            self.adapter,
            RuntimeAdapter::Anthropic {
                auth: AnthropicAuth::Bearer,
                ..
            }
        ) {
            return Err(Error::UnsupportedProbeAuthentication);
        }
        Ok(())
    }

    pub(crate) fn check_execution(&self) -> Result<(), Error> {
        check_execution(self.adapter)
    }
}

pub(crate) fn resolve<'a>(
    row: &Selection<'_>,
    facts: &'a ProviderFacts,
) -> Result<Route<'a>, Error> {
    let known = facts.models.get(row.model.id.as_str());
    let override_ = known.and_then(|model| model.runtime_override.as_ref());
    let requested_wire = row
        .overrides
        .and_then(|value| value.api_protocol)
        .or(row.model.api_protocol)
        .or_else(|| known.and_then(|model| model.api_protocol));
    let (wire, selected, uses_override) = facts.select_adapter(override_, requested_wire)?;
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
    let normalize_base_url = match selected {
        RuntimeAdapter::Anthropic {
            normalize_base_url, ..
        } => *normalize_base_url,
        RuntimeAdapter::OpenaiCompatible {
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
    let kind = match selected {
        RuntimeAdapter::OpenaiChat {} => ProviderKind::OpenaiChatCompletions,
        RuntimeAdapter::OpenaiCompatible { name, .. } => ProviderKind::OpenaiCompatible {
            name: if *name == AdapterName::Connection {
                row.connection.id.clone()
            } else {
                row.provider.to_owned()
            },
        },
        RuntimeAdapter::OpenaiResponses { responses }
        | RuntimeAdapter::OpenaiCodex { responses } => match responses {
            ResponsesContract::Openai { .. } => ProviderKind::OpenaiResponses,
            ResponsesContract::OpenResponses { contract } => ProviderKind::OpenResponses(*contract),
        },
        RuntimeAdapter::Anthropic { .. } => ProviderKind::Anthropic,
        RuntimeAdapter::Google {} | RuntimeAdapter::Cohere {} | RuntimeAdapter::Unavailable {} => {
            return Err(Error::UnsupportedProtocol);
        }
    };
    Ok(Route {
        wire,
        kind,
        base_url: url.to_string(),
        adapter: selected,
    })
}

#[cfg(test)]
mod tests;
