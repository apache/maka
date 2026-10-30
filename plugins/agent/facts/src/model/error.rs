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
use std::time::Duration;

/// A provider failure with protocol-level evidence for safe replay.
#[derive(Clone, Debug, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[error("provider failed ({reason:?}): {message}{retry}", retry = .retry_at_unix_ms.map(|ms| format!(" (retry at Unix {ms} ms)")).unwrap_or_default())]
pub struct ProviderFailure {
    reason: ProviderFailureReason,
    message: String,
    status: Option<u16>,
    code: Option<String>,
    replay_safe: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    retained_output_safe: bool,
    retry_at_unix_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ProviderFailureReason {
    Network,
    TimedOut,
    RateLimit,
    QuotaExhausted,
    ProviderUnavailable,
    StreamTruncated,
}

impl ProviderFailure {
    pub fn new(
        reason: ProviderFailureReason,
        message: impl Into<String>,
        replay_safe: bool,
        retry_at_unix_ms: Option<u64>,
    ) -> Self {
        let mut message = message.into();
        if message.len() > 4096 {
            let mut end = 4096;
            while !message.is_char_boundary(end) {
                end -= 1;
            }
            message.truncate(end);
        }
        Self {
            reason,
            message,
            status: None,
            code: None,
            replay_safe,
            retained_output_safe: false,
            retry_at_unix_ms,
        }
    }
    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn with_diagnostic(mut self, status: Option<u16>, code: Option<String>) -> Self {
        self.status = status;
        self.code = code;
        self
    }

    pub fn status(&self) -> Option<u16> {
        self.status
    }
    pub fn code(&self) -> Option<&str> {
        self.code.as_deref()
    }

    pub fn reason(&self) -> ProviderFailureReason {
        self.reason
    }

    pub fn replay_safe(&self) -> bool {
        self.replay_safe
    }

    /// The adapter permits continuing from durably retained complete items.
    /// This does not authorize discarding their output or repeating effects.
    pub fn with_retained_output(mut self, safe: bool) -> Self {
        self.retained_output_safe = safe;
        self
    }

    pub fn retained_output_safe(&self) -> bool {
        self.retained_output_safe
    }

    pub fn retry_at_unix_ms(&self) -> Option<u64> {
        self.retry_at_unix_ms
    }

    /// The provider deadline is a lower bound, independent of replay authorization.
    pub fn retry_after(&self) -> Option<Duration> {
        self.retry_delay_at(Self::now_unix_ms())
    }

    pub fn retry_delay_at(&self, now_unix_ms: u64) -> Option<Duration> {
        self.retry_at_unix_ms
            .map(|at| Duration::from_millis(at.saturating_sub(now_unix_ms)))
    }

    pub fn now_unix_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| {
                u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
            })
    }

    pub fn retryable(&self) -> bool {
        matches!(
            self.reason,
            ProviderFailureReason::Network
                | ProviderFailureReason::TimedOut
                | ProviderFailureReason::RateLimit
                | ProviderFailureReason::ProviderUnavailable
                | ProviderFailureReason::StreamTruncated
        )
    }

    pub fn restrict_replay(mut self, safe: bool) -> Self {
        self.replay_safe &= safe;
        self
    }

    pub fn with_retry_at(mut self, retry_at_unix_ms: Option<u64>) -> Self {
        self.retry_at_unix_ms = self
            .retry_at_unix_ms
            .into_iter()
            .chain(retry_at_unix_ms)
            .max();
        self
    }

    pub fn validate(&self) -> Result<(), ModelError> {
        if self.message.len() > 4096
            || self
                .status
                .is_some_and(|status| !(100..600).contains(&status))
        {
            return Err(ModelError::Adapter(
                "invalid provider failure evidence".into(),
            ));
        }
        Ok(())
    }
}

/// Safe failure evidence, separate from provider-owned diagnostic text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ModelFailureCause {
    Http {
        #[schemars(range(min = 100, max = 599))]
        status: u16,
    },
    TimedOut,
    ContextOverflow,
    Provider {
        reason: ProviderFailureReason,
        #[serde(skip_serializing_if = "Option::is_none")]
        retry_at_unix_ms: Option<u64>,
    },
    Adapter,
}
impl ModelFailureCause {
    pub fn validate(&self) -> Result<(), ModelError> {
        if matches!(self, Self::Http { status } if !(100..=599).contains(status) || (200..300).contains(status))
        {
            return Err(ModelError::Adapter(
                "invalid model HTTP failure status".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, thiserror::Error)]
pub enum ModelError {
    #[error("model HTTP request failed (status {status}){detail}", detail = message.as_ref().map(|message| format!(": {message}")).unwrap_or_default())]
    Http {
        status: u16,
        message: Option<String>,
    },
    #[error("model request cancelled")]
    Cancelled,
    #[error("model transport physical cleanup is unconfirmed")]
    CleanupUnconfirmed,
    #[error("model stream idle timeout exceeded")]
    TimedOut,
    #[error("model input exceeds provider capacity (observed output: {observed_output})")]
    ContextOverflow { observed_output: bool },
    #[error(transparent)]
    Provider(ProviderFailure),
    #[error("model adapter failed: {0}")]
    Adapter(String),
}

impl ModelError {
    pub fn cleanup_unconfirmed(&self) -> bool {
        matches!(self, Self::CleanupUnconfirmed)
    }
    pub fn failure_cause(&self) -> Option<ModelFailureCause> {
        Some(match self {
            Self::Cancelled => return None,
            Self::Http { status, .. } => ModelFailureCause::Http { status: *status },
            Self::TimedOut => ModelFailureCause::TimedOut,
            Self::ContextOverflow { .. } => ModelFailureCause::ContextOverflow,
            Self::Provider(failure) => ModelFailureCause::Provider {
                reason: failure.reason(),
                retry_at_unix_ms: failure.retry_at_unix_ms,
            },
            Self::Adapter(_) | Self::CleanupUnconfirmed => ModelFailureCause::Adapter,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_retry_windows_survive_terminal_classification_and_serialization() {
        let error = ModelError::Provider(ProviderFailure::new(
            ProviderFailureReason::RateLimit,
            "account usage window exhausted",
            true,
            Some(2_592_000_000),
        ));
        let cause = error.failure_cause().unwrap();
        assert_eq!(
            serde_json::to_value(&cause).unwrap(),
            serde_json::json!({
                "kind": "provider", "reason": "rate_limit", "retry_at_unix_ms": 2_592_000_000u64,
            })
        );
        assert_eq!(
            error.to_string(),
            "provider failed (RateLimit): account usage window exhausted (retry at Unix 2592000000 ms)"
        );
        let decoded: ModelError =
            serde_json::from_value(serde_json::to_value(error).unwrap()).unwrap();
        let ModelError::Provider(failure) = decoded else {
            panic!("failure evidence lost")
        };
        failure.validate().unwrap();
        assert_eq!(
            failure.retry_delay_at(0),
            Some(Duration::from_secs(2_592_000))
        );
    }
}
