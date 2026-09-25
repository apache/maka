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

pub(super) fn resolve(
    connection: &ConnectionCatalogEntry,
    model: &ModelInfo,
) -> Result<ModelRequestContext, OperationError> {
    if matches!((model.context_window, model.input_limit), (Some(context), Some(input)) if input > context)
    {
        return Err(unavailable("Model input limit exceeds its context window"));
    }
    let declaration = connection
        .model_overrides
        .as_ref()
        .and_then(|values| values.get(&model.id));
    let output = match (
        declaration.and_then(|value| value.max_output_tokens),
        model.max_output_tokens,
    ) {
        (Some(requested), Some(capacity)) => Some(requested.min(capacity)),
        (requested, capacity) => requested.or(capacity),
    };
    // Reserve the entire output budget, respect any independent input ceiling,
    // then leave 5% for input growth since the last measured request.
    let automatic = model
        .context_window
        .zip(output)
        .and_then(|(window, output)| window.checked_sub(output))
        .map(|budget| model.input_limit.map_or(budget, |limit| budget.min(limit)))
        .map(|budget| budget - budget.div_ceil(20))
        .filter(|threshold| *threshold > 0);
    Ok(ModelRequestContext {
        provider_id: connection.provider.name.clone(),
        context_window: model
            .context_window
            .into_iter()
            .chain(model.input_limit)
            .min(),
        model_context_window: model.context_window,
        declared_window: declaration
            .and_then(|value| value.compaction_threshold)
            .or(automatic),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn compaction_reserves_output_and_headroom_unless_manually_overridden() {
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
        let context = resolve(&connection, &connection.models[0]).unwrap();
        assert_eq!(context.context_window, Some(96000));
        assert_eq!(
            context.model_context_window, None,
            "input-only limits cannot become full capacity"
        );
        connection.models[0].context_window = Some(1_000_000);
        for (input, maximum, requested, manual, expected) in [
            (None, Some(128_000), None, None, Some(828_400)),
            (Some(800_000), Some(128_000), None, None, Some(760_000)),
            (None, Some(128_000), Some(64_000), None, Some(889_200)),
            (None, Some(128_000), Some(256_000), None, Some(828_400)),
            (None, None, Some(128_000), None, Some(828_400)),
            (None, None, None, None, None),
            (None, Some(1_000_000), None, None, None),
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
