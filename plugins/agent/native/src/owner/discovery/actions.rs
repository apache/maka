/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use super::watch_inputs::WatchAuthority;
use super::*;
use futures_util::FutureExt;
use maka_agent_authority::permissions::ConfirmedFileAction;
use maka_agent_facts::discovery::{ActionId, PendingActionRecord, PendingActionStatus};
use maka_agent_state::discovery::guards::{ActionReceipt, InputCheck};
use maka_capabilities::call::{Identity, Scope};
use maka_plugin_core::operation::{OperationCleanup, OperationOutcome, OperationResult, Receipt};
use serde_json::json;

fn json_object_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({
        "type": "object",
        "additionalProperties": true
    })
}

#[derive(Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct StagePendingAction {
    action_id: Option<ActionId>,
    topic_id: TopicId,
    connector_tool: String,
    #[schemars(schema_with = "json_object_schema")]
    params: Value,
    input_paths: Vec<String>,
    idempotency_key: Option<String>,
    expires_in_secs: Option<u64>,
}

#[derive(Serialize, Deserialize)]
struct ActionAuthority {
    source: WatchAuthority,
    connector: String,
}

impl Owner {
    fn action_tool(
        &self,
        config: &ResolvedConfiguration,
        name: &str,
    ) -> Result<&crate::tools::SelectedTool, String> {
        if config
            .tools
            .as_ref()
            .is_some_and(|allowed| !allowed.iter().any(|n| n == name))
        {
            return Err("connector authorization revoked".into());
        }
        self.tool_basis
            .iter()
            .find(|tool| tool.name() == name)
            .ok_or_else(|| "configured connector unavailable".into())
    }
    pub(super) async fn stage_pending_action(
        &self,
        context: &ToolCallContext,
        input: StagePendingAction,
        cancel: CancellationToken,
    ) -> Result<Value, ToolError> {
        if cancel.is_cancelled() {
            return Err(ToolError::Failed("discovery_cancelled".into()));
        }
        if !input.params.is_object() {
            return Err(ToolError::Failed("expected JSON object params".into()));
        }
        let source = self
            .watch_authority(context, PENDING, &input.topic_id)
            .await?;
        let session = self
            .session(&source.target.session_id)
            .await
            .map_err(ToolError::Failed)?;
        check_target(&session, &source.target).map_err(ToolError::Failed)?;
        let tool = self
            .action_tool(&session.configuration, &input.connector_tool)
            .map_err(ToolError::Failed)?;
        let (_, _, connector, file) = tool
            .confirmed_connector(&self.services, &input.params)
            .map_err(ToolError::Failed)?;
        let mut paths = input.input_paths;
        if let Some(file) = file {
            let cwd = std::path::PathBuf::from(&source.target.workspace.path);
            let params = input.params.clone();
            let targets = tokio::task::spawn_blocking(move || {
                maka_fs_tools::mutation_paths(file, params, &cwd)
            })
            .await
            .map_err(|e| ToolError::Failed(reason(e)))??;
            for path in targets {
                paths.push(
                    path.into_os_string()
                        .into_string()
                        .map_err(|_| ToolError::Failed("non-UTF-8 destination".into()))?,
                )
            }
        }
        paths.sort();
        paths.dedup();
        if paths.len() > 64 {
            return Err(ToolError::Failed("expected at most 64 input files".into()));
        }
        let hashes = if paths.is_empty() {
            BTreeMap::new()
        } else {
            self.watch_inputs(&source, input.topic_id.clone())
                .await
                .map_err(ToolError::Failed)?
                .snapshot(paths, cancel.clone())
                .await
                .map_err(ToolError::Failed)?
        };
        if cancel.is_cancelled() {
            return Err(ToolError::Failed("discovery_cancelled".into()));
        }
        let id = input.action_id.unwrap_or_else(|| {
            ActionId(
                crate::tools::operation_uuid(&context.execution, &context.operation_id).to_string(),
            )
        });
        let key = input.idempotency_key.unwrap_or_else(|| id.0.clone());
        if [&id.0, &key]
            .into_iter()
            .any(|s| s.trim().is_empty() || s.len() > 256 || s.chars().any(char::is_control))
        {
            return Err(ToolError::Failed("invalid action identity".into()));
        }
        let at = UnixMillis(now() as i64);
        let expires = input.expires_in_secs.unwrap_or(86400);
        let end = expires
            .checked_mul(1000)
            .and_then(|ms| i64::try_from(ms).ok())
            .and_then(|ms| at.0.checked_add(ms))
            .filter(|end| *end > at.0)
            .ok_or_else(|| ToolError::Failed("invalid action lifetime".into()))?;
        let action = PendingActionRecord {
            action_id: id.clone(),
            topic_id: input.topic_id,
            connector_tool: input.connector_tool,
            params: input.params,
            input_hashes: hashes,
            idempotency_key: key,
            status: PendingActionStatus::AwaitingConfirm,
            receipt: None,
            expires_at: UnixMillis(end),
            created_at: at,
            updated_at: at,
        };
        let worker = source.plan.is_some();
        let read_authority = json!(source);
        let state = self.discovery.stage_action_statement(
            action,
            json!(ActionAuthority { source, connector }),
            read_authority,
        );
        if worker {
            let _gate = self.scheduler.gate.lock().await;
            let (rev, job) = self
                .scheduler
                .investigation()
                .await
                .map_err(ToolError::Failed)?;
            let mut job = job.ok_or_else(|| ToolError::Failed("discovery_not_active".into()))?;
            self.check_discovery_invocation(context, &job)
                .await
                .map_err(ToolError::Failed)?;
            if !matches!(job.phase, Phase::Investigating { result: None }) {
                return Err(ToolError::Failed("discovery_result_conflict".into()));
            }
            job.phase = Phase::Investigating {
                result: Some(Report::NoReport {
                    note: "Staged an action for confirmation".into(),
                    notes: vec![],
                }),
            };
            job.execution = Some(context.execution.clone());
            self.commit_discovery_writes(
                state,
                vec![mutation(ACTIVE.into(), rev, &job).map_err(ToolError::Failed)?],
            )
            .await
            .map_err(dossiers::write_error)?;
            self.scheduler.notify_status_changed();
            self.scheduler.wake.notify_one();
        } else {
            let custody = context
                .custody
                .as_deref()
                .ok_or_else(|| ToolError::Failed("agent_work_custody_required".into()))?;
            self.store
                .data_writer_for_work(custody, &context.execution.session_id)
                .map_err(dossiers::write_error)?
                .write(state)
                .await
                .map_err(dossiers::write_error)?;
        }
        self.watch_runner.wake();
        Ok(json!({"action_id":id,"status":"awaiting_confirm"}))
    }

    pub(crate) async fn confirm_pending_action(
        self: &Arc<Self>,
        input: PendingActionRequest,
        scope: &Scope,
    ) -> Result<ConfirmPendingActionResult, String> {
        self.resource_work(scope, move |owner, scope| {
            Box::pin(async move { owner.confirm_action(input.action_id, &scope).await })
        })
        .await
    }

    async fn confirm_action(
        &self,
        id: ActionId,
        scope: &Scope,
    ) -> Result<ConfirmPendingActionResult, String> {
        let (r, authority) = self
            .discovery
            .action_for_confirmation(id.clone())
            .await
            .map_err(reason)?
            .ok_or("discovery_action_missing")?;
        if r.status != PendingActionStatus::AwaitingConfirm {
            return existing_result(&r);
        }
        let auth: ActionAuthority =
            serde_json::from_value(authority.ok_or("discovery_action_authority_unavailable")?)
                .map_err(reason)?;
        let expired = r.expires_at.0 <= now() as i64;
        let mut checked = InputCheck::Compared(vec![]);
        let mut file_inputs = None;
        if !expired && !r.input_hashes.is_empty() {
            let inputs = self.watch_inputs(&auth.source, r.topic_id.clone()).await;
            checked = match inputs {
                Ok(inputs) => {
                    let proof = inputs.confirmed_inputs(r.input_hashes);
                    file_inputs = Some(proof.clone());
                    let cancel = scope.cancellation.clone();
                    InputCheck::Compared(
                        tokio::task::spawn_blocking(move || proof.changed(&cancel))
                            .await
                            .map_err(reason)??,
                    )
                }
                Err(error) => InputCheck::Unavailable(error),
            };
        }
        if scope.cancellation.is_cancelled() || self.stop.is_cancelled() {
            return Err("discovery_confirmation_cancelled".into());
        }
        if !self
            .discovery
            .claim_action(id.clone(), r.updated_at, checked)
            .await
            .map_err(reason)?
        {
            let live = self
                .discovery
                .get_pending_action(id)
                .await
                .map_err(reason)?
                .ok_or("discovery_action_missing")?;
            return existing_result(&live);
        }
        // From here the original owner records a terminal receipt even if the observer leaves.
        let result = std::panic::AssertUnwindSafe(self.execute_action(
            &auth,
            &r.connector_tool,
            r.params,
            &r.idempotency_key,
            file_inputs,
            scope,
        ))
        .catch_unwind()
        .await;
        let original = match &result {
            Ok(Err(
                ToolError::OperationUnknown { observation, .. }
                | ToolError::OperationCleanupUnconfirmed { observation, .. },
            )) => Some(observation),
            _ => None,
        };
        let outcome = match &result {
            Ok(Ok(outcome)) => outcome.clone(),
            Ok(Err(ToolError::Failed(error))) => ConfirmPendingActionResult::Failed {
                error: error.clone(),
            },
            Ok(Err(error)) => ConfirmPendingActionResult::UnknownPendingReceipt {
                error: error.to_string(),
            },
            Err(_) => ConfirmPendingActionResult::UnknownPendingReceipt {
                error: "Connector observation interrupted".into(),
            },
        };
        let mut receipt = json!(outcome);
        let settlement = if matches!(
            outcome,
            ConfirmPendingActionResult::UnknownPendingReceipt { .. }
        ) {
            receipt["idempotencyKey"] = json!(r.idempotency_key);
            if let Some(original) = original {
                receipt["original"] = json!(original);
            }
            ActionReceipt::Unknown(receipt)
        } else if let ConfirmPendingActionResult::Stale { changed_paths } = &outcome {
            ActionReceipt::Stale(changed_paths.clone())
        } else {
            ActionReceipt::Returned(receipt)
        };
        self.discovery
            .finish_action(id, settlement, UnixMillis(now() as i64))
            .await
            .map_err(reason)?;
        Ok(outcome)
    }

    async fn execute_action(
        &self,
        auth: &ActionAuthority,
        name: &str,
        input: Value,
        key: &str,
        file_inputs: Option<Arc<maka_fs_tools::ConfirmedInputs>>,
        scope: &Scope,
    ) -> Result<ConfirmPendingActionResult, ToolError> {
        let current = self
            .session(&auth.source.target.session_id)
            .await
            .map_err(ToolError::Failed)?;
        check_target(&current, &auth.source.target).map_err(ToolError::Failed)?;
        let tool = self
            .action_tool(&current.configuration, name)
            .map_err(ToolError::Failed)?;
        let (selection, services, binding, file) = tool
            .confirmed_connector(&self.services, &input)
            .map_err(ToolError::Failed)?;
        if binding != auth.connector {
            return Err(ToolError::Failed("connector binding changed".into()));
        }
        let ceiling = auth
            .source
            .effect_ceiling
            .intersect(scope.sandbox_floor())
            .map_err(|e| ToolError::Failed(reason(e)))?;
        let reserved =
            access::reserved_sandbox_floor(&self.store, &current.configuration.workspace)
                .await
                .map_err(ToolError::Failed)?;
        let floor = self
            .capture_sandbox(&current.configuration, &ceiling)
            .await
            .map_err(ToolError::Failed)?
            .intersect(&reserved)
            .map_err(|e| ToolError::Failed(reason(e)))?;
        // Open the selected directory again even for a connector with no file inputs.
        let _workspace = workspace::open_workspace(
            &self.workspace_roots,
            &current.configuration.workspace,
            &self.managed_worktrees,
        )
        .await
        .map_err(ToolError::Failed)?;
        let current = self
            .session(&auth.source.target.session_id)
            .await
            .map_err(ToolError::Failed)?;
        check_target(&current, &auth.source.target).map_err(ToolError::Failed)?;
        self.action_tool(&current.configuration, name)
            .map_err(ToolError::Failed)?;
        let cancel = scope.cancellation.child_token();
        let request = if file.is_some() {
            services.request_with_context(
                Identity::Native,
                cancel,
                Arc::new(ConfirmedFileAction {
                    target: auth.source.target.clone(),
                    connector_tool: name.into(),
                    inputs: file_inputs.ok_or_else(|| {
                        ToolError::Failed("Confirmed file action has no input snapshot".into())
                    })?,
                }),
            )
        } else {
            services.request(Identity::Native, cancel)
        }
        .and_then(|r| r.with_sandbox_floor(&floor))
        .map_err(ToolError::Failed)?;
        let operation = crate::tools::native_operation_uuid(
            &serde_json::to_vec(&("discovery_action", self.run_owner(), key))
                .map_err(|e| ToolError::Failed(reason(e)))?,
        );
        let result = async {
            let observer = request
                .begin_mutation_target(
                    &selection.target,
                    selection.method.clone(),
                    input,
                    operation,
                    json!({"kind":"discovery_action","idempotencyKey":key}),
                    maka_host_runtime::application::CallResources::default(),
                )
                .map_err(ToolError::Failed)?;
            let mutation = observer.await.map_err(ToolError::OutcomeUnknown)?;
            let reference = mutation.reference.clone();
            let completion = tokio::time::timeout(Duration::from_secs(60), mutation.completion())
                .await
                .map_err(|_| ToolError::OperationUnknown {
                    message: "Timed out waiting for the original connector receipt".into(),
                    observation: Box::new(maka_plugin_core::operation::OperationReply {
                        reference: reference.clone(),
                        receipt: Receipt::Unavailable {
                            diagnostic: "receipt timeout".into(),
                        },
                    }),
                })?;
            if let Err(message) = completion.cleanup {
                return Err(ToolError::OperationCleanupUnconfirmed {
                    message,
                    observation: Box::new(completion.reply),
                });
            }
            let reply = completion.reply;
            if reference != reply.reference {
                return Err(ToolError::OutcomeUnknown(
                    "Connector receipt mismatch".into(),
                ));
            }
            match &reply.receipt {
                Receipt::Recorded {
                    outcome:
                        OperationOutcome::Returned {
                            result: OperationResult::Success { value },
                        },
                    cleanup: OperationCleanup::Confirmed,
                } => {
                    if file.is_some() {
                        match serde_json::from_value::<maka_workspace_api::files::FileResult>(
                            value.clone(),
                        )
                        .map_err(|e| ToolError::OutcomeUnknown(reason(e)))?
                        {
                            maka_workspace_api::files::FileResult::Failed { message } => {
                                return Err(ToolError::Failed(message));
                            }
                            maka_workspace_api::files::FileResult::Stale { changed_paths } => {
                                return Ok(ConfirmPendingActionResult::Stale { changed_paths });
                            }
                            maka_workspace_api::files::FileResult::Completed { value } => {
                                if value.get("status").and_then(Value::as_str) == Some("failed") {
                                    return Err(ToolError::Failed(value.to_string()));
                                }
                            }
                        }
                    }
                    Ok(ConfirmPendingActionResult::Done {
                        receipt: json!(reply),
                    })
                }
                Receipt::Recorded {
                    outcome:
                        OperationOutcome::Returned {
                            result: OperationResult::Failure { diagnostic },
                        },
                    cleanup: OperationCleanup::Confirmed,
                } => Err(ToolError::Failed(diagnostic.clone())),
                Receipt::Recorded {
                    outcome: OperationOutcome::NotExecuted { proof },
                    ..
                } => Err(ToolError::Failed(format!("{proof:?}"))),
                _ => Err(ToolError::OperationUnknown {
                    message: serde_json::to_string(&reply.receipt)
                        .map_err(|e| ToolError::OutcomeUnknown(reason(e)))?,
                    observation: Box::new(reply),
                }),
            }
        }
        .await;
        if let Err(error) = request.finish().await {
            return match result {
                Err(
                    original @ (ToolError::OperationUnknown { .. }
                    | ToolError::OperationCleanupUnconfirmed { .. }),
                ) => Err(original),
                _ => Err(ToolError::OutcomeUnknown(error)),
            };
        }
        result
    }
}

fn existing_result(r: &PendingActionRecord) -> Result<ConfirmPendingActionResult, String> {
    match r.status {
        PendingActionStatus::Stale => {
            let receipt = r.receipt.as_ref();
            if receipt.is_some_and(|v| v["reason"] == "expired") {
                return Ok(ConfirmPendingActionResult::Failed {
                    error: "discovery_action_expired".into(),
                });
            }
            Ok(ConfirmPendingActionResult::Stale {
                changed_paths: receipt
                    .and_then(|v| v["changedPaths"].as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(|p| p.as_str().map(str::to_owned))
                    .collect(),
            })
        }
        PendingActionStatus::UnknownPendingReceipt => {
            Ok(ConfirmPendingActionResult::UnknownPendingReceipt {
                error: r
                    .receipt
                    .as_ref()
                    .and_then(|v| v["error"].as_str())
                    .unwrap_or("Check the external receipt")
                    .into(),
            })
        }
        _ => Err(format!("discovery_action_{}", r.status.as_str())),
    }
}
