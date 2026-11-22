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

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ModelDiscovery {
    Protocol {
        #[serde(skip_serializing_if = "Option::is_none")]
        auth: Option<DiscoveryAuth>,
        #[serde(skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        query: Option<BTreeMap<String, String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        response_shape: Option<ResponseShape>,
        #[serde(skip_serializing_if = "Option::is_none")]
        model_protocols: Option<ModelProtocols>,
        #[serde(skip_serializing_if = "Option::is_none")]
        filter: Option<ModelFilter>,
    },
    Fireworks {
        accounts_path: String,
        public_account: String,
        query: BTreeMap<String, String>,
    },
    Cloudflare,
    Fallback {
        reason: String,
    },
    Ollama,
    Cohere,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DiscoveryAuth {
    GithubCopilot,
    OauthBearer,
    OpenaiCodex,
    None,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResponseShape {
    ArrayOrData,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelProtocols {
    Commandcode,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ModelFilter {
    LanguageModels,
    ToolCapable,
}
