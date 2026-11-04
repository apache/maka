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

mod overflow;

use crate::{ModelError, ProviderFailure, ProviderFailureReason};
use maka_provider_protocol::output::ProviderError;
use serde_json::Value;

#[derive(Clone, Copy, Default)]
pub(super) enum QuotaScope {
    #[default]
    Generic,
    Zai,
}
impl QuotaScope {
    pub fn endpoint(endpoint: &str) -> Self {
        match reqwest::Url::parse(endpoint)
            .ok()
            .as_ref()
            .and_then(|url| url.host_str())
        {
            Some("api.z.ai" | "open.bigmodel.cn") => Self::Zai,
            _ => Self::Generic,
        }
    }
}

#[derive(Default)]
pub(super) struct Evidence {
    pub quota_scope: QuotaScope,
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
    pub fn provider(&self, error: ProviderError, retry_at_unix_ms: Option<u64>) -> ModelError {
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
        let identifiers = overflow::identifiers(&error);
        let has = |values: &[&str]| identifiers.iter().any(|id| values.contains(&id.as_str()));
        if overflow::rejected(&error, &identifiers) {
            return ModelError::ContextOverflow {
                observed_output: self.observed,
            };
        }
        let positive_quota = has(&[
            "insufficient_quota",
            "insufficient_balance",
            "freeusagelimiterror",
            "exceeded_current_quota_error",
        ]) || (matches!(self.quota_scope, QuotaScope::Zai)
            // Z.ai documents these string codes in its error envelope.
            // https://docs.z.ai/api-reference/api-code
            && records
                .iter()
                .filter_map(|record| record.get("code").and_then(Value::as_str))
                .chain(error.code.as_ref().and_then(Value::as_str))
                .any(|code| matches!(code, "1308" | "1310" | "1316" | "1317" | "1318" | "1319" | "1320" | "1321")));
        let permanent = matches!(error.status, Some(401 | 403))
            || (error.status == Some(402) && !positive_quota)
            || has(&[
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
        } else if error.status == Some(429)
            || identifiers.iter().any(|code| {
                code.contains("rate_limit")
                    || matches!(code.as_str(), "too_many_requests" | "throttlingexception")
            })
        {
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
        if !permanent && let Some(rejection) = image_rejection(&error, !self.unsafe_replay) {
            return rejection;
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
fn image_rejection(error: &ProviderError, replay_safe: bool) -> Option<ModelError> {
    let records = [Some(&error.data), error.data.get("error")];
    let identifiers = records
        .iter()
        .flatten()
        .flat_map(|record| [record.get("code"), record.get("type")])
        .flatten()
        .filter_map(Value::as_str)
        .chain(error.kind.as_deref())
        .chain(error.code.as_ref().and_then(Value::as_str));
    let explicit = identifiers.into_iter().any(|code| {
        matches!(
            code.to_ascii_lowercase().as_str(),
            "invalid_image"
                | "invalid_image_format"
                | "invalid_image_url"
                | "invalid_base64_image"
                | "unsupported_image"
                | "unsupported_image_format"
                | "image_too_large"
                | "image_too_small"
                | "image_parse_error"
                | "image_size_exceeded"
                | "image_dimensions_exceeded"
        )
    });
    let message = error.message.as_deref().or_else(|| {
        records
            .iter()
            .flatten()
            .find_map(|record| record.get("message").and_then(Value::as_str))
    });
    let unsupported = error.status == Some(400)
        && message.is_some_and(|message| {
            let message = message.trim();
            message.eq_ignore_ascii_case("unsupported image")
                || message
                    .strip_prefix("You have uploaded an unsupported image")
                    .is_some_and(|suffix| suffix.is_empty() || suffix.starts_with('.'))
        });
    (explicit || unsupported).then(|| ModelError::ImageInputRejected {
        message: message.map_or_else(|| provider_message(error.status), str::to_owned),
        // A protocol content index is not an original-image index. Attribution
        // requires the common view's source mapping, which this boundary lacks.
        index: None,
        replay_safe,
        status: error.status,
        code: error
            .code
            .as_ref()
            .and_then(Value::as_str)
            .or_else(|| {
                records
                    .iter()
                    .flatten()
                    .find_map(|record| record.get("code").and_then(Value::as_str))
            })
            .map(str::to_owned),
    })
}

fn provider_message(status: Option<u16>) -> String {
    status.map_or_else(
        || "provider request failed".into(),
        |status| format!("model HTTP request failed (status {status})"),
    )
}
pub(super) fn http_body_error(status: u16, error: impl std::fmt::Display) -> ProviderError {
    ProviderError {
        message: Some(format!("response body read failed: {error}")),
        ..http_error(status, &[])
    }
}

pub(super) fn http_error(status: u16, bytes: &[u8]) -> ProviderError {
    let data: Value = serde_json::from_slice(bytes).unwrap_or_else(|_| {
        std::str::from_utf8(bytes)
            .ok()
            .filter(|text| !text.is_empty())
            .map_or(Value::Null, |text| Value::String(text.to_owned()))
    });
    let record = data.get("error").unwrap_or(&data);
    ProviderError {
        message: if bytes.is_empty() {
            Some(format!("{status} status code (no body)"))
        } else {
            record
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_owned)
        },
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

    fn classify(status: u16, value: Value) -> ModelError {
        Evidence::default().provider(
            http_error(status, &serde_json::to_vec(&value).unwrap()),
            None,
        )
    }

    // Synthetic envelopes based on the official Z.ai code table and Kimi Code's
    // exceeded_current_quota_error mapping; these are not captured wire fixtures.
    #[test]
    fn documented_quota_codes_stop_retries_only_in_their_scope() {
        for code in [
            "1308", "1310", "1316", "1317", "1318", "1319", "1320", "1321",
        ] {
            let evidence = Evidence {
                quota_scope: QuotaScope::endpoint("https://api.z.ai/api/coding/paas/v4"),
                unsafe_replay: true,
                retry_at_unix_ms: Some(18_000_000),
                ..Default::default()
            };
            let error = evidence.provider(
                http_error(
                    429,
                    &serde_json::to_vec(
                        &json!({"error":{"code":code,"message":"original quota diagnostic"}}),
                    )
                    .unwrap(),
                ),
                None,
            );
            let ModelError::Provider(failure) = error else {
                panic!("expected quota failure for {code}")
            };
            assert_eq!(
                failure.reason(),
                ProviderFailureReason::QuotaExhausted,
                "{code}"
            );
            assert!(!failure.retryable(), "{code}");
            assert!(!failure.replay_safe());
            assert_eq!(failure.retry_at_unix_ms(), Some(18_000_000));
            assert_eq!(failure.message(), "original quota diagnostic");
            assert_eq!(failure.status(), Some(429));
            assert_eq!(failure.code(), Some(code));
        }
        for (endpoint, body) in [
            (
                "https://open.bigmodel.cn/api/paas/v4",
                json!({"error":{"code":"1302"}}),
            ),
            (
                "https://api.z.ai/api/paas/v4",
                json!({"error":{"code":"1305"}}),
            ),
            ("https://other.invalid", json!({"error":{"code":"1308"}})),
            (
                "https://api.z.ai.other.invalid",
                json!({"error":{"code":"1310"}}),
            ),
            ("https://api.z.ai", json!({"error":{"type":"1308"}})),
            ("https://api.z.ai", json!({"error":{"message":"1308"}})),
        ] {
            let error = Evidence {
                quota_scope: QuotaScope::endpoint(endpoint),
                ..Default::default()
            }
            .provider(http_error(429, &serde_json::to_vec(&body).unwrap()), None);
            let ModelError::Provider(failure) = error else {
                panic!("expected transient failure: {endpoint} {body}")
            };
            assert_eq!(
                failure.reason(),
                ProviderFailureReason::RateLimit,
                "{endpoint} {body}"
            );
            assert!(failure.retryable());
        }
        let ModelError::Provider(failure) = classify(
            429,
            json!({"error":{"type":"exceeded_current_quota_error"}}),
        ) else {
            panic!("expected Kimi quota failure")
        };
        assert_eq!(failure.reason(), ProviderFailureReason::QuotaExhausted);
        assert!(!failure.retryable());
    }

    #[test]
    fn scoped_quota_preserves_overflow_and_permanent_failure_priority() {
        for (status, body, overflow) in [
            (
                400,
                json!({"error":{"code":"1308", "type":"context_length_exceeded"}}),
                true,
            ),
            (401, json!({"error":{"code":"1308"}}), false),
            (403, json!({"error":{"code":"1308"}}), false),
        ] {
            let error = Evidence {
                quota_scope: QuotaScope::Zai,
                ..Default::default()
            }
            .provider(
                http_error(status, &serde_json::to_vec(&body).unwrap()),
                None,
            );
            if overflow {
                assert!(matches!(
                    error,
                    ModelError::ContextOverflow {
                        observed_output: false
                    }
                ));
            } else {
                assert!(
                    matches!(error, ModelError::Http { status: actual, .. } if actual == status)
                );
            }
        }
    }
}

#[cfg(test)]
mod image_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn contradictory_image_code_preserves_rate_deadline_status_and_effect_safety() {
        for unsafe_replay in [false, true] {
            let result = Evidence {
                observed: true,
                unsafe_replay,
                retry_at_unix_ms: Some(456_000),
                ..Default::default()
            }
            .provider(
                ProviderError {
                    status: Some(429),
                    message: Some("provider rate limit".into()),
                    kind: None,
                    code: Some(json!("invalid_image")),
                    retryable: Some(true),
                    data: Value::Null,
                },
                None,
            );
            let ModelError::Provider(failure) = result else {
                panic!("actual rate evidence must retain its typed cause");
            };
            assert_eq!(failure.reason(), ProviderFailureReason::RateLimit);
            assert_eq!(failure.status(), Some(429));
            assert_eq!(failure.code(), Some("invalid_image"));
            assert_eq!(failure.retry_at_unix_ms(), Some(456_000));
            assert_eq!(failure.replay_safe(), !unsafe_replay);
        }
    }

    #[test]
    fn positive_image_codes_agree_across_http_sse_and_statusless_events() {
        let original = "Provider rejected image format 图片; original diagnostics";
        for status in [Some(400), Some(200), None] {
            let error = ProviderError {
                status,
                message: Some(original.into()),
                kind: Some("invalid_request_error".into()),
                code: Some(json!("invalid_image_format")),
                retryable: Some(true),
                data: json!({"error":{"code":"invalid_image_format","param":"messages[3].content[2]"}}),
            };
            for replay_safe in [false, true] {
                let result = Evidence {
                    observed: true,
                    unsafe_replay: !replay_safe,
                    ..Default::default()
                }
                .provider(error.clone(), Some(1000));
                assert!(
                    matches!(result, ModelError::ImageInputRejected { message, index: None, replay_safe: actual, status: actual_status, code } if message == original && actual == replay_safe && actual_status == status && code.as_deref() == Some("invalid_image_format"))
                );
            }
        }
    }

    #[test]
    fn image_diagnostics_keep_actual_status_and_code_without_relabeling_kind() {
        let original = "  unsupported vendor image diagnostic 图片  ";
        let error = ProviderError {
            status: Some(422),
            message: Some(original.into()),
            kind: Some("invalid_image_format".into()),
            code: Some(json!("vendor_specific_code")),
            retryable: None,
            data: Value::Null,
        };
        let rejection = Evidence::default().provider(error, None);
        assert_eq!(
            rejection.to_string(),
            format!(
                "provider rejected image input (status 422) (code vendor_specific_code): {original}"
            )
        );
        assert!(
            matches!(rejection, ModelError::ImageInputRejected { message, status: Some(422), code, replay_safe: true, index: None } if message == original && code.as_deref() == Some("vendor_specific_code"))
        );
        let rejection = Evidence::default().provider(
            ProviderError {
                status: None,
                message: Some(original.into()),
                kind: Some("invalid_image_format".into()),
                code: None,
                retryable: None,
                data: Value::Null,
            },
            None,
        );
        assert_eq!(
            rejection.to_string(),
            format!("provider rejected image input: {original}")
        );
        assert!(matches!(
            rejection,
            ModelError::ImageInputRejected {
                status: None,
                code: None,
                ..
            }
        ));
    }

    #[test]
    fn only_narrow_http_message_evidence_can_replace_an_image_code() {
        for message in [
            "unsupported image",
            "You have uploaded an unsupported image. Please make sure your image has a supported format.",
        ] {
            let body = serde_json::to_vec(
                &json!({"error":{"type":"invalid_request_error","message":message}}),
            )
            .unwrap();
            assert!(
                matches!(Evidence::default().provider(http_error(400, &body), None), ModelError::ImageInputRejected { message: original, index: None, replay_safe: true, status: Some(400), code: None } if original == message)
            );
            assert!(matches!(
                Evidence::default().provider(http_error(500, &body), None),
                ModelError::Provider(_)
            ));
        }
        for value in [
            json!({"error":{"message":"invalid request"}}),
            json!({"error":{"message":"image might be unsupported"}}),
            json!({"error":{"message":"invalid_image_format"}}),
            json!({"error":{"message":"unsupported image processing option"}}),
            json!({"request":{"code":"invalid_image"}}),
        ] {
            assert!(
                matches!(
                    Evidence::default()
                        .provider(http_error(400, &serde_json::to_vec(&value).unwrap()), None),
                    ModelError::Http { status: 400, .. }
                ),
                "{value}"
            );
        }
        let payload =
            json!({"error":{"code":"payload_too_large","message":"request body exceeds limit"}});
        assert!(matches!(
            Evidence::default().provider(
                http_error(413, &serde_json::to_vec(&payload).unwrap()),
                None
            ),
            ModelError::Http { status: 413, .. }
        ));
    }
}
