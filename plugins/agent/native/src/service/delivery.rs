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

//! Disposable UI notifications from canonical facts. No execution state lives here.
use super::{encode, history, preview};
use crate::{contract::*, owner::Owner};
use maka_agent_facts::{durable::*, model::ModelPart, tool_call::ToolSettlement};
use maka_agent_state::session_history::HistoryItem;
use maka_host_runtime::application::Context;
use std::sync::Arc;

pub(super) fn tool_id(run: RunId, tool: &ToolKey) -> String {
    maka_agent_facts::tool_call::tool_use_id(run, &format!("{}:{}", tool.attempt, tool.call))
}

pub(super) fn executor_tool_id(run: RunId, task: ExternalTaskId, id: &str) -> String {
    maka_agent_facts::tool_call::tool_use_id(run, &format!("{task}:{id}"))
}

pub(super) fn executor_tool_display(
    name: &str,
    input: &serde_json::Value,
) -> (
    Option<maka_agent_facts::display::Text>,
    Option<maka_agent_ports::session::history::ExternalToolTarget>,
) {
    use maka_agent_facts::display::Text;
    use maka_agent_ports::session::history::ExternalToolTarget;
    let string = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| input[*key].as_str().filter(|text| !text.is_empty()))
    };
    let preview = |text: &str| {
        let mut chars = text.chars();
        let mut value: String = chars
            .by_ref()
            .take(4096)
            .filter(|&ch| !ch.is_control() || ch == '\n' || ch == '\t')
            .collect();
        if chars.next().is_some() {
            value.push('…');
        }
        value
    };
    let summary =
        string(&["toolSummary", "description", "Description"]).and_then(Text::single_line);
    match name {
        "run_command" | "Bash" | "commandExecution" | "shell" | "execute" => {
            let command = string(&["command", "CommandLine"]);
            (
                summary.or_else(|| command.and_then(Text::single_line)),
                command.map(|command| ExternalToolTarget::Command {
                    command: preview(command),
                    cwd: string(&["cwd", "Cwd"]).map(preview),
                }),
            )
        }
        "read_file"
        | "view_file"
        | "Read"
        | "write_to_file"
        | "Write"
        | "Edit"
        | "MultiEdit"
        | "replace_file_content"
        | "multi_replace_file_content"
        | "fileChange"
        | "apply_patch"
        | "list_dir"
        | "Glob"
        | "find_by_name" => {
            let path = string(&[
                "path",
                "Path",
                "AbsolutePath",
                "TargetFile",
                "file_path",
                "DirectoryPath",
                "SearchDirectory",
                "pattern",
            ])
            .or_else(|| {
                input["changes"]
                    .as_array()
                    .filter(|changes| changes.len() == 1)
                    .and_then(|changes| changes[0]["path"].as_str())
            });
            (
                summary.or_else(|| path.and_then(Text::single_line)),
                path.map(|path| ExternalToolTarget::File {
                    path: preview(path),
                }),
            )
        }
        "Grep" | "grep_search" | "WebSearch" | "webSearch" | "search_web" => {
            let query = string(&["query", "pattern", "Query", "RegexPattern"]);
            (
                summary.or_else(|| query.and_then(Text::single_line)),
                query.map(|query| ExternalToolTarget::Search {
                    query: preview(query),
                }),
            )
        }
        _ => (None, None),
    }
}

pub(super) fn recorded_settlement(
    reply: &maka_agent_facts::operation::RecordedOperationReply,
) -> Option<ToolSettlement> {
    use maka_plugin_core::operation::{OperationOutcome, Receipt};
    Some(match &reply.receipt {
        Receipt::Recorded {
            outcome: OperationOutcome::Unresolved,
            ..
        } => return None,
        Receipt::Recorded {
            outcome: OperationOutcome::Returned { result },
            ..
        } => {
            if result.is_error() {
                ToolSettlement::Failed
            } else {
                ToolSettlement::Returned
            }
        }
        Receipt::Recorded {
            outcome: OperationOutcome::NotExecuted { .. },
            ..
        } => ToolSettlement::Rejected,
        _ => ToolSettlement::Unknown,
    })
}

pub(super) fn project(item: &HistoryItem, turn_id: String) -> Result<Delivery, String> {
    let run = item.recorded.run;
    let fact = match &item.recorded.fact {
        Fact::RunAdmitted { .. } => DeliveryFact::Opened,
        Fact::ModelObserved {
            attempt,
            index,
            part,
            ..
        } => {
            let step = item.scope.step.ok_or("agent_history_step_missing")?;
            match part {
                ModelPart::ToolCall { call } => DeliveryFact::ToolInputReady {
                    tool_use_id: tool_id(
                        run,
                        &ToolKey {
                            attempt: *attempt,
                            call: call.id.clone(),
                        },
                    ),
                    step_id: step,
                    attempt_id: *attempt,
                    name: call.name.clone(),
                    provider_executed: call.provider_executed,
                },
                ModelPart::ToolResult { id, is_error, .. } => DeliveryFact::ProviderToolResult {
                    tool_use_id: tool_id(
                        run,
                        &ToolKey {
                            attempt: *attempt,
                            call: id.clone(),
                        },
                    ),
                    is_error: *is_error,
                },
                _ => DeliveryFact::PartCommitted {
                    step_id: step,
                    attempt_id: *attempt,
                    message_id: item.recorded.id.to_string(),
                    ordinal: *index,
                },
            }
        }
        Fact::ModelClosed {
            attempt,
            diagnostic,
            ..
        } => DeliveryFact::StepEnded {
            step_id: item.scope.step.ok_or("agent_history_step_missing")?,
            attempt_id: *attempt,
            completed: diagnostic.is_none(),
        },
        Fact::ModelInterrupted { attempt, .. } => DeliveryFact::StepEnded {
            step_id: item.scope.step.ok_or("agent_history_step_missing")?,
            attempt_id: *attempt,
            completed: false,
        },
        Fact::ToolDecided {
            tool,
            decision: ToolDecision::Rejected { .. },
        }
        | Fact::ToolPreventedBeforeHostAdmission { tool, .. } => DeliveryFact::ToolRejected {
            tool_use_id: tool_id(run, tool),
        },
        Fact::OperationObserved { tool, reply } => match recorded_settlement(reply) {
            Some(settlement) => DeliveryFact::ToolSettled {
                tool_use_id: tool_id(run, tool),
                settlement,
            },
            None => DeliveryFact::TranscriptChanged,
        },
        Fact::LocalToolReturned {
            tool, settlement, ..
        } => DeliveryFact::ToolSettled {
            tool_use_id: tool_id(run, tool),
            settlement: *settlement,
        },
        Fact::ToolResultAccepted {
            tool,
            outcome: AcceptedResult::Failed,
            ..
        } => DeliveryFact::ToolSettled {
            tool_use_id: tool_id(run, tool),
            settlement: ToolSettlement::Failed,
        },
        Fact::ExternalTaskObserved { task, output, .. } => {
            use maka_agent_facts::executor::Output;
            match output {
                Output::ToolStart {
                    tool_call_id,
                    name,
                    input,
                } => DeliveryFact::ExecutorToolStart {
                    tool_use_id: executor_tool_id(run, *task, tool_call_id),
                    name: name.clone(),
                    title: executor_tool_display(name, input).0,
                },
                Output::ToolResult {
                    tool_call_id,
                    is_error,
                    ..
                } => DeliveryFact::ExecutorToolResult {
                    tool_use_id: executor_tool_id(run, *task, tool_call_id),
                    is_error: *is_error,
                },
                _ => DeliveryFact::TranscriptChanged,
            }
        }
        Fact::RunTerminated { terminal, .. } => DeliveryFact::Ended {
            failed: *terminal != Terminal::Completed,
        },
        // History supplies complete output; this is only invalidation metadata.
        _ => DeliveryFact::TranscriptChanged,
    };
    Ok(Delivery {
        sequence: item.sequence,
        run_id: run,
        turn_id,
        fact,
    })
}

pub(super) async fn watch(
    owner: &Arc<Owner>,
    input: Watch,
    context: &Context,
) -> Result<serde_json::Value, String> {
    let history = history::open(owner, context.scope(), &input.session_id).await?;
    // Subscribe before the initial query: a racing commit remains a pending level.
    let mut changes = owner.durable.subscribe().map_err(|e| e.to_string())?;
    let mut preview = preview::Delivery::new(owner.preview_epoch());
    let mut after = input.after;
    let mut queue_delivered = None;
    let mut interactions_delivered = None;
    let mut apps_delivered = None;
    let mut stale = true;
    loop {
        let mut reader = owner.preview_reader(&input.session_id).await;
        if reader
            .as_ref()
            .is_some_and(|reader| reader.has_changed().is_err())
        {
            reader = None;
        }
        let current = reader
            .as_mut()
            .and_then(|reader| reader.borrow_and_update().clone());
        let new_attempt = current.as_ref().is_some_and(|cut| !preview.matches(cut));
        preview.current(current.clone());
        stale |= new_attempt;
        if stale {
            changes.borrow_and_update();
            history::authorize(owner, context.scope(), &input.session_id).await?;
            let cut = history.capture().await.map_err(|e| e.to_string())?;
            if after > cut.through_sequence {
                return Err("agent_cursor_invalid".into());
            }
            if let Some(current) = current.as_ref().filter(|_| new_attempt) {
                let view = history
                    .view_at(&cut, current.binding.execution.run_id)
                    .await
                    .map_err(|e| e.to_string())?;
                preview.seed(&view)?;
            }
            let queue = encode(owner.queue(&input.session_id).await?)?;
            if queue_delivered.as_ref() != Some(&queue) {
                queue_delivered = Some(queue.clone());
                context
                    .emit(serde_json::json!({"kind":"queue","queue":queue}))
                    .await?;
            }
            let pending = owner.pending_interactions(&input.session_id).await?;
            if interactions_delivered.as_ref() != Some(&pending) {
                context
                    .emit(encode(DeliveryPage::Interactions {
                        pending: pending.clone(),
                    })?)
                    .await?;
                interactions_delivered = Some(pending);
            }
            let apps = owner.computer_apps(&input.session_id).await?;
            if apps_delivered.as_ref() != Some(&apps) {
                context
                    .emit(encode(DeliveryPage::ComputerApps { apps: apps.clone() })?)
                    .await?;
                apps_delivered = Some(apps);
            }
            let page = history
                .page(&cut, after, 32)
                .await
                .map_err(|e| e.to_string())?;
            preview.committed(&page.items);
            let mut events = Vec::with_capacity(page.items.len());
            for item in page.items {
                let source = history
                    .run_source(item.recorded.run)
                    .await
                    .map_err(|e| e.to_string())?;
                events.push(project(&item, source.spec.turn_id)?);
            }
            after = page.next.unwrap_or(cut.through_sequence);
            stale = page.next.is_some();
            history::authorize(owner, context.scope(), &input.session_id).await?;
            context
                .emit(encode(DeliveryPage::Events {
                    through: cut.through_sequence,
                    next_after: after,
                    events,
                })?)
                .await?;
        }
        let mut ready = stale;
        if let Some(page) = preview.next(after)? {
            history::authorize(owner, context.scope(), &input.session_id).await?;
            context
                .emit(encode(DeliveryPage::Preview { page })?)
                .await?;
            ready = true;
        }
        tokio::select! {
            biased;
            _ = context.scope().cancellation.cancelled() => return Err("agent_observation_cancelled".into()),
            changed = changes.changed() => { changed.map_err(|_| "agent_observation_closed")?; stale = true; },
            () = std::future::ready(()), if ready => {},
            _ = async {
                match reader.as_mut() {
                    Some(reader) => { let _ = reader.changed().await; },
                    None => std::future::pending::<()>().await,
                }
            } => {},
        }
    }
}
