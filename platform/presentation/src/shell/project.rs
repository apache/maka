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

use super::{
    Ownership, RESOURCE_REF_PREFIX, ResourceUpdate, SNAPSHOT_MAX_BYTES, ShellMode, ShellOutput,
    ShellSnapshot, ShellStatus,
};
use crate::ProjectionError;
use maka_plugin_core::shell_run::ShellOutcome;
use maka_plugin_core::shell_run::ShellOutput as StoredOutput;
use maka_plugin_core::shell_run::ShellState;
use maka_plugin_core::shell_run::{ShellObservation, ShellRun};
use maka_plugin_core::terminal::TerminalScreen;
use std::sync::Arc;

const MODEL_BYTES: usize = maka_plugin_core::terminal::PREVIEW_BYTES;
const TERMINAL_MARKER: &str = "[terminal snapshot truncated to fit the output limit]";
const FIELD_MARKER: &str = "[runtime resource field truncated]";
const RECOVERY: &str = "If the command is safe to re-run, redirect its output to a file (e.g. `cmd > out.txt 2>&1`) then Read or Grep that file for the omitted portion. If re-running could repeat side effects, do not. Otherwise work from the kept output above.";

pub fn local_update(record: ShellRun) -> Result<ResourceUpdate, ProjectionError> {
    project(record, true, None)
}

pub fn local_observation(observation: ShellObservation) -> Result<ResourceUpdate, ProjectionError> {
    project((*observation.record).clone(), true, observation.preview)
}

pub fn local_state(record: ShellRun) -> Result<ShellSnapshot, ProjectionError> {
    local_metadata(record).map(|update| update.result)
}

/// The same canonical ownership/source envelope without terminal output.
pub fn local_metadata(record: ShellRun) -> Result<ResourceUpdate, ProjectionError> {
    project(record, false, None)
}

fn project(
    record: ShellRun,
    include_output: bool,
    preview: Option<Arc<TerminalScreen>>,
) -> Result<ResourceUpdate, ProjectionError> {
    record
        .validate_metadata()
        .map_err(ProjectionError::Invalid)?;
    let (status, completed_at, exit_code, failure_message) = match record.state {
        ShellState::Starting => (ShellStatus::Starting, None, None, None),
        ShellState::Running => (ShellStatus::Running, None, None, None),
        ShellState::Terminal {
            completed_at,
            outcome,
            ..
        } => {
            let code = outcome.exit_code();
            let (status, message) = match outcome {
                ShellOutcome::Completed => (ShellStatus::Completed, None),
                ShellOutcome::Exited { message, .. } => (ShellStatus::Failed, message),
                ShellOutcome::Failed { message } => (ShellStatus::Failed, Some(message)),
                ShellOutcome::TimedOut { message } => (ShellStatus::TimedOut, message),
                ShellOutcome::Cancelled { message } => (ShellStatus::Cancelled, message),
                ShellOutcome::Orphaned { message } => (ShellStatus::Orphaned, Some(message)),
            };
            (status, Some(completed_at), code, message)
        }
    };
    let mode = if record.output.is_pty() {
        ShellMode::Pty
    } else {
        ShellMode::Pipes
    };
    let mut result = ShellSnapshot {
        kind: super::SnapshotKind::ShellRun,
        resource_ref: format!("{RESOURCE_REF_PREFIX}{}", record.id),
        mode,
        status,
        cwd: record.cwd,
        cmd: record.command,
        started_at: record.started_at,
        updated_at: record.updated_at,
        completed_at,
        timeout_ms: record.timeout_ms,
        exit_code,
        failure_message,
        revision: record.revision,
        output: include_output.then(|| model_output(record.output, preview)),
    };
    bound(&mut result)?;
    Ok(ResourceUpdate {
        session_id: record.session_id,
        ownership: Ownership::Local,
        correlation: record.correlation,
        visibility: record.visibility,
        result,
    })
}

fn model_output(output: StoredOutput, preview: Option<Arc<TerminalScreen>>) -> ShellOutput {
    match output {
        StoredOutput::Pipes {
            stdout,
            stderr,
            latest_stream,
            stdout_truncated,
            stderr_truncated,
        } => {
            let (stdout, out_cut) = pipe_tail(stdout);
            let (stderr, err_cut) = pipe_tail(stderr);
            ShellOutput::Pipes {
                stdout,
                stderr,
                latest_stream,
                stdout_truncated: stdout_truncated || out_cut,
                stderr_truncated: stderr_truncated || err_cut,
                redacted: false,
            }
        }
        StoredOutput::Pty { screen: display } => {
            let view = preview
                .as_deref()
                .cloned()
                .unwrap_or_else(|| display.text(MODEL_BYTES));
            let mut remaining = MODEL_BYTES;
            let (screen, screen_cut) = prioritized(view.screen, &mut remaining);
            let alternate = view
                .last_alternate_screen
                .map(|s| prioritized(s, &mut remaining));
            let (scrollback, scroll_cut) = tail(view.scrollback, remaining, TERMINAL_MARKER);
            let alternate_cut = alternate.as_ref().is_some_and(|(_, cut)| *cut);
            ShellOutput::Pty {
                screen,
                scrollback,
                last_alternate_screen: alternate.map(|(s, _)| s).filter(|s| !s.is_empty()),
                cols: view.size.cols(),
                rows: view.size.rows(),
                cursor: view.cursor,
                alternate_screen: view.alternate_screen,
                truncated: view.truncated || screen_cut || scroll_cut || alternate_cut,
                redacted: false,
            }
        }
    }
}
fn prioritized(text: String, remaining: &mut usize) -> (String, bool) {
    let (text, cut) = tail(text, *remaining, TERMINAL_MARKER);
    *remaining = if cut {
        0
    } else {
        remaining.saturating_sub(text.len())
    };
    (text, cut)
}
fn tail(text: String, budget: usize, marker: &str) -> (String, bool) {
    if text.len() <= budget {
        return (text, false);
    }
    let Some(bytes) = budget.checked_sub(marker.len() + 1) else {
        return (String::new(), true);
    };
    let start = text.ceil_char_boundary(text.len().saturating_sub(bytes));
    (format!("{marker}\n{}", &text[start..]), true)
}

// Same model-facing line/byte policy as runtime/tool-output.ts; no spill file,
// and the recovery hint explicitly forbids repeating unsafe side effects.
fn pipe_tail(text: String) -> (String, bool) {
    let body = text.strip_suffix('\n').unwrap_or(&text);
    let lines = body.split('\n').count();
    if lines <= 2000 && text.len() <= MODEL_BYTES {
        return (text, false);
    }
    let mut start = body.len();
    let mut retained = 0;
    let mut hit_bytes = false;
    for line in body.rsplit('\n').take(2000) {
        let candidate = start.saturating_sub(line.len() + usize::from(retained > 0));
        if body.len() - candidate > MODEL_BYTES {
            hit_bytes = true;
            break;
        }
        start = candidate;
        retained += 1;
    }
    if retained == 0 {
        start = body.ceil_char_boundary(body.len().saturating_sub(MODEL_BYTES));
        hit_bytes = true;
    }
    let removed = if hit_bytes {
        text.len() - (body.len() - start)
    } else {
        lines - retained
    };
    if removed == 0 {
        return (text, false);
    }
    let unit = if hit_bytes { "bytes" } else { "lines" };
    (
        format!(
            "...{removed} {unit} truncated. {RECOVERY}\n\n{}",
            &body[start..]
        ),
        true,
    )
}

#[derive(Clone, Copy)]
enum Field {
    Command,
    Cwd,
    Failure,
    Stdout,
    Stderr,
    Screen,
    Scrollback,
    Alternate,
}

fn bound(snapshot: &mut ShellSnapshot) -> Result<(), ProjectionError> {
    while serde_json::to_vec(snapshot)
        .map_err(|_| ProjectionError::Invalid("shell serialization failed"))?
        .len()
        > SNAPSHOT_MAX_BYTES
    {
        let mut fields = vec![
            (Field::Command, snapshot.cmd.len()),
            (Field::Cwd, snapshot.cwd.len()),
        ];
        if let Some(message) = &snapshot.failure_message {
            fields.push((Field::Failure, message.len()));
        }
        match &snapshot.output {
            Some(ShellOutput::Pipes { stdout, stderr, .. }) => {
                fields.extend([(Field::Stdout, stdout.len()), (Field::Stderr, stderr.len())])
            }
            Some(ShellOutput::Pty {
                screen,
                scrollback,
                last_alternate_screen,
                ..
            }) => {
                fields.extend([
                    (Field::Screen, screen.len()),
                    (Field::Scrollback, scrollback.len()),
                ]);
                if let Some(alternate) = last_alternate_screen {
                    fields.push((Field::Alternate, alternate.len()));
                }
            }
            None => {}
        }
        // Preserve source field order for equal byte lengths.
        let (field, length) = fields
            .into_iter()
            .reduce(|left, right| if right.1 > left.1 { right } else { left })
            .unwrap();
        if length == 0 {
            return Err(ProjectionError::TooLarge);
        }
        let keep_head = matches!(field, Field::Command | Field::Cwd | Field::Failure);
        let value = field_mut(snapshot, field);
        let budget = value.len() / 2;
        *value = if budget <= FIELD_MARKER.len() + 1 {
            String::new()
        } else if keep_head {
            let end = value.floor_char_boundary(budget - FIELD_MARKER.len() - 1);
            format!("{}\n{FIELD_MARKER}", &value[..end])
        } else {
            tail(std::mem::take(value), budget, FIELD_MARKER).0
        };
    }
    snapshot.validate().map_err(ProjectionError::Invalid)
}
fn field_mut(snapshot: &mut ShellSnapshot, field: Field) -> &mut String {
    match field {
        Field::Command => &mut snapshot.cmd,
        Field::Cwd => &mut snapshot.cwd,
        Field::Failure => snapshot.failure_message.as_mut().unwrap(),
        _ => match snapshot.output.as_mut().unwrap() {
            ShellOutput::Pipes {
                stdout,
                stderr,
                stdout_truncated,
                stderr_truncated,
                ..
            } => match field {
                Field::Stdout => {
                    *stdout_truncated = true;
                    stdout
                }
                Field::Stderr => {
                    *stderr_truncated = true;
                    stderr
                }
                _ => unreachable!(),
            },
            ShellOutput::Pty {
                screen,
                scrollback,
                last_alternate_screen,
                truncated,
                ..
            } => {
                *truncated = true;
                match field {
                    Field::Screen => screen,
                    Field::Scrollback => scrollback,
                    Field::Alternate => last_alternate_screen.as_mut().unwrap(),
                    _ => unreachable!(),
                }
            }
        },
    }
}
