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

use super::{Selection, ThinkingLevel, Value, Wire};

pub(super) fn responses(
    row: &Selection<'_>,
    level: Option<ThinkingLevel>,
    parallel: bool,
) -> Value {
    let model = row.model.id.as_str();
    let mut options = super::openai(
        Wire::OpenaiResponses,
        level,
        row.model.supports_reasoning_summary.unwrap_or(false),
        parallel,
    );
    options["openai"]["forceReasoning"] = Value::Bool(true);
    if supports_fast(model)
        && let Some(tier) = row
            .overrides
            .and_then(|profile| profile.service_tier.as_ref())
    {
        options["openai"]["serviceTier"] = serde_json::json!(tier);
    }
    options
}

// core/model-thinking.ts supportsRelayFastServiceTier deliberately tests the
// bare model ID: a relay/ prefix must not inherit priority processing support.
fn supports_fast(model: &str) -> bool {
    if model.starts_with("gpt-4") {
        return true;
    }
    if let Some(tail) = model.strip_prefix('o') {
        let version = tail.split('-').next().unwrap_or(tail);
        return version_at_least(version, '3');
    }
    let Some(tail) = model.strip_prefix("gpt-") else {
        return false;
    };
    let (version, variant) = tail
        .split_once('-')
        .map_or((tail, None), |(version, variant)| (version, Some(variant)));
    if variant.is_some_and(|value| {
        value.is_empty() || value.starts_with("nano") || value.starts_with("chat")
    }) {
        return false;
    }
    let (major, minor) = version
        .split_once('.')
        .map_or((version, None), |(major, minor)| (major, Some(minor)));
    version_at_least(major, '5')
        && minor.is_none_or(|value| !value.is_empty() && value.bytes().all(|c| c.is_ascii_digit()))
}

fn version_at_least(version: &str, minimum: char) -> bool {
    if version.is_empty() || !version.bytes().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let significant = version.trim_start_matches('0');
    significant.len() > 1
        || significant
            .chars()
            .next()
            .is_some_and(|digit| digit >= minimum)
}
