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

use super::wire_limit;
use maka_runtime::configuration::{
    ConnectionCatalogEntry, ModelCatalogEntry, ModelInfo, ModelModality,
};

pub(super) fn resolve(
    row: &ConnectionCatalogEntry,
    reported: &ModelInfo,
    default: Option<&str>,
) -> ModelCatalogEntry {
    let id = reported.id.trim();
    let profile = row
        .model_overrides
        .as_ref()
        .and_then(|profiles| profiles.get(id));
    let effective = profile.map(|profile| profile.apply(reported));
    let model = effective.as_ref().unwrap_or(reported);
    let capabilities = model.capabilities.unwrap_or_default();
    let no_text = model.modalities.as_ref().is_some_and(|modalities| {
        !modalities.output.is_empty() && !modalities.output.contains(&ModelModality::Text)
    });
    let chat = capabilities.chat;
    let unsupported = chat == Some(false)
        || (chat != Some(true) && no_text)
        || (capabilities.image_generation == Some(true)
            && chat != Some(true)
            && capabilities.reasoning != Some(true)
            && capabilities.function_calling != Some(true));
    let thinking_levels = profile
        .and_then(|p| p.thinking_levels.clone())
        .or_else(|| model.thinking_levels.clone())
        .unwrap_or_default();
    ModelCatalogEntry {
        id: id.into(),
        capabilities,
        can_use_as_chat_default: !unsupported,
        is_default: default == Some(id),
        supports_vision: capabilities.vision.unwrap_or(false),
        default_supports_vision: reported.capabilities.and_then(|c| c.vision),
        default_context_window: reported.context_window,
        default_input_limit: reported.input_limit,
        default_thinking_level: profile
            .and_then(|p| p.default_thinking_level)
            .or(model.default_thinking_level)
            .filter(|level| thinking_levels.contains(level)),
        thinking_levels,
        input_limit: model.input_limit,
        compaction_threshold: profile.and_then(|p| p.compaction_threshold),
        display_name: model.display_name.as_deref().map(|s| wire_limit(s, 512)),
        description: model.description.as_deref().map(|s| wire_limit(s, 2048)),
        context_window: model.context_window,
        knowledge_cutoff: model.knowledge_cutoff.clone(),
    }
}
