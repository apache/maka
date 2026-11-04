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

use super::{ExecutionRoute, Model, ModelInfo, ModelOverride, ModelRequestContext, RunError};
use maka_agent_facts::{configuration::ModelCapabilities, model::request::ProviderKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub(super) enum Controls {
    Captured {
        route: ExecutionRoute,
        model_override: Option<ModelOverride>,
        body_overlay: Option<Value>,
    },
    // Before account observations were separated, admission stored effective request controls.
    Frozen {
        context: ModelRequestContext,
        provider_configuration: Value,
        basis: FrozenRequest,
    },
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FrozenRequest {
    adapter: String,
    protocol: ProviderKind,
    base_url: String,
    capabilities: ModelCapabilities,
    options: Value,
    main_output_limit: Option<u64>,
    body_overlay: Option<Value>,
}

impl Controls {
    pub(super) fn model_override(&self) -> Option<Cow<'_, ModelOverride>> {
        match self {
            Self::Captured { model_override, .. } => model_override.as_ref().map(Cow::Borrowed),
            Self::Frozen { basis, .. } => Some(Cow::Owned(ModelOverride {
                adapter: Some(basis.adapter.clone()),
                ..Default::default()
            })),
        }
    }

    pub(super) fn matches(&self, model: &Model) -> bool {
        match self {
            Self::Captured { route, .. } => route.matches(model),
            Self::Frozen { basis, .. } => {
                basis.adapter == model.adapter
                    && basis.protocol == model.protocol
                    && basis.base_url == model.base_url
            }
        }
    }

    pub(super) fn apply(&self, model: &mut Model) {
        if let Self::Frozen { basis, .. } = self {
            model.provider_options = basis.options.clone();
            model.main_output_limit = basis.main_output_limit;
            model.info.capabilities = Some(basis.capabilities);
        }
    }

    pub(super) fn context(
        &self,
        row: &maka_agent_facts::configuration::ConnectionCatalogEntry,
        model: &ModelInfo,
    ) -> Result<ModelRequestContext, RunError> {
        match self {
            Self::Captured { model_override, .. } => {
                super::request_context(row, model, model_override.as_ref())
            }
            Self::Frozen { context, .. } => Ok(context.clone()),
        }
    }

    pub(super) fn body_overlay(&self) -> Option<&Value> {
        match self {
            Self::Captured { body_overlay, .. } => body_overlay.as_ref(),
            Self::Frozen { basis, .. } => basis.body_overlay.as_ref(),
        }
    }
}
