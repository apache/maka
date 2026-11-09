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

use super::{MAX_PAGE_CHARS, ReadError, ReadPage, ReadRequest};
use maka_plugin_core::shell_result::{ShellMode, ShellOutput, ShellSnapshot, ShellStatus};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReadKind {
    Terminal,
    ShellRun,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Foreground {
    kind: ReadKind,
    status: ShellStatus,
    exit_code: Option<i64>,
    failure_message: Option<String>,
    output: ShellOutput,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadMetadata {
    kind: ReadKind,
    status: ShellStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<ShellMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    revision: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stdout_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stderr_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    redacted: Option<bool>,
}

/// Model-only page; the original committed snapshot remains the raw result.
pub fn read_shell_page(
    snapshot: &ShellSnapshot,
    request: &ReadRequest,
) -> Result<ReadPage, ReadError> {
    read_page_with_budget(snapshot, request, MAX_PAGE_CHARS)
}

fn read_page_with_budget(
    snapshot: &ShellSnapshot,
    request: &ReadRequest,
    budget: usize,
) -> Result<ReadPage, ReadError> {
    let metadata = ReadMetadata {
        kind: ReadKind::ShellRun,
        status: snapshot.status,
        mode: Some(snapshot.mode),
        revision: Some(snapshot.revision),
        exit_code: snapshot.exit_code,
        stdout_truncated: None,
        stderr_truncated: None,
        truncated: None,
        redacted: None,
    };
    page(
        budget,
        request,
        metadata,
        snapshot.output.as_ref(),
        snapshot.failure_message.as_deref(),
    )
}

pub(crate) fn read_archived_shell(
    serialized: &str,
    request: &ReadRequest,
    budget: usize,
) -> Option<Result<ReadPage, ReadError>> {
    if let Ok(snapshot) = serde_json::from_str::<ShellSnapshot>(serialized)
        && snapshot.validate().is_ok()
    {
        return Some(read_page_with_budget(&snapshot, request, budget));
    }
    let snapshot: Foreground = serde_json::from_str(serialized).ok()?;
    if snapshot.kind != ReadKind::Terminal {
        return None;
    }
    let metadata = ReadMetadata {
        kind: ReadKind::Terminal,
        status: snapshot.status,
        mode: None,
        revision: None,
        exit_code: snapshot.exit_code,
        stdout_truncated: None,
        stderr_truncated: None,
        truncated: None,
        redacted: None,
    };
    Some(page(
        budget,
        request,
        metadata,
        Some(&snapshot.output),
        snapshot.failure_message.as_deref(),
    ))
}

fn page(
    budget: usize,
    request: &ReadRequest,
    mut metadata: ReadMetadata,
    output: Option<&ShellOutput>,
    failure: Option<&str>,
) -> Result<ReadPage, ReadError> {
    let mut parts = Vec::new();
    match output {
        Some(ShellOutput::Pipes {
            stdout,
            stderr,
            stdout_truncated,
            stderr_truncated,
            redacted,
            ..
        }) => {
            parts.extend([stdout.as_str(), stderr.as_str()]);
            metadata.stdout_truncated = Some(*stdout_truncated);
            metadata.stderr_truncated = Some(*stderr_truncated);
            metadata.redacted = Some(*redacted);
        }
        Some(ShellOutput::Pty {
            scrollback,
            screen,
            last_alternate_screen,
            truncated,
            redacted,
            ..
        }) => {
            parts.extend([scrollback.as_str(), screen.as_str()]);
            parts.extend(last_alternate_screen.as_deref());
            metadata.truncated = Some(*truncated);
            metadata.redacted = Some(*redacted);
        }
        None => {}
    }
    parts.extend(failure);
    let text = parts
        .into_iter()
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    // Include the serialized metadata and its outer field name in the cap.
    let overhead = serde_json::to_string(&metadata)
        .expect("typed metadata is JSON")
        .encode_utf16()
        .count()
        + 12;
    let mut page = request.page_with_budget(&text, budget.saturating_sub(overhead))?;
    page.metadata = Some(metadata);
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::read::ReadInput;
    use maka_plugin_core::{shell_result::SnapshotKind, terminal::TerminalCursor};

    #[test]
    fn shell_pages_bound_the_whole_envelope_and_preserve_status_and_truncation() {
        let text = "😀x".repeat(6_000);
        for output in [
            ShellOutput::Pipes {
                stdout: text.clone(),
                stderr: "stderr".into(),
                latest_stream: None,
                stdout_truncated: true,
                stderr_truncated: false,
                redacted: false,
            },
            ShellOutput::Pty {
                scrollback: text.clone(),
                screen: "screen".into(),
                last_alternate_screen: Some("alternate".into()),
                cols: 80,
                rows: 24,
                cursor: TerminalCursor {
                    x: 0,
                    y: 0,
                    visible: true,
                },
                alternate_screen: false,
                truncated: true,
                redacted: false,
            },
        ] {
            let pty = matches!(output, ShellOutput::Pty { .. });
            let mut snapshot = ShellSnapshot {
                kind: SnapshotKind::ShellRun,
                resource_ref: "maka://runtime/background-tasks/item".into(),
                mode: if pty {
                    ShellMode::Pty
                } else {
                    ShellMode::Pipes
                },
                status: ShellStatus::Failed,
                cwd: "/work".into(),
                cmd: "fixture".into(),
                started_at: 1,
                updated_at: 2,
                completed_at: Some(2),
                timeout_ms: None,
                exit_code: Some(1),
                failure_message: Some("failure".into()),
                revision: 1,
                output: Some(output),
            };
            snapshot.validate().unwrap();
            let raw = serde_json::to_value(&snapshot).unwrap();
            let input: ReadInput =
                serde_json::from_value(serde_json::json!({"path":snapshot.resource_ref})).unwrap();
            let page = serde_json::to_value(
                read_shell_page(&snapshot, &input.resolve().unwrap()).unwrap(),
            )
            .unwrap();
            assert!(page.to_string().encode_utf16().count() <= MAX_PAGE_CHARS);
            assert!(text.starts_with(page["content"].as_str().unwrap()));
            assert_eq!(page["metadata"]["status"], "failed");
            assert_eq!(page["metadata"]["exitCode"], 1);
            assert_eq!(page["metadata"]["revision"], 1);
            assert_eq!(
                page["metadata"][if pty { "truncated" } else { "stdoutTruncated" }],
                true
            );
            assert_eq!(serde_json::to_value(&snapshot).unwrap(), raw);
            let next: ReadInput = serde_json::from_value(page["next"].clone()).unwrap();
            snapshot.failure_message = Some("changed".into());
            assert_eq!(
                read_shell_page(&snapshot, &next.resolve().unwrap()),
                Err(ReadError::ContentChanged)
            );
        }
    }
}
