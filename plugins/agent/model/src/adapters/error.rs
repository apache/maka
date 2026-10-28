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
            None,
        ))
    }
    pub fn transport(&self, error: ModelError) -> ModelError {
        match error {
            ModelError::Provider(failure) => ModelError::Provider(ProviderFailure::new(
                failure.reason(),
                failure.message(),
                !self.unsafe_replay,
                failure.retry_after().map(|d| d.as_millis() as u64),
            )),
            error => error,
        }
    }
    pub fn provider(
        &self,
        error: ProviderError,
        anthropic: bool,
        retry_after: Option<u64>,
    ) -> ModelError {
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
            && error.status == Some(400)
            && records.iter().any(|record| {
                record.get("type").and_then(Value::as_str) == Some("invalid_request_error")
                    && record
                        .get("message")
                        .and_then(Value::as_str)
                        .is_some_and(prompt_too_long)
            });
        if has(&[
            "context_length_exceeded",
            "model_context_window_exceeded",
            "request_too_large",
        ]) || too_long
        {
            return ModelError::ContextOverflow {
                observed_output: self.observed,
            };
        }
        let permanent = matches!(error.status, Some(401..=403))
            || has(&[
                "insufficient_quota",
                "insufficient_balance",
                "quota_exceeded",
                "freeusagelimiterror",
                "authentication_error",
                "permission_error",
                "invalid_api_key",
            ]);
        let reason = if permanent {
            None
        } else if has(&["resource-exhausted"]) {
            Some(ProviderFailureReason::ProviderUnavailable)
        } else if error.status == Some(429) || has(&["rate_limit_error"]) {
            Some(ProviderFailureReason::RateLimit)
        } else if matches!(error.status, Some(408 | 500..=599))
            || has(&["server_error", "overloaded_error"])
        {
            Some(ProviderFailureReason::ProviderUnavailable)
        } else {
            None
        };
        if let Some(reason) = reason {
            return ModelError::Provider(ProviderFailure::new(
                reason,
                error
                    .message
                    .unwrap_or_else(|| provider_message(error.status)),
                !self.unsafe_replay,
                retry_after,
            ));
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
    fn overflow_requires_bounded_structured_provider_evidence() {
        for value in [
            json!({"code":"context_length_exceeded"}),
            json!({"error":{"code":"context_length_exceeded"}}),
            json!({"type":"request_too_large"}),
            json!({"code":"model_context_window_exceeded"}),
        ] {
            assert!(matches!(
                classify(400, value, false),
                ModelError::ContextOverflow {
                    observed_output: false
                }
            ));
        }
        for value in [
            json!({"message":"context_length_exceeded"}),
            json!({"code":"rate_limit_error","message":"context overflow"}),
            json!({"prompt":{"code":"context_length_exceeded"}}),
        ] {
            assert!(!matches!(
                classify(400, value, false),
                ModelError::ContextOverflow { .. }
            ));
        }
        assert!(matches!(
            classify(413, json!({}), false),
            ModelError::Http { status: 413, .. }
        ));
        let mut body = vec![b' '; 65537];
        body.extend_from_slice(br#"{"error":{"code":"context_length_exceeded"}}"#);
        assert!(matches!(
            Evidence::default().provider(http_error(400, &body), false, None),
            ModelError::Http { status: 400, .. }
        ));
        assert!(matches!(
            Evidence::default().provider(http_error(400, b"not JSON"), false, None),
            ModelError::Http { status: 400, .. }
        ));
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

    #[test]
    fn http_diagnostics_preserve_messages_and_permanent_failures_override_retry_signals() {
        for status in [100, 199, 300, 400, 401, 402, 403, 404] {
            let error = classify(
                status,
                json!({"error":{"message":"invalid request field"}}),
                false,
            );
            assert!(matches!(error, ModelError::Http { status: actual, .. } if actual == status));
            assert_eq!(
                error.to_string(),
                format!("model HTTP request failed (status {status}): invalid request field")
            );
            assert_eq!(
                error.failure_cause(),
                Some(maka_agent_facts::model::error::ModelFailureCause::Http { status })
            );
        }
        for status in [401, 402, 403, 429] {
            assert!(matches!(
                classify(
                    status,
                    json!({"error":{"code":"insufficient_quota"}}),
                    false
                ),
                ModelError::Http { .. }
            ));
        }
        for (status, reason) in [
            (429, ProviderFailureReason::RateLimit),
            (408, ProviderFailureReason::ProviderUnavailable),
            (503, ProviderFailureReason::ProviderUnavailable),
        ] {
            let ModelError::Provider(failure) =
                Evidence::default().provider(http_error(status, b"{}"), false, Some(1234))
            else {
                panic!("typed provider failure")
            };
            assert_eq!(failure.reason(), reason);
            assert!(failure.replay_safe());
            assert_eq!(failure.retry_after().unwrap().as_millis(), 1234);
        }
    }
}
