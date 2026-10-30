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

//! Safe evidence at the boundary where private errors become public rejection codes.

use maka_agent_ports::provider::Error as ProviderError;
use maka_config::ConfigError;
use maka_model::ModelError;

pub(super) fn provider(
    stage: &'static str,
    error: &ProviderError,
    connection_id: &str,
    provider: &str,
) {
    let (cause, reason) = match error {
        ProviderError::Cancelled => return,
        ProviderError::Unavailable => ("provider_unavailable", None),
        ProviderError::AuthenticationRequired => ("provider_authentication_required", None),
        ProviderError::Rejected(_) => ("provider_rejected", None),
        ProviderError::Invalid(_) => ("provider_invalid", None),
        ProviderError::OutcomeUnknown => ("provider_outcome_unknown", None),
        ProviderError::Transport(_) => ("provider_transport", None),
        ProviderError::Http(_) => ("provider_http", None),
        ProviderError::InvalidConfiguration => ("provider_invalid", Some("invalid_configuration")),
        ProviderError::InvalidModel => ("provider_invalid", Some("invalid_model")),
        ProviderError::InvalidPreparedModel => ("provider_invalid", Some("invalid_prepared_model")),
        ProviderError::SelectedModelChanged => ("provider_invalid", Some("selected_model_changed")),
        ProviderError::UnsupportedThinkingLevel => {
            ("provider_invalid", Some("unsupported_thinking_level"))
        }
        ProviderError::UnsupportedProtocol => ("provider_invalid", Some("unsupported_protocol")),
        ProviderError::UnsupportedExecutionProfile => {
            ("provider_invalid", Some("unsupported_execution_profile"))
        }
        ProviderError::InvalidEndpoint => ("provider_invalid", Some("invalid_endpoint")),
        ProviderError::MissingResponsesContract => {
            ("provider_invalid", Some("missing_responses_contract"))
        }
        ProviderError::UnsupportedParallelPolicy => {
            ("provider_invalid", Some("unsupported_parallel_policy"))
        }
        ProviderError::InsufficientOutputBudget => {
            ("provider_invalid", Some("insufficient_output_budget"))
        }
        ProviderError::ProviderFactsUnavailable => {
            ("provider_invalid", Some("provider_facts_unavailable"))
        }
        ProviderError::UnsupportedProbeAuthentication => {
            ("provider_invalid", Some("unsupported_probe_authentication"))
        }
    };
    let status = match error {
        ProviderError::Http(status) => Some(*status),
        _ => None,
    };
    tracing::warn!(
        stage,
        cause,
        reason,
        connection_id,
        provider,
        status,
        "Model preparation failed"
    );
}

pub(super) fn configuration(stage: &'static str, error: &ConfigError, connection_id: Option<&str>) {
    let cause = crate::diagnostics::config_cause(error);
    match error {
        ConfigError::Io(error) => tracing::warn!(
            stage, cause, connection_id, error_kind = ?error.kind(), os_code = error.raw_os_error(),
            "Model preparation failed"
        ),
        ConfigError::Sqlx(error) => {
            // Only a numeric SQLite code, never the database's free-form message.
            let sql_code = error
                .as_database_error()
                .and_then(|error| error.code())
                .and_then(|code| code.parse::<i32>().ok());
            tracing::warn!(
                stage,
                cause,
                connection_id,
                sql_code,
                "Model preparation failed"
            );
        }
        ConfigError::Json(error) => tracing::warn!(
            stage, cause, connection_id, category = ?error.classify(),
            line = error.line(), column = error.column(), "Model preparation failed"
        ),
        _ => tracing::warn!(stage, cause, connection_id, "Model preparation failed"),
    }
}

pub(super) fn model(stage: &'static str, error: &ModelError, connection_id: &str) {
    match error {
        ModelError::Cancelled => {}
        ModelError::Http { status, .. } => tracing::warn!(
            stage,
            cause = "model_http",
            connection_id,
            status,
            "Model preparation failed"
        ),
        ModelError::TimedOut => tracing::warn!(
            stage,
            cause = "model_timed_out",
            connection_id,
            "Model preparation failed"
        ),
        ModelError::ContextOverflow { observed_output } => tracing::warn!(
            stage,
            cause = "model_context_overflow",
            connection_id,
            observed_output,
            "Model preparation failed"
        ),
        ModelError::Provider(error) => {
            tracing::warn!(stage, cause = "model_provider", connection_id, reason = ?error.reason(), "Model preparation failed")
        }
        ModelError::CleanupUnconfirmed => tracing::warn!(
            stage,
            cause = "model_cleanup_unconfirmed",
            connection_id,
            "Model preparation failed"
        ),
        ModelError::ImageInputPayloadTooLarge { bytes, limit } => tracing::warn!(
            stage,
            cause = "image_input_payload_too_large",
            connection_id,
            bytes,
            limit,
            "Model preparation failed"
        ),
        ModelError::ImageInputRejected { index, .. } => tracing::warn!(
            stage,
            cause = "image_input_rejected",
            connection_id,
            index,
            "Model preparation failed"
        ),
        ModelError::Adapter(_) => tracing::warn!(
            stage,
            cause = "model_adapter",
            connection_id,
            "Model preparation failed"
        ),
    }
}

pub(super) fn network(stage: &'static str, error: &maka_network::Error, connection_id: &str) {
    let cause = match error {
        maka_network::Error::InvalidProxy => "proxy_invalid",
        maka_network::Error::MissingCredentials => "proxy_credentials_missing",
        maka_network::Error::InvalidUpgrade => "network_invalid_upgrade",
        maka_network::Error::InvalidHeaders => "network_invalid_headers",
        maka_network::Error::RedirectLimit => "network_redirect_limit",
        maka_network::Error::Transport(_) => "network_transport",
    };
    tracing::warn!(stage, cause, connection_id, "Model preparation failed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arbitrary_provider_error_strings_stay_private_at_diagnostic_boundary() {
        use std::io::{Read, Seek};
        let mut file = tempfile::tempfile().unwrap();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(file.try_clone().unwrap())
            .with_max_level(tracing::Level::WARN)
            .with_ansi(false)
            .without_time()
            .finish();
        let _guard = tracing::subscriber::set_default(subscriber);
        for (stage, error) in [
            (
                "boundary_invalid",
                ProviderError::Invalid("PRIVATE_INVALID_VALIDATION_SENTINEL".into()),
            ),
            (
                "boundary_rejected",
                ProviderError::Rejected("PRIVATE_REJECTED_REMOTE_SENTINEL".into()),
            ),
            (
                "boundary_transport",
                ProviderError::Transport("PRIVATE_TRANSPORT_URL_KEY_SENTINEL".into()),
            ),
            ("boundary_thinking", ProviderError::UnsupportedThinkingLevel),
            (
                "boundary_profile",
                ProviderError::UnsupportedExecutionProfile,
            ),
        ] {
            provider(stage, &error, "original-connection", "kimi-coding-plan");
        }
        file.rewind().unwrap();
        let mut log = String::new();
        file.read_to_string(&mut log).unwrap();
        for (stage, cause) in [
            ("boundary_invalid", "provider_invalid"),
            ("boundary_rejected", "provider_rejected"),
            ("boundary_transport", "provider_transport"),
        ] {
            let line = log.lines().find(|line| line.contains(stage)).unwrap();
            assert!(line.contains(&format!("cause=\"{cause}\"")), "{line}");
            assert!(line.contains("original-connection"));
            assert!(line.contains("kimi-coding-plan"));
            assert!(!line.contains("reason="));
        }
        for (stage, reason) in [
            ("boundary_thinking", "unsupported_thinking_level"),
            ("boundary_profile", "unsupported_execution_profile"),
        ] {
            let line = log.lines().find(|line| line.contains(stage)).unwrap();
            assert!(line.contains("cause=\"provider_invalid\""), "{line}");
            assert!(line.contains(&format!("reason=\"{reason}\"")), "{line}");
        }
        for secret in [
            "PRIVATE_INVALID_VALIDATION_SENTINEL",
            "PRIVATE_REJECTED_REMOTE_SENTINEL",
            "PRIVATE_TRANSPORT_URL_KEY_SENTINEL",
        ] {
            assert!(
                !log.contains(secret),
                "arbitrary provider error payload escaped sanitization"
            );
        }
    }
}
