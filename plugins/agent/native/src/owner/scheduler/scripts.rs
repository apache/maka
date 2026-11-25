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

use super::*;
use maka_process::{ProcessOutcome, ShellExecutor, Termination};
use maka_sandbox::Sandbox;
use maka_scheduler::plan::{ScriptOutcome, StateUpdate};
use std::time::Instant;

pub(super) struct Check {
    pub id: String,
    pub revision: u64,
    pub result: Result<ScriptOutcome, String>,
}

impl Owner {
    pub(super) async fn check_scheduled_script(
        &self,
        approval: BackgroundGrant,
        source: String,
        prev_state: Option<&str>,
    ) -> Result<ScriptOutcome, String> {
        let target = approval.target();
        let session = self.session(&target.session_id).await?;
        let config = session.configuration;
        if session.archived
            || config.binding != target.binding
            || config.boundary_revision != target.boundary_revision
            || config.workspace != target.workspace
            || config.permissions != target.permissions
        {
            return Err("Conversation access changed. Update this automation to continue.".into());
        }
        self.check_automation(
            &config,
            approval.sandbox_ceiling().unwrap_or(&Sandbox::Disabled),
            source,
            prev_state,
            self.stop.child_token(),
        )
        .await?
        .result
    }

    async fn check_automation(
        &self,
        config: &ResolvedConfiguration,
        ceiling: &Sandbox,
        source: String,
        prev_state: Option<&str>,
        cancellation: CancellationToken,
    ) -> Result<ScriptExecution, String> {
        let sandbox = self.capture_sandbox(config, ceiling).await?;
        let (path, directory, _) = workspace::open_workspace_observation(
            &self.workspace_roots,
            &config.workspace,
            &self.managed_worktrees,
        )
        .await
        .map_err(reason)?;
        let executor = tokio::task::spawn_blocking(move || {
            ShellExecutor::from_directory(path, directory.into_std_file(), sandbox).map_err(reason)
        })
        .await
        .map_err(reason)??;
        let network = self
            .configuration
            .network_configuration()
            .await
            .map_err(reason)?;
        let route =
            maka_network::Policy::from_host_settings(&network.proxy, network.password.as_deref())
                .map_err(reason)?;
        let executor = executor.with_network_route(route);
        #[cfg(target_os = "linux")]
        let executor = executor.with_network_helper(self.helper.clone());
        #[cfg(windows)]
        let executor =
            executor.with_backend(Arc::new(maka_host_runtime::sandbox::windows::Backend::new(
                self.store.owned_root().map_err(reason)?.canonical_path(),
                &self.helper,
            )));
        run_script(
            executor,
            self.helper.clone(),
            source,
            prev_state,
            cancellation,
        )
        .await
    }

    pub(super) async fn test_script(
        &self,
        config: &ResolvedConfiguration,
        ceiling: &Sandbox,
        source: String,
        state: Option<Value>,
        cancellation: CancellationToken,
    ) -> Result<Value, String> {
        let start = Instant::now();
        let execution = async {
            let state = state
                .as_ref()
                .map(maka_scheduler::plan::compact_script_state)
                .transpose()?;
            self.check_automation(config, ceiling, source, state.as_deref(), cancellation)
                .await
        }
        .await;
        let execution = execution.unwrap_or_else(|error| ScriptExecution {
            result: Err(error),
            stdout: String::new(),
            stderr: String::new(),
        });
        execution.report(start.elapsed())
    }
}

struct ScriptExecution {
    result: Result<ScriptOutcome, String>,
    stdout: String,
    stderr: String,
}

impl ScriptExecution {
    fn report(self, duration: Duration) -> Result<Value, String> {
        let ok = self.result.is_ok();
        let mut report = match self.result {
            Ok(outcome) => {
                let mut fields =
                    serde_json::to_value(outcome.payload.unwrap_or_default()).map_err(reason)?;
                fields["triggered"] = outcome.triggered.into();
                match outcome.state_update {
                    StateUpdate::Unchanged => {}
                    StateUpdate::Clear => fields["state"] = Value::Null,
                    StateUpdate::Set(state) => {
                        fields["state"] = serde_json::from_str(&state).map_err(reason)?
                    }
                }
                fields
            }
            Err(error) => serde_json::json!({"error":error}),
        };
        report["ok"] = ok.into();
        report["stdout"] = diagnostic(&self.stdout).into();
        report["stderr"] = diagnostic(&self.stderr).into();
        report["durationMs"] = (duration.as_millis() as u64).into();
        Ok(report)
    }
}

fn diagnostic(text: &str) -> &str {
    &text[text.ceil_char_boundary(text.len().saturating_sub(8192))..]
}

async fn run_script(
    executor: ShellExecutor,
    executable: std::path::PathBuf,
    source: String,
    prev_state: Option<&str>,
    cancellation: CancellationToken,
) -> Result<ScriptExecution, String> {
    let args = [maka_js_runtime::automation::WORKER.to_owned()];
    let mut env = BTreeMap::new();
    if let Some(state) = prev_state {
        env.insert("MAKA_AUTOMATION_STATE".into(), state.to_owned());
    }
    let command = executor
        .command_program(executable, &args, &env)
        .map_err(reason)?;
    let output = command
        .run_with_input(source.into_bytes(), 30_000, cancellation)
        .await
        .map_err(reason)?;
    let result = match output.outcome {
        ProcessOutcome::Exited(status) if status.success() => {
            // A truncated first line might end in what looks like a valid result.
            let complete = if output.stdout_truncated {
                output.stdout.split_once('\n').map_or("", |(_, rest)| rest)
            } else {
                &output.stdout
            };
            parse_stdout(complete)
        }
        ProcessOutcome::Exited(status) => {
            let stderr = diagnostic(output.stderr.trim());
            Err(if stderr.is_empty() {
                format!("Script failed ({status})")
            } else {
                format!("Script failed ({status}): {stderr}")
            })
        }
        ProcessOutcome::Interrupted {
            reason: Termination::Timeout,
            ..
        } => Err("Script check timed out".into()),
        ProcessOutcome::Interrupted {
            reason: Termination::Cancelled,
            ..
        } => Err("Script check cancelled".into()),
    };
    Ok(ScriptExecution {
        result,
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

fn parse_stdout(stdout: &str) -> Result<ScriptOutcome, String> {
    const EXPECTED: &str = r#"Print true, false, or a JSON object such as {"trigger":true} on the last non-empty stdout line"#;
    match stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
    {
        Some("true") => Ok(true.into()),
        Some("false") => Ok(false.into()),
        Some(line) if line.starts_with('{') => serde_json::from_str(line)
            .map_err(|error| format!("{EXPECTED}: {}", diagnostic(&error.to_string()))),
        _ => Err(EXPECTED.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_scheduler::plan::ScriptPayload;
    use serde_json::json;

    #[test]
    fn failed_dry_run_keeps_the_utf8_tail_of_both_streams() {
        let text = format!("{}x", "é".repeat(5000));
        let report = ScriptExecution {
            result: Err("invalid result".into()),
            stdout: text.clone(),
            stderr: text.clone(),
        }
        .report(Duration::from_millis(12))
        .unwrap();
        let tail = format!("{}x", "é".repeat(4095));
        assert_eq!(
            report,
            json!({"ok":false,"error":"invalid result","stdout":tail,"stderr":tail,"durationMs":12})
        );
    }

    #[test]
    fn last_nonempty_line_selects_a_boolean_or_a_structured_outcome() {
        for value in [false, true] {
            assert_eq!(
                parse_stdout(&format!("log\n {value} \r\n \n")).unwrap(),
                value.into()
            );
        }
        let parsed = parse_stdout(r#"{"trigger":true,"summary":"  已完成  ","data":{"n":2},"state": [1, 2],"dedupeKey":" e2 "}"#).unwrap();
        assert_eq!(
            parsed,
            ScriptOutcome {
                triggered: true,
                dedupe_key: Some("e2".into()),
                payload: Some(ScriptPayload {
                    summary: Some("已完成".into()),
                    data: Some(json!({"n":2})),
                    dedupe_key: Some("e2".into())
                }),
                state_update: StateUpdate::Set("[1,2]".into()),
            }
        );
        assert_eq!(
            parse_stdout(r#"{"trigger":false,"summary":"  "}"#).unwrap(),
            false.into()
        );
        let clear = parse_stdout(r#"{"trigger":false,"state":null,"data":null}"#).unwrap();
        assert_eq!(clear.state_update, StateUpdate::Clear);
        assert_eq!(clear.payload.unwrap().data, Some(Value::Null));
    }

    #[test]
    fn stdout_limits_count_trimmed_utf8_and_compact_json_bytes() {
        for (field, at_limit) in [
            ("summary", "é".repeat(2048)),
            ("dedupeKey", "é".repeat(128)),
            ("data", "é".repeat(8191)),
            ("state", "é".repeat(32767)),
        ] {
            let line = |value| json!({"trigger":true,field:value}).to_string();
            assert!(parse_stdout(&line(at_limit.clone())).is_ok(), "{field}");
            assert!(
                parse_stdout(&line(at_limit + "!"))
                    .unwrap_err()
                    .contains(field)
            );
        }
        assert!(
            parse_stdout(r#"{"trigger":true,"dedupeKey":" "}"#)
                .unwrap_err()
                .contains("dedupeKey")
        );
    }

    #[test]
    fn invalid_stdout_explains_the_protocol_and_rejects_unknown_or_mistyped_fields() {
        for line in [
            "",
            "true\nlater log",
            "[]",
            "1",
            r#""true""#,
            "{",
            "{}",
            r#"{"trigger":"true"}"#,
            r#"{"trigger":true,"extra":1}"#,
            r#"{"trigger":true,"dedupeKey":42}"#,
            r#"{"trigger":true,"summary":null}"#,
            r#"{"trigger":true,"dedupeKey":null}"#,
            r#"{"trigger":true,"trigger":false}"#,
        ] {
            let error = parse_stdout(line).unwrap_err();
            assert!(
                error.contains("true, false") && error.contains(r#"{"trigger":"#),
                "{line}: {error}"
            );
        }
    }
}
