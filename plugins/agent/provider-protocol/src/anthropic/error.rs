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

use crate::output::ProviderError;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Envelope {
    Error { error: Detail },
}
#[derive(Deserialize)]
struct Detail {
    r#type: String,
    message: String,
}

/// HTTP status supplies retry policy; a valid vendor envelope supplies the
/// diagnostic. HTML, truncated JSON and empty bodies retain only the status.
pub fn http_failure(status: u16, body: &[u8]) -> ProviderError {
    let raw = serde_json::from_slice::<Value>(body).ok();
    let parsed = raw
        .as_ref()
        .and_then(|v| serde_json::from_value::<Envelope>(v.clone()).ok());
    let (message, code, data) = match parsed {
        Some(Envelope::Error { error }) => {
            let data = serde_json::json!({"type":"error","error":{"type":error.r#type,"message":error.message}});
            (Some(error.message), Some(Value::String(error.r#type)), data)
        }
        None => (None, None, Value::Null),
    };
    ProviderError {
        kind: code.as_ref().and_then(Value::as_str).map(str::to_owned),
        message,
        code,
        status: Some(status),
        retryable: Some(matches!(status, 408 | 409 | 429) || status >= 500),
        data,
    }
}
