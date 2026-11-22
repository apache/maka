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
use super::Wire;
use maka_agent_ports::provider::Error;
use serde_json::Value;

/// The declared output capacity is the default reply budget. Explicit budgets
/// are capped by that capacity before subtracting a fixed Anthropic thinking budget.
pub(super) fn resolve(
    connection: &Selection<'_>,
    wire: Wire,
    options: &Value,
) -> Result<Option<u64>, Error> {
    let requested = connection
        .overrides
        .and_then(|value| value.max_output_tokens);
    let limit = connection.model.max_output_tokens;
    let limit = match (requested, limit) {
        (Some(requested), Some(capacity)) => Some(requested.min(capacity)),
        (requested, capacity) => requested.or(capacity),
    };
    limit
        .map(|limit| {
            if wire == Wire::AnthropicMessages {
                subtract_budget(limit, options)
            } else {
                Ok(limit)
            }
        })
        .transpose()
}

fn subtract_budget(limit: u64, options: &Value) -> Result<u64, Error> {
    let thinking = &options["anthropic"]["thinking"];
    let fixed = if thinking["type"] == "enabled" {
        thinking["budgetTokens"].as_u64().unwrap_or(0)
    } else {
        0
    };
    limit
        .checked_sub(fixed)
        .filter(|limit| *limit > 0)
        .ok_or(Error::InsufficientOutputBudget)
}
