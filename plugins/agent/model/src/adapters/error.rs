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

use crate::{ModelError, ProviderFailure, ProviderFailureReason};
use maka_provider_protocol::output::ProviderError;
use serde_json::Value;

#[derive(Default)]
pub(super) struct Evidence {
    pub observed: bool,
    pub retry_at_unix_ms: Option<u64>,
    pub unsafe_replay: bool,
}
impl Evidence {
    pub fn interrupted(
        &self,
        reason: ProviderFailureReason,
        message: impl Into<String>,
    ) -> ModelError {
        ModelError::Provider(ProviderFailure::new(
            reason,
            message,
            !self.unsafe_replay,
            self.retry_at_unix_ms,
        ))
    }
    pub fn transport(&self, error: ModelError) -> ModelError {
        match error {
            ModelError::Provider(failure) => {
                ModelError::Provider(failure.restrict_replay(!self.unsafe_replay))
            }
            error => error,
        }
    }
    pub fn provider(
        &self,
        error: ProviderError,
        anthropic: bool,
        retry_at_unix_ms: Option<u64>,
    ) -> ModelError {
        if error
            .status
            .is_some_and(|status| !(100..600).contains(&status))
        {
            return ModelError::Adapter("invalid model HTTP failure status".into());
        }
        let retry_at_unix_ms = retry_at_unix_ms.or(self.retry_at_unix_ms);
        let mut records = vec![&error.data];
        if let Some(inner) = error.data.get("error") {
            records.push(inner);
        }
        let identifiers = records
            .iter()
            .flat_map(|record| [record.get("code"), record.get("type")])
            .flatten()
            .filter_map(Value::as_str)
            .chain(error.kind.as_deref())
            .chain(error.code.as_ref().and_then(Value::as_str))
            .map(str::to_ascii_lowercase)
            .collect::<Vec<_>>();
        let has = |values: &[&str]| identifiers.iter().any(|id| values.contains(&id.as_str()));
        let too_long = anthropic
            && matches!(error.status, None | Some(400))
            && records.iter().any(|record| {
                record.get("type").and_then(Value::as_str) == Some("invalid_request_error")
                    && record
                        .get("message")
                        .and_then(Value::as_str)
                        .is_some_and(prompt_too_long)
            });
        if has(&["context_length_exceeded", "model_context_window_exceeded"]) || too_long {
            return ModelError::ContextOverflow {
                observed_output: self.observed,
            };
        }
        let positive_quota = has(&[
            "insufficient_quota",
            "insufficient_balance",
            "freeusagelimiterror",
        ]);
        let permanent = matches!(error.status, Some(401 | 403))
            || (error.status == Some(402) && !positive_quota)
            || has(&[
                "request_too_large",
                "authentication_error",
                "permission_error",
                "invalid_api_key",
            ]);
        let reason = if permanent {
            None
        } else if positive_quota {
            Some(ProviderFailureReason::QuotaExhausted)
        } else if has(&["resource-exhausted"]) {
            Some(ProviderFailureReason::ProviderUnavailable)
        } else if error.status == Some(429) || has(&["rate_limit_error", "rate_limit_exceeded"]) {
            Some(ProviderFailureReason::RateLimit)
        } else if matches!(error.status, Some(408 | 500..=599))
            || has(&[
                "api_error",
                "server_error",
                "overloaded_error",
                "service_unavailable",
            ])
        {
            Some(ProviderFailureReason::ProviderUnavailable)
        } else {
            None
        };
        if let Some(reason) = reason {
            return ModelError::Provider(
                ProviderFailure::new(
                    reason,
                    error
                        .message
                        .unwrap_or_else(|| provider_message(error.status)),
                    !self.unsafe_replay,
                    retry_at_unix_ms,
                )
                .with_diagnostic(
                    error.status,
                    error.code.as_ref().and_then(|code| match code {
                        Value::String(value) => Some(value.clone()),
                        Value::Number(value) => Some(value.to_string()),
                        _ => None,
                    }),
                ),
            );
        }
        if let Some(status) = error
            .status
            .filter(|s| (100..600).contains(s) && !(200..300).contains(s))
        {
            return ModelError::Http {
                status,
                message: error.message,
            };
        }
        ModelError::Adapter(
            error
                .message
                .unwrap_or_else(|| provider_message(error.status)),
        )
    }
}
fn provider_message(status: Option<u16>) -> String {
    status.map_or_else(
        || "provider request failed".into(),
        |status| format!("model HTTP request failed (status {status})"),
    )
}
fn prompt_too_long(message: &str) -> bool {
    let Some(body) = message.strip_prefix("prompt is too long: ") else {
        return false;
    };
    let Some(body) = body.strip_suffix(" maximum") else {
        return false;
    };
    let Some((input, maximum)) = body.split_once(" tokens > ") else {
        return false;
    };
    let parse = |s: &str| {
        (!s.is_empty() && s.len() <= 16 && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse::<u64>().ok())
            .flatten()
            .filter(|n| *n <= 9_007_199_254_740_991)
    };
    matches!((parse(input), parse(maximum)), (Some(input), Some(maximum)) if maximum > 0 && input > maximum)
}
pub(super) fn http_error(status: u16, bytes: &[u8]) -> ProviderError {
    let data: Value = if bytes.len() <= 64 * 1024 {
        serde_json::from_slice(bytes).unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let record = data.get("error").unwrap_or(&data);
    ProviderError {
        message: record
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_owned),
        kind: record
            .get("type")
            .and_then(Value::as_str)
            .map(str::to_owned),
        code: record.get("code").cloned(),
        status: Some(status),
        retryable: None,
        data,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn classify(status: u16, value: Value, anthropic: bool) -> ModelError {
        Evidence::default().provider(
            http_error(status, &serde_json::to_vec(&value).unwrap()),
            anthropic,
            None,
        )
    }

    #[test]
    fn anthropic_overflow_relation_is_exact_and_route_scoped() {
        let value = |message| json!({"error":{"type":"invalid_request_error","message":message}});
        let valid = "prompt is too long: 200001 tokens > 200000 maximum";
        assert!(matches!(
            classify(400, value(valid), true),
            ModelError::ContextOverflow { .. }
        ));
        assert!(matches!(
            classify(400, value(valid), false),
            ModelError::Http { .. }
        ));
        assert!(matches!(
            classify(413, value(valid), true),
            ModelError::Http { .. }
        ));
        for message in [
            "prompt is too long",
            "prompt is too long: 1 tokens > 2 maximum",
            "quota: prompt is too long: 3 tokens > 2 maximum",
            "prompt is too long: 3 tokens > 2 maximum; output limit",
            "prompt is too long: 9999999999999999 tokens > 2 maximum",
            "prompt is too long: 3 tokens > 0 maximum",
        ] {
            assert!(
                matches!(classify(400, value(message), true), ModelError::Http { .. }),
                "{message}"
            );
        }
    }
}
