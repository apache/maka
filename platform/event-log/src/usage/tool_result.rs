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

use maka_agent_facts::{
    accounting::{ToolResult, ToolStatus},
    tool_call::RejectionKind,
};
use serde::{Deserialize, de::Error};

// This boundary owns stored JSON text. Decode the chosen payload directly so
// arbitrary_precision does not turn its f64 into a tagged-enum Content map.
// Keep the public ToolResult's generic Deserialize contract independent of SQL.
pub(super) fn decode(json: &str) -> serde_json::Result<ToolResult> {
    // Internal-tag Content previously validated even variant-ignored values.
    maka_agent_facts::public_catalog::validate_json(json)?;
    if !json.trim_start().starts_with('{') {
        return Err(serde_json::Error::custom(
            "expected a stored tool result object",
        ));
    }
    #[derive(Deserialize)]
    struct Tag {
        kind: String,
    }
    let tag: Tag = serde_json::from_str(json)?;
    match tag.kind.as_str() {
        "rejected" => {
            #[derive(Deserialize)]
            struct Fields {
                #[serde(rename = "kind")]
                _kind: String,
                reason: RejectionKind,
            }
            let fields: Fields = serde_json::from_str(json)?;
            Ok(ToolResult::Rejected {
                reason: fields.reason,
            })
        }
        "settled" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Fields {
                #[serde(rename = "kind")]
                _kind: String,
                started_at: f64,
                outcome: ToolStatus,
            }
            let fields: Fields = serde_json::from_str(json)?;
            Ok(ToolResult::Settled {
                started_at: fields.started_at,
                outcome: fields.outcome,
            })
        }
        kind => Err(serde_json::Error::unknown_variant(
            kind,
            &["rejected", "settled"],
        )),
    }
}

#[cfg(test)]
mod tests;
