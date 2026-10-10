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

//! Runtime resources: the shell runs a Host owns, in particular the PTY
//! terminal a client starts, drives, and watches.
//!
//! Sources: `RUNTIME_RESOURCE_OPERATION_SPECS` and its decoders in
//! `packages/runtime-host/src/protocol/runtime-resource.ts`; the resource
//! record is `ShellRunUpdate` and `ShellRunStateResult` in
//! `packages/core/src/events.ts`, checked by
//! `decodeCanonicalShellToolResultContent` in
//! `packages/core/src/shell-run-result.ts`; statuses, outputs and the Desktop
//! launch prefix are in `packages/core/src/shell-run.ts`; the live-PTY cap is
//! `DEFAULT_MAX_LIVE_PTY_RUNS` in `packages/runtime/src/shell-run-contract.ts`.
//! The Host side is `HostRuntimeResourceCoordinator` in
//! `packages/runtime-host/src/server/runtime-resource-coordinator.ts`.
//!
//! A terminal's life, as Maka Desktop drives it
//! (`apps/desktop/src/main/runtime-host-shell-runs-ipc-main.ts`):
//!
//! 1. `runtime.resource.start` without `command`, with a launch id of
//!    [`DESKTOP_TERMINAL_LAUNCH_PREFIX`] and a UUID
//!    ([`RuntimeResourceStartInput::terminal`]): the Host runs the user's
//!    login shell (`exec "$SHELL" -l`) in a PTY in the Session's workspace and
//!    answers its state.
//! 2. `subscription.pty_interest.set` ([`crate::SubscriptionPtyInterestSet`])
//!    on the Session's subscription names the refs whose output it wants, as
//!    [`crate::SessionRuntimeResourcePtyDataFrame`]s.
//! 3. `runtime.resource.controller.acquire` takes the one controller seat
//!    and answers the screen so far ([`PtySnapshot`]). Data frames whose
//!    `ptySequence` is above the snapshot's `sequence` follow it; a gap, or a
//!    frame with `reset`, means acquire again.
//! 4. `runtime.resource.controller.control` sends keystrokes and sizes, with
//!    a `sequence` that starts at the acquire's `nextSequence` and rises by
//!    one per call; the Host answers a repeated sequence with the same
//!    control from a replay cache.
//! 5. `runtime.resource.controller.release` gives the seat up (closing the
//!    panel or the window does; the shell keeps running), and
//!    `runtime.resource.stop` ends the shell.
//!
//! No frame announces an exit: the Session subscription's
//! `session_domain_changed` with domain `runtime_resource` names the changed
//! refs, and `runtime.resource.query` `get` answers the new state, whose
//! status is then one of [`ShellRunStatus::is_terminal`]. Terminal text
//! travels as UTF-8 JSON strings both ways, not base64.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{HostOperationError, HostOperationErrorCode, Operation, ToolOutputStream};

/// `RUNTIME_RESOURCE_RESULT_MAX_BYTES`: an encoded start, page, or `get`
/// result.
pub const RUNTIME_RESOURCE_RESULT_MAX_BYTES: usize = 52 * 1024;
/// `RUNTIME_RESOURCE_CONTROLLER_ACQUIRE_RESULT_MAX_BYTES`: the Host halves
/// the snapshot buffer until the acquire result fits.
pub const RUNTIME_RESOURCE_CONTROLLER_ACQUIRE_RESULT_MAX_BYTES: usize = 90 * 1024;
/// `RUNTIME_RESOURCE_PAGE_MAX_ITEMS`: resources per `runtime.resource.query`
/// page.
pub const RUNTIME_RESOURCE_PAGE_MAX_ITEMS: usize = 64;
/// `RUNTIME_RESOURCE_CURSOR_MAX_BYTES`.
pub const RUNTIME_RESOURCE_CURSOR_MAX_BYTES: usize = 32;
/// `RUNTIME_RESOURCE_REF_MAX_BYTES`: UTF-8 bytes of a resource ref, which
/// has the form `maka://runtime/background-tasks/<id>`.
pub const RUNTIME_RESOURCE_REF_MAX_BYTES: usize = 256;
/// `RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES`: UTF-8 bytes of one control's
/// `input`.
pub const RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES: usize = 32 * 1024;
/// `RUNTIME_RESOURCE_COMMAND_MAX_BYTES`: UTF-8 bytes of a start's `command`.
pub const RUNTIME_RESOURCE_COMMAND_MAX_BYTES: usize = 32 * 1024;
/// `RUNTIME_RESOURCE_MAX_CONTROL_SEQUENCE` (`Number.MAX_SAFE_INTEGER - 1`):
/// the Host releases the controller after a control with this sequence.
pub const RUNTIME_RESOURCE_MAX_CONTROL_SEQUENCE: u64 = (1 << 53) - 2;
/// `RUNTIME_RESOURCE_MIN_PTY_COLS`.
pub const RUNTIME_RESOURCE_MIN_PTY_COLS: u16 = 2;
/// `RUNTIME_RESOURCE_MAX_PTY_COLS`.
pub const RUNTIME_RESOURCE_MAX_PTY_COLS: u16 = 240;
/// `RUNTIME_RESOURCE_MIN_PTY_ROWS`.
pub const RUNTIME_RESOURCE_MIN_PTY_ROWS: u16 = 1;
/// `RUNTIME_RESOURCE_MAX_PTY_ROWS`.
pub const RUNTIME_RESOURCE_MAX_PTY_ROWS: u16 = 100;
/// UTF-8 bytes of a snapshot's `buffer` (`ptyBuffer`). The Host keeps the
/// last 16,000 characters of raw output for it.
pub const RUNTIME_RESOURCE_PTY_BUFFER_MAX_BYTES: usize = 80 * 1024;
/// `DEFAULT_MAX_LIVE_PTY_RUNS`: live PTYs across every Session of the Host,
/// the agent's interactive runs included. A start past it fails as
/// [`RuntimeResourceFailure::HostFailure`] (see there).
pub const MAX_LIVE_PTY_RUNS: usize = 8;
/// `DESKTOP_TERMINAL_LAUNCH_PREFIX`: the launch id prefix that marks a
/// client's terminal, as opposed to the agent's shell runs
/// (`isDesktopTerminalShellRun`).
pub const DESKTOP_TERMINAL_LAUNCH_PREFIX: &str = "desktop-terminal-";

wire_enum! {
    /// `ShellRunStatus` (`SHELL_RUN_STATUSES` in `packages/core/src/shell-run.ts`).
    pub enum ShellRunStatus {
        Starting = "starting",
        Running = "running",
        Completed = "completed",
        Failed = "failed",
        TimedOut = "timed_out",
        Cancelled = "cancelled",
        /// The Host lost the process, for example across a Host restart.
        Orphaned = "orphaned",
    }
}

impl ShellRunStatus {
    /// `isActiveShellRunStatus`: the process is starting or running.
    pub fn is_active(&self) -> bool {
        matches!(self, Self::Starting | Self::Running)
    }

    /// `isTerminalShellRunStatus`: the process has ended and will not change
    /// again. An unknown status is neither active nor terminal.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::TimedOut | Self::Cancelled | Self::Orphaned
        )
    }
}

wire_enum! {
    /// `ShellMode`: a terminal runs in `pty`; the agent's one-shot commands
    /// and a client's `command` start run with `pipes`.
    pub enum ShellMode {
        Pipes = "pipes",
        Pty = "pty",
    }
}

wire_tag! {
    /// `ShellRunStateResult.kind`.
    ShellRunKind = "shell_run"
}

/// `ShellRunStateResult` (`decodeRuntimeResourceState`, which accepts a
/// `shell_run` result without `operation`): one shell run's state.
///
/// The status and the end fields agree as `isValidShellRunState` requires:
/// `completed` has exit code 0, `timed_out` 124, `cancelled` 130, `failed`
/// a non-zero exit code or a failure message, `orphaned` a failure message
/// and no exit code; an active run has none of them.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct ShellRunState {
    kind: ShellRunKind,
    #[serde(rename = "ref")]
    pub resource_ref: String,
    pub mode: ShellMode,
    pub status: ShellRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    pub cwd: String,
    /// The command line; `exec "$SHELL" -l` for a terminal on macOS and Linux.
    pub cmd: String,
    /// Unix milliseconds.
    pub started_at: u64,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_message: Option<String>,
    /// Positive; rises with every change.
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox_denial: Option<SandboxDenial>,
    /// What the run printed, when the Host includes it; its `mode` is the
    /// run's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<ShellOutput>,
}

/// `SandboxDenialSignal` / `SandboxDenialRecovery`: the sandbox probably
/// refused the command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct SandboxDenial {
    /// Always `true`.
    pub likely: bool,
    /// `macos-seatbelt`, `linux`, or `windows`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    /// `require_escalated` when the run needs to leave the sandbox.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery: Option<String>,
}

wire_union! {
    /// `ShellOutput` (`isShellOutput` in `packages/core/src/shell-run.ts`),
    /// by `mode`.
    pub enum ShellOutput in "mode" {
        Pipes(PipeShellOutput) = "pipes",
        Pty(PtyShellOutput) = "pty",
    }
}

/// `PipeShellOutput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct PipeShellOutput {
    pub stdout: String,
    pub stderr: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latest_stream: Option<ToolOutputStream>,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub redacted: bool,
}

/// `PtyShellOutput`: the rendered screen, not the raw bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct PtyShellOutput {
    pub screen: String,
    pub scrollback: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_alternate_screen: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub cursor: PtyCursor,
    pub alternate_screen: bool,
    pub truncated: bool,
    pub redacted: bool,
}

/// `PtyShellOutput.cursor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct PtyCursor {
    pub x: u16,
    pub y: u16,
    pub visible: bool,
}

/// `ShellRunUpdateOwnership` (`decodeOwnership`): whose process this is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum RuntimeResourceOwnership {
    /// The Session's own run.
    Local,
    /// A run another Session started and still owns (a branch shows its
    /// source's runs).
    #[serde(rename_all = "camelCase")]
    SourceOwned { source_session_id: String, owner_session_id: String },
    /// A run inherited from a Session whose owner can no longer be resolved.
    #[serde(rename_all = "camelCase")]
    SourceUnavailable { source_session_id: String },
    /// An ownership kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `ShellRunUpdate` (`decodeRuntimeResourceUpdate`): one resource as
/// `runtime.resource.query` lists it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RuntimeResource {
    /// The Session whose view shows the resource.
    pub session_id: String,
    pub ownership: RuntimeResourceOwnership,
    /// For a client's start, its launch id; for the agent's run, its Turn.
    pub source_turn_id: String,
    /// For a client's start, its launch id again; for the agent's run, its
    /// Tool call (at most 512 UTF-8 bytes).
    pub source_tool_call_id: String,
    pub result: ShellRunState,
}

impl RuntimeResource {
    /// The launch id a client started the resource with: the Host stores
    /// it as both `sourceTurnId` and `sourceToolCallId`, which no agent run
    /// does (`HostRuntimeResourceCoordinator#start`).
    pub fn launch_id(&self) -> Option<&str> {
        (self.source_turn_id == self.source_tool_call_id).then_some(self.source_turn_id.as_str())
    }

    /// Whether this is a client terminal the Session owns: the resources
    /// Desktop shows as terminal tabs (`isDesktopTerminal` in
    /// `apps/desktop/src/renderer/platform/desktop/create-workbar-services.ts`,
    /// `isDesktopTerminalShellRun`).
    pub fn is_desktop_terminal(&self) -> bool {
        self.ownership == RuntimeResourceOwnership::Local
            && self.result.mode == ShellMode::Pty
            && self.launch_id().is_some_and(|id| id.starts_with(DESKTOP_TERMINAL_LAUNCH_PREFIX))
    }
}

/// `RuntimeResourceQueryInput` (`decodeRuntimeResourceQueryInput`), by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum RuntimeResourceQueryInput {
    /// The Session's resources, the agent's runs included, from the start.
    #[serde(rename_all = "camelCase")]
    ListStart { session_id: String },
    /// The next page, at the revision of the first one.
    #[serde(rename_all = "camelCase")]
    ListContinue { session_id: String, revision: String, cursor: String },
    #[serde(rename_all = "camelCase")]
    Get {
        session_id: String,
        #[serde(rename = "ref")]
        resource_ref: String,
    },
}

/// `RuntimeResourceQueryResult` (`decodeRuntimeResourceQueryResult`), by
/// `kind`. Revisions are `sha256:<64 hex>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum RuntimeResourceQueryResult {
    /// At most [`RUNTIME_RESOURCE_PAGE_MAX_ITEMS`] resources.
    #[serde(rename_all = "camelCase")]
    Page {
        session_id: String,
        revision: String,
        resources: Vec<RuntimeResource>,
        next_cursor: Option<String>,
    },
    /// The list changed since its first page: start again.
    RevisionChanged { expected: String, actual: String },
    /// `get`: `null` when the Session has no resource with that ref.
    #[serde(rename_all = "camelCase")]
    Resource { session_id: String, revision: String, resource: Option<Box<RuntimeResource>> },
    /// A result kind this client does not recognize.
    #[serde(other, skip_serializing)]
    Unknown,
}

/// `RuntimeResourceStartInput` (`decodeRuntimeResourceStartInput`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RuntimeResourceStartInput {
    pub session_id: String,
    /// 1 to 128 characters. The Host records it as the resource's
    /// `sourceTurnId` and `sourceToolCallId`.
    pub launch_id: String,
    /// Absent for a terminal. With a command the Host runs it once with
    /// pipes, hidden from the model (Desktop's `!<command>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

impl RuntimeResourceStartInput {
    /// A terminal: the user's login shell in a PTY, launched as
    /// `desktop-terminal-<unique>` (Desktop passes a random UUID).
    pub fn terminal(session_id: impl Into<String>, unique: &str) -> Self {
        Self {
            session_id: session_id.into(),
            launch_id: format!("{DESKTOP_TERMINAL_LAUNCH_PREFIX}{unique}"),
            command: None,
        }
    }

    /// A one-shot command. Refused when the command is blank or longer
    /// than [`RUNTIME_RESOURCE_COMMAND_MAX_BYTES`].
    pub fn command(
        session_id: impl Into<String>,
        launch_id: impl Into<String>,
        command: impl Into<String>,
    ) -> Result<Self, RuntimeResourceInputError> {
        let command = command.into();
        if command.trim().is_empty() || command.len() > RUNTIME_RESOURCE_COMMAND_MAX_BYTES {
            return Err(RuntimeResourceInputError::Command);
        }
        Ok(Self {
            session_id: session_id.into(),
            launch_id: launch_id.into(),
            command: Some(command),
        })
    }
}

/// `RuntimeResourceStartResult`: the new run's state. It carries no
/// ownership or launch id; those are the client's own (`local`, and the
/// launch id it sent).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RuntimeResourceStartResult {
    pub resource: ShellRunState,
}

/// `RuntimeResourceControllerAcquireInput`, also the release input
/// (`decodeControllerIdentity`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RuntimeResourceControllerInput {
    pub session_id: String,
    #[serde(rename = "ref")]
    pub resource_ref: String,
    /// Client-chosen entity id (`^[A-Za-z0-9_-]{1,128}$`), bound to one
    /// resource for the connection's life.
    pub controller_id: String,
}

impl RuntimeResourceControllerInput {
    pub fn new(
        session_id: impl Into<String>,
        resource_ref: impl Into<String>,
        controller_id: impl Into<String>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            resource_ref: resource_ref.into(),
            controller_id: controller_id.into(),
        }
    }
}

/// `RuntimeResourceControllerAcquireResult`
/// (`decodeRuntimeResourceControllerAcquireResult`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RuntimeResourceAcquireResult {
    pub controller_id: String,
    /// The `sequence` of the next control; 1 for a new controller, and where
    /// the controller left off when the same connection acquires again.
    pub next_sequence: u64,
    pub pty: PtySnapshot,
}

/// `RuntimeResourcePtySnapshot`: the terminal so far.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct PtySnapshot {
    pub session_id: String,
    #[serde(rename = "ref")]
    pub resource_ref: String,
    /// The `ptySequence` of the last output in `buffer`; data frames at or
    /// below it are already in the buffer.
    pub sequence: u64,
    /// The newest raw output, escape sequences included, at most
    /// [`RUNTIME_RESOURCE_PTY_BUFFER_MAX_BYTES`]: reset the emulator and
    /// write it.
    pub buffer: String,
    pub size: PtySize,
}

/// A PTY size (`decodeSize`): 2 to 240 columns, 1 to 100 rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
}

impl PtySize {
    /// A size the Host accepts, or an error naming the one given.
    pub fn new(cols: u16, rows: u16) -> Result<Self, RuntimeResourceInputError> {
        let cols_ok =
            (RUNTIME_RESOURCE_MIN_PTY_COLS..=RUNTIME_RESOURCE_MAX_PTY_COLS).contains(&cols);
        let rows_ok =
            (RUNTIME_RESOURCE_MIN_PTY_ROWS..=RUNTIME_RESOURCE_MAX_PTY_ROWS).contains(&rows);
        if cols_ok && rows_ok {
            Ok(Self { cols, rows })
        } else {
            Err(RuntimeResourceInputError::Size { cols, rows })
        }
    }

    /// The nearest size the Host accepts, for a view measured in cells.
    pub fn clamped(cols: u16, rows: u16) -> Self {
        Self {
            cols: cols.clamp(RUNTIME_RESOURCE_MIN_PTY_COLS, RUNTIME_RESOURCE_MAX_PTY_COLS),
            rows: rows.clamp(RUNTIME_RESOURCE_MIN_PTY_ROWS, RUNTIME_RESOURCE_MAX_PTY_ROWS),
        }
    }
}

/// `RuntimeResourcePtyControl` (`decodePtyControl`), by `kind`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub enum PtyControl {
    /// Bytes for the shell, as a terminal emulator encodes keys (Enter is
    /// `\r`).
    Input {
        input: String,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    InputAndResize {
        input: String,
        cols: u16,
        rows: u16,
    },
}

impl PtyControl {
    /// Input of 1 to [`RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES`] bytes.
    pub fn input(input: impl Into<String>) -> Result<Self, RuntimeResourceInputError> {
        Ok(Self::Input { input: checked_input(input.into())? })
    }

    pub fn resize(size: PtySize) -> Self {
        Self::Resize { cols: size.cols, rows: size.rows }
    }

    /// Input and a new size in one control.
    pub fn input_and_resize(
        input: impl Into<String>,
        size: PtySize,
    ) -> Result<Self, RuntimeResourceInputError> {
        Ok(Self::InputAndResize {
            input: checked_input(input.into())?,
            cols: size.cols,
            rows: size.rows,
        })
    }
}

fn checked_input(input: String) -> Result<String, RuntimeResourceInputError> {
    if input.is_empty() || input.len() > RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES {
        return Err(RuntimeResourceInputError::Input { bytes: input.len() });
    }
    Ok(input)
}

/// `RuntimeResourceControllerControlInput`
/// (`decodeRuntimeResourceControllerControlInput`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RuntimeResourceControlInput {
    pub session_id: String,
    #[serde(rename = "ref")]
    pub resource_ref: String,
    pub controller_id: String,
    /// 1 to [`RUNTIME_RESOURCE_MAX_CONTROL_SEQUENCE`]: the acquire's
    /// `nextSequence`, then one more per control.
    pub sequence: u64,
    pub control: PtyControl,
}

impl RuntimeResourceControlInput {
    /// `control` as the controller's `sequence`th.
    pub fn new(
        controller: &RuntimeResourceControllerInput,
        sequence: u64,
        control: PtyControl,
    ) -> Self {
        Self {
            session_id: controller.session_id.clone(),
            resource_ref: controller.resource_ref.clone(),
            controller_id: controller.controller_id.clone(),
            sequence,
            control,
        }
    }
}

/// `RuntimeResourceControllerControlResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RuntimeResourceControlResult {
    pub controller_id: String,
    pub sequence: u64,
}

/// `RuntimeResourceControllerReleaseResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RuntimeResourceReleaseResult {
    pub controller_id: String,
    /// `false` when no controller held the resource (the shell ended and
    /// the Host released it, or it was never acquired).
    pub released: bool,
}

/// `RuntimeResourceStopInput` (`decodeRuntimeResourceStopInput`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RuntimeResourceStopInput {
    pub session_id: String,
    #[serde(rename = "ref")]
    pub resource_ref: String,
}

impl RuntimeResourceStopInput {
    pub fn new(session_id: impl Into<String>, resource_ref: impl Into<String>) -> Self {
        Self { session_id: session_id.into(), resource_ref: resource_ref.into() }
    }
}

/// `RuntimeResourceStopResult`: `{}`. The stopped state arrives as a
/// `runtime_resource` domain change.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, serde(deny_unknown_fields))]
#[non_exhaustive]
pub struct RuntimeResourceStopResult {}

/// An input this client refuses to send because the Host's decoder would.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum RuntimeResourceInputError {
    #[error("PTY input must be 1 to 32 KiB, not {bytes} bytes")]
    Input { bytes: usize },
    #[error("a PTY of {cols}x{rows} is outside 2-240 columns and 1-100 rows")]
    Size { cols: u16, rows: u16 },
    #[error("a command must not be blank or longer than 32 KiB")]
    Command,
    #[error("PTY interest names at most 16 distinct refs")]
    PtyInterest,
}

/// What a failed `runtime.resource.*` request means for a terminal.
///
/// The Host answers most refusals with `operation_conflict` and tells them
/// apart only by message, so this reads both (the messages are the fixed
/// strings of `HostRuntimeResourceCoordinator`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum RuntimeResourceFailure {
    /// Another controller holds the PTY: a second acquire, or a release of a
    /// seat this connection does not hold. One controller per resource.
    ControllerHeld,
    /// This connection's controller is gone (released, or released by the
    /// Host when the shell ended); acquire again.
    ControllerLost,
    /// The controller id is already bound to another resource on this
    /// connection.
    ControllerIdInUse,
    /// Only a live PTY can be controlled: the shell ended, the resource is
    /// not a PTY, or the Host restarted and orphaned it.
    NotLive,
    /// The PTY is stopping and takes no more input; the Host released the
    /// controller.
    Stopping,
    /// A control out of order, or a sequence retried with other input:
    /// acquire again for the next sequence.
    SequenceConflict,
    /// Any other `operation_conflict`.
    Conflict,
    SessionArchived,
    /// The Session or the resource does not exist.
    NotFound,
    /// The Host refused the input or ref.
    InvalidRequest,
    /// `internal_failure`. This is also what a start past
    /// [`MAX_LIVE_PTY_RUNS`] (or 64 live runs of any kind) answers: the
    /// manager's slot error is not typed, so the coordinator reports
    /// "Runtime Resource operation failed" and asks the Host to drain, after
    /// which it stops serving (`#resourceFailure`, `reserveSlot` in
    /// `packages/runtime/src/shell-run-manager.ts`). A client should not
    /// start a terminal while it can see that many live PTYs.
    HostFailure,
    /// Not ready, draining, unavailable, or a code this client does not
    /// know.
    Unavailable,
}

impl RuntimeResourceFailure {
    /// Classifies a Host error answer to a `runtime.resource.*` request.
    pub fn of(error: &HostOperationError) -> Self {
        match error.code {
            HostOperationErrorCode::OperationConflict => match error.message.as_str() {
                "Runtime Resource already has a connected controller"
                | "Runtime Resource controller is held by another connection" => {
                    Self::ControllerHeld
                }
                "Runtime Resource controller is not held by this connection" => {
                    Self::ControllerLost
                }
                "Controller identity is already bound to another Runtime Resource" => {
                    Self::ControllerIdInUse
                }
                "Only an active PTY Runtime Resource can be controlled" => Self::NotLive,
                "Runtime Resource PTY control is closed while the process is stopping" => {
                    Self::Stopping
                }
                "Controller sequence was retried with different input"
                | "Runtime Resource controller sequence is out of order" => Self::SequenceConflict,
                _ => Self::Conflict,
            },
            HostOperationErrorCode::SessionArchived => Self::SessionArchived,
            HostOperationErrorCode::NotFound => Self::NotFound,
            HostOperationErrorCode::InvalidRequest => Self::InvalidRequest,
            HostOperationErrorCode::InternalFailure => Self::HostFailure,
            _ => Self::Unavailable,
        }
    }
}

/// `runtime.resource.query` (mode `query`).
#[derive(Debug)]
pub enum RuntimeResourceQuery {}

impl Operation for RuntimeResourceQuery {
    const NAME: &'static str = "runtime.resource.query";
    type Input = RuntimeResourceQueryInput;
    type Output = RuntimeResourceQueryResult;
}

/// `runtime.resource.start` (mode `command`).
#[derive(Debug)]
pub enum RuntimeResourceStart {}

impl Operation for RuntimeResourceStart {
    const NAME: &'static str = "runtime.resource.start";
    type Input = RuntimeResourceStartInput;
    type Output = RuntimeResourceStartResult;
}

/// `runtime.resource.controller.acquire` (mode `control`).
#[derive(Debug)]
pub enum RuntimeResourceControllerAcquire {}

impl Operation for RuntimeResourceControllerAcquire {
    const NAME: &'static str = "runtime.resource.controller.acquire";
    type Input = RuntimeResourceControllerInput;
    type Output = RuntimeResourceAcquireResult;
}

/// `runtime.resource.controller.control` (mode `control`).
#[derive(Debug)]
pub enum RuntimeResourceControllerControl {}

impl Operation for RuntimeResourceControllerControl {
    const NAME: &'static str = "runtime.resource.controller.control";
    type Input = RuntimeResourceControlInput;
    type Output = RuntimeResourceControlResult;
}

/// `runtime.resource.controller.release` (mode `control`).
#[derive(Debug)]
pub enum RuntimeResourceControllerRelease {}

impl Operation for RuntimeResourceControllerRelease {
    const NAME: &'static str = "runtime.resource.controller.release";
    type Input = RuntimeResourceControllerInput;
    type Output = RuntimeResourceReleaseResult;
}

/// `runtime.resource.stop` (mode `control`).
#[derive(Debug)]
pub enum RuntimeResourceStop {}

impl Operation for RuntimeResourceStop {
    const NAME: &'static str = "runtime.resource.stop";
    type Input = RuntimeResourceStopInput;
    type Output = RuntimeResourceStopResult;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn round_trip<T: serde::de::DeserializeOwned + Serialize>(value: Value) -> T {
        let decoded: T = serde_json::from_value(value.clone()).expect("decode");
        assert_eq!(serde_json::to_value(&decoded).expect("encode"), value);
        decoded
    }

    fn terminal_state(status: &str, end: Value) -> Value {
        let mut state = json!({
            "kind": "shell_run", "ref": "maka://runtime/background-tasks/r1", "mode": "pty",
            "status": status, "pid": 42, "cwd": "/tmp/w", "cmd": "exec \"$SHELL\" -l",
            "startedAt": 1, "updatedAt": 2, "revision": 3
        });
        if let (Value::Object(state), Value::Object(end)) = (&mut state, end) {
            state.extend(end);
        }
        state
    }

    #[test]
    fn a_listed_terminal_names_its_launch_and_ends_with_a_terminal_status() {
        let resource: RuntimeResource = round_trip(json!({
            "sessionId": "s", "ownership": {"kind": "local"},
            "sourceTurnId": "desktop-terminal-1", "sourceToolCallId": "desktop-terminal-1",
            "result": terminal_state("cancelled", json!({"completedAt": 4, "exitCode": 130}))
        }));
        assert_eq!(resource.launch_id(), Some("desktop-terminal-1"));
        assert!(resource.is_desktop_terminal());
        assert!(resource.result.status.is_terminal() && !resource.result.status.is_active());
        assert_eq!(resource.result.exit_code, Some(130));

        let agent: RuntimeResource = round_trip(json!({
            "sessionId": "s",
            "ownership": {"kind": "source_owned", "sourceSessionId": "a", "ownerSessionId": "b"},
            "sourceTurnId": "turn", "sourceToolCallId": "call",
            "result": terminal_state("running", json!({}))
        }));
        assert_eq!(agent.launch_id(), None);
        assert!(!agent.is_desktop_terminal());
        assert!(agent.result.status.is_active());
        let unknown: ShellRunStatus = serde_json::from_value(json!("paused")).expect("decode");
        assert!(!unknown.is_active() && !unknown.is_terminal());
    }

    #[test]
    fn a_state_may_carry_its_output() {
        let mut state = terminal_state("completed", json!({"completedAt": 4, "exitCode": 0}));
        state["output"] = json!({
            "mode": "pty", "screen": "% ", "scrollback": "", "cols": 80, "rows": 24,
            "cursor": {"x": 2, "y": 0, "visible": true}, "alternateScreen": false,
            "truncated": false, "redacted": false
        });
        let state: ShellRunState = round_trip(state);
        assert!(matches!(state.output, Some(ShellOutput::Pty(ref pty)) if pty.cursor.x == 2));
    }

    #[test]
    fn query_results_decode_by_kind() {
        let page: RuntimeResourceQueryResult = round_trip(json!({
            "kind": "page", "sessionId": "s", "revision": "sha256:00", "resources": [],
            "nextCursor": null
        }));
        assert!(matches!(page, RuntimeResourceQueryResult::Page { next_cursor: None, .. }));
        let missing: RuntimeResourceQueryResult = round_trip(json!({
            "kind": "resource", "sessionId": "s", "revision": "sha256:00", "resource": null
        }));
        assert!(matches!(missing, RuntimeResourceQueryResult::Resource { resource: None, .. }));
        let future: RuntimeResourceQueryResult =
            serde_json::from_value(json!({"kind": "summary"})).expect("decode");
        assert_eq!(future, RuntimeResourceQueryResult::Unknown);
    }

    #[test]
    fn inputs_encode_as_the_host_decodes_them() {
        assert_eq!(
            serde_json::to_value(RuntimeResourceStartInput::terminal("s", "u1")).expect("encode"),
            json!({"sessionId": "s", "launchId": "desktop-terminal-u1"})
        );
        assert_eq!(
            RuntimeResourceStartInput::command("s", "l", " \n"),
            Err(RuntimeResourceInputError::Command)
        );
        let controller = RuntimeResourceControllerInput::new("s", "r", "c");
        let size = PtySize::new(100, 30).expect("size");
        let control = RuntimeResourceControlInput::new(
            &controller,
            2,
            PtyControl::input_and_resize("ls\r", size).expect("input"),
        );
        assert_eq!(
            serde_json::to_value(control).expect("encode"),
            json!({"sessionId": "s", "ref": "r", "controllerId": "c", "sequence": 2,
                   "control": {"kind": "input_and_resize", "input": "ls\r",
                               "cols": 100, "rows": 30}})
        );
        assert_eq!(
            serde_json::to_value(PtyControl::resize(size)).expect("encode"),
            json!({"kind": "resize", "cols": 100, "rows": 30})
        );
        assert_eq!(serde_json::to_value(RuntimeResourceStopResult {}).expect("encode"), json!({}));
    }

    #[test]
    fn inputs_past_the_host_limits_are_refused() {
        assert_eq!(PtyControl::input(""), Err(RuntimeResourceInputError::Input { bytes: 0 }));
        let long = "x".repeat(RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES + 1);
        assert!(PtyControl::input(long).is_err());
        assert!(PtyControl::input("x".repeat(RUNTIME_RESOURCE_CONTROL_INPUT_MAX_BYTES)).is_ok());
        assert_eq!(PtySize::new(1, 24), Err(RuntimeResourceInputError::Size { cols: 1, rows: 24 }));
        assert!(PtySize::new(241, 24).is_err() && PtySize::new(80, 0).is_err());
        assert!(PtySize::new(80, 101).is_err() && PtySize::new(240, 100).is_ok());
        assert_eq!(PtySize::clamped(1000, 0), PtySize { cols: 240, rows: 1 });
    }

    #[test]
    fn failures_tell_the_seat_the_sequence_and_the_host_apart() {
        let conflict = |message: &str| {
            RuntimeResourceFailure::of(&HostOperationError::new(
                HostOperationErrorCode::OperationConflict,
                message,
            ))
        };
        assert_eq!(
            conflict("Runtime Resource already has a connected controller"),
            RuntimeResourceFailure::ControllerHeld
        );
        assert_eq!(
            conflict("Runtime Resource controller is not held by this connection"),
            RuntimeResourceFailure::ControllerLost
        );
        assert_eq!(
            conflict("Only an active PTY Runtime Resource can be controlled"),
            RuntimeResourceFailure::NotLive
        );
        assert_eq!(
            conflict("Runtime Resource controller sequence is out of order"),
            RuntimeResourceFailure::SequenceConflict
        );
        assert_eq!(conflict("something new"), RuntimeResourceFailure::Conflict);
        let internal = HostOperationError::new(
            HostOperationErrorCode::InternalFailure,
            "Runtime Resource operation failed",
        );
        assert_eq!(RuntimeResourceFailure::of(&internal), RuntimeResourceFailure::HostFailure);
        let draining = HostOperationError::new(HostOperationErrorCode::HostDraining, "draining");
        assert_eq!(RuntimeResourceFailure::of(&draining), RuntimeResourceFailure::Unavailable);
    }
}
