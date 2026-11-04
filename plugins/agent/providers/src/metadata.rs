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

use maka_agent_facts::configuration::{ConnectionCatalogEntry, ModelInfo, ModelOverride};
use std::sync::Arc;

pub fn model_request(
    row: &ConnectionCatalogEntry,
    model: &str,
    overrides: Option<ModelOverride>,
) -> maka_agent_ports::provider::Resolve {
    maka_agent_ports::provider::Resolve {
        connection: maka_agent_ports::provider::Connection {
            id: row.connection_id.clone(),
            revision: row.revision,
            configuration: row.configuration.clone(),
        },
        model: row
            .models
            .iter()
            .find(|info| info.id == model)
            .cloned()
            .unwrap_or_else(|| ModelInfo::new(model)),
        overrides,
        thinking_level: None,
    }
}
pub async fn model_metadata(
    row: &ConnectionCatalogEntry,
    model: &str,
    overrides: Option<ModelOverride>,
    snapshot: Arc<crate::catalog::Snapshot>,
) -> Result<crate::api::ModelMetadata, String> {
    let request = model_request(row, model, overrides);
    if row.provider.package_id == crate::codex::ID {
        let overrides = &request.overrides;
        let default_thinking_level = overrides.as_ref().and_then(|o| o.default_thinking_level);
        let resolved = crate::definition(&row.provider, snapshot.clone())?
            .prepare(request)
            .await
            .map_err(|error| error.to_string())?;
        Ok(crate::api::ModelMetadata {
            info: resolved.info,
            thinking_levels: resolved.thinking_levels,
            default_thinking_level,
        })
    } else {
        crate::api::ApiProviders::model_metadata(
            &row.provider.name,
            snapshot,
            request.connection,
            request.model,
            request.overrides,
        )
    }
}
