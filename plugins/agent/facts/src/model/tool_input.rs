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
use serde_json::Value;

/// Accepted model arguments, including malformed JSON that cannot authorize an effect.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    content = "data",
    rename_all = "snake_case",
    deny_unknown_fields
)]
pub enum ToolInput {
    Json(Value),
    InvalidJson { raw: String },
}

impl ToolInput {
    pub fn from_json(raw: String) -> Self {
        match serde_json::from_str(&raw) {
            Ok(value) => Self::Json(value),
            Err(_) => Self::InvalidJson { raw },
        }
    }

    pub fn as_json(&self) -> Option<&Value> {
        match self {
            Self::Json(value) => Some(value),
            Self::InvalidJson { .. } => None,
        }
    }

    /// Correction evidence appended to every refusal, including cancellation and recovery.
    pub fn invalid_json_diagnostic(&self) -> Option<String> {
        let Self::InvalidJson { raw } = self else {
            return None;
        };
        let error = serde_json::from_str::<Value>(raw).err().map_or_else(
            || "arguments were recorded as malformed JSON".into(),
            |error| error.to_string(),
        );
        let raw = serde_json::to_string(raw).expect("strings are JSON serializable");
        Some(format!(
            "Invalid tool arguments JSON: {error}\nRaw arguments: {raw}"
        ))
    }
}

impl From<Value> for ToolInput {
    fn from(value: Value) -> Self {
        Self::Json(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn malformed_arguments_retain_exact_raw_and_do_not_become_json_strings() {
        let input = ToolInput::from_json("  {\"n\":\n".into());
        assert_eq!(
            input,
            ToolInput::InvalidJson {
                raw: "  {\"n\":\n".into()
            }
        );
        assert_eq!(input.as_json(), None);
        assert_eq!(
            input.invalid_json_diagnostic().unwrap(),
            concat!(
                "Invalid tool arguments JSON: EOF while parsing a value at line 2 column 0\n",
                r#"Raw arguments: "  {\"n\":\n""#,
            ),
        );
        let encoded = serde_json::to_value(&input).unwrap();
        assert_eq!(
            encoded,
            json!({"kind":"invalid_json","data":{"raw":"  {\"n\":\n"}})
        );
        assert_eq!(serde_json::from_value::<ToolInput>(encoded).unwrap(), input);
    }

    #[test]
    fn valid_scalars_and_marker_shaped_objects_remain_json() {
        for (raw, expected) in [
            ("\"abc\"", json!("abc")),
            ("null", json!(null)),
            ("7", json!(7)),
            (
                "{\"kind\":\"invalid_json\",\"data\":{\"raw\":\"{\"}}",
                json!({"kind":"invalid_json","data":{"raw":"{"}}),
            ),
        ] {
            let input = ToolInput::from_json(raw.into());
            assert_eq!(input.as_json(), Some(&expected));
            assert_eq!(input.invalid_json_diagnostic(), None);
            let encoded = serde_json::to_value(&input).unwrap();
            assert_eq!(encoded, json!({"kind":"json","data":expected}));
            assert_eq!(serde_json::from_value::<ToolInput>(encoded).unwrap(), input);
        }
    }
}
