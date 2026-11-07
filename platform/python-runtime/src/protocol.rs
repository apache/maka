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

use maka_code_runtime::{CellDiagnostic, ToolMetadata};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

#[derive(Serialize, Deserialize)]
pub(crate) struct Start {
    pub source: String,
    pub names: Vec<String>,
    pub metadata: Vec<ToolMetadata>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Request {
    Ready,
    Call {
        id: u32,
        name: String,
        args: Vec<Value>,
        kwargs: serde_json::Map<String, Value>,
    },
    Sleep {
        id: u32,
        duration: Duration,
        asynchronous: bool,
    },
    Resolve {
        ids: Vec<u32>,
    },
    Complete {
        error: Option<CellDiagnostic>,
    },
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Reply {
    Return {
        value: Value,
    },
    Error {
        error: CellDiagnostic,
    },
    Pending,
    Resolved {
        results: Vec<(u32, Result<Value, CellDiagnostic>)>,
    },
}

// Payloads are bounded separately so private framing cannot change which JSON
// values a Python cell can send or receive.
pub(crate) const MAX_JSON_DEPTH: usize = 128;
pub(crate) fn validate_json(value: &Value) -> Result<(), CellDiagnostic> {
    let mut stack = vec![(value, 0)];
    while let Some((value, depth)) = stack.pop() {
        if depth >= MAX_JSON_DEPTH {
            return Err(crate::helpers::error(
                "JSON value exceeds the transport nesting limit",
            ));
        }
        match value {
            Value::Array(values) => stack.extend(values.iter().map(|value| (value, depth + 1))),
            Value::Object(values) => stack.extend(values.values().map(|value| (value, depth + 1))),
            _ => {}
        }
    }
    Ok(())
}
pub(crate) fn decode<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, serde_json::Error> {
    // Resolved { results: [(id, Result<Value, Diagnostic>)] } adds four
    // containers around a payload. Check framing before recursive serde code
    // runs: a corrupted worker must not exhaust the Host stack.
    let mut depth = 0usize;
    let mut quoted = false;
    let mut escaped = false;
    for byte in bytes {
        if quoted {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                quoted = false;
            }
        } else {
            match byte {
                b'"' => quoted = true,
                b'[' | b'{' => {
                    depth += 1;
                    if depth > MAX_JSON_DEPTH + 4 {
                        return Err(serde_json::Error::io(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "worker frame nesting limit exceeded",
                        )));
                    }
                }
                b']' | b'}' => depth = depth.saturating_sub(1),
                _ => {}
            }
        }
    }
    let mut decoder = serde_json::Deserializer::from_slice(bytes);
    decoder.disable_recursion_limit();
    let value = T::deserialize(&mut decoder)?;
    decoder.end()?;
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frames_are_bounded_before_recursive_decoding_and_strings_are_not_structure() {
        let frame = format!(
            "{}0{}",
            "[".repeat(MAX_JSON_DEPTH + 5),
            "]".repeat(MAX_JSON_DEPTH + 5)
        );
        assert!(
            decode::<Value>(frame.as_bytes())
                .unwrap_err()
                .to_string()
                .contains("nesting limit")
        );
        let text = format!("{}\\\"{}", "[".repeat(1000), "}".repeat(1000));
        assert_eq!(
            decode::<Value>(&serde_json::to_vec(&text).unwrap()).unwrap(),
            Value::String(text)
        );
    }
}
