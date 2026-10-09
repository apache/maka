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

//! Why a Host candidate failed to start, and the diagnostic it leaves.
//!
//! A candidate that fails before it is ready classifies the error, writes
//! `startup-diagnostic.<startupAttemptId>.json` into the root's control
//! directory, and exits with the reason's code (`runExecutionCandidateEntry`
//! in `packages/runtime-host/src/candidate-entry.ts`). A candidate that lost
//! the election to another one exits with 2 and leaves nothing.
//!
//! The launcher tidies those files up as the TS launcher does
//! (`connectOrSpawnRuntimeHostWithDependencies` in
//! `packages/runtime-host/src/client/connect-or-spawn.ts`): the diagnostic
//! that ends an election is renamed to `startup-diagnostic.json`
//! ([`select_startup_diagnostic`]), a failure the election no longer reports
//! is deleted, and a successful connection deletes the failure it recorded
//! and the selected file ([`clear_startup_diagnostic`]). Attempts of other
//! launchers are left to the candidate, which prunes old ones when it writes
//! its own (`pruneCandidateStartupDiagnostics`).

use std::fmt;
use std::path::Path;

use serde::Deserialize;

/// `startup-diagnostic.<id>.json` is at most this large
/// (`MAX_STARTUP_DIAGNOSTIC_BYTES` in `control/startup-diagnostic.ts`).
const MAX_STARTUP_DIAGNOSTIC_BYTES: u64 = 16 * 1024;

/// The exit code of a candidate that lost the election
/// (`process.exit(2)` in `candidate-entry.ts`).
pub const CANDIDATE_LOST_EXIT_CODE: i32 = 2;

/// Why a candidate could not start: `CandidateStartupFailureReason` in
/// `packages/runtime-host/src/candidate-startup-failure.ts`, read back from
/// the exit code (`candidateStartupFailureForExitCode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum StartupFailureReason {
    StoredDataIncompatible,
    OperationalStateMigrationBlocked,
    LocalIpcSecurityFailed,
    InternalStartupFailure,
    ManagedRootRequiresOperator,
    DeploymentRecordMissing,
    DeploymentClaimMismatch,
    DeploymentLifecycleMismatch,
    DeploymentRecordInvalid,
    DeploymentLaunchMismatch,
    DeploymentTransitionInProgress,
    DeploymentNeedsRepair,
}

impl StartupFailureReason {
    const ALL: [Self; 12] = [
        Self::StoredDataIncompatible,
        Self::OperationalStateMigrationBlocked,
        Self::LocalIpcSecurityFailed,
        Self::InternalStartupFailure,
        Self::ManagedRootRequiresOperator,
        Self::DeploymentRecordMissing,
        Self::DeploymentClaimMismatch,
        Self::DeploymentLifecycleMismatch,
        Self::DeploymentRecordInvalid,
        Self::DeploymentLaunchMismatch,
        Self::DeploymentTransitionInProgress,
        Self::DeploymentNeedsRepair,
    ];

    /// `EXIT_CODE_BY_REASON` in `candidate-startup-failure.ts`.
    pub fn exit_code(self) -> i32 {
        match self {
            Self::StoredDataIncompatible => 65,
            Self::OperationalStateMigrationBlocked => 78,
            Self::LocalIpcSecurityFailed => 77,
            Self::InternalStartupFailure => 70,
            Self::ManagedRootRequiresOperator => 80,
            Self::DeploymentRecordMissing => 81,
            Self::DeploymentClaimMismatch => 82,
            Self::DeploymentLifecycleMismatch => 83,
            Self::DeploymentRecordInvalid => 84,
            Self::DeploymentLaunchMismatch => 85,
            Self::DeploymentTransitionInProgress => 86,
            Self::DeploymentNeedsRepair => 87,
        }
    }

    /// The reason a candidate's exit code stands for, if any.
    pub fn from_exit_code(code: i32) -> Option<Self> {
        Self::ALL.into_iter().find(|reason| reason.exit_code() == code)
    }

    /// The wire name, as the diagnostic file spells it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::StoredDataIncompatible => "stored_data_incompatible",
            Self::OperationalStateMigrationBlocked => "operational_state_migration_blocked",
            Self::LocalIpcSecurityFailed => "local_ipc_security_failed",
            Self::InternalStartupFailure => "internal_startup_failure",
            Self::ManagedRootRequiresOperator => "managed_root_requires_operator",
            Self::DeploymentRecordMissing => "deployment_record_missing",
            Self::DeploymentClaimMismatch => "deployment_claim_mismatch",
            Self::DeploymentLifecycleMismatch => "deployment_lifecycle_mismatch",
            Self::DeploymentRecordInvalid => "deployment_record_invalid",
            Self::DeploymentLaunchMismatch => "deployment_launch_mismatch",
            Self::DeploymentTransitionInProgress => "deployment_transition_in_progress",
            Self::DeploymentNeedsRepair => "deployment_needs_repair",
        }
    }

    /// Whether starting again cannot help without a person
    /// (`isPermanentCandidateStartupFailure`: every reason except
    /// `local_ipc_security_failed` and `internal_startup_failure`).
    pub fn is_permanent(self) -> bool {
        !matches!(self, Self::LocalIpcSecurityFailed | Self::InternalStartupFailure)
    }

    /// What to tell a person: the messages of `runtimeHostStartupError` in
    /// `packages/runtime-host/src/client/startup-error.ts`.
    pub fn message(self) -> &'static str {
        match self {
            Self::StoredDataIncompatible => {
                "Maka cannot read part of this workspace’s stored data. The workspace was left in \
                 place. Update Maka or report diagnostic code STORED_DATA_INCOMPATIBLE."
            }
            Self::OperationalStateMigrationBlocked => {
                "Maka could not safely upgrade this workspace and left it unchanged. Reopen it with \
                 the previous Maka release to export or remove incompatible data, then try again. \
                 Diagnostic code: OPERATIONAL_STATE_MIGRATION_BLOCKED."
            }
            Self::InternalStartupFailure => {
                "Runtime Host failed while recovering this workspace. Try again; if the problem \
                 persists, report diagnostic code INTERNAL_STARTUP_FAILURE."
            }
            Self::LocalIpcSecurityFailed => {
                "Runtime Host could not secure its Local IPC endpoint. Try again; if the problem \
                 persists, report diagnostic code LOCAL_IPC_SECURITY_FAILED."
            }
            Self::ManagedRootRequiresOperator => {
                "This workspace is managed by a Runtime Host operator. Activate it through the \
                 configured Host profile. Diagnostic code: MANAGED_ROOT_REQUIRES_OPERATOR."
            }
            Self::DeploymentRecordMissing => {
                "The Runtime Host operator refers to a managed deployment that is not installed. \
                 Repair the deployment before connecting. Diagnostic code: DEPLOYMENT_RECORD_MISSING."
            }
            Self::DeploymentClaimMismatch => {
                "The Runtime Host operator does not match the managed deployment. Repair or \
                 explicitly migrate the deployment. Diagnostic code: DEPLOYMENT_CLAIM_MISMATCH."
            }
            Self::DeploymentLifecycleMismatch => {
                "The Runtime Host launch path cannot honor the configured lifecycle. Use the \
                 deployment operator. Diagnostic code: DEPLOYMENT_LIFECYCLE_MISMATCH."
            }
            Self::DeploymentLaunchMismatch => {
                "The Runtime Host process does not match the exact package selected by the managed \
                 deployment. Repair or explicitly migrate the deployment. Diagnostic code: \
                 DEPLOYMENT_LAUNCH_MISMATCH."
            }
            Self::DeploymentRecordInvalid => {
                "The Runtime Host managed deployment record is invalid. Run deployment repair \
                 before connecting. Diagnostic code: DEPLOYMENT_RECORD_INVALID."
            }
            Self::DeploymentTransitionInProgress => {
                "The Runtime Host managed deployment is changing. Retry after the lifecycle \
                 operation completes. Diagnostic code: DEPLOYMENT_TRANSITION_IN_PROGRESS."
            }
            Self::DeploymentNeedsRepair => {
                "The Runtime Host managed deployment could not safely complete or roll back a \
                 lifecycle change. Run deployment repair before connecting. Diagnostic code: \
                 DEPLOYMENT_NEEDS_REPAIR."
            }
        }
    }
}

impl fmt::Display for StartupFailureReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The file a failed candidate writes: `CandidateStartupDiagnostic` in
/// `packages/runtime-host/src/control/startup-diagnostic.ts`, decoded as
/// `readCandidateStartupDiagnostic` does. The Host redacts secrets and bounds
/// every text before writing it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct StartupDiagnostic {
    pub schema_version: u32,
    pub root_id: String,
    pub startup_attempt_id: String,
    pub candidate_pid: u32,
    pub captured_at: String,
    pub reason: String,
    pub error_chain: Vec<StartupErrorSummary>,
    #[serde(default)]
    pub logs: Vec<String>,
}

/// One error of [`StartupDiagnostic::error_chain`], outermost first.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[non_exhaustive]
pub struct StartupErrorSummary {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "code_as_text")]
    pub code: Option<String>,
    pub message: String,
}

/// `code` is a string or a finite number.
fn code_as_text<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Ok(match Option::<serde_json::Value>::deserialize(deserializer)? {
        Some(serde_json::Value::String(code)) => Some(code),
        Some(serde_json::Value::Number(code)) => Some(code.to_string()),
        _ => None,
    })
}

impl StartupDiagnostic {
    /// The error chain on one line: `Name (code): message: …`.
    pub fn error_text(&self) -> String {
        let mut text = String::new();
        for error in &self.error_chain {
            if !text.is_empty() {
                text.push_str(": ");
            }
            match (&error.name, &error.code) {
                (Some(name), Some(code)) => text.push_str(&format!("{name} ({code}) ")),
                (Some(name), None) => text.push_str(&format!("{name} ")),
                (None, Some(code)) => text.push_str(&format!("({code}) ")),
                (None, None) => {}
            }
            text.push_str(error.message.trim());
        }
        text
    }
}

/// The diagnostic file of one attempt inside a control directory
/// (`resolveCandidateStartupDiagnosticPath`).
pub fn startup_diagnostic_path(
    control_directory: &Path,
    startup_attempt_id: &str,
) -> std::path::PathBuf {
    control_directory.join(format!("startup-diagnostic.{startup_attempt_id}.json"))
}

/// The name the diagnostic that ended an election is kept under, until a
/// later connection succeeds (`RUNTIME_HOST_STARTUP_DIAGNOSTIC_FILE` in
/// `control/startup-diagnostic.ts`).
pub const SELECTED_STARTUP_DIAGNOSTIC_FILE: &str = "startup-diagnostic.json";

/// Deletes the diagnostic of `startup_attempt_id`, or the selected one for
/// `None` (`clearCandidateStartupDiagnostic`). A missing file is fine; any
/// other failure is logged and ignored, as the TS launcher ignores it.
pub async fn clear_startup_diagnostic(control_directory: &Path, startup_attempt_id: Option<&str>) {
    let path = match startup_attempt_id {
        Some(id) => startup_diagnostic_path(control_directory, id),
        None => control_directory.join(SELECTED_STARTUP_DIAGNOSTIC_FILE),
    };
    match async_fs::remove_file(&path).await {
        Ok(()) => log::debug!("removed the startup diagnostic {}", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("could not remove {}: {error}", path.display()),
    }
}

/// Keeps the diagnostic of `startup_attempt_id`, which ended the election,
/// as [`SELECTED_STARTUP_DIAGNOSTIC_FILE`] (`selectCandidateStartupDiagnostic`).
/// Read it first; afterwards it is only under the selected name.
pub async fn select_startup_diagnostic(control_directory: &Path, startup_attempt_id: &str) {
    let from = startup_diagnostic_path(control_directory, startup_attempt_id);
    let to = control_directory.join(SELECTED_STARTUP_DIAGNOSTIC_FILE);
    match async_fs::rename(&from, &to).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("could not keep {} as {}: {error}", from.display(), to.display()),
    }
}

/// Reads the diagnostic that the candidate of `startup_attempt_id` wrote, if
/// it wrote a valid one for `root_id`.
pub async fn read_startup_diagnostic(
    control_directory: &Path,
    root_id: &str,
    startup_attempt_id: &str,
) -> Option<StartupDiagnostic> {
    let path = startup_diagnostic_path(control_directory, startup_attempt_id);
    let metadata = async_fs::symlink_metadata(&path).await.ok()?;
    if !metadata.is_file() || metadata.len() > MAX_STARTUP_DIAGNOSTIC_BYTES {
        return None;
    }
    let bytes = async_fs::read(&path).await.ok()?;
    let diagnostic: StartupDiagnostic = serde_json::from_slice(&bytes).ok()?;
    (diagnostic.schema_version == 1
        && diagnostic.root_id == root_id
        && diagnostic.startup_attempt_id == startup_attempt_id
        && !diagnostic.error_chain.is_empty())
    .then_some(diagnostic)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_round_trip_and_only_two_reasons_are_transient() {
        for reason in StartupFailureReason::ALL {
            assert_eq!(StartupFailureReason::from_exit_code(reason.exit_code()), Some(reason));
        }
        assert_eq!(StartupFailureReason::from_exit_code(0), None);
        assert_eq!(StartupFailureReason::from_exit_code(CANDIDATE_LOST_EXIT_CODE), None);
        let transient: Vec<_> =
            StartupFailureReason::ALL.into_iter().filter(|reason| !reason.is_permanent()).collect();
        assert_eq!(
            transient,
            [
                StartupFailureReason::LocalIpcSecurityFailed,
                StartupFailureReason::InternalStartupFailure
            ]
        );
    }

    #[test]
    fn the_error_chain_reads_as_one_line() {
        let diagnostic: StartupDiagnostic = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "rootId": "r",
            "startupAttemptId": "a",
            "candidatePid": 42,
            "capturedAt": "2026-09-25T00:00:00.000Z",
            "reason": "stored_data_incompatible",
            "errorChain": [
                {"name": "StoredMessageError", "code": "stored_session_message_incompatible", "message": "bad row"},
                {"code": 5, "message": "inner"},
                {"message": "root cause"}
            ],
            "logs": []
        }))
        .expect("diagnostic");
        assert_eq!(
            diagnostic.error_text(),
            "StoredMessageError (stored_session_message_incompatible) bad row: (5) inner: root cause"
        );
    }
}
