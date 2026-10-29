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

//! Closed diagnostic categories; private error payloads never cross this boundary.

use maka_agent_engine::RunError;
use maka_agent_facts::event::CommitError;
use maka_config::ConfigError;
use maka_event_log::StoreError;

pub(crate) fn config_cause(error: &ConfigError) -> &'static str {
    match error {
        ConfigError::Invalid(_) => "config_invalid",
        ConfigError::UnsupportedDatabase => "config_unsupported_database",
        ConfigError::CommitUnknown => "config_commit_unknown",
        ConfigError::Io(_) => "config_io",
        ConfigError::Sqlx(_) => "config_sqlx",
        ConfigError::Migration(_) => "config_migration",
        ConfigError::Store(_) => "config_store",
        ConfigError::Json(_) => "config_json",
    }
}

pub(crate) fn store_cause(error: &StoreError) -> &'static str {
    match error {
        StoreError::ConnectionClosed => "store_connection_closed",
        StoreError::OperationUnknown => "store_operation_unknown",
        StoreError::CommitUnknown(_) => "store_commit_unknown",
        StoreError::Sqlx(_) => "store_sqlx",
        StoreError::Sqlite(_) => "store_sqlite",
        StoreError::Io(_) => "store_io",
        StoreError::Json(_) => "store_json",
        StoreError::Migration(_) => "store_migration",
        StoreError::Poisoned => "store_poisoned",
        StoreError::CloseFailed(_) => "store_close_failed",
        StoreError::StartupCleanupFailed { .. } => "store_startup_cleanup_failed",
        StoreError::UnsupportedDatabase => "store_unsupported_database",
        StoreError::Initialization => "store_initialization",
        StoreError::HistoryTurnMissing => "store_history_turn_missing",
        StoreError::HistoryTurnSplit => "store_history_turn_split",
        StoreError::HistoryUnsettled => "store_history_unsettled",
        StoreError::HistoryProviderEffectUnresolved => "store_history_provider_effect_unresolved",
        StoreError::ManagedSession => "store_session_managed",
        _ => "store_error",
    }
}

pub(crate) fn store_sql_code(error: &StoreError) -> Option<i32> {
    match error {
        StoreError::Sqlx(error) | StoreError::CommitUnknown(error) => error
            .as_database_error()
            .and_then(|error| error.code())
            .and_then(|code| code.parse().ok()),
        StoreError::Sqlite(error) => error.sqlite_error().map(|error| error.extended_code),
        _ => None,
    }
}

pub(crate) fn run_cause(error: &RunError) -> &'static str {
    match error {
        RunError::Store(error) => store_cause(error),
        RunError::Commit(CommitError::Retired) => "commit_retired",
        RunError::Commit(CommitError::PermissionRevoked) => "commit_permission_revoked",
        RunError::Commit(CommitError::NativeTurnInterrupted) => "commit_native_turn_interrupted",
        RunError::Commit(CommitError::Rejected(_)) => "commit_rejected",
        RunError::Commit(CommitError::OutcomeUnknown(_)) => "commit_outcome_unknown",
        RunError::Busy => "session_busy",
        RunError::SessionState(_) => "session_state_error",
        RunError::ContinuationChanged => "continuation_changed",
        RunError::ReconciliationRequired(_) => "reconciliation_required",
        RunError::InvalidInput(_) => "invalid_input",
        RunError::Cancelled => "cancelled",
        RunError::ModelIncomplete => "model_incomplete",
        RunError::CleanupUnconfirmed => "cleanup_unconfirmed",
        RunError::Model(_) => "model_error",
        RunError::Tool(_) if error.is_cleanup_unconfirmed() => "cleanup_unconfirmed",
        RunError::Tool(_) => "tool_error",
        RunError::Internal(_) => "internal_error",
    }
}
