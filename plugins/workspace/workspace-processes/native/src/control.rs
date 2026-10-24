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
use maka_agent_facts::shell_run::ShellPatch;
use maka_agent_facts::shell_run::ShellState;
use maka_agent_facts::shell_run::ShellVisibility;
use maka_agent_facts::shell_run::{ShellObservation, ShellRun};
use maka_host_runtime::shell::{ControlErrorKind, request::parse_ref, stdin};
use serde_json::json;

impl Processes {
    pub(super) async fn read_model(
        &self,
        tool: &ToolCallContext,
        id: &str,
    ) -> Result<ShellObservation, ToolError> {
        let session = &tool.invocation.session_id;
        if let Some(Ok(live)) = self
            .resources
            .get(session, id)
            .and_then(|handle| handle.latest())
            && live.state.active()
            && live.visibility == ShellVisibility::Model
            && live.id.starts_with(&self.prefix)
        {
            return Ok((*live).clone());
        }
        let record = maka_agent_authority::permissions::execution(
            &self.store,
            &tool.invocation,
            tool.execution.as_deref(),
        )?
        .read_shell_run(session, id)
        .await
        .map_err(persistence)?
        .filter(|record| {
            record.visibility == ShellVisibility::Model && record.id.starts_with(&self.prefix)
        })
        .ok_or_else(|| failed("Process resource not found in this Session and provider"))?;
        if let Some(update) = self
            .resources
            .get(session, id)
            .and_then(|handle| handle.latest())
        {
            return prefer_live(record, update);
        }
        Ok(record.into())
    }
    pub(super) async fn project(
        &self,
        tool: &ToolCallContext,
        mut record: ShellObservation,
        compact: bool,
    ) -> Result<Value, ToolError> {
        if matches!(
            record.state,
            ShellState::Terminal {
                observed_at: None,
                ..
            }
        ) {
            record.record = Arc::new(
                maka_agent_authority::permissions::execution(
                    &self.store,
                    &tool.invocation,
                    tool.execution.as_deref(),
                )?
                .patch_shell_run(
                    &record.session_id,
                    &record.id,
                    ShellPatch {
                        observed_at: Some(maka_agent_authority::now()),
                        ..Default::default()
                    },
                )
                .await
                .map_err(persistence)?,
            );
            record.preview = None;
        }
        let mut snapshot = maka_presentation::shell::local_observation(record)
            .map_err(persistence)?
            .result;
        if compact {
            snapshot.output = None;
        }
        serde_json::to_value(snapshot).map_err(persistence)
    }
    pub(super) async fn control(
        &self,
        name: &str,
        value: Value,
        tool: &ToolCallContext,
        cancellation: &CancellationToken,
    ) -> Result<Value, ToolError> {
        let session = &tool.invocation.session_id;
        if name == "writeStdin" {
            return self
                .write(stdin::Input::parse(value)?, tool, cancellation)
                .await;
        }
        let input: Reference = serde_json::from_value(value).map_err(failed)?;
        let id =
            parse_ref(&input.reference).ok_or_else(|| failed("Invalid process resource ref"))?;
        let mut record = self.read_model(tool, id).await?;
        cancelled(cancellation)?;
        if name == "read" {
            return self.project(tool, record, false).await;
        }
        let applied = if let Some(mut handle) = self.resources.get(session, id) {
            // Stop bypasses input backpressure and remains available after revocation.
            let receipt = handle.stop_and_wait().await.map_err(worker_error)?;
            record = (*handle.drained().await.map_err(worker_error)?).clone();
            receipt.applied
        } else {
            if record.state.active() {
                record = self.read_model(tool, id).await?;
                if record.state.active() {
                    return Err(ToolError::CleanupUnconfirmed(
                        "Active process has no native owner".into(),
                    ));
                }
            }
            false
        };
        let mut value = self.project(tool, record, false).await?;
        value["operation"] = json!({"kind":"stop","applied":applied});
        Ok(value)
    }
    async fn write(
        &self,
        input: stdin::Input,
        tool: &ToolCallContext,
        cancellation: &CancellationToken,
    ) -> Result<Value, ToolError> {
        let session = &tool.invocation.session_id;
        let id = parse_ref(&input.reference).expect("validated ref");
        let mut record = self.read_model(tool, id).await?;
        if !record.output.is_pty() {
            return Err(failed("writeStdin requires a PTY process ref"));
        }
        let mut accepted_bytes = 0;
        let mut resized = false;
        let mut resize_changed = false;
        let mut failure = None;
        if let Some(mut handle) = self.resources.get(session, id) {
            let gate = handle.control_gate();
            let _guard = tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(failed("PTY input cancelled before admission")),
                guard = gate.lock() => guard,
            };
            record = (*handle.ready().await.map_err(worker_error)?).clone();
            if record.state.active() {
                if self.controllers.lock().unwrap().iter().any(|lease| {
                    lease.controller.target.session_id == *session
                        && lease.controller.target.reference == input.reference
                        && !lease.cancellation.is_cancelled()
                }) {
                    return Err(failed("PTY is controlled by a connected user"));
                }
                let current = maka_agent_authority::permissions::live(
                    &maka_agent_authority::permissions::execution(
                        &self.store,
                        &tool.invocation,
                        tool.execution.as_deref(),
                    )?,
                    &tool.invocation,
                )
                .await?;
                if current.permission_basis() != record.permissions.basis {
                    return Err(failed(
                        "PTY launch permissions no longer match this Session; start a new terminal",
                    ));
                }
                cancelled(cancellation)?;
                let result =
                    match handle.enqueue_control(input.data, input.size, cancellation.clone()) {
                        Ok(receipt) => receipt.await,
                        Err(error) => Err(error),
                    };
                match result {
                    Ok(receipt) => {
                        accepted_bytes = receipt.accepted_bytes;
                        resized = receipt.resized;
                        resize_changed = receipt.resize_changed;
                        record = (*receipt.record).clone();
                    }
                    Err(error) => match error.kind {
                        ControlErrorKind::Rejected => return Err(failed(error)),
                        ControlErrorKind::Unknown => {
                            return Err(ToolError::CleanupUnconfirmed(error.to_string()));
                        }
                        ControlErrorKind::Closed => {
                            handle.stop();
                            record = (*handle.drained().await.map_err(worker_error)?).clone();
                            accepted_bytes = error.accepted_bytes.expect("known input closure");
                            resized = error.resized.expect("known input closure");
                            resize_changed = error.resize_changed.expect("known input closure");
                            failure = Some(error.message);
                        }
                    },
                }
            }
        } else if record.state.active() {
            record = self.read_model(tool, id).await?;
            if record.state.active() {
                return Err(ToolError::CleanupUnconfirmed(
                    "Active PTY has no native owner".into(),
                ));
            }
        }
        let mut value = self.project(tool, record, false).await?;
        value["operation"] = json!({"kind":"pty_control", "acceptedBytes":accepted_bytes,
            "requestedBytes":input.bytes,"resized":resized,"resizeChanged":resize_changed,"failure":failure});
        Ok(value)
    }
}

// SQL remains the durable authority; an equal revision may carry newer live output.
pub(super) fn prefer_live(
    durable: ShellRun,
    update: Result<Arc<ShellObservation>, Arc<ShellError>>,
) -> Result<ShellObservation, ToolError> {
    let live = update.map_err(worker_error)?;
    Ok(if live.revision >= durable.revision {
        (*live).clone()
    } else {
        durable.into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::shell_run::{ShellOutcome, ShellOutput, ShellPermissions};

    fn running() -> ShellRun {
        ShellRun {
            id: "resource".into(),
            session_id: "session".into(),
            source_run_id: None,
            source_turn_id: "turn".into(),
            source_tool_call_id: "tool".into(),
            visibility: ShellVisibility::Model,
            permissions: ShellPermissions {
                basis: maka_agent_facts::workspace::PermissionBasis {
                    boundary_revision: 0,
                    binding: maka_agent_facts::workspace::BindingStamp {
                        id: uuid::Uuid::from_u128(1),
                        permission_epoch: 0,
                    },
                },
                sandbox: Sandbox::Disabled,
            },
            cwd: "/".into(),
            command: "fixture".into(),
            started_at: 1,
            updated_at: 1,
            timeout_ms: None,
            revision: 1,
            state: ShellState::Starting,
            output: ShellOutput::Pipes {
                stdout: String::new(),
                stderr: String::new(),
                latest_stream: None,
                stdout_truncated: false,
                stderr_truncated: false,
            },
        }
        .patched(ShellPatch {
            state: Some(ShellState::Running),
            ..Default::default()
        })
        .unwrap()
    }

    #[test]
    fn live_output_preserves_durable_revision_and_observed_sql_wins_over_old_final_arc() {
        let durable = running();
        let mut live = durable.clone();
        let ShellOutput::Pipes { stdout, .. } = &mut live.output else {
            unreachable!()
        };
        *stdout = "literal live output".into();
        let selected = prefer_live(durable.clone(), Ok(Arc::new(live.clone().into()))).unwrap();
        assert_eq!(selected.revision, 2);
        assert_eq!(selected.updated_at, 1);
        let ShellOutput::Pipes { stdout, .. } = &selected.output else {
            unreachable!()
        };
        assert_eq!(stdout, "literal live output");
        let final_cut = live
            .patched(ShellPatch {
                state: Some(ShellState::Terminal {
                    completed_at: 10,
                    outcome: ShellOutcome::Completed,
                    observed_at: None,
                }),
                ..Default::default()
            })
            .unwrap();
        let old_arc = Arc::new(final_cut.clone().into());
        let observed = final_cut
            .patched(ShellPatch {
                observed_at: Some(20),
                ..Default::default()
            })
            .unwrap();
        let selected = prefer_live(observed, Ok(old_arc)).unwrap();
        assert_eq!(selected.revision, 4);
        assert!(matches!(
            selected.state,
            ShellState::Terminal {
                observed_at: Some(20),
                ..
            }
        ));
        let ShellOutput::Pipes { stdout, .. } = &selected.output else {
            unreachable!()
        };
        assert_eq!(stdout, "literal live output");
        assert!(
            matches!(prefer_live(durable, Err(Arc::new(ShellError::Rejected("native cleanup failed")))),
            Err(ToolError::CleanupUnconfirmed(message)) if message == "native cleanup failed")
        );
    }
}
