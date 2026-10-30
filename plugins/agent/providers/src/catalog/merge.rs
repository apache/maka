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

use super::ModelInfo;
use std::collections::BTreeMap;

pub(super) fn fill_metadata(model: &mut ModelInfo, shared: &ModelInfo) {
    model.display_name = model
        .display_name
        .take()
        .or_else(|| shared.display_name.clone());
    model.description = model
        .description
        .take()
        .or_else(|| shared.description.clone());
    model.knowledge_cutoff = model
        .knowledge_cutoff
        .take()
        .or_else(|| shared.knowledge_cutoff.clone());
    model.context_window = model.context_window.or(shared.context_window);
    model.input_limit = model.input_limit.or(shared.input_limit);
    model.max_output_tokens = model.max_output_tokens.or(shared.max_output_tokens);
}

/// Only an exact models.dev OpenRouter entry may connect a live OpenRouter ID
/// to the canonical ID shared by another models.dev route. Slugs are not IDs.
pub(super) fn shared_metadata(
    bridges: &BTreeMap<String, String>,
    router: &[ModelInfo],
) -> BTreeMap<String, ModelInfo> {
    let mut groups: BTreeMap<&str, Vec<&ModelInfo>> = BTreeMap::new();
    for model in router {
        let canonical = bridges
            .get(&model.id)
            .map_or(model.id.as_str(), String::as_str);
        groups.entry(canonical).or_default().push(model);
    }
    groups
        .into_iter()
        .map(|(id, models)| {
            let exact = models.iter().find(|model| model.id == id);
            (
                id.to_owned(),
                ModelInfo {
                    id: id.to_owned(),
                    display_name: unanimous(&models, |model| model.display_name.as_ref()),
                    description: unanimous(&models, |model| model.description.as_ref()),
                    knowledge_cutoff: unanimous(&models, |model| model.knowledge_cutoff.as_ref()),
                    context_window: exact
                        .and_then(|model| model.context_window)
                        .or_else(|| unanimous(&models, |model| model.context_window.as_ref())),
                    input_limit: exact
                        .and_then(|model| model.input_limit)
                        .or_else(|| unanimous(&models, |model| model.input_limit.as_ref())),
                    max_output_tokens: exact
                        .and_then(|model| model.max_output_tokens)
                        .or_else(|| unanimous(&models, |model| model.max_output_tokens.as_ref())),
                    ..Default::default()
                },
            )
        })
        .collect()
}

fn unanimous<T: Clone + PartialEq>(
    models: &[&ModelInfo],
    field: impl Fn(&ModelInfo) -> Option<&T>,
) -> Option<T> {
    let mut values = models.iter().filter_map(|model| field(model));
    let first = values.next()?;
    values.all(|value| value == first).then(|| first.clone())
}

pub(super) fn reported(mut reported: ModelInfo, public: &ModelInfo) -> ModelInfo {
    let own_efforts = reported.thinking_levels.is_some();
    let reasoning_disabled = reported.capabilities.and_then(|caps| caps.reasoning) == Some(false);
    macro_rules! fill {
        ($($field:ident),* $(,)?) => { $(if reported.$field.is_none() { reported.$field = public.$field.clone(); })* };
    }
    fill!(
        display_name,
        description,
        api_protocol,
        context_window,
        input_limit,
        max_output_tokens,
        supports_reasoning_summary,
        knowledge_cutoff,
        structured_output,
        last_updated,
        modalities,
        image_input
    );
    if !own_efforts && !reasoning_disabled {
        fill!(thinking_levels, default_thinking_level);
    }
    if let Some(defaults) = public.capabilities {
        let caps = reported.capabilities.get_or_insert_default();
        macro_rules! fill_caps {
            ($($field:ident),* $(,)?) => { $(caps.$field = caps.$field.or(defaults.$field);)* };
        }
        fill_caps!(
            chat,
            vision,
            reasoning,
            function_calling,
            parallel_tool_calls,
            image_generation,
            web_search
        );
    }
    reported
}
