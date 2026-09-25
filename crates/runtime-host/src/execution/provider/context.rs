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
use super::unavailable;
use maka_protocol::OperationError;
use maka_runtime::{
    configuration::{ConnectionCatalogEntry, ModelInfo},
    context::ModelRequestContext,
};

/// Providers return a resolved SDK reply budget; advertised ceilings remain
/// total output. Normalize the ceiling/default once, never the resolved budget.
pub(super) fn output_limit(model: &maka_plugins::provider::Model) -> Result<u64, OperationError> {
    let thinking = if matches!(model.protocol, maka_model::ProviderKind::Anthropic)
        && model.provider_options["anthropic"]["thinking"]["type"] == "enabled"
    {
        model.provider_options["anthropic"]["thinking"]["budgetTokens"]
            .as_u64()
            .unwrap_or(0)
    } else {
        0
    };
    let text_budget = |total: u64| {
        total
            .checked_sub(thinking)
            .filter(|limit| *limit > 0)
            .ok_or_else(|| unavailable("Model output limit does not leave a positive text budget"))
    };
    let ceiling = model.info.max_output_tokens.map(text_budget).transpose()?;
    match (model.main_output_limit, ceiling) {
        (Some(selected), Some(ceiling)) => Ok(selected.min(ceiling)),
        (Some(selected), None) => Ok(selected),
        (None, Some(ceiling)) => Ok(ceiling),
        (None, None) => text_budget(8000),
    }
}

pub(super) fn resolve(
    connection: &ConnectionCatalogEntry,
    model: &ModelInfo,
) -> Result<ModelRequestContext, OperationError> {
    let capacity = model.context_window.ok_or_else(|| {
        unavailable("Model context window is unknown; set contextWindow in the model profile")
    })?;
    if matches!((model.context_window, model.input_limit), (Some(context), Some(input)) if input > context)
    {
        return Err(unavailable("Model input limit exceeds its context window"));
    }
    let declaration = connection
        .model_overrides
        .as_ref()
        .and_then(|values| values.get(&model.id));
    let input_ceiling = model
        .input_limit
        .map_or(capacity, |limit| capacity.min(limit));
    // This proactive trigger uses observed usage, not a proof that the next
    // prompt and its selected output budget fit. Leave 15% for further work.
    let automatic = ((u128::from(input_ceiling) * 85) / 100) as u64;
    Ok(ModelRequestContext {
        provider_id: connection.provider.name.clone(),
        context_window: Some(input_ceiling),
        model_context_window: Some(capacity),
        declared_window: declaration
            .and_then(|value| value.compaction_threshold)
            .or(Some(automatic.max(1))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compaction_requires_total_capacity_and_preserves_manual_threshold() {
        let mut connection: ConnectionCatalogEntry = serde_json::from_value(json!({
            "connectionId":"connection","revision":1,"slug":"fixture","name":"Fixture",
            "provider":{"packageId":"fixture","entryId":"fixture","scope":"profile","name":"model"},
            "configuration":{},"enabled":true,"enabledModelIds":["custom"],
            "models":[{"id":"custom","contextWindow":128000,"inputLimit":96000}],
            "modelOverrides":{"custom":{"compactionThreshold":64000}}
        }))
        .unwrap();
        let context = resolve(&connection, &connection.models[0]).unwrap();
        assert_eq!(context.model_context_window, Some(128000));
        assert_eq!(context.context_window, Some(96000));
        assert_eq!(context.declared_window, Some(64000));
        connection.models[0].context_window = None;
        assert!(resolve(&connection, &connection.models[0]).is_err());
        connection.models[0].context_window = Some(1_000_000);
        for (input, maximum, requested, manual, expected) in [
            (None, Some(128_000), None, None, Some(850_000)),
            (Some(800_000), Some(128_000), None, None, Some(680_000)),
            (None, Some(128_000), Some(64_000), None, Some(850_000)),
            (None, Some(128_000), Some(256_000), None, Some(850_000)),
            (None, None, Some(128_000), None, Some(850_000)),
            (None, None, None, None, Some(850_000)),
            (None, Some(1_000_000), None, None, Some(850_000)),
            (None, None, None, Some(700_000), Some(700_000)),
        ] {
            let model = &mut connection.models[0];
            model.input_limit = input;
            model.max_output_tokens = maximum;
            let profile = connection
                .model_overrides
                .as_mut()
                .unwrap()
                .get_mut("custom")
                .unwrap();
            profile.max_output_tokens = requested;
            profile.compaction_threshold = manual;
            assert_eq!(
                resolve(&connection, &connection.models[0])
                    .unwrap()
                    .declared_window,
                expected,
                "input={input:?}, output={maximum:?}, requested={requested:?}, manual={manual:?}"
            );
        }
    }
}
